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

/** Render a friendly setup message instead of a blank page. */
export function renderNotConfigured(root) {
  root.innerHTML = `
    <div class="setup-msg">
      <h1>Almost there 🎤</h1>
      <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code>
         (in <code>.env</code> locally, or in Cloudflare Pages environment variables),
         then rebuild.</p>
    </div>`;
}
