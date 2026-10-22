// Playback remote, shared by the TV sidebar and the phone's Remote tab.
//
// Phones send { action } as a Realtime Broadcast "control" message; the TV
// (the only page with the YouTube player) applies it and broadcasts its
// "state" back, so every remote shows the same thing. The TV's own buttons
// apply actions directly.

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

const BUTTONS = [
  ['restart', '⏮', 'Start over'],
  ['toggle', '⏯', 'Pause'],
  ['skip', '⏭', 'Skip'],
  ['slower', '🐢', 'Slower'],
  ['faster', '🐇', 'Faster'],
  ['mute', '🔇', 'Mute'],
  ['voldown', '🔉', 'Vol −'],
  ['volup', '🔊', 'Vol +'],
];

/**
 * Render remote buttons into `root`. `onAction(action)` is called on click.
 * Returns update(state) where state = { tv, queueOpen, active, playing, rate,
 * volume, muted }. tv=false → the TV isn't answering (everything disabled);
 * active=false → nothing is playing (playback buttons disabled).
 * `queueToggle` adds a Show/Hide queue button for the TV's sidebar.
 */
export function mountRemote(root, { onAction, compact = false, queueToggle = false }) {
  root.classList.add('remote', compact ? 'remote-compact' : 'remote-full');
  root.innerHTML = `
    ${queueToggle ? `<div class="remote-row queue-row">${btn(['queue', '📋', 'Hide queue'])}</div>` : ''}
    <div class="remote-row transport">
      ${BUTTONS.slice(0, 3).map(btn).join('')}
    </div>
    <div class="remote-row">
      ${btn(BUTTONS[3])}
      <span class="remote-readout" data-readout="rate">1×</span>
      ${btn(BUTTONS[4])}
    </div>
    <div class="remote-row">
      ${btn(BUTTONS[5])}
      ${btn(BUTTONS[6])}
      <span class="remote-readout" data-readout="volume">–</span>
      ${btn(BUTTONS[7])}
    </div>`;

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b && !b.disabled) onAction(b.dataset.action);
  });

  const q = (sel) => root.querySelector(sel);
  return function update(state) {
    const active = Boolean(state?.active);
    root.querySelectorAll('button[data-action]').forEach((b) => (b.disabled = !active));
    root.classList.toggle('inactive', !active);
    // The queue button works whenever the TV is connected, even with nothing playing.
    const queue = q('[data-action=queue]');
    if (queue) {
      queue.disabled = !state?.tv;
      queue.querySelector('.label').textContent = state?.queueOpen === false ? 'Show queue on TV' : 'Hide queue on TV';
    }
    if (!active) return;
    const toggle = q('[data-action=toggle]');
    toggle.querySelector('.icon').textContent = state.playing ? '⏸' : '▶';
    toggle.querySelector('.label').textContent = state.playing ? 'Pause' : 'Play';
    const mute = q('[data-action=mute]');
    mute.querySelector('.icon').textContent = state.muted ? '🔈' : '🔇';
    mute.querySelector('.label').textContent = state.muted ? 'Unmute' : 'Mute';
    q('[data-readout=rate]').textContent = `${state.rate}×`;
    q('[data-readout=volume]').textContent = state.muted ? 'Muted' : `${state.volume}%`;
    q('[data-action=slower]').disabled = state.rate <= SPEEDS[0];
    q('[data-action=faster]').disabled = state.rate >= SPEEDS[SPEEDS.length - 1];
  };
}

function btn([action, icon, label]) {
  return `
    <button type="button" class="secondary remote-btn" data-action="${action}" title="${label}">
      <span class="icon">${icon}</span><span class="label">${label}</span>
    </button>`;
}
