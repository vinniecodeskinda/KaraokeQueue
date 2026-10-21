// Host lifecycle, shared by the TV (host) page and the phone (join) page.
//
// - Whoever holds the room's host key sends a heartbeat every 10s. That's
//   what keeps the room open; the server treats a silent host as gone.
// - Everyone watches Realtime Presence. If nobody connected is the host,
//   the longest-present member asks to take over. The server only allows
//   that once the old host has been silent for 45s, and exactly one claim
//   wins. Others retry later as a fallback in case that member is idle.
import { claimHost, hostHeartbeat } from './queue-api.js';

const HEARTBEAT_MS = 10_000;
const CLAIM_CHECK_MS = 5_000;
const FALLBACK_STAGGER_MS = 20_000;

/** Start heartbeating as host. Calls onLost(err) once if host is lost. Returns stop(). */
export function startHeartbeat(roomId, hostKey, onLost) {
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    try {
      await hostHeartbeat(roomId, hostKey);
    } catch (err) {
      // Network blips are retried next beat; only a definite "not host" ends it.
      if (/no longer the host/i.test(err.message)) {
        stopped = true;
        clearInterval(timer);
        onLost(err);
      }
    }
  };
  const timer = setInterval(beat, HEARTBEAT_MS);
  beat();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Watch for a host-less room and try to take over.
 *   getState() → { people, memberId, memberKey } (people = presence list)
 *   onClaimed({ hostKey }) once this member becomes host.
 * Returns stop().
 */
export function watchForHostHandover(getState, onClaimed) {
  let hostlessSince = null;
  let claiming = false;
  const timer = setInterval(async () => {
    const { people, memberId, memberKey } = getState();
    if (!people.length || people.some((p) => p.is_host)) {
      hostlessSince = null;
      return;
    }
    hostlessSince ??= Date.now();
    // Longest-present member goes first; the rest wait their turn.
    const order = [...people].sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));
    const rank = Math.max(0, order.findIndex((p) => p.member_id === memberId));
    if (claiming || Date.now() - hostlessSince < rank * FALLBACK_STAGGER_MS) return;
    claiming = true;
    try {
      const { hostKey } = await claimHost(memberKey);
      clearInterval(timer);
      onClaimed({ hostKey });
    } catch {
      /* "The host is still here" (not 45s yet) or someone else won — keep watching */
    } finally {
      claiming = false;
    }
  }, CLAIM_CHECK_MS);
  return () => clearInterval(timer);
}
