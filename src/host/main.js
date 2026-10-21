import QRCode from 'qrcode';
import '../styles/base.css';
import '../styles/host.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  fetchMembers,
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
  hostingFor,
  joinUrl,
  membershipFor,
  rememberMembership,
  roomFromUrl,
  shareJoinLink,
} from '../lib/rooms.js';
import { mountSongSearch } from '../lib/song-search.js';
import { currentName, promptName, saveName } from '../lib/name-dialog.js';
import { store } from '../lib/store.js';
import { createPlayer } from './youtube-player.js';
import { QueueController } from './queue-controller.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const COLLAPSED_KEY = 'karaoke.host.collapsed';

let room;
let hosting;
let me;           // this device's membership: { roomId, memberId, memberKey }
let controller;   // created on "Start the party"

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
    return gate(`Room <b>${escapeHtml(code)}</b> doesn't exist (rooms expire after 2 idle days).`, true);
  }

  hosting = hostingFor(room.code);
  if (!hosting || hosting.id !== room.id) {
    return gate(
      `This device isn't the host of room <b>${escapeHtml(room.code)}</b>.<br />
       <a class="btn" href="/join/?room=${room.code}">Join as a guest</a>`,
      true,
    );
  }

  // The host is a member too (that's who TV-added songs are credited to).
  // Rooms made before members existed get a host membership on first visit.
  try {
    const joined = await joinRoom(room.code, {
      name: currentName(),
      memberKey: membershipFor(room.code)?.memberKey,
      hostKey: hosting.hostKey,
    });
    me = { roomId: joined.room.id, memberId: joined.memberId, memberKey: joined.memberKey };
    rememberMembership(room.code, me);
    renderHostName(joined.name);
  } catch (err) {
    return gate(`Couldn't open the room: ${escapeHtml(err.message)}`, true);
  }

  showRoom();
  wireCollapse();

  $('host-name-btn').addEventListener('click', async () => {
    const wanted = await promptName({ title: 'Change your name' });
    try {
      renderHostName(saveName(await renameMember(me.memberKey, wanted)));
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
        toast(`🎶 “${song.title}” added for ${$('host-name').textContent}`);
      } catch (err) {
        toast(err.message);
      }
    },
  });

  $('people').addEventListener('click', onKickClick);
  refreshMembers();
  subscribeToRoom(
    room.id,
    { onQueue: () => controller?.refresh(), onMembers: refreshMembers },
    (status) => ($('conn').dataset.status = status),
  );

  $('start-btn').addEventListener('click', start, { once: true });
}

async function start() {
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading…';

  const player = await createPlayer('player', {
    onEnded: () => controller?.handleEnded(),
    onError: (code, reason) => controller?.handleError(code, reason),
  });

  controller = new QueueController({
    player,
    roomId: room.id,
    hostKey: hosting.hostKey,
    onChange: render,
    onNotice: toast,
  });

  // Skip is button-only: a single-letter hotkey on the TV is too easy to hit by accident.
  $('skip-btn').addEventListener('click', () => controller.skip());

  $('start-overlay').remove();
  await controller.refresh();
}

function render({ playing, upNext }) {
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

async function refreshMembers() {
  let members;
  try {
    members = await fetchMembers(room.id);
  } catch (err) {
    toast(err.message);
    return;
  }
  $('people-count').textContent = members.length;
  $('people').innerHTML = members
    .map(
      (m) => `
      <li>
        <span class="person">${escapeHtml(m.name)}${m.is_host ? ' <span class="badge-host">host</span>' : ''}</span>
        ${m.is_host ? '' : `<button type="button" class="secondary small kick" data-id="${m.id}" data-name="${escapeHtml(m.name)}">Remove</button>`}
      </li>`,
    )
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
function wireCollapse() {
  const setCollapsed = (collapsed) => {
    $('app').classList.toggle('collapsed', collapsed);
    $('show-sidebar').hidden = !collapsed;
    store.set(COLLAPSED_KEY, collapsed);
  };
  setCollapsed(store.get(COLLAPSED_KEY, false));
  $('collapse-btn').addEventListener('click', () => setCollapsed(true));
  $('show-sidebar').addEventListener('click', () => setCollapsed(false));
  document.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (e.key === 'q' || e.key === 'Q') setCollapsed(!$('app').classList.contains('collapsed'));
  });
}

function gate(html, withHome = false) {
  $('start-overlay').remove();
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
