// The Recent list's rows, as the page holds them: the load's head page plus whatever "Load more"
// appended beneath it, merged the way the approval queue merges its pages (patch-queue.ts). The
// head re-reads while anything runs, and the poll must not drop the pages the reader asked for.
// Held rows are snapshots and are never read again: one still running when 50 newer suites push
// it below the head keeps showing "running" until the page reloads. Accepted, as it is rare.

import type { CheckSuiteListItem } from "$lib/api/types";

/** A page of the list, as `GET /v1/check-suites` answers it. */
export interface SuitePageLike {
  suites: CheckSuiteListItem[];
  nextCursor: string | null;
}

/** Rows read below the head by "Load more", and the cursor that walks on from them. */
export interface DeeperSuites {
  /** The filters they were read under: other filters are another list. */
  key: string;
  rows: CheckSuiteListItem[];
  cursor: string | null;
}

/** The server's order: `createdAt` then id, both descending, both compared as text. */
function newestFirst(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

const byNewest = (a: CheckSuiteListItem, b: CheckSuiteListItem) => newestFirst(a.suite, b.suite);

/**
 * Merges a fresh head page with the rows held beneath it. A held row inside the head's range
 * that the head no longer carries has left the filter; one below it stays. A head with nothing
 * after it is the whole list, and every held row has left it.
 */
export function mergeSuiteHead(
  held: DeeperSuites | null,
  page: SuitePageLike,
): SuitePageLike {
  if (held === null || page.nextCursor === null) return page;
  const oldest = page.suites.at(-1);
  if (oldest === undefined) return { suites: [], nextCursor: page.nextCursor };
  const fresh = new Set(page.suites.map((item) => item.suite.id));
  const kept = held.rows.filter((row) =>
    !fresh.has(row.suite.id) && newestFirst(row.suite, oldest.suite) > 0
  );
  return {
    suites: [...page.suites, ...kept].sort(byNewest),
    // Held rows walk on from the held cursor, and a null one there is the end of the list.
    nextCursor: kept.length === 0 ? page.nextCursor : held.cursor,
  };
}

/**
 * Folds a "Load more" page into what is held. The head rows it was read under are held too: a
 * newer row arriving at the head pushes its oldest out of the next head page, and only the held
 * copy keeps them on screen.
 */
export function appendSuitePage(
  held: DeeperSuites | null,
  key: string,
  head: CheckSuiteListItem[],
  page: SuitePageLike,
): DeeperSuites {
  const rows = held !== null && held.key === key ? held.rows : [];
  // The later read wins a row both carry.
  const byId = new Map<string, CheckSuiteListItem>();
  for (const item of [...rows, ...head, ...page.suites]) byId.set(item.suite.id, item);
  return { key, rows: [...byId.values()].sort(byNewest), cursor: page.nextCursor };
}
