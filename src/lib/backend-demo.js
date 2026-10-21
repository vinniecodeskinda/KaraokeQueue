// Demo backend: same API as backend-supabase.js, but the catalog and queue
// live in this browser's localStorage and changes are broadcast to other
// tabs with BroadcastChannel. Open /host/ and / in two tabs of the same
// browser and they stay in sync — no Supabase project needed.
//
// Mirrors the rules in supabase/schema.sql (one 'playing' row, per-guest
// cap, idempotent advance) so the demo behaves like the real thing.

const SONGS = [
  { title: 'Never Gonna Give You Up', artist: 'Rick Astley', youtube_video_id: 'dQw4w9WgXcQ', tags: ['pop', '80s'] },
  { title: 'Bohemian Rhapsody', artist: 'Queen', youtube_video_id: 'fJ9rUzIMcZQ', tags: ['rock', '70s'] },
  { title: 'Despacito', artist: 'Luis Fonsi ft. Daddy Yankee', youtube_video_id: 'kJQP7kiw5Fk', tags: ['latin'] },
  { title: 'Gangnam Style', artist: 'PSY', youtube_video_id: '9bZkp7q19f0', tags: ['kpop'] },
  { title: 'Smells Like Teen Spirit', artist: 'Nirvana', youtube_video_id: 'hTWKbfoikeg', tags: ['rock', '90s'] },
  { title: 'Shape of You', artist: 'Ed Sheeran', youtube_video_id: 'JGwWNGJdvx8', tags: ['pop'] },
  { title: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars', youtube_video_id: 'OPf0YbXqDm0', tags: ['funk', 'pop'] },
  { title: 'See You Again', artist: 'Wiz Khalifa ft. Charlie Puth', youtube_video_id: 'RgKAFK5djSk', tags: ['hiphop'] },
].map((s) => ({ id: `demo-${s.youtube_video_id}`, ...s }));

const KEY = 'karaoke.demo.queue';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('karaoke-demo') : null;
const localListeners = new Set();
let memoryQueue = [];   // fallback when localStorage is unavailable

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return memoryQueue; }
}

function save(rows) {
  memoryQueue = rows;
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch { /* memory only */ }
  channel?.postMessage('changed');            // other tabs
  localListeners.forEach((fn) => fn());       // this tab
}

const withSong = (row) => ({ ...row, song: SONGS.find((s) => s.id === row.song_id) });
const tick = () => new Promise((r) => setTimeout(r, 60));   // feel like a network call

export async function fetchActiveQueue() {
  await tick();
  const rows = load()
    .filter((r) => r.status === 'playing' || r.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(withSong);
  return {
    playing: rows.find((r) => r.status === 'playing') ?? null,
    upNext: rows.filter((r) => r.status === 'queued'),
  };
}

export async function searchSongs(term, limit = 25) {
  await tick();
  const q = term.trim().toLowerCase();
  return SONGS.filter(
    (s) => !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q),
  )
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, limit);
}

export async function requestSong(songId, guestName) {
  await tick();
  const name = guestName.trim();
  const rows = load();
  const mine = rows.filter(
    (r) => r.status === 'queued' && r.guest_name.toLowerCase() === name.toLowerCase(),
  );
  if (mine.length >= 5) throw new Error('You already have 5 songs waiting. Let someone else sing!');
  const row = {
    id: crypto.randomUUID(),
    song_id: songId,
    guest_name: name,
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
  };
  save([...rows, row]);
  return row.id;
}

export async function requestYoutubeSong() {
  throw new Error('YouTube search isn’t available in demo mode.');
}

export async function advanceQueue(finishedId = null, outcome = 'completed') {
  await tick();
  const rows = load();
  const now = new Date().toISOString();
  if (finishedId) {
    const done = rows.find((r) => r.id === finishedId && r.status === 'playing');
    if (done) Object.assign(done, { status: outcome, finished_at: now });
  }
  const playing = rows.find((r) => r.status === 'playing');
  if (playing) return playing.id;
  const next = rows
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (next) Object.assign(next, { status: 'playing', started_at: now });
  // Keep only the last 50 finished rows so storage never grows unbounded.
  const finished = rows.filter((r) => r.status === 'completed' || r.status === 'skipped');
  const keep = new Set(finished.slice(-50));
  save(rows.filter((r) => !finished.includes(r) || keep.has(r)));
  return next?.id ?? null;
}

export async function searchYoutube() {
  return { available: false, items: [] };
}

export function subscribeToQueue(onChange, onStatus = () => {}) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 50);
  };
  channel?.addEventListener('message', fire);
  localListeners.add(fire);
  setTimeout(() => onStatus('SUBSCRIBED'), 0);
  return () => {
    channel?.removeEventListener('message', fire);
    localListeners.delete(fire);
  };
}
