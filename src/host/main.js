import QRCode from 'qrcode';
import '../styles/base.css';
import '../styles/host.css';
import { showDemoBanner } from '../lib/supabase.js';
import { isDemo, subscribeToQueue } from '../lib/queue-api.js';
import { createPlayer } from './youtube-player.js';
import { QueueController } from './queue-controller.js';
import { escapeHtml } from '../lib/dom.js';

const $ = (id) => document.getElementById(id);

if (isDemo) showDemoBanner();
init();

function init() {
  renderJoinCode();
  $('start-btn').addEventListener('click', start, { once: true });
}

async function start() {
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading…';

  let controller;
  const player = await createPlayer('player', {
    onEnded: () => controller?.handleEnded(),
    onError: (code, reason) => controller?.handleError(code, reason),
  });

  controller = new QueueController({ player, onChange: render, onNotice: toast });

  subscribeToQueue(
    () => controller.refresh(),
    (status) => $('conn').dataset.status = status,
  );

  $('skip-btn').addEventListener('click', () => controller.skip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' || e.key === 'N') controller.skip();
  });

  $('start-overlay').remove();
  await controller.refresh();
}

function render({ playing, upNext }) {
  $('idle').hidden = Boolean(playing);
  $('now-playing').hidden = !playing;
  if (playing) {
    $('np-guest').textContent = playing.guest_name;
    $('np-song').textContent = `${playing.song.title} — ${playing.song.artist}`;
  }

  $('up-next-count').textContent = upNext.length;
  $('up-next').innerHTML = upNext.length
    ? upNext
        .map(
          (row) => `
          <li>
            <span class="song">${escapeHtml(row.song.title)}</span>
            <span class="meta">${escapeHtml(row.song.artist)} · <b>${escapeHtml(row.guest_name)}</b></span>
          </li>`,
        )
        .join('')
    : '<li class="empty">Queue is empty — add a song from your phone!</li>';
}

function renderJoinCode() {
  const joinUrl = new URL('/', location.href).href;
  $('join-url').textContent = joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  QRCode.toCanvas($('join-qr'), joinUrl, { width: 160, margin: 1 }).catch(console.error);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}
