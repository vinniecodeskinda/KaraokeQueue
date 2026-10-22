# Home Karaoke

Split-screen karaoke for a house party:

| URL                   | Who            | What                                                                 |
|-----------------------|----------------|----------------------------------------------------------------------|
| `/`                   | Everyone       | Landing page: **Host a party** (creates a room) or **Join** by typing a 5-character room code |
| `/host/?room=CODE`    | The TV         | YouTube player, room code + QR + "Copy join link", song search, collapsible "Up next" sidebar (button or **Q**), auto-advancing queue |
| `/join/?room=CODE`    | Guests' phones | The join link / QR target. Search, request songs, see how many songs are ahead of you |

No sign-in anywhere. Guests only need the code or link.

- **Sessions:** joining a room lasts until you close the app or tab. A reload keeps you in. Reopening the app later makes you a new person.
- **One host:** the database allows only one host per room. The host's screen checks in every 10 seconds.
  - If the host leaves (gone ~45s), the longest-present person still in the room becomes host automatically. They get Skip, Remove and an **Open TV player here** button.
  - If everyone leaves, the room closes after 2 minutes and is deleted. There's no "resume hosting".
- **Names:** each person picks a name once, on the landing page or in a one-time welcome box when they open a join link. Leave it blank and you get a singer pun like "Celine Dijon". After that, requests go straight through with no prompt.
- **Rooms:** an optional room name (default "<host>'s Room") and an optional password. Without a password, the room is open to anyone with the code.
- **People:** a live list of who's connected right now (Supabase Realtime Presence). The host can **Remove** anyone. Their waiting songs are dropped and that device can't rejoin.
- **Size:** up to 150 people per room. On Supabase's free plan, the real ceiling is about **200 open connections across all rooms at once**; every open phone or TV is one.
- **Search:** YouTube only, on both screens. It runs when you press Search or Enter. Each search uses YouTube API quota: about **100 searches/day** on the free tier, and repeated searches are cached for 7 days in Cloudflare Workers KV (binding `SEARCH_CACHE` in `wrangler.toml`). If searches run out, people see when they come back (midnight Pacific).
  - The **Prioritize karaoke versions** switch adds "karaoke" to the search and ranks karaoke/lyric versions first.
  - Songs people pick are still saved in the `songs` table, because the queue needs them, but there's no browsable catalog.
- **Playback controls:** on the TV sidebar and in every phone's **Remote** tab: Start over, Pause/Play, Skip, speed (0.5×–1.5×, resets to 1× for each new song), Mute, and Volume −/+. Phones also get **Show/Hide queue on TV**, and swiping left on the Remote tab opens the **Reactions** page (20 emoji that bounce up the TV and fade by mid-screen).
  - Phones send commands over Supabase Realtime Broadcast, and the TV reports its state back.
  - Key/pitch change isn't possible with YouTube embeds, because the audio can't be reached from the page. Searching for "lower key karaoke" versions is the workaround.

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
Google Cloud Console → enable **YouTube Data API v3** → Credentials → API key. Restrict it to that API. The free quota is 10,000 units/day, and each search costs 100, so you get about 100 searches/day. Results are cached for 7 days in Workers KV, and searches only run when someone taps **Search**.

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
This is a trust-your-guests app with no logins.

- **All changes go through server functions.** Guests can read songs, the queue and the member list, but every change goes through `SECURITY DEFINER` functions. Those functions check a per-device **member key** (to request songs) or the room's **host key** (to advance, skip or remove someone).
- **Keys stay private.** Guests can't read `rooms` or `member_keys`, so neither kind of key is ever readable by other guests.
- **Passwords** are stored as bcrypt hashes and checked when someone joins.
- **Removal is per device.** A removed person can't rejoin from that device. Someone who clears their browser data can rejoin as a new person, unless the room has a password; if that matters, set one.
- **Cleanup:** rooms idle for 2+ days are removed by `purge_old_queue()`.

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
