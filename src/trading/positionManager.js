const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PRICE_POLL_INTERVAL_MS, MAX_CONCURRENT_POSITIONS, SOL_MINT, DRY_RUN } = require('../config');
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

async function tryEnterPosition(mint) {
  if (openPositions.size >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[position] skipping ${mint} — already at MAX_CONCURRENT_POSITIONS (${MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(mint)) return;

  let assessment;
  try {
    assessment = await assessAndGate({ chain: 'solana', address: mint });
  } catch (err) {
    console.error(`[position] risk assessment failed for ${mint}, skipping (fail-closed):`, err.message);
    logTrade({ mint, chain: 'solana', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    return;
  }

  printFindings(mint, assessment);
  logTrade({ mint, chain: 'solana', event: 'assessed', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'solana', address: mint });

  if (assessment.recommended) {
    telegram.notify(findingsMessage(mint, assessment));
  }

  if (!assessment.recommended) return;

  const liveCfg = getConfig();
  if (liveCfg.paused) {
    console.log(`[position] ${mint} was recommended but the bot is currently paused — skipping entry.`);
    return;
  }
  if (!liveCfg.enableSolana) {
    console.log(`[position] ${mint} was recommended but Solana trading is currently disabled — skipping entry.`);
    return;
  }

  const wallet = loadWallet();
  const solBalance = await getSolBalance();
  const rawSize = solBalance * (liveCfg.capitalPct / 100);
  const sizeSol = Math.min(rawSize, liveCfg.maxPositionSol);

  if (sizeSol <= 0) {
    console.log(`[position] skipping ${mint} — computed size non-positive (balance=${solBalance})`);
    return;
  }

  const lamports = Math.floor(sizeSol * LAMPORTS_PER_SOL);

  let buyResult;
  try {
    buyResult = await buySol(mint, lamports, wallet);
  } catch (err) {
    console.error(`[position] buy failed for ${mint}:`, err.message);
    logTrade({ mint, chain: 'solana', event: 'buy_failed', error: err.message });
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
    dbPositionId,
  };
  openPositions.set(mint, position);

  console.log(
    `[position] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${mint} — ${sizeSol.toFixed(4)} SOL @ ${entryPriceSolPerToken}`
  );
  logTrade({ mint, chain: 'solana', event: 'buy', sizeSol, dryRun: buyResult.dryRun, signature: buyResult.signature });
  telegram.notify(`🟢 BOUGHT ${mint}\n${sizeSol.toFixed(4)} SOL${buyResult.dryRun ? ' (dry run)' : ''}`);

  monitorPosition(mint);
}

function monitorPosition(mint) {
  const interval = setInterval(async () => {
    const position = openPositions.get(mint);
    if (!position) {
      clearInterval(interval);
      return;
    }

    try {
      const quote = await getQuote(mint, SOL_MINT, position.tokenAmountRaw);
      const currentSolOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
      const pnlPct = ((currentSolOut - position.sizeSol) / position.sizeSol) * 100;
      const ageMs = Date.now() - position.openedAt;

      const { takeProfitPct, stopLossPct, maxHoldMs } = position.exit;
      const hitTakeProfit = pnlPct >= takeProfitPct;
      const hitStopLoss = stopLossPct != null && pnlPct <= stopLossPct;
      const isStale = ageMs >= maxHoldMs;

      if (hitTakeProfit || hitStopLoss || isStale) {
        clearInterval(interval);
        const reason = hitTakeProfit ? 'take_profit' : hitStopLoss ? 'stop_loss' : 'max_age';
        await exitPosition(mint, reason, pnlPct);
      }
    } catch (err) {
      console.error(`[position] price poll failed for ${mint}:`, err.message);
    }
  }, PRICE_POLL_INTERVAL_MS);
}

async function exitPosition(mint, reason, pnlPct) {
  const position = openPositions.get(mint);
  if (!position) return;
  openPositions.delete(mint);

  const wallet = loadWallet();
  let sellResult;
  try {
    sellResult = await sellToSol(mint, position.tokenAmountRaw, wallet);
  } catch (err) {
    console.error(`[position] sell failed for ${mint}:`, err.message);
    logTrade({ mint, chain: 'solana', event: 'sell_failed', error: err.message, reason });
    telegram.notify(`⚠️ SELL FAILED for ${mint}: ${err.message}`);
    return;
  }

  console.log(
    `[position] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${mint} — reason=${reason} pnl=${pnlPct.toFixed(1)}%`
  );
  logTrade({
    mint,
    chain: 'solana',
    event: 'sell',
    reason,
    pnlPct,
    dryRun: sellResult.dryRun,
    signature: sellResult.signature,
  });
  stateSync.recordPositionClosed(position.dbPositionId, {
    exitTx: sellResult.signature,
    exitReason: reason,
    pnlPct,
  });
  telegram.notify(
    `🔴 SOLD ${mint}\nreason: ${reason}\npnl: ${pnlPct.toFixed(1)}%${sellResult.dryRun ? ' (dry run)' : ''}`
  );
}

module.exports = { tryEnterPosition, openPositions };
