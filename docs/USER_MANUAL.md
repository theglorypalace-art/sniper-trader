# Sniper Trader — How to Use the Trading Tools

A short guide for new users. This covers **only** what you do inside the bot (mainly Telegram) to trade and control settings.

---

## Open the control panel

In your bot chat, send:

```text
/menu
```

That screen is your main dashboard. Use the buttons, or type the commands below.

---

## Start or stop trading

| Action | What it does |
|--------|----------------|
| **Start trading** | The bot may open new positions when a coin passes your rules. |
| **Stop trading** | No new buys. Open positions can still be managed / exited by the bot. |

Commands:

```text
/starttrading
/stoptrading
```

---

## Chains (Solana / BSC)

On the menu, toggle:

- **Solana ON / OFF** — listen and trade on Solana launchpads  
- **BSC ON / OFF** — listen and trade on BNB (if enabled for your bot)

Only turn on chains you intend to use.

---

## Platforms (where new coins are detected)

**Menu → Platforms**

Turn each launchpad **ON** or **OFF**:

- pump.fun  
- Raydium LaunchLab / LetsBonk  
- Meteora / Believe  
- Moonshot  
- Boop.fun  

**ON** = the bot watches that platform for new coins.  
**OFF** = it ignores that platform.

Start with the platforms you care about; fewer platforms means a quieter feed.

---

## Capital (size of each buy)

**Menu → Capital %**

| Control | Meaning |
|---------|---------|
| **Solana %** | Each Solana buy uses this percent of your SOL balance. |
| **BSC %** | Same idea for BNB. |
| **Max per trade** | Hard ceiling in SOL or BNB (or “no cap”). |

Examples:

```text
/setcapital 5
```

→ about 5% of balance per Solana trade (still limited by max per trade if set).

---

## Exit rules (when the bot sells)

**Menu → Take profit** (exit section)

| Setting | Meaning |
|---------|---------|
| **Take profit %** | Sell when profit reaches this % (or **Auto** by risk tier). |
| **Stop loss %** | Sell when loss reaches this % (or **Auto**). |
| **Max hold (minutes)** | Sell after this time if TP/SL did not fire (or **Auto**). |

Examples:

```text
/settp 20
/setsl 15
/setmaxhold 10
```

`0` or **Auto** = the bot chooses defaults from the coin’s risk tier.

These apply to new trades and are re-read while a position is open.

---

## Risk tier

**Menu → Risk tier**

| Choice | Effect |
|--------|--------|
| **LOW only** | Stricter — fewer coins, safer-looking only. |
| **LOW + MEDIUM** | More coins allowed through. |

Pick **LOW only** if you want fewer, tighter entries; **LOW + MEDIUM** for more activity.

---

## Filters (who gets in)

**Menu → Filters**

| Filter | Meaning |
|--------|---------|
| **Max dev %** | Skip if creator/dev holds more than this % of supply. High number (e.g. 99) ≈ almost off. |
| **Max top-10 %** | Skip if top 10 holders control more than this %. |
| **Max risk score** | Only enter if the bot’s score is at or below this. Lower = pickier. |

Related:

```text
/setscore 40
/setdev 30
/settop10 70
```

**MEDIUM filters** (submenu) apply only when tier allows MEDIUM — slightly looser ceilings for those coins.

---

## Safety toggles (optional gates)

**Menu → Safety toggles**

| Toggle / limit | Meaning |
|----------------|---------|
| **Block mint authority** | ON = reject coins that can still mint new supply. |
| **Block creator rugs** | ON = reject when data flags a bad creator history. |
| **Min market cap** | Only enter if market cap is at least this USD amount. **0 = off**. |
| **Max single holder %** | Reject if one wallet holds more than this %. **0 = off**. |
| **Max high ownership %** | Reject if concentrated ownership is above this %. **0 = off**. |

Examples:

```text
/setminmcap 10000
/setminmcap 0
/setsingle 25
/sethighown 0
```

---

## Daily limit

**Menu → Daily limit**

Maximum number of recommended / entered tokens per UTC day.

```text
/setmax 5
```

When the limit is hit, the bot waits until the next UTC day (or you raise the limit).

---

## Scanner

**Menu → Scanner** or:

```text
/scanner
```

Shows whether the feed is connected, how many new coins were seen, checked, passed, and bought. Use this to confirm the bot is listening.

---

## Positions

**Menu → Positions** or:

```text
/positions
```

Lists open trades and live profit/loss when available.

---

## Wallet / balance

**Menu → Wallet** or:

```text
/balance
```

Shows balance and the bot wallet address for the active chain(s).

---

## Analyze a coin (manual check)

Paste a **contract address** in the chat, or:

```text
/analyze <contract address>
```

You get a short report: risk-style verdict, market snapshot when available, and whether it fits **your current** filters — plus a suggested exit style. Useful before you change filters or to inspect a CA someone shared.

---

## Status

```text
/status
```

or **Refresh** on the menu — one screen: trading on/off, chains, capital, limits, scanner headline, open positions count.

---

## Simple flow for a new user

1. Open `/menu`.  
2. **Start trading**.  
3. Set **Capital %** (e.g. 5%) and a **max per trade** if you want a ceiling.  
4. Set **Take profit / Stop loss / Max hold** (or leave Auto).  
5. Choose **Risk tier** (LOW only or LOW + MEDIUM).  
6. Adjust **Filters** and **Safety** only if you want stricter or looser entries.  
7. Turn on the **Platforms** you want.  
8. Check **Scanner** that the feed is live.  
9. Use **Positions** and Telegram alerts to follow open trades.  
10. **Stop trading** anytime to pause new buys.

---

## Command cheat sheet

| Command | Use |
|---------|-----|
| `/menu` | Full control panel |
| `/status` | Status summary |
| `/scanner` | Feed & funnel |
| `/positions` | Open trades |
| `/balance` | Wallet |
| `/analyze <CA>` | Inspect a contract |
| `/setcapital <n>` | Solana capital % |
| `/settp <n>` | Take profit % |
| `/setsl <n>` | Stop loss % |
| `/setmaxhold <n>` | Max hold minutes |
| `/setminmcap <n>` | Min market cap USD (`0` = off) |
| `/setscore <n>` | Max risk score |
| `/setmax <n>` | Daily limit |
| `/starttrading` | Allow new buys |
| `/stoptrading` | Pause new buys |
| `/help` | List commands |

---

*Use the tools above to match how aggressive or selective you want the bot to be. All of these can be changed anytime from Telegram.*
