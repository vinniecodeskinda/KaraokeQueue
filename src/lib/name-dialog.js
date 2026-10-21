// Singer names, shared by every page. Each device picks a name once (on the
// landing page, or the first time it opens a join link). Requests then go
// straight through under that name. Anyone who skips gets a random pun on
// a famous singer, so the queue never shows a blank.
import { store } from './store.js';

const NAME_KEY = 'karaoke.name';
const SINGER_PUNS = [
  'Taylor Drift', 'Billie Eyelash', 'Ariana Venti', 'Justin Timberfake', 'Bruno Marshmallow',
  'Lady Gouda', 'Harry Smiles', 'Elton Yawn', 'Freddie Mercurial', 'Britney Spheres',
  'Dua Lipstick', 'Post Malonely', 'Ed Shearing', 'Katy Perrier', 'Snoop Doggo',
  'Bean-yoncé', 'Rihanna Banana', 'Adelete', 'Mariah Scary', 'Cardi Bee',
  'Fizzo', 'Olivia Rodrigoat', 'Michael Snackson', 'Whitney Hustlin', 'Dolly Partyon',
  'Bob Barley', 'Bon Groovy', 'Celine Dijon', 'Cher Bear', 'The Weekday',
  'Sabrina Carpooler', 'Chappell Roam', 'Doja Hat', 'Frank Snackatra', 'Elvis Parsley',
  'Stevie Wondering', 'Madonut', 'Bruce Springclean', 'Mick Swagger', 'Ozzy Ostrich',
  'Shakira Shakeira', 'Kenny Loggedin', 'Barry Manicure', 'Lionel Richtea', 'Garth Books',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const sillyName = () => pick(SINGER_PUNS);

/** True once this device has a name (typed or auto-assigned). */
export const hasName = () => Boolean(store.get(NAME_KEY, ''));

export function saveName(name) {
  const clean = String(name ?? '').trim().slice(0, 40);
  store.set(NAME_KEY, clean || sillyName());
  return currentName();
}

/** The name requests are made under. Assigns a silly one if none yet. */
export function currentName() {
  const saved = store.get(NAME_KEY, '');
  if (saved) return saved;
  const name = sillyName();
  store.set(NAME_KEY, name);
  return name;
}

let dialog;

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'name-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <h2 class="name-dialog-title"></h2>
      <p class="name-dialog-sub"></p>
      <label class="field-label name-field">Your name</label>
      <div class="name-row name-field">
        <input name="name" maxlength="40" autocomplete="nickname" placeholder="Your name" />
        <button type="button" class="secondary dice" title="Random singer pun" aria-label="Random singer pun">🎲</button>
      </div>
      <label class="field-label pw-field">Room password</label>
      <input class="pw-field pw-input" name="password" type="password" autocomplete="off" placeholder="Password" />
      <p class="dialog-error" role="alert"></p>
      <div class="dialog-actions">
        <!-- Submit first so Enter in an input picks it; CSS reverses the visual order. -->
        <button value="ok" class="name-dialog-submit"></button>
        <button value="cancel" class="secondary name-dialog-cancel" formnovalidate>Cancel</button>
      </div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelector('.dice').addEventListener('click', () => {
    const input = dialog.querySelector('input[name=name]');
    input.value = sillyName();
    input.focus();
  });
}

function open({ title, subtitle = '', confirmLabel, askName = true, askPassword = false, error = '', cancelable = false }) {
  if (!dialog) build();
  const q = (sel) => dialog.querySelector(sel);
  q('.name-dialog-title').textContent = title;
  q('.name-dialog-sub').textContent = subtitle;
  q('.name-dialog-sub').hidden = !subtitle;
  q('.name-dialog-submit').textContent = confirmLabel;
  q('.name-dialog-cancel').hidden = !cancelable;
  q('.dialog-error').textContent = error;
  q('.dialog-error').hidden = !error;
  dialog.querySelectorAll('.name-field').forEach((el) => (el.hidden = !askName));
  dialog.querySelectorAll('.pw-field').forEach((el) => (el.hidden = !askPassword));
  const nameInput = q('input[name=name]');
  const pwInput = q('input[name=password]');
  nameInput.value = currentName();
  pwInput.value = '';
  dialog.returnValue = '';
  dialog.showModal();
  (askPassword ? pwInput : nameInput).focus();
  if (!askPassword) nameInput.select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve({ ok: dialog.returnValue === 'ok', name: nameInput.value, password: pwInput.value }),
      { once: true },
    );
  });
}

/**
 * Ask for a name ("change my name"). Closing or leaving it blank keeps a
 * silly name. Resolves to the saved name.
 */
export async function promptName({ title = 'What should we call you?', subtitle = '', confirmLabel = 'Save' } = {}) {
  const { name } = await open({ title, subtitle, confirmLabel });
  return saveName(name);
}

/**
 * Join prompt for a guest arriving by link: optional name, plus the room
 * password when needed. Resolves to { name, password }, or null if they
 * cancelled a password prompt.
 */
export async function promptJoin({ title, subtitle, askName, askPassword, error }) {
  const res = await open({
    title,
    subtitle,
    confirmLabel: "Let's sing",
    askName,
    askPassword,
    error,
    cancelable: askPassword,
  });
  if (askPassword && !res.ok) return null;
  const name = askName ? saveName(res.name) : currentName();
  return { name, password: res.password };
}
