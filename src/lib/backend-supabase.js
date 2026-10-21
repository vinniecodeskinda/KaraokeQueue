// Supabase-backed implementation of the queue API (see queue-api.js).
// Reads go straight to tables; every write is an RPC that checks the
// caller's member key / host key (see supabase/schema.sql). The app never
// polls — live updates come from subscribeToRoom().
import { supabase } from './supabase.js';

const QUEUE_SELECT = `
  id, guest_name, member_id, status, created_at, started_at,
  song:songs ( id, title, artist, youtube_video_id )
`;

/**
 * Create a room. Returns { id, code, name, hasPassword, hostKey, memberId,
 * memberKey, memberName } — hostKey and memberKey stay on this device.
 */
export async function createRoom({ name, password, hostName }) {
  const { data, error } = await supabase.rpc('create_room', {
    p_name: name ?? '',
    p_password: password ?? '',
    p_host_name: hostName ?? '',
  });
  if (error) throw friendly(error);
  return {
    id: data.id,
    code: data.code,
    name: data.name,
    hasPassword: data.has_password,
    hostKey: data.host_key,
    memberId: data.member_id,
    memberKey: data.member_key,
    memberName: data.member_name,
  };
}

/** Public room info by code: { id, code, name, hasPassword } or null. */
export async function findRoom(code) {
  const { data, error } = await supabase.rpc('get_room', { p_code: code });
  if (error) throw friendly(error);
  return data ? { id: data.id, code: data.code, name: data.name, hasPassword: data.has_password } : null;
}

/**
 * Join a room (or re-enter with this device's member key). Returns
 * { room: {id, code, name}, memberId, memberKey, name, isHost }.
 */
export async function joinRoom(code, { password, name, memberKey, hostKey } = {}) {
  const { data, error } = await supabase.rpc('join_room', {
    p_code: code,
    p_password: password ?? null,
    p_name: name ?? null,
    p_member_key: memberKey ?? null,
    p_host_key: hostKey ?? null,
  });
  if (error) throw friendly(error);
  return {
    room: data.room,
    memberId: data.member_id,
    memberKey: data.member_key,
    name: data.name,
    isHost: data.is_host,
  };
}

/** Change this member's display name; returns the name actually used. */
export async function renameMember(memberKey, name) {
  const { data, error } = await supabase.rpc('rename_member', { p_member_key: memberKey, p_name: name });
  if (error) throw friendly(error);
  return data;
}

/** Everyone currently in the room (kicked members excluded), host first. */
export async function fetchMembers(roomId) {
  const { data, error } = await supabase
    .from('members')
    .select('id, name, is_host, joined_at')
    .eq('room_id', roomId)
    .eq('kicked', false)
    .order('is_host', { ascending: false })
    .order('joined_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return data;
}

/** Host only: remove someone from the room and drop their waiting songs. */
export async function kickMember(roomId, hostKey, memberId) {
  const { error } = await supabase.rpc('kick_member', {
    p_room_id: roomId,
    p_host_key: hostKey,
    p_member_id: memberId,
  });
  if (error) throw friendly(error);
}

/** Active queue for a room: the playing row (if any) and queued rows in order. */
export async function fetchActiveQueue(roomId) {
  const { data, error } = await supabase
    .from('queue')
    .select(QUEUE_SELECT)
    .eq('room_id', roomId)
    .in('status', ['playing', 'queued'])
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  const playing = data.find((r) => r.status === 'playing') ?? null;
  const upNext = data.filter((r) => r.status === 'queued');
  return { playing, upNext };
}

/** Search the shared catalog by title or artist. */
export async function searchSongs(term, limit = 25) {
  const q = term.trim();
  let query = supabase
    .from('songs')
    .select('id, title, artist, youtube_video_id, tags')
    .order('title')
    .limit(limit);
  if (q) {
    // Drop characters that are meaningful inside a PostgREST or() filter or
    // act as LIKE wildcards; they never matter for a song search.
    const safe = q.replace(/[%_*,.()"\\:]/g, ' ').replace(/\s+/g, ' ').trim();
    if (safe) query = query.or(`title.ilike.*${safe}*,artist.ilike.*${safe}*`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** Request a catalog song as this member. Returns the new queue row id. */
export async function requestSong(memberKey, songId) {
  const { data, error } = await supabase.rpc('request_song', {
    p_member_key: memberKey,
    p_song_id: songId,
  });
  if (error) throw friendly(error);
  return data;
}

/** Request a YouTube search result that isn't in the catalog yet. */
export async function requestYoutubeSong(memberKey, { videoId, title, artist, channel }) {
  const { data, error } = await supabase.rpc('request_youtube_song', {
    p_member_key: memberKey,
    p_video_id: videoId,
    p_title: title,
    p_artist: artist ?? channel ?? '',   // search results carry the uploader as `channel`
  });
  if (error) throw friendly(error);
  return data;
}

/**
 * Host only: mark `finishedId` done (if given) and promote the next song.
 * Returns the id of the row now playing, or null when the queue is empty.
 */
export async function advanceQueue(roomId, hostKey, finishedId = null, outcome = 'completed') {
  const { data, error } = await supabase.rpc('advance_queue', {
    p_room_id: roomId,
    p_host_key: hostKey,
    p_finished_id: finishedId,
    p_outcome: outcome,
  });
  if (error) throw friendly(error);
  return data;
}

/** YouTube Data API fallback via our Pages Function (key stays server-side). */
export async function searchYoutube(term, { karaoke = true } = {}) {
  const params = new URLSearchParams({ q: term, karaoke: karaoke ? '1' : '0' });
  let res;
  try {
    res = await fetch(`/api/youtube-search?${params}`);
  } catch {
    return { available: false, items: [] };
  }
  // In plain `vite dev` there is no Functions runtime: treat as not set up.
  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!isJson || res.status === 501 || res.status === 404) return { available: false, items: [] };
  if (!res.ok) throw new Error('YouTube search is unavailable right now');
  const body = await res.json();
  return { available: true, items: body.items ?? [] };
}

/**
 * Subscribe to one room's queue and member changes. Callbacks are debounced
 * and callers simply re-fetch — the data is tiny, and this avoids subtle
 * bugs from patching local state with partial Realtime payloads.
 * Returns an unsubscribe function.
 */
export function subscribeToRoom(roomId, { onQueue = () => {}, onMembers = () => {} }, onStatus = () => {}) {
  const debounce = (fn, ms = 120) => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };
  const queueChanged = debounce(onQueue);
  const membersChanged = debounce(onMembers);
  const filter = `room_id=eq.${roomId}`;
  const channel = supabase
    .channel(`room-${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue', filter }, queueChanged)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members', filter }, membersChanged)
    .subscribe((status) => {
      onStatus(status);
      // After a dropped connection comes back, resync anything we missed.
      if (status === 'SUBSCRIBED') {
        queueChanged();
        membersChanged();
      }
    });
  return () => supabase.removeChannel(channel);
}

function friendly(error) {
  // Surface our functions' human-readable messages (wrong password, kicked, caps).
  return new Error(error.message || 'Something went wrong');
}
