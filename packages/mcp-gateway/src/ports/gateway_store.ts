// Persistence, as the core sees it — a dumb row-holder, same doctrine as the model-proxy's
// KeyStore: every decision (sealing, minting, the data plane's allow/deny) happens elsewhere
// and lands here fully formed.
//
// Where two writers can race, the store answers atomically instead of trusting a read made
// before the write: a slug's liveness is the database's unique index, an edit touches only the
// fields it names, archiving is one-way, and a revoked run stays revoked for keys minted later.

import type { McpServer, McpUsageRecord, McpVirtualKey } from "../core/types.ts";

/**
 * What an edit may change on a server row — the operator's fields, and the container state the
 * hosting service owns. Never `archivedAt`: archiving has its own write.
 */
export type McpServerEdit =
  & Partial<
    Pick<
      McpServer,
      "name" | "description" | "url" | "auth" | "encryptedAuth" | "authLast4" | "settings" | "host"
    >
  >
  & Pick<McpServer, "updatedAt">;

export interface GatewayStore {
  /** Inserts a server, or answers "slug_taken" when a LIVE row already carries its slug. */
  createServer(server: McpServer): Promise<"created" | "slug_taken">;
  getServer(id: string): Promise<McpServer | null>;
  /** The LIVE row carrying this slug, if any — archived rows free their slug for reuse. */
  getLiveServerBySlug(slug: string): Promise<McpServer | null>;
  /** Newest first, archived included (they still anchor historical runs). */
  listServers(): Promise<McpServer[]>;
  /**
   * Full-row write keyed by server.id. It may SET archivedAt but never clears it: archiving is
   * one-way, so a stale row written over a concurrent archive cannot bring the server back.
   */
  saveServer(server: McpServer): Promise<void>;
  /** Writes exactly the named fields, and returns the row as stored — null when there is none. */
  updateServer(id: string, edit: McpServerEdit): Promise<McpServer | null>;
  /**
   * `updateServer`, only while `holds` says yes of the row as it stands at the write — read and
   * written atomically, so no other edit lands between the two. "changed" when it said no, null
   * when there is no such row. How a credential is written: sealed for the row's destination as
   * read (its url, settings, container), it lands only while the row still has that destination.
   */
  updateServerIf(
    id: string,
    edit: McpServerEdit,
    holds: (current: McpServer) => boolean | Promise<boolean>,
  ): Promise<McpServer | null | "changed">;
  /**
   * Sets every hosted row's url to its marker (`hosted://<slug>`) where it is not already, in one
   * write, and says how many changed. Rows created before the marker kept the guard url they were
   * created with; nothing dials it, and the API should not show it.
   */
  markHostedUrls(): Promise<number>;
  /**
   * Stamps archivedAt unless it is already set, and wipes the sealed credential; the row as
   * stored, or null when there is none. No later write puts a credential back on an archived row.
   */
  archiveServer(id: string, at: string): Promise<McpServer | null>;

  /** Inserts a key, or answers "run_revoked" when its run's credentials were already revoked. */
  createVirtualKey(key: McpVirtualKey): Promise<"created" | "run_revoked">;
  /**
   * The data plane's per-request lookup: the presented token, hashed. `revokedAt` is set when
   * the KEY or its RUN was revoked, read in one statement — so a key that landed after its run's
   * revocation (an issue racing the revoke) is dead however the two writes interleaved.
   */
  getVirtualKeyByTokenHash(tokenHash: string): Promise<McpVirtualKey | null>;
  /**
   * Revokes a run for good: records the run as revoked, then stamps revokedAt on every live key
   * of it. Idempotent; the first revocation's time stands.
   */
  revokeVirtualKeysForRun(runId: string, at: string): Promise<void>;

  /** Append-only audit trail, one row per forwarded (or refused) JSON-RPC request. */
  recordUsage(record: McpUsageRecord): Promise<void>;
  /**
   * One page of a run's trail: the NEWEST `limit` rows, oldest-first within the page. Never the
   * whole trail — how many rows a run has is the agent's decision, not ours (a denied call is
   * refused before the upstream dial and still writes a row), so a reader that asked for no
   * bound gets `MAX_USAGE_PAGE` rows and a cursor rather than everything the run wrote.
   */
  listUsageForRun(runId: string, query?: UsageQuery): Promise<UsagePage>;
  close(): Promise<void>;
}

/** The most rows one read may return, whatever it asked for. */
export const MAX_USAGE_PAGE = 200;

export interface UsageQuery {
  /** Rows to return, counted from the newest. Clamped to 1…`MAX_USAGE_PAGE`. */
  limit?: number;
  /** The previous page's `nextCursor`: keep walking backwards from where it stopped. */
  cursor?: string;
}

export interface UsagePage {
  /** Oldest first, so a page reads like the slice of the trail it is. */
  records: McpUsageRecord[];
  /**
   * Opaque to every caller — pass it back as `cursor` for the next, older page. Null when this
   * page reached the run's first call.
   */
  nextCursor: string | null;
}

/** A page size an adapter will honour: whole, at least one row, never past the cap. */
export function clampUsageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_USAGE_PAGE;
  return Math.min(MAX_USAGE_PAGE, Math.max(1, Math.floor(limit)));
}

/**
 * A cursor, as every adapter spells it: the decimal row counter the previous page stopped at.
 * Anything else — a client's invention, a cursor from another deployment — reads as no cursor,
 * which starts at the newest row. Callers that care refuse a malformed cursor before this.
 */
export function usageCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || !/^\d{1,19}$/.test(cursor)) return null;
  const seq = Number(cursor);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}
