import { createClient } from '@supabase/supabase-js';

// Deliberately reads server-only env vars (no NEXT_PUBLIC_ prefix) so the
// service_role key never ships to the browser. Every read/write the
// dashboard does goes through our own API routes (app/api/*), which run
// on the server and use this client — the browser never talks to
// Supabase directly.
let client = null;

export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set for the dashboard.');
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
