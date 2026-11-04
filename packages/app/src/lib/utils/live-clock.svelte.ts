/** A one-second display clock, stopped when nothing is running or its owner unmounts. */
export function liveClock(active: () => boolean): { readonly now: number } {
  let now = $state(Date.now());
  $effect(() => {
    if (!active()) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(timer);
  });
  return {
    get now() {
      return now;
    },
  };
}
