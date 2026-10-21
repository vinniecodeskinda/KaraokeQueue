// Demo backend: same API as backend-supabase.js, but rooms, members,
// catalog and queue live in this browser's localStorage, and changes are
// broadcast to other tabs with BroadcastChannel. Open the host and join
// pages in two tabs of the same browser and they stay in sync — no
// Supabase project needed.
//
// Mirrors the rules in supabase/schema.sql (one 'playing' row per room,
// per-member cap, host/member key checks, passwords, kicking).
// Demo-only: passwords are kept in plain text in this browser.

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

const KEYS = { queue: 'karaoke.demo.queue', rooms: 'karaoke.demo.rooms', members: 'karaoke.demo.members' };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('karaoke-demo') : null;
const localListeners = new Set();
const memory = {};   // fallback when localStorage is unavailable

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? []; } catch { return memory[key] ?? []; }
}

function save(key, rows, notify = true) {
  memory[key] = rows;
  try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* memory only */ }
  if (!notify) return;
  channel?.postMessage(key);                  // other tabs
  localListeners.forEach((fn) => fn(key));    // this tab
}

const withSong = (row) => ({ ...row, song: SONGS.find((s) => s.id === row.song_id) });
const tick = () => new Promise((r) => setTimeout(r, 60));   // feel like a network call
const newKey = () => crypto.randomUUID().replace(/-/g, '');

function uniqueName(roomId, wanted, exceptId) {
  const base = (wanted?.trim() || 'Mystery Singer').slice(0, 36);
  const taken = new Set(
    load(KEYS.members)
      .filter((m) => m.room_id === roomId && !m.kicked && m.id !== exceptId)
      .map((m) => m.name.toLowerCase()),
  );
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

function addMember(roomId, name, isHost) {
  const member = {
    id: crypto.randomUUID(),
    room_id: roomId,
    name: uniqueName(roomId, name),
    is_host: isHost,
    kicked: false,
    joined_at: new Date().toISOString(),
    key: newKey(),
  };
  save(KEYS.members, [...load(KEYS.members), member]);
  return member;
}

const memberByKey = (key) => load(KEYS.members).find((m) => m.key === key);

export async function createRoom({ name, password, hostName }) {
  await tick();
  const rooms = load(KEYS.rooms);
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.some((r) => r.code === code));
  const room = {
    id: crypto.randomUUID(),
    code,
    name: (name?.trim() || `${(hostName?.trim() || 'Karaoke').slice(0, 40)}'s Room`).slice(0, 60),
    password: password || null,
    hostKey: newKey(),
  };
  save(KEYS.rooms, [...rooms, room], false);
  const host = addMember(room.id, hostName, true);
  return {
    id: room.id, code, name: room.name, hasPassword: Boolean(room.password), hostKey: room.hostKey,
    memberId: host.id, memberKey: host.key, memberName: host.name,
  };
}

export async function findRoom(code) {
  await tick();
  const room = load(KEYS.rooms).find((r) => r.code === code.trim().toUpperCase());
  return room ? { id: room.id, code: room.code, name: room.name, hasPassword: Boolean(room.password) } : null;
}

export async function joinRoom(code, { password, name, memberKey, hostKey } = {}) {
  await tick();
  const room = load(KEYS.rooms).find((r) => r.code === code.trim().toUpperCase());
  if (!room) throw new Error('Room not found');
  const info = { id: room.id, code: room.code, name: room.name };
  const existing = memberKey && memberByKey(memberKey);
  if (existing && existing.room_id === room.id) {
    if (existing.kicked) throw new Error('You were removed from this party by the host.');
    return { room: info, memberId: existing.id, memberKey, name: existing.name, isHost: existing.is_host };
  }
  const isHost = Boolean(hostKey) && hostKey === room.hostKey;
  if (room.password && !isHost) {
    if (!password) throw new Error('This room needs a password');
    if (password !== room.password) throw new Error('Wrong password');
  }
  const m = addMember(room.id, name, isHost);
  return { room: info, memberId: m.id, memberKey: m.key, name: m.name, isHost };
}

export async function renameMember(memberKey, name) {
  await tick();
  const members = load(KEYS.members);
  const me = members.find((m) => m.key === memberKey && !m.kicked);
  if (!me) throw new Error('You are not in this room');
  me.name = uniqueName(me.room_id, name, me.id);
  save(KEYS.members, members);
  return me.name;
}

export async function fetchMembers(roomId) {
  await tick();
  return load(KEYS.members)
    .filter((m) => m.room_id === roomId && !m.kicked)
    .sort((a, b) => b.is_host - a.is_host || a.joined_at.localeCompare(b.joined_at))
    .map(({ id, name, is_host, joined_at }) => ({ id, name, is_host, joined_at }));
}

export async function kickMember(roomId, hostKey, memberId) {
  await tick();
  const room = load(KEYS.rooms).find((r) => r.id === roomId);
  if (!room || room.hostKey !== hostKey) throw new Error('Only the host can remove people');
  const members = load(KEYS.members);
  const target = members.find((m) => m.id === memberId && m.room_id === roomId && !m.is_host);
  if (!target) return;
  target.kicked = true;
  save(KEYS.members, members);
  const queue = load(KEYS.queue);
  queue.forEach((r) => {
    if (r.member_id === memberId && r.status === 'queued') Object.assign(r, { status: 'skipped' });
  });
  save(KEYS.queue, queue);
}

export async function fetchActiveQueue(roomId) {
  await tick();
  const rows = load(KEYS.queue)
    .filter((r) => r.room_id === roomId && (r.status === 'playing' || r.status === 'queued'))
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

export async function requestSong(memberKey, songId) {
  await tick();
  const me = memberByKey(memberKey);
  if (!me) throw new Error('Join the room before requesting songs');
  if (me.kicked) throw new Error('You were removed from this party by the host.');
  const rows = load(KEYS.queue);
  const mine = rows.filter((r) => r.room_id === me.room_id && r.status === 'queued' && r.member_id === me.id);
  if (mine.length >= 5) throw new Error('You already have 5 songs waiting. Let someone else sing!');
  const row = {
    id: crypto.randomUUID(),
    room_id: me.room_id,
    song_id: songId,
    guest_name: me.name,
    member_id: me.id,
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
  };
  save(KEYS.queue, [...rows, row]);
  return row.id;
}

export async function requestYoutubeSong() {
  throw new Error('YouTube search isn’t available in demo mode.');
}

export async function advanceQueue(roomId, hostKey, finishedId = null, outcome = 'completed') {
  await tick();
  const room = load(KEYS.rooms).find((r) => r.id === roomId);
  if (!room || room.hostKey !== hostKey) throw new Error('Only the host can control this room');
  const rows = load(KEYS.queue);
  const now = new Date().toISOString();
  const inRoom = rows.filter((r) => r.room_id === roomId);
  if (finishedId) {
    const done = inRoom.find((r) => r.id === finishedId && r.status === 'playing');
    if (done) Object.assign(done, { status: outcome, finished_at: now });
  }
  const playing = inRoom.find((r) => r.status === 'playing');
  if (playing) return playing.id;
  const next = inRoom
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (next) Object.assign(next, { status: 'playing', started_at: now });
  // Keep only the last 50 finished rows so storage never grows unbounded.
  const finished = rows.filter((r) => r.status === 'completed' || r.status === 'skipped');
  const keep = new Set(finished.slice(-50));
  save(KEYS.queue, rows.filter((r) => !finished.includes(r) || keep.has(r)));
  return next?.id ?? null;
}

export async function searchYoutube() {
  return { available: false, items: [] };
}

export function subscribeToRoom(roomId, { onQueue = () => {}, onMembers = () => {} }, onStatus = () => {}) {
  const timers = {};
  const fire = (key) => {
    const fn = key === KEYS.members ? onMembers : key === KEYS.queue ? onQueue : null;
    if (!fn) return;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, 50);
  };
  const onMessage = (e) => fire(e.data);
  channel?.addEventListener('message', onMessage);
  localListeners.add(fire);
  setTimeout(() => onStatus('SUBSCRIBED'), 0);
  return () => {
    channel?.removeEventListener('message', onMessage);
    localListeners.delete(fire);
  };
}
