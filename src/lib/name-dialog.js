// Singer names, shared by every page. Each device picks a name once (on the
// landing page, or the first time it opens a join link). Requests then go
// straight through under that name. Anyone who skips gets a random silly
// name, so the queue never shows a blank.
import { store } from './store.js';

const NAME_KEY = 'karaoke.name';
const ADJECTIVES = [
  'Sparkly', 'Funky', 'Groovy', 'Sassy', 'Wobbly', 'Disco', 'Fluffy', 'Jazzy',
  'Sleepy', 'Cosmic', 'Spicy', 'Bouncy', 'Glittery', 'Dramatic', 'Sneaky',
  'Majestic', 'Tiny', 'Electric', 'Cheesy', 'Soulful', 'Moonwalking', 'Off-Key',
];
const NOUNS = [
  'Penguin', 'Pickle', 'Llama', 'Taco', 'Walrus', 'Noodle', 'Otter', 'Waffle',
  'Flamingo', 'Potato', 'Sloth', 'Meatball', 'Hamster', 'Narwhal', 'Burrito',
  'Raccoon', 'Muffin', 'Goose', 'Dumpling', 'Unicorn', 'Crab', 'Biscuit',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const sillyName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`;

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
      <div class="name-row">
        <input name="name" maxlength="40" autocomplete="nickname" placeholder="Your name" />
        <button type="button" class="secondary dice" title="Random silly name" aria-label="Random silly name">🎲</button>
      </div>
      <div class="dialog-actions">
        <!-- Submit first so Enter in the input picks it; CSS reverses the visual order. -->
        <button value="ok" class="name-dialog-submit"></button>
      </div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelector('.dice').addEventListener('click', () => {
    const input = dialog.querySelector('input');
    input.value = sillyName();
    input.focus();
  });
}

/**
 * Ask for a name (first visit via a join link, or "change my name").
 * Closing or leaving it blank keeps a silly name. Resolves to the saved name.
 */
export function promptName({ title = 'What should we call you?', subtitle = '', confirmLabel = 'Save' } = {}) {
  if (!dialog) build();
  const input = dialog.querySelector('input');
  dialog.querySelector('.name-dialog-title').textContent = title;
  dialog.querySelector('.name-dialog-sub').textContent = subtitle;
  dialog.querySelector('.name-dialog-sub').hidden = !subtitle;
  dialog.querySelector('.name-dialog-submit').textContent = confirmLabel;
  input.value = currentName();
  dialog.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(saveName(input.value)), { once: true });
  });
}
