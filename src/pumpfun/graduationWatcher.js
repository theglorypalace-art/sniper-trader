// Holds pump.fun tokens that passed every safety check EXCEPT "does it have
// a swap route yet" (they haven't migrated off the bonding curve), and polls
// each one's on-chain curve state until it graduates — then hands it
// straight to the buy path so the bot can act the moment it becomes
// tradeable, instead of forever rejecting every pre-migration launch.
//
// Verify pump.fun's migration behavior against a real, recent migration on
// a Solana explorer before relying on this in production — like the create
// detector, this watches the SAME on-chain account (src/analysis/pumpfunCurve.js)
// rather than parsing any log wording, so it's a bit more resilient, but
// pump.fun's account layout has changed before and could again.
const { getBondingCurveState } = require('../analysis/pumpfunCurve');
const runtime = require('../live/runtime');

const POLL_MS = Number(process.env.GRADUATION_POLL_MS || 4000);
const MAX_WATCHLIST = Number(process.env.GRADUATION_WATCHLIST_MAX || 60);
const WATCH_TIMEOUT_MS = Number(process.env.GRADUATION_WATCH_TIMEOUT_MS || 45 * 60 * 1000);
const CHECK_BATCH_SIZE = Number(process.env.GRADUATION_CHECK_BATCH_SIZE || 10); // curve-state RPC calls per tick

const watchlist = new Map(); // mint -> { assessment, addedAt, checking }
let onGraduated = null; // (mint, assessment) => Promise<void>, set by start()
let timer = null;
let cursor = 0; // round-robins through the watchlist across ticks so a big list doesn't starve later entries

// Adds a token to the watchlist. If it's already full, the WORST-scoring
// entry is dropped to make room for a genuinely better candidate; if the new
// one isn't better than the worst, it's dropped instead (report it, but
// don't watch it).
function watch(mint, assessment) {
  if (watchlist.has(mint)) return true;

  if (watchlist.size >= MAX_WATCHLIST) {
    let worstMint = null;
    let worstScore = -Infinity;
    for (const [m, w] of watchlist) {
      if (w.assessment.score > worstScore) {
        worstScore = w.assessment.score;
        worstMint = m;
      }
    }
    if (worstMint != null && assessment.score < worstScore) {
      watchlist.delete(worstMint);
      runtime.recordWatchDropped('solana', 'watchlist full — replaced by a better-scoring candidate');
    } else {
      runtime.recordWatchDropped('solana', 'watchlist full');
      return false;
    }
  }

  watchlist.set(mint, { assessment, addedAt: Date.now(), checking: false });
  runtime.recordWatchAdded('solana', watchlist.size);
  return true;
}

async function tick() {
  if (!watchlist.size) return;

  // Drop expired entries first (most pump.fun tokens never migrate at all).
  const now = Date.now();
  for (const [mint, w] of watchlist) {
    if (now - w.addedAt > WATCH_TIMEOUT_MS) {
      watchlist.delete(mint);
      runtime.recordWatchExpired('solana');
    }
  }
  if (!watchlist.size) return;

  const mints = [...watchlist.keys()];
  const batch = [];
  for (let i = 0; i < Math.min(CHECK_BATCH_SIZE, mints.length); i += 1) {
    batch.push(mints[cursor % mints.length]);
    cursor += 1;
  }

  await Promise.all(
    batch.map(async (mint) => {
      const w = watchlist.get(mint);
      if (!w || w.checking) return;
      w.checking = true;
      try {
        const state = await getBondingCurveState(mint).catch(() => null);
        if (state && state.complete) {
          watchlist.delete(mint);
          runtime.recordGraduation('solana');
          if (onGraduated) await onGraduated(mint, w.assessment);
        }
      } catch (err) {
        console.error(`[graduation-watcher] check failed for ${mint}:`, err.message);
      } finally {
        const still = watchlist.get(mint);
        if (still) still.checking = false;
      }
    })
  );

  runtime.setWatchlistSize('solana', watchlist.size);
}

function start(callback) {
  onGraduated = callback;
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[graduation-watcher] tick failed:', err.message));
  }, POLL_MS);
  if (timer.unref) timer.unref();
  console.log(`[graduation-watcher] watching for pump.fun migrations every ${POLL_MS}ms (max ${MAX_WATCHLIST} tracked, ${Math.round(WATCH_TIMEOUT_MS / 60000)}min timeout)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function size() {
  return watchlist.size;
}

function list() {
  return [...watchlist.entries()].map(([mint, w]) => ({
    mint,
    score: w.assessment.score,
    verdict: w.assessment.verdict,
    ageMs: Date.now() - w.addedAt,
  }));
}

module.exports = { watch, start, stop, size, list, _tick: tick };
