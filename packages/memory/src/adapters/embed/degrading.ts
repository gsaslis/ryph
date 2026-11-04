// An embedder that is on by default and must never be the reason anything fails: the single
// binary's. The model loads on first use (a write's claim, a search's query, the backfill), not
// at boot, and when it cannot load (a runtime or weights that are missing, a native library the
// machine refuses) it says so once and gives up for good. `available()` then reads false and the
// service ranks by full-text alone, as if it had no embedder, instead of warning on every write
// and search. A failure after a successful load (a worker that crashed mid-job) is not a reason
// to give up: the worker embedder starts a fresh thread for the next job.

import type { Embedder } from "../../ports/embedder.ts";

export interface LoadableEmbedder extends Embedder {
  load(): Promise<void>;
  close(): Promise<void>;
}

export function degradingEmbedder(
  inner: LoadableEmbedder,
  /** Called once, with the reason, when the first load fails. */
  onUnavailable: (reason: string) => void,
): Embedder & { close(): Promise<void> } {
  let gaveUp: string | null = null;
  // The first load, shared by every caller that arrives while it runs; settled for good after.
  let loading: Promise<void> | null = null;
  const ready = async () => {
    loading ??= inner.load().catch((err) => {
      gaveUp = err instanceof Error ? err.message : String(err);
      onUnavailable(gaveUp);
      void inner.close();
    });
    await loading;
    if (gaveUp !== null) throw new Error(`embeddings are unavailable: ${gaveUp}`);
  };
  return {
    model: inner.model,
    available: () => gaveUp === null,
    async embed(texts, opts) {
      if (texts.length === 0) return [];
      await ready();
      return await inner.embed(texts, opts);
    },
    close: () => inner.close(),
  };
}
