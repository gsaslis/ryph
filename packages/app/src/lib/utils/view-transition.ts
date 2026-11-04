// The page transition the root layout starts on each navigation, so that anything below it can wait
// for the animation to end rather than only for the new page to render: `navigation.complete`
// resolves as the new DOM lands, while the old and new snapshots are still moving.
let finished: Promise<void> = Promise.resolve();

/** Called by the root layout with each transition it starts. */
export function trackViewTransition(transition: ViewTransition) {
  finished = transition.finished.catch(() => {});
}

/** Resolves once the latest page transition is over, or at once if none is running. */
export function viewTransitionFinished(): Promise<void> {
  return finished;
}

/**
 * Whether to animate with the View Transitions API. WebKit (Safari on macOS, every browser on iOS)
 * ships it but renders our transitions broken, so it takes the same path as a browser without it.
 */
export function viewTransitionsEnabled(): boolean {
  if (!document.startViewTransition) return false;
  const ua = navigator.userAgent;
  return !(/AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua));
}
