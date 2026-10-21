// "Who's singing?" prompt, shared by the host and join pages. Builds its own
// <dialog> on first use; remembers the last name on this device.
import { store } from './store.js';

const NAME_KEY = 'karaoke.name';
let dialog;

export const savedName = () => store.get(NAME_KEY, '');
export const saveName = (name) => store.set(NAME_KEY, name);

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'name-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Who's singing?</h2>
      <p class="name-dialog-song"></p>
      <input name="name" maxlength="40" required autocomplete="nickname" placeholder="Your name" />
      <div class="dialog-actions">
        <!-- Submit first so Enter in the input picks it; CSS reverses the visual order. -->
        <button value="ok" class="name-dialog-submit">Request 🎶</button>
        <button value="cancel" class="secondary" formnovalidate>Cancel</button>
      </div>
    </form>`;
  document.body.append(dialog);
}

/**
 * Ask for a singer name. `songTitle` null means "just change my name".
 * Resolves to the trimmed name, or null if cancelled.
 */
export function askName(songTitle, { defaultName } = {}) {
  if (!dialog) build();
  const input = dialog.querySelector('input');
  dialog.querySelector('.name-dialog-song').textContent = songTitle
    ? `Requesting “${songTitle}”`
    : 'Change your name';
  dialog.querySelector('.name-dialog-submit').textContent = songTitle ? 'Request 🎶' : 'Save';
  input.value = savedName() || defaultName || '';
  dialog.returnValue = '';   // Esc keeps the previous returnValue otherwise
  dialog.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const name = input.value.trim();
        const ok = dialog.returnValue === 'ok' && name;
        if (ok) saveName(name);
        resolve(ok ? name : null);
      },
      { once: true },
    );
  });
}
