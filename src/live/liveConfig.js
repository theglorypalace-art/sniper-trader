const { getSupabase } = require('./supabaseClient');
const staticConfig = require('../config');

// Falls back to the static .env-based defaults if Supabase isn't
// configured, so the engine still runs standalone (same as before this
// feature existed) if you haven't set SUPABASE_URL/SUPABASE_SERVICE_KEY.
let cached = {
  paused: false,
  enableSolana: staticConfig.ENABLE_SOLANA,
  enableBsc: staticConfig.ENABLE_BSC,
  minRecommendTier: 'LOW', // 'LOW' or 'LOW_MEDIUM'
  maxTokensPerDay: staticConfig.MAX_TOKENS_PER_DAY,
  maxDevPercent: 30,
  maxTop10Percent: 70,
  capitalPct: staticConfig.CAPITAL_PCT,
  maxPositionSol: staticConfig.MAX_POSITION_SOL,
  bscCapitalPct: staticConfig.BSC_CAPITAL_PCT,
  bscMaxPositionBnb: staticConfig.BSC_MAX_POSITION_BNB,
};

function mapRow(row) {
  if (!row) return cached;
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

module.exports = { start, getConfig, refresh };
