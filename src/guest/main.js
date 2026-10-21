import '../styles/base.css';
import '../styles/guest.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  isDemo,
  fetchActiveQueue,
  findRoom,
  requestSong,
  requestYoutubeSong,
  subscribeToQueue,
} from '../lib/queue-api.js';
import { roomFromUrl, shareJoinLink } from '../lib/rooms.js';
import { mountSongSearch } from '../lib/song-search.js';
import { askName, savedName } from '../lib/name-dialog.js';
import { store } from '../lib/store.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const REQUESTS_KEY = 'karaoke.requests';

let room;
let myRequestIds = new Set(store.get(REQUESTS_KEY, []));

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
    return gate(`There's no room called <b>${escapeHtml(code)}</b>. Check the code on the TV.`);
  }

  $('room-code').textContent = room.code;
  document.title = `Karaoke — Room ${room.code}`;
  $('room-chip').addEventListener('click', async () => {
    const how = await shareJoinLink(room.code);
    if (how === 'copied') toast('Join link copied — send it to your friends!');
  });

  renderNameChip();
  $('name-chip').addEventListener('click', async () => {
    if (await askName(null)) renderNameChip();
  });
  wireTabs();

  mountSongSearch($('search'), { onRequest: request, onError: toast });

  refreshQueue();
  subscribeToQueue(room.id, refreshQueue);
}

// ------------------------------------------------------------- request

async function request({ kind, song }) {
  const name = await askName(song.title);
  if (!name) return;
  renderNameChip();
  try {
    const id =
      kind === 'catalog'
        ? await requestSong(room.id, song.id, name)
        : await requestYoutubeSong(room.id, song, name);
    myRequestIds.add(id);
    store.set(REQUESTS_KEY, [...myRequestIds]);
    toast(`🎶 “${song.title}” added to the queue!`);
    refreshQueue();
  } catch (err) {
    toast(err.message);
  }
}

function renderNameChip() {
  const name = savedName();
  $('name-chip').hidden = !name;
  $('name-chip').textContent = `👤 ${name}`;
}

// ------------------------------------------------------------- queue

async function refreshQueue() {
  let playing, upNext;
  try {
    ({ playing, upNext } = await fetchActiveQueue(room.id));
  } catch (err) {
    toast(err.message);
    return;
  }

  $('now-card').hidden = !playing;
  if (playing) {
    $('now-title').textContent = playing.song.title;
    $('now-meta').textContent = [playing.song.artist, `sung by ${playing.guest_name}`].filter(Boolean).join(' · ');
  }

  $('queue-count').textContent = upNext.length;
  $('queue-list').innerHTML = upNext.length
    ? upNext
        .map(
          (row) => `
          <li class="${myRequestIds.has(row.id) ? 'mine' : ''}">
            <span class="title">${escapeHtml(row.song.title)}</span>
            <span class="artist">${row.song.artist ? `${escapeHtml(row.song.artist)} · ` : ''}${escapeHtml(row.guest_name)}</span>
          </li>`,
        )
        .join('')
    : '<li class="empty">The queue is empty. Be the first!</li>';

  renderMyStatus(playing, upNext);
}

/** "You're up next" / "3 songs ahead of you" for this phone's own requests. */
function renderMyStatus(playing, upNext) {
  const el = $('my-status');
  if (playing && myRequestIds.has(playing.id)) {
    el.hidden = false;
    el.className = 'my-status now';
    el.textContent = '🎤 You’re on! Grab the mic.';
    return;
  }
  const position = upNext.findIndex((row) => myRequestIds.has(row.id));
  if (position === -1) {
    el.hidden = true;
    pruneOldRequests(playing, upNext);
    return;
  }
  const ahead = position + (playing ? 1 : 0);
  el.hidden = false;
  el.className = 'my-status';
  el.textContent =
    ahead === 0 ? '⏭ You’re up next!' : `⏳ ${ahead} song${ahead === 1 ? '' : 's'} ahead of you`;
}

/** Forget request ids that are no longer active so localStorage stays small. */
function pruneOldRequests(playing, upNext) {
  const active = new Set([playing?.id, ...upNext.map((r) => r.id)]);
  const kept = [...myRequestIds].filter((id) => active.has(id));
  if (kept.length !== myRequestIds.size) {
    myRequestIds = new Set(kept);
    store.set(REQUESTS_KEY, kept);
  }
}

// ------------------------------------------------------------- ui bits

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) =>
        t.setAttribute('aria-selected', String(t === tab)),
      );
      document.querySelectorAll('.panel').forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
    }),
  );
}

function gate(html) {
  $('gate').hidden = false;
  $('gate').innerHTML = `
    <div class="gate-card">
      <p>${html}</p>
      <a class="btn" href="/">Enter a different code</a>
    </div>`;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}
