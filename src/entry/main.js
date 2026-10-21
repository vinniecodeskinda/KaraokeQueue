import '../styles/base.css';
import '../styles/entry.css';
import { showDemoBanner } from '../lib/supabase.js';
import { createRoom, findRoom, isDemo, joinRoom } from '../lib/queue-api.js';
import {
  hostedRooms,
  hostUrl,
  membershipFor,
  normalizeCode,
  rememberHosting,
  rememberMembership,
  roomFromUrl,
} from '../lib/rooms.js';
import { escapeHtml } from '../lib/dom.js';
import { hasName, currentName, saveName, sillyName } from '../lib/name-dialog.js';

const $ = (id) => document.getElementById(id);

if (isDemo) showDemoBanner();

// Old-style links like /?room=ABCDE go straight to the join page.
const linked = roomFromUrl();
if (linked) location.replace(`/join/?room=${linked}`);

// ---------------------------------------------------------------- name
// Prefill a returning device's name; otherwise suggest a singer pun as the
// placeholder, which is what they get if they leave it blank.
const nameInput = $('name-input');
let suggested = sillyName();
if (hasName()) nameInput.value = currentName();
nameInput.placeholder = suggested;
$('dice-btn').addEventListener('click', () => {
  nameInput.value = sillyName();
  nameInput.focus();
  updateRoomNamePlaceholder();
});
nameInput.addEventListener('input', updateRoomNamePlaceholder);
const typedName = () => nameInput.value.trim() || suggested;
const commitName = () => saveName(typedName());

// Room name defaults to "<host name>'s Room" — show that as the placeholder.
function updateRoomNamePlaceholder() {
  $('room-name').placeholder = `${typedName()}'s Room`;
}
updateRoomNamePlaceholder();

// ---------------------------------------------------------------- join
const codeInput = $('code-input');
codeInput.addEventListener('input', () => {
  const pos = codeInput.selectionStart;
  codeInput.value = normalizeCode(codeInput.value);
  codeInput.setSelectionRange(pos, pos);
  $('join-pw-box').hidden = true;   // a different code may not need a password
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = normalizeCode(codeInput.value);
  if (code.length !== 5) {
    toast('Room codes are 5 characters, like K7QX2.');
    codeInput.focus();
    return;
  }
  const btn = $('join-btn');
  btn.disabled = true;
  try {
    const room = await findRoom(code);
    if (!room) {
      toast(`No room called ${code}. Check the code on the TV.`);
      return;
    }
    const existing = membershipFor(room.code);
    const password = $('join-pw').value;
    // Locked room and no password typed yet (and not already a member): ask.
    if (room.hasPassword && !existing && !password) {
      $('join-pw-box').hidden = false;
      $('join-pw').focus();
      toast(`“${room.name}” has a password.`);
      return;
    }
    const name = commitName();
    const joined = await joinRoom(room.code, { password, name, memberKey: existing?.memberKey });
    rememberMembership(room.code, { roomId: joined.room.id, memberId: joined.memberId, memberKey: joined.memberKey });
    location.href = `/join/?room=${room.code}`;
  } catch (err) {
    toast(err.message);
    if (/password/i.test(err.message)) {
      $('join-pw-box').hidden = false;
      $('join-pw').select();
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- host
$('host-btn').addEventListener('click', async () => {
  const btn = $('host-btn');
  btn.disabled = true;
  btn.textContent = 'Creating room…';
  try {
    const hostName = commitName();
    const room = await createRoom({
      name: $('room-name').value.trim(),
      password: $('room-pw').value,
      hostName,
    });
    rememberHosting(room);
    rememberMembership(room.code, { roomId: room.id, memberId: room.memberId, memberKey: room.memberKey });
    location.href = hostUrl(room.code);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.textContent = 'Create a room';
  }
});

// Rooms this device created recently — one tap to get back to the TV view.
const recent = hostedRooms().filter((r) => Date.now() - r.createdAt < 2 * 24 * 3600 * 1000);
if (recent.length) {
  const box = $('recent-rooms');
  box.hidden = false;
  box.innerHTML =
    '<p class="hint">Resume hosting:</p>' +
    recent
      .map((r) => `<a class="chip-link resume-link" href="${hostUrl(r.code)}">${escapeHtml(r.code)}</a>`)
      .join('');
  box.addEventListener('click', (e) => {
    if (e.target.closest('.resume-link')) commitName();
  });
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
