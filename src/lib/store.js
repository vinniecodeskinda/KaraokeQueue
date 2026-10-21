// Browser storage helpers. Both can throw (private mode, blocked storage),
// so every access is guarded and falls back to defaults.
//
// - store:   localStorage — device preferences that should survive closing
//            the app (your name, the karaoke switch, sidebar collapsed).
// - session: sessionStorage — this tab's room session (member key, host
//            key). It survives a reload but is gone once the tab or app is
//            closed, so reopening means joining as a new person.
function wrap(getStorage) {
  return {
    get(key, fallback) {
      try {
        return JSON.parse(getStorage().getItem(key)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        getStorage().setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
  };
}

export const store = wrap(() => localStorage);
export const session = wrap(() => sessionStorage);
