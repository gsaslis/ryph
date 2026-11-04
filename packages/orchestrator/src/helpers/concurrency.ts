// Bounded fan-out over the forge: every caller that asks it one question per repo shares the
// same width, so no request — however many repos it names — opens more than that at once.

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, answers in `items` order. An
 * unbounded `Promise.all` would turn one scoped request into one concurrent forge call per repo
 * the deployment has connected.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** How many repos one request asks the forge about at once. */
export const FORGE_CHECK_CONCURRENCY = 5;
