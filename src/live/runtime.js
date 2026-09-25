// In-memory "what is the bot doing right now" registry. The detectors and
// position managers write into it; Telegram (and anything else) reads it.
// It has no dependencies on the rest of the app, so it can be required from
// anywhere without creating import cycles.
const BUCKET_MS = 60 * 1000;
const KEEP_BUCKETS = 24 * 60; // 24h of per-minute counters
const RECENT_MAX = 10;

const startedAt = Date.now();
const newChain = () => ({
  detector: 'idle', // idle | connecting | connected | stalled | reconnecting
  detectorSince: null,
  lastMessageAt: null, // last sign of life from the feed (any message/block)
  lastLaunchAt: null,
  reconnects: 0,
  totals: { launches: 0, assessed: 0, passed: 0, recommended: 0, entered: 0, exited: 0, wins: 0, losses: 0, realizedNative: 0 },
  rejects: {}, // reason bucket -> count
  skips: {}, // why a safe token still wasn't entered -> count
  buckets: new Map(), // minuteKey -> counters
});
const chains = { solana: newChain(), bsc: newChain() };
let recent = [];
const positionSources = {};

const now = () => Date.now();

function bucket(chain) {
  const c = chains[chain];
  const key = Math.floor(now() / BUCKET_MS);
  let b = c.buckets.get(key);
  if (!b) {
    b = { launches: 0, assessed: 0, passed: 0, recommended: 0, entered: 0 };
    c.buckets.set(key, b);
    for (const k of c.buckets.keys()) if (k < key - KEEP_BUCKETS) c.buckets.delete(k);
  }
  return b;
}

function windowSum(chain, minutes) {
  const c = chains[chain];
  const minKey = Math.floor(now() / BUCKET_MS) - Math.max(1, Math.ceil(minutes)) + 1;
  const sum = { launches: 0, assessed: 0, passed: 0, recommended: 0, entered: 0 };
  for (const [k, b] of c.buckets) {
    if (k >= minKey) for (const f of Object.keys(sum)) sum[f] += b[f];
  }
  return sum;
}

const bump = (obj, key) => {
  obj[key] = (obj[key] || 0) + 1;
};

// ---- detector health ----
function setDetector(chain, state) {
  const c = chains[chain];
  if (c.detector !== state) {
    if (state === 'reconnecting') c.reconnects += 1;
    c.detector = state;
    c.detectorSince = now();
  }
  if (state === 'connected') c.lastMessageAt = now();
}
const touch = (chain) => {
  chains[chain].lastMessageAt = now();
};

// ---- funnel counters ----
function recordLaunch(chain) {
  const c = chains[chain];
  c.totals.launches += 1;
  c.lastLaunchAt = now();
  bucket(chain).launches += 1;
}

// Groups the free-text rejection reasons into a few readable buckets.
function classifyReject(assessment) {
  const r = String((assessment.reasons && assessment.reasons[0]) || '');
  if (assessment.verdict !== 'UNSAFE') return `risk too high (${assessment.verdict})`;
  if (/no sell route|honeypot/i.test(r)) return 'no sell route / honeypot';
  if (/freeze authority/i.test(r)) return 'freeze authority active';
  if (/(creator|dev|owner).*(hold|wallet)/i.test(r)) return 'dev holding over limit';
  if (/top 10/i.test(r)) return 'top-10 holding over limit';
  return 'other red flag';
}

const BLOCK_LABELS = {
  tier: 'MEDIUM risk (tier setting is LOW only)',
  score: 'risk score above entry limit',
  quota: 'daily limit already used',
  paused: 'trading paused / chain off',
};

function recordAssessed(chain, address, a) {
  const c = chains[chain];
  c.totals.assessed += 1;
  const b = bucket(chain);
  b.assessed += 1;

  if (!a.tradeable) {
    bump(c.rejects, classifyReject(a));
  } else {
    c.totals.passed += 1;
    b.passed += 1;
    if (a.recommended) {
      c.totals.recommended += 1;
      b.recommended += 1;
    } else if (a.blockedBy) {
      bump(c.skips, BLOCK_LABELS[a.blockedBy] || a.blockedBy);
    }
  }

  recent.unshift({
    at: now(),
    chain,
    address,
    verdict: a.verdict,
    score: a.score,
    recommended: !!a.recommended,
    tradeable: !!a.tradeable,
    note: (a.reasons && a.reasons[0]) || '',
  });
  recent = recent.slice(0, RECENT_MAX);
}

function recordSkip(chain, why) {
  bump(chains[chain].skips, why);
}

function recordEntry(chain) {
  chains[chain].totals.entered += 1;
  bucket(chain).entered += 1;
}

function recordExit(chain, { pnlNative = 0 } = {}) {
  const t = chains[chain].totals;
  t.exited += 1;
  t.realizedNative += Number(pnlNative) || 0;
  if (pnlNative > 0) t.wins += 1;
  else if (pnlNative < 0) t.losses += 1;
}

// ---- open positions (owned by the position managers) ----
function registerPositions(chain, getter) {
  positionSources[chain] = getter;
}
function getOpenPositions() {
  const out = [];
  for (const getter of Object.values(positionSources)) {
    try {
      out.push(...getter());
    } catch (_) {
      /* a broken getter must never break a status message */
    }
  }
  return out;
}

function snapshot() {
  return { startedAt, chains, recent: [...recent] };
}

// Test helper.
function _reset() {
  chains.solana = newChain();
  chains.bsc = newChain();
  recent = [];
  for (const k of Object.keys(positionSources)) delete positionSources[k];
}

module.exports = {
  setDetector,
  touch,
  recordLaunch,
  recordAssessed,
  recordSkip,
  recordEntry,
  recordExit,
  registerPositions,
  getOpenPositions,
  windowSum,
  snapshot,
  _reset,
};
