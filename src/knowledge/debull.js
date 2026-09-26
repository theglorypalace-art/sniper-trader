/**
 * DE-BULL Academy knowledge applied to bot defaults.
 * Full notes: docs/DEBULL_KNOWLEDGE.md
 *
 * Manual class formula (partial exits):
 *   TP 100% sell ~90% | moonbag toward 1000% | SL -45% full
 * Bot uses a single full-exit plan per position (simpler & safer to automate).
 */

/** Recommended max % of wallet per snipe (class: trade with 10% of capital). */
const CAPITAL_PCT_RECOMMENDED = 10;

/** Class advanced stop. */
const STOP_LOSS_PCT = -45;

/**
 * Practical auto-exit plans derived from DE-BULL (not identical to multi-leg manual plan).
 * Longer holds than "spray and 5-min flat" so TP can actually print.
 */
function exitPlanFor(tier) {
  switch (tier) {
    case 'LOW':
      // Closer to class 100–200% target band; give the trade room
      return { takeProfitPct: 80, stopLossPct: STOP_LOSS_PCT, maxHoldMs: 20 * 60 * 1000 };
    case 'MEDIUM':
      return { takeProfitPct: 50, stopLossPct: STOP_LOSS_PCT, maxHoldMs: 15 * 60 * 1000 };
    case 'HIGH':
      return { takeProfitPct: 35, stopLossPct: STOP_LOSS_PCT, maxHoldMs: 10 * 60 * 1000 };
    default:
      return { takeProfitPct: 25, stopLossPct: STOP_LOSS_PCT, maxHoldMs: 8 * 60 * 1000 };
  }
}

/** Soft preference: migrated / final stretch are higher quality than brand-new curve spam. */
function categoryQualityBonus(category) {
  if (category === 'migrated') return -8; // lower risk score
  if (category === 'final_stretch') return -4;
  if (category === 'new') return 5; // first-pump trap bias
  return 0;
}

const RULES = {
  neverReplaceStopWithHope: true,
  firstPumpOftenTrap: true,
  maxCapitalPct: CAPITAL_PCT_RECOMMENDED,
  preferTrendingNarrative: true,
  missBetterThanLoss: true,
};

module.exports = {
  CAPITAL_PCT_RECOMMENDED,
  STOP_LOSS_PCT,
  exitPlanFor,
  categoryQualityBonus,
  RULES,
};
