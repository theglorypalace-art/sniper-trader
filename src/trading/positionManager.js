const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PRICE_POLL_INTERVAL_MS, MAX_CONCURRENT_POSITIONS, SOL_MINT, DRY_RUN, SOL_FEE_RESERVE } = require('../config');
const { computeTradeSize } = require('./sizing');
const { resolveExit, evaluateExit } = require('./exitRules');
const { entryMessage, exitMessage } = require('./present');
const runtime = require('../live/runtime');
const { assessAndGate } = require('../analysis/riskEngine');
const { getQuote, buySol, sellToSol } = require('./jupiter');
const { getSolBalance, loadWallet } = require('../solana/wallet');
const { logTrade } = require('../db/tradeLog');
const { getConfig } = require('../live/liveConfig');
const stateSync = require('../live/stateSync');
const telegram = require('../telegram/bot');

const openPositions = new Map(); // mint -> position state

function printFindings(mint, assessment) {
  console.log(`\n[findings] ${mint} (solana)`);
  console.log(`  verdict: ${assessment.verdict}${assessment.recommended ? ' — RECOMMENDED' : ''}`);
  if (assessment.category) {
    console.log(`  category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}`);
  }
  if (assessment.devPercent != null) console.log(`  dev/creator holding: ~${assessment.devPercent.toFixed(1)}%`);
  if (assessment.top10Percent != null) console.log(`  top10 holders: ~${assessment.top10Percent.toFixed(1)}%`);
  if (assessment.curveProgressPct != null) {
    console.log(`  bonding curve: ~${assessment.curveProgressPct.toFixed(0)}%${assessment.migrated ? ' (migrated to Raydium)' : ''}`);
  }
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

function findingsMessage(mint, assessment) {
  const lines = [
    `🔎 Solana — ${assessment.recommended ? '✅ RECOMMENDED' : assessment.verdict}`,
    `CA: ${mint}`,
    assessment.category ? `Category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}` : null,
    assessment.devPercent != null ? `Dev holding: ~${assessment.devPercent.toFixed(1)}%` : null,
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
runtime.registerPositions('solana', () =>
  [...openPositions.values()].map((p) => ({
    chain: 'solana',
    unit: 'SOL',
    address: p.mint,
    size: p.sizeSol,
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

async function tryEnterPosition(mint) {
  if (openPositions.size + entering >= MAX_CONCURRENT_POSITIONS) {
    runtime.recordSkip('solana', 'a position is already open (max concurrent reached)');
    console.log(`[position] skipping ${mint} — already at MAX_CONCURRENT_POSITIONS (${MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(mint)) return;

  entering += 1;
  try {
    await enterPosition(mint);
  } finally {
    entering -= 1;
  }
}

async function enterPosition(mint) {
  const pre = getConfig();
  let assessment;
  try {
    // While paused / Solana is off the token is still assessed and reported,
    // but must not consume one of today's slots.
    assessment = await assessAndGate({ chain: 'solana', address: mint, consumeSlot: !pre.paused && pre.enableSolana });
  } catch (err) {
    console.error(`[position] risk assessment failed for ${mint}, skipping (fail-closed):`, err.message);
    logTrade({ mint, chain: 'solana', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    runtime.recordSkip('solana', 'risk assessment error');
    return;
  }

  printFindings(mint, assessment);
  logTrade({ mint, chain: 'solana', event: 'assessed', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'solana', address: mint });
  runtime.recordAssessed('solana', mint, assessment);

  if (assessment.recommended) {
    telegram.notify(findingsMessage(mint, assessment));
  }

  if (!assessment.recommended) return;

  const liveCfg = getConfig();
  if (liveCfg.paused) {
    console.log(`[position] ${mint} was recommended but the bot is currently paused — skipping entry.`);
    runtime.recordSkip('solana', 'trading paused / chain off');
    return;
  }
  if (!liveCfg.enableSolana) {
    console.log(`[position] ${mint} was recommended but Solana trading is currently disabled — skipping entry.`);
    runtime.recordSkip('solana', 'trading paused / chain off');
    return;
  }

  const wallet = loadWallet();
  const solBalance = await getSolBalance();
  const { size: sizeSol, limitedBy } = computeTradeSize({
    balance: solBalance,
    pct: liveCfg.capitalPct,
    cap: liveCfg.maxPositionSol,
    reserve: SOL_FEE_RESERVE,
  });

  if (sizeSol <= 0) {
    console.log(`[position] skipping ${mint} — computed size non-positive (balance=${solBalance}, ${limitedBy})`);
    runtime.recordSkip('solana', 'wallet balance too low to size a trade');
    return;
  }
  console.log(`[position] sizing ${mint}: ${sizeSol.toFixed(4)} SOL (${liveCfg.capitalPct}% of ${Number(solBalance).toFixed(4)}; limited by ${limitedBy})`);

  const lamports = Math.floor(sizeSol * LAMPORTS_PER_SOL);

  let buyResult;
  try {
    buyResult = await buySol(mint, lamports, wallet);
  } catch (err) {
    console.error(`[position] buy failed for ${mint}:`, err.message);
    logTrade({ mint, chain: 'solana', event: 'buy_failed', error: err.message });
    runtime.recordSkip('solana', 'buy transaction failed');
    telegram.notify(`⚠️ BUY FAILED for ${mint}: ${err.message}`);
    return;
  }

  const entryPriceSolPerToken = lamports / Number(buyResult.quote.outAmount);
  const dbPositionId = await stateSync.recordPositionOpened({
    chain: 'solana',
    address: mint,
    dryRun: buyResult.dryRun,
    sizeNative: sizeSol,
    entryTx: buyResult.signature,
  });

  const position = {
    mint,
    sizeSol,
    tokenAmountRaw: Number(buyResult.quote.outAmount),
    entryPriceSolPerToken,
    openedAt: Date.now(),
    dryRun: buyResult.dryRun,
    buySignature: buyResult.signature,
    exit: assessment.exit,
    verdict: assessment.verdict,
    score: assessment.score,
    dbPositionId,
    // live monitoring state
    lastPnlPct: 0,
    lastValueNative: sizeSol,
    lastPolledAt: null,
    exiting: false,
    polling: false,
    sellFailures: 0,
    nextExitAt: 0,
  };
  openPositions.set(mint, position);
  runtime.recordEntry('solana');

  console.log(
    `[position] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${mint} — ${sizeSol.toFixed(4)} SOL @ ${entryPriceSolPerToken}`
  );
  logTrade({ mint, chain: 'solana', event: 'buy', sizeSol, dryRun: buyResult.dryRun, signature: buyResult.signature });
  telegram.notify(
    entryMessage({
      chainLabel: '🟣 Solana',
      unit: 'SOL',
      address: mint,
      size: sizeSol,
      capitalPct: liveCfg.capitalPct,
      balance: solBalance,
      assessment,
      cfg: liveCfg,
      dryRun: buyResult.dryRun,
    })
  );

  monitorPosition(mint);
}

// Polls the sell price every PRICE_POLL_INTERVAL_MS and sells the whole
// position the moment a rule fires. The rules (take profit / stop loss / max
// hold) are re-read from live config on every poll, so changing them from
// Telegram applies to positions that are already open.
function monitorPosition(mint) {
  const interval = setInterval(async () => {
    const position = openPositions.get(mint);
    if (!position) {
      clearInterval(interval);
      return;
    }
    if (position.exiting || position.polling) return;

    position.polling = true;
    try {
      const quote = await getQuote(mint, SOL_MINT, position.tokenAmountRaw);
      const currentSolOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
      const pnlPct = ((currentSolOut - position.sizeSol) / position.sizeSol) * 100;
      const ageMs = Date.now() - position.openedAt;

      position.lastPnlPct = pnlPct;
      position.lastValueNative = currentSolOut;
      position.lastPolledAt = Date.now();

      const rules = resolveExit(position.exit, getConfig());
      const reason = evaluateExit({ pnlPct, ageMs, rules });
      if (reason && Date.now() >= position.nextExitAt) {
        await exitPosition(mint, reason, pnlPct);
      }
    } catch (err) {
      console.error(`[position] price poll failed for ${mint}:`, err.message);
    } finally {
      position.polling = false;
    }
  }, PRICE_POLL_INTERVAL_MS);
}

async function exitPosition(mint, reason, pnlPct) {
  const position = openPositions.get(mint);
  if (!position || position.exiting) return;
  position.exiting = true;

  const wallet = loadWallet();
  let sellResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt += 1) {
    try {
      sellResult = await sellToSol(mint, position.tokenAmountRaw, wallet);
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[position] sell attempt ${attempt}/${SELL_ATTEMPTS} failed for ${mint}:`, err.message);
      if (attempt < SELL_ATTEMPTS) await sleep(SELL_RETRY_BASE_MS * attempt);
    }
  }

  if (!sellResult) {
    // Keep the position tracked so the monitor retries — do NOT abandon it.
    position.exiting = false;
    position.sellFailures += 1;
    position.nextExitAt = Date.now() + Math.min(60000, 10000 * position.sellFailures);
    logTrade({ mint, chain: 'solana', event: 'sell_failed', error: lastErr && lastErr.message, reason });
    if (position.sellFailures === 1 || position.sellFailures % 5 === 0) {
      telegram.notify(
        `⚠️ SELL FAILED for ${mint} (${reason}) after ${SELL_ATTEMPTS} tries: ${lastErr && lastErr.message}\n` +
          `Still holding it — the bot will keep retrying. If it keeps failing, sell manually.`
      );
    }
    return;
  }

  openPositions.delete(mint);

  // Use what the sell actually returned, not the last price poll.
  const exitSol = sellResult.quote ? Number(sellResult.quote.outAmount) / LAMPORTS_PER_SOL : position.lastValueNative;
  const pnlSol = exitSol - position.sizeSol;
  const realizedPct = (pnlSol / position.sizeSol) * 100;
  const rules = resolveExit(position.exit, getConfig());

  console.log(
    `[position] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${mint} — reason=${reason} pnl=${realizedPct.toFixed(1)}% (${pnlSol.toFixed(5)} SOL)`
  );
  logTrade({
    mint,
    chain: 'solana',
    event: 'sell',
    reason,
    pnlPct: realizedPct,
    pnlSol,
    dryRun: sellResult.dryRun,
    signature: sellResult.signature,
  });
  runtime.recordExit('solana', { pnlNative: pnlSol });
  stateSync.recordPositionClosed(position.dbPositionId, {
    exitTx: sellResult.signature,
    exitReason: reason,
    pnlPct: realizedPct,
    pnlNative: pnlSol,
  });
  telegram.notify(
    exitMessage({
      unit: 'SOL',
      address: mint,
      reason,
      size: position.sizeSol,
      exitValue: exitSol,
      heldMs: Date.now() - position.openedAt,
      rules,
      dryRun: sellResult.dryRun,
    })
  );
}

module.exports = { tryEnterPosition, openPositions };
