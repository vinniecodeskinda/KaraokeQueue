import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Expose SUPABASE_URL / SUPABASE_ANON_KEY to the browser bundle as
  // import.meta.env.SUPABASE_*. The anon key is designed to be public;
  // Row Level Security in supabase/schema.sql is what protects the data.
  // YOUTUBE_API_KEY is deliberately NOT exposed — it lives only in the
  // Cloudflare Pages Function (functions/api/youtube-search.js).
  envPrefix: ['SUPABASE_'],
  build: {
    rollupOptions: {
      input: {
        guest: resolve(__dirname, 'index.html'),
        host: resolve(__dirname, 'host/index.html'),
      },
    },
  },
  server: {
    // In dev, forward /api/* to `wrangler pages dev` if you run it on 8788.
    proxy: { '/api': 'http://localhost:8788' },
  },
});
