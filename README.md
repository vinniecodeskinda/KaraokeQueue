# Home Karaoke

Split-screen karaoke for a house party:

| URL                   | Who            | What                                                                 |
|-----------------------|----------------|----------------------------------------------------------------------|
| `/`                   | Everyone       | Landing page: **Host a party** (creates a room) or **Join** by typing a 5-character room code |
| `/host/?room=CODE`    | The TV         | YouTube player, room code + QR + "Copy join link", song search, collapsible "Up next" sidebar (button or **Q**), auto-advancing queue |
| `/join/?room=CODE`    | Guests' phones | The join link / QR target. Search, request songs, see how many songs are ahead of you |

No sign-in anywhere. Creating a room gives the host's device a secret host key, kept in its browser, so only that device can play or skip songs. Guests only need the code or link. Both screens have a **Prioritize karaoke versions** switch: it ranks karaoke/lyric versions first and adds "karaoke" to YouTube searches.

Built to run entirely on free tiers: **Cloudflare Pages** (static site + one Pages Function) and **Supabase** (Postgres + Realtime). There's no server to keep running.

## How it works

```
 phone (/)                         Supabase                          TV (/host/)
 ─────────                         ────────                          ───────────
 search ───── select songs ──────► songs
 request ──── insert ────────────► queue ── Realtime (WebSocket) ──► refresh()
                                     ▲                                   │
                                     └──── rpc advance_queue() ◄─── YouTube ENDED / error / skip
```

- **The database is the source of truth.** A unique index allows only one `queue` row with status `playing`. The host calls the `advance_queue()` RPC, which marks the finished row `completed` (or `skipped`) and promotes the oldest `queued` row in one transaction. Calling it twice is harmless, so two open TV tabs or a duplicate ENDED event can't skip songs.
- **No polling.** Both views subscribe to `postgres_changes` on `queue` and re-fetch the small active queue when it changes.
- **Videos that can't play are skipped.** If the uploader disabled embedding (YouTube errors 101/150) or the video is gone, the host skips it and shows a notice.
- **Guests only get the access they need.** Row Level Security lets the anon key read `songs` and `queue` and insert into `queue`. Nothing else, and a trigger caps the queue at 200 songs and 5 waiting songs per guest.

## Setup

### 0. Try it with zero setup (demo mode)
```bash
npm install
npm run dev
```
Without Supabase keys, the app uses an in-browser demo backend ([`src/lib/backend-demo.js`](src/lib/backend-demo.js)). Create a room in one tab and join it from another tab of the **same browser**. They stay in sync through `BroadcastChannel`. A yellow banner shows you're in demo mode. Phones on other devices won't sync in demo mode, because that needs Supabase.

### 1. Supabase (free tier)
1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the tables, policies, RPCs and Realtime publication, and seeds 4 demo songs.
3. **Project Settings → API**: copy the Project URL and the `anon` public key.

### 2. Run locally
```bash
npm install
cp .env.example .env    # fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm run dev
```
Open `http://localhost:5173/` and click **Create a room**. Then join from your phone with the room code, or scan the QR code. The phone must be on the same Wi-Fi; run `npm run dev -- --host` to expose the dev server to your LAN.

The YouTube fallback is a Pages Function, so plain `npm run dev` doesn't serve it. The guest UI just reports it as not set up. To test it locally, put `YOUTUBE_API_KEY=...` in `.dev.vars` and run `npx wrangler pages dev dist` after `npm run build`, or `npm run pages:dev`.

### 3. Deploy to Cloudflare Pages
1. Push this folder to a GitHub repo, then **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git**.
2. Build settings: framework preset **None**, build command `npm run build`, output directory `dist`.
3. **Settings → Environment variables** (Production *and* Preview):
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`: plain text. They're baked into the bundle at build time.
   - `YOUTUBE_API_KEY`: *Secret*, optional. Only the Pages Function reads it.
4. Redeploy after changing variables (they're read at build time).

### 4. Optional: YouTube Data API v3 key
Google Cloud Console → enable **YouTube Data API v3** → Credentials → API key. Restrict it to that API. The free quota is 10,000 units/day, and each search costs 100, so you get about 100 searches/day. Results are cached at the edge for 24h, and guests only search YouTube when they tap **Search YouTube instead**. Songs picked this way are added to the catalog, so the next guest finds them locally.

## Free-tier budget

| Limit (free)                               | Usage here |
|--------------------------------------------|------------|
| Supabase DB 500 MB                         | A few KB per party. Run `select purge_old_queue();` (or schedule it with pg_cron; see schema) to drop finished rows older than 2 days |
| Supabase Realtime 200 concurrent / 2M msgs per month | 1 connection per open screen; one message per queue change |
| Supabase pauses after 7 days idle          | Open the dashboard and click *Restore* before a party if it's been a while |
| Cloudflare Pages 500 builds/month, unlimited static requests | Static assets |
| Pages Functions 100k requests/day           | Only the YouTube fallback |

## Adding songs
Insert rows in the Supabase Table Editor, or with SQL:
```sql
insert into songs (title, artist, youtube_video_id, tags)
values ('Song', 'Artist', 'XXXXXXXXXXX', '{pop,english}');
```
The video ID is the 11 characters after `v=` in a YouTube URL. Karaoke or lyric versions work best. Check that they play when embedded.

## Security notes
This is a trust-your-guests app with no logins. Anyone with a room's code can request songs into that room. Only the device holding the room's host key can advance or skip; `advance_queue()` checks it. Guests can't read the `rooms` table, so host keys never leave the server. Rooms idle for 2+ days are removed by `purge_old_queue()`.

## Project layout
```
index.html                    landing page: host or join (/)
join/index.html               guest remote (/join/?room=CODE)
host/index.html               TV screen (/host/?room=CODE)
src/entry/main.js             create room / enter code
src/lib/supabase.js           client + env config
src/lib/queue-api.js          picks Supabase or demo backend
src/lib/backend-supabase.js   all DB calls + Realtime subscription
src/lib/backend-demo.js       in-browser demo backend
src/lib/rooms.js              room codes, join links, host keys on this device
src/lib/song-search.js        shared search widget + karaoke switch
src/lib/name-dialog.js        "Who's singing?" prompt
src/host/youtube-player.js    IFrame API loader/wrapper
src/host/queue-controller.js  queue ⇄ player state machine
src/host/main.js              TV UI
src/guest/main.js             phone UI
functions/api/youtube-search.js  Pages Function (YouTube fallback)
supabase/schema.sql           tables, RLS, RPCs, realtime, seed data
```
