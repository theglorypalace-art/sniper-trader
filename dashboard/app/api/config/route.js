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
    updates.updated_by = 'dashboard';

    const supabase = getSupabase();
    const { error } = await supabase.from('bot_config').update(updates).eq('id', 1);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
