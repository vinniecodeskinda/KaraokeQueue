// Song search widget shared by the host (TV) and join (phone) pages.
//
// - Typing searches the free Supabase catalog (debounced).
// - Enter, or "Search YouTube", also queries the YouTube fallback. That
//   costs API quota, so it only runs on an explicit action.
// - The "Prioritize karaoke" switch ranks karaoke/lyric versions first in
//   catalog results and adds "karaoke" to YouTube queries. It is
//   remembered per device.
import { searchSongs, searchYoutube } from './queue-api.js';
import { escapeHtml } from './dom.js';
import { store } from './store.js';

const PREF_KEY = 'karaoke.preferKaraoke';
const KARAOKE_RE = /karaoke|instrumental|sing[- ]?along|lyrics/i;

export const isKaraokeVersion = (song) =>
  (song.tags ?? []).includes('karaoke') || KARAOKE_RE.test(song.title);

/**
 * @param {HTMLElement} root  container to render into
 * @param {object} opts
 * @param {(req: {kind: 'catalog'|'youtube', song: object}) => Promise<void>} opts.onRequest
 * @param {(msg: string) => void} opts.onError
 * @param {string} [opts.buttonLabel]
 */
export function mountSongSearch(root, { onRequest, onError, buttonLabel = 'Request' }) {
  let preferKaraoke = store.get(PREF_KEY, true);
  let catalog = [];
  let youtube = [];
  let lastYoutubeTerm = null;

  root.classList.add('song-search');
  root.innerHTML = `
    <form class="search" role="search">
      <input type="search" placeholder="Song title or artist…" autocomplete="off"
             enterkeyhint="search" aria-label="Search songs" />
    </form>
    <label class="switch">
      <input type="checkbox" role="switch" ${preferKaraoke ? 'checked' : ''} />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      <span class="switch-label">Prioritize karaoke versions</span>
    </label>
    <ul class="results catalog-results"></ul>
    <div class="yt-fallback" hidden>
      <button type="button" class="secondary yt-btn">Search YouTube</button>
      <ul class="results yt-results"></ul>
    </div>`;

  const input = root.querySelector('input[type=search]');
  const toggle = root.querySelector('input[role=switch]');
  const catalogList = root.querySelector('.catalog-results');
  const ytBox = root.querySelector('.yt-fallback');
  const ytList = root.querySelector('.yt-results');
  const ytBtn = root.querySelector('.yt-btn');

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runCatalog, 250);   // keep request volume low on the free tier
  });
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    runCatalog();
    if (input.value.trim().length >= 2) runYoutube();
    input.blur();
  });
  toggle.addEventListener('change', () => {
    preferKaraoke = toggle.checked;
    store.set(PREF_KEY, preferKaraoke);
    renderCatalog();
    if (lastYoutubeTerm) runYoutube();   // re-query with/without "karaoke"
  });
  ytBtn.addEventListener('click', runYoutube);

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-idx]');
    if (!btn) return;
    const kind = btn.dataset.kind;
    const song = (kind === 'catalog' ? catalog : youtube)[Number(btn.dataset.idx)];
    btn.disabled = true;
    try {
      await onRequest({ kind, song });
    } finally {
      btn.disabled = false;
    }
  });

  async function runCatalog() {
    const term = input.value;
    try {
      catalog = await searchSongs(term);
    } catch (err) {
      onError(err.message);
      return;
    }
    renderCatalog();
    ytBox.hidden = term.trim().length < 2;
    if (term.trim() !== lastYoutubeTerm) {
      ytList.innerHTML = '';
      lastYoutubeTerm = null;
    }
  }

  function renderCatalog() {
    if (preferKaraoke) {
      // Stable sort: karaoke versions first, otherwise keep title order.
      catalog = [...catalog].sort((a, b) => isKaraokeVersion(b) - isKaraokeVersion(a));
    } else {
      catalog = [...catalog].sort((a, b) => a.title.localeCompare(b.title));
    }
    catalogList.innerHTML = catalog.length
      ? catalog
          .map((s, i) =>
            row(s.title, s.artist, 'catalog', i, null, preferKaraoke && isKaraokeVersion(s)),
          )
          .join('')
      : `<li class="empty">No songs match “${escapeHtml(input.value)}” in the catalog.</li>`;
  }

  async function runYoutube() {
    const term = input.value.trim();
    if (!term) return;
    lastYoutubeTerm = term;
    ytBox.hidden = false;
    ytBtn.disabled = true;
    ytBtn.textContent = 'Searching YouTube…';
    try {
      const { available, items } = await searchYoutube(term, { karaoke: preferKaraoke });
      if (!available) {
        ytList.innerHTML = '<li class="empty">YouTube search isn’t set up yet (needs YOUTUBE_API_KEY).</li>';
        return;
      }
      youtube = items;
      ytList.innerHTML = items.length
        ? items
            .map((v, i) =>
              row(v.title, v.channel, 'youtube', i, v.thumbnail, preferKaraoke && isKaraokeVersion(v)),
            )
            .join('')
        : '<li class="empty">Nothing found on YouTube either.</li>';
    } catch (err) {
      onError(err.message);
    } finally {
      ytBtn.disabled = false;
      ytBtn.textContent = 'Search YouTube';
    }
  }

  function row(title, artist, kind, idx, thumb, karaokeBadge) {
    return `
      <li class="result">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : ''}
        <div class="info">
          <span class="title">${escapeHtml(title)}</span>
          <span class="artist">${karaokeBadge ? '<span class="tag">🎤 karaoke</span>' : ''}${escapeHtml(artist)}</span>
        </div>
        <button type="button" data-kind="${kind}" data-idx="${idx}">${escapeHtml(buttonLabel)}</button>
      </li>`;
  }

  runCatalog();
  return { focus: () => input.focus(), clear: () => { input.value = ''; runCatalog(); } };
}
