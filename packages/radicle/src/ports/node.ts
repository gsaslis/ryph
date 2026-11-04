// The radicle-node control socket, as a port.
//
// The wire protocol (heartwood `radicle/src/node/command.rs`, `radicle-node/src/control.rs`):
// ONE JSON command per line, written to a freshly connected UNIX socket; the answer is NDJSON
// on the same connection, and the connection is closed afterwards. There is no multiplexing and
// no request id — which is why the adapter opens a connection per call rather than keeping one.
//
// `subscribe` is the exception: it answers events for as long as the node lives. Two facts about
// it shape everything downstream, and both come from heartwood's own comments:
// - the node's channel is bounded (`sync_channel(8192)`) and a slow consumer is DROPPED, so the
//   adapter must read continuously and never apply back-pressure
// - nothing is replayed after a reconnect or a node restart, so an EOF is not "nothing more
//   happened", it is "you have a hole" — which is why it is surfaced as its own stream item
//   rather than as the iterator simply returning.
//
// Unknown `type`s are passed through as-is. A node newer than this bridge must not be able to
// stop the event loop by inventing an event.

/** One event off the control socket. Every event carries `type`; the rest is per variant. */
export interface NodeEvent {
  type: string;
  [field: string]: unknown;
}

/** An update to one git reference, as `refsFetched` reports it (externally tagged). */
export type RefUpdate =
  | { updated: { name: string; old: string; new: string } }
  | { created: { name: string; oid: string } }
  | { deleted: { name: string; oid: string } }
  | { skipped: { name: string; oid: string } };

export interface RefsFetched extends NodeEvent {
  type: "refsFetched";
  remote: string;
  rid: string;
  updated: RefUpdate[];
}

export function isRefsFetched(event: NodeEvent): event is RefsFetched {
  return event.type === "refsFetched" && typeof event.rid === "string" &&
    Array.isArray(event.updated);
}

/** What `subscribe` yields. The EOF item is terminal and always the last one. */
export type NodeStreamItem =
  | { kind: "event"; event: NodeEvent }
  /** The node hung up, the socket died, or the subscription was aborted. Reconcile. */
  | { kind: "eof"; reason: string };

/** The seeding scope. ryph always seeds `all`: a narrower one misses a stranger's comment. */
export type SeedScope = "all" | "followed";

/** Whether the node's policy table actually changed. */
export interface Updated {
  updated: boolean;
}

export interface NodeControl {
  /** The node's own NID (the public key, `z6Mk…` — not the `did:key:` form). */
  nodeId(): Promise<string>;
  /** Resolves when the node answered, rejects when it could not be reached. */
  status(): Promise<{ running: boolean }>;
  seed(rid: string, scope: SeedScope): Promise<Updated>;
  unseed(rid: string): Promise<Updated>;
  /**
   * Fetches `rid` from ONE named peer, bounded by `timeoutMs`.
   *
   * There is no "fetch from anyone" here, and this is not the way the bridge fetches a
   * repository it is seeding: the node refuses a fetch from a peer it has no established
   * session with ("peer … is not connected; cannot initiate fetch"), and the control socket
   * offers nothing that would DIAL a holder the routing table knows about. Fetching from the
   * network goes through `rad sync --fetch` — heartwood's own seed walk — in
   * `core/sync_fetch.ts`.
   */
  fetch(rid: string, nid: string, timeoutMs: number): Promise<unknown[]>;
  /** Gossips our namespaces for `rid`. Best-effort by contract: callers log and carry on. */
  announceRefsFor(rid: string, namespaces: string[]): Promise<unknown>;
  sessions(): Promise<unknown[]>;
  /**
   * The peers the ROUTING TABLE claims hold `rid` — heartwood's `seedsFor`, which is what
   * `rad sync` means by "found N potential seed(s)". It is gossip, not a fetch: a seed listed
   * here may still refuse us.
   *
   * An empty answer is NOT proof that nobody has the repository. A private repository is kept
   * out of every inventory announcement and its refs are announced only to the nodes on its
   * allow list (`radicle-protocol/src/service.rs`), so to a node that is not allowed it looks
   * exactly like a repository nobody is offering.
   */
  seedsFor(rid: string): Promise<unknown[]>;
  /** The live stream. Ends with exactly one `eof` item, whatever killed it. */
  subscribe(signal?: AbortSignal): AsyncIterable<NodeStreamItem>;
}

/** Thrown when the node could not be reached at all — distinct from a command it refused. */
export class NodeUnavailableError extends Error {
  constructor(readonly socket: string, cause: unknown) {
    super(`radicle-node control socket ${socket} is not answering: ${cause}`);
    this.name = "NodeUnavailableError";
  }
}

/** Thrown when the node answered `{"error": …}` to a command. */
export class NodeCommandError extends Error {
  constructor(readonly command: string, reason: string) {
    super(`node refused ${command}: ${reason}`);
    this.name = "NodeCommandError";
  }
}

/**
 * No peer served a repository — with the per-peer reasons, and with the one fact that
 * separates the two readings of it.
 *
 * `triedSeeds` is how many peers BOTH claimed to hold the repository (the routing table) and
 * were actually ASKED for it. Above zero, "somebody who has it refused us" is a fair reading
 * and a private repository is the likeliest cause. At zero, nothing was refused by anybody who
 * has it: there was nobody to ask, or nobody we could dial, which says nothing about
 * visibility. The routing COUNT on its own cannot tell those apart, and a connect flow that
 * reads it as if it could tells people their public repository is private.
 *
 * Raised from two places: a named-peer `fetch` over the control socket, and — the path a seed
 * takes — `rad sync --fetch`, whose own words arrive as `summary`.
 */
export class FetchRefusedError extends NodeCommandError {
  /** The fetcher's own last word, when it said something the per-peer lines do not carry. */
  readonly summary: string | null;
  /** How many seeds the routing table offered, when it was asked. Null when it was not. */
  readonly candidates: number | null;
  /**
   * The fetcher gave up before the NODE did — its own control-socket read timed out, or we cut
   * the subprocess off. Nothing was refused and the fetch may still be running, so this is a
   * "not yet", not a verdict: the next pull is expected to find the refs.
   */
  readonly inProgress: boolean;

  constructor(
    readonly rid: string,
    readonly triedSeeds: number,
    readonly attempts: ReadonlyArray<{ nid: string; reason: string }>,
    extra?: { summary?: string | null; candidates?: number | null; inProgress?: boolean },
  ) {
    const summary = extra?.summary?.trim() || null;
    super(
      "fetch",
      attempts.length === 0
        ? (summary === null ? `no peer served ${rid}` : `no peer served ${rid}: ${summary}`)
        : `no peer served ${rid} (${
          attempts.map((a) => `${a.nid.slice(0, 12)}: ${a.reason}`).join("; ")
        })`,
    );
    this.name = "FetchRefusedError";
    this.summary = summary;
    this.candidates = extra?.candidates ?? null;
    this.inProgress = extra?.inProgress ?? false;
  }
}
