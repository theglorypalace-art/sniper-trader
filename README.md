# pump.fun Sniper Bot

Detects new token launches on pump.fun (Solana), buys a small % of wallet
capital, and auto-sells at a take-profit target (with an optional
stop-loss and max-hold-time safety net).

**Every meme-coin risk that applies to this category of trading still
applies here.** This bot does not remove that risk — it just automates
the mechanics. Most new token launches go to zero. Read this whole README
before touching real funds.

## How it works

1. Subscribes to pump.fun's on-chain program logs via Helius's WebSocket RPC
2. On a new token creation, resolves the actual mint address from the transaction
3. Runs a safety check (confirms the token can actually be sold — rejects likely honeypots)
4. Buys `CAPITAL_PCT`% of your wallet's SOL balance (capped at `MAX_POSITION_SOL`)
5. Polls the price every `PRICE_POLL_INTERVAL_MS` and sells when:
   - price is up `TAKE_PROFIT_PCT`% (default 25%), or
   - price is down `STOP_LOSS_PCT`% (default -50%, disable by leaving unset), or
   - the position has been open longer than `MAX_POSITION_AGE_MS` (default 30 min)
6. Every trade attempt — bought, sold, skipped, or failed — is appended to `trades.log`

## Setup

```
npm install
cp .env.example .env
```

1. Sign up at [helius.dev](https://helius.dev), create an API key, put it in `.env` as `HELIUS_API_KEY`
2. Leave `DRY_RUN=true` and run `npm start` — watch the console and `trades.log`. No real transactions are sent in this mode; the bot logs exactly what it *would* have done.
3. Only once you've watched dry-run behavior for a while and trust it:
   - Create a **brand new, dedicated** Solana wallet — never your main wallet
   - Fund it with a small amount you are fully prepared to lose entirely
   - Export its private key in base58 format, put it in `.env` as `WALLET_PRIVATE_KEY`
   - Set `DRY_RUN=false`

## What this does NOT protect you from

- **Rug pulls that happen after purchase** — the safety check confirms the token is sellable *right now*, not that it will remain sellable, or that liquidity won't be pulled the moment after you buy.
- **Losing races to faster bots/infrastructure** — dedicated sniping services run infrastructure this project doesn't attempt to match (colocated nodes, MEV relationships). Expect to lose the best entries to them regularly.
- **Slippage on exit** — `SLIPPAGE_BPS` (default 5%) is a buffer, not a guarantee; thin liquidity can still cause a worse fill than expected, especially in a rush to exit.
- **Wash-traded or fake-looking activity** — this bot buys purely based on "a new token launched," with no attempt to judge community/social legitimacy.

## Known limitations / things to verify before trusting this

- **Log-string detection is brittle.** The detector looks for the literal string `"Instruction: Create"` in pump.fun's program logs. If pump.fun upgrades their program, this string or the whole log format could change silently. Verify this against a real, current pump.fun transaction on a Solana explorer before relying on it.
- **`PUMPFUN_PROGRAM_ID` in `src/config.js`** is pump.fun's known mainnet program ID as of this build — confirm it's still current before going live.
- **Jupiter API version** — this targets Jupiter's v6 quote/swap endpoints. Check [station.jup.ag](https://station.jup.ag/docs) for the current API version before relying on it; aggregator APIs do get versioned/deprecated over time.
- **None of this has been tested against live Solana mainnet from the environment this was built in** (sandboxed, no external network access to Solana/Helius/Jupiter). Syntax and module wiring were verified; live on-chain behavior was not. Test extensively in `DRY_RUN=true` and then with trivial real amounts before trusting it with anything meaningful.

## Extending this

- `MAX_CONCURRENT_POSITIONS` currently limits the bot to one open position at a time — raise carefully, since each position needs its own price-polling loop and capital.
- No holder-concentration, dev-wallet, or social-signal checks exist yet — `src/trading/safety.js` is intentionally minimal and is the place to add more rug-detection heuristics over time.
- No Telegram/UI layer exists — everything runs from `trades.log` and console output. A dashboard or Telegram notifier could be layered on top the same way the Hyperliquid bot has one.
