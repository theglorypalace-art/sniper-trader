// Human-readable Telegram text for entries and exits.
const { resolveExit } = require('./exitRules');

const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a || '');
const sign = (n) => (n >= 0 ? '+' : '−');
const pct = (n, d = 1) => `${sign(n)}${Math.abs(n).toFixed(d)}%`;

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtNative(n, unit) {
  const digits = Math.abs(n) >= 1 ? 4 : 5;
  return `${Number(n).toFixed(digits)} ${unit}`;
}

// "🎯 TP +20% (auto) · 🛑 SL −25% (auto) · ⏱ max hold 20m (auto)"
function describeExit(rules) {
  const src = (c) => (c ? 'yours' : 'auto');
  return (
    `🎯 TP +${rules.takeProfitPct}% (${src(rules.custom.tp)}) · ` +
    `🛑 SL −${Math.abs(rules.stopLossPct)}% (${src(rules.custom.sl)}) · ` +
    `⏱ max hold ${fmtDuration(rules.maxHoldMs).replace(/ 00s$/, '')} (${src(rules.custom.hold)})`
  );
}

function entryMessage({ chainLabel, unit, address, size, capitalPct, balance, assessment, cfg, dryRun }) {
  const rules = resolveExit(assessment.exit, cfg);
  return [
    `🟢 BOUGHT ${short(address)}${dryRun ? ' (dry run)' : ''}`,
    `CA: ${address}`,
    `${chainLabel} • ${fmtNative(size, unit)} (${Number(capitalPct)}% of ${fmtNative(balance, unit)})`,
    `Risk: ${assessment.verdict} (score ${assessment.score})`,
    describeExit(rules),
  ].join('\n');
}

const EXIT_TITLES = {
  take_profit: '✅ TAKE PROFIT HIT',
  stop_loss: '🛑 STOP LOSS HIT',
  max_age: '⏱ MAX HOLD REACHED',
};

function exitMessage({ unit, address, reason, size, exitValue, heldMs, rules, dryRun }) {
  const pnl = exitValue - size;
  const pnlPct = size > 0 ? (pnl / size) * 100 : 0;
  const target =
    reason === 'take_profit'
      ? `target was +${rules.takeProfitPct}% (${rules.custom.tp ? 'yours' : 'auto'})`
      : reason === 'stop_loss'
      ? `stop was −${Math.abs(rules.stopLossPct)}% (${rules.custom.sl ? 'yours' : 'auto'})`
      : `limit was ${fmtDuration(rules.maxHoldMs).replace(/ 00s$/, '')} (${rules.custom.hold ? 'yours' : 'auto'})`;
  return [
    `${EXIT_TITLES[reason] || 'SOLD'} — SOLD ${short(address)}${dryRun ? ' (dry run)' : ''}`,
    `Entry ${fmtNative(size, unit)} → Exit ${fmtNative(exitValue, unit)}`,
    `P&L ${pct(pnlPct)} (${sign(pnl)}${fmtNative(Math.abs(pnl), unit)})`,
    `Held ${fmtDuration(heldMs)} • ${target}`,
  ].join('\n');
}

module.exports = { short, sign, pct, fmtDuration, fmtNative, describeExit, entryMessage, exitMessage };
