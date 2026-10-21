import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.SUPABASE_URL;
const anonKey = import.meta.env.SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: false },          // no user accounts in this app
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

/** Small banner shown when running on the in-browser demo backend. */
export function showDemoBanner() {
  const el = document.createElement('div');
  el.className = 'demo-banner';
  el.innerHTML =
    '<b>Demo mode</b> · queue lives in this browser only. ' +
    'Set <code>SUPABASE_URL</code> + <code>SUPABASE_ANON_KEY</code> to go live.';
  document.body.append(el);
  document.body.classList.add('demo');
}
