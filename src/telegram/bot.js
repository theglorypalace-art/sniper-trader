const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN, PRICE_POLL_INTERVAL_MS } = require('../config');
const { getSupabase } = require('../live/supabaseClient');
const { getConfig, refresh, applyLocal, COLUMNS, MIGRATION_KEYS, isMigrated } = require('../live/liveConfig');
const { getDailyCount } = require('../analysis/dailyLimiter');
const { scannerText, positionsText, heartbeatText, scannerHeadline } = require('./reports');
const runtime = require('../live/runtime');

let bot = null;

function getBot() {
  if (!TELEGRAM_BOT_TOKEN) return null;
  if (bot) return bot;
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  return bot;
}

// ---------------------------------------------------------------------
// Adjustable numeric settings. Each one gets: a value-picker screen with
// presets and -/+ buttons, a "type your own value" option, and a slash
// command (e.g. /setcapital 12.5). Add a new entry here and it shows up
// everywhere automatically.
// ---------------------------------------------------------------------
const SETTINGS = {
  capitalPct: {
    cmd: 'setcapital',
    title: '🟣 Solana — capital per trade',
    unit: '%',
    min: 0.01,
    max: 100,
    presets: [1, 2, 5, 10, 25, 50, 75, 100],
    steps: [1, 5],
    parent: 'm:cap',
    warnAbove: 25,
    describe: (c) => `Each Solana buy uses this % of your SOL balance. ${capNote(c.maxPositionSol, 'SOL')} A small SOL reserve is always kept for fees.`,
  },
  bscCapitalPct: {
    cmd: 'setbsccapital',
    title: '🟡 BSC — capital per trade',
    unit: '%',
    min: 0.01,
    max: 100,
    presets: [1, 2, 5, 10, 25, 50, 75, 100],
    steps: [1, 5],
    parent: 'm:cap',
    warnAbove: 25,
    describe: (c) => `Each BSC buy uses this % of your BNB balance. ${capNote(c.bscMaxPositionBnb, 'BNB')} A small BNB reserve is always kept for gas.`,
  },
  maxPositionSol: {
    cmd: 'setmaxpos',
    title: '🟣 Solana — max per trade',
    unit: ' SOL',
    min: 0,
    max: 100000,
    zeroLabel: 'No cap',
    presets: [0, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    steps: [0.05, 0.25],
    parent: 'm:cap',
    describe: (c) => `Hard ceiling on one Solana buy, no matter what the capital % says (now ${fmt(c.capitalPct)}% of balance). Choose No cap to let the % alone decide the size.`,
  },
  bscMaxPositionBnb: {
    cmd: 'setbscmaxpos',
    title: '🟡 BSC — max per trade',
    unit: ' BNB',
    min: 0,
    max: 100000,
    zeroLabel: 'No cap',
    presets: [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    steps: [0.01, 0.05],
    parent: 'm:cap',
    describe: (c) => `Hard ceiling on one BSC buy, no matter what the capital % says (now ${fmt(c.bscCapitalPct)}% of balance). Choose No cap to let the % alone decide the size.`,
  },
  maxTokensPerDay: {
    cmd: 'setmax',
    title: '🎯 Daily limit',
    unit: '',
    min: 1,
    max: 100,
    int: true,
    presets: [1, 2, 3, 5, 10, 20, 50, 100],
    steps: [1, 5],
    parent: 'menu',
    describe: (c) => `Max tokens recommended (and traded) per UTC day. Used today: ${getDailyCount()}/${c.maxTokensPerDay}.`,
  },
  takeProfitPct: {
    cmd: 'settp',
    title: '🎯 Take profit',
    unit: '%',
    min: 0,
    max: 10000,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 5, 10, 15, 20, 30, 50, 100],
    steps: [1, 5],
    parent: 'm:exit',
    describe: (c) =>
      c.takeProfitPct > 0
        ? `The bot sells the WHOLE position as soon as profit reaches +${fmt(c.takeProfitPct)}%, on every trade. Applies to open positions immediately.\n\nTip: positions are also sold when the max hold time runs out (now ${c.maxHoldMin > 0 ? fmt(c.maxHoldMin) + ' min' : 'auto: 20/12/6 min by risk tier'}) — raise it under Max hold if your target needs longer.`
        : `Auto: each token gets its own target from its risk tier (LOW +20% · MEDIUM +15% · HIGH +12%). Pick a % to use your own target on every trade instead.`,
  },
  stopLossPct: {
    cmd: 'setsl',
    title: '🛑 Stop loss',
    unit: '%',
    min: 0,
    max: 99,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 10, 15, 20, 25, 30, 40, 50],
    steps: [1, 5],
    parent: 'm:exit',
    describe: (c) =>
      c.stopLossPct > 0
        ? `The bot sells the WHOLE position if it falls ${fmt(c.stopLossPct)}% below your entry. Applies to open positions immediately.`
        : `Auto: LOW −25% · MEDIUM −30% · HIGH −35%. Pick a % to use your own stop on every trade instead.`,
  },
  maxHoldMin: {
    cmd: 'setmaxhold',
    title: '⏱ Max hold time',
    unit: ' min',
    min: 0,
    max: 1440,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 5, 10, 20, 30, 60, 120, 240],
    steps: [1, 5],
    parent: 'm:exit',
    describe: () => `If neither take-profit nor stop-loss has fired by then, the bot sells anyway. Auto: LOW 20 · MEDIUM 12 · HIGH 6 minutes.`,
  },
  maxRiskScore: {
    cmd: 'setscore',
    title: '🎚 Entry quality (max risk score)',
    unit: '',
    min: 1,
    max: 100,
    int: true,
    presets: [5, 10, 15, 20, 25, 30, 40, 50],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Only enter tokens whose risk score is at or below this — lower is pickier. LOW tier is ≤ 25, MEDIUM ≤ 50. Every token's score shows in 🔎 Scanner. (Tokens are taken first-come, so this is how you steer toward better ones.)`,
  },
  heartbeatMin: {
    cmd: 'setheartbeat',
    title: '📡 Heartbeat',
    unit: ' min',
    min: 0,
    max: 1440,
    int: true,
    zeroLabel: 'Off',
    zeroIcon: '🔕',
    zeroWord: 'off',
    presets: [0, 15, 30, 60, 120, 240, 360, 720],
    steps: [5, 15],
    parent: 'scan',
    describe: () => `Every N minutes the bot messages you a "still scanning" summary: is the feed alive, how many new tokens it checked, how many passed, and your open positions. Off = only alerts on real events.`,
  },
  maxDevPercent: {
    cmd: 'setdev',
    title: '🔍 Max dev/creator holding',
    unit: '%',
    min: 1,
    max: 100,
    presets: [5, 10, 15, 20, 30, 40, 50, 70],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Tokens where the creator/owner wallet holds more than this % of supply are rejected.`,
  },
  maxTop10Percent: {
    cmd: 'settop10',
    title: '🔍 Max top-10 holders',
    unit: '%',
    min: 1,
    max: 100,
    presets: [30, 40, 50, 60, 70, 80, 90, 100],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Tokens where the top 10 holders control more than this % of supply are rejected.`,
  },
};

const fmt = (n) => String(Number(Number(n).toFixed(4)));
// Display a setting's value, e.g. "12.5%", "0.5 SOL", or "No cap" for a 0 cap.
const valText = (def, v) => (def.zeroLabel && Number(v) === 0 ? def.zeroLabel : `${fmt(v)}${def.unit}`);
const capLabel = (v, unit) => (Number(v) > 0 ? `max ${fmt(v)} ${unit}` : 'no cap');
const capNote = (v, unit) =>
  Number(v) > 0
    ? `Capped at ${fmt(v)} ${unit} per trade — the smaller of the two applies (raise or remove the cap under Max per trade).`
    : `No max-per-trade cap is set, so this % alone decides the size.`;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function validate(def, raw) {
  const n = Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(n)) return { error: 'That is not a number.' };
  if (def.int && !Number.isInteger(n)) return { error: 'Please enter a whole number.' };
  if (n < def.min || n > def.max) {
    return { error: def.zeroLabel ? `Enter a value up to ${fmt(def.max)}${def.unit}, or 0 for ${def.zeroLabel.toLowerCase()}.` : `Must be between ${fmt(def.min)} and ${fmt(def.max)}${def.unit}.` };
  }
  return { value: def.int ? n : round4(n) };
}

// Accepts "12", "12.5", "12,5", "12%", " 0.25 SOL " ... and, for cap settings,
// words like "none" / "no cap" / "off" / "unlimited" (= 0 = no cap).
function parseInput(def, text) {
  const t = String(text).trim();
  if (def.zeroLabel && /^(none|no\s*cap|nocap|off|auto|default|unlimited|no\s*limit|remove)$/i.test(t)) return '0';
  return t.replace(',', '.').replace(/\s*(%|sol|bnb)\s*$/i, '');
}

// ---------------------------------------------------------------------
// Config writes
// ---------------------------------------------------------------------
async function updateConfig(patch) {
  const supabase = getSupabase();
  if (!supabase) {
    // No Supabase: still works, but only until the next restart.
    return applyLocal(patch);
  }
  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!COLUMNS[k]) throw new Error(`Unknown setting: ${k}`);
    // Settings from migration 002 live in memory only until that SQL has been run.
    if (MIGRATION_KEYS.includes(k) && !isMigrated()) continue;
    fields[COLUMNS[k]] = v;
  }
  if (Object.keys(fields).length) {
    const { error } = await supabase.from('bot_config').update({ ...fields, updated_by: 'telegram' }).eq('id', 1);
    if (error) {
      const missingColumn = /column|schema cache/i.test(error.message) && Object.keys(patch).some((k) => MIGRATION_KEYS.includes(k));
      if (!missingColumn) throw error;
      // Column not there yet — keep the change in memory rather than failing the tap.
    } else {
      // Force an immediate re-read instead of waiting on the realtime push or
      // the 15s poll, so what we show next is the true, just-applied state.
      await refresh();
    }
  }
  // Pin the values we just set so what's displayed can never be stale.
  return applyLocal(patch);
}

// If TELEGRAM_CHAT_ID isn't set, anyone who finds the bot can control it —
// set it once you know your chat ID (the bot tells you on /start) to lock
// this down to just you.
function isAuthorized(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

// ---------------------------------------------------------------------
// Views (text + inline keyboard). Every screen has a way back.
// ---------------------------------------------------------------------
const btn = (text, data) => ({ text, callback_data: data });
const view = (text, inline_keyboard) => ({ text: text.length > 4000 ? text.slice(0, 3990) + '\n…' : text, reply_markup: { inline_keyboard } });

function statusText(cfg) {
  const lines = [
    cfg.paused ? '⏸ TRADING STOPPED' : '🟢 TRADING LIVE',
    DRY_RUN ? 'Mode: 🧪 DRY RUN (no real trades)' : 'Mode: 🔴 LIVE (real trades)',
    '',
    `Chains: Solana ${cfg.enableSolana ? 'ON' : 'OFF'} | BSC ${cfg.enableBsc ? 'ON' : 'OFF'}`,
    `Capital per trade: ${fmt(cfg.capitalPct)}% SOL (${capLabel(cfg.maxPositionSol, 'SOL')}) | ${fmt(cfg.bscCapitalPct)}% BNB (${capLabel(cfg.bscMaxPositionBnb, 'BNB')})`,
    `Min tier to recommend: ${cfg.minRecommendTier === 'LOW' ? 'LOW only' : 'LOW + MEDIUM'}`,
    `Daily quota used: ${getDailyCount()}/${cfg.maxTokensPerDay}`,
    `Exit: TP ${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'} | SL ${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'} | max hold ${cfg.maxHoldMin > 0 ? fmt(cfg.maxHoldMin) + 'm' : 'auto'}`,
    `Risk limits: score ≤ ${fmt(cfg.maxRiskScore)} | dev% ≤ ${fmt(cfg.maxDevPercent)} | top10% ≤ ${fmt(cfg.maxTop10Percent)}`,
    '',
    scannerHeadline() || 'Scanner: no chain running',
    `Open positions: ${runtime.getOpenPositions().length}`,
  ];
  if (!getSupabase()) lines.push('', '⚠️ Supabase not configured — changes apply now but reset on restart.');
  else if (!isMigrated()) lines.push('', '⚠️ Take-profit / stop-loss / max-hold / entry-quality / heartbeat settings work now but reset on restart. Run supabase/migrations/002_exit_and_scanner_settings.sql in the Supabase SQL editor to save them.');
  return lines.join('\n');
}

function mainView(cfg, banner) {
  return view((banner ? `${banner}\n\n` : '') + statusText(cfg), [
    [
      cfg.paused ? btn('▶️ Start trading', 'resume') : btn('⏸ Stop trading', 'pause'),
      btn('🔄 Refresh', 'status'),
    ],
    [
      btn(cfg.enableSolana ? '🟣 Solana: ON' : '🟣 Solana: OFF', 'toggle_solana'),
      btn(cfg.enableBsc ? '🟡 BSC: ON' : '🟡 BSC: OFF', 'toggle_bsc'),
    ],
    [btn('📈 Positions', 'pos'), btn('🔎 Scanner', 'scan')],
    [btn('💰 Capital %', 'm:cap'), btn('🎯 Take profit', 'm:exit')],
    [btn('🛡 Risk tier', 'm:risk'), btn('🔍 Filters', 'm:filters')],
    [btn('📅 Daily limit', 'v:maxTokensPerDay'), btn('❓ Help', 'help')],
  ]);
}

function capitalView(cfg, banner) {
  return view(
    (banner ? `${banner}\n\n` : '') +
      `💰 Capital per trade\n\n` +
      `🟣 Solana: ${fmt(cfg.capitalPct)}% of SOL balance (${capLabel(cfg.maxPositionSol, 'SOL')})\n` +
      `🟡 BSC: ${fmt(cfg.bscCapitalPct)}% of BNB balance (${capLabel(cfg.bscMaxPositionBnb, 'BNB')})\n\n` +
      `Set any % from 0.01 to 100. Each buy uses that % of your balance, but never more than the "max per trade" cap — ` +
      `raise it or choose No cap so it doesn't limit you. A small amount is always kept back for fees. ` +
      `Changes apply to the very next trade.`,
    [
      [btn(`🟣 Solana % (${fmt(cfg.capitalPct)}%)`, 'v:capitalPct'), btn(`🟡 BSC % (${fmt(cfg.bscCapitalPct)}%)`, 'v:bscCapitalPct')],
      [btn(`🟣 SOL max (${Number(cfg.maxPositionSol) > 0 ? fmt(cfg.maxPositionSol) : 'no cap'})`, 'v:maxPositionSol'), btn(`🟡 BNB max (${Number(cfg.bscMaxPositionBnb) > 0 ? fmt(cfg.bscMaxPositionBnb) : 'no cap'})`, 'v:bscMaxPositionBnb')],
      [btn('⬅️ Back', 'menu')],
    ]
  );
}

function riskView(cfg, banner) {
  const low = cfg.minRecommendTier === 'LOW';
  return view(
    (banner ? `${banner}\n\n` : '') +
      `🛡 Minimum risk tier to recommend\n\nCurrent: ${low ? 'LOW only (strictest)' : 'LOW + MEDIUM'}\n\n` +
      `LOW only trades the safest-looking tokens. LOW + MEDIUM lets through more, with more risk.`,
    [
      [btn(`${low ? '✅ ' : ''}LOW only`, 't:LOW'), btn(`${low ? '' : '✅ '}LOW + MEDIUM`, 't:LOW_MEDIUM')],
      [btn('⬅️ Back', 'menu')],
    ]
  );
}

function filtersView(cfg) {
  return view(
    `🔍 Risk filters\n\nDev/creator holding limit: ${fmt(cfg.maxDevPercent)}%\nTop-10 holders limit: ${fmt(cfg.maxTop10Percent)}%\nEntry quality: risk score ≤ ${fmt(cfg.maxRiskScore)}\n\n` +
      `Tokens over any limit are skipped before any trade. Tokens are taken first-come, so tighter limits = pickier entries.`,
    [
      [btn(`Dev ≤ ${fmt(cfg.maxDevPercent)}%`, 'v:maxDevPercent'), btn(`Top10 ≤ ${fmt(cfg.maxTop10Percent)}%`, 'v:maxTop10Percent')],
      [btn(`🎚 Entry quality (score ≤ ${fmt(cfg.maxRiskScore)})`, 'v:maxRiskScore')],
      [btn('⬅️ Back', 'menu')],
    ]
  );
}

function exitView(cfg, banner) {
  const tp = cfg.takeProfitPct > 0 ? `+${fmt(cfg.takeProfitPct)}% (yours)` : 'Auto by risk tier';
  const sl = cfg.stopLossPct > 0 ? `−${fmt(cfg.stopLossPct)}% (yours)` : 'Auto by risk tier';
  const hold = cfg.maxHoldMin > 0 ? `${fmt(cfg.maxHoldMin)} min (yours)` : 'Auto by risk tier';
  return view(
    (banner ? `${banner}\n\n` : '') +
      `🎯 Exit rules — when the bot sells\n\n` +
      `🎯 Take profit: ${tp}\n🛑 Stop loss: ${sl}\n⏱ Max hold: ${hold}\n\n` +
      `Auto plan: LOW +20% / −25% / 20 min · MEDIUM +15% / −30% / 12 min · HIGH +12% / −35% / 6 min.\n\n` +
      `The bot checks the sell price every ${Math.max(1, Math.round(PRICE_POLL_INTERVAL_MS / 1000))}s and sells the whole position the moment a rule triggers. ` +
      `Changes apply to open positions immediately. You get a message on every entry and every exit with the real profit/loss.`,
    [
      [btn(`🎯 Take profit (${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'})`, 'v:takeProfitPct'), btn(`🛑 Stop loss (${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'})`, 'v:stopLossPct')],
      [btn(`⏱ Max hold (${cfg.maxHoldMin > 0 ? fmt(cfg.maxHoldMin) + 'm' : 'auto'})`, 'v:maxHoldMin'), btn('📈 Positions', 'pos')],
      [btn('⬅️ Back', 'menu')],
    ]
  );
}

function scannerView(cfg) {
  return view(scannerText(cfg, 60), [
    [btn('🔄 Refresh', 'scan'), btn(`📡 Heartbeat: ${cfg.heartbeatMin > 0 ? fmt(cfg.heartbeatMin) + 'm' : 'off'}`, 'v:heartbeatMin')],
    [btn('📈 Positions', 'pos'), btn('🔍 Filters', 'm:filters')],
    [btn('⬅️ Back', 'menu')],
  ]);
}

function positionsView(cfg) {
  return view(positionsText(cfg), [
    [btn('🔄 Refresh', 'pos'), btn('🎯 Exit rules', 'm:exit')],
    [btn('🔎 Scanner', 'scan'), btn('⬅️ Back', 'menu')],
  ]);
}

function pickerView(key, cfg, banner) {
  const def = SETTINGS[key];
  const cur = cfg[key];
  const shortUnit = def.unit.trim() === '%' ? '%' : '';
  const rows = [];

  for (let i = 0; i < def.presets.length; i += 4) {
    rows.push(
      def.presets.slice(i, i + 4).map((p) =>
        btn(`${Number(cur) === p ? '✅ ' : ''}${def.zeroLabel && p === 0 ? (def.zeroIcon || '♾') + ' ' + def.zeroLabel : fmt(p) + shortUnit}`, `s:${key}:${p}`)
      )
    );
  }
  const [small, large] = def.steps;
  rows.push([
    btn(`−${fmt(large)}`, `d:${key}:${-large}`),
    btn(`−${fmt(small)}`, `d:${key}:${-small}`),
    btn(`+${fmt(small)}`, `d:${key}:${small}`),
    btn(`+${fmt(large)}`, `d:${key}:${large}`),
  ]);
  rows.push([btn('✏️ Type your own value', `c:${key}`)]);
  rows.push([btn('⬅️ Back', def.parent)]);

  const warn = def.warnAbove && Number(cur) > def.warnAbove ? `\n⚠️ That's a large share of your balance — one bad token can hurt.\n` : '';
  return view(
    (banner ? `${banner}\n\n` : '') +
      `${def.title}\n\nCurrent: ${valText(def, cur)}\n${warn}\n${def.describe(cfg)}\n\n` +
      `${def.zeroLabel ? `Any value up to ${fmt(def.max)}${def.unit}, or 0 for ${def.zeroLabel.toLowerCase()}.` : `Range ${fmt(def.min)}–${fmt(def.max)}${def.unit}.`} Tap a preset, nudge with −/+, or type your own.`,
    rows
  );
}

function customPromptView(key) {
  const def = SETTINGS[key];
  return view(
    `✏️ ${def.title}\n\nType the new value and send it (${def.zeroLabel ? `any value up to ${fmt(def.max)}${def.unit}, or "${def.zeroWord || 'none'}" for ${def.zeroLabel.toLowerCase()}` : `${fmt(def.min)}–${fmt(def.max)}${def.unit}`}${def.int ? ', whole number' : ''}).\nExample: ${fmt(def.presets[def.zeroLabel ? 3 : 2])}`,
    [[btn('✖️ Cancel', `v:${key}`)]]
  );
}

const HELP_TEXT =
  `Everything is button-driven — tap /menu (or ❓ Help → Menu) and use the buttons. Typing works too:\n\n` +
  `/menu or /status — control panel\n` +
  `/positions — open positions with live P&L and distance to take-profit\n` +
  `/scanner — is it scanning? feed health, tokens checked, why it isn't buying\n` +
  `/starttrading or /resume — resume buying recommended tokens\n` +
  `/stoptrading or /pause — stop entering new positions (open ones are still monitored/sold)\n` +
  `/solana on|off, /bsc on|off — toggle a chain's trading\n\n` +
  `Capital per trade:\n` +
  `/setcapital <pct> — Solana % of SOL balance per buy (any value 0.01–100)\n` +
  `/setbsccapital <pct> — BSC % of BNB balance per buy\n` +
  `/setmaxpos <sol|none> — Solana max SOL per buy (none = no cap)\n` +
  `/setbscmaxpos <bnb|none> — BSC max BNB per buy (none = no cap)\n\n` +
  `Exit rules (0 or "auto" = automatic by risk tier):\n` +
  `/settp <pct> — take profit % (sell everything at this profit)\n` +
  `/setsl <pct> — stop loss % (sell if down this much)\n` +
  `/setmaxhold <min> — force-sell after this many minutes\n\n` +
  `Selectivity & safety:\n` +
  `/setscore <n> — entry quality: only tokens with risk score ≤ n\n` +
  `/setheartbeat <min|off> — "still scanning" summary every N minutes\n` +
  `/setmax <n> — max tokens per day\n` +
  `/setrisk low|lowmedium — only LOW risk, or LOW+MEDIUM\n` +
  `/setdev <pct> — max dev/creator holding\n` +
  `/settop10 <pct> — max top-10 holder share\n\n` +
  `Send any of the value commands with no number to get buttons for it. /cancel aborts typing a value.\n\n` +
  `Every finding, buy, and sell is pushed here automatically the moment it happens.`;

const helpView = () => view(HELP_TEXT, [[btn('📋 Open menu', 'menu')]]);

// ---------------------------------------------------------------------
// Bot wiring
// ---------------------------------------------------------------------
function start() {
  const b = getBot();
  if (!b) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.');
    return;
  }
  console.log('[telegram] bot started (polling mode)');

  // chatId -> { key, messageId, ts } while waiting for a typed value.
  const pending = new Map();
  const PENDING_TTL_MS = 5 * 60 * 1000;

  b.setMyCommands([
    { command: 'menu', description: 'Open the control panel' },
    { command: 'status', description: 'Show status + buttons' },
    { command: 'positions', description: 'Open positions + live P&L' },
    { command: 'scanner', description: 'Is it scanning? Feed + funnel' },
    { command: 'settp', description: 'Take profit %' },
    { command: 'starttrading', description: 'Start trading' },
    { command: 'stoptrading', description: 'Stop trading' },
    { command: 'setcapital', description: 'Solana capital % per trade' },
    { command: 'setbsccapital', description: 'BSC capital % per trade' },
    { command: 'help', description: 'All commands' },
  ]).catch((err) => console.error('[telegram] setMyCommands failed:', err.message));

  const send = (chatId, v) => b.sendMessage(chatId, v.text, { reply_markup: v.reply_markup });

  async function show(chatId, messageId, v) {
    try {
      await b.editMessageText(v.text, { chat_id: chatId, message_id: messageId, reply_markup: v.reply_markup });
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return; // nothing changed — fine
      throw err;
    }
  }

  const fail = (chatId, err) => b.sendMessage(chatId, `Failed: ${err.message}`);

  // ---- basic commands ----
  b.onText(/^\/start\b/, async (msg) => {
    const intro =
      `Meme coin scanner online.\nYour chat ID: ${msg.chat.id}\n` +
      (TELEGRAM_CHAT_ID ? '' : '⚠️ TELEGRAM_CHAT_ID is not set — set it to this value on Railway so only you can control the bot.\n');
    await b.sendMessage(msg.chat.id, intro);
    if (isAuthorized(msg.chat.id)) await send(msg.chat.id, mainView(getConfig()));
  });

  b.onText(/^\/help\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, helpView());
  });

  b.onText(/^\/(menu|status)\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, mainView(getConfig()));
  });

  b.onText(/^\/positions\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, positionsView(getConfig()));
  });

  b.onText(/^\/scanner\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, scannerView(getConfig()));
  });

  b.onText(/^\/cancel\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    pending.delete(msg.chat.id);
    send(msg.chat.id, mainView(getConfig(), 'Cancelled.'));
  });

  b.onText(/^\/(stoptrading|pause)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: true });
      await send(msg.chat.id, mainView(getConfig(), '⏹ Trading stopped. No new positions will be entered.'));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/(starttrading|resume)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: false });
      await send(msg.chat.id, mainView(getConfig(), '▶️ Trading started.'));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/setrisk(?:@\w+)?(?:\s+(low_?medium|low))?\s*$/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (!match[1]) return send(msg.chat.id, riskView(getConfig()));
    const tier = match[1].toLowerCase() === 'low' ? 'LOW' : 'LOW_MEDIUM';
    try {
      await updateConfig({ minRecommendTier: tier });
      await send(msg.chat.id, riskView(getConfig(), `✅ Minimum recommend tier set to ${tier}.`));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/(solana|bsc)(?:@\w+)?\s+(on|off)\s*$/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const chain = match[1].toLowerCase();
    const on = match[2].toLowerCase() === 'on';
    try {
      await updateConfig(chain === 'solana' ? { enableSolana: on } : { enableBsc: on });
      await send(msg.chat.id, mainView(getConfig(), `✅ ${chain === 'solana' ? 'Solana' : 'BSC'} ${on ? 'ON' : 'OFF'}.`));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  // ---- numeric settings: /setcapital 12.5 etc. (no number => opens buttons) ----
  for (const [key, def] of Object.entries(SETTINGS)) {
    const re = new RegExp(`^\\/${def.cmd}(?:@\\w+)?(?:\\s+(\\S+))?\\s*$`, 'i');
    b.onText(re, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      if (!match[1]) return send(msg.chat.id, pickerView(key, getConfig()));
      const res = validate(def, parseInput(def, match[1]));
      if (res.error) return b.sendMessage(msg.chat.id, `❌ ${res.error}`);
      try {
        await updateConfig({ [key]: res.value });
        await send(msg.chat.id, pickerView(key, getConfig(), `✅ Set to ${valText(def, res.value)}.`));
      } catch (err) {
        fail(msg.chat.id, err);
      }
    });
  }

  // ---- typed values after tapping "✏️ Type your own value" ----
  b.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) {
      if (!/^\/cancel\b/i.test(text)) pending.delete(chatId); // any other command abandons the prompt
      return;
    }
    const p = pending.get(chatId);
    if (!p) return;
    if (!isAuthorized(chatId)) return;
    if (Date.now() - p.ts > PENDING_TTL_MS) {
      pending.delete(chatId);
      return;
    }

    const def = SETTINGS[p.key];
    const res = validate(def, parseInput(def, text));
    if (res.error) {
      return b.sendMessage(chatId, `❌ ${res.error} Try again, or /cancel.`);
    }
    try {
      await updateConfig({ [p.key]: res.value });
      pending.delete(chatId);
      b.deleteMessage(chatId, msg.message_id).catch(() => {}); // tidy up the typed number (best effort)
      const v = pickerView(p.key, getConfig(), `✅ Set to ${valText(def, res.value)}.`);
      try {
        await show(chatId, p.messageId, v);
      } catch (_) {
        await send(chatId, v);
      }
    } catch (err) {
      fail(chatId, err);
    }
  });

  // ---- button taps ----
  b.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (!isAuthorized(chatId)) {
      return b.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    }

    const [action, arg1, arg2] = String(query.data || '').split(':');
    let toast;
    let next;

    try {
      pending.delete(chatId); // leaving a "type a value" prompt cancels it, unless we set it again below

      switch (action) {
        case 'menu':
        case 'status':
          toast = action === 'status' ? 'Refreshed' : undefined;
          await refresh();
          next = mainView(getConfig());
          break;

        case 'help':
          next = helpView();
          break;

        case 'pos':
          toast = 'Updated';
          next = positionsView(getConfig());
          break;

        case 'scan':
          toast = 'Updated';
          next = scannerView(getConfig());
          break;

        case 'pause':
          await updateConfig({ paused: true });
          toast = '⏹ Trading stopped';
          next = mainView(getConfig());
          break;

        case 'resume':
          await updateConfig({ paused: false });
          toast = '▶️ Trading started';
          next = mainView(getConfig());
          break;

        case 'toggle_solana': {
          const on = !getConfig().enableSolana;
          await updateConfig({ enableSolana: on });
          toast = `Solana ${on ? 'ON' : 'OFF'}`;
          next = mainView(getConfig());
          break;
        }

        case 'toggle_bsc': {
          const on = !getConfig().enableBsc;
          await updateConfig({ enableBsc: on });
          toast = `BSC ${on ? 'ON' : 'OFF'}`;
          next = mainView(getConfig());
          break;
        }

        case 'm': // sub-menus
          next =
            arg1 === 'cap' ? capitalView(getConfig())
            : arg1 === 'risk' ? riskView(getConfig())
            : arg1 === 'filters' ? filtersView(getConfig())
            : arg1 === 'exit' ? exitView(getConfig())
            : mainView(getConfig());
          break;

        case 'v': // open a value picker
          if (!SETTINGS[arg1]) throw new Error('Unknown setting');
          next = pickerView(arg1, getConfig());
          break;

        case 's': { // set to a preset
          const def = SETTINGS[arg1];
          if (!def) throw new Error('Unknown setting');
          const res = validate(def, arg2);
          if (res.error) throw new Error(res.error);
          await updateConfig({ [arg1]: res.value });
          toast = `✅ ${valText(def, res.value)}`;
          next = pickerView(arg1, getConfig());
          break;
        }

        case 'd': { // nudge up/down
          const def = SETTINGS[arg1];
          if (!def) throw new Error('Unknown setting');
          const cur = Number(getConfig()[arg1]);
          const target = clamp(round4(cur + Number(arg2)), def.min, def.max);
          if (target === cur) {
            toast = Number(arg2) > 0 ? 'Already at the maximum' : 'Already at the minimum';
          } else {
            await updateConfig({ [arg1]: def.int ? Math.round(target) : target });
            toast = `✅ ${valText(def, target)}`;
          }
          next = pickerView(arg1, getConfig());
          break;
        }

        case 'c': // ask for a typed value
          if (!SETTINGS[arg1]) throw new Error('Unknown setting');
          pending.set(chatId, { key: arg1, messageId, ts: Date.now() });
          next = customPromptView(arg1);
          break;

        case 't': { // risk tier
          const tier = arg1 === 'LOW' ? 'LOW' : 'LOW_MEDIUM';
          await updateConfig({ minRecommendTier: tier });
          toast = `Tier: ${tier === 'LOW' ? 'LOW only' : 'LOW + MEDIUM'}`;
          next = riskView(getConfig());
          break;
        }

        default:
          toast = 'Unknown button — open /menu';
          next = mainView(getConfig());
      }

      await b.answerCallbackQuery(query.id, toast ? { text: toast } : undefined);
      await show(chatId, messageId, next);
    } catch (err) {
      console.error('[telegram] callback_query failed:', err.message);
      b.answerCallbackQuery(query.id, { text: `Failed: ${err.message}`.slice(0, 190), show_alert: true }).catch(() => {});
    }
  });

  b.on('polling_error', (err) => console.error('[telegram] polling error:', err.message));

  // Periodic "still scanning" summary (interval is adjustable; 0 = off).
  let lastHeartbeatAt = Date.now();
  const hb = setInterval(() => {
    const cfg = getConfig();
    const minutes = Number(cfg.heartbeatMin) || 0;
    if (!minutes) {
      lastHeartbeatAt = Date.now();
      return;
    }
    if (Date.now() - lastHeartbeatAt >= minutes * 60 * 1000) {
      lastHeartbeatAt = Date.now();
      notify(heartbeatText(cfg, minutes));
    }
  }, 30 * 1000);
  if (hb.unref) hb.unref();
}

// Called by the position managers for instant push notifications. Safe to
// call even when Telegram isn't configured — it's a no-op then.
function notify(text) {
  const b = getBot();
  if (!b || !TELEGRAM_CHAT_ID) return;
  b.sendMessage(TELEGRAM_CHAT_ID, text).catch((err) => {
    console.error('[telegram] notify failed:', err.message);
  });
}

// One message a few seconds after boot so you know the bot is up, which mode
// it's in, and that the feeds actually connected.
function announceStartup(delayMs = 8000) {
  const t = setTimeout(() => {
    const cfg = getConfig();
    notify(
      [
        '🚀 Scanner started',
        DRY_RUN ? '🧪 DRY RUN — no real trades' : '🔴 LIVE — real trades',
        scannerHeadline() || 'No chain running',
        `Entry: tier ${cfg.minRecommendTier === 'LOW' ? 'LOW only' : 'LOW+MEDIUM'} · score ≤ ${fmt(cfg.maxRiskScore)} · ${getDailyCount()}/${cfg.maxTokensPerDay} used today`,
        `Exit: TP ${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'} · SL ${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'}`,
        cfg.paused ? '⏸ Trading is STOPPED — tap /menu → Start trading.' : '🟢 Trading is on.',
        'Send /scanner any time to see what it is checking.',
      ].join('\n')
    );
  }, delayMs);
  if (t.unref) t.unref();
}

module.exports = { start, notify, announceStartup };
