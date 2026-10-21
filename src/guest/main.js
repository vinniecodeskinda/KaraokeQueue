import '../styles/base.css';
import '../styles/guest.css';
import { isConfigured, renderNotConfigured } from '../lib/supabase.js';
import {
  fetchActiveQueue,
  requestSong,
  requestYoutubeSong,
  searchSongs,
  searchYoutube,
  subscribeToQueue,
} from '../lib/queue-api.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);

// Per-phone conveniences. localStorage can throw (private mode), so guard it.
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

let guestName = store.get('karaoke.name', '');
let myRequestIds = new Set(store.get('karaoke.requests', []));
let catalogResults = [];
let ytResults = [];

if (!isConfigured) {
  renderNotConfigured($('app'));
} else {
  init();
}

function init() {
  renderNameChip();
  wireTabs();

  let debounce;
  $('search-input').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);   // keep request volume low on the free tier
  });
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    runSearch();
    $('search-input').blur();
  });

  $('results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-song-id]');
    if (btn) request({ kind: 'catalog', song: catalogResults.find((s) => s.id === btn.dataset.songId) });
  });
  $('yt-results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-video-id]');
    if (btn) request({ kind: 'youtube', song: ytResults.find((s) => s.videoId === btn.dataset.videoId) });
  });
  $('yt-search-btn').addEventListener('click', runYoutubeSearch);
  $('name-chip').addEventListener('click', async () => {
    const name = await askName(null);
    if (name) setName(name);
  });

  runSearch();
  refreshQueue();
  subscribeToQueue(refreshQueue);
}

// ------------------------------------------------------------- search

async function runSearch() {
  const term = $('search-input').value;
  $('yt-results').innerHTML = '';
  try {
    catalogResults = await searchSongs(term);
  } catch (err) {
    toast(err.message);
    return;
  }
  $('results').innerHTML = catalogResults.length
    ? catalogResults.map((s) => resultRow(s.title, s.artist, `data-song-id="${s.id}"`)).join('')
    : `<li class="empty">No songs match “${escapeHtml(term)}” in the catalog.</li>`;

  // Offer the YouTube fallback when the user has typed something.
  $('yt-fallback').hidden = term.trim().length < 2;
}

async function runYoutubeSearch() {
  const term = $('search-input').value.trim();
  if (!term) return;
  const btn = $('yt-search-btn');
  btn.disabled = true;
  btn.textContent = 'Searching YouTube…';
  try {
    const { available, items } = await searchYoutube(term);
    if (!available) {
      $('yt-results').innerHTML = '<li class="empty">YouTube search isn’t set up on this party.</li>';
      return;
    }
    ytResults = items;
    $('yt-results').innerHTML = items.length
      ? items
          .map((v) =>
            resultRow(v.title, v.channel, `data-video-id="${escapeHtml(v.videoId)}"`, v.thumbnail),
          )
          .join('')
      : '<li class="empty">Nothing found on YouTube either.</li>';
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search YouTube instead';
  }
}

function resultRow(title, artist, dataAttr, thumb) {
  return `
    <li class="result">
      ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : ''}
      <div class="info">
        <span class="title">${escapeHtml(title)}</span>
        <span class="artist">${escapeHtml(artist)}</span>
      </div>
      <button type="button" ${dataAttr}>Request</button>
    </li>`;
}

// ------------------------------------------------------------- request

async function request({ kind, song }) {
  if (!song) return;
  const name = await askName(song.title);
  if (!name) return;
  setName(name);

  try {
    const id =
      kind === 'catalog'
        ? await requestSong(song.id, name)
        : await requestYoutubeSong(song, name);
    myRequestIds.add(id);
    store.set('karaoke.requests', [...myRequestIds]);
    toast(`🎶 “${song.title}” added to the queue!`);
    refreshQueue();
  } catch (err) {
    toast(err.message);
  }
}

/** Show the name dialog, pre-filled with the remembered name. Resolves to a name or null. */
function askName(songTitle) {
  const dialog = $('name-dialog');
  $('name-dialog-song').textContent = songTitle ? `Requesting “${songTitle}”` : 'Change your name';
  $('name-submit').textContent = songTitle ? 'Request 🎶' : 'Save';
  $('name-input').value = guestName;
  dialog.returnValue = '';   // Esc keeps the previous returnValue otherwise
  dialog.showModal();
  $('name-input').focus();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const name = $('name-input').value.trim();
        resolve(dialog.returnValue === 'ok' && name ? name : null);
      },
      { once: true },
    );
  });
}

function setName(name) {
  guestName = name;
  store.set('karaoke.name', name);
  renderNameChip();
}

function renderNameChip() {
  $('name-chip').hidden = !guestName;
  $('name-chip').textContent = `👤 ${guestName}`;
}

// ------------------------------------------------------------- queue

async function refreshQueue() {
  let playing, upNext;
  try {
    ({ playing, upNext } = await fetchActiveQueue());
  } catch (err) {
    toast(err.message);
    return;
  }

  $('now-card').hidden = !playing;
  if (playing) {
    $('now-title').textContent = playing.song.title;
    $('now-meta').textContent = `${playing.song.artist} · sung by ${playing.guest_name}`;
  }

  $('queue-count').textContent = upNext.length;
  $('queue-list').innerHTML = upNext.length
    ? upNext
        .map(
          (row) => `
          <li class="${myRequestIds.has(row.id) ? 'mine' : ''}">
            <span class="title">${escapeHtml(row.song.title)}</span>
            <span class="artist">${escapeHtml(row.song.artist)} · ${escapeHtml(row.guest_name)}</span>
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
    store.set('karaoke.requests', kept);
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

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}
