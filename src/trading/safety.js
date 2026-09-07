const { getQuote } = require('./jupiter');
const { SOL_MINT } = require('../config');

// Before ever buying, confirm the token can actually be sold back to SOL.
// A quote existing doesn't guarantee a real sell will succeed later (a
// malicious token can still add sell restrictions dynamically), but a
// token that can't even be quoted for a sell right now is an immediate,
// strong red flag — do not buy it.
async function canSell(mint, testAmountRaw = 1000) {
  try {
    const quote = await getQuote(mint, SOL_MINT, testAmountRaw);
    return Boolean(quote && quote.outAmount && Number(quote.outAmount) > 0);
  } catch {
    return false;
  }
}

// Extend this over time — e.g. checking mint/freeze authority via
// getParsedAccountInfo, holder concentration, or a rug-check API. This is
// intentionally a minimal starting point, not a complete safety net.
async function runSafetyChecks(mint) {
  const sellable = await canSell(mint);
  if (!sellable) {
    return { safe: false, reason: 'No sell route found (possible honeypot or dead liquidity).' };
  }
  return { safe: true, reason: null };
}

module.exports = { canSell, runSafetyChecks };
