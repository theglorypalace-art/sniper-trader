const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('../config');
const { getSupabase } = require('../live/supabaseClient');
const { getConfig, refresh } = require('../live/liveConfig');
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
  if (!supabase) throw new Error("Supabase not configured — live control needs it (see supabase/schema.sql).");
  const { error } = await supabase.from('bot_config').update({ ...fields, updated_by: 'telegram' }).eq('id', 1);
  if (error) throw error;
  // Force an immediate re-read instead of waiting on the realtime push or
  // the 15s poll, so the confirmation message that follows always shows
  // the true, just-applied state — not a stale cached value.
  return refresh();
}

// If TELEGRAM_CHAT_ID isn't set, anyone who finds the bot can control it —
// set it once you know your chat ID (the bot tells you on /start) to lock
// this down to just you.
function isAuthorized(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

function statusText(cfg) {
  return (
    `${cfg.paused ? '⏸ TRADING STOPPED' : '🟢 TRADING LIVE'}\n\n` +
    `Chains: Solana ${cfg.enableSolana ? 'ON' : 'OFF'} | BSC ${cfg.enableBsc ? 'ON' : 'OFF'}\n` +
    `Min tier to recommend: ${cfg.minRecommendTier}\n` +
    `Daily quota used: ${getDailyCount()}/${cfg.maxTokensPerDay}\n` +
    `Risk limits: dev% ≤ ${cfg.maxDevPercent} | top10% ≤ ${cfg.maxTop10Percent}\n` +
    `Position size: ${cfg.capitalPct}% SOL (max ${cfg.maxPositionSol}) | ${cfg.bscCapitalPct}% BNB (max ${cfg.bscMaxPositionBnb})`
  );
}

function controlKeyboard(cfg) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          cfg.paused
            ? { text: '▶️ Start trading', callback_data: 'resume' }
            : { text: '⏸ Stop trading', callback_data: 'pause' },
          { text: '🔄 Refresh', callback_data: 'status' },
        ],
        [
          { text: cfg.enableSolana ? '🟣 Solana: ON' : '🟣 Solana: OFF', callback_data: 'toggle_solana' },
          { text: cfg.enableBsc ? '🟡 BSC: ON' : '🟡 BSC: OFF', callback_data: 'toggle_bsc' },
        ],
        [{ text: '❓ Help', callback_data: 'help' }],
      ],
    },
  };
}

const HELP_TEXT =
  `Commands (buttons above do the same thing — use whichever's easier):\n\n` +
  `/status — full status + control buttons\n` +
  `/starttrading or /resume — resume buying recommended tokens\n` +
  `/stoptrading or /pause — stop entering any new positions (open positions still get monitored/sold normally)\n` +
  `/setmax <n> — max tokens recommended per day\n` +
  `/setrisk low | lowmedium — only LOW risk, or LOW+MEDIUM\n` +
  `/solana on|off, /bsc on|off — toggle a chain's trading\n\n` +
  `Every finding, buy, and sell is pushed here automatically the moment it happens — you don't need to ask.`;

function start() {
  const b = getBot();
  if (!b) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.');
    return;
  }
  console.log('[telegram] bot started (polling mode)');

  async function replyWithStatus(chatId, header) {
    const cfg = getConfig();
    const text = header ? `${header}\n\n${statusText(cfg)}` : statusText(cfg);
    return b.sendMessage(chatId, text, controlKeyboard(cfg));
  }

  b.onText(/^\/start\b/, async (msg) => {
    const intro =
      `Meme coin scanner online.\nYour chat ID: ${msg.chat.id}\n` +
      (TELEGRAM_CHAT_ID ? '' : '⚠️ TELEGRAM_CHAT_ID is not set — set it to this value on Railway so only you can control the bot.\n');
    await b.sendMessage(msg.chat.id, intro);
    if (isAuthorized(msg.chat.id)) await replyWithStatus(msg.chat.id);
  });

  b.onText(/^\/help\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    b.sendMessage(msg.chat.id, HELP_TEXT);
  });

  b.onText(/^\/status\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    replyWithStatus(msg.chat.id);
  });

  b.onText(/^\/(stoptrading|pause)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: true });
      await replyWithStatus(msg.chat.id, '⏹ Trading stopped. No new positions will be entered.');
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/(starttrading|resume)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: false });
      await replyWithStatus(msg.chat.id, '▶️ Trading started.');
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/setmax (\d+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ max_tokens_per_day: Number(match[1]) });
      await replyWithStatus(msg.chat.id, `✅ Daily quota set to ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/setrisk (low|lowmedium)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const tier = match[1].toLowerCase() === 'low' ? 'LOW' : 'LOW_MEDIUM';
    try {
      await updateConfig({ min_recommend_tier: tier });
      await replyWithStatus(msg.chat.id, `✅ Minimum recommend tier set to ${tier}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/solana (on|off)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ enable_solana: match[1].toLowerCase() === 'on' });
      await replyWithStatus(msg.chat.id, `✅ Solana ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  b.onText(/^\/bsc (on|off)/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ enable_bsc: match[1].toLowerCase() === 'on' });
      await replyWithStatus(msg.chat.id, `✅ BSC ${match[1]}.`);
    } catch (err) {
      b.sendMessage(msg.chat.id, `Failed: ${err.message}`);
    }
  });

  // Button taps — same actions as the commands above, no typing required.
  b.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (!isAuthorized(chatId)) {
      return b.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    }

    try {
      if (query.data === 'help') {
        await b.answerCallbackQuery(query.id);
        return b.sendMessage(chatId, HELP_TEXT);
      }

      if (query.data === 'pause') {
        await updateConfig({ paused: true });
        await b.answerCallbackQuery(query.id, { text: '⏹ Trading stopped' });
      } else if (query.data === 'resume') {
        await updateConfig({ paused: false });
        await b.answerCallbackQuery(query.id, { text: '▶️ Trading started' });
      } else if (query.data === 'toggle_solana') {
        await updateConfig({ enable_solana: !getConfig().enableSolana });
        await b.answerCallbackQuery(query.id, { text: 'Solana toggled' });
      } else if (query.data === 'toggle_bsc') {
        await updateConfig({ enable_bsc: !getConfig().enableBsc });
        await b.answerCallbackQuery(query.id, { text: 'BSC toggled' });
      } else if (query.data === 'status') {
        await b.answerCallbackQuery(query.id, { text: 'Refreshed' });
      }

      const cfg = getConfig();
      await b.editMessageText(statusText(cfg), {
        chat_id: chatId,
        message_id: messageId,
        ...controlKeyboard(cfg),
      });
    } catch (err) {
      console.error('[telegram] callback_query failed:', err.message);
      b.answerCallbackQuery(query.id, { text: `Failed: ${err.message}` }).catch(() => {});
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
