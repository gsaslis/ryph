// Where a minted event goes — the webhook mailroom, in whatever process holds it.
//
// The payload is deliberately PROVIDER-NEUTRAL: no RID-shaped types, no COB vocabulary in the
// field names, nothing a GitHub-shaped consumer would have to special-case. `repoRef` happens
// to be a RID and `thread.ref` happens to be a COB id, but the sink's contract is "an opaque
// string the forge can hand back to us", exactly as `owner/name` and `#12` are on GitHub.
//
// This package does NOT know what the other end does with it. Nothing here imports @ryph/forge
// or @ryph/orchestrator; the mailroom wiring is the host's job.

export type BridgeEventKind = BridgeThreadEvent["kind"] | BridgeBranchEvent["kind"];

export type BridgeEvent = BridgeThreadEvent | BridgeBranchEvent;

/** Something that happened in a conversation: a comment, or a change request's fate. */
export interface BridgeThreadEvent {
  /**
   * Stable and derived, never random: `<rid>:<cob>:<op>:<actionIndex>` for a comment or a
   * revision, `<rid>:<cob>:merged:<digest>` (the SHA-256 of every commit that merged, sorted;
   * bare `merged` when the state names none) / `<rid>:<cob>:closed` for a state change. Replaying the
   * same storage state mints the same ids, which is what makes reconcile safe to run as often
   * as we like.
   */
  deliveryId: string;
  kind:
    /** Somebody who is not us said something on an issue or a change request. */
    | "comment.created"
    /** Somebody who is not us opened a change request or pushed a new revision of one. */
    | "change_request.pushed"
    /** A change request we can see reached `merged`. */
    | "change_request.merged"
    /** A change request we can see was archived — Radicle's nearest thing to "closed". */
    | "change_request.closed";
  /** The repository — a RID. */
  repoRef: string;
  /** Who did it. Verified by the node before we ever saw the op, so this is not a claim. */
  actor: { did: string; alias?: string };
  thread: { kind: "issue" | "change_request"; ref: string };
  /** The comment body, for `comment.created`. */
  body?: string;
  /** The id of the comment itself, for `comment.created`. */
  sourceCommentId?: string;
  /** The revision a change-request comment hangs off, when it hangs off one. */
  revision?: string;
  /** For `change_request.merged`, always: what merged — the revision and the commit its merge
   * recorded (the revision's head). Usually one; several only when the change request's state
   * named no single merge, and then a commit is merged when ANY of them holds it. Empty when the
   * change request records no merge with a full commit id. */
  merged?: Array<{ revision: string; commit: string }>;
  /** For `change_request.pushed`: the latest revision by the author of an open change
   * request. */
  changeRequest?: {
    /** The revision's head commit. */
    headSha: string;
    /** The branch it targets: always the repository's default, the only target a Radicle
     * change request has. */
    baseRef: string;
    /** Who opened the change request — its author's DID, where `actor` is the revision's. */
    author: string;
    /** Its page on the configured explorer — an https link, or null. */
    url: string | null;
  };
}

/**
 * The repository's CANONICAL default branch moved — the `refs/heads/<default>` the node
 * computes once the delegates reach quorum, never one peer's copy of it (that is a fork's push,
 * and it builds nothing).
 */
export interface BridgeBranchEvent {
  /** `<rid>:heads/<branch>:<commit>` — derived, so a replay of the same move is one event. */
  deliveryId: string;
  kind: "branch.updated";
  repoRef: string;
  /** Who SAW it: our own node. A canonical ref moves when a quorum agrees, which is nobody's
   * single act, and the field is required on the wire. */
  actor: { did: string; alias?: string };
  /** The default branch's bare name, as the identity document says it now, and its commit. */
  branch: { ref: string; commit: string };
}

/** Same shape as the webhook queue's outcome: a caller can hand a verdict straight to a clock. */
export type DeliverOutcome =
  | { kind: "ok" }
  | { kind: "failed"; message: string; terminal: boolean };

export interface EventSink {
  /** Never throws: the consumer's retry logic needs terminality, not exception shapes. */
  deliver(event: BridgeEvent): Promise<DeliverOutcome>;
}
