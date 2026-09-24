const { ethers } = require('ethers');
const { BSC_MAX_CONCURRENT_POSITIONS, PRICE_POLL_INTERVAL_MS, DRY_RUN, BNB_FEE_RESERVE } = require('../config');
const { computeTradeSize } = require('../trading/sizing');
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

async function tryEnterPosition(tokenAddress) {
  if (openPositions.size >= BSC_MAX_CONCURRENT_POSITIONS) {
    console.log(`[position-bsc] skipping ${tokenAddress} — already at BSC_MAX_CONCURRENT_POSITIONS (${BSC_MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(tokenAddress)) return;

  let assessment;
  try {
    assessment = await assessAndGate({ chain: 'bsc', address: tokenAddress });
  } catch (err) {
    console.error(`[position-bsc] risk assessment failed for ${tokenAddress}, skipping (fail-closed):`, err.message);
    logTrade({ tokenAddress, chain: 'bsc', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    return;
  }

  printFindings(tokenAddress, assessment);
  logTrade({ tokenAddress, chain: 'bsc', event: 'assessed', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'bsc', address: tokenAddress });

  if (assessment.recommended) {
    telegram.notify(findingsMessage(tokenAddress, assessment));
  }

  if (!assessment.recommended) return;

  const liveCfg = getConfig();
  if (liveCfg.paused) {
    console.log(`[position-bsc] ${tokenAddress} was recommended but the bot is currently paused — skipping entry.`);
    return;
  }
  if (!liveCfg.enableBsc) {
    console.log(`[position-bsc] ${tokenAddress} was recommended but BSC trading is currently disabled — skipping entry.`);
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
    dbPositionId,
  };
  openPositions.set(tokenAddress, position);

  console.log(`[position-bsc] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${tokenAddress} — ${sizeBnb.toFixed(4)} BNB`);
  logTrade({ tokenAddress, chain: 'bsc', event: 'buy', sizeBnb, dryRun: buyResult.dryRun, txHash: buyResult.txHash });
  telegram.notify(`🟢 BOUGHT ${tokenAddress}\n${sizeBnb.toFixed(4)} BNB${buyResult.dryRun ? ' (dry run)' : ''}`);

  monitorPosition(tokenAddress);
}

function monitorPosition(tokenAddress) {
  const interval = setInterval(async () => {
    const position = openPositions.get(tokenAddress);
    if (!position) {
      clearInterval(interval);
      return;
    }

    try {
      const outWei = await quoteSell(tokenAddress, position.tokenAmountRaw);
      const currentBnbOut = Number(ethers.formatEther(outWei));
      const pnlPct = ((currentBnbOut - position.sizeBnb) / position.sizeBnb) * 100;
      const ageMs = Date.now() - position.openedAt;

      const { takeProfitPct, stopLossPct, maxHoldMs } = position.exit;
      const hitTakeProfit = pnlPct >= takeProfitPct;
      const hitStopLoss = stopLossPct != null && pnlPct <= stopLossPct;
      const isStale = ageMs >= maxHoldMs;

      if (hitTakeProfit || hitStopLoss || isStale) {
        clearInterval(interval);
        const reason = hitTakeProfit ? 'take_profit' : hitStopLoss ? 'stop_loss' : 'max_age';
        await exitPosition(tokenAddress, reason, pnlPct);
      }
    } catch (err) {
      console.error(`[position-bsc] price poll failed for ${tokenAddress}:`, err.message);
    }
  }, PRICE_POLL_INTERVAL_MS);
}

async function exitPosition(tokenAddress, reason, pnlPct) {
  const position = openPositions.get(tokenAddress);
  if (!position) return;
  openPositions.delete(tokenAddress);

  const wallet = loadWallet();
  let sellResult;
  try {
    sellResult = await sellForBnb(tokenAddress, position.tokenAmountRaw, wallet);
  } catch (err) {
    console.error(`[position-bsc] sell failed for ${tokenAddress}:`, err.message);
    logTrade({ tokenAddress, chain: 'bsc', event: 'sell_failed', error: err.message, reason });
    telegram.notify(`⚠️ SELL FAILED for ${tokenAddress}: ${err.message}`);
    return;
  }

  console.log(
    `[position-bsc] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${tokenAddress} — reason=${reason} pnl=${pnlPct.toFixed(1)}%`
  );
  logTrade({
    tokenAddress,
    chain: 'bsc',
    event: 'sell',
    reason,
    pnlPct,
    dryRun: sellResult.dryRun,
    txHash: sellResult.txHash,
  });
  stateSync.recordPositionClosed(position.dbPositionId, {
    exitTx: sellResult.txHash,
    exitReason: reason,
    pnlPct,
  });
  telegram.notify(
    `🔴 SOLD ${tokenAddress}\nreason: ${reason}\npnl: ${pnlPct.toFixed(1)}%${sellResult.dryRun ? ' (dry run)' : ''}`
  );
}

module.exports = { tryEnterPosition, openPositions };
