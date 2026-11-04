// A tiny LRU with a short TTL, holding converted pages by the URL the AGENT asked for.
//
// It exists for one access pattern, which is the common one: a page longer than a slice is read
// by calling `web__fetch` again with the next offset, and without a cache every one of those
// calls would re-fetch the page over the network and re-convert it — the expensive half — to
// hand back a different 50 KB of the same string. With it, paging a document costs one fetch.
//
// Keyed on the REQUESTED url, because that is what a repeat call carries; the entry remembers
// the final URL it resolved to, so a redirect chain is walked once too. Bounded on both axes
// (entries, and total characters held) because an entry is a whole page of markdown, and a
// service that keeps eight of them is a service holding sixteen megabytes for nobody.

/** What the cache holds. Opaque here — core/page.ts decides what a page is. */
export interface PageCache<T> {
  get(key: string): T | null;
  set(key: string, value: T, weight: number): void;
  /** Entries currently held; for tests and the service's debug line. */
  readonly size: number;
}

export interface PageCacheOptions {
  /** How many pages at most. */
  max?: number;
  /** How many characters all entries may hold together. */
  maxChars?: number;
  /** How long an entry stays usable. Short on purpose: a page an agent re-reads is the same
   * page, but a page it comes back to in an hour should be fetched again. */
  ttlMs?: number;
  now?(): number;
}

export function makePageCache<T>(options: PageCacheOptions = {}): PageCache<T> {
  const max = options.max ?? 4;
  const maxChars = options.maxChars ?? 4 * 1024 * 1024;
  const ttlMs = options.ttlMs ?? 120_000;
  const now = options.now ?? (() => Date.now());
  // Insertion order IS the LRU order: a hit deletes and re-sets, which moves it to the end.
  const entries = new Map<string, { value: T; weight: number; at: number }>();
  let held = 0;

  const drop = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    held -= entry.weight;
    entries.delete(key);
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (now() - entry.at > ttlMs) {
        drop(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, weight) {
      drop(key);
      // A page too big to share the cache with anything else is simply not cached: keeping it
      // would evict everything and then be evicted by the next one.
      if (weight > maxChars) return;
      entries.set(key, { value, weight, at: now() });
      held += weight;
      while (entries.size > max || held > maxChars) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
