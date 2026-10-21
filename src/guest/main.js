import '../styles/base.css';
import '../styles/guest.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  isDemo,
  fetchActiveQueue,
  fetchMembers,
  findRoom,
  joinRoom,
  renameMember,
  requestSong,
  requestYoutubeSong,
  subscribeToRoom,
} from '../lib/queue-api.js';
import { forgetMembership, membershipFor, rememberMembership, roomFromUrl, shareJoinLink } from '../lib/rooms.js';
import { mountSongSearch } from '../lib/song-search.js';
import { currentName, hasName, promptJoin, promptName, saveName } from '../lib/name-dialog.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const KICKED_RE = /removed from this party/i;

let room;
let me;               // { roomId, memberId, memberKey }
let myName = '';
let unsubscribe = () => {};

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
  $('room-title').textContent = room.name;
  document.title = `${room.name} — ${room.code}`;
  $('room-chip').addEventListener('click', async () => {
    const how = await shareJoinLink(room.code);
    if (how === 'copied') toast('Join link copied — send it to your friends!');
  });

  try {
    if (!(await enterRoom())) return;
  } catch (err) {
    return gate(`Couldn't join <b>${escapeHtml(room.name)}</b>: ${escapeHtml(err.message)}`);
  }

  $('name-chip').addEventListener('click', async () => {
    const wanted = await promptName({ title: 'Change your name' });
    try {
      myName = saveName(await renameMember(me.memberKey, wanted));
      renderNameChip();
    } catch (err) {
      handleError(err);
    }
  });
  renderNameChip();
  wireTabs();

  mountSongSearch($('search'), { onRequest: request, onError: toast });

  refreshQueue();
  refreshMembers();
  unsubscribe = subscribeToRoom(room.id, { onQueue: refreshQueue, onMembers: refreshMembers });
}

/**
 * Become a member of the room: re-use this device's membership if it has
 * one, otherwise ask for a name (first visit) and the password (locked
 * rooms). Returns false if they can't get in.
 */
async function enterRoom() {
  const existing = membershipFor(room.code);
  if (existing) {
    try {
      const joined = await joinRoom(room.code, { memberKey: existing.memberKey });
      return accept(joined);
    } catch (err) {
      if (KICKED_RE.test(err.message)) return kicked();
      forgetMembership(room.code);   // stale key (e.g. room was reset) → join fresh
    }
  }

  let askName = !hasName();
  let error = '';
  for (;;) {
    if (askName || room.hasPassword) {
      const answer = await promptJoin({
        title: `Welcome to ${room.name}! 🎤`,
        subtitle: askName ? 'What should we call you? This shows next to the songs you pick.' : '',
        askName,
        askPassword: room.hasPassword,
        error,
      });
      if (!answer) {
        gate(`<b>${escapeHtml(room.name)}</b> needs a password to join.<br />
              <a class="btn" href="${location.href}">Try again</a>`);
        return false;
      }
      askName = false;
      try {
        return accept(await joinRoom(room.code, { name: answer.name, password: answer.password }));
      } catch (err) {
        if (!/password/i.test(err.message)) throw err;
        error = err.message;   // wrong password → ask again
      }
    } else {
      return accept(await joinRoom(room.code, { name: currentName() }));
    }
  }
}

function accept(joined) {
  me = { roomId: joined.room.id, memberId: joined.memberId, memberKey: joined.memberKey };
  myName = joined.name;
  rememberMembership(room.code, me);
  return true;
}

// ------------------------------------------------------------- request

async function request({ song, kind }) {
  try {
    if (kind === 'catalog') await requestSong(me.memberKey, song.id);
    else await requestYoutubeSong(me.memberKey, song);
    toast(`🎶 “${song.title}” added for ${myName}!`);
    refreshQueue();
  } catch (err) {
    handleError(err);
  }
}

function renderNameChip() {
  $('name-chip').hidden = false;
  $('name-chip').textContent = `👤 ${myName}`;
  $('name-chip').title = 'Change your name';
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

  const mine = (row) => row.member_id === me.memberId;
  $('queue-count').textContent = upNext.length;
  $('queue-list').innerHTML = upNext.length
    ? upNext
        .map(
          (row) => `
          <li class="${mine(row) ? 'mine' : ''}">
            <span class="title">${escapeHtml(row.song.title)}</span>
            <span class="artist">${row.song.artist ? `${escapeHtml(row.song.artist)} · ` : ''}${escapeHtml(row.guest_name)}</span>
          </li>`,
        )
        .join('')
    : '<li class="empty">The queue is empty. Be the first!</li>';

  renderMyStatus(playing, upNext, mine);
}

/** "You're up next" / "3 songs ahead of you" for this member's requests. */
function renderMyStatus(playing, upNext, mine) {
  const el = $('my-status');
  if (playing && mine(playing)) {
    el.hidden = false;
    el.className = 'my-status now';
    el.textContent = '🎤 You’re on! Grab the mic.';
    return;
  }
  const position = upNext.findIndex(mine);
  if (position === -1) {
    el.hidden = true;
    return;
  }
  const ahead = position + (playing ? 1 : 0);
  el.hidden = false;
  el.className = 'my-status';
  el.textContent =
    ahead === 0 ? '⏭ You’re up next!' : `⏳ ${ahead} song${ahead === 1 ? '' : 's'} ahead of you`;
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
  // Not in the list any more → the host removed us.
  if (!members.some((m) => m.id === me.memberId)) {
    kicked();
    return;
  }
  $('people-count').textContent = members.length;
  $('people-list').innerHTML = members
    .map(
      (m) => `
      <li class="${m.id === me.memberId ? 'mine' : ''}">
        <span class="title">${escapeHtml(m.name)}</span>
        <span class="artist">${m.is_host ? '🎛️ Host' : m.id === me.memberId ? 'You' : 'Guest'}</span>
      </li>`,
    )
    .join('');
}

// ------------------------------------------------------------- ui bits

function handleError(err) {
  if (KICKED_RE.test(err.message)) kicked();
  else toast(err.message);
}

function kicked() {
  unsubscribe();
  // Keep the (now refused) membership so reopening the link still says
  // "removed" instead of quietly joining as someone new.
  gate(`The host removed you from <b>${escapeHtml(room.name)}</b>.`);
  return false;
}

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
      <a class="btn secondary" href="/">Back to start</a>
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
