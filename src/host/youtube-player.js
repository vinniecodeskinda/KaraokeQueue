// Thin promise-based wrapper around the official YouTube IFrame Player API.
// https://developers.google.com/youtube/iframe_api_reference

let apiPromise;

export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  });
  return apiPromise;
}

/** Error codes the IFrame API reports when a video can't play here. */
export const YT_ERRORS = {
  2: 'Invalid video ID',
  5: 'HTML5 player error',
  100: 'Video not found or private',
  101: 'Uploader disallows embedding',
  150: 'Uploader disallows embedding',
};

/**
 * Create a player inside `elementId` (the element is replaced by an iframe).
 * Resolves once the player is ready to accept commands.
 */
export async function createPlayer(elementId, { onEnded, onError, onPlaying } = {}) {
  const YT = await loadYouTubeApi();
  return new Promise((resolve) => {
    const player = new YT.Player(elementId, {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 1,
        controls: 1,
        rel: 0,              // related videos only from the same channel
        playsinline: 1,
        iv_load_policy: 3,   // hide annotations
        fs: 1,
      },
      events: {
        onReady: () => resolve(player),
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) onEnded?.();
          else if (e.data === YT.PlayerState.PLAYING) onPlaying?.();
        },
        onError: (e) => onError?.(e.data, YT_ERRORS[e.data] ?? 'Playback error'),
      },
    });
  });
}
