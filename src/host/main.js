import QRCode from 'qrcode';
import '../styles/base.css';
import '../styles/host.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  findRoom,
  isDemo,
  joinRoom,
  kickMember,
  renameMember,
  requestSong,
  requestYoutubeSong,
  subscribeToRoom,
} from '../lib/queue-api.js';
import {
  forgetHostKey,
  hostingFor,
  joinUrl,
  membershipFor,
  rememberMembership,
  roomFromUrl,
  shareJoinLink,
} from '../lib/rooms.js';
import { startHeartbeat } from '../lib/host-session.js';
import { mountRemote, SPEEDS } from '../lib/remote.js';
import { isReaction } from '../lib/reactions.js';
import { ReactionField } from './reaction-field.js';
import { mountSongSearch } from '../lib/song-search.js';
import { currentName, promptName, saveName } from '../lib/name-dialog.js';
import { store } from '../lib/store.js';
import { createPlayer } from './youtube-player.js';
import { QueueController } from './queue-controller.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const COLLAPSED_KEY = 'karaoke.host.collapsed';

let room;
let hosting;      // { id, hostKey } — only in this tab's session
let me;           // { memberId, memberKey, name, joinedAt }
let live;         // { unsubscribe, track } for the room channel
let controller;   // created on "Start the party"
let player;
let stopHeartbeat = () => {};
let updateRemote = () => {};
let loadedRowId = null;      // queue row currently on screen
let resetSpeed = false;      // new song → back to normal speed once it starts
let intermission = null;     // { timer } while the up-next screen is showing
const INTERMISSION_SECONDS = 8;
let reactionField;           // physics sim for floating emoji (created on init)

if (isDemo) showDemoBanner();
init();

async function init() {
  const code = roomFromUrl();
  if (!code) {
    location.replace('/');
    return;
  }

  try {
    room = await findRoom(code);
  } catch (err) {
    return gate(`Couldn't reach the server: ${escapeHtml(err.message)}`);
  }
  if (!room) {
    return gate(`Room <b>${escapeHtml(code)}</b> doesn't exist.`, true);
  }
  if (!room.open) {
    return gate(`<b>${escapeHtml(room.name)}</b> has closed — everyone left.`, true);
  }

  // Host powers live only in the tab that created (or took over) the room.
  hosting = hostingFor(room.code);
  if (!hosting || hosting.id !== room.id) {
    return gate(
      `This screen isn't the host of <b>${escapeHtml(room.name)}</b>.<br />
       <a class="btn" href="/join/?room=${room.code}">Join as a guest</a>`,
      true,
    );
  }

  try {
    const session = membershipFor(room.code);
    const joined = await joinRoom(room.code, {
      name: currentName(),
      memberKey: session?.memberKey,
      hostKey: hosting.hostKey,
    });
    rememberMembership(room.code, { roomId: joined.room.id, memberId: joined.memberId, memberKey: joined.memberKey });
    me = {
      memberId: joined.memberId,
      memberKey: joined.memberKey,
      name: joined.name,
      joinedAt: membershipFor(room.code).joinedAt,
    };
    renderHostName(me.name);
  } catch (err) {
    return gate(`Couldn't open the room: ${escapeHtml(err.message)}`, true);
  }

  stopHeartbeat = startHeartbeat(room.id, hosting.hostKey, lostHost);

  showRoom();
  wireCollapse();

  $('host-name-btn').addEventListener('click', async () => {
    const wanted = await promptName({ title: 'Change your name' });
    try {
      me.name = saveName(await renameMember(me.memberKey, wanted));
      renderHostName(me.name);
      live.track({ name: me.name });
    } catch (err) {
      toast(err.message);
    }
  });

  mountSongSearch($('search'), {
    buttonLabel: 'Add',
    onError: toast,
    onRequest: async ({ kind, song }) => {
      try {
        if (kind === 'catalog') await requestSong(me.memberKey, song.id);
        else await requestYoutubeSong(me.memberKey, song);
        toast(`🎶 “${song.title}” added for ${me.name}`);
      } catch (err) {
        toast(err.message);
      }
    },
  });

  $('people').addEventListener('click', onKickClick);
  updateRemote = mountRemote($('tv-remote'), { onAction: applyAction, compact: true });
  updateRemote({ active: false });
  live = subscribeToRoom(
    room.id,
    {
      onQueue: () => controller?.refresh(),
      onPresence: renderPeople,
      // Phones' Remote tab: they send actions, and ask for state when opened.
      onBroadcast: (event, payload) => {
        if (event === 'control') applyAction(payload?.action);
        else if (event === 'hello') sendState();
        else if (event === 'react') floatReaction(payload);
      },
    },
    (status) => ($('conn').dataset.status = status),
    {
      key: me.memberId,
      payload: { member_id: me.memberId, name: me.name, is_host: true, joined_at: me.joinedAt },
    },
  );

  $('start-btn').addEventListener('click', start, { once: true });
  $('im-start').addEventListener('click', startNow);
  $('fs-btn').addEventListener('click', toggleFullscreen);
}

async function start() {
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading…';

  player = await createPlayer('player', {
    onEnded: () => controller?.handleEnded(),
    onError: (code, reason) => controller?.handleError(code, reason),
    onPlaying: () => {
      if (resetSpeed) {
        resetSpeed = false;
        player.setPlaybackRate(1);
      }
    },
    onChange: sendState,
  });

  controller = new QueueController({
    player,
    roomId: room.id,
    hostKey: hosting.hostKey,
    onChange: render,
    onNotice: toast,
    onNewSong: showIntermission,
  });

  // Controls are button-only: single-letter hotkeys on the TV are too easy to hit by accident.
  $('start-overlay')?.remove();
  await controller.refresh();
  sendState();
}

// ------------------------------------------------------------- remote

// ------------------------------------------------------------- up next

/** A new song is cued: show who's up, count down, then play. */
function showIntermission(row, upNext) {
  hideIntermission();
  $('im-singer').textContent = `🎤 ${row.guest_name}`;
  $('im-song').textContent = [row.song.title, row.song.artist].filter(Boolean).join(' — ');
  const then = upNext[0];
  $('im-then').textContent = then ? `Then: ${then.guest_name} — ${then.song.title}` : '';
  $('intermission').hidden = false;

  let left = INTERMISSION_SECONDS;
  $('im-count').textContent = left;
  intermission = {
    timer: setInterval(() => {
      left -= 1;
      $('im-count').textContent = left;
      if (left <= 0) startNow();
    }, 1000),
  };
  setTimeout(sendState, 300);
}

function hideIntermission() {
  if (intermission) clearInterval(intermission.timer);
  intermission = null;
  $('intermission').hidden = true;
}

/** End the countdown early (Start now / Play on any remote) or on time. */
function startNow() {
  if (!intermission) return;
  hideIntermission();
  player.playVideo();
}

// ------------------------------------------------------------- reactions

/** Float an emoji (with the sender's name) up the side of the TV. */
function floatReaction(payload) {
  if (!isReaction(payload?.emoji)) return;
  reactionField ??= new ReactionField($('reactions'));
  if (import.meta.env.DEV) window.__reactionField = reactionField;   // for testing
  reactionField.add(payload.emoji, payload.name);
}

/**
 * Fullscreen the whole TV page with the video filling it (sidebar hidden).
 * Looks like YouTube's fullscreen, but our overlays (reactions, up-next)
 * still show, which they can't inside YouTube's own fullscreen.
 */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen isn’t available here.'));
}
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === document.documentElement;
  $('app').classList.toggle('fs-mode', on);
  $('fs-btn').textContent = on ? '✕ Exit fullscreen' : '⛶ Fullscreen + reactions';
});

/** Apply a remote action (from the TV's own buttons or any phone). */
function applyAction(action) {
  // Show/hide the queue sidebar works any time, even before a song plays.
  if (action === 'queue') {
    setCollapsed(!$('app').classList.contains('collapsed'));
    return;
  }
  if (!player || !controller?.state.playing) return;
  // On the up-next screen, Play / Start over start the song now; Skip skips it.
  if (intermission && (action === 'toggle' || action === 'restart')) {
    startNow();
    return;
  }
  if (intermission && action === 'skip') hideIntermission();
  switch (action) {
    case 'restart':
      player.seekTo(0, true);
      player.playVideo();
      break;
    case 'toggle':
      if (isPlaying()) player.pauseVideo();
      else player.playVideo();
      break;
    case 'skip':
      controller.skip();
      break;
    case 'slower':
    case 'faster': {
      const rates = player.getAvailablePlaybackRates?.() ?? SPEEDS;
      const options = SPEEDS.filter((r) => rates.includes(r));
      const i = options.indexOf(player.getPlaybackRate());
      const next = options[Math.max(0, Math.min(options.length - 1, (i === -1 ? options.indexOf(1) : i) + (action === 'faster' ? 1 : -1)))];
      if (next) player.setPlaybackRate(next);
      break;
    }
    case 'mute':
      if (player.isMuted()) player.unMute();
      else player.mute();
      break;
    case 'voldown':
    case 'volup':
      player.unMute();
      player.setVolume(Math.max(0, Math.min(100, player.getVolume() + (action === 'volup' ? 10 : -10))));
      break;
    default:
      return;
  }
  // Volume/mute have no player event — report state once it has applied.
  setTimeout(sendState, 300);
}

const isPlaying = () => [1, 3].includes(player?.getPlayerState());   // playing or buffering

function playerState() {
  const tv = { tv: true, queueOpen: !$('app').classList.contains('collapsed') };
  if (!player || !controller?.state.playing) return { ...tv, active: false };
  return {
    ...tv,
    active: true,
    upNext: Boolean(intermission),
    playing: isPlaying(),
    rate: player.getPlaybackRate(),
    volume: Math.round(player.getVolume()),
    muted: player.isMuted(),
  };
}

/** Update the TV's buttons and tell every phone remote. */
function sendState() {
  const state = playerState();
  updateRemote(state);
  live?.send('state', state);
}

/** Host passed to someone else (this screen was offline too long). */
function lostHost() {
  hideIntermission();
  stopHeartbeat();
  forgetHostKey(room.code);
  try {
    player?.stopVideo();
  } catch {
    /* player not ready */
  }
  live?.unsubscribe();
  gate(
    `You're no longer the host of <b>${escapeHtml(room.name)}</b> — this screen was away too long,
     so someone else in the room took over.<br />
     <a class="btn" href="/join/?room=${room.code}">Rejoin as a guest</a>`,
    true,
  );
}

function render({ playing, upNext }) {
  if ((playing?.id ?? null) !== loadedRowId) {
    loadedRowId = playing?.id ?? null;
    resetSpeed = true;   // each singer starts at normal speed
    if (!playing) hideIntermission();
    setTimeout(sendState, 300);
  }
  $('idle').hidden = Boolean(playing);
  $('now-playing').hidden = !playing;
  if (playing) {
    $('np-guest').textContent = playing.guest_name;
    $('np-song').textContent = [playing.song.title, playing.song.artist].filter(Boolean).join(' — ');
  }

  $('up-next-count').textContent = upNext.length;
  $('pill-count').textContent = upNext.length;
  $('up-next').innerHTML = upNext.length
    ? upNext
        .map(
          (row) => `
          <li>
            <span class="song">${escapeHtml(row.song.title)}</span>
            <span class="meta">${row.song.artist ? `${escapeHtml(row.song.artist)} · ` : ''}<b>${escapeHtml(row.guest_name)}</b></span>
          </li>`,
        )
        .join('')
    : '<li class="empty">Queue is empty — add a song!</li>';
}

// ------------------------------------------------------------- people

/** Who's connected right now (Realtime Presence). */
function renderPeople(people) {
  $('people-count').textContent = people.length;
  $('people').innerHTML = people
    .map((p) => {
      const isMe = p.member_id === me.memberId;
      return `
      <li>
        <span class="person">${escapeHtml(p.name)}${p.is_host ? ' <span class="badge-host">host</span>' : ''}${isMe ? ' <span class="you">(you)</span>' : ''}</span>
        ${isMe ? '' : `<button type="button" class="secondary small kick" data-id="${p.member_id}" data-name="${escapeHtml(p.name)}">Remove</button>`}
      </li>`;
    })
    .join('');
}

async function onKickClick(e) {
  const btn = e.target.closest('.kick');
  if (!btn) return;
  if (!confirm(`Remove ${btn.dataset.name} from the party? Their waiting songs will be dropped.`)) return;
  btn.disabled = true;
  try {
    await kickMember(room.id, hosting.hostKey, btn.dataset.id);
    toast(`${btn.dataset.name} was removed.`);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

// ------------------------------------------------------------- room info

function renderHostName(name) {
  $('host-name').textContent = name;
}

function showRoom() {
  const { code, name } = room;
  const url = joinUrl(code);
  const site = new URL('/', url).host;
  for (const id of ['room-code', 'idle-code', 'pill-code', 'overlay-code']) $(id).textContent = code;
  for (const id of ['room-name', 'idle-name', 'overlay-name']) $(id).textContent = name;
  $('room-lock').hidden = !room.hasPassword;
  $('idle-site').textContent = site;
  document.title = `${name} — ${code}`;
  QRCode.toCanvas($('join-qr'), url, { width: 132, margin: 1 }).catch(console.error);
  $('copy-link').addEventListener('click', async () => {
    const how = await shareJoinLink(code);
    if (how === 'copied') toast('Join link copied — paste it in your group chat!');
  });
}

/** Sidebar collapse: player goes full width; a small pill brings it back. */
function setCollapsed(collapsed) {
  $('app').classList.toggle('collapsed', collapsed);
  $('show-sidebar').hidden = !collapsed;
  store.set(COLLAPSED_KEY, collapsed);
  sendState();   // phones' "Show/Hide queue" button follows along
}

function wireCollapse() {
  setCollapsed(store.get(COLLAPSED_KEY, false));
  $('collapse-btn').addEventListener('click', () => setCollapsed(true));
  $('show-sidebar').addEventListener('click', () => setCollapsed(false));
  document.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (e.key === 'q' || e.key === 'Q') setCollapsed(!$('app').classList.contains('collapsed'));
  });
}

function gate(html, withHome = false) {
  $('start-overlay')?.remove();
  $('gate').hidden = false;
  $('gate').innerHTML = `
    <div class="gate-card">
      <p>${html}</p>
      ${withHome ? '<a class="btn secondary" href="/">Back to start</a>' : ''}
    </div>`;
}

const isTyping = (e) => e.target.closest?.('input, textarea, [contenteditable]');

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}
