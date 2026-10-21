// Song search widget shared by the host (TV) and join (phone) pages.
//
// Searches YouTube only (through our Pages Function, which keeps the API
// key server-side). Each search costs YouTube API quota — about 100
// searches/day on the free tier, with results cached for 24h — so it runs
// when you press Enter or the Search button, not on every keystroke.
// The "Prioritize karaoke" switch adds "karaoke" to the query and ranks
// karaoke/lyric versions first. It is remembered per device.
import { searchYoutube } from './queue-api.js';
import { escapeHtml } from './dom.js';
import { store } from './store.js';

const PREF_KEY = 'karaoke.preferKaraoke';
const KARAOKE_RE = /karaoke|instrumental|sing[- ]?along|lyrics/i;

export const isKaraokeVersion = (song) =>
  (song.tags ?? []).includes('karaoke') || KARAOKE_RE.test(song.title);

/**
 * @param {HTMLElement} root  container to render into
 * @param {object} opts
 * @param {(req: {kind: 'youtube', song: object}) => Promise<void>} opts.onRequest
 * @param {(msg: string) => void} opts.onError
 * @param {string} [opts.buttonLabel]
 */
export function mountSongSearch(root, { onRequest, onError, buttonLabel = 'Request' }) {
  let preferKaraoke = store.get(PREF_KEY, true);
  let results = [];
  let lastTerm = '';

  root.classList.add('song-search');
  root.innerHTML = `
    <form class="search" role="search">
      <input type="search" placeholder="Search YouTube for a song…" autocomplete="off"
             enterkeyhint="search" aria-label="Search YouTube" />
      <button type="submit" class="search-btn">Search</button>
    </form>
    <label class="switch">
      <input type="checkbox" role="switch" ${preferKaraoke ? 'checked' : ''} />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      <span class="switch-label">Prioritize karaoke versions</span>
    </label>
    <ul class="results"></ul>`;

  const input = root.querySelector('input[type=search]');
  const toggle = root.querySelector('input[role=switch]');
  const list = root.querySelector('.results');
  const searchBtn = root.querySelector('.search-btn');

  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    run();
    input.blur();
  });
  toggle.addEventListener('change', () => {
    preferKaraoke = toggle.checked;
    store.set(PREF_KEY, preferKaraoke);
    if (lastTerm) run();   // re-query with/without "karaoke"
  });

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-idx]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await onRequest({ kind: 'youtube', song: results[Number(btn.dataset.idx)] });
    } finally {
      btn.disabled = false;
    }
  });

  async function run() {
    const term = input.value.trim();
    if (term.length < 2) {
      input.focus();
      return;
    }
    lastTerm = term;
    searchBtn.disabled = true;
    list.innerHTML = '<li class="empty">Searching YouTube…</li>';
    try {
      const { available, items } = await searchYoutube(term, { karaoke: preferKaraoke });
      if (!available) {
        list.innerHTML = '<li class="empty">YouTube search isn’t set up (needs YOUTUBE_API_KEY).</li>';
        return;
      }
      results = preferKaraoke
        ? [...items].sort((a, b) => isKaraokeVersion(b) - isKaraokeVersion(a))
        : items;
      list.innerHTML = results.length
        ? results.map((v, i) => row(v, i)).join('')
        : `<li class="empty">No results for “${escapeHtml(term)}”.</li>`;
    } catch (err) {
      list.innerHTML = '';
      onError(err.message);
    } finally {
      searchBtn.disabled = false;
    }
  }

  function row(v, idx) {
    const badge = preferKaraoke && isKaraokeVersion(v) ? '<span class="tag">🎤 karaoke</span>' : '';
    return `
      <li class="result">
        ${v.thumbnail ? `<img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />` : ''}
        <div class="info">
          <span class="title">${escapeHtml(v.title)}</span>
          <span class="artist">${badge}${escapeHtml(v.channel)}</span>
        </div>
        <button type="button" data-idx="${idx}">${escapeHtml(buttonLabel)}</button>
      </li>`;
  }

  list.innerHTML = '<li class="empty">Type a song or artist and press Search.</li>';
  return { focus: () => input.focus() };
}
