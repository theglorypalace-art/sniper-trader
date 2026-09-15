const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = require('../config');

let client = null;

// Returns null (not a thrown error) when Supabase isn't configured, so the
// engine can still run in a purely local/static-config mode if you haven't
// set this up yet — live filters and the dashboard/Telegram feed just
// won't be available until you do.
function getSupabase() {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return client;
}

module.exports = { getSupabase };
