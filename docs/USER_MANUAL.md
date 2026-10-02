# Sniper Trader — Beginner User Manual

A simple guide to set up the bot and control it for your own trading.  
You do **not** need to read the code. Everything important is done with environment variables and Telegram.

---

## 1. What this bot does (in plain words)

1. Watches new meme-coin launches on Solana (and optionally BNB).
2. Checks each coin against **your** rules (risk, market cap, holders, etc.).
3. Can buy a small slice of your wallet balance when a coin passes.
4. Can sell on take-profit, stop-loss, or a max hold time.
5. You control all of that live from **Telegram** — no redeploy for normal settings.

**Default safety:** the bot starts in **DRY RUN** (paper mode). It only uses real money when you explicitly turn that off.

---

## 2. What you need before starting

| Item | Why |
|------|-----|
| A **dedicated** trading wallet | Never use your main wallet. Create a new one and fund it with a small amount only. |
| [Helius](https://helius.dev) API key | Solana data feed (free tier is enough to start). |
| Telegram account + a bot from [@BotFather](https://t.me/BotFather) | Live control panel. |
| Hosting (e.g. Railway) or a computer that stays online | The bot must run 24/7 to catch launches. |
| Optional: [Supabase](https://supabase.com) free project | Saves your Telegram settings across restarts. |

---

## 3. First-time setup (checklist)

### Step A — Create a bot wallet
1. Create a **new** Solana wallet (Phantom, Solflare, or CLI).
2. Export the **private key** (base58). Keep it secret.
3. Send only what you can afford to lose (example: 0.05–0.5 SOL to start).

### Step B — Telegram bot
1. Open Telegram → talk to **@BotFather** → `/newbot` → follow prompts.
2. Copy the **bot token**.
3. Start a chat with your new bot and send `/start`.
4. Note the **chat ID** the bot shows you (or that your host logs). Put that in settings so only you can control the bot.

### Step C — Environment variables
Copy `.env.example` to `.env` (or fill the same keys on Railway). Minimum to run Solana in dry-run:

```text
DRY_RUN=true
ENABLE_SOLANA=true
ENABLE_BSC=false
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_numeric_chat_id
```

When you are ready for **real** trades (only after testing):

```text
DRY_RUN=false
WALLET_PRIVATE_KEY=your_base58_private_key
```

Optional but recommended (settings survive restarts):

```text
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
```

Then in Supabase → SQL Editor, run the full `supabase/schema.sql` once (or the migrations if the project already exists). See `supabase/README.md`.

### Step D — Start the service
Deploy or run the app so it stays online. You should get a Telegram message that the scanner started, and `/menu` should work.

---

## 4. Your control panel: Telegram

Send:

```text
/menu
```

Main buttons:

| Button | Purpose |
|--------|---------|
| **Start / Stop trading** | Pause new buys without shutting the bot down. |
| **Solana / BSC ON·OFF** | Which chains are active. |
| **Positions** | Open trades and live P&amp;L. |
| **Scanner** | Is the feed alive? How many coins seen/passed. |
| **Wallet** | Balance and address. |
| **Capital %** | How much of the balance each buy may use (+ max size cap). |
| **Take profit** | Exit targets (or “auto” by risk tier). |
| **Risk tier** | Stricter (LOW only) or more open (LOW + MEDIUM). |
| **Filters** | Dev %, top-10 holders, risk score. |
| **Daily limit** | Max trades/recommendations per day. |
| **Platforms** | Which launchpads to listen to. |
| **Safety toggles** | Market cap floor, holder limits, mint/rug blocks. |

### Useful commands

```text
/status          — same as menu status
/positions       — open positions
/balance         — wallet
/scanner         — feed health
/analyze <CA>    — paste a contract address for a risk snapshot
/settp 20        — take profit 20%
/setsl 15        — stop loss 15%
/setmaxhold 10   — max hold 10 minutes
/setminmcap 10000 — min market cap $10,000 (0 = off)
/setcapital 5    — 5% of balance per trade
/starttrading    — resume
/stoptrading     — pause
/help            — command list
```

You can also **paste only a contract address** in the chat to run `/analyze`.

---

## 5. Suggested first settings (new users)

Start **defensive**. Loosen later if you accept more risk.

| Setting | Suggested start | Notes |
|---------|-----------------|--------|
| DRY_RUN | **true** | Watch behavior before real money. |
| Capital % | **2–5%** | Small size per trade. |
| Max per trade (SOL) | **0.05–0.2** | Hard ceiling. |
| Daily limit | **3–10** | Avoid overtrading. |
| Min market cap | **10000** or **0** | `0` = no MC gate; `$10k+` filters very early junk. |
| Max risk score | **30–50** | Lower = pickier. |
| Risk tier | **LOW only** first | Then try LOW + MEDIUM. |
| Take profit | **15–30%** or auto | |
| Stop loss | **10–25%** or auto | |
| Max hold | **5–15 min** or auto | Fast exits on memes. |
| Platforms | All ON, or only **pump.fun** at first | Fewer pads = quieter feed. |

Safety toggles (mint authority / creator rug / single holder) default **off** so nothing is silently blocking you. Turn them **on** in **Safety** if you want stricter protection.

---

## 6. How a typical trade cycle works

1. A new coin appears on a platform you enabled.
2. The bot scores it and applies **your** filters.
3. If it fails → skipped (you may see less spam; check `/scanner`).
4. If it passes and trading is **not** paused → buy using capital % (and max size).
5. Position is monitored → sell on TP, SL, or max hold.
6. Telegram notifies buy / sell when configured.

If buys fail often (slippage, empty balance, RPC), check **Wallet**, SOL for fees, and that `DRY_RUN=false` only when you intend live trading.

---

## 7. Dry run vs live

| Mode | `DRY_RUN` | Real funds |
|------|-----------|------------|
| Practice | `true` | No |
| Live | `false` | Yes |

Always test in dry run until `/scanner` looks healthy and you understand the alerts.

---

## 8. Common questions

**“Nothing is trading.”**  
- Trading paused? → Start trading.  
- Still `DRY_RUN=true`? (That is OK for testing; no real fills.)  
- Filters too tight? Raise score limit, set min MC to 0, check Platforms.  
- Feed down? → `/scanner`.  
- Daily limit reached? → raise daily limit or wait until UTC midnight.

**“I want looser / tighter rules.”**  
Everything is on Telegram: Filters, Safety, Platforms, Exit, Capital. No code change required.

**“Can two people use one bot?”**  
One `TELEGRAM_CHAT_ID` = one controller. For multiple users you need separate deployments and wallets.

**“What about BSC?”**  
Set `ENABLE_BSC=true`, add BSC RPC + dedicated BSC key, fund BNB for gas. Most beginners start Solana-only.

---

## 9. Safety habits

- Dedicated wallet only; small balance.
- Start dry-run; size up slowly.
- Memecoins can go to zero — only risk money you can lose.
- Never share private keys, bot token, or Supabase **service** key.
- Keep `TELEGRAM_CHAT_ID` set so strangers cannot control the bot.

---

## 10. Quick start (one page)

1. New wallet → small SOL deposit.  
2. Helius key + Telegram bot token + chat ID.  
3. Env: `DRY_RUN=true`, `HELIUS_API_KEY`, `TELEGRAM_*`.  
4. Deploy / run → `/menu`.  
5. Set capital 5%, daily limit 5, tier LOW only.  
6. Watch `/scanner` and alerts for a day.  
7. When ready: `DRY_RUN=false` + `WALLET_PRIVATE_KEY`, tiny size first.

---

*This manual is for operators of their own instance. It is not financial advice. Markets are volatile; past behavior of the bot does not guarantee future results.*
