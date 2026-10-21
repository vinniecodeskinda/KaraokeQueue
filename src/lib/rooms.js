// Room helpers shared by the entry, host and join pages.
//
// A room session lives in sessionStorage (see store.js): it survives a
// reload, but closing the tab/app ends it. Reopening the app means joining
// as a new person, and there is no "resume hosting" — if the host leaves,
// host passes to someone still in the room.
import { session } from './store.js';

const SESSION_KEY = 'karaoke.session';   // { [code]: { roomId, memberId, memberKey, joinedAt, hostKey? } }

// Clean up pre-session versions that kept these in localStorage forever.
try {
  ['karaoke.hosting', 'karaoke.memberships', 'karaoke.requests'].forEach((k) => localStorage.removeItem(k));
} catch {
  /* ignore */
}

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Shareable link guests open to join a room (also what the QR code encodes). */
export const joinUrl = (code) => new URL(`/join/?room=${encodeURIComponent(code)}`, location.origin).href;
export const hostUrl = (code) => `/host/?room=${encodeURIComponent(code)}`;

/** Room code from ?room=… on the current page. */
export const roomFromUrl = () => normalizeCode(new URLSearchParams(location.search).get('room'));

const all = () => session.get(SESSION_KEY, {});
const update = (code, patch) => {
  const sessions = all();
  sessions[code] = { ...sessions[code], ...patch };
  session.set(SESSION_KEY, sessions);
};

/** This tab's membership in `code`: { roomId, memberId, memberKey, joinedAt, hostKey? } or null. */
export const membershipFor = (code) => all()[code] ?? null;

export function rememberMembership(code, { roomId, memberId, memberKey }) {
  const existing = membershipFor(code);
  update(code, {
    roomId,
    memberId,
    memberKey,
    joinedAt: existing?.memberId === memberId ? existing.joinedAt : new Date().toISOString(),
  });
}

export function forgetMembership(code) {
  const sessions = all();
  delete sessions[code];
  session.set(SESSION_KEY, sessions);
}

/** Remember the host key for `code` in this tab (on create, or after taking over). */
export const rememberHostKey = (code, hostKey) => update(code, { hostKey });
export const forgetHostKey = (code) => update(code, { hostKey: null });

/** { id, hostKey } if this tab is the host of `code`, else null. */
export function hostingFor(code) {
  const s = membershipFor(code);
  return s?.hostKey ? { id: s.roomId, hostKey: s.hostKey } : null;
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
