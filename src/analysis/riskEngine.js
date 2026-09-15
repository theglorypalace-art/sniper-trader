// Combines on-chain + GoPlus data into a single verdict per token:
// LOW / MEDIUM / HIGH / CRITICAL risk, a category (new / final_stretch /
// migrated / developing), a community-coin flag, and a suggested exit plan
// (take-profit / stop-loss / max hold time).
//
// Several thresholds here (max dev %, max top-10 %, minimum tier that
// counts as "recommended", daily quota) are read from live config
// (src/live/liveConfig.js) instead of being hardcoded, so they can be
// changed from Telegram/the dashboard without a redeploy. If Supabase
// isn't configured, liveConfig falls back to sane static defaults.
//
// This is a heuristic filter, not a guarantee. A "LOW risk" verdict means
// the obvious, checkable rug patterns weren't found right now — it does
// not mean the token can't still go to zero. Liquidity can be pulled,
// wallets can dump, and none of this replaces your own judgment.
const { getSolanaTokenSecurity, getEvmTokenSecurity } = require('./goplus');
const { getBondingCurveState, curveProgressPct } = require('./pumpfunCurve');
const { canSell } = require('../trading/safety');
const { tryConsumeDailySlot } = require('./dailyLimiter');
const { getConfig } = require('../live/liveConfig');

const RISK_TIERS = [
  { max: 25, label: 'LOW' },
  { max: 50, label: 'MEDIUM' },
  { max: 75, label: 'HIGH' },
  { max: Infinity, label: 'CRITICAL' },
];

function tierFor(score) {
  return RISK_TIERS.find((t) => score <= t.max).label;
}

function reject(chain, address, reason) {
  return {
    chain,
    address,
    verdict: 'UNSAFE',
    tradeable: false,
    recommended: false,
    score: 100,
    reasons: [reason],
    category: null,
    isCommunityCoin: false,
    devPercent: null,
    top10Percent: null,
    curveProgressPct: null,
    migrated: null,
    exit: null,
  };
}

function exitPlanFor(tier) {
  switch (tier) {
    case 'LOW':
      return { takeProfitPct: 20, stopLossPct: -25, maxHoldMs: 20 * 60 * 1000 };
    case 'MEDIUM':
      return { takeProfitPct: 15, stopLossPct: -30, maxHoldMs: 12 * 60 * 1000 };
    default:
      return { takeProfitPct: 12, stopLossPct: -35, maxHoldMs: 6 * 60 * 1000 };
  }
}

function finalize(input) {
  const tier = tierFor(input.score);
  const tradeable = tier === 'LOW' || tier === 'MEDIUM';
  return {
    ...input,
    verdict: tier,
    tradeable,
    recommended: false, // set by assessAndGate once the live-config gate + daily quota are checked
    exit: tradeable ? exitPlanFor(tier) : null,
  };
}

// -------------------- Solana / pump.fun --------------------

async function assessSolanaToken(mint) {
  const cfg = getConfig();
  const maxDevPercent = cfg.maxDevPercent ?? 30;
  const maxTop10Percent = cfg.maxTop10Percent ?? 70;
  const reasons = [];
  let score = 0;

  const sellable = await canSell(mint);
  if (!sellable) {
    return reject('solana', mint, 'No sell route found right now (possible honeypot or dead liquidity).');
  }

  let sec = null;
  try {
    sec = await getSolanaTokenSecurity(mint);
  } catch (err) {
    reasons.push(`GoPlus lookup failed (${err.message}) — scoring conservatively without it.`);
    score += 10;
  }

  let devPercent = null;
  let top10Percent = null;
  let lpBurnPercent = null;

  if (sec) {
    if (sec.freezable && sec.freezable.status === '1') {
      return reject('solana', mint, 'Freeze authority is still active — the creator can block anyone from trading at will.');
    }
    if (sec.mintable && sec.mintable.status === '1') {
      score += 20;
      reasons.push('Mint authority is still active — supply can be inflated after you buy.');
    }
    if (Array.isArray(sec.holders) && sec.holders.length) {
      top10Percent = sec.holders.reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
      const creatorHolder = sec.holders.find((h) => /creator|deployer/i.test(h.tag || ''));
      if (creatorHolder) devPercent = Number(creatorHolder.percent || 0) * 100;
    }
    if (Array.isArray(sec.dex) && sec.dex.length) {
      lpBurnPercent = Math.max(...sec.dex.map((d) => Number(d.burn_percent || 0)));
    }
  }

  if (devPercent != null) {
    if (devPercent > maxDevPercent) {
      return reject('solana', mint, `Creator/dev wallet holds ~${devPercent.toFixed(1)}% of supply — over the ${maxDevPercent}% limit.`);
    }
    score += Math.min(40, devPercent * 2);
    reasons.push(`Dev/creator wallet holds ~${devPercent.toFixed(1)}% of supply.`);
  } else {
    reasons.push('Could not confirm dev wallet holding % from available data.');
    score += 8;
  }

  if (top10Percent != null) {
    if (top10Percent > maxTop10Percent) {
      return reject('solana', mint, `Top 10 holders control ~${top10Percent.toFixed(1)}% of supply — over the ${maxTop10Percent}% limit.`);
    }
    if (top10Percent > 20) score += Math.min(25, top10Percent - 20);
    reasons.push(`Top 10 holders control ~${top10Percent.toFixed(1)}% of supply.`);
  }

  const curveState = await getBondingCurveState(mint).catch(() => null);
  const progressPct = curveState ? curveProgressPct(curveState) : null;
  const migrated = curveState ? curveState.complete : null;

  if (lpBurnPercent != null && lpBurnPercent < 50 && !migrated) {
    score += 15;
    reasons.push(`Only ~${lpBurnPercent.toFixed(0)}% of LP is burned/locked.`);
  }

  let category = 'developing';
  if (migrated) {
    category = 'migrated';
  } else if (progressPct != null && progressPct >= 80) {
    category = 'final_stretch';
    score += 10;
    reasons.push(`Bonding curve ~${progressPct.toFixed(0)}% complete — close to Raydium migration; expect a volatility spike either way.`);
  } else if (progressPct != null && progressPct < 20) {
    category = 'new';
    reasons.push(`Very early — bonding curve only ~${progressPct.toFixed(0)}% complete, largely unproven.`);
  }

  const isCommunityCoin = devPercent != null && devPercent < 5 && (top10Percent == null || top10Percent < 40);
  if (isCommunityCoin) {
    reasons.push('Holdings look broadly distributed — reads as a community coin rather than a dev-controlled one.');
  }

  return finalize({
    chain: 'solana',
    address: mint,
    score,
    reasons,
    category,
    isCommunityCoin,
    devPercent,
    top10Percent,
    curveProgressPct: progressPct,
    migrated,
  });
}

// -------------------- BNB Smart Chain / PancakeSwap --------------------

async function assessBscToken(address) {
  const cfg = getConfig();
  const maxDevPercent = cfg.maxDevPercent ?? 30;
  const maxTop10Percent = cfg.maxTop10Percent ?? 70;
  const reasons = [];
  let score = 0;

  let sec = null;
  try {
    sec = await getEvmTokenSecurity(address);
  } catch (err) {
    return reject('bsc', address, `GoPlus lookup failed (${err.message}) — too risky to trade blind.`);
  }
  if (!sec) {
    return reject('bsc', address, 'No security data available for this token yet — too new/unverified to trust.');
  }

  if (sec.is_honeypot === '1') {
    return reject('bsc', address, 'Flagged as a honeypot by GoPlus (can buy, cannot sell).');
  }
  if (sec.cannot_sell_all === '1') {
    return reject('bsc', address, 'Contract can prevent holders from selling all of their tokens in one go.');
  }
  if (sec.is_open_source === '0') {
    return reject('bsc', address, "Contract is not verified/open-source — can't assess it further.");
  }
  if (sec.selfdestruct === '1') {
    return reject('bsc', address, 'Contract has a self-destruct function.');
  }

  const buyTax = Number(sec.buy_tax || 0) * 100;
  const sellTax = Number(sec.sell_tax || 0) * 100;
  if (buyTax >= 100 || sellTax >= 100 || sec.cannot_buy === '1') {
    return reject('bsc', address, 'Cannot actually buy and/or sell this token right now.');
  }
  if (buyTax > 15 || sellTax > 15) {
    return reject('bsc', address, `Buy/sell tax too high (buy ${buyTax.toFixed(1)}%, sell ${sellTax.toFixed(1)}%) to safely flip.`);
  }
  if (buyTax + sellTax > 10) {
    score += 15;
    reasons.push(`Combined buy+sell tax is ${(buyTax + sellTax).toFixed(1)}% — eats into any quick exit.`);
  }

  const devPercent = sec.owner_percent != null && sec.owner_percent !== '' ? Number(sec.owner_percent) * 100 : null;
  if (devPercent != null) {
    if (devPercent > maxDevPercent) {
      return reject('bsc', address, `Owner wallet holds ~${devPercent.toFixed(1)}% of supply — over the ${maxDevPercent}% limit.`);
    }
    score += Math.min(40, devPercent * 2);
    reasons.push(`Owner/dev wallet holds ~${devPercent.toFixed(1)}% of supply.`);
  } else {
    reasons.push('No confirmed owner address/holding — could mean renounced, could mean hidden.');
    score += 8;
  }

  const holders = Array.isArray(sec.holders) ? sec.holders : [];
  const top10Percent = holders.reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
  if (top10Percent > maxTop10Percent) {
    return reject('bsc', address, `Top 10 holders control ~${top10Percent.toFixed(1)}% of supply — over the ${maxTop10Percent}% limit.`);
  }
  if (top10Percent > 20) score += Math.min(25, top10Percent - 20);
  if (holders.length) reasons.push(`Top 10 holders control ~${top10Percent.toFixed(1)}% of supply.`);

  if (sec.is_mintable === '1') {
    score += 20;
    reasons.push('Contract can mint new supply after launch.');
  }
  if (sec.hidden_owner === '1' || sec.can_take_back_ownership === '1') {
    score += 20;
    reasons.push('Ownership can be hidden or reclaimed — renounced ownership may not be real.');
  }

  const lpHolders = Array.isArray(sec.lp_holders) ? sec.lp_holders : [];
  const lpLockedPercent = lpHolders
    .filter((h) => Number(h.is_locked) === 1 || /burn/i.test(h.tag || ''))
    .reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
  if (lpHolders.length && lpLockedPercent < 50) {
    score += 20;
    reasons.push(`Only ~${lpLockedPercent.toFixed(0)}% of LP is locked/burned.`);
  } else if (!lpHolders.length) {
    score += 10;
    reasons.push('No LP holder data available yet — liquidity depth unconfirmed.');
  }

  const holderCount = Number(sec.holder_count || 0);
  if (holderCount < 30) {
    score += 10;
    reasons.push(`Only ${holderCount || 'a handful of'} holders so far — very early.`);
  }

  const isCommunityCoin = devPercent != null && devPercent < 5 && top10Percent < 40;
  if (isCommunityCoin) {
    reasons.push('Holdings look broadly distributed — reads as a community coin rather than a dev-controlled one.');
  }

  return finalize({
    chain: 'bsc',
    address,
    score,
    reasons,
    category: 'new',
    isCommunityCoin,
    devPercent,
    top10Percent,
    curveProgressPct: null,
    migrated: null,
  });
}

// Runs the full assessment, applies the live "minimum tier to recommend"
// gate, then the "very selective, max N/day" gate. Reads both from live
// config so they're adjustable from Telegram/the dashboard without a
// redeploy. Everything evaluated is still returned (with full reasoning)
// for instant feedback — only assessment.recommended changes.
async function assessAndGate({ chain, address }) {
  const cfg = getConfig();
  const assessment = chain === 'solana' ? await assessSolanaToken(address) : await assessBscToken(address);
  if (!assessment.tradeable) return assessment;

  if (assessment.verdict === 'MEDIUM' && cfg.minRecommendTier === 'LOW') {
    assessment.reasons.push('MEDIUM risk tokens are currently turned off (min recommend tier = LOW).');
    return assessment;
  }

  const gotSlot = tryConsumeDailySlot(cfg.maxTokensPerDay);
  assessment.recommended = gotSlot;
  if (!gotSlot) {
    assessment.reasons.push(`Passed the safety filter, but today's ${cfg.maxTokensPerDay}-token quota is already used.`);
  }
  return assessment;
}

module.exports = { assessSolanaToken, assessBscToken, assessAndGate };
