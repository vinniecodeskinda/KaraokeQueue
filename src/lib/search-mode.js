// Which search to use, per device:
//   'api'    — YouTube Data API (official; ~100 searches/day). If the daily
//              limit runs out, searches switch to backup automatically.
//   'scrape' — backup search: youtube.com's own web search, no daily limit
//              (unofficial — see functions/api/youtube-search.js).
// Pasted YouTube links work in both modes and never use quota.
import { store } from './store.js';

const KEY = 'karaoke.searchMode';
const listeners = new Set();

export const getSearchMode = () => (store.get(KEY, 'api') === 'scrape' ? 'scrape' : 'api');

export function setSearchMode(mode) {
  store.set(KEY, mode === 'scrape' ? 'scrape' : 'api');
  listeners.forEach((fn) => fn(getSearchMode()));
}

/** "Backup search" slider. Several on one page stay in sync. */
export function mountSearchModeSwitch(root) {
  root.classList.add('search-mode');
  root.innerHTML = `
    <label class="switch">
      <input type="checkbox" role="switch" />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      <span class="switch-label">Backup search <span class="mode-detail"></span></span>
    </label>`;
  const input = root.querySelector('input');
  const detail = root.querySelector('.mode-detail');
  const render = (mode) => {
    input.checked = mode === 'scrape';
    detail.textContent =
      mode === 'scrape'
        ? '— ON: searching youtube.com directly, no daily limit'
        : '— OFF: official YouTube API (switches to backup automatically if the daily limit runs out)';
  };
  input.addEventListener('change', () => setSearchMode(input.checked ? 'scrape' : 'api'));
  listeners.add(render);
  render(getSearchMode());
}
