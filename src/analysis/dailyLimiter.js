// Enforces the "very selective, max N tokens a day" rule. State is a tiny
// JSON file so the count survives restarts within the same day (Termux/
// mobile setups get killed and relaunched a lot).
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', '..', 'daily-limit-state.json');

function todayKeyUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { date: todayKeyUtc(), count: 0 };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (err) {
    console.error('[daily-limiter] failed to persist state:', err.message);
  }
}

function currentState() {
  const state = loadState();
  if (state.date !== todayKeyUtc()) {
    return { date: todayKeyUtc(), count: 0 };
  }
  return state;
}

// Call this only once you've decided a token should actually be
// recommended/traded. Returns false (and reserves nothing) once the day's
// quota is used up.
function tryConsumeDailySlot(maxPerDay) {
  const state = currentState();
  if (state.count >= maxPerDay) return false;
  state.count += 1;
  saveState(state);
  return true;
}

function getDailyCount() {
  return currentState().count;
}

module.exports = { tryConsumeDailySlot, getDailyCount };
