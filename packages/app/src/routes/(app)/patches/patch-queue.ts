// The approval queue's rows, as the page holds them: the load's head page plus whatever
// "Load more" has appended beneath it, merged the way LiveTaskList merges a task list.
//
// Its own module because the merge is the interesting part and it is worth testing away from
// the markup. The rule it exists to enforce: THE POLLER MUST NOT EAT THE DEEPER PAGES. The head
// re-reads every five seconds while anything is advancing, and a merge that compared the head
// by array identity threw away every page the reader had asked for each time it did.

import type { PatchWithContext } from "$lib/api/types";

/** A page of the queue, as `GET /v1/patches` answers it. */
export interface PatchPageLike {
  patches: PatchWithContext[];
  nextCursor: string | null;
}

/** Rows fetched BELOW the head by "Load more", and the cursor that walks on from them. */
export interface DeeperPatches {
  /** The state filter they were read under — a different one is a different queue. */
  key: string;
  rows: PatchWithContext[];
  cursor: string | null;
}

/** What the page draws. */
export interface MergedPatches {
  rows: PatchWithContext[];
  cursor: string | null;
}

/**
 * Newest first, ties broken by id — the server's `ORDER BY created_at DESC, id DESC`. Both
 * columns are text there and the timestamps are ISO-8601, so comparing the strings here is the
 * same comparison the database made.
 */
export function newestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Merge a fresh head page with the rows held beneath it.
 *
 * A head page can only speak about its OWN range. A held row inside that range which the page
 * did not carry has left the filter; a held row below the page's oldest sits in the part nobody
 * has paged past, and the page's silence says nothing about it — so it stays.
 *
 * `held` null (or belonging to another filter) means there is nothing beneath: the page is the
 * whole queue.
 */
export function mergePatchHead(
  held: DeeperPatches | null,
  page: PatchPageLike,
): MergedPatches {
  if (held === null) return { rows: page.patches, cursor: page.nextCursor };

  const oldest = page.patches.at(-1);
  // An empty head under this filter means nothing matches it at all — including anything the
  // reader had paged to, which was read under the same predicate.
  if (oldest === undefined) return { rows: [], cursor: page.nextCursor };

  const fresh = new Set(page.patches.map((patch) => patch.id));
  const kept = held.rows.filter((row) => !fresh.has(row.id) && newestFirst(row, oldest) > 0);
  return {
    rows: [...page.patches, ...kept].sort(newestFirst),
    // A cursor already held points past rows this page never reached, so it still stands, and
    // a null one says the reader has paged to the end. Only a queue that is nothing but this
    // page takes the page's own.
    cursor: kept.length === 0 ? page.nextCursor : held.cursor,
  };
}

/**
 * Fold a "Load more" page into what is held. The head rows it was read under are held as well:
 * once newer patches arrive, the head's oldest rows fall out of the next head page, and without
 * a held copy they would vanish from between the head and the pages read below it.
 */
export function appendPatchPage(
  held: DeeperPatches | null,
  key: string,
  head: PatchWithContext[],
  page: PatchPageLike,
): DeeperPatches {
  const rows = held !== null && held.key === key ? held.rows : [];
  // A row read twice keeps its later copy.
  const byId = new Map<string, PatchWithContext>();
  for (const patch of [...rows, ...head, ...page.patches]) byId.set(patch.id, patch);
  return { key, rows: [...byId.values()].sort(newestFirst), cursor: page.nextCursor };
}
