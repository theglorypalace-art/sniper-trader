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
const stateSync = require('../live/stateSync');
const telegram = require('../telegram/bot');

const openPositions = new Map(); // mint -> position state
let lastEntryAttemptAt = 0;
const ENTRY_COOLDOWN_MS = Number(process.env.ENTRY_COOLDOWN_MS || 15000); // min gap between buy attempts

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

const SELL_ATTEMPTS = Number(process.env.SELL_ATTEMPTS || 3);
const SELL_RETRY_BASE_MS = Number(process.env.SELL_RETRY_BASE_MS || 1500);
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
  if (openPositions.size >= MAX_CONCURRENT_POSITIONS) {
    runtime.recordSkip('solana', 'already holding a position (max concurrent reached)');
    console.log(`[position] skipping ${mint} — already at MAX_CONCURRENT_POSITIONS (${MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (entering + openPositions.size >= MAX_CONCURRENT_POSITIONS) {
    runtime.recordSkip('solana', 'busy evaluating another candidate that arrived first');
    console.log(`[position] skipping ${mint} — already evaluating another candidate (MAX_CONCURRENT_POSITIONS=${MAX_CONCURRENT_POSITIONS})`);
    return;
  }
  if (openPositions.has(mint)) return;

  // Cool down between buy attempts to stop spam of failed portal trades
  const since = Date.now() - lastEntryAttemptAt;
  if (lastEntryAttemptAt && since < ENTRY_COOLDOWN_MS) {
    runtime.recordSkip('solana', 'entry cooldown');
    console.log(`[position] skipping ${mint} — entry cooldown (${Math.ceil((ENTRY_COOLDOWN_MS - since) / 1000)}s left)`);
    return;
  }

  entering += 1;
  lastEntryAttemptAt = Date.now();
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

  // Pre-migration: no Jupiter route. Buy on bonding curve only if it would
  // have been recommended (or we explicitly promote it with a daily slot).
  const onCurve = Boolean(assessment.pendingGraduation);
  const liveCfg = getConfig();

  if (onCurve && !assessment.recommended) {
    if (liveCfg.paused || !liveCfg.enableSolana) {
      console.log(`[position] ${mint} on curve — paused/off, watch only`);
      graduationWatcher.watch(mint, assessment);
      return;
    }
    // Promote to buy only if a daily slot is available (same selectivity as post-migration)
    const { tryConsumeDailySlot } = require('../analysis/dailyLimiter');
    const gotSlot = tryConsumeDailySlot(liveCfg.maxTokensPerDay);
    if (!gotSlot) {
      console.log(`[position] ${mint} on curve but daily quota full — not buying`);
      runtime.recordSkip('solana', 'daily quota full');
      return;
    }
    assessment.recommended = true;
    assessment.reasons = [
      ...(assessment.reasons || []),
      'Buying on pump.fun bonding curve (no Jupiter route until migration).',
    ];
  }

  if (!assessment.recommended) return;

  if (liveCfg.paused) {
    console.log(`[position] ${mint} recommended but paused — skip`);
    runtime.recordSkip('solana', 'trading paused / chain off');
    return;
  }
  if (!liveCfg.enableSolana) {
    console.log(`[position] ${mint} recommended but Solana off — skip`);
    runtime.recordSkip('solana', 'trading paused / chain off');
    return;
  }

  // Notify only when we actually attempt a buy (not every assessment)
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
      try {
        if (position.tokenAmountRaw) {
          const quote = await getQuote(mint, SOL_MINT, position.tokenAmountRaw);
          currentSolOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
          pnlPct = ((currentSolOut - position.sizeSol) / position.sizeSol) * 100;
        }
      } catch (quoteErr) {
        // Pre-migration: Jupiter has no route. Force exit on max-hold only;
        // TP/SL from Jupiter quotes unavailable until migration.
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
      const reason = evaluateExit({ pnlPct, ageMs, rules });
      if (reason && Date.now() >= position.nextExitAt) {
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

  const wallet = loadWallet();
  let sellResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt += 1) {
    try {
      // Pump positions (and any unknown balance): sell 100% via PumpPortal with high exit slippage.
      // Jupiter path only when we have a known raw amount and bought via Jupiter.
      if (position.via === 'pumpPortal' || !position.tokenAmountRaw) {
        sellResult = await sellOnPump(mint, position.tokenAmountRaw);
        if (!sellResult.quote) sellResult.quote = null;
      } else {
        try {
          sellResult = await sellToSol(mint, position.tokenAmountRaw, wallet);
        } catch (jupErr) {
          console.warn(`[position] Jupiter sell failed, trying PumpPortal 100%: ${jupErr.message}`);
          sellResult = await sellOnPump(mint, null);
          if (!sellResult.quote) sellResult.quote = null;
        }
      }
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[position] sell attempt ${attempt}/${SELL_ATTEMPTS} failed for ${mint}:`, err.message);
      // Zero balance: stop retrying immediately
      if (err.code === 'SELL_ZERO' || /SellZeroAmount|holds 0 tokens|0x1786/i.test(err.message || '')) {
        break;
      }
      if (attempt < SELL_ATTEMPTS) await sleep(SELL_RETRY_BASE_MS * attempt);
    }
  }

  if (!sellResult) {
    const msg = (lastErr && lastErr.message) || '';
    const isZero =
      (lastErr && lastErr.code === 'SELL_ZERO') ||
      /SellZeroAmount|sell zero|holds 0 tokens|0x1786/i.test(msg);

    if (isZero) {
      openPositions.delete(mint);
      logTrade({ mint, chain: 'solana', event: 'sell_abandoned', error: msg, reason });
      runtime.recordSkip('solana', 'sell zero amount — abandoned');
      // Console only — was spamming Telegram on empty positions
      console.warn(`[position] abandoned ${mint} (${reason}) — 0 balance, no Telegram spam`);
      return;
    }

    // Transient failure: keep tracking and retry later.
    position.exiting = false;
    position.sellFailures += 1;
    position.nextExitAt = Date.now() + Math.min(60000, 10000 * position.sellFailures);
    logTrade({ mint, chain: 'solana', event: 'sell_failed', error: msg, reason });
    if (position.sellFailures === 1 || position.sellFailures % 5 === 0) {
      telegram.notify(
        `⚠️ SELL FAILED for ${mint} (${reason}) after ${SELL_ATTEMPTS} tries: ${msg}\n` +
          `Still holding it — the bot will keep retrying. If it keeps failing, sell manually.`
      );
    }
    return;
  }

  openPositions.delete(mint);

  // Use what the sell actually returned, not the last price poll.
  const exitSol = sellResult.quote ? Number(sellResult.quote.outAmount) / LAMPORTS_PER_SOL : position.lastValueNative;
  const pnlSol = exitSol - position.sizeSol;
  const realizedPct = (pnlSol / position.sizeSol) * 100;
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
