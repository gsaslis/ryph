/**
 * How long a tab stays hidden before its streams close. A quick switch to another tab and back
 * keeps them; a tab left in the background lets them go.
 */
export const HIDDEN_CLOSE_MS = 10_000;

/**
 * Holds a stream open only while the page can be seen. `open` starts it and returns how to close
 * it; it is closed once the tab has been hidden for `delay`, and opened again when the tab is
 * visible again. Returns the way to stop for good.
 *
 * Why: a browser allows six HTTP/1.1 connections per host, and every app tab holds up to three
 * SSE streams, so two forgotten tabs can starve the one in use. Every stream that goes through
 * here resyncs on open (a snapshot, or a resume from the last event it delivered), so a reopen
 * loses nothing.
 *
 * Without a `document` (a test that does not stub one) the stream is simply held open.
 */
export function whileVisible(open: () => () => void, delay = HIDDEN_CLOSE_MS): () => void {
  let close: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const doc = typeof document === "undefined" ? null : document;
  const hidden = () => doc?.visibilityState === "hidden";

  const start = () => {
    if (close === null && !stopped) close = open();
  };
  const end = () => {
    const c = close;
    close = null;
    c?.();
  };
  const onChange = () => {
    if (stopped) return;
    if (hidden()) {
      timer ??= setTimeout(() => {
        timer = undefined;
        end();
      }, delay);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    start();
  };

  doc?.addEventListener("visibilitychange", onChange);
  start();
  // A tab opened in the background holds its streams only as long as a hidden one would.
  onChange();
  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    doc?.removeEventListener("visibilitychange", onChange);
    end();
  };
}
