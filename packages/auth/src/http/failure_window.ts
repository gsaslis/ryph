// A per-process failed-attempt budget: `attempts` failures per key per `windowMs`, counted from
// the key's first failure. The map stays bounded however many distinct keys fail: entries sit in
// window-start order (a fresh window re-inserts its key at the back), so every write drops the
// expired run at the front and stops at the first live entry, and past `maxEntries` the oldest
// windows go first. Each entry is dropped once, so the sweep is amortized O(1) per write.

export interface FailureWindowOptions {
  attempts: number;
  windowMs: number;
  now(): Date;
  /** The most keys tracked at once. Past it the oldest window is forgotten early. */
  maxEntries?: number;
}

export interface FailureWindow {
  isLimited(key: string): boolean;
  recordFailure(key: string): void;
  /** How many keys are tracked right now. */
  readonly size: number;
}

export function failureWindow(opts: FailureWindowOptions): FailureWindow {
  const maxEntries = opts.maxEntries ?? 100_000;
  const failures = new Map<string, { count: number; windowStartMs: number }>();
  const expired = (entry: { windowStartMs: number }, nowMs: number): boolean =>
    nowMs - entry.windowStartMs > opts.windowMs;

  const sweep = (nowMs: number): void => {
    for (const [key, entry] of failures) {
      if (!expired(entry, nowMs) && failures.size < maxEntries) return;
      failures.delete(key);
    }
  };

  return {
    isLimited(key) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (expired(entry, opts.now().getTime())) {
        failures.delete(key);
        return false;
      }
      return entry.count >= opts.attempts;
    },
    recordFailure(key) {
      const nowMs = opts.now().getTime();
      const entry = failures.get(key);
      if (entry && !expired(entry, nowMs)) {
        entry.count += 1;
        return;
      }
      // Delete first so the fresh window lands at the back and the order stays by window start.
      failures.delete(key);
      sweep(nowMs);
      failures.set(key, { count: 1, windowStartMs: nowMs });
    },
    get size() {
      return failures.size;
    },
  };
}
