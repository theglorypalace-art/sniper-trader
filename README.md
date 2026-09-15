# Meme Coin Scanner (Solana + BNB Smart Chain)

Watches for new meme coin launches on **Solana (pump.fun)** and **BNB Smart
Chain (PancakeSwap)**, runs every one through a risk engine (dev/creator
holding %, holder concentration, honeypot/tax checks, LP lock status,
pump.fun migration/curve status), and only recommends the small, very
selective subset that passes — **at most `MAX_TOKENS_PER_DAY` per day**
(default 5, across both chains combined).

**Every meme-coin risk that applies to this category of trading still
applies here.** The risk engine filters out the *obvious, checkable*
red flags — it does not, and cannot, guarantee a "LOW risk" token won't
still go to zero. Liquidity can be pulled after purchase, wallets that
looked distributed can turn out to be linked, and no automated check
replaces your own judgment. Read this whole README before touching real
funds.

## A note on "Axiom.trade compatible"

Axiom.Trade has no official public developer API. The unofficial
third-party SDKs that exist log into your real Axiom account and use
browser automation to get past Cloudflare's bot protection — that's a
real account-security and ToS risk, not something this project wires up.

Instead, this scanner is a **standalone analyzer + (optional) auto-trader**
that works independently of Axiom. When a token is recommended, its
contract address and full findings are printed/logged immediately — you
can paste that CA into Axiom (or any other terminal) yourself, or let the
bot execute the trade directly (see "Execution speed" below).

## How it works

1. **Detection**
   - Solana: subscribes to pump.fun's on-chain program logs via Helius's WebSocket RPC.
   - BSC: subscribes to PancakeSwap V2's `PairCreated` events, filtered to WBNB-paired pools.
2. **Risk assessment** (`src/analysis/riskEngine.js`) — for every single token seen, not just the ones that pass:
   - Can it actually be sold right now? (Solana: live Jupiter quote. BSC: GoPlus honeypot flag + buy/sell tax.)
   - Dev/creator wallet holding % and top-10 holder concentration.
   - Mint/freeze authority still active? Ownership hidden or reclaimable?
   - LP burned/locked %.
   - Solana only: bonding curve progress and migration status, read directly on-chain (not from an unofficial API) — tags a token `new`, `developing`, `final_stretch` (close to migrating to Raydium), or `migrated`.
   - Broadly-distributed holdings with no dominant dev wallet get flagged as a **community coin**.
3. **Scoring** — each token gets a 0-100 risk score → **LOW / MEDIUM / HIGH / CRITICAL**. Only LOW/MEDIUM are ever tradeable; anything else is rejected outright regardless of the daily quota.
4. **Daily selectivity gate** (`src/analysis/dailyLimiter.js`) — even a LOW-risk token only gets recommended if today's `MAX_TOKENS_PER_DAY` quota isn't already used. Resets at UTC midnight.
5. **Instant feedback** — every token evaluated gets an immediate console log + `trades.log` entry: contract address, chain, category, risk verdict, every reason behind the score, and (if recommended) the suggested take-profit / stop-loss / max-hold-time.
6. **Execution** (if `DRY_RUN=false`) — buys `CAPITAL_PCT`% (or `BSC_CAPITAL_PCT`%) of that chain's wallet balance, capped at `MAX_POSITION_SOL` / `BSC_MAX_POSITION_BNB`, and polls price to auto-sell at the risk-tier's take-profit/stop-loss/max-hold.

### Execution speed vs. manual alerts

This intentionally does **not** route recommendations through Telegram or
any other manual-approval step before trading. Any human-in-the-loop relay
is exactly where slippage creeps in on fast-moving launches — by the time
you read an alert and tap buy, the entry is gone. If `DRY_RUN=false`, the
bot buys the moment a token is recommended and sells the moment its exit
condition is hit. The full findings are still logged instantly for your
own visibility — they just don't gate execution.

### Suggested "very safe" exit plan by risk tier

| Tier | Take-profit | Stop-loss | Max hold |
|---|---|---|---|
| LOW | +20% | -25% | 20 min |
| MEDIUM | +15% | -30% | 12 min |

These are conservative on purpose — a small, reliably-taken profit and a
fast, forced exit if it isn't working, rather than swinging for a bigger
number. Tune them in `src/analysis/riskEngine.js` (`exitPlanFor`) once you
have real DRY_RUN data to work from.

## Setup

```
npm install
cp .env.example .env
```

1. **Solana**: sign up at [helius.dev](https://helius.dev), create an API key, put it in `.env` as `HELIUS_API_KEY`.
2. **BSC** (optional): set `ENABLE_BSC=true`. The default public RPC (`bsc-rpc.publicnode.com`) works for testing; get a dedicated key before trading real funds.
3. Leave `DRY_RUN=true` and run `npm start` — watch the console and `trades.log`. No real transactions are sent in this mode; every buy/sell is simulated and logged exactly as it would have happened.
4. Only once you've watched dry-run behavior for a while and trust it:
   - Create **brand new, dedicated** wallets — never your main wallet — one per chain you enable.
   - Fund each with a small amount you are fully prepared to lose entirely.
   - Solana: export the private key in base58 format → `WALLET_PRIVATE_KEY`.
   - BSC: export the private key in hex (`0x...`) format → `BSC_WALLET_PRIVATE_KEY`.
   - Set `DRY_RUN=false`.

## What this does NOT protect you from

- **Rug pulls that happen after purchase** — every check here confirms the token looks sellable and reasonably distributed *right now*, not that it will stay that way.
- **Losing races to faster bots/infrastructure** — dedicated sniping services run infrastructure this project doesn't attempt to match (colocated nodes, MEV relationships, private mempools).
- **Slippage on exit** — `SLIPPAGE_BPS`/`BSC_SLIPPAGE_BPS` are buffers, not guarantees; thin liquidity can still produce a worse fill than expected.
- **GoPlus/on-chain data being wrong, stale, or unavailable** — the risk engine scores conservatively when a lookup fails, but "conservative" isn't the same as "safe."
- **Wash-traded or fake-looking community activity** — "community coin" here means holdings look distributed, not that the community itself is genuine.

## Known limitations / things to verify before trusting this

- **pump.fun log-string detection is brittle.** The Solana detector looks for the literal string `"Instruction: Create"` in pump.fun's program logs — verify against a real, current transaction before relying on it.
- **`PUMPFUN_PROGRAM_ID`** and the bonding-curve account layout (`src/analysis/pumpfunCurve.js`) are current as of this build, sourced from pump-fun's own public docs repo — pump.fun has changed this account's fields before (e.g. adding a `creator` field) and could again.
- **Jupiter v6 and PancakeSwap V2 APIs** — check their current docs before relying on either long-term.
- **GoPlus Solana endpoint is explicitly labeled "beta"** by GoPlus themselves — expect rougher coverage than the mature EVM endpoint.
- **BSC detection only catches WBNB-paired pools.** Pairs quoted against BUSD/USDT etc. are skipped — widen `src/bsc/detector.js` if you want those too.
- **None of this has been tested against live mainnet from the environment this was built in** (sandboxed, no external network access to Solana/BSC/Helius/GoPlus/Jupiter/PancakeSwap). Syntax and module wiring were verified; live on-chain behavior was not. Test extensively in `DRY_RUN=true`, then with trivial real amounts, before trusting it with anything meaningful.

## Extending this

- `MAX_CONCURRENT_POSITIONS` / `BSC_MAX_CONCURRENT_POSITIONS` currently limit each chain to one open position at a time — raise carefully, since each position needs its own price-polling loop and capital.
- The risk engine's scoring weights and hard-reject thresholds live in `src/analysis/riskEngine.js` — tune them as you gather real data on what actually correlates with rugs vs. genuine plays.
- `daily-limit-state.json` (git-ignored) tracks today's used quota — delete it to reset manually, or just wait for UTC midnight.
- No Telegram/dashboard notifier exists yet — everything runs from `trades.log` and console output, by design (see "Execution speed" above). A read-only notifier that mirrors the console output elsewhere (without gating execution) would be a safe addition.

---

## Going 24/7: Railway + Supabase + Telegram + Dashboard

This section covers turning the engine into an always-on bot with live,
no-redeploy filter control and a Telegram bot / web dashboard on top.

### Architecture

```
┌─────────────────────────┐        ┌──────────────────┐
│  Engine (Railway)        │◄──────►│                  │
│  - detectors             │  reads  │    Supabase       │
│  - risk engine           │  writes │  bot_config       │
│  - position managers     │        │  assessments      │
│  - Telegram bot (polling)│        │  positions        │
└─────────────────────────┘        └────────▲─────────┘
                                             │ reads/writes
                                    ┌────────┴─────────┐
                                    │ Dashboard (Vercel) │
                                    │  /dashboard folder │
                                    └───────────────────┘
```

The engine is the only thing that ever executes trades. Telegram and the
dashboard are both just control surfaces that read/write the same
Supabase tables — neither can trade directly, and either can be skipped
entirely if you only want one.

### 1. Supabase (shared live-config + data layer)

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run everything in `supabase/schema.sql`.
3. Database → Replication → turn on Realtime for `bot_config` (lets filter
   changes apply within seconds instead of waiting for the 15s poll).
4. Project Settings → API → copy the **Project URL** and the
   **service_role key** (not the anon key — the engine and dashboard's
   API routes both run server-side and need the elevated key; the anon
   key is never used anywhere in this project).

### 2. Engine on Railway

1. Push this repo to GitHub (already done if you're reading this from there).
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → select `sniper-trader`.
3. Add environment variables (Railway → Variables): everything from `.env.example`, including `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` and (once you've made the bot below) `TELEGRAM_BOT_TOKEN`.
4. Deploy. `railway.json` is already set to restart automatically on crash — this is what makes it "standby 24/7" instead of dying the moment something throws.
5. Watch the deploy logs for `[boot] ✅ listening for new pump.fun launches` — that confirms it's live.

### 3. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow the prompts → copy the token it gives you into `TELEGRAM_BOT_TOKEN` on Railway.
2. Message your new bot `/start`. It replies with your chat ID.
3. Set `TELEGRAM_CHAT_ID` to that value on Railway and redeploy — this locks control to just you (without it, anyone who finds your bot could pause it or change your filters).
4. From then on: `/status`, `/pause`, `/resume`, `/setmax <n>`, `/setrisk low|lowmedium`, `/solana on|off`, `/bsc on|off` — plus automatic push notifications the moment a token is recommended, bought, or sold.

### 4. Dashboard on Vercel (optional)

The dashboard lives in `dashboard/` inside this same repo.

1. [vercel.com](https://vercel.com) → New Project → import this repo → **set Root Directory to `dashboard`** (this is the one Vercel-specific setting that matters — without it, Vercel tries to build the whole repo as one Next.js app).
2. Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and a `DASHBOARD_PASSWORD` you choose yourself (treat it like a real credential — it gates pause/resume and your position-sizing controls).
3. Deploy. Visit the URL, enter the password, and you'll see live positions, recent findings, and an editable filter panel.

**Note on the two "enable Solana/BSC" switches:** the `ENABLE_SOLANA` /
`ENABLE_BSC` variables on Railway control whether that chain's *listener*
starts at all — changing those needs a redeploy. Once a listener is
running, the live `enable_solana` / `enable_bsc` values in Supabase (via
Telegram's `/solana`, `/bsc` or the dashboard) control whether it's
actually *allowed to buy anything* — that part is instant, no redeploy.
Practically: turn a chain on in Railway once, then use Telegram/the
dashboard to flip it on/off day-to-day.

### What's genuinely live vs. what needs a redeploy

| Adjustable live (Telegram/dashboard, ~instant) | Needs a Railway redeploy |
|---|---|
| Pause/resume all trading | Which chains' listeners start at all (`ENABLE_SOLANA`/`ENABLE_BSC`) |
| Min risk tier to recommend (LOW / LOW+MEDIUM) | `DRY_RUN` on/off |
| Max tokens/day | Wallet private keys |
| Max dev % / top-10 % thresholds | RPC endpoints, program/contract addresses |
| Position size (% and hard cap, per chain) | Exit plan values (TP/SL/max-hold per tier — still in code) |
