const { ethers } = require('ethers');
const { BSC_MAX_CONCURRENT_POSITIONS, PRICE_POLL_INTERVAL_MS, DRY_RUN, BNB_FEE_RESERVE } = require('../config');
const { computeTradeSize } = require('../trading/sizing');
const { resolveExit, evaluateExit } = require('../trading/exitRules');
const { entryMessage, exitMessage } = require('../trading/present');
const runtime = require('../live/runtime');
const { assessAndGate } = require('../analysis/riskEngine');
const { quoteSell, buyWithBnb, sellForBnb, getTokenDecimals } = require('./pancakeswap');
const { getBnbBalance, loadWallet } = require('./wallet');
const { logTrade } = require('../db/tradeLog');
const { getConfig } = require('../live/liveConfig');
const stateSync = require('../live/stateSync');
const telegram = require('../telegram/bot');

const openPositions = new Map(); // tokenAddress -> position state

function printFindings(tokenAddress, assessment) {
  console.log(`\n[findings] ${tokenAddress} (bsc)`);
  console.log(`  verdict: ${assessment.verdict}${assessment.recommended ? ' — RECOMMENDED' : ''}`);
  if (assessment.category) {
    console.log(`  category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}`);
  }
  if (assessment.devPercent != null) console.log(`  owner/dev holding: ~${assessment.devPercent.toFixed(1)}%`);
  if (assessment.top10Percent != null) console.log(`  top10 holders: ~${assessment.top10Percent.toFixed(1)}%`);
  assessment.reasons.forEach((r) => console.log(`  - ${r}`));
  if (assessment.exit) {
    console.log(
      `  suggested exit: TP +${assessment.exit.takeProfitPct}% / SL ${assessment.exit.stopLossPct}% / max hold ${(
        assessment.exit.maxHoldMs / 60000
      ).toFixed(0)}min`
    );
  }
  console.log('');
}

function findingsMessage(tokenAddress, assessment) {
  const lines = [
    `🔎 BSC — ${assessment.recommended ? '✅ RECOMMENDED' : assessment.verdict}`,
    `CA: ${tokenAddress}`,
    assessment.category ? `Category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}` : null,
    assessment.devPercent != null ? `Owner holding: ~${assessment.devPercent.toFixed(1)}%` : null,
    assessment.top10Percent != null ? `Top10: ~${assessment.top10Percent.toFixed(1)}%` : null,
    ...assessment.reasons.map((r) => `• ${r}`),
  ].filter(Boolean);
  return lines.join('\n');
}

const SELL_ATTEMPTS = Number(process.env.SELL_ATTEMPTS || 3);
const SELL_RETRY_BASE_MS = Number(process.env.SELL_RETRY_BASE_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let entering = 0; // entries in flight (assessing/buying) — counted against the position limit

// Read-only view of open positions for Telegram's 📈 Positions screen.
runtime.registerPositions('bsc', () =>
  [...openPositions.values()].map((p) => ({
    chain: 'bsc',
    unit: 'BNB',
    address: p.tokenAddress,
    size: p.sizeBnb,
    valueNative: p.lastValueNative,
    pnlPct: p.lastPnlPct,
    openedAt: p.openedAt,
    lastPolledAt: p.lastPolledAt,
    dryRun: p.dryRun,
    exit: p.exit,
    verdict: p.verdict,
    score: p.score,
    exiting: p.exiting,
    sellFailures: p.sellFailures,
  }))
);

async function tryEnterPosition(tokenAddress) {
  if (openPositions.size >= BSC_MAX_CONCURRENT_POSITIONS) {
    runtime.recordSkip('bsc', 'already holding a position (max concurrent reached)');
    console.log(`[position-bsc] skipping ${tokenAddress} — already at BSC_MAX_CONCURRENT_POSITIONS (${BSC_MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (entering + openPositions.size >= BSC_MAX_CONCURRENT_POSITIONS) {
    // Not actually holding a position yet — another candidate that arrived
    // moments earlier is still being assessed, so this one is skipped rather
    // than risking two buys racing past BSC_MAX_CONCURRENT_POSITIONS.
    runtime.recordSkip('bsc', 'busy evaluating another candidate that arrived first');
    console.log(`[position-bsc] skipping ${tokenAddress} — already evaluating another candidate (BSC_MAX_CONCURRENT_POSITIONS=${BSC_MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(tokenAddress)) return;

  entering += 1;
  try {
    await enterPosition(tokenAddress);
  } finally {
    entering -= 1;
  }
}

async function enterPosition(tokenAddress) {
  const pre = getConfig();
  let assessment;
  try {
    // While paused / BSC is off the token is still assessed and reported,
    // but must not consume one of today's slots.
    assessment = await assessAndGate({ chain: 'bsc', address: tokenAddress, consumeSlot: !pre.paused && pre.enableBsc });
  } catch (err) {
    console.error(`[position-bsc] risk assessment failed for ${tokenAddress}, skipping (fail-closed):`, err.message);
    logTrade({ tokenAddress, chain: 'bsc', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    runtime.recordSkip('bsc', 'risk assessment error');
    return;
  }

  printFindings(tokenAddress, assessment);
  logTrade({ tokenAddress, chain: 'bsc', event: 'assessed', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'bsc', address: tokenAddress });
  runtime.recordAssessed('bsc', tokenAddress, assessment);

  if (assessment.recommended) {
    telegram.notify(findingsMessage(tokenAddress, assessment));
  }

  if (!assessment.recommended) return;

  const liveCfg = getConfig();
  if (liveCfg.paused || !liveCfg.enableBsc) {
    console.log(`[position-bsc] ${tokenAddress} was recommended but ${liveCfg.paused ? 'the bot is currently paused' : 'BSC trading is currently disabled'} — skipping entry.`);
    runtime.recordSkip('bsc', 'trading paused / chain off');
    return;
  }

  const wallet = loadWallet();
  const bnbBalance = await getBnbBalance();
  const { size: sizeBnb, limitedBy } = computeTradeSize({
    balance: bnbBalance,
    pct: liveCfg.bscCapitalPct,
    cap: liveCfg.bscMaxPositionBnb,
    reserve: BNB_FEE_RESERVE,
  });

  if (sizeBnb <= 0) {
    console.log(`[position-bsc] skipping ${tokenAddress} — computed size non-positive (balance=${bnbBalance}, ${limitedBy})`);
    runtime.recordSkip('bsc', 'wallet balance too low to size a trade');
    return;
  }
  console.log(`[position-bsc] sizing ${tokenAddress}: ${sizeBnb.toFixed(5)} BNB (${liveCfg.bscCapitalPct}% of ${Number(bnbBalance).toFixed(5)}; limited by ${limitedBy})`);

  const bnbAmountWei = ethers.parseEther(sizeBnb.toFixed(18));

  let buyResult;
  try {
    buyResult = await buyWithBnb(tokenAddress, bnbAmountWei, wallet);
  } catch (err) {
    console.error(`[position-bsc] buy failed for ${tokenAddress}:`, err.message);
    logTrade({ tokenAddress, chain: 'bsc', event: 'buy_failed', error: err.message });
    runtime.recordSkip('bsc', 'buy transaction failed');
    telegram.notify(`⚠️ BUY FAILED for ${tokenAddress}: ${err.message}`);
    return;
  }

  const decimals = await getTokenDecimals(tokenAddress).catch(() => 18);
  const dbPositionId = await stateSync.recordPositionOpened({
    chain: 'bsc',
    address: tokenAddress,
    dryRun: buyResult.dryRun,
    sizeNative: sizeBnb,
    entryTx: buyResult.txHash,
  });

  const position = {
    tokenAddress,
    sizeBnb,
    tokenAmountRaw: buyResult.outAmountRaw,
    decimals,
    openedAt: Date.now(),
    dryRun: buyResult.dryRun,
    buyTxHash: buyResult.txHash,
    exit: assessment.exit,
    verdict: assessment.verdict,
    score: assessment.score,
    dbPositionId,
    // live monitoring state
    lastPnlPct: 0,
    lastValueNative: sizeBnb,
    lastPolledAt: null,
    exiting: false,
    polling: false,
    sellFailures: 0,
    nextExitAt: 0,
  };
  openPositions.set(tokenAddress, position);
  runtime.recordEntry('bsc');

  console.log(`[position-bsc] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${tokenAddress} — ${sizeBnb.toFixed(4)} BNB`);
  logTrade({ tokenAddress, chain: 'bsc', event: 'buy', sizeBnb, dryRun: buyResult.dryRun, txHash: buyResult.txHash });
  telegram.notify(
    entryMessage({
      chainLabel: '🟡 BSC',
      unit: 'BNB',
      address: tokenAddress,
      size: sizeBnb,
      capitalPct: liveCfg.bscCapitalPct,
      balance: Number(bnbBalance),
      assessment,
      cfg: liveCfg,
      dryRun: buyResult.dryRun,
    })
  );

  monitorPosition(tokenAddress);
}

// Polls the sell price every PRICE_POLL_INTERVAL_MS and sells the whole
// position the moment a rule fires. Rules are re-read from live config on
// every poll, so changes from Telegram apply to already-open positions.
function monitorPosition(tokenAddress) {
  const interval = setInterval(async () => {
    const position = openPositions.get(tokenAddress);
    if (!position) {
      clearInterval(interval);
      return;
    }
    if (position.exiting || position.polling) return;

    position.polling = true;
    try {
      const outWei = await quoteSell(tokenAddress, position.tokenAmountRaw);
      const currentBnbOut = Number(ethers.formatEther(outWei));
      const pnlPct = ((currentBnbOut - position.sizeBnb) / position.sizeBnb) * 100;
      const ageMs = Date.now() - position.openedAt;

      position.lastPnlPct = pnlPct;
      position.lastValueNative = currentBnbOut;
      position.lastPolledAt = Date.now();

      const rules = resolveExit(position.exit, getConfig());
      const reason = evaluateExit({ pnlPct, ageMs, rules });
      if (reason && Date.now() >= position.nextExitAt) {
        await exitPosition(tokenAddress, reason, pnlPct);
      }
    } catch (err) {
      console.error(`[position-bsc] price poll failed for ${tokenAddress}:`, err.message);
    } finally {
      position.polling = false;
    }
  }, PRICE_POLL_INTERVAL_MS);
}

async function exitPosition(tokenAddress, reason, pnlPct) {
  const position = openPositions.get(tokenAddress);
  if (!position || position.exiting) return;
  position.exiting = true;

  const wallet = loadWallet();
  let sellResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt += 1) {
    try {
      sellResult = await sellForBnb(tokenAddress, position.tokenAmountRaw, wallet);
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[position-bsc] sell attempt ${attempt}/${SELL_ATTEMPTS} failed for ${tokenAddress}:`, err.message);
      if (attempt < SELL_ATTEMPTS) await sleep(SELL_RETRY_BASE_MS * attempt);
    }
  }

  if (!sellResult) {
    // Keep the position tracked so the monitor retries — do NOT abandon it.
    position.exiting = false;
    position.sellFailures += 1;
    position.nextExitAt = Date.now() + Math.min(60000, 10000 * position.sellFailures);
    logTrade({ tokenAddress, chain: 'bsc', event: 'sell_failed', error: lastErr && lastErr.message, reason });
    if (position.sellFailures === 1 || position.sellFailures % 5 === 0) {
      telegram.notify(
        `⚠️ SELL FAILED for ${tokenAddress} (${reason}) after ${SELL_ATTEMPTS} tries: ${lastErr && lastErr.message}\n` +
          `Still holding it — the bot will keep retrying. If it keeps failing, sell manually.`
      );
    }
    return;
  }

  openPositions.delete(tokenAddress);

  // Use what the sell actually returned, not the last price poll.
  const exitBnb =
    sellResult.outAmountRaw != null ? Number(ethers.formatEther(sellResult.outAmountRaw)) : position.lastValueNative;
  const pnlBnb = exitBnb - position.sizeBnb;
  const realizedPct = (pnlBnb / position.sizeBnb) * 100;
  const rules = resolveExit(position.exit, getConfig());

  console.log(
    `[position-bsc] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${tokenAddress} — reason=${reason} pnl=${realizedPct.toFixed(1)}% (${pnlBnb.toFixed(6)} BNB)`
  );
  logTrade({
    tokenAddress,
    chain: 'bsc',
    event: 'sell',
    reason,
    pnlPct: realizedPct,
    pnlBnb,
    dryRun: sellResult.dryRun,
    txHash: sellResult.txHash,
  });
  runtime.recordExit('bsc', { pnlNative: pnlBnb });
  stateSync.recordPositionClosed(position.dbPositionId, {
    exitTx: sellResult.txHash,
    exitReason: reason,
    pnlPct: realizedPct,
    pnlNative: pnlBnb,
  });
  telegram.notify(
    exitMessage({
      unit: 'BNB',
      address: tokenAddress,
      reason,
      size: position.sizeBnb,
      exitValue: exitBnb,
      heldMs: Date.now() - position.openedAt,
      rules,
      dryRun: sellResult.dryRun,
    })
  );
}

module.exports = { tryEnterPosition, openPositions };
