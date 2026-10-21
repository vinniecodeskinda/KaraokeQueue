// All database access lives here so the host and guest views share one
// definition of "the queue". Every call is a single small request — the
// app never polls; live updates come from subscribeToQueue().
import { supabase } from './supabase.js';

const QUEUE_SELECT = `
  id, guest_name, status, created_at, started_at,
  song:songs ( id, title, artist, youtube_video_id )
`;

/** Active queue: the playing row (if any) first, then queued rows in order. */
export async function fetchActiveQueue() {
  const { data, error } = await supabase
    .from('queue')
    .select(QUEUE_SELECT)
    .in('status', ['playing', 'queued'])
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  const playing = data.find((r) => r.status === 'playing') ?? null;
  const upNext = data.filter((r) => r.status === 'queued');
  return { playing, upNext };
}

/** Search the catalog by title or artist. */
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

/** Guest requests a catalog song. Returns the new queue row id. */
export async function requestSong(songId, guestName) {
  const { data, error } = await supabase
    .from('queue')
    .insert({ song_id: songId, guest_name: guestName })
    .select('id')
    .single();
  if (error) throw friendly(error);
  return data.id;
}

/** Guest requests a YouTube search result that isn't in the catalog yet. */
export async function requestYoutubeSong({ videoId, title, artist }, guestName) {
  const { data, error } = await supabase.rpc('request_youtube_song', {
    p_video_id: videoId,
    p_title: title,
    p_artist: artist ?? '',
    p_guest_name: guestName,
  });
  if (error) throw friendly(error);
  return data;
}

/**
 * Host only: mark `finishedId` done (if given) and promote the next song.
 * Returns the id of the row now playing, or null when the queue is empty.
 */
export async function advanceQueue(finishedId = null, outcome = 'completed') {
  const { data, error } = await supabase.rpc('advance_queue', {
    p_finished_id: finishedId,
    p_outcome: outcome,
  });
  if (error) throw error;
  return data;
}

/** YouTube Data API fallback via our Pages Function (key stays server-side). */
export async function searchYoutube(term) {
  const res = await fetch(`/api/youtube-search?q=${encodeURIComponent(term)}`);
  if (res.status === 501 || res.status === 404) return { available: false, items: [] };
  if (!res.ok) throw new Error('YouTube search failed');
  const body = await res.json();
  return { available: true, items: body.items ?? [] };
}

/**
 * Subscribe to every change on the queue table. Calls `onChange()` (debounced)
 * so callers simply re-fetch — the queue is tiny, and this avoids subtle bugs
 * from patching local state with partial Realtime payloads.
 * Returns an unsubscribe function.
 */
export function subscribeToQueue(onChange, onStatus = () => {}) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 120);
  };
  const channel = supabase
    .channel('queue-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, fire)
    .subscribe((status) => {
      onStatus(status);
      // After a dropped connection comes back, resync anything we missed.
      if (status === 'SUBSCRIBED') fire();
    });
  return () => supabase.removeChannel(channel);
}

function friendly(error) {
  // Surface our trigger's human-readable messages (queue full, per-guest cap).
  return new Error(error.message || 'Something went wrong');
}
