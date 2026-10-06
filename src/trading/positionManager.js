const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PRICE_POLL_INTERVAL_MS, MAX_CONCURRENT_POSITIONS, SOL_MINT, DRY_RUN, SOL_FEE_RESERVE, ENABLE_GRADUATION_WATCH } = require('../config');
const { computeTradeSize } = require('./sizing');
const { resolveExit, evaluateExit } = require('./exitRules');
const { entryMessage, exitMessage } = require('./present');
const runtime = require('../live/runtime');
const { assessAndGate } = require('../analysis/riskEngine');
const graduationWatcher = require('../pumpfun/graduationWatcher');
const { getQuote, buySol, sellToSol } = require('./jupiter');
const { buyOnPump, sellOnPump } = require('./pumpPortal');
const { getSolBalance, loadWallet } = require('../solana/wallet');
const { logTrade } = require('../db/tradeLog');
const { getConfig } = require('../live/liveConfig');
const { getTokenMarket } = require('../analysis/dexscreener');
const stateSync = require('../live/stateSync');
const telegram = require('../telegram/bot');

const openPositions = new Map(); // mint -> position state
let lastEntryAttemptAt = 0;
const ENTRY_COOLDOWN_MS = Number(process.env.ENTRY_COOLDOWN_MS || 3000); // only after a real buy attempt

function printFindings(mint, assessment) {
  console.log(`\n[findings] ${mint} (solana)`);
  console.log(`  verdict: ${assessment.verdict}${assessment.recommended ? ' — RECOMMENDED' : ''}`);
  if (assessment.category) {
    console.log(`  category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}`);
  }
  if (assessment.devPercent != null) console.log(`  dev/creator holding: ~${assessment.devPercent.toFixed(1)}%`);
  if (assessment.top10Percent != null) console.log(`  top10 holders: ~${assessment.top10Percent.toFixed(1)}%`);
  if (assessment.curveProgressPct != null) {
    console.log(`  bonding curve: ~${assessment.curveProgressPct.toFixed(0)}%${assessment.migrated ? ' (migrated to Raydium)' : ''}`);
  }
  assessment.reasons.forEach((r) => console.log(`  - ${r}`));
  if (assessment.exit) {
    console.log(
      `  suggested exit: TP +${assessment.exit.takeProfitPct}% / SL ${assessment.exit.stopLossPct}% / max hold ${(
        assessment.exit.maxHoldMs / 60000
      ).toFixed(0)}min`
    );
  }
  console.log('');
}

function findingsMessage(mint, assessment) {
  const lines = [
    `🔎 Solana — ${assessment.recommended ? '✅ RECOMMENDED' : assessment.verdict}`,
    `CA: ${mint}`,
    assessment.category ? `Category: ${assessment.category}${assessment.isCommunityCoin ? ' (community coin)' : ''}` : null,
    assessment.devPercent != null ? `Dev holding: ~${assessment.devPercent.toFixed(1)}%` : null,
    assessment.top10Percent != null ? `Top10: ~${assessment.top10Percent.toFixed(1)}%` : null,
    ...assessment.reasons.map((r) => `• ${r}`),
  ].filter(Boolean);
  return lines.join('\n');
}

const SELL_ATTEMPTS = Number(process.env.SELL_ATTEMPTS || 6);
const SELL_RETRY_BASE_MS = Number(process.env.SELL_RETRY_BASE_MS || 1200);
const SELL_SLIP_LADDER = String(process.env.SELL_SLIP_LADDER || '25,35,45,55,65,75')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let entering = 0; // entries in flight (assessing/buying) — counted against the position limit

// Read-only view of open positions for Telegram's 📈 Positions screen.
runtime.registerPositions('solana', () =>
  [...openPositions.values()].map((p) => ({
    chain: 'solana',
    unit: 'SOL',
    address: p.mint,
    size: p.sizeSol,
    valueNative: p.lastValueNative,
    pnlPct: p.lastPnlPct,
    openedAt: p.openedAt,
    lastPolledAt: p.lastPolledAt,
    dryRun: p.dryRun,
    exit: p.exit,
    verdict: p.verdict,
    score: p.score,
    exiting: p.exiting,
    sellFailures: p.sellFailures,
  }))
);

async function tryEnterPosition(mint) {
  // Serial mode: finish the open trade (buy→monitor→sell) before evaluating the next.
  if (openPositions.size > 0) {
    // Quiet skip — expected while a position is open (do not inflate scanner spam).
    return;
  }
  if (entering > 0) {
    // Already assessing/buying one candidate — ignore the rest until done.
    return;
  }
  if (openPositions.has(mint)) return;

  const since = Date.now() - lastEntryAttemptAt;
  if (lastEntryAttemptAt && since < ENTRY_COOLDOWN_MS) {
    return; // short quiet gap after last buy attempt only
  }

  entering += 1;
  try {
    await enterPosition(mint);
  } finally {
    entering -= 1;
  }
}

async function enterPosition(mint) {
  const pre = getConfig();
  let assessment;
  try {
    // While paused / Solana is off the token is still assessed and reported,
    // but must not consume one of today's slots. requireSellable:false lets
    // a pre-migration token that passes everything else go to the
    // graduation watcher instead of being discarded outright.
    assessment = await assessAndGate({
      chain: 'solana',
      address: mint,
      consumeSlot: !pre.paused && pre.enableSolana,
      requireSellable: !ENABLE_GRADUATION_WATCH,
    });
  } catch (err) {
    console.error(`[position] risk assessment failed for ${mint}, skipping (fail-closed):`, err.message);
    logTrade({ mint, chain: 'solana', event: 'skipped', reason: `risk assessment error: ${err.message}` });
    runtime.recordSkip('solana', 'risk assessment error');
    return;
  }

  printFindings(mint, assessment);
  logTrade({ mint, chain: 'solana', event: 'assessed', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'solana', address: mint });
  runtime.recordAssessed('solana', mint, assessment);

  const liveCfg = getConfig();
  if (liveCfg.paused || !liveCfg.enableSolana) {
    if (assessment.pendingGraduation) graduationWatcher.watch(mint, assessment);
    return;
  }

  // Hard unsafe (freeze, ownership gates, etc.) — never buy.
  if (assessment.verdict === 'UNSAFE' && !assessment.pendingGraduation) {
    return;
  }

  // Score ceiling from Telegram (maxRiskScore).
  const maxScore = liveCfg.maxRiskScore ?? 100;
  if (Number(assessment.score) > maxScore) {
    console.log(`[position] ${mint} score ${assessment.score} > max ${maxScore} — skip`);
    return;
  }

  // Promote curve / passed tokens to a real buy (one serial slot).
  const onCurve = Boolean(assessment.pendingGraduation) || assessment.migrated === false;
  if (!assessment.recommended) {
    const { tryConsumeDailySlot } = require('../analysis/dailyLimiter');
    const gotSlot = tryConsumeDailySlot(liveCfg.maxTokensPerDay);
    if (!gotSlot) {
      console.log(`[position] ${mint} daily quota full — not buying`);
      runtime.recordSkip('solana', 'daily quota full');
      if (onCurve) graduationWatcher.watch(mint, assessment);
      return;
    }
    assessment.recommended = true;
    assessment.reasons = [
      ...(assessment.reasons || []),
      onCurve
        ? 'Serial entry: buying on pump bonding curve (no Jupiter route yet).'
        : 'Serial entry: passed score/safety gates — taking the trade.',
    ];
  }

  lastEntryAttemptAt = Date.now(); // cooldown starts only when we actually try to buy
  await buyAndTrack(mint, assessment, liveCfg, {
    preferPump: onCurve || assessment.category === 'new' || assessment.migrated === false,
  });
}

// Called by the graduation watcher the instant a watched token's bonding
// curve completes. Re-runs the FULL assessment (requireSellable:true) rather
// than trusting the cached, possibly-minutes-old one — holder distribution
// and taxes can change while a token is on the curve, and this is the exact
// moment the bot commits real money, so it's worth the extra round trip.
async function enterFromGraduation(mint) {
  const pre = getConfig();
  let assessment;
  try {
    assessment = await assessAndGate({
      chain: 'solana',
      address: mint,
      consumeSlot: !pre.paused && pre.enableSolana,
      requireSellable: true,
    });
  } catch (err) {
    console.error(`[position] graduation re-assessment failed for ${mint}, skipping (fail-closed):`, err.message);
    logTrade({ mint, chain: 'solana', event: 'skipped', reason: `graduation risk assessment error: ${err.message}` });
    runtime.recordSkip('solana', 'risk assessment error');
    return;
  }

  printFindings(mint, assessment);
  logTrade({ mint, chain: 'solana', event: 'assessed_at_graduation', ...assessment });
  stateSync.recordAssessment({ ...assessment, chain: 'solana', address: mint });
  runtime.recordAssessed('solana', mint, assessment);

  if (assessment.recommended) {
    telegram.notify(`🎓 Just graduated — ${findingsMessage(mint, assessment)}`);
  }
  if (!assessment.recommended) {
    console.log(`[position] ${mint} graduated but no longer passes (or quota/pause) — not buying.`);
    return;
  }

  const liveCfg = getConfig();
  if (liveCfg.paused || !liveCfg.enableSolana) {
    console.log(`[position] ${mint} graduated and was recommended, but trading is paused/off — skipping entry.`);
    runtime.recordSkip('solana', 'trading paused / chain off');
    return;
  }
  if (openPositions.size + entering >= MAX_CONCURRENT_POSITIONS) {
    runtime.recordSkip('solana', 'already holding/evaluating a position (max concurrent reached)');
    console.log(`[position] ${mint} graduated but a position slot isn't free — skipping entry.`);
    return;
  }

  runtime.recordGraduationBuy('solana');
  entering += 1;
  try {
    await buyAndTrack(mint, assessment, liveCfg);
  } finally {
    entering -= 1;
  }
}

// Sizes, buys, tracks and starts monitoring a position for an assessment
// that has ALREADY been fully gated (tradeable + recommended). Shared by the
// normal entry path and the graduation-triggered one.
async function buyAndTrack(mint, assessment, liveCfg, { preferPump = false } = {}) {
  const wallet = loadWallet();
  const solBalance = await getSolBalance();
  const { size: sizeSol, limitedBy } = computeTradeSize({
    balance: solBalance,
    pct: liveCfg.capitalPct,
    cap: liveCfg.maxPositionSol,
    reserve: SOL_FEE_RESERVE,
  });

  if (sizeSol <= 0) {
    console.log(`[position] skipping ${mint} — computed size non-positive (balance=${solBalance}, ${limitedBy})`);
    runtime.recordSkip('solana', 'wallet balance too low to size a trade');
    return;
  }
  console.log(`[position] sizing ${mint}: ${sizeSol.toFixed(4)} SOL (${liveCfg.capitalPct}% of ${Number(solBalance).toFixed(4)}; limited by ${limitedBy})`);

  const lamports = Math.floor(sizeSol * LAMPORTS_PER_SOL);

  let buyResult;
  let via = 'jupiter';
  try {
    if (preferPump) {
      // Bonding-curve / auto-route buy — works before Jupiter has a route.
      buyResult = await buyOnPump(mint, sizeSol);
      via = buyResult.via || 'pumpPortal';
    } else {
      try {
        buyResult = await buySol(mint, lamports, wallet);
      } catch (jupErr) {
        console.warn(`[position] Jupiter buy failed for ${mint}, falling back to PumpPortal: ${jupErr.message}`);
        buyResult = await buyOnPump(mint, sizeSol);
        via = buyResult.via || 'pumpPortal';
      }
    }
  } catch (err) {
    console.error(`[position] buy failed for ${mint}:`, err.message);
    logTrade({ mint, chain: 'solana', event: 'buy_failed', error: err.message, code: err.code || null });
    runtime.recordSkip('solana', err.code === 'BUY_ZERO' ? 'buy filled 0 tokens' : 'buy transaction failed');
    // Rate-limit: only notify hard failures occasionally, not every miss
    if (err.code !== 'BUY_ZERO') {
      telegram.notify(`⚠️ BUY FAILED for ${mint}: ${err.message}`.slice(0, 350));
    } else {
      console.warn(`[position] buy got 0 tokens for ${mint} — not tracking (no spam notify)`);
    }
    return;
  }

  const rawOut = buyResult.tokenAmountRaw != null
    ? buyResult.tokenAmountRaw
    : (buyResult.quote && buyResult.quote.outAmount);
  const outAmountNum = rawOut != null && rawOut !== '' ? Number(rawOut) : 0;

  // Never open a tracked position with 0 tokens — that caused SellZeroAmount spam.
  if (!buyResult.dryRun && !(outAmountNum > 0)) {
    console.warn(`[position] buy returned no tokens for ${mint} — not opening position`);
    logTrade({ mint, chain: 'solana', event: 'buy_failed', error: 'zero tokens after buy' });
    runtime.recordSkip('solana', 'buy filled 0 tokens');
    telegram.notify(`⚠️ BUY returned 0 tokens for ${mint.slice(0, 12)}… — not tracking. Check wallet / slippage.`);
    return;
  }

  const entryPriceSolPerToken = outAmountNum > 0 ? lamports / outAmountNum : 0;
  const dbPositionId = await stateSync.recordPositionOpened({
    chain: 'solana',
    address: mint,
    dryRun: buyResult.dryRun,
    sizeNative: sizeSol,
    entryTx: buyResult.signature,
  });

  const position = {
    mint,
    sizeSol,
    tokenAmountRaw: outAmountNum > 0 ? (typeof rawOut === 'string' ? rawOut : String(Math.floor(outAmountNum))) : null,
    entryPriceSolPerToken,
    openedAt: Date.now(),
    dryRun: buyResult.dryRun,
    buySignature: buyResult.signature,
    exit: assessment.exit,
    verdict: assessment.verdict,
    score: assessment.score,
    dbPositionId,
    via,
    // live monitoring state
    lastPnlPct: 0,
    lastValueNative: sizeSol,
    lastPolledAt: null,
    exiting: false,
    polling: false,
    sellFailures: 0,
    nextExitAt: 0,
  };
  openPositions.set(mint, position);
  runtime.recordEntry('solana');

  console.log(
    `[position] ${DRY_RUN ? '[DRY RUN] ' : ''}ENTERED ${mint} via ${via} — ${sizeSol.toFixed(4)} SOL @ ${entryPriceSolPerToken || 'n/a'}`
  );
  logTrade({ mint, chain: 'solana', event: 'buy', sizeSol, dryRun: buyResult.dryRun, signature: buyResult.signature, via });
  telegram.notify(
    entryMessage({
      chainLabel: '🟣 Solana',
      unit: 'SOL',
      address: mint,
      size: sizeSol,
      capitalPct: liveCfg.capitalPct,
      balance: solBalance,
      assessment,
      cfg: liveCfg,
      dryRun: buyResult.dryRun,
      via,
    })
  );

  monitorPosition(mint);
}

// Polls the sell price every PRICE_POLL_INTERVAL_MS and sells the whole
// position the moment a rule fires. The rules (take profit / stop loss / max
// hold) are re-read from live config on every poll, so changing them from
// Telegram applies to positions that are already open.
function monitorPosition(mint) {
  const interval = setInterval(async () => {
    const position = openPositions.get(mint);
    if (!position) {
      clearInterval(interval);
      return;
    }
    if (position.exiting || position.polling) return;

    position.polling = true;
    try {
      let currentSolOut = position.lastValueNative;
      let pnlPct = position.lastPnlPct || 0;
      let priced = false;

      // 1) Jupiter route (post-migration / real DEX)
      if (position.tokenAmountRaw) {
        try {
          const quote = await getQuote(mint, SOL_MINT, position.tokenAmountRaw);
          currentSolOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
          pnlPct = ((currentSolOut - position.sizeSol) / position.sizeSol) * 100;
          priced = true;
        } catch (_) {
          /* fall through to DexScreener */
        }
      }

      // 2) DexScreener native price — works on bonding-curve / pre-Jupiter pairs
      if (!priced) {
        try {
          const mkt = await getTokenMarket(mint);
          if (mkt && mkt.priceNative > 0 && position.tokenAmountRaw) {
            // pump.fun tokens are 6 decimals; if wrong, PnL scale is off but direction still works for exits
            const decimals = position.decimals != null ? position.decimals : 6;
            const tokens = Number(position.tokenAmountRaw) / 10 ** decimals;
            currentSolOut = tokens * mkt.priceNative;
            if (position.sizeSol > 0) {
              pnlPct = ((currentSolOut - position.sizeSol) / position.sizeSol) * 100;
              priced = true;
            }
          }
        } catch (_) {
          /* ignore */
        }
      }

      // 3) Still no price → only max-hold can force exit (TP/SL need a price)
      if (!priced) {
        const ageMsProbe = Date.now() - position.openedAt;
        const rulesProbe = resolveExit(position.exit, getConfig());
        if (ageMsProbe >= rulesProbe.maxHoldMs) {
          await exitPosition(mint, 'max_age', pnlPct);
          return;
        }
      }
      const ageMs = Date.now() - position.openedAt;

      position.lastPnlPct = pnlPct;
      position.lastValueNative = currentSolOut;
      position.lastPolledAt = Date.now();

      const rules = resolveExit(position.exit, getConfig());
      let reason = evaluateExit({ pnlPct, ageMs, rules });
      // If a previous sell failed, keep forcing exit with last reason
      if (!reason && position.sellFailures > 0 && position.lastExitReason) {
        reason = position.lastExitReason;
      }
      if (reason && Date.now() >= (position.nextExitAt || 0)) {
        await exitPosition(mint, reason, pnlPct);
      }
    } catch (err) {
      console.error(`[position] price poll failed for ${mint}:`, err.message);
    } finally {
      position.polling = false;
    }
  }, PRICE_POLL_INTERVAL_MS);
}

async function exitPosition(mint, reason, pnlPct) {
  const position = openPositions.get(mint);
  if (!position || position.exiting) return;
  position.exiting = true;
  position.lastExitReason = reason;

  telegram.notify(
    `⏳ SELLING ${mint.slice(0, 8)}… (${reason}) — attempting exit now`
  );

  const wallet = loadWallet();
  let sellResult = null;
  let lastErr = null;
  const slips = SELL_SLIP_LADDER.length ? SELL_SLIP_LADDER : [25, 40, 55, 70];

  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt += 1) {
    const slip = slips[Math.min(attempt - 1, slips.length - 1)];
    try {
      // Always try full wallet sell via PumpPortal first (curve + thin pools).
      try {
        sellResult = await sellOnPump(mint, position.tokenAmountRaw, { slippage: slip });
        if (!sellResult.quote) sellResult.quote = null;
      } catch (pumpErr) {
        if (pumpErr.code === 'SELL_ZERO' || /SellZeroAmount|0x1786/i.test(pumpErr.message || '')) {
          throw pumpErr;
        }
        // Fallback Jupiter if we still know a raw amount
        if (position.tokenAmountRaw) {
          console.warn(`[position] Pump sell fail (slip ${slip}%): ${pumpErr.message} — trying Jupiter`);
          sellResult = await sellToSol(mint, position.tokenAmountRaw, wallet);
        } else {
          throw pumpErr;
        }
      }
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[position] sell attempt ${attempt}/${SELL_ATTEMPTS} (${slip}% slip) failed for ${mint}:`, err.message);
      if (err.code === 'SELL_ZERO' || /SellZeroAmount|holds 0 tokens|0x1786/i.test(err.message || '')) {
        // One more balance recheck after delay — RPC lag
        await sleep(2000);
        try {
          const { getTokenBalanceRaw } = require('./pumpPortal');
          const bal = await getTokenBalanceRaw(mint);
          if (bal > 0n) {
            lastErr = null;
            continue;
          }
        } catch (_) {}
        break;
      }
      if (attempt < SELL_ATTEMPTS) await sleep(SELL_RETRY_BASE_MS * attempt);
    }
  }

  if (!sellResult) {
    const msg = (lastErr && lastErr.message) || 'unknown sell error';
    const isZero =
      (lastErr && lastErr.code === 'SELL_ZERO') ||
      /SellZeroAmount|sell zero|holds 0 tokens|0x1786/i.test(msg);

    // NEVER drop tracking while we still have a known token amount from the buy —
    // RPC lag / Helius 429 often reports 0 falsely and that left users stuck.
    const hasKnown = position.tokenAmountRaw && String(position.tokenAmountRaw) !== '0';
    if (isZero && !hasKnown && (position.sellFailures || 0) >= 5) {
      openPositions.delete(mint);
      logTrade({ mint, chain: 'solana', event: 'sell_abandoned', error: msg, reason });
      telegram.notify(
        `⚠️ STOPPED tracking ${mint}\nWallet repeatedly shows 0 tokens after buy.\n` +
          `Double-check the wallet manually and sell on pump.fun if tokens remain.`
      );
      return;
    }

    position.exiting = false;
    position.sellFailures = (position.sellFailures || 0) + 1;
    // Retry fast — stuck bags are dangerous
    position.nextExitAt = Date.now() + (isZero ? 3000 : 5000);
    logTrade({ mint, chain: 'solana', event: 'sell_failed', error: msg, reason });
    if (position.sellFailures <= 3 || position.sellFailures % 3 === 0) {
      telegram.notify(
        `⚠️ SELL FAILED ${mint.slice(0, 12)}… (${reason}) #${position.sellFailures}: ${msg.slice(0, 160)}\n` +
          `Still holding — forced retry in a few seconds.`
      );
    }
    return;
  }

  // Confirm tokens left the wallet; if not, keep retrying
  try {
    const { getTokenBalanceRaw } = require('./pumpPortal');
    await sleep(1500);
    const left = await getTokenBalanceRaw(mint);
    if (left > 0n && !sellResult.dryRun) {
      console.warn(`[position] sell sig ok but still holding ${left} — will retry`);
      position.exiting = false;
      position.sellFailures = (position.sellFailures || 0) + 1;
      position.nextExitAt = Date.now() + 4000;
      position.tokenAmountRaw = left.toString();
      telegram.notify(`⚠️ Sell sent but still holding ${mint.slice(0, 12)}… — retrying`);
      return;
    }
  } catch (_) {}

  openPositions.delete(mint);

  const exitSol = sellResult.quote
    ? Number(sellResult.quote.outAmount) / LAMPORTS_PER_SOL
    : position.lastValueNative || position.sizeSol;
  const pnlSol = exitSol - position.sizeSol;
  const realizedPct = position.sizeSol > 0 ? (pnlSol / position.sizeSol) * 100 : pnlPct || 0;
  const rules = resolveExit(position.exit, getConfig());

  console.log(
    `[position] ${sellResult.dryRun ? '[DRY RUN] ' : ''}EXITED ${mint} — reason=${reason} pnl=${realizedPct.toFixed(1)}% (${pnlSol.toFixed(5)} SOL)`
  );
  logTrade({
    mint,
    chain: 'solana',
    event: 'sell',
    reason,
    pnlPct: realizedPct,
    pnlSol,
    dryRun: sellResult.dryRun,
    signature: sellResult.signature,
  });
  runtime.recordExit('solana', { pnlNative: pnlSol });
  stateSync.recordPositionClosed(position.dbPositionId, {
    exitTx: sellResult.signature,
    exitReason: reason,
    pnlPct: realizedPct,
    pnlNative: pnlSol,
  });
  telegram.notify(
    exitMessage({
      unit: 'SOL',
      address: mint,
      reason,
      size: position.sizeSol,
      exitValue: exitSol,
      heldMs: Date.now() - position.openedAt,
      rules,
      dryRun: sellResult.dryRun,
    })
  );
}

module.exports = { tryEnterPosition, openPositions, enterFromGraduation };
