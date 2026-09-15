import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabaseServer';

export async function GET() {
  try {
    const supabase = getSupabase();
    const [configRes, positionsRes, assessmentsRes] = await Promise.all([
      supabase.from('bot_config').select('*').eq('id', 1).single(),
      supabase.from('positions').select('*').order('opened_at', { ascending: false }).limit(50),
      supabase.from('assessments').select('*').order('created_at', { ascending: false }).limit(50),
    ]);
    if (configRes.error) throw configRes.error;
    if (positionsRes.error) throw positionsRes.error;
    if (assessmentsRes.error) throw assessmentsRes.error;

    return NextResponse.json({
      config: configRes.data,
      positions: positionsRes.data,
      assessments: assessmentsRes.data,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
