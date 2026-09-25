const { getSupabase } = require('./supabaseClient');

// All functions here are best-effort and never throw — if Supabase isn't
// configured or a write fails, the engine keeps running on local
// trades.log alone (same as before this feature existed). The dashboard/
// Telegram feed just won't reflect that event.

async function recordAssessment(assessment) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from('assessments').insert({
      chain: assessment.chain,
      address: assessment.address,
      verdict: assessment.verdict,
      recommended: assessment.recommended,
      category: assessment.category,
      is_community_coin: assessment.isCommunityCoin,
      dev_percent: assessment.devPercent,
      top10_percent: assessment.top10Percent,
      curve_progress_pct: assessment.curveProgressPct,
      migrated: assessment.migrated,
      score: assessment.score,
      reasons: assessment.reasons,
      exit_plan: assessment.exit,
    });
  } catch (err) {
    console.error('[state-sync] failed to record assessment:', err.message);
  }
}

async function recordPositionOpened({ chain, address, dryRun, sizeNative, entryTx }) {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('positions')
      .insert({ chain, address, dry_run: dryRun, size_native: sizeNative, entry_tx: entryTx, status: 'open' })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    console.error('[state-sync] failed to record position open:', err.message);
    return null;
  }
}

async function recordPositionClosed(positionId, { exitTx, exitReason, pnlPct, pnlNative }) {
  const supabase = getSupabase();
  if (!supabase || !positionId) return;
  const base = {
    status: 'closed',
    exit_tx: exitTx,
    exit_reason: exitReason,
    pnl_pct: pnlPct,
    closed_at: new Date().toISOString(),
  };
  try {
    let { error } = await supabase.from('positions').update({ ...base, pnl_native: pnlNative }).eq('id', positionId);
    if (error && /pnl_native|column|schema cache/i.test(error.message)) {
      // Migration 002 not run yet: still mark the position closed.
      ({ error } = await supabase.from('positions').update(base).eq('id', positionId));
    }
    if (error) throw error;
  } catch (err) {
    console.error('[state-sync] failed to record position close:', err.message);
  }
}

module.exports = { recordAssessment, recordPositionOpened, recordPositionClosed };
