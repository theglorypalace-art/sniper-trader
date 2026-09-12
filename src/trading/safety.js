const { getQuote } = require('./jupiter');
const { SOL_MINT } = require('../config');

// Before ever buying, confirm the token can actually be sold back to SOL.
// A quote existing doesn't guarantee a real sell will succeed later (a
// malicious token can still add sell restrictions dynamically), but a
// token that can't even be quoted for a sell right now is an immediate,
// strong red flag — do not buy it.
//
// This is now just one input into the full risk engine
// (src/analysis/riskEngine.js), which also checks holder concentration,
// dev wallet %, mint/freeze authority, LP lock status, and pump.fun curve
// status. Nothing in positionManager.js calls this directly anymore —
// riskEngine.js does.
async function canSell(mint, testAmountRaw = 1000) {
  try {
    const quote = await getQuote(mint, SOL_MINT, testAmountRaw);
    return Boolean(quote && quote.outAmount && Number(quote.outAmount) > 0);
  } catch {
    return false;
  }
}

module.exports = { canSell };
