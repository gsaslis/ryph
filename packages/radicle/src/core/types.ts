// The shapes the bridge answers with — the contract a forge-side client is written against.
//
// These are NOT Radicle's shapes. `rad cob show` returns the materialized COB with maps keyed by
// op id, timestamps in epoch milliseconds, authors as bare public keys in some places and
// `did:key:` in others, and a patch's discussion split across revisions. All of that is
// normalized here into flat arrays, ISO timestamps and one spelling of "who" — so that the
// GitHub-shaped code on the other side has one less dialect to learn.
//
// Vocabulary: a Radicle PATCH is a CHANGE REQUEST here.

/** A repository's identity document, plus what it means for us. */
export interface RepoIdentity {
  rid: string;
  name: string;
  description: string;
  defaultBranch: string;
  /** Delegate DIDs, in document order. */
  delegates: string[];
  threshold: number;
  visibility: "public" | "private";
  /** For a private repo, the DIDs allowed to fetch it. Empty for a public one. */
  allow: string[];
  /** Our own identity, so a caller never needs a second round trip to interpret the rest. */
  self: { did: string; nid: string; alias: string | null };
  /** Whether our DID is in `delegates` — the capability probe. */
  isDelegate: boolean;
  /** Whether we may fetch it: public, or private with our DID in `allow`. */
  isAllowed: boolean;
}

export interface Actor {
  did: string;
  alias?: string;
}

/** One comment, wherever it hangs. `replyTo` is null for a top-level comment. */
export interface CommentView {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  editedAt: string | null;
  replyTo: string | null;
  /** Emoji, deduplicated, in the order the COB lists them. */
  reactions: string[];
  /** For a change request: the revision the comment hangs off. Absent on issues. */
  revision?: string;
  /** For a review remark: the file and line it points at. */
  location?: CommentLocation;
  /** The files the comment embeds (its latest edit's), in the order the COB lists them.
   * Absent when there are none — heartwood's own shape. */
  embeds?: EmbedView[];
}

/**
 * A file a comment, a revision's description or a review's summary embeds: a git blob in the
 * repository's storage, named by its object id. The body links it by that id, as
 * `[name](<oid>)` — what Radicle Desktop writes — and `GET …/embeds/:oid` serves its bytes.
 */
export interface EmbedView {
  name: string;
  oid: string;
}

export interface CommentLocation {
  path: string;
  commit: string;
  /** The first line of the range, 1-based — what a human calls "the line". */
  line: number | null;
  side: "old" | "new";
}

export type IssueState = "open" | "closed";

export interface IssueView {
  id: string;
  title: string;
  author: Actor;
  state: IssueState;
  /** `solved` or `other`, when closed. */
  closeReason: string | null;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  /** The opening post — the root comment's body, also present as `comments[0]`. */
  body: string;
  comments: CommentView[];
}

/** Radicle's four patch states, under ryph's names. `draft` and `archived` are Radicle's
 * own words; `closed` is what an archived change request becomes on the event boundary. */
export type ChangeState = "draft" | "open" | "archived" | "merged";

export interface RevisionView {
  id: string;
  base: string;
  head: string;
  description: string;
  timestamp: string;
  author: Actor;
  /** What the description (its latest edit) embeds; absent when nothing. */
  embeds?: EmbedView[];
}

export interface ReviewView {
  id: string;
  author: Actor;
  revision: string;
  verdict: "accept" | "reject" | null;
  summary: string | null;
  /** What the summary (its latest edit) embeds; absent when nothing. */
  summaryEmbeds?: EmbedView[];
  createdAt: string;
  comments: CommentView[];
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "changed";
  insertions: number;
  deletions: number;
  /** The path it came from, for a rename or a copy. */
  previousPath?: string;
}

export interface DiffStat {
  base: string;
  head: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: FileChange[];
}

export interface ChangeView {
  id: string;
  title: string;
  author: Actor;
  state: ChangeState;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  /** The merge target, as the COB records it: `delegates`, or a branch name. */
  target: string;
  /** The latest revision's base and head — the two shas a client actually wants. The newest
   * revision overall, whoever pushed it: a run that revised somebody's change request reads its
   * own revision back here. */
  base: string;
  head: string;
  /** The head of the latest revision by the change request's AUTHOR — heartwood's
   * `Patch::latest`. Anybody may add a revision to anybody's change request; this is the head
   * that is the change request's own, the one a push event names (see `latestByAuthor`). */
  authorHead: string;
  description: string;
  revisions: RevisionView[];
  reviews: ReviewView[];
  /** Every revision discussion, flattened and ordered; each carries its `revision`. */
  comments: CommentView[];
  merges: Array<{ did: string; revision: string; commit: string; timestamp: string }>;
  /** The revision a merged change request merged at, and the commit its merge recorded (the
   * revision's head, as `git push` onto the default branch writes it) — the one a threshold of
   * delegates agreed on, as the COB's own state names it. Null unless merged. */
  mergedRevision: { revision: string; commit: string } | null;
  /** The latest revision's diff against its base, computed with git against storage. Null when
   * the objects are not (yet) in storage — a change request fetched from a peer whose pack we
   * have the COB for but not the commits. */
  files: DiffStat | null;
}

/** What a submitted change answers with. */
export interface SubmitResult {
  /** The change request's COB id — what `patches.forge_ref` stores. */
  ref: string;
  /** The revision this submission created, or the existing one when nothing changed. */
  revision: string;
  /** Whether anything was actually written — false for an identical head+base re-submit. */
  created: boolean;
  /** Rendered from RYPH_RADICLE_EXPLORER_URL, when one is configured. */
  url: string | null;
}

/** The machine-readable marker on a refusal an agent is meant to read rather than retry. */
export const FORGE_CAPABILITY_UNAVAILABLE = "forge_capability_unavailable";

/** The machine-readable marker on "the node was asked and came back with nothing". */
export const REPO_UNAVAILABLE = "repo_unavailable";

/**
 * Thrown by `seed` when the node ended up holding no identity document for the RID: the fetch
 * did not produce one and storage has nothing.
 *
 * Why this is not simply a 404. Measured against heartwood: a private repository refuses the
 * whole fetch at the responder (`radicle-node/src/worker.rs`'s `is_authorized`, which checks
 * `doc.is_visible_to`), and what the INITIATOR sees is a dead handshake — heartwood's own
 * golden prints `an I/O error occurred during the fetch handshake (connection reset)`
 * (`rad-init-private-clone.md`). It is never told that it was refused, or why. And a private
 * repository is kept out of inventory announcements and its refs announced only to allowed
 * nodes, so the routing table is empty too.
 *
 * So the wire cannot distinguish "this repository is private and ryph is not on its allow list"
 * from "no peer is offering this repository". This error carries everything that IS known — our
 * DID, the command that would fix the first case, and how many seeds the routing table claimed
 * — and lets the connect flow say both.
 */
export class RepoUnavailableError extends Error {
  constructor(
    readonly rid: string,
    /** Our own DID: the one a delegate would have to add to the allow list. */
    readonly did: string,
    /** Peers the routing table claims hold it. Null when the node could not be asked. */
    readonly seeds: number | null,
    /** How many of those the node was CONNECTED to and actually asked. Zero means nobody who
     * claims to hold it was reachable — which is not the same as being refused by one. */
    readonly triedSeeds: number,
    /** The node's own words for why the fetch produced nothing. */
    readonly reason: string,
  ) {
    super(`${rid} could not be fetched: ${reason}`);
    this.name = "RepoUnavailableError";
  }
}

/** The `error` a seed of a repository the node explicitly blocks is refused with. */
export const REPO_BLOCKED = "repo_blocked";

/**
 * A user-mode seed of a repository the person's node BLOCKS (`rad block`). Their decision about
 * their own node, so ryph neither overrides it nor touches the row: the connect flow tells them
 * how to lift it themselves. The HTTP layer turns it into a `409 repo_blocked`.
 */
export class RepoBlockedError extends Error {
  readonly command: string;
  constructor(readonly rid: string) {
    super(
      `your Radicle node blocks ${rid}, so ryph will not seed it — unblock it with ` +
        `\`rad unblock ${rid}\` and connect it again`,
    );
    this.name = "RepoBlockedError";
    this.command = `rad unblock ${rid}`;
  }
}

/** Thrown by the core when an action needs delegate rights we do not have. The HTTP layer turns
 * it into a typed 403 — never a 500, because the agent on the other end can act on it. */
export class CapabilityError extends Error {
  constructor(readonly capability: string, readonly reason: string) {
    super(reason);
    this.name = "CapabilityError";
  }
}

/** Thrown for anything the CALLER got wrong: an unknown id, an ambiguous prefix, a body that
 * does not match the bundle. A 400 or 404, never a 500. */
export class RefusedError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.name = "RefusedError";
  }
}
