const { getSupabase } = require('./supabaseClient');
const staticConfig = require('../config');

// Falls back to the static .env-based defaults if Supabase isn't
// configured, so the engine still runs standalone (same as before this
// feature existed) if you haven't set SUPABASE_URL/SUPABASE_SERVICE_KEY.
let cached = {
  paused: false,
  enableSolana: staticConfig.ENABLE_SOLANA,
  enableBsc: staticConfig.ENABLE_BSC,
  minRecommendTier: 'LOW_MEDIUM', // 'LOW' or 'LOW_MEDIUM' — default allows MEDIUM so the bot can actually enter once a safe candidate appears
  maxTokensPerDay: staticConfig.MAX_TOKENS_PER_DAY,
  maxDevPercent: 30,
  maxTop10Percent: 70,
  capitalPct: staticConfig.CAPITAL_PCT,
  maxPositionSol: staticConfig.MAX_POSITION_SOL,
  bscCapitalPct: staticConfig.BSC_CAPITAL_PCT,
  bscMaxPositionBnb: staticConfig.BSC_MAX_POSITION_BNB,
  takeProfitPct: 0, // 0 = auto by risk tier
  stopLossPct: 0, // 0 = auto by risk tier (positive number: 25 means -25%)
  maxHoldMin: 0, // 0 = auto by risk tier
  maxRiskScore: 50, // only enter tokens scoring <= this
  heartbeatMin: Number(process.env.HEARTBEAT_MIN || 60), // 0 = off
  // Separate, looser ceilings that apply ONLY when a token would otherwise
  // land as MEDIUM risk and minRecommendTier allows MEDIUM. A LOW-tier
  // token is still governed by maxDevPercent/maxTop10Percent/maxRiskScore.
  mediumMaxDevPercent: 45,
  mediumMaxTop10Percent: 85,
  mediumMaxScore: 50, // effectively "no extra restriction" until lowered below maxRiskScore
  // BSC-only: reject any token whose buy or sell tax exceeds these.
  maxBuyTaxPct: 15,
  maxSellTaxPct: 15,
};

// The settings added by supabase/migrations/002_*.sql and 003_*.sql. Until
// those have been run, these live in memory only.
const MIGRATION_KEYS = [
  'takeProfitPct', 'stopLossPct', 'maxHoldMin', 'maxRiskScore', 'heartbeatMin',
  'mediumMaxDevPercent', 'mediumMaxTop10Percent', 'mediumMaxScore', 'maxBuyTaxPct', 'maxSellTaxPct',
];
let migrated = true;

// Maps the camelCase keys used in code to the bot_config column names.
const COLUMNS = {
  paused: 'paused',
  enableSolana: 'enable_solana',
  enableBsc: 'enable_bsc',
  minRecommendTier: 'min_recommend_tier',
  maxTokensPerDay: 'max_tokens_per_day',
  maxDevPercent: 'max_dev_percent',
  maxTop10Percent: 'max_top10_percent',
  capitalPct: 'capital_pct',
  maxPositionSol: 'max_position_sol',
  bscCapitalPct: 'bsc_capital_pct',
  bscMaxPositionBnb: 'bsc_max_position_bnb',
  takeProfitPct: 'take_profit_pct',
  stopLossPct: 'stop_loss_pct',
  maxHoldMin: 'max_hold_min',
  maxRiskScore: 'max_risk_score',
  heartbeatMin: 'heartbeat_min',
  mediumMaxDevPercent: 'medium_max_dev_percent',
  mediumMaxTop10Percent: 'medium_max_top10_percent',
  mediumMaxScore: 'medium_max_score',
  maxBuyTaxPct: 'max_buy_tax_pct',
  maxSellTaxPct: 'max_sell_tax_pct',
};

// Value from a DB column, or the last known value if the column doesn't exist yet.
function num(row, col, fallback) {
  return row[col] === undefined || row[col] === null ? fallback : Number(row[col]);
}

function mapRow(row) {
  if (!row) return cached;
  migrated = MIGRATION_KEYS.every((k) => row[COLUMNS[k]] !== undefined);
  return {
    paused: row.paused,
    enableSolana: row.enable_solana,
    enableBsc: row.enable_bsc,
    minRecommendTier: row.min_recommend_tier,
    maxTokensPerDay: row.max_tokens_per_day,
    maxDevPercent: Number(row.max_dev_percent),
    maxTop10Percent: Number(row.max_top10_percent),
    capitalPct: Number(row.capital_pct),
    maxPositionSol: Number(row.max_position_sol),
    bscCapitalPct: Number(row.bsc_capital_pct),
    bscMaxPositionBnb: Number(row.bsc_max_position_bnb),
    takeProfitPct: num(row, 'take_profit_pct', cached.takeProfitPct),
    stopLossPct: num(row, 'stop_loss_pct', cached.stopLossPct),
    maxHoldMin: num(row, 'max_hold_min', cached.maxHoldMin),
    maxRiskScore: num(row, 'max_risk_score', cached.maxRiskScore),
    heartbeatMin: num(row, 'heartbeat_min', cached.heartbeatMin),
    mediumMaxDevPercent: num(row, 'medium_max_dev_percent', cached.mediumMaxDevPercent),
    mediumMaxTop10Percent: num(row, 'medium_max_top10_percent', cached.mediumMaxTop10Percent),
    mediumMaxScore: num(row, 'medium_max_score', cached.mediumMaxScore),
    maxBuyTaxPct: num(row, 'max_buy_tax_pct', cached.maxBuyTaxPct),
    maxSellTaxPct: num(row, 'max_sell_tax_pct', cached.maxSellTaxPct),
  };
}

async function refresh() {
  const supabase = getSupabase();
  if (!supabase) return cached;
  const { data, error } = await supabase.from('bot_config').select('*').eq('id', 1).single();
  if (error) {
    console.error('[live-config] refresh failed, keeping last known values:', error.message);
    return cached;
  }
  cached = mapRow(data);
  return cached;
}

function getConfig() {
  return cached;
}

// Applies a change to the in-memory config immediately. Used when Supabase
// isn't configured (so Telegram buttons still work until the next restart),
// and after a Supabase write so the value shown is never stale.
function applyLocal(patch) {
  cached = { ...cached, ...patch };
  return cached;
}

// Call once at boot. Does an initial fetch, then subscribes to realtime
// changes AND polls every 15s as a fallback in case the realtime
// connection drops silently.
async function start() {
  const supabase = getSupabase();
  if (!supabase) {
    console.log('[live-config] Supabase not configured — running on static .env config only. Filters require a redeploy to change.');
    return;
  }

  await refresh();
  console.log('[live-config] loaded from Supabase:', JSON.stringify(cached));

  supabase
    .channel('bot_config_changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bot_config' }, (payload) => {
      cached = mapRow(payload.new);
      console.log('[live-config] updated live:', JSON.stringify(cached));
    })
    .subscribe();

  setInterval(refresh, 15000);
}

// False when Supabase is configured but the 002 migration hasn't been run.
const isMigrated = () => migrated;

module.exports = { start, getConfig, refresh, applyLocal, COLUMNS, MIGRATION_KEYS, isMigrated };
