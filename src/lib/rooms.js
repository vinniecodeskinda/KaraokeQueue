// Room helpers shared by the entry, host and join pages.
import { store } from './store.js';

const HOSTING_KEY = 'karaoke.hosting';   // { [code]: { id, hostKey, createdAt } }

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Shareable link guests open to join a room (also what the QR code encodes). */
export const joinUrl = (code) => new URL(`/join/?room=${encodeURIComponent(code)}`, location.origin).href;
export const hostUrl = (code) => `/host/?room=${encodeURIComponent(code)}`;

/** Room code from ?room=… on the current page. */
export const roomFromUrl = () => normalizeCode(new URLSearchParams(location.search).get('room'));

/** Remember that this device hosts `room` (the host key never leaves it). */
export function rememberHosting(room) {
  const all = store.get(HOSTING_KEY, {});
  all[room.code] = { id: room.id, hostKey: room.hostKey, createdAt: Date.now() };
  // Keep the 5 most recent rooms only.
  const recent = Object.entries(all)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, 5);
  store.set(HOSTING_KEY, Object.fromEntries(recent));
}

// Rooms this device has joined: { [code]: { roomId, memberId, memberKey } }.
// The member key is what lets this device request songs (and get kicked).
const MEMBERSHIPS_KEY = 'karaoke.memberships';

export function membershipFor(code) {
  return store.get(MEMBERSHIPS_KEY, {})[code] ?? null;
}

export function rememberMembership(code, { roomId, memberId, memberKey }) {
  const all = store.get(MEMBERSHIPS_KEY, {});
  all[code] = { roomId, memberId, memberKey, at: Date.now() };
  // Keep the 20 most recent rooms only.
  const recent = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
  store.set(MEMBERSHIPS_KEY, Object.fromEntries(recent));
}

export function forgetMembership(code) {
  const all = store.get(MEMBERSHIPS_KEY, {});
  delete all[code];
  store.set(MEMBERSHIPS_KEY, all);
}

/** { id, hostKey } if this device hosts `code`, else null. */
export function hostingFor(code) {
  return store.get(HOSTING_KEY, {})[code] ?? null;
}

/** Rooms this device has hosted, newest first: [{ code, id, hostKey, createdAt }]. */
export function hostedRooms() {
  return Object.entries(store.get(HOSTING_KEY, {}))
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Copy (or natively share on phones) a room's join link. */
export async function shareJoinLink(code) {
  const url = joinUrl(code);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Join my karaoke room', text: `Room code ${code}`, url });
      return 'shared';
    } catch {
      /* cancelled — fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    prompt('Copy this join link:', url);
    return 'prompted';
  }
}
