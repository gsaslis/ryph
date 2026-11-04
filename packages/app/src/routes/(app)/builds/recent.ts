// The builds list's rows, as the page holds them: the load's head page plus whatever "Load more"
// appended beneath it, merged as the checks list merges its pages (checks/recent.ts). The head
// re-reads while anything builds, and the poll must not drop the pages the reader asked for.
// Held rows are snapshots: one still building when 50 newer builds push it below the head keeps
// showing "building" until the page reloads.

import type { BuildListItem } from "$lib/api/types";

export interface BuildPageLike {
  builds: BuildListItem[];
  nextCursor: string | null;
}

/** Rows read below the head by "Load more", and the cursor that walks on from them. */
export interface DeeperBuilds {
  /** The filters they were read under: other filters are another list. */
  key: string;
  rows: BuildListItem[];
  cursor: string | null;
}

/** The server's order: `createdAt` then id, both descending, both compared as text. */
function newestFirst(a: BuildListItem, b: BuildListItem) {
  if (a.build.createdAt !== b.build.createdAt) {
    return a.build.createdAt < b.build.createdAt ? 1 : -1;
  }
  if (a.build.id === b.build.id) return 0;
  return a.build.id < b.build.id ? 1 : -1;
}

/**
 * Merges a fresh head page with the rows held beneath it. A held row inside the head's range
 * that the head no longer carries has left the filter; one below it stays. A head with nothing
 * after it is the whole list, and every held row has left it.
 */
export function mergeBuildHead(held: DeeperBuilds | null, page: BuildPageLike): BuildPageLike {
  if (held === null || page.nextCursor === null) return page;
  const oldest = page.builds.at(-1);
  if (oldest === undefined) return { builds: [], nextCursor: page.nextCursor };
  const fresh = new Set(page.builds.map((item) => item.build.id));
  const kept = held.rows.filter((row) => !fresh.has(row.build.id) && newestFirst(row, oldest) > 0);
  return {
    builds: [...page.builds, ...kept].sort(newestFirst),
    nextCursor: kept.length === 0 ? page.nextCursor : held.cursor,
  };
}

/** Folds a "Load more" page into what is held, the head rows it was read under with it. */
export function appendBuildPage(
  held: DeeperBuilds | null,
  key: string,
  head: BuildListItem[],
  page: BuildPageLike,
): DeeperBuilds {
  const rows = held !== null && held.key === key ? held.rows : [];
  // The later read wins a row both carry.
  const byId = new Map<string, BuildListItem>();
  for (const item of [...rows, ...head, ...page.builds]) byId.set(item.build.id, item);
  return { key, rows: [...byId.values()].sort(newestFirst), cursor: page.nextCursor };
}
