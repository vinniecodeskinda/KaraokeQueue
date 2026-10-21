// Queue state machine for the host screen.
//
// Source of truth is the database: exactly one `queue` row may be 'playing'
// (enforced by a unique index). The controller's job is to keep the
// YouTube player in step with that row:
//
//   Realtime change ─┐
//   ENDED event ─────┼─► serialized task ─► advance_queue() RPC ─► sync()
//   onError / skip ──┘                                         └─► load video
//
// All work runs through one promise chain so a Realtime refresh can never
// interleave with an in-flight advance (which would double-skip songs).
import { advanceQueue, fetchActiveQueue } from '../lib/queue-api.js';

export class QueueController {
  /**
   * @param {object}   opts
   * @param {YT.Player} opts.player  ready YouTube player
   * @param {(state) => void} opts.onChange  called with { playing, upNext } after every sync
   * @param {(msg: string) => void} [opts.onNotice]  transient messages for the TV
   */
  constructor({ player, onChange, onNotice = () => {} }) {
    this.player = player;
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.state = { playing: null, upNext: [] };
    this.loadedRowId = null;   // queue row whose video is loaded in the player
    this.chain = Promise.resolve();
  }

  /** Queue a task; tasks run strictly one at a time. */
  #run(task) {
    this.chain = this.chain.then(task).catch((err) => {
      console.error('[queue]', err);
      this.onNotice(`Queue error: ${err.message ?? err}`);
    });
    return this.chain;
  }

  /** Re-read the queue and reconcile the player. Call on start + every Realtime event. */
  refresh() {
    return this.#run(() => this.#sync());
  }

  /** YouTube ENDED event → mark completed, play the next song. */
  handleEnded() {
    const rowId = this.loadedRowId;
    if (!rowId) return;
    return this.#run(() => this.#advance(rowId, 'completed'));
  }

  /** YouTube onError (e.g. embedding disabled) → skip it so the party keeps going. */
  handleError(code, reason) {
    const rowId = this.loadedRowId;
    if (!rowId) return;
    const title = this.state.playing?.song?.title ?? 'This song';
    this.onNotice(`Skipped “${title}”: ${reason}`);
    return this.#run(() => this.#advance(rowId, 'skipped'));
  }

  /** Manual skip button / keyboard shortcut on the host. */
  skip() {
    const rowId = this.loadedRowId;
    if (!rowId) return;
    return this.#run(() => this.#advance(rowId, 'skipped'));
  }

  async #advance(finishedId, outcome) {
    // Ignore stale events: another host tab may already have moved on.
    if (this.state.playing && this.state.playing.id !== finishedId) return this.#sync();
    await advanceQueue(finishedId, outcome);
    return this.#sync();   // loads the next video, or stops the player if the queue is empty
  }

  async #sync() {
    let { playing, upNext } = await fetchActiveQueue();

    // Nothing playing but songs are waiting → promote the first one.
    // (Covers first start, songs added to an idle queue, and host reloads.)
    if (!playing && upNext.length > 0) {
      await advanceQueue(null);
      ({ playing, upNext } = await fetchActiveQueue());
    }

    this.state = { playing, upNext };

    if (playing && playing.id !== this.loadedRowId) {
      this.loadedRowId = playing.id;
      this.player.loadVideoById(playing.song.youtube_video_id);
    } else if (!playing && this.loadedRowId) {
      this.loadedRowId = null;
      this.player.stopVideo();
    }

    this.onChange(this.state);
  }
}
