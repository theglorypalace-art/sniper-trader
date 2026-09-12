const { ethers } = require('ethers');
const {
  BSC_CAPITAL_PCT,
  BSC_MAX_POSITION_BNB,
  BSC_MAX_CONCURRENT_POSITIONS,
  PRICE_POLL_INTERVAL_MS,
  MAX_TOKENS_PER_DAY,
  DRY_RUN,
} = require('../config');
const { assessAndGate } = require('../analysis/riskEngine');
const { quoteSell, buyWithBnb, sellForBnb, getTokenDecimals } = require('./pancakeswap');
const { getBnbBalance, loadWallet } = require('./wallet');
const { logTrade } = require('../db/tradeLog');

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

async function tryEnterPosition(tokenAddress) {
  if (openPositions.size >= BSC_MAX_CONCURRENT_POSITIONS) {
    console.log(`[position-bsc] skipping ${tokenAddress} — already at BSC_MAX_CONCURRENT_POSITIONS (${BSC_MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(tokenAddress)) return;

  let assessment;
  try {
    assessment = await assessAndGate({ chain: 'bsc', address: tokenAddress }, MAX_TOKENS_PER_DAY);
  } catch (err) {
    console.error(`[position-bsc] risk assessment failed for ${tokenAddress}, skipping (fail-closed):`, err.message);
    logTrade({ tokenAddress, chain: 'bsc', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    return;
  }

  printFindings(tokenAddress, assessment);
  logTrade({ tokenAddress, chain: 'bsc', event: 'assessed', ...assessment });

  if (!assessment.recommended) return;

  const wallet = loadWallet();
  const bnbBalance = await getBnbBalance();
  const rawSize = bnbBalance * (BSC_CAPITAL_PCT / 100);
  const sizeBnb = Math.min(rawSize, BSC_MAX_POSITION_BNB);

  if (sizeBnb <= 0) {
    console.log(`[position-bsc] skipping ${tokenAddress} — computed size non-positive (balance=${bnbBalance})`);
    return;
  }

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
  const position = {
    tokenAddress,
    sizeBnb,
    tokenAmountRaw: buyResult.outAmountRaw,
    decimals,
    openedAt: Date.now(),
    dryRun: buyResult.dryRun,
    buyTxHash: buyResult.txHash,
    exit: assessment.exit,
  };
  openPositions.set(tokenAddress, position);

  console.log(`[position-bsc] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${tokenAddress} — ${sizeBnb.toFixed(4)} BNB`);
  logTrade({ tokenAddress, chain: 'bsc', event: 'buy', sizeBnb, dryRun: buyResult.dryRun, txHash: buyResult.txHash });

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
}

module.exports = { tryEnterPosition, openPositions };
