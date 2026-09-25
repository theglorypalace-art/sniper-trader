import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabaseServer';

const ALLOWED_FIELDS = [
  'paused',
  'enable_solana',
  'enable_bsc',
  'min_recommend_tier',
  'max_tokens_per_day',
  'max_dev_percent',
  'max_top10_percent',
  'capital_pct',
  'max_position_sol',
  'bsc_capital_pct',
  'bsc_max_position_bnb',
];

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in body) updates[key] = body[key];
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields in request.' }, { status: 400 });
    }

    // Sanity-check the sizing fields (capital % is free between 0.01 and 100;
    // the per-trade caps accept 0 meaning "no cap").
    const RANGES = {
      capital_pct: [0.01, 100],
      bsc_capital_pct: [0.01, 100],
      max_position_sol: [0, 100000],
      bsc_max_position_bnb: [0, 100000],
      take_profit_pct: [0, 10000],
      stop_loss_pct: [0, 99],
      max_hold_min: [0, 1440],
      max_risk_score: [1, 100],
      heartbeat_min: [0, 1440],
    };
    for (const [key, [lo, hi]] of Object.entries(RANGES)) {
      if (key in updates) {
        const n = Number(updates[key]);
        if (!Number.isFinite(n) || n < lo || n > hi) {
          return NextResponse.json({ error: `${key} must be a number between ${lo} and ${hi}.` }, { status: 400 });
        }
        updates[key] = n;
      }
    }
    updates.updated_by = 'dashboard';

    const supabase = getSupabase();
    const { error } = await supabase.from('bot_config').update(updates).eq('id', 1);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
