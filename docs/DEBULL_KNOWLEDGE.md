# DE-BULL Academy — Bot Knowledge Base

Source: 1-Week Crypto Trading Masterclass Notes (21–25 Sep 2026).  
Used as strategy/risk guidance for sniper-trader. Not financial advice.

## Core formula

**Success = Strategy + Risk Management + Psychology + Discipline**

- Discipline is CORE. Protect capital first.
- Only ~5% of traders make consistent money — process over emotion.
- Trading is ~10% skill, ~90% emotion & psychology.
- **A miss is better than a loss.** Never replace Support / Stop-Loss with HOPE.

## Capital rules (must follow)

| Rule | Value |
|------|--------|
| Max risk per trade | **10% of trading capital** (never business/savings money) |
| Do not overtrade | Clear rules before every entry |
| FOMO | Forbidden — first pump is often a trap |

## Exit framework (DE-BULL advanced)

| Level | Action |
|-------|--------|
| Target range | **+100% to +200%** |
| Stop | **−45%** full exit |
| Partial style (manual) | TP +100% → sell ~90%; moonbag toward +1000%; SL −45% → 100% |

For the automated bot (single full exit per position), defaults map to a practical slice of this:

- Prefer taking profit when available rather than only max-hold flat exits.
- Avoid ultra-tight SL (e.g. −10%) on meme launches — noise will stop you out.
- Avoid 5-minute max hold with +35% TP — most LOWs will expire flat (seen in live trades).

## Market structure

Three pillars of a coin:

1. **Liquidity Pool** — real money sits here  
2. **Volume** — money in and out  
3. **Market Cap**

Healthy relationship: **Market Cap ≫ Volume ≫ Liquidity**.  
Weak LP + strong-looking chart = still risky.

### Lifecycle (Solana memes)

`New` → `Final Stretch` → `Migrated` (added to real LP / Raydium-style pool)

Launchpads:

- Solana: Pump.fun, Bonk.fun, Surge, Stonk.fun, …
- BNB: Fun.meme

Tip: at ~100k MC, 1% move ≈ $1k.

## Coin types

| Type | Behavior |
|------|----------|
| Narrative | Image/meme pairs (Pepe, Wojak…) — can last longer |
| Community | Dies when community/reason dies |
| Utility | Pays for services |
| Trends | Fastest up, fastest die; can recycle |
| News/Event | Often dies after the event |

Rules:

- If it is **not trending**, do not buy.
- Rumor often moves money more than news — still do not hold rumor coins all the way to event day.
- **First pump is usually the first trap.** Prefer second wave / clearer structure when possible.

## Chart / entry quality

- Bigger timeframe → bigger picture.
- Almost every good coin has a **double bottom** — safer after confirmation.
- Support → resistance moves often ~100% after double support.
- Resistance becomes support as levels break; third resistance is often a trap — protect capital under breakout stress.
- Long-term rule: wait for basket/bottom shape; target max **100–200%**.

## Timing (class context)

- Afternoon often weak.
- Stronger window often **02:00–04:00** (local class context).
- Weekends can be better for crypto activity.
- Devs create supports; waiting for quality flow beats spraying every launch.

## On-chain / tools mentioned in class

- Axiom.trade (execution / tracking)
- DexScreener (top traders → copy wallets → track on Axiom)
- Solscan.io / Metasleuth.com
- Pump.fun create/buy flow (bonding curve; most coins never graduate)

## How the bot applies this

See `src/knowledge/debull.js`:

- Default **capital % = 10**
- Exit plans biased toward **discipline over FOMO** (wider SL, realistic TP/hold)
- Prefer not treating every brand-new curve token as equal to final-stretch/migrated
- Knowledge is documented so Telegram/dashboard operators can tune without guessing

