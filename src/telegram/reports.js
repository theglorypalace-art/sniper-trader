// Text for the "what is the bot doing right now" screens. Pure functions over
// the runtime registry + live config, so they're easy to test and reuse
// (Telegram buttons, the periodic heartbeat, the main status line).
const staticConfig = require('../config');
const runtime = require('../live/runtime');
const { getDailyCount } = require('../analysis/dailyLimiter');
const { resolveExit } = require('../trading/exitRules');
const { short, pct, fmtDuration, fmtNative, sign } = require('../trading/present');

const CHAINS = {
  solana: { label: '🟣 Solana', unit: 'SOL', enabled: () => staticConfig.ENABLE_SOLANA, envName: 'ENABLE_SOLANA', maxOpen: () => staticConfig.MAX_CONCURRENT_POSITIONS, cfgFlag: 'enableSolana' },
  bsc: { label: '🟡 BSC', unit: 'BNB', enabled: () => staticConfig.ENABLE_BSC, envName: 'ENABLE_BSC', maxOpen: () => staticConfig.BSC_MAX_CONCURRENT_POSITIONS, cfgFlag: 'enableBsc' },
};

const STATE_ICON = { connected: '🟢', connecting: '🟡', reconnecting: '🟠', stalled: '🔴', idle: '⚪' };

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  return `${fmtDuration(s * 1000)} ago`;
}

function feedLine(chain) {
  const meta = CHAINS[chain];
  if (!meta.enabled()) return `${meta.label}: ⚪ not running (${meta.envName} is off on Railway)`;
  const c = runtime.snapshot().chains[chain];
  const icon = STATE_ICON[c.detector] || '⚪';
  const alive = c.lastMessageAt ? `last event ${ago(c.lastMessageAt)}` : 'no events yet';
  const rc = c.reconnects ? ` · ${c.reconnects} reconnect${c.reconnects > 1 ? 's' : ''}` : '';
  return `${meta.label}: ${icon} feed ${c.detector} (${alive}${rc})`;
}

function openFor(chain) {
  return runtime.getOpenPositions().filter((p) => p.chain === chain);
}

// Everything currently preventing a NEW entry, so "why isn't it buying?" always has an answer.
function entryBlockers(cfg, chain) {
  const meta = CHAINS[chain];
  const out = [];
  if (cfg.paused) out.push('trading is STOPPED');
  if (!cfg[meta.cfgFlag]) out.push(`${meta.label.slice(3)} is switched OFF`);
  const used = getDailyCount();
  if (used >= cfg.maxTokensPerDay) out.push(`daily limit reached (${used}/${cfg.maxTokensPerDay})`);
  if (openFor(chain).length >= meta.maxOpen()) out.push('a position is already open');
  return out;
}

function realizedLine() {
  const snap = runtime.snapshot().chains;
  const parts = [];
  for (const [chain, meta] of Object.entries(CHAINS)) {
    const t = snap[chain].totals;
    if (t.exited > 0) {
      parts.push(`${meta.label.slice(0, 2)} ${t.exited} closed (${t.wins}W/${t.losses}L) ${sign(t.realizedNative)}${fmtNative(Math.abs(t.realizedNative), meta.unit)}`);
    }
  }
  return parts.length ? `Realized since boot: ${parts.join(' | ')}` : 'Realized since boot: no closed trades yet';
}

const topEntries = (obj, n = 3) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

function funnel(chain, minutes) {
  const w = runtime.windowSum(chain, minutes);
  return `${w.launches} new → ${w.assessed} checked → ${w.passed} passed safety → ${w.recommended} recommended → ${w.entered} bought`;
}

function windowLabel(minutes) {
  return minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

// ---- 🔎 Scanner screen ----
function scannerText(cfg, minutes = 60) {
  const snap = runtime.snapshot();
  const lines = ['🔎 Scanner — live', `Up ${fmtDuration(Date.now() - snap.startedAt)}`, ''];

  for (const [chain, meta] of Object.entries(CHAINS)) {
    lines.push(feedLine(chain));
    if (!meta.enabled()) continue;
    const c = snap.chains[chain];
    lines.push(`  Last new token: ${ago(c.lastLaunchAt)} • ${c.totals.launches} seen since boot`);
    lines.push(`  Last ${windowLabel(minutes)}: ${funnel(chain, minutes)}`);
    const rej = topEntries(c.rejects);
    if (rej.length) lines.push(`  Rejected mostly: ${rej.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
    const skp = topEntries(c.skips);
    if (skp.length) lines.push(`  Safe but not bought: ${skp.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
    const blockers = entryBlockers(cfg, chain);
    lines.push(blockers.length ? `  ⛔ Not entering now: ${blockers.join('; ')}` : '  ✅ Ready to enter the next token that passes');
  }

  lines.push('', `Entry filter: tier ${cfg.minRecommendTier === 'LOW' ? 'LOW only' : 'LOW+MEDIUM'} • risk score ≤ ${cfg.maxRiskScore} • dev ≤ ${cfg.maxDevPercent}% • top10 ≤ ${cfg.maxTop10Percent}%`);
  lines.push(`Daily limit: ${getDailyCount()}/${cfg.maxTokensPerDay} used`);

  if (snap.recent.length) {
    lines.push('', 'Last checked:');
    for (const r of snap.recent.slice(0, 5)) {
      const meta = CHAINS[r.chain];
      const outcome = r.recommended ? '✅ bought/recommended' : r.tradeable ? '➖ safe, not taken' : '❌ rejected';
      lines.push(`• ${ago(r.at)} ${meta.label.slice(0, 2)} ${short(r.address)} — ${r.verdict}${r.score != null && r.verdict !== 'UNSAFE' ? ` (${Number(r.score).toFixed(0)})` : ''} ${outcome}`);
    }
  }

  lines.push('', `Open positions: ${runtime.getOpenPositions().length}`, realizedLine());
  return lines.join('\n');
}

// ---- 📈 Positions screen ----
function positionsText(cfg) {
  const open = runtime.getOpenPositions();
  const lines = [];
  if (!open.length) {
    lines.push('📈 No open positions.', '', 'The bot is waiting for a token that passes your filters — see 🔎 Scanner for what it has checked.');
  } else {
    lines.push(`📈 Open positions (${open.length})`);
    for (const p of open) {
      const meta = CHAINS[p.chain];
      const rules = resolveExit(p.exit, cfg); // live: reflects your current settings
      const pnlNative = (p.valueNative ?? p.size) - p.size;
      const pnlPct = p.pnlPct || 0;
      const toTp = rules.takeProfitPct > 0 && pnlPct > 0 ? Math.min(100, (pnlPct / rules.takeProfitPct) * 100) : 0;
      const toSl = pnlPct < 0 && rules.stopLossPct < 0 ? Math.min(100, (pnlPct / rules.stopLossPct) * 100) : 0;
      const progress = pnlPct >= 0 ? `${toTp.toFixed(0)}% of the way to take-profit` : `${toSl.toFixed(0)}% of the way to stop-loss`;
      lines.push(
        '',
        `${meta.label.slice(0, 2)} ${short(p.address)}${p.dryRun ? ' [DRY RUN]' : ''} — ${p.verdict}`,
        `Size ${fmtNative(p.size, meta.unit)} → now ${fmtNative(p.valueNative ?? p.size, meta.unit)}`,
        `P&L ${pct(pnlPct)} (${sign(pnlNative)}${fmtNative(Math.abs(pnlNative), meta.unit)}) • ${progress}`,
        `🎯 +${rules.takeProfitPct}%${rules.custom.tp ? '' : ' (auto)'} • 🛑 −${Math.abs(rules.stopLossPct)}% • ⏱ ${fmtDuration(Date.now() - p.openedAt)} of ${fmtDuration(rules.maxHoldMs).replace(/ 00s$/, '')}`,
        p.lastPolledAt ? `price checked ${ago(p.lastPolledAt)}` : 'waiting for first price check'
      );
      if (p.exiting) lines.push('⏳ selling now…');
      else if (p.sellFailures) lines.push(`⚠️ last sell attempt failed (×${p.sellFailures}) — retrying automatically`);
    }
  }
  lines.push('', realizedLine());
  return lines.join('\n');
}

// ---- 📡 periodic heartbeat ----
function heartbeatText(cfg, minutes) {
  const lines = ['📡 Still scanning', ''];
  for (const [chain, meta] of Object.entries(CHAINS)) {
    if (!meta.enabled()) continue;
    lines.push(feedLine(chain));
    lines.push(`  Last ${windowLabel(minutes)}: ${funnel(chain, minutes)}`);
    const blockers = entryBlockers(cfg, chain);
    if (blockers.length) lines.push(`  ⛔ Not entering: ${blockers.join('; ')}`);
  }
  const open = runtime.getOpenPositions();
  lines.push('', `Open positions: ${open.length}${open.length ? ' — ' + open.map((p) => `${short(p.address)} ${pct(p.pnlPct || 0)}`).join(', ') : ''}`);
  lines.push(realizedLine());
  return lines.join('\n');
}

// One-liner for the main status screen.
function scannerHeadline() {
  return Object.entries(CHAINS)
    .filter(([, meta]) => meta.enabled())
    .map(([chain, meta]) => {
      const c = runtime.snapshot().chains[chain];
      return `${meta.label.slice(0, 2)} ${STATE_ICON[c.detector] || '⚪'} ${c.detector} • last new token ${ago(c.lastLaunchAt)}`;
    })
    .join(' | ');
}

module.exports = { scannerText, positionsText, heartbeatText, scannerHeadline, entryBlockers, feedLine };
