// A small leaky-bucket limiter + bounded queue for outbound calls to
// third-party APIs with a request-per-minute ceiling (GoPlus's free tier is
// roughly 30/min). Without this, moving the risk assessment ahead of the
// sellability check (see riskEngine.js) means GoPlus gets called for EVERY
// new pump.fun launch — which on a busy day can be 20+/minute, enough to
// saturate the limit on its own.
//
// If the queue backs up faster than it can drain, the OLDEST waiting
// requests are dropped rather than eventually processed minutes late — a
// risk check on a token from 5 minutes ago is worthless to a bot trying to
// buy at launch or at graduation.
const DEFAULT_INTERVAL_MS = Number(process.env.GOPLUS_MIN_INTERVAL_MS || 2200); // ~27/min, just under GoPlus's public ~30/min
// Deliberately small. This bot needs to trade, not complete every check —
// a token assessed a minute late is often worse than one never assessed at
// all (the entry window is gone either way). A short queue plus the 50%
// shed below means it degrades to "check roughly half of what arrives,
// promptly" under load instead of "check all of it, eventually".
const DEFAULT_MAX_QUEUE = Number(process.env.GOPLUS_MAX_QUEUE || 12);
// Once this many are already waiting, start shedding roughly half of NEW
// arrivals outright (near-zero cost, no queue slot used) rather than
// letting the backlog — and therefore the delay — keep growing.
const DEFAULT_SHED_AT = Number(process.env.GOPLUS_SHED_AT_QUEUE || Math.ceil(DEFAULT_MAX_QUEUE / 2));

function createLimiter({ intervalMs = DEFAULT_INTERVAL_MS, maxQueue = DEFAULT_MAX_QUEUE, shedAt = DEFAULT_SHED_AT } = {}) {
  const queue = [];
  let lastRunAt = 0;
  let timer = null;
  let dropped = 0;
  let shed = 0;
  let shedToggle = 0;

  function runNext() {
    timer = null;
    const job = queue.shift();
    if (!job) return;
    lastRunAt = Date.now();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject);
    if (queue.length) schedule();
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastRunAt));
    timer = setTimeout(runNext, wait);
    if (timer.unref) timer.unref();
  }

  return {
    // Queues fn (a () => Promise) and resolves/rejects with its result once
    // its turn comes up, throttled to roughly one call per intervalMs.
    run(fn) {
      return new Promise((resolve, reject) => {
        if (queue.length >= shedAt) {
          // Under load: skip roughly every other NEW arrival rather than
          // queueing it behind an already-growing backlog. Whatever gets
          // through still runs promptly.
          shedToggle = (shedToggle + 1) % 2;
          if (shedToggle === 0) {
            shed += 1;
            reject(new Error('skipped under load — system is prioritizing keeping up over checking everything'));
            return;
          }
        }
        if (queue.length >= maxQueue) {
          const stale = queue.shift();
          dropped += 1;
          stale.reject(new Error('rate-limit queue full — dropped an older, now-stale request'));
        }
        queue.push({ fn, resolve, reject });
        schedule();
      });
    },
    get pending() {
      return queue.length;
    },
    get droppedCount() {
      return dropped;
    },
    get shedCount() {
      return shed;
    },
  };
}

// Shared across both GoPlus endpoints (Solana + EVM) since the rate limit is
// per API key/IP, not per chain.
const goplusLimiter = createLimiter();

module.exports = { createLimiter, goplusLimiter };
