const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', '..', 'trades.log');

function logTrade(entry) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (err) {
    console.error('[trade-log] failed to write:', err.message);
  }
}

module.exports = { logTrade, LOG_PATH };
