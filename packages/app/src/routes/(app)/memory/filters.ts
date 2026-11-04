// The browse page's filters, as URL query parameters: read leniently (an unknown value is "any"),
// written only when set, so a filtered view is a link. Pure, so the parsing is unit-tested.

import {
  type Memory,
  type MemoryKind,
  memoryKindSchema,
  type MemoryStatus,
  memoryStatusSchema,
  type MemoryTrust,
  memoryTrustSchema,
} from "$lib/api/types";
import type { MemoryFilters } from "$lib/api/memory";

export interface BrowseFilters {
  /** "" = every subject; else `org` or `repo:<url>`. */
  subject: string;
  /** "" = every audience; else `all` or `agent:<id>`. */
  audience: string;
  kind: MemoryKind | "";
  status: MemoryStatus | "";
  trust: MemoryTrust | "";
  q: string;
}

/** The status a fresh visit opens on: the canon, plus what needs a look — never the retired. */
export const DEFAULT_STATUS: BrowseFilters["status"] = "";

const SUBJECT = /^(org|repo:.+)$/;
const AUDIENCE = /^(all|agent:.+)$/;

export function parseFilters(params: URLSearchParams): BrowseFilters {
  const subject = params.get("subject") ?? "";
  const audience = params.get("audience") ?? "";
  const kind = memoryKindSchema.safeParse(params.get("kind"));
  const status = memoryStatusSchema.safeParse(params.get("status"));
  const trust = memoryTrustSchema.safeParse(params.get("trust"));
  return {
    subject: SUBJECT.test(subject) ? subject : "",
    audience: AUDIENCE.test(audience) ? audience : "",
    kind: kind.success ? kind.data : "",
    status: status.success ? status.data : "",
    trust: trust.success ? trust.data : "",
    q: (params.get("q") ?? "").trim(),
  };
}

/** The query string for a filter set — empty when nothing is set. */
export function filtersToSearch(filters: BrowseFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== "") params.set(key, value);
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

/** How many memories one page of the list shows; "Show more" reads the next this many. */
export const PAGE_SIZE = 100;

/**
 * The same filters as the API takes them, for the page starting `offset` rows in. Unset means
 * "any" everywhere. One row past the page is asked for, so `splitPage` can tell whether another
 * page follows without a count.
 */
export function toApiFilters(filters: BrowseFilters, offset = 0): MemoryFilters {
  return {
    ...(filters.subject ? { subject: filters.subject } : {}),
    ...(filters.audience ? { audience: filters.audience } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.trust ? { trust: filters.trust } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    limit: PAGE_SIZE + 1,
    ...(offset > 0 ? { offset } : {}),
  };
}

/** A page as read with `toApiFilters`: its rows, and whether the probe row says more follow. */
export function splitPage(rows: Memory[]): { memories: Memory[]; hasMore: boolean } {
  return { memories: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

/**
 * The pages read so far, as one list. An offset walk over a list that changes between reads can
 * hand back a row twice (a memory written meanwhile shifts the rest down one), so a row already
 * shown is not shown again.
 */
export function joinPages(pages: Memory[][]): Memory[] {
  const seen = new Set<string>();
  return pages.flat().filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}
