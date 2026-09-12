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
