// Persistence, as the core sees it — a dumb row-holder, same doctrine as the orchestrator's
// TaskStore: every decision (sealing, minting, the proxy's allow/deny) happens elsewhere and
// lands here fully formed.

import type {
  CustomProvider,
  CustomProviderPatch,
  PlanSignIn,
  PlatformModelPolicy,
  ProviderKey,
  ProviderKeyPatch,
  UsageRecord,
  VirtualKey,
} from "../core/types.ts";
import type { UsageAggregateQuery, UsageAggregateRow } from "../core/usage_report.ts";

/** The custom endpoint a secret was sealed for, and that endpoint's shape (`endpointShape`) as
 * it was sealed for. */
export interface SealedForEndpoint {
  providerId: string;
  shape: string;
}

/** A guarded secret write: refused (`moved`) when the endpoint's shape is no longer the one the
 * secret was sealed for, or the key as written (null: no such key). */
export type GuardedKeyWrite = { moved: true } | { moved: false; key: ProviderKey | null };

export interface KeyStore {
  createProviderKey(key: ProviderKey): Promise<void>;
  /**
   * Writes a key whose secret was sealed for a custom endpoint — `createProviderKey` when
   * `create`, else the `updateProviderKey` patch — only while that endpoint's shape is still
   * `sealedFor.shape`, checked and written in one transaction holding the endpoint row against
   * `updateCustomProvider` (which holds it to change the shape and drop the keys' secrets). So
   * the two serialise: a secret sealed for the old shape is either written before the move,
   * which then drops it, or refused after it — never left behind holding a value nothing opens.
   */
  writeProviderKeySealedFor(
    sealedFor: SealedForEndpoint,
    write: { create: ProviderKey } | { id: string; patch: ProviderKeyPatch },
  ): Promise<GuardedKeyWrite>;
  getProviderKey(id: string): Promise<ProviderKey | null>;
  /** Newest first, archived included (they still anchor historical runs). */
  listProviderKeys(): Promise<ProviderKey[]>;
  /** Full-row upsert keyed by key.id. Not for edits, which are `updateProviderKey` patches: a
   * whole row read earlier would put back whatever changed since (a plan key's rotated tokens). */
  saveProviderKey(key: ProviderKey): Promise<void>;
  /**
   * Partial write keyed by id; null when there is no such row. What a ChatGPT plan key's two
   * writers use: the token refresh writes the sealed secret and the data plane writes the
   * status, and a whole-row write from either would put back what the other just changed.
   */
  updateProviderKey(id: string, patch: ProviderKeyPatch): Promise<ProviderKey | null>;
  /**
   * Runs `fn` holding a lock on one provider key that every process on this database honours —
   * what keeps two replicas from refreshing one rotating refresh token at once, which OpenAI
   * answers by revoking it. Waits for the lock rather than failing; a wait past its bound
   * throws. NOT re-entrant, and not a guarantee against callers in the same process (a single
   * PGlite connection holds every lock at once): the caller queues its own per key first
   * (plan_keys.ts `exclusive`), and never takes it from inside `fn`.
   */
  withProviderKeyLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Replaces the sealed secret only while it is still `expected`: true when it was replaced,
   * false when the row moved on (or is gone). How a refreshed token set is written back, so a
   * write can never land on top of one it did not start from.
   */
  replaceProviderKeySecret(
    id: string,
    expected: string,
    next: string,
    at: string,
  ): Promise<boolean>;
  /**
   * Marks a plan key `needs_reauth` only while its sealed secret is still `expected` — the value
   * found unreadable. A sign-in or refresh that wrote a new token set since is not undone by a
   * verdict about the old one. True when it changed the row.
   */
  markPlanNeedsReauth(id: string, expected: string, at: string): Promise<boolean>;
  /** Marks a plan key `limited`, unless it is `needs_reauth` (which says more). True when it
   * changed the row. */
  markPlanLimited(id: string, at: string): Promise<boolean>;
  /** Puts a `limited` plan key back to `active`; any other status is left as it is. True when it
   * changed the row. */
  clearPlanLimited(id: string, at: string): Promise<boolean>;

  /** This deployment's `ext_agent_host_id`: the stored one, or `candidate` stored and returned
   * when none is. Minted once, never changed. */
  claimAgentHostId(candidate: string, at: string): Promise<string>;
  createSignIn(row: PlanSignIn): Promise<void>;
  getSignIn(id: string): Promise<PlanSignIn | null>;
  getSignInByState(state: string): Promise<PlanSignIn | null>;
  /**
   * Moves a PENDING, unexpired sign-in to `exchanging` and returns it; null when it was not
   * pending (another completion took it) or has expired. The one guard that a code is
   * exchanged once, however many times the browser's return arrives.
   */
  claimSignIn(id: string, nowIso: string): Promise<PlanSignIn | null>;
  finishSignIn(
    id: string,
    outcome: {
      status: "done" | "failed" | "pending";
      error: string | null;
      resultKeyId: string | null;
      at: string;
    },
  ): Promise<void>;
  /** Deletes sign-ins that expired before `before`, finished or not. */
  pruneSignIns(before: string): Promise<void>;

  /**
   * Every registered custom endpoint, ARCHIVED INCLUDED — callers filter. The archived ones are
   * needed as often as the live ones: a historical usage row is priced from a declared model,
   * and `resolveProvider` must still answer for a run whose endpoint was archived mid-flight so
   * the proxy can refuse it with a 403 rather than a "no such provider" 502.
   */
  listCustomProviders(): Promise<CustomProvider[]>;
  getCustomProvider(id: string): Promise<CustomProvider | null>;
  createCustomProvider(row: CustomProvider): Promise<void>;
  /**
   * Partial write keyed by id; null when there is no such row. A patch that CHANGES the
   * endpoint's request shape (`endpointShape`: `baseUrl`, `authHeader`, `authScheme`,
   * `extraHeaders`) also drops the sealed secret of every key registered against this endpoint
   * (to `NO_SECRET`), in the same transaction: each was sealed for the old shape, and is entered
   * again rather than ever being sent with the new one. Answers how many LIVE keys lost a
   * secret that way (`keysCleared`), so the caller can say so.
   */
  updateCustomProvider(
    id: string,
    patch: CustomProviderPatch,
  ): Promise<{ provider: CustomProvider; keysCleared: number } | null>;
  /** The kill switch, idempotent: an already-archived row keeps its original timestamp. */
  archiveCustomProvider(id: string, at: string): Promise<void>;

  createVirtualKey(key: VirtualKey): Promise<void>;
  /** The proxy's per-request lookup: the presented token, hashed. */
  getVirtualKeyByTokenHash(tokenHash: string): Promise<VirtualKey | null>;
  /** Stamps revokedAt on every live virtual key of a run — the run concluded, its credentials die. */
  revokeVirtualKeysForRun(runId: string, at: string): Promise<void>;
  /**
   * Stamps revokedAt on every live virtual key held by a PLATFORM principal — every row whose
   * runId starts with `PLATFORM_PRINCIPAL_PREFIX`, whichever consumer minted it. What a change
   * to the platform model policy runs: the outstanding credentials were minted against the old
   * key and the old allowlist, and a policy edit that left them spending would be no edit at all.
   */
  revokePlatformVirtualKeys(at: string): Promise<void>;

  /** The platform's own policy: one row, or none when no admin has set it. */
  getPlatformPolicy(): Promise<PlatformModelPolicy | null>;
  savePlatformPolicy(policy: PlatformModelPolicy): Promise<void>;
  clearPlatformPolicy(): Promise<void>;

  /** Append-only metering trail, one row per forwarded request. */
  recordUsage(record: UsageRecord): Promise<void>;
  /** Oldest first. */
  listUsageForRun(runId: string): Promise<UsageRecord[]>;
  /**
   * The trail's sums, grouped by each of `query.by` × provider × model × tier bucket, where a
   * row's tier bucket is the highest of `query.tierThresholds` its total input (uncached +
   * cache read + cache write) exceeds, or 0. Pricing happens above this; the store only ever
   * adds. One array of rows per dimension, in the order asked.
   *
   * Every dimension is summed from THE SAME rows at the same moment. That is why the dimensions
   * arrive together rather than one call each: a row's `at` is when its request STARTED, but the
   * row is written when the response body ends, so a ninety-second stream that began inside the
   * window is inserted mid-report — missed by one breakdown, counted by the next, and the
   * report stops adding up to its own totals.
   */
  aggregateUsage(query: UsageAggregateQuery): Promise<UsageAggregateRow[][]>;
  close(): Promise<void>;
}
