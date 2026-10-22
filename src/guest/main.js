import '../styles/base.css';
import '../styles/guest.css';
import { showDemoBanner } from '../lib/supabase.js';
import {
  isDemo,
  fetchActiveQueue,
  fetchMemberStatus,
  findRoom,
  joinRoom,
  kickMember,
  renameMember,
  requestSong,
  requestYoutubeSong,
  subscribeToRoom,
} from '../lib/queue-api.js';
import {
  forgetHostKey,
  forgetMembership,
  hostingFor,
  hostUrl,
  membershipFor,
  rememberHostKey,
  rememberMembership,
  roomFromUrl,
  shareJoinLink,
} from '../lib/rooms.js';
import { startHeartbeat, watchForHostHandover } from '../lib/host-session.js';
import { mountRemote } from '../lib/remote.js';
import { REACTIONS } from '../lib/reactions.js';
import { mountSongSearch } from '../lib/song-search.js';
import { currentName, hasName, promptJoin, promptName, saveName } from '../lib/name-dialog.js';
import { store } from '../lib/store.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);
const KICKED_RE = /removed from this party/i;
const KICKED_KEY = 'karaoke.kickedFrom';   // room ids this device was removed from

let room;
let me;               // { memberId, memberKey, name, joinedAt }
let hostKey = null;   // set while this phone is the host
let people = [];      // who's connected right now (presence)
let live = { unsubscribe() {}, track: async () => {}, send: async () => {} };
let updateRemote = () => {};
let stateTimeout;
let stopHeartbeat = () => {};
let stopWatching = () => {};

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
  if (!room.open) {
    return gate(`<b>${escapeHtml(room.name)}</b> has closed — everyone left.`);
  }
  if (store.get(KICKED_KEY, []).includes(room.id)) {
    return gate(`The host removed you from <b>${escapeHtml(room.name)}</b>.`);
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
      me.name = saveName(await renameMember(me.memberKey, wanted));
      renderNameChip();
      live.track({ name: me.name });
    } catch (err) {
      handleError(err);
    }
  });
  renderNameChip();
  wireTabs();
  $('people-list').addEventListener('click', onKickClick);
  $('open-tv').href = hostUrl(room.code);

  mountSongSearch($('search'), { onRequest: request, onError: toast });

  // Remote tab: everyone can control the TV player.
  updateRemote = mountRemote($('phone-remote'), {
    onAction: (action) => live.send('control', { action }),
    queueToggle: true,
  });
  showRemoteState({ active: false });
  wireRemotePager();
  document.querySelector('.tab[data-tab=remote]').addEventListener('click', requestState);
  mountReactionBar();

  live = subscribeToRoom(
    room.id,
    {
      onQueue: refreshQueue,
      onMembers: checkMyStatus,
      onPresence: (list) => {
        renderPeople(list);
        requestState();   // someone came or went — maybe the TV
      },
      onBroadcast: (event, payload) => {
        if (event === 'state') showRemoteState(payload);
      },
    },
    () => {},
    {
      key: me.memberId,
      payload: { member_id: me.memberId, name: me.name, is_host: false, joined_at: me.joinedAt },
    },
  );
  refreshQueue();

  // Already host in this session (e.g. took over, then reloaded)?
  const hosting = hostingFor(room.code);
  if (hosting?.id === room.id) becomeHost(hosting.hostKey, { quiet: true });
  else watchHandover();
}

/**
 * Join for this session: reuse this tab's membership if it has one (a
 * reload), otherwise ask for a name (first visit) and the password (locked
 * rooms). A closed tab/app starts over as a new person. Returns false if
 * they can't get in.
 */
async function enterRoom() {
  const existing = membershipFor(room.code);
  if (existing) {
    try {
      return accept(await joinRoom(room.code, { memberKey: existing.memberKey }));
    } catch (err) {
      if (KICKED_RE.test(err.message)) return kicked();
      forgetMembership(room.code);   // stale session → join fresh
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
  rememberMembership(room.code, { roomId: joined.room.id, memberId: joined.memberId, memberKey: joined.memberKey });
  me = {
    memberId: joined.memberId,
    memberKey: joined.memberKey,
    name: joined.name,
    joinedAt: membershipFor(room.code).joinedAt,
  };
  return true;
}

// ------------------------------------------------------------- host handover

function watchHandover() {
  stopWatching = watchForHostHandover(
    () => ({ people, memberId: me.memberId, memberKey: me.memberKey }),
    ({ hostKey: key }) => becomeHost(key),
  );
}

/** This phone is now the host: heartbeat, show host tools, tell everyone. */
function becomeHost(key, { quiet = false } = {}) {
  stopWatching();
  hostKey = key;
  rememberHostKey(room.code, key);
  live.track({ is_host: true });
  stopHeartbeat = startHeartbeat(room.id, key, loseHost);
  document.body.classList.add('is-host');
  $('host-banner').hidden = false;
  if (!quiet) toast('👑 The host left — you’re the host now!');
  renderPeople(people);
  refreshQueue();
}

function loseHost() {
  stopHeartbeat();
  hostKey = null;
  forgetHostKey(room.code);
  live.track({ is_host: false });
  document.body.classList.remove('is-host');
  $('host-banner').hidden = true;
  toast('You’re no longer the host.');
  renderPeople(people);
  watchHandover();
}

// ------------------------------------------------------------- remote

/** Ask the TV for its player state; if nothing answers, it isn't running. */
function requestState() {
  live.send('hello', {});
  clearTimeout(stateTimeout);
  stateTimeout = setTimeout(() => showRemoteState({ active: false }), 2500);
}

function showRemoteState(state) {
  if (state?.tv) clearTimeout(stateTimeout);
  updateRemote(state);
  $('remote-hint').textContent = !state?.tv
    ? 'The TV screen isn’t connected right now.'
    : !state.active
      ? 'Nothing is playing yet — you can still show or hide the queue on the TV.'
      : state.upNext
        ? 'The TV is showing who’s up next — press Play to start the song now.'
        : 'Controls the TV for everyone.';
}

// ------------------------------------------------------------- reactions

/** Emoji bar pinned to the bottom of the screen; taps float up on the TV. */
/** Remote tab: swipe (or tap the labels) between Controls and Reactions. */
function wireRemotePager() {
  const pager = $('remote-pager');
  const tabs = [...document.querySelectorAll('.pager-tab')];
  const select = (i) => tabs.forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
  tabs.forEach((t, i) =>
    t.addEventListener('click', () => pager.scrollTo({ left: i * pager.clientWidth, behavior: 'smooth' })),
  );
  pager.addEventListener('scroll', () => select(Math.round(pager.scrollLeft / pager.clientWidth)), {
    passive: true,
  });
}

/** Reactions page of the Remote tab; taps float up on the TV. */
function mountReactionBar() {
  const bar = $('react-grid');
  bar.innerHTML = REACTIONS.map(
    (e) => `<button type="button" class="react-btn" data-emoji="${e}" aria-label="Send ${e}">${e}</button>`,
  ).join('');
  let last = 0;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.react-btn');
    if (!btn) return;
    const now = Date.now();
    if (now - last < 300) return;   // gentle rate limit per phone
    last = now;
    live.send('react', { emoji: btn.dataset.emoji, name: me.name });
    btn.classList.remove('pop');
    void btn.offsetWidth;            // restart the pop animation
    btn.classList.add('pop');
  });
}

async function onKickClick(e) {
  const btn = e.target.closest('.kick');
  if (!btn || !hostKey) return;
  if (!confirm(`Remove ${btn.dataset.name} from the party? Their waiting songs will be dropped.`)) return;
  btn.disabled = true;
  try {
    await kickMember(room.id, hostKey, btn.dataset.id);
    toast(`${btn.dataset.name} was removed.`);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

// ------------------------------------------------------------- request

async function request({ song, kind }) {
  try {
    if (kind === 'catalog') await requestSong(me.memberKey, song.id);
    else await requestYoutubeSong(me.memberKey, song);
    toast(`🎶 “${song.title}” added for ${me.name}!`);
    refreshQueue();
  } catch (err) {
    handleError(err);
  }
}

function renderNameChip() {
  $('name-chip').hidden = false;
  $('name-chip').textContent = `👤 ${me.name}`;
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

/** Who's connected right now (Realtime Presence). Host sees Remove buttons. */
function renderPeople(list) {
  people = list;
  $('people-count').textContent = list.length;
  $('people-list').innerHTML = list
    .map((p) => {
      const isMe = p.member_id === me.memberId;
      const role = p.is_host ? '👑 Host' : isMe ? 'You' : 'Guest';
      return `
      <li class="${isMe ? 'mine' : ''}">
        <div class="person-info">
          <span class="title">${escapeHtml(p.name)}</span>
          <span class="artist">${isMe && p.is_host ? '👑 Host (you)' : role}</span>
        </div>
        ${hostKey && !isMe ? `<button type="button" class="secondary small kick" data-id="${p.member_id}" data-name="${escapeHtml(p.name)}">Remove</button>` : ''}
      </li>`;
    })
    .join('');
}

/** Members table changed (kick or host change) — check where we stand. */
async function checkMyStatus() {
  try {
    const status = await fetchMemberStatus(me.memberId);
    if (status.kicked) kicked();
  } catch {
    /* transient — next change will re-check */
  }
}

// ------------------------------------------------------------- ui bits

function handleError(err) {
  if (KICKED_RE.test(err.message)) kicked();
  else toast(err.message);
}

function kicked() {
  stopWatching();
  stopHeartbeat();
  live.unsubscribe();
  forgetMembership(room.code);
  // Remember on this device, so reopening the link doesn't quietly rejoin.
  const banned = store.get(KICKED_KEY, []);
  if (!banned.includes(room.id)) store.set(KICKED_KEY, [...banned, room.id].slice(-20));
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
