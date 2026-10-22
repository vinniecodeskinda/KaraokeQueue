// Song search widget shared by the host (TV) and join (phone) pages.
//
// Searches YouTube through our Pages Function, using the device's search
// mode (see search-mode.js): the official API (~100 searches/day, results
// cached 7 days) or backup search. If the API's daily limit runs out, it
// retries with backup search automatically. Pasting a YouTube link queues
// that video directly in either mode. Searches run on Enter / Search, not
// on every keystroke. The "Prioritize karaoke" switch adds "karaoke" to the
// query and ranks karaoke/lyric versions first. Both settings are per device.
import { searchYoutube } from './queue-api.js';
import { escapeHtml } from './dom.js';
import { store } from './store.js';
import { getSearchMode, mountSearchModeSwitch } from './search-mode.js';

const SOURCE_LABEL = {
  api: 'YouTube search',
  scrape: 'Backup search',
  link: 'Pasted link',
};

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
 * @param {boolean} [opts.modeSwitch]  show the "Backup search" slider here too
 */
export function mountSongSearch(root, { onRequest, onError, buttonLabel = 'Request', modeSwitch = false }) {
  let preferKaraoke = store.get(PREF_KEY, true);
  let apiOrder = [];   // results as YouTube returned them
  let results = [];    // what's on screen (maybe re-sorted)
  let lastTerm = '';

  root.classList.add('song-search');
  root.innerHTML = `
    <form class="search" role="search">
      <input type="search" placeholder="Search YouTube or paste a link…" autocomplete="off"
             enterkeyhint="search" aria-label="Search YouTube or paste a YouTube link" />
      <button type="submit" class="search-btn">Search</button>
    </form>
    <label class="switch karaoke-switch">
      <input type="checkbox" role="switch" ${preferKaraoke ? 'checked' : ''} />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      <span class="switch-label">Prioritize karaoke versions</span>
    </label>
    ${modeSwitch ? '<div class="mode-slot"></div>' : ''}
    <p class="results-source" hidden></p>
    <ul class="results"></ul>`;

  const input = root.querySelector('input[type=search]');
  const toggle = root.querySelector('.karaoke-switch input');
  const list = root.querySelector('.results');
  const sourceNote = root.querySelector('.results-source');
  const searchBtn = root.querySelector('.search-btn');
  if (modeSwitch) mountSearchModeSwitch(root.querySelector('.mode-slot'));

  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    run();
    input.blur();
  });
  toggle.addEventListener('change', () => {
    preferKaraoke = toggle.checked;
    store.set(PREF_KEY, preferKaraoke);
    // Re-sort what's on screen instead of searching again (a search costs
    // quota). The next search uses the new setting.
    if (results.length) render();
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
    sourceNote.hidden = true;
    list.innerHTML = '<li class="empty">Searching YouTube…</li>';
    try {
      let res;
      let fellBack = false;
      try {
        res = await searchYoutube(term, { karaoke: preferKaraoke, mode: getSearchMode() });
      } catch (err) {
        if (err.code !== 'quota') throw err;
        // Official daily limit used up → try backup search instead.
        fellBack = true;
        list.innerHTML = '<li class="empty">Daily limit reached — trying backup search…</li>';
        res = await searchYoutube(term, { karaoke: preferKaraoke, mode: 'scrape' });
      }
      if (!res.available) {
        list.innerHTML = '<li class="empty">YouTube search isn’t set up (needs YOUTUBE_API_KEY).</li>';
        return;
      }
      apiOrder = res.items;
      sourceNote.hidden = false;
      sourceNote.textContent = fellBack
        ? 'Official searches are used up for today — these are from backup search.'
        : `From: ${SOURCE_LABEL[res.source] ?? 'YouTube'}`;
      render();
      if (res.source === 'link' && !res.items.length) {
        list.innerHTML = '<li class="empty">That video can’t be played here (it’s private, missing, or blocks embedding).</li>';
      }
    } catch (err) {
      list.innerHTML = '';
      onError(err.message);
    } finally {
      searchBtn.disabled = false;
    }
  }

  /** Show apiOrder, karaoke versions first when the switch is on. */
  function render() {
    results = preferKaraoke
      ? [...apiOrder].sort((a, b) => isKaraokeVersion(b) - isKaraokeVersion(a))
      : apiOrder;
    list.innerHTML = results.length
      ? results.map((v, i) => row(v, i)).join('')
      : `<li class="empty">No results for “${escapeHtml(lastTerm)}”.</li>`;
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
