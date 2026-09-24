// Shared position-sizing rule for both chains.
//
//   size = balance * pct/100
//   ...but never more than what's left after a small fee reserve (so a
//   100% setting can't drain the wallet to zero and leave nothing for gas /
//   token-account rent / the eventual sell),
//   ...and never more than `cap`, unless cap is 0/null (= no cap).
function computeTradeSize({ balance, pct, cap, reserve = 0 }) {
  const bal = Number(balance);
  if (!Number.isFinite(bal) || bal <= 0) return { size: 0, limitedBy: 'empty wallet' };

  let size = bal * (Number(pct) / 100);
  let limitedBy = 'capital %';

  const spendable = Math.max(0, bal - Number(reserve || 0));
  if (size > spendable) {
    size = spendable;
    limitedBy = 'fee reserve';
  }

  const c = Number(cap);
  if (Number.isFinite(c) && c > 0 && size > c) {
    size = c;
    limitedBy = 'max-per-trade cap';
  }

  return { size, limitedBy };
}

module.exports = { computeTradeSize };
