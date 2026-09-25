// The single place that decides WHEN a position is sold.
//
// Each token gets an automatic exit plan from the risk engine (by risk tier).
// Your own settings (Telegram / dashboard) override any part of it:
//   take profit %, stop loss %, max hold minutes — 0 means "use the auto plan".
// Rules are re-read from live config on every price poll, so changing a
// setting takes effect on positions that are already open.
const staticConfig = require('../config');

function resolveExit(plan, cfg) {
  const p = plan || {};
  const tp = Number(cfg.takeProfitPct) > 0;
  const sl = Number(cfg.stopLossPct) > 0;
  const hold = Number(cfg.maxHoldMin) > 0;
  return {
    takeProfitPct: tp ? Number(cfg.takeProfitPct) : p.takeProfitPct ?? staticConfig.TAKE_PROFIT_PCT,
    stopLossPct: sl ? -Math.abs(Number(cfg.stopLossPct)) : p.stopLossPct ?? staticConfig.STOP_LOSS_PCT,
    maxHoldMs: hold ? Number(cfg.maxHoldMin) * 60 * 1000 : p.maxHoldMs ?? staticConfig.MAX_POSITION_AGE_MS,
    custom: { tp, sl, hold },
  };
}

// Returns 'take_profit' | 'stop_loss' | 'max_age' | null.
function evaluateExit({ pnlPct, ageMs, rules }) {
  if (pnlPct >= rules.takeProfitPct) return 'take_profit';
  if (rules.stopLossPct != null && pnlPct <= rules.stopLossPct) return 'stop_loss';
  if (ageMs >= rules.maxHoldMs) return 'max_age';
  return null;
}

module.exports = { resolveExit, evaluateExit };
