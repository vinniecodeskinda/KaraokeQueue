import QRCode from 'qrcode';
import '../styles/base.css';
import '../styles/host.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  findRoom,
  isDemo,
  requestSong,
  requestYoutubeSong,
  subscribeToQueue,
} from '../lib/queue-api.js';
import { hostingFor, joinUrl, roomFromUrl, shareJoinLink } from '../lib/rooms.js';
import { mountSongSearch } from '../lib/song-search.js';
import { currentName, promptName } from '../lib/name-dialog.js';
import { store } from '../lib/store.js';
import { createPlayer } from './youtube-player.js';
import { QueueController } from './queue-controller.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const COLLAPSED_KEY = 'karaoke.host.collapsed';

if (isDemo) showDemoBanner();
init();

async function init() {
  const code = roomFromUrl();
  if (!code) {
    location.replace('/');
    return;
  }

  let room;
  try {
    room = await findRoom(code);
  } catch (err) {
    return gate(`Couldn't reach the server: ${escapeHtml(err.message)}`);
  }
  if (!room) {
    return gate(`Room <b>${escapeHtml(code)}</b> doesn't exist (rooms expire after 2 idle days).`, true);
  }

  const hosting = hostingFor(room.code);
  if (!hosting || hosting.id !== room.id) {
    return gate(
      `This device isn't the host of room <b>${escapeHtml(room.code)}</b>.<br />
       <a class="btn" href="/join/?room=${room.code}">Join as a guest</a>`,
      true,
    );
  }

  showRoom(room.code);
  wireCollapse();

  // Songs added from the TV go in under the host's name (set on the landing page).
  const renderHostName = () => ($('host-name').textContent = currentName());
  renderHostName();
  $('host-name-btn').addEventListener('click', async () => {
    await promptName({ title: 'Change your name' });
    renderHostName();
  });
  mountSongSearch($('search'), {
    buttonLabel: 'Add',
    onError: toast,
    onRequest: async ({ kind, song }) => {
      const name = currentName();
      try {
        if (kind === 'catalog') await requestSong(room.id, song.id, name);
        else await requestYoutubeSong(room.id, song, name);
        toast(`🎶 “${song.title}” added for ${name}`);
      } catch (err) {
        toast(err.message);
      }
    },
  });

  $('start-btn').addEventListener('click', () => start(room, hosting.hostKey), { once: true });
}

async function start(room, hostKey) {
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading…';

  let controller;
  const player = await createPlayer('player', {
    onEnded: () => controller?.handleEnded(),
    onError: (code, reason) => controller?.handleError(code, reason),
  });

  controller = new QueueController({
    player,
    roomId: room.id,
    hostKey,
    onChange: render,
    onNotice: toast,
  });

  subscribeToQueue(
    room.id,
    () => controller.refresh(),
    (status) => ($('conn').dataset.status = status),
  );

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

function showRoom(code) {
  const url = joinUrl(code);
  const site = new URL('/', url).host;
  for (const id of ['room-code', 'idle-code', 'pill-code', 'overlay-code']) $(id).textContent = code;
  $('idle-site').textContent = site;
  document.title = `Karaoke — Room ${code}`;
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
