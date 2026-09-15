const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('../config');
const { getSupabase } = require('../live/supabaseClient');
const { getConfig } = require('../live/liveConfig');
const { getDailyCount } = require('../analysis/dailyLimiter');

let bot = null;

function getBot() {
  if (!TELEGRAM_BOT_TOKEN) return null;
  if (bot) return bot;
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  return bot;
}

async function updateConfig(fields) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase not configured — live control needs it (see supabase/schema.sql).');
  const { error } = await supabase.from('bot_config').update({ ...fields, updated_by: 'telegram' }).eq('id', 1);
  if (error) throw error;
}

// If TELEGRAM_CHAT_ID isn't set, anyone who finds the bot can control it —
// set it once you know your chat ID (the bot tells you on /start) to lock
// this down to just you.
function isAuthorized(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

function start() {
  const b = getBot();
  if (!b) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.');
    return;
  }
  console.log('[telegram] bot started (polling mode)');

  b.onText(/^\/start/, (msg) => {
    b.sendMessage(
      msg.chat.id,
      `Meme coin scanner online.\nYour chat ID: ${msg.chat.id}\n` +
        (TELEGRAM_CHAT_ID ? '' : '⚠️ TELEGRAM_CHAT_ID is not set — set it to this value so only you can control the bot.\n') +
        `\nCommands:\n/status\n/pause\n/resume\n/setmax <n>\n/setrisk low | lowmedium\n/solana on|off\n/bsc on|off`
    );
  });

  b.onText(/^\/status/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    const cfg = getConfig();
    b.sendMessage(
      msg.chat.id,
      `Status\n` +
        `paused: ${cfg.paused}\n` +
        `solana: ${cfg.enableSolana} | bsc: ${cfg.enableBsc}\n` +
        `min recommend tier: ${cfg.minRecommendTier}\n` +
        `daily quota: ${getDailyCount()}/${cfg.maxTokensPerDay}\n` +
        `dev% limit: ${cfg.maxDevPercent} | top10% limit: ${cfg.maxTop10Percent}\n` +
        `capital: ${cfg.capitalPct}% SOL (max ${cfg.maxPositionSol}) | ${cfg.bscCapitalPct}% BNB (max ${cfg.bscMaxPositionBnb})`
    );
  });

  b.onText(/^\/pause/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: true });
      b.sendMessage(msg.chat.id, 'Paused — no new positions will be entered until /resume.');
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/resume/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: false });
      b.sendMessage(msg.chat.id, 'Resumed.');
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/setmax (\d+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ max_tokens_per_day: Number(match[1]) });
      b.sendMessage(msg.chat.id, `Daily quota set to ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/setrisk (low|lowmedium)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const tier = match[1].toLowerCase() === 'low' ? 'LOW' : 'LOW_MEDIUM';
    try {
      await updateConfig({ min_recommend_tier: tier });
      b.sendMessage(msg.chat.id, `Minimum recommend tier set to ${tier}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/solana (on|off)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ enable_solana: match[1].toLowerCase() === 'on' });
      b.sendMessage(msg.chat.id, `Solana ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/bsc (on|off)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ enable_bsc: match[1].toLowerCase() === 'on' });
      b.sendMessage(msg.chat.id, `BSC ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.on('polling_error', (err) => console.error('[telegram] polling error:', err.message));
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

module.exports = { start, notify };
