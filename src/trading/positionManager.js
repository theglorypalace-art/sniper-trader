const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const {
  CAPITAL_PCT,
  MAX_POSITION_SOL,
  TAKE_PROFIT_PCT,
  STOP_LOSS_PCT,
  PRICE_POLL_INTERVAL_MS,
  MAX_POSITION_AGE_MS,
  MAX_CONCURRENT_POSITIONS,
  SOL_MINT,
  DRY_RUN,
} = require('../config');
const { runSafetyChecks } = require('./safety');
const { getQuote, buySol, sellToSol } = require('./jupiter');
const { getSolBalance, loadWallet } = require('../solana/wallet');
const { logTrade } = require('../db/tradeLog');

const openPositions = new Map(); // mint -> position state

async function tryEnterPosition(mint) {
  if (openPositions.size >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[position] skipping ${mint} — already at MAX_CONCURRENT_POSITIONS (${MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(mint)) return;

  const safety = await runSafetyChecks(mint);
  if (!safety.safe) {
    console.log(`[position] skipping ${mint} — ${safety.reason}`);
    logTrade({ mint, event: 'skipped', reason: safety.reason });
    return;
  }

  const wallet = loadWallet();
  const solBalance = await getSolBalance();
  const rawSize = solBalance * (CAPITAL_PCT / 100);
  const sizeSol = Math.min(rawSize, MAX_POSITION_SOL);

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
    logTrade({ mint, event: 'buy_failed', error: err.message });
    return;
  }

  const entryPriceSolPerToken = lamports / Number(buyResult.quote.outAmount);
  const position = {
    mint,
    sizeSol,
    tokenAmountRaw: Number(buyResult.quote.outAmount),
    entryPriceSolPerToken,
    openedAt: Date.now(),
    dryRun: buyResult.dryRun,
    buySignature: buyResult.signature,
  };
  openPositions.set(mint, position);

  console.log(
    `[position] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${mint} — ${sizeSol.toFixed(4)} SOL @ ${entryPriceSolPerToken}`
  );
  logTrade({ mint, event: 'buy', sizeSol, dryRun: buyResult.dryRun, signature: buyResult.signature });

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

      const hitTakeProfit = pnlPct >= TAKE_PROFIT_PCT;
      const hitStopLoss = STOP_LOSS_PCT != null && pnlPct <= STOP_LOSS_PCT;
      const isStale = ageMs >= MAX_POSITION_AGE_MS;

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
    logTrade({ mint, event: 'sell_failed', error: err.message, reason });
    return;
  }

  console.log(
    `[position] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${mint} — reason=${reason} pnl=${pnlPct.toFixed(1)}%`
  );
  logTrade({
    mint, event: 'sell', reason, pnlPct,
    dryRun: sellResult.dryRun, signature: sellResult.signature,
  });
}

module.exports = { tryEnterPosition, openPositions };
