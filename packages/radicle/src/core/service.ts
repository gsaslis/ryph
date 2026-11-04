// The bridge itself: everything the HTTP surface does, as plain methods over the two ports.
//
// Three rules run through the whole file:
//
// 1. CONFIRM, NEVER SCRAPE. `git push` announces the patch id on stderr and `rad cob update`
//    prints the op id on stdout, and both are used — as a HINT. The answer this service returns
//    is always read back out of the COB afterwards. The one time that discipline was missing
//    (an early experiment against rad 1.10.2) a push whose stderr said "✓ Patch … opened" had
//    in fact only half-succeeded.
//
// 2. THE CACHE IS NOT THE TRUTH. `rad cob show` reads a materialization out of the profile's
//    COB cache, NOT out of git. The node refreshes that cache when IT fetches; a COB whose refs
//    arrived any other way (an operator's `git fetch`, a test moving refs between two storages)
//    is stale or invisible until `rad {issue,patch} cache` is run. So every read re-caches the
//    object it is about to read, which for a single object is a few milliseconds, and the event
//    consumer re-caches every COB whose ref moved.
//
// 3. A REFUSAL IS A VALUE. `rad` says "not authorized to apply …" on stderr and exits 1 when a
//    non-delegate tries a delegate-only action. That becomes a `CapabilityError` and then a
//    typed 403 — an agent can read it and choose something else to do. It is never a 500.
//
// And one about files. A write may carry EMBEDS — an agent's screenshot, say — and they are
// written the way heartwood writes them itself (`Embed::store` + `Transaction::embed`): each file
// is a blob in storage (`git hash-object -w`), the action names it as `{name, content:
// "git:<oid>"}`, and `rad cob update --embed-hash <name> <oid>` puts it in the op's `embeds/`
// tree, which is what carries the blob to every peer that fetches the COB. A file the action
// named but the op did not carry would be a broken embed everywhere but here.

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExecResult, orThrow, type RadExec } from "../ports/rad.ts";
import { FetchRefusedError, type NodeControl, type SeedScope } from "../ports/node.ts";
import type { JobCli, JobView } from "../ports/jobs.ts";
import type { TrackedRepoStore } from "../ports/tracked_repos.ts";
import { syncFetch } from "./sync_fetch.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { readBundleHeader } from "../helpers/bundle.ts";
import { withRepoLock } from "../helpers/repo_lock.ts";
import { makeTempFile } from "../helpers/temp_file.ts";
import { type FilePatch, splitUnifiedDiff } from "../helpers/diff.ts";
import {
  compareRevisions,
  type RevisionComparison,
  type RevisionComparisonInput,
} from "./revision_comparison.ts";
import {
  fullOidsIn,
  isFullOid,
  isOidPrefix,
  normalizeRid,
  renderExplorerUrl,
} from "../helpers/ids.ts";
import {
  CapabilityError,
  type ChangeView,
  type CommentView,
  type DiffStat,
  type EmbedView,
  type FileChange,
  type IssueView,
  RefusedError,
  RepoBlockedError,
  type RepoIdentity,
  RepoUnavailableError,
  type SubmitResult,
} from "./types.ts";
import { existingReviewId, materializeChange, materializeIssue, toNid } from "./materialize.ts";

/** The largest embedded file `readEmbed` serves: the control plane's attachment cap (5 MiB,
 * `MAX_ATTACHMENT_BYTES` in packages/orchestrator/src/core/attachments.ts), restated here —
 * nothing here imports the orchestrator — so a file the control plane would refuse anyway
 * never leaves storage. */
export const MAX_EMBED_BYTES = 5 * 1024 * 1024;

export const ISSUE_TYPE = "xyz.radicle.issue";
export const CHANGE_TYPE = "xyz.radicle.patch";

export type ThreadKind = "issue" | "change";

const TYPE_OF: Record<ThreadKind, string> = { issue: ISSUE_TYPE, change: CHANGE_TYPE };
/** `rad issue cache` / `rad patch cache` — the porcelain that rebuilds one object's row. */
const CACHE_CMD: Record<ThreadKind, string> = { issue: "issue", change: "patch" };

export interface SelfIdentity {
  did: string;
  nid: string;
  alias: string | null;
  home: string;
  /** Present when the node is reachable; null when it is not (a push still works without it). */
  node: { running: boolean; sessions: number } | null;
  /** Whose node this is — `user` when the bridge acts as one person. See setup.ts's `BridgeMode`. */
  mode: "deployment" | "user";
}

export interface ListFilter {
  /** `open` / `closed` for issues; `open` / `draft` / `archived` / `merged` for changes. */
  state?: string;
  /** Every named label must be present. */
  labels?: string[];
  limit?: number;
  offset?: number;
}

/** A file a write stores with the COB: its name (a plain file name, unique within the write) and
 * its bytes. Read back as an `EmbedView`. */
export interface EmbedInput {
  name: string;
  bytes: Uint8Array;
}

export interface SubmitInput {
  /** The verified bundle on disk. The caller owns the file; this never deletes it. */
  bundlePath: string;
  title: string;
  description: string;
  /** The description's files. */
  embeds?: EmbedInput[];
  baseSha: string;
  headSha: string;
  draft?: boolean;
  /** An existing change request to add a revision to. Absent: open a new one. */
  changeRef?: string;
}

export interface ReviewRemark {
  path: string;
  line: number;
  side: "old" | "new";
  body: string;
}

export interface ReviewInput {
  summary?: string;
  verdict?: "accept" | "reject";
  remarks?: ReviewRemark[];
  /** The summary's files; only with a summary. */
  summaryEmbeds?: EmbedInput[];
}

/** One change request's diff, hunks included. `complete` is false when the objects are not in
 * storage — the COB arrived and the pack did not — so a caller must not read a missing path as
 * "the change request does not touch that file". */
export interface ChangeDiff {
  base: string;
  head: string;
  files: FilePatch[];
  complete: boolean;
}

export interface RadicleServiceDeps {
  exec: RadExec;
  node: NodeControl;
  diag: Diagnostics;
  /** Where scratch repositories for bundle verification are built. */
  scratchDir: string;
  /** `RYPH_RADICLE_EXPLORER_URL` — `{rid}`, `{kind}` and `{id}` are substituted. A template
   * naming none of them renders nothing: see `helpers/ids.ts`. */
  explorerUrl?: string | null;
  /** The bound on a node-side fetch triggered by a seed or a clone. */
  fetchTimeoutMs?: number;
  /** The clock `fetchedWithin` reads. Injected so a test can move it. */
  now?: () => number;
  /** The job COB's one writer (`rad-job`). Absent: every job method refuses — see `jobsOf`. */
  jobs?: JobCli | null;
  /**
   * USER MODE: the repositories this bridge may touch, out of somebody's own node, which holds
   * many more (`ports/tracked_repos.ts`). Absent or null: a deployment, whose node is its own,
   * and every repository in storage is this bridge's business.
   */
  tracked?: TrackedRepoStore | null;
  /** User mode: what else is dropped when a repository leaves scope — the consumer's cursors and
   * the git door's mirror, which this service does not own. */
  forget?: (rid: string) => Promise<void>;
}

/** A node's explicit seeding policy for one repository, as `rad seed` lists it. */
type NodePolicy = { policy: "allow"; scope: SeedScope | null } | { policy: "block" };

/** What recording a run answered. `created` is about the RUN: false when this node already had
 * a run with this log URL on a job for the commit, which is what makes a retry converge. */
export interface RecordRunResult {
  jobId: string;
  uuid: string;
  created: boolean;
  /** Whether this call had to create the job itself — no node had asked for one yet. */
  jobCreated: boolean;
  /** Where the run stands after this call. */
  status: "started" | "succeeded" | "failed";
}

/** A run to record: the commit, the log URL it is found again by, and the verdict to finish it
 * with in the same call, if the suite has settled. */
export interface RecordRunInput {
  commit: string;
  log: string;
  finish?: "succeeded" | "failed";
  /** Log URLs of the runs this one replaces: each of ours still going is finished as failed. */
  supersedes?: string[];
  /** Touch only a run already recorded under `log`; record none when there is none. */
  existingOnly?: boolean;
}

export interface RadicleService {
  identity(): Promise<SelfIdentity>;
  /** Our own DID. Cached, and re-read whenever the key file on disk changes underneath us. */
  selfDid(): Promise<string>;
  repo(rid: string): Promise<RepoIdentity>;
  seed(rid: string): Promise<RepoIdentity>;
  unseed(rid: string): Promise<{ unseeded: boolean }>;
  /**
   * Pulls a repository from the network through `rad sync --fetch`. Throws
   * `FetchRefusedError` when no seed served it; see `core/sync_fetch.ts` for why this is
   * the CLI and not the control socket. `graceMs` is how long past the budget the CLI may run
   * before it is killed; see `syncFetch`.
   */
  fetchFromNetwork(rid: string, budgetMs?: number, opts?: { graceMs?: number }): Promise<void>;
  /**
   * Whether a fetch THIS PROCESS asked for served `rid` within the last `ms` — the pull's, a
   * seed's or a clone's own. Storage is then as fresh as the network was that recently, which
   * is what the git door reads before deciding whether to ask again.
   */
  fetchedWithin(rid: string, ms: number): boolean;
  /**
   * Every RID this bridge watches — what the reconcile and the pull walk. A deployment's is
   * everything in storage; a user-mode bridge's is the tracked set, and nothing else on the node.
   */
  seededRepos(): Promise<string[]>;
  /** Whether `rid` is this bridge's business at all: always in a deployment, only when tracked
   * in user mode. Every route but the seed pair asks it first, and so does the event consumer. */
  inScope(rid: string): Promise<boolean>;
  /** User mode: removes every policy a disconnect could not, while the node was down. A no-op
   * in a deployment, and never throws — what still fails stays pending for the next call. */
  retryPendingUnseeds(): Promise<void>;
  /**
   * User mode: disconnects every tracked repository not in `keep`, through `unseed` — so a
   * disconnect the bridge never heard of heals at the next boot. `before` is an ISO time taken
   * BEFORE `keep` was read: a repository tracked (or tracked again) at or after it is a connect
   * in flight and is left alone. Answers the RIDs it dropped.
   */
  untrackExcept(keep: ReadonlySet<string>, before: string): Promise<string[]>;
  listIssues(rid: string, filter?: ListFilter): Promise<{ issues: IssueView[]; total: number }>;
  getIssue(rid: string, id: string): Promise<IssueView>;
  /**
   * One file an issue or a change request embeds, by its blob id: only one the object's own text
   * names (a comment, a revision's description, a review's summary or remark), only a blob, and
   * at most `MAX_EMBED_BYTES` — a 404, a 404 and a 413 otherwise. Read from storage, so no
   * network is involved; the forge hands the bytes on as a thread's images.
   */
  readEmbed(
    rid: string,
    kind: ThreadKind,
    id: string,
    oid: string,
  ): Promise<{ name: string; oid: string; bytes: Uint8Array }>;
  createIssue(
    rid: string,
    input: { title: string; body: string; labels?: string[]; embeds?: EmbedInput[] },
  ): Promise<IssueView>;
  closeIssue(rid: string, id: string, reason?: "solved" | "other"): Promise<IssueView>;
  listChanges(rid: string, filter?: ListFilter): Promise<{ changes: ChangeView[]; total: number }>;
  getChange(rid: string, id: string): Promise<ChangeView>;
  /** The latest revision's diff as UNIFIED PATCH TEXT, one entry per file. `ChangeView.files`
   * is a stat and cannot answer "which lines may a review remark anchor to"; this can. */
  changeDiff(rid: string, id: string): Promise<ChangeDiff>;
  compareChange(
    rid: string,
    id: string,
    input: RevisionComparisonInput,
  ): Promise<RevisionComparison>;
  submitChange(rid: string, input: SubmitInput): Promise<SubmitResult>;
  addComment(
    rid: string,
    kind: ThreadKind,
    id: string,
    input: { body: string; replyTo?: string; embeds?: EmbedInput[] },
  ): Promise<{ id: string }>;
  /** Replaces a comment's text — and its files, with `embeds` (none when absent). */
  editComment(
    rid: string,
    kind: ThreadKind,
    id: string,
    commentId: string,
    input: { body: string; embeds?: EmbedInput[] },
  ): Promise<{ id: string }>;
  reactToComment(
    rid: string,
    kind: ThreadKind,
    id: string,
    commentId: string,
    input: { reaction: string; active?: boolean },
  ): Promise<{ id: string }>;
  submitReview(
    rid: string,
    id: string,
    input: ReviewInput,
  ): Promise<{ reviewId: string; comments: string[]; edited: boolean }>;
  addLabels(rid: string, kind: ThreadKind, id: string, labels: string[]): Promise<string[]>;
  /**
   * Every job COB about `commit` — several, when nodes raced to create one — and our own NID, so
   * a reader can tell our runs from everyone else's without a second call.
   */
  listJobs(rid: string, commit: string): Promise<{ node: string; jobs: JobView[] }>;
  /**
   * Records that this node started a run on `commit` (find, then create) and, given `finish`,
   * finishes it in the same call. Idempotent on the LOG URL — `rad-job` picks the run's uuid
   * itself, so the caller's key has to be something it chooses, and a log URL per suite
   * generation is exactly that. Finishing with the verdict the run already has is a no-op; a
   * different one is a 409, and so is a run `rad-job` cannot reach (a duplicate job ahead of
   * ours) — asking again never changes either answer.
   *
   * `supersedes` finishes the older runs a newer one replaces, as failed, first and under the
   * same lock; one that is already finished, or not ours, is left alone. With `existingOnly`,
   * null is the answer when no run has this log.
   */
  recordRun(
    rid: string,
    input: RecordRunInput & { existingOnly?: false },
  ): Promise<RecordRunResult>;
  recordRun(rid: string, input: RecordRunInput): Promise<RecordRunResult | null>;
  /** Gossips our namespace for a repo. Never throws — a failure is logged and swallowed. */
  announce(rid: string): Promise<void>;
  /** Rebuilds the COB cache row for one object, so the next read is not stale. */
  recache(rid: string, kind: ThreadKind, id?: string): Promise<void>;
  /** The raw materialization, for the event consumer's state reads. */
  showCob(rid: string, kind: ThreadKind, id: string): Promise<unknown>;
  /** The storage directory for a RID — the git gateway's input. */
  storageDir(rid: string): string;
}

/** `rad`'s refusal for an action the signer may not take. */
const UNAUTHORIZED = /not authorized to apply/i;

/** A push option may not contain a newline — git refuses the whole push if it does. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Whether git will hand this push option to a remote helper VERBATIM.
 *
 * git C-quotes an option value that needs quoting, and `git-remote-rad` takes what it is given
 * literally — so anything outside printable ASCII, and the two characters C-quoting itself
 * escapes, makes the push fail rather than the value arrive wrong.
 */
function isPushOptionSafe(value: string): boolean {
  return /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(value);
}

export function makeRadicleService(deps: RadicleServiceDeps): RadicleService {
  const { exec, node, diag } = deps;
  const tracked = deps.tracked ?? null;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 30_000;
  const now = deps.now ?? Date.now;
  /**
   * When the network last served each repository through a fetch we asked for. Only a fetch
   * that LANDED is recorded: a refusal or a timeout leaves the entry alone, so the next caller
   * asks again rather than trusting a freshness nobody delivered.
   */
  const fetchedAt = new Map<string, number>();
  const recordFetched = (rid: string): void => {
    fetchedAt.set(rid, now());
  };
  let cachedSelf: { did: string; nid: string; alias: string | null } | null = null;
  let cachedKeyStamp: string | null = null;

  /**
   * The public key's identity on disk — `<mtime>:<size>`, or null when it is not there.
   *
   * This exists because the cache below is a SECURITY control, not a speed one: our own NID is
   * what the event consumer filters its own writes by, and it is the only thing between a
   * comment ryph posted and ryph answering it in a loop. Remembered for the life of the process
   * it is also a statement that the key cannot change under us — and it can: the node's
   * entrypoint writes the key pair on first boot, a restarted pod with a restored volume brings
   * a different one, and an operator can rotate it. A `stat` per read is a syscall; getting this
   * wrong is an agent talking to itself on somebody's repository.
   */
  const keyStamp = async (): Promise<string | null> => {
    try {
      const info = await stat(`${exec.home}/keys/radicle.pub`);
      return `${info.mtime.getTime()}:${info.size}`;
    } catch {
      return null;
    }
  };

  const readSelf = async () => {
    const stamp = await keyStamp();
    if (cachedSelf !== null && stamp === cachedKeyStamp) return cachedSelf;
    const did = orThrow("rad self --did", await exec.rad(["self", "--did"])).stdout.trim();
    const aliasResult = await exec.rad(["self", "--alias"]);
    const self = {
      did,
      nid: toNid(did),
      alias: aliasResult.code === 0 ? (aliasResult.stdout.trim() || null) : null,
    };
    if (cachedSelf !== null && cachedSelf.did !== self.did) {
      // Loud rather than silent: every cursor, every own-write filter and every signature this
      // process has already made belongs to the other identity.
      diag.warn("radicle.identity_changed", { from: cachedSelf.did, to: self.did });
    }
    cachedSelf = self;
    cachedKeyStamp = stamp;
    return self;
  };

  /** Every `rad cob` read goes through here so the stale-cache rule is in ONE place. */
  const showCob = async (rid: string, kind: ThreadKind, id: string): Promise<unknown> => {
    await recache(rid, kind, id);
    const out = await exec.rad([
      "cob",
      "show",
      "--repo",
      rid,
      "--type",
      TYPE_OF[kind],
      "--object",
      id,
    ]);
    if (out.code !== 0) {
      throw new RefusedError(
        `no ${kind === "issue" ? "issue" : "change request"} ${id} in ${rid}`,
        404,
      );
    }
    try {
      return JSON.parse(out.stdout.trim().split("\n")[0]);
    } catch (err) {
      throw new Error(`rad cob show returned unreadable JSON for ${id}: ${err}`);
    }
  };

  const recache = async (rid: string, kind: ThreadKind, id?: string): Promise<void> => {
    const args = [CACHE_CMD[kind], "cache"];
    if (id !== undefined) args.push(id);
    args.push(kind === "issue" ? "-r" : "--repo", rid, "--no-announce", "-q");
    const out = await exec.rad(args, { timeoutMs: 120_000 });
    // Not fatal: an object that has never been cached and cannot be cached is simply not there,
    // and the read that follows says so with a 404.
    if (out.code !== 0) {
      diag.debug("radicle.recache_failed", { rid, kind, id, err: out.stderr.trim().slice(0, 300) });
    }
  };

  const listCobIds = async (rid: string, kind: ThreadKind): Promise<string[]> => {
    const out = orThrow(
      "rad cob list",
      await exec.rad(["cob", "list", "--repo", rid, "--type", TYPE_OF[kind]]),
    );
    return out.stdout.split("\n").map((l) => l.trim()).filter(isFullOid);
  };

  /** A full id, or a unique prefix of one. Ambiguity is the caller's 400, not a guess. */
  const resolveId = async (rid: string, kind: ThreadKind, given: string): Promise<string> => {
    if (!isOidPrefix(given)) {
      throw new RefusedError(`${JSON.stringify(given)} is not an object id or a prefix of one`);
    }
    if (isFullOid(given)) return given;
    const matches = (await listCobIds(rid, kind)).filter((id) => id.startsWith(given));
    if (matches.length === 0) {
      throw new RefusedError(`nothing in ${rid} has an id starting with ${given}`, 404);
    }
    if (matches.length > 1) {
      throw new RefusedError(
        `${given} is ambiguous — ${matches.length} objects share that prefix`,
        409,
      );
    }
    return matches[0];
  };

  const announce = async (rid: string): Promise<void> => {
    try {
      const self = await readSelf();
      await node.announceRefsFor(rid, [self.nid]);
    } catch (err) {
      // By design: a write is a local, signed storage commit. Gossip is how others LEARN of it,
      // and a node that is down delays that and loses nothing. Never fail a write on it.
      diag.warn("radicle.announce_failed", { rid, err: String(err) });
    }
  };

  /**
   * Every writer for one repository serializes here. `git-remote-rad`, `rad issue open` and
   * `rad cob update` all write the SAME storage repository, whatever scratch directory the
   * caller built for itself — see helpers/repo_lock.ts for why in-process is enough.
   */
  const lockOn = <T>(rid: string, fn: () => Promise<T>): Promise<T> =>
    withRepoLock(normalizeRid(rid), fn);

  /**
   * Writes a write's files into the repository's storage as blobs and names each as the COB will:
   * by the id git gives it. The body the forge sent already links that same id — a blob's id is a
   * function of its bytes — so nothing here rewrites the text.
   */
  const storeEmbeds = async (
    rid: string,
    embeds: EmbedInput[] | undefined,
  ): Promise<EmbedView[]> => {
    if (embeds === undefined || embeds.length === 0) return [];
    const dir = exec.storageDir(rid);
    const stored: EmbedView[] = [];
    for (const embed of embeds) {
      const file = await makeTempFile(deps.scratchDir, ".embed");
      try {
        await writeFile(file, embed.bytes);
        const oid = orThrow(
          "git hash-object",
          await exec.git(dir, ["hash-object", "-w", "--", file]),
        ).stdout.trim();
        if (!isFullOid(oid)) throw new Error(`git hash-object printed no object id: ${oid}`);
        stored.push({ name: embed.name, oid });
      } finally {
        await rm(file).catch(() => {});
      }
    }
    return stored;
  };

  /** Stored files as an action names them — heartwood's `Embed<Uri>`. */
  const embedsJson = (stored: EmbedView[]) =>
    stored.map((e) => ({ name: e.name, content: `git:${e.oid}` }));

  /** Applies COB actions. Returns the new operation id — which for a comment IS the comment id.
   * The `Unlocked` form is for callers that ALREADY hold the repository's lock; everything else
   * goes through `updateCob`. `embeds` are files already in storage (`storeEmbeds`) that the
   * actions name: the op carries them, or no peer that fetches it could show them. */
  const updateCobUnlocked = async (
    rid: string,
    kind: ThreadKind,
    id: string,
    actions: Array<Record<string, unknown>>,
    message: string,
    capability: string,
    embeds: EmbedView[] = [],
  ): Promise<string> => {
    const file = await makeTempFile(deps.scratchDir, ".jsonl");
    try {
      await writeFile(file, `${actions.map((a) => JSON.stringify(a)).join("\n")}\n`);
      const out = await exec.rad([
        "cob",
        "update",
        "--repo",
        rid,
        "--type",
        TYPE_OF[kind],
        "--object",
        id,
        "--message",
        message,
        ...embeds.flatMap((e) => ["--embed-hash", e.name, e.oid]),
        file,
      ]);
      if (out.code !== 0) throw refusalOf(out, capability);
      const opId = fullOidsIn(out.stdout)[0];
      if (opId === undefined) {
        throw new Error(`rad cob update printed no operation id: ${out.stdout.trim()}`);
      }
      await announce(rid);
      return opId;
    } finally {
      await rm(file).catch(() => {});
    }
  };

  const updateCob = (
    rid: string,
    kind: ThreadKind,
    id: string,
    actions: Array<Record<string, unknown>>,
    message: string,
    capability: string,
    embeds: EmbedView[] = [],
  ): Promise<string> =>
    lockOn(rid, () => updateCobUnlocked(rid, kind, id, actions, message, capability, embeds));

  /** Turns a failed `rad` into the right exception: a capability refusal, or a real error. */
  const refusalOf = (out: ExecResult, capability: string): Error => {
    const stderr = out.stderr.trim();
    if (UNAUTHORIZED.test(stderr)) {
      return new CapabilityError(
        capability,
        "this action is reserved for the repository's delegates, and ryph is not one",
      );
    }
    return new Error(`rad cob update failed (exit ${out.code}): ${stderr || out.stdout.trim()}`);
  };

  /** The delegate gate, asked BEFORE the write so the refusal is the same shape every time. */
  const requireDelegate = async (rid: string, capability: string): Promise<RepoIdentity> => {
    const identity = await repo(rid);
    if (!identity.isDelegate) {
      throw new CapabilityError(
        capability,
        `ryph (${identity.self.did}) is not a delegate of ${rid}, and Radicle reserves this ` +
          "action for delegates",
      );
    }
    return identity;
  };

  /**
   * How many peers the routing table claims hold `rid`, or null when the node could not say.
   *
   * A HINT and never a verdict: a private repository is absent from every inventory
   * announcement, so zero is also what one looks like from a node that is not allowed to see
   * it. Above zero is the sharper half — somebody is offering the repository and our fetch
   * still came back empty, which is what a refusal looks like from this side.
   */
  const seedCount = async (rid: string): Promise<number | null> => {
    try {
      return (await node.seedsFor(rid)).length;
    } catch (err) {
      diag.debug("radicle.seeds_unanswerable", { rid, err: String(err) });
      return null;
    }
  };

  const repo = async (rid: string): Promise<RepoIdentity> => {
    const canonical = normalizeRid(rid);
    const out = await exec.rad(["inspect", canonical, "--identity"]);
    if (out.code !== 0) {
      throw new RefusedError(
        `${canonical} is not in this node's storage — seed it first`,
        404,
      );
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(out.stdout);
    } catch (err) {
      throw new Error(`rad inspect --identity returned unreadable JSON: ${err}`);
    }
    const payload = (doc.payload ?? {}) as Record<string, unknown>;
    const project = (payload["xyz.radicle.project"] ?? {}) as Record<string, unknown>;
    const visibility = (doc.visibility ?? null) as { type?: string; allow?: unknown } | null;
    const delegates = Array.isArray(doc.delegates) ? doc.delegates.map(String) : [];
    const allow = Array.isArray(visibility?.allow) ? visibility.allow.map(String) : [];
    const self = await readSelf();
    const isPrivate = visibility?.type === "private";
    return {
      rid: canonical,
      name: String(project.name ?? ""),
      description: String(project.description ?? ""),
      defaultBranch: String(project.defaultBranch ?? "main"),
      delegates,
      threshold: typeof doc.threshold === "number" ? doc.threshold : 1,
      // The `visibility` key is ABSENT for a public repo — measured, rad 1.10.2.
      visibility: isPrivate ? "private" : "public",
      allow,
      self,
      isDelegate: delegates.includes(self.did),
      isAllowed: !isPrivate || delegates.includes(self.did) || allow.includes(self.did),
    };
  };

  const diffStat = async (rid: string, base: string, head: string): Promise<DiffStat | null> => {
    if (!isFullOid(base) || !isFullOid(head)) return null;
    const dir = exec.storageDir(rid);
    const numstat = await exec.git(dir, [
      "diff",
      "--numstat",
      "--find-renames",
      "--no-color",
      `${base}..${head}`,
    ]);
    if (numstat.code !== 0) {
      // The commits are not in storage — the COB arrived, the pack did not. A read must still
      // answer; `files: null` is the honest report.
      diag.debug("radicle.diff_unavailable", { rid, base, head });
      return null;
    }
    const status = await exec.git(dir, [
      "diff",
      "--name-status",
      "--find-renames",
      "--no-color",
      `${base}..${head}`,
    ]);
    const statuses = new Map<string, { status: FileChange["status"]; previousPath?: string }>();
    for (const line of status.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const code = parts[0][0];
      const kind: FileChange["status"] = code === "A"
        ? "added"
        : code === "D"
        ? "deleted"
        : code === "R"
        ? "renamed"
        : code === "C"
        ? "copied"
        : code === "M"
        ? "modified"
        : "changed";
      const path = parts[parts.length - 1];
      statuses.set(
        path,
        kind === "renamed" || kind === "copied"
          ? { status: kind, previousPath: parts[1] }
          : { status: kind },
      );
    }

    const files: FileChange[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      // A binary file is reported as "-\t-\tpath".
      const added = parts[0] === "-" ? 0 : Number(parts[0]);
      const removed = parts[1] === "-" ? 0 : Number(parts[1]);
      const path = parts[parts.length - 1];
      insertions += Number.isFinite(added) ? added : 0;
      deletions += Number.isFinite(removed) ? removed : 0;
      files.push({
        path,
        insertions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(removed) ? removed : 0,
        ...(statuses.get(path) ?? { status: "changed" as const }),
      });
    }
    return { base, head, filesChanged: files.length, insertions, deletions, files };
  };

  const getChange = async (rid: string, given: string): Promise<ChangeView> => {
    const id = await resolveId(rid, "change", given);
    const view = materializeChange(id, await showCob(rid, "change", id));
    view.files = await diffStat(rid, view.base, view.head);
    return view;
  };

  /**
   * The unified diff of a change request's latest revision, per file.
   *
   * Separate from `diffStat` and not folded into `getChange`: the hunks of a large change run
   * to megabytes, every thread read would carry them, and only one caller — the review check —
   * ever wants them.
   */
  const changeDiff = async (rid: string, given: string): Promise<ChangeDiff> => {
    const change = await getChange(rid, given);
    const empty = { base: change.base, head: change.head, files: [], complete: false };
    if (!isFullOid(change.base) || !isFullOid(change.head)) return empty;
    const out = await exec.git(exec.storageDir(rid), [
      "diff",
      "--no-color",
      "--find-renames",
      "--unified=3",
      `${change.base}..${change.head}`,
    ], { timeoutMs: 120_000 });
    if (out.code !== 0) {
      // The commits are not in storage. Answering "no files, incomplete" keeps the caller from
      // reading an absent path as a file the change request does not touch.
      diag.debug("radicle.diff_text_unavailable", { rid, id: change.id });
      return empty;
    }
    const patches = new Map(splitUnifiedDiff(out.stdout).map((f) => [f.path, f.patch]));
    // The stat is the authority on WHICH files changed — it sees binaries and pure renames,
    // which produce no hunks at all — and the split fills in the hunks where there are any.
    const files = (change.files?.files ?? []).map((f) => ({
      path: f.path,
      patch: patches.get(f.path) ?? null,
    }));
    for (const [path, patch] of patches) {
      if (!files.some((f) => f.path === path)) files.push({ path, patch });
    }
    return { base: change.base, head: change.head, files, complete: change.files !== null };
  };

  // Compare the recorded revisions in storage, not the exported current branch: a rewritten
  // head need not contain the old revision's commits. Never accept arbitrary git expressions.
  const compareChange = async (
    rid: string,
    given: string,
    input: RevisionComparisonInput,
  ): Promise<RevisionComparison> => {
    const id = await resolveId(rid, "change", given);
    const change = materializeChange(id, await showCob(rid, "change", id));
    return await compareRevisions(change.revisions, input, exec.git, exec.storageDir(rid));
  };

  const getIssue = async (rid: string, given: string): Promise<IssueView> => {
    const id = await resolveId(rid, "issue", given);
    return materializeIssue(id, await showCob(rid, "issue", id));
  };

  const readEmbed = async (
    rid: string,
    kind: ThreadKind,
    given: string,
    oid: string,
  ): Promise<{ name: string; oid: string; bytes: Uint8Array }> => {
    if (!isFullOid(oid)) throw new RefusedError(`${JSON.stringify(oid)} is not a full object id`);
    const id = await resolveId(rid, kind, given);
    // Only what THIS object embeds. A blob id is not a secret, and storage holds every peer's
    // namespace; serving any blob by id would make this route a reader of the whole store,
    // where the git door serves canonical refs only. Materialized without the diff stat, which
    // is the expensive half of a change request read and says nothing about embeds.
    const cob = await showCob(rid, kind, id);
    const embeds: EmbedView[] = [];
    const ofComments = (comments: CommentView[]) => {
      for (const c of comments) embeds.push(...(c.embeds ?? []));
    };
    if (kind === "issue") {
      ofComments(materializeIssue(id, cob).comments);
    } else {
      const change = materializeChange(id, cob);
      for (const r of change.revisions) embeds.push(...(r.embeds ?? []));
      ofComments(change.comments);
      for (const review of change.reviews) {
        embeds.push(...(review.summaryEmbeds ?? []));
        ofComments(review.comments);
      }
    }
    const named = embeds.find((e) => e.oid === oid);
    if (named === undefined) {
      throw new RefusedError(`${id} embeds no file ${oid}`, 404);
    }
    const dir = exec.storageDir(rid);
    const type = await exec.git(dir, ["cat-file", "-t", oid]);
    if (type.code !== 0 || type.stdout.trim() !== "blob") {
      // Named by the object and absent from storage: the COB's commit arrived without it, or
      // the name points at something that is not a file. Either way there is nothing to serve.
      throw new RefusedError(`the embedded file ${oid} is not in this node's storage`, 404);
    }
    // The size BEFORE the read: the object is content-addressed, so what `-s` measured is
    // exactly what `blob` prints, and a file over the cap is never pulled into memory.
    const size = Number((await exec.git(dir, ["cat-file", "-s", oid])).stdout.trim());
    if (!Number.isFinite(size) || size > MAX_EMBED_BYTES) {
      throw new RefusedError(
        `the embedded file ${oid} is larger than ${MAX_EMBED_BYTES} bytes`,
        413,
      );
    }
    const blob = orThrow(
      "git cat-file blob",
      await exec.git(dir, ["cat-file", "blob", oid], { binary: true }),
    );
    if (blob.bytes === undefined) throw new Error("the executor returned no raw bytes for a blob");
    return { name: named.name, oid, bytes: blob.bytes };
  };

  const matchesFilter = (
    item: { state: string; labels: string[] },
    filter: ListFilter | undefined,
  ): boolean => {
    if (filter?.state !== undefined && item.state !== filter.state) return false;
    if (filter?.labels?.length) {
      for (const label of filter.labels) if (!item.labels.includes(label)) return false;
    }
    return true;
  };

  const page = <T>(items: T[], filter: ListFilter | undefined): T[] => {
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return items.slice(offset, offset + limit);
  };

  const jobsOf = (): JobCli => {
    if (deps.jobs == null) {
      throw new Error("no job CLI is wired into this bridge (rad-job), so it cannot touch jobs");
    }
    return deps.jobs;
  };

  const jobsFor = async (canonical: string, commit: string): Promise<JobView[]> =>
    (await jobsOf().list(canonical)).filter((j) => j.commit === commit);

  /** Our run with this log on any job for the commit — the idempotency key of `recordRun`. */
  const ownRunByLog = (jobs: JobView[], nid: string, log: string) => {
    for (const job of jobs) {
      const run = job.runs.find((r) => r.node === nid && r.log === log);
      if (run !== undefined) return { jobId: job.id, uuid: run.uuid, status: run.status };
    }
    return null;
  };

  /** Our run `uuid` on any job for the commit — where `rad-job` actually put it. */
  const ownRunByUuid = (jobs: JobView[], nid: string, uuid: string) => {
    for (const job of jobs) {
      const run = job.runs.find((r) => r.node === nid && r.uuid === uuid);
      if (run !== undefined) return { jobId: job.id, uuid, status: run.status };
    }
    return null;
  };

  /**
   * The bounded fetch a seed asks for, then the identity read that decides whether the seed
   * worked. `fetch` false skips straight to the read: a user-mode seed of a repository the
   * person's node already seeds and holds has nothing to find, and the pull asks the network
   * within a minute anyway.
   */
  const fetchAndDescribe = async (canonical: string, fetch: boolean): Promise<RepoIdentity> => {
    let reason: string | null = null;
    let triedSeeds = 0;
    if (fetch) {
      try {
        await syncFetch({ exec, diag }, canonical, fetchTimeoutMs);
        recordFetched(canonical);
      } catch (err) {
        // How many peers that CLAIM to hold it were actually asked — the only thing that
        // makes "a peer refused us" a fair reading of this.
        if (err instanceof FetchRefusedError) triedSeeds = err.triedSeeds;
        // The seeding policy is written either way; the fetch is how we FIND the repo, and it
        // fails for three reasons that look alike on the wire (nobody has it, a peer refused
        // it because it is private, the node is down). The identity read below is what
        // actually decides whether this call succeeded.
        reason = err instanceof FetchRefusedError && err.inProgress
          // Not a refusal: the fetcher ran out of patience before the node did. The pull loop
          // asks again on its own cadence, so "try again in a moment" is the honest answer.
          ? `the fetch is still running (${err.message}) — the node keeps going and ryph ` +
            "asks again on its next pull, so this repository may appear shortly"
          : String(err);
        diag.warn("radicle.seed_fetch_failed", { rid: canonical, err: reason });
      }
    }
    try {
      return await repo(canonical);
    } catch (err) {
      // A 404 here is the interesting one: the node was asked and came back with nothing,
      // which is where a private repository and an unknown one become the same answer. It
      // gets its own shape, carrying what a caller needs to say both. See
      // `RepoUnavailableError`.
      if (!(err instanceof RefusedError) || err.status !== 404) throw err;
      const self = await readSelf();
      throw new RepoUnavailableError(
        canonical,
        self.did,
        await seedCount(canonical),
        triedSeeds,
        reason ??
          "the node reported no fetch error and storage still holds no identity document",
      );
    }
  };

  /**
   * The node's EXPLICIT seeding policy for a repository, as `rad seed` lists them: `allow` with
   * its scope, `block`, or null when the node has no row for it at all.
   *
   * The CLI and not the socket because the socket has no command that READS a policy; and the
   * listing rather than `rad inspect --policy`, which says "is not being seeded" for a `block`
   * row and for no row alike — and a person's explicit block is the one policy ryph must never
   * write over. The listing is a table (rad 1.10.3, measured), one row per policy:
   * `│ rad:z…   <name>   block            │` or `… allow    followed │`, or the one line
   * "No seeding policies to show." Anything else is refused rather than guessed at: a misread is
   * a policy on somebody's node we would then overwrite, widen or remove.
   */
  const explicitPolicy = async (canonical: string): Promise<NodePolicy | null> => {
    const out = orThrow("rad seed", await exec.rad(["seed"]));
    // oxlint-disable-next-line no-control-regex
    const text = out.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    if (/No seeding policies to show/.test(text)) return null;
    const unreadable = () =>
      new Error(
        `\`rad seed\` listed policies in a shape this bridge cannot read: ${
          JSON.stringify(text.trim().slice(0, 200))
        }`,
      );
    if (!/\bRepository\b.*\bPolicy\b/.test(text)) throw unreadable();
    for (const line of text.split("\n")) {
      // The FIRST cell only: the Name column is the repository's own identity document, which
      // anybody can write, RIDs and table borders included.
      const first = line.split("│").map((c) => c.trim()).find((c) => c !== "");
      if (first?.split(/\s+/)[0] !== canonical) continue;
      const row = /\s(allow|block)(?:\s+(all|followed))?\s*│?\s*$/.exec(line);
      if (row === null) throw unreadable();
      if (row[1] === "block") return { policy: "block" };
      return { policy: "allow", scope: (row[2] ?? null) as SeedScope | null };
    }
    return null;
  };

  /**
   * Removes the seeding policy ryph wrote for a repository — only while it is still an `allow`.
   * `rad unseed` deletes whatever row there is, and a person who has since BLOCKED the
   * repository (or removed the policy themselves) owns that row now: it is left alone, and the
   * removal counts as done. So does one they narrowed to `followed`: ryph only ever writes `all`.
   */
  const removeOurPolicy = async (canonical: string): Promise<boolean> => {
    const policy = await explicitPolicy(canonical);
    if (policy?.policy !== "allow" || policy.scope !== "all") return false;
    return (await node.unseed(canonical)).updated;
  };

  /** Drops what the bridge kept about a repository it no longer watches. */
  const forget = async (canonical: string): Promise<void> => {
    try {
      await deps.forget?.(canonical);
    } catch (err) {
      diag.warn("radicle.forget_failed", { rid: canonical, err: String(err) });
    }
  };

  /**
   * A user-mode seed. The node is somebody's own, so its policy is theirs: a repository it
   * already seeds is TRACKED and nothing else — its scope is not widened to `all`, even though
   * under `followed` a stranger's comment never arrives, because that is a choice the person made
   * about their own node. One they BLOCKED is refused outright, and the block row is never
   * touched. One with no policy at all gets the policy a deployment's would, and the tracked row
   * remembers that ryph wrote it, so a disconnect removes exactly that and no more.
   *
   * The row is written BEFORE the policy: a crash in between leaves a row whose policy can be
   * cleaned up, never a policy nobody remembers writing.
   */
  const seedTracked = async (
    store: TrackedRepoStore,
    canonical: string,
  ): Promise<RepoIdentity> => {
    const prior = await store.get(canonical);
    const policy = await explicitPolicy(canonical);
    if (policy?.policy === "block") throw new RepoBlockedError(canonical);
    // OR-ed into the row by the store: a leftover row that says "not ours" is corrected the
    // moment ryph does write the policy, and one that says "ours" stays so.
    await store.track(canonical, policy === null);
    if (policy === null) {
      try {
        await node.seed(canonical, "all");
      } catch (err) {
        // Nothing was written to the node: put the row back as it was — gone if there was none,
        // and still owing its removal if a disconnect had left it that way.
        if (prior === null) await store.untrack(canonical);
        else if (prior.unseedPending) await store.markUnseedPending(canonical);
        throw err;
      }
    }
    // A repository the node already holds needs no fetch to be found; one it was just asked to
    // seed is found by one, exactly as in a deployment.
    const held = policy !== null &&
      (await stat(exec.storageDir(canonical)).catch(() => null)) !== null;
    return await fetchAndDescribe(canonical, !held);
  };

  /**
   * A user-mode unseed. The repository leaves scope AT ONCE — its cursors and its git mirror go
   * with it, so connecting it again is a first sight rather than a replay of everything said in
   * between, stale `/ryph` commands included. The policy goes only if ryph wrote it; a node that
   * cannot be asked right now leaves the row marked pending, out of scope, and the removal is
   * retried (`retryPendingUnseeds`) until it lands. The caller hears the node is unreachable.
   */
  const unseedTracked = async (
    store: TrackedRepoStore,
    canonical: string,
  ): Promise<{ unseeded: boolean }> => {
    const row = await store.get(canonical);
    if (row === null) return { unseeded: false };
    if (!row.createdPolicy) {
      await store.untrack(canonical);
      await forget(canonical);
      return { unseeded: false };
    }
    await store.markUnseedPending(canonical);
    await forget(canonical);
    try {
      const unseeded = await removeOurPolicy(canonical);
      await store.untrack(canonical);
      return { unseeded };
    } catch (err) {
      diag.warn("radicle.unseed_pending", { rid: canonical, err: String(err) });
      throw err;
    }
  };

  return {
    storageDir: (rid) => exec.storageDir(normalizeRid(rid)),
    selfDid: async () => (await readSelf()).did,
    showCob,
    recache,
    announce,
    repo,

    async identity() {
      const self = await readSelf();
      let nodeState: SelfIdentity["node"] = null;
      try {
        await node.status();
        nodeState = { running: true, sessions: (await node.sessions()).length };
      } catch (err) {
        // A bridge whose node is down can still read storage and still push. Say so, do not fail.
        diag.debug("radicle.node_unreachable", { err: String(err) });
      }
      return {
        ...self,
        home: exec.home,
        node: nodeState,
        mode: tracked === null ? "deployment" : "user",
      };
    },

    fetchFromNetwork(rid, budgetMs, opts) {
      const canonical = normalizeRid(rid);
      return syncFetch({ exec, diag }, canonical, budgetMs ?? fetchTimeoutMs, opts?.graceMs)
        .then(() => recordFetched(canonical));
    },

    fetchedWithin(rid, ms) {
      const at = fetchedAt.get(normalizeRid(rid));
      return at !== undefined && now() - at < ms;
    },

    async seed(rid) {
      const canonical = normalizeRid(rid);
      // The fetch this asks the node for writes the repository's storage, so it queues behind
      // whatever else is writing it.
      return await lockOn(canonical, async () => {
        if (tracked !== null) return await seedTracked(tracked, canonical);
        // Scope `all`, always. Anything narrower and a stranger's `/ryph` comment never arrives —
        // the node would only ask for the delegates' namespaces. It also has to come FIRST:
        // `rad sync` refuses a repository that is not seeded, because the policy is what tells the
        // node which namespaces to ask for.
        await node.seed(canonical, "all");
        return await fetchAndDescribe(canonical, true);
      });
    },

    async unseed(rid) {
      const canonical = normalizeRid(rid);
      return await lockOn(canonical, async () => {
        if (tracked !== null) return await unseedTracked(tracked, canonical);
        const { updated } = await node.unseed(canonical);
        return { unseeded: updated };
      });
    },

    async inScope(rid) {
      if (tracked === null) return true;
      const row = await tracked.get(normalizeRid(rid));
      return row !== null && !row.unseedPending;
    },

    async retryPendingUnseeds() {
      if (tracked === null) return;
      let pending;
      try {
        pending = await tracked.pendingUnseeds();
      } catch (err) {
        diag.warn("radicle.unseed_retry_failed", { err: String(err) });
        return;
      }
      for (const row of pending) {
        await lockOn(row.rid, async () => {
          try {
            // Connected again in the meantime: `track` called the removal off.
            const current = await tracked.get(row.rid);
            if (current === null || !current.unseedPending) return;
            await removeOurPolicy(row.rid);
            await tracked.untrack(row.rid);
            diag.debug("radicle.unseed_settled", { rid: row.rid });
          } catch (err) {
            diag.debug("radicle.unseed_still_pending", { rid: row.rid, err: String(err) });
          }
        });
      }
    },

    async untrackExcept(keep, before) {
      if (tracked === null) return [];
      const dropped: string[] = [];
      for (const row of await tracked.list()) {
        if (keep.has(row.rid)) continue;
        try {
          const gone = await lockOn(row.rid, async () => {
            // Asked again under the lock a seed takes: a repository (re)connected since `keep`
            // was read was tracked after `before`, and its control-plane row may simply not
            // have landed yet. That is a connect in flight, not a disconnect that was missed.
            const current = await tracked.get(row.rid);
            if (current === null || current.unseedPending || current.trackedAt >= before) {
              return false;
            }
            await unseedTracked(tracked, row.rid).catch((err) => {
              // Out of scope already; the policy is retried with every other pending one.
              diag.debug("radicle.untrack_unsettled", { rid: row.rid, err: String(err) });
            });
            return true;
          });
          if (gone) dropped.push(row.rid);
        } catch (err) {
          diag.warn("radicle.untrack_failed", { rid: row.rid, err: String(err) });
        }
      }
      return dropped;
    },

    async seededRepos() {
      if (tracked !== null) return (await tracked.list()).map((r) => r.rid);
      const storage = `${exec.home.replace(/\/+$/, "")}/storage`;
      const out: string[] = [];
      try {
        for (const entry of await readdir(storage, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          // A directory in storage is not always a repository: a fetch in flight leaves
          // `<rid>.tmp` behind, and the node's own scratch names come and go. Anything that is
          // not a RID is silently not one — warning per pass per leftover turned a normal node
          // into a log full of "not a repository id".
          try {
            out.push(normalizeRid(entry.name));
          } catch {
            diag.debug("radicle.storage_entry_skipped", { storage, entry: entry.name });
          }
        }
      } catch (err) {
        diag.debug("radicle.storage_unreadable", { storage, err: String(err) });
      }
      return out.sort();
    },

    async listIssues(rid, filter) {
      const ids = await listCobIds(rid, "issue");
      await recache(rid, "issue");
      const all: IssueView[] = [];
      for (const id of ids) {
        const out = await exec.rad([
          "cob",
          "show",
          "--repo",
          rid,
          "--type",
          ISSUE_TYPE,
          "--object",
          id,
        ]);
        if (out.code !== 0) continue;
        try {
          all.push(materializeIssue(id, JSON.parse(out.stdout.trim().split("\n")[0])));
        } catch {
          diag.warn("radicle.unreadable_issue", { rid, id });
        }
      }
      const matched = all
        .filter((i) => matchesFilter(i, filter))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { issues: page(matched, filter), total: matched.length };
    },

    getIssue,

    readEmbed,

    async createIssue(rid, input) {
      const identity = await repo(rid);
      if (input.labels?.length && !identity.isDelegate) {
        throw new CapabilityError(
          "create_issue.labels",
          `ryph is not a delegate of ${rid}, so it cannot label an issue`,
        );
      }
      // `rad cob create` CANNOT be used here: in rad 1.10.2 it writes an operation with no
      // identity header, and the resulting object fails to materialize ("identity document
      // missing") for issues and patches alike. Measured, both as a delegate and as a stranger.
      // `rad issue open` is the supported path and the only one that works.
      const args = [
        "issue",
        "open",
        "-r",
        rid,
        "--title",
        input.title,
        "--description",
        input.body,
        "--no-announce",
      ];
      if (input.labels?.length) args.push("--labels", input.labels.join(" "));
      const stored = await storeEmbeds(rid, input.embeds);
      const id = await lockOn(rid, async () => {
        const out = await exec.rad(args);
        if (out.code !== 0) throw refusalOf(out, "create_issue");
        // The porcelain prints a table, not JSON. The id is the only 40-hex run in it — and it
        // is a hint, confirmed by the read below like every other write here.
        const scraped = fullOidsIn(out.stdout)[0];
        if (scraped === undefined) {
          throw new Error(`rad issue open printed no issue id: ${out.stdout.trim().slice(0, 300)}`);
        }
        // `rad issue open` takes no files, so the description's are added by editing the opening
        // comment — whose id is the issue's own — with the same text and its embeds.
        if (stored.length > 0) {
          const embed = () =>
            updateCobUnlocked(
              rid,
              "issue",
              scraped,
              [{ type: "comment.edit", id: scraped, body: input.body, embeds: embedsJson(stored) }],
              "Embed files",
              "create_issue",
              stored,
            );
          try {
            await embed().catch(() => embed());
          } catch (err) {
            // The issue is out, linking files it does not carry. It is closed, and the write
            // refused for good: a failure the caller may retry would have the forge look for
            // the issue it opened, find this one, and report it written.
            const closed = await updateCobUnlocked(
              rid,
              "issue",
              scraped,
              [{ type: "lifecycle", state: { status: "closed", reason: "other" } }],
              "Close: its files could not be attached",
              "create_issue",
            ).then(() => true, (closeErr) => {
              diag.warn("radicle.half_open_issue", { rid, id: scraped, err: String(closeErr) });
              return false;
            });
            throw new RefusedError(
              `issue ${scraped} was opened but its files could not be attached` +
                (closed ? ", so it was closed" : ", and closing it failed too: it is still open") +
                `: ${err instanceof Error ? err.message : String(err)}`,
              409,
            );
          }
        }
        await announce(rid);
        return scraped;
      });
      return await getIssue(rid, id);
    },

    async closeIssue(rid, given, reason = "solved") {
      const id = await resolveId(rid, "issue", given);
      const issue = await getIssue(rid, id);
      const self = await readSelf();
      if (issue.author.did !== self.did) {
        // Radicle lets an author close their own issue; anything else is a delegate's.
        await requireDelegate(rid, "close_issue");
      }
      await updateCob(
        rid,
        "issue",
        id,
        [{ type: "lifecycle", state: { status: "closed", reason } }],
        "Close issue",
        "close_issue",
      );
      return await getIssue(rid, id);
    },

    async listChanges(rid, filter) {
      const ids = await listCobIds(rid, "change");
      await recache(rid, "change");
      const all: ChangeView[] = [];
      for (const id of ids) {
        const out = await exec.rad([
          "cob",
          "show",
          "--repo",
          rid,
          "--type",
          CHANGE_TYPE,
          "--object",
          id,
        ]);
        if (out.code !== 0) continue;
        try {
          all.push(materializeChange(id, JSON.parse(out.stdout.trim().split("\n")[0])));
        } catch {
          diag.warn("radicle.unreadable_change", { rid, id });
        }
      }
      const matched = all
        .filter((c) => matchesFilter(c, filter))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const wanted = page(matched, filter);
      // The diff is computed only for the page that is actually returned — it is the one part
      // of a listing that costs a subprocess per row.
      for (const change of wanted) change.files = await diffStat(rid, change.base, change.head);
      return { changes: wanted, total: matched.length };
    },

    getChange,
    changeDiff,
    compareChange,

    async listJobs(rid, commit) {
      const canonical = normalizeRid(rid);
      if (!isFullOid(commit)) {
        throw new RefusedError("commit must be a full 40-character object id");
      }
      const [self, jobs] = await Promise.all([readSelf(), jobsFor(canonical, commit)]);
      return { node: self.nid, jobs };
    },

    // One implementation behind the two signatures: null only ever answers `existingOnly`.
    recordRun: (async (rid: string, input: RecordRunInput): Promise<RecordRunResult | null> => {
      const canonical = normalizeRid(rid);
      if (!isFullOid(input.commit)) {
        throw new RefusedError("commit must be a full 40-character object id");
      }
      // The find, the create, the run and the finish are one decision: outside the lock, a
      // forge retry and its original would both find nothing and both create a job — or both
      // add a run. One call and one lock also keep the listings down: `rad-job list` reads
      // every job in the repository, and this takes at most two of them.
      return await lockOn(canonical, async () => {
        const self = await readSelf();
        let before = await jobsFor(canonical, input.commit);

        // Whatever this call wrote is announced, even when it then refuses: a run created and
        // found unfinishable is still a run the network should see.
        let wrote = false;
        try {
          // The runs this one replaces first: a newer generation's report is the last that
          // will ever mention them, and a run left going reads as a suite still running.
          const superseded = [...new Set(input.supersedes ?? [])]
            .filter((log) => log !== input.log)
            .map((log) => ownRunByLog(before, self.nid, log))
            .filter((run) => run !== null && run.status === "started");
          for (const run of superseded) {
            wrote = true;
            await jobsOf().finish(canonical, input.commit, run!.uuid, "failed");
          }
          if (superseded.length > 0) {
            before = await jobsFor(canonical, input.commit);
            for (const run of superseded) {
              const now = ownRunByUuid(before, self.nid, run!.uuid);
              // Only a duplicate job ahead of ours keeps a finish from landing (see below). It is
              // not this run's verdict, so it is said and not refused.
              if (now?.status !== "failed") {
                diag.warn("radicle.superseded_run_unfinished", { rid: canonical, uuid: run!.uuid });
              }
            }
          }

          const existing = ownRunByLog(before, self.nid, input.log);
          if (existing === null && input.existingOnly) return null;
          if (existing !== null) {
            if (input.finish === undefined || existing.status === input.finish) {
              return { ...existing, created: false, jobCreated: false };
            }
            // `rad-job` would overwrite it — last op wins, measured — and a verdict that flips
            // after it was published is worse than a refused call.
            if (existing.status !== "started") {
              throw new RefusedError(
                `run ${existing.uuid} already finished as ${existing.status}`,
                409,
              );
            }
          }

          let jobCreated = false;
          let uuid: string;
          if (existing !== null) {
            uuid = existing.uuid;
          } else {
            if (before.length === 0) {
              // The job's `Request` names the commit as its parent, so the commit has to be in
              // storage; `rad-job new` says so only as a git odb error three causes deep. Asked
              // first, it is a clean 404 the forge can retry once the push has landed.
              const present = await exec.git(exec.storageDir(canonical), [
                "cat-file",
                "-e",
                `${input.commit}^{commit}`,
              ]);
              if (present.code !== 0) {
                throw new RefusedError(
                  `commit ${input.commit} is not in this node's storage of ${canonical}`,
                  404,
                );
              }
              wrote = true;
              await jobsOf().create(canonical, input.commit);
              jobCreated = true;
            }
            wrote = true;
            uuid = await jobsOf().addRun(canonical, input.commit, input.log);
          }
          if (input.finish !== undefined) {
            wrote = true;
            await jobsOf().finish(canonical, input.commit, uuid, input.finish);
          }

          // The confirmation: `rad-job` chose the job for the run and for the finish, so where
          // the run landed, and whether the finish reached it, is read, not assumed.
          const after = ownRunByUuid(await jobsFor(canonical, input.commit), self.nid, uuid);
          if (after === null) {
            throw new Error(`rad-job run printed ${uuid}, and no job for ${input.commit} holds it`);
          }
          if (input.finish !== undefined && after.status !== input.finish) {
            // `rad-job` finishes on the FIRST job it finds for the commit, and exits 0 when that
            // job does not hold the run. Only a duplicate job ordered ahead of ours gets here, and
            // it stays ahead: no retry can finish this run.
            throw new RefusedError(
              `run ${uuid} is on job ${after.jobId}, and rad-job can only finish runs on the ` +
                `first job for ${input.commit}, which is another one; this run cannot be finished`,
              409,
            );
          }
          return { ...after, created: existing === null, jobCreated };
        } finally {
          if (wrote) await announce(canonical);
        }
      });
    }) as RadicleService["recordRun"],

    async submitChange(rid, input) {
      const canonical = normalizeRid(rid);
      // ONE submission at a time per repository: the scratch repo is private, but the push
      // lands in the shared storage repository, and so does the description edit that follows
      // it. The no-op check is inside the lock too — outside it, two identical submissions
      // would both read "not there yet" and both push.
      return await lockOn(canonical, async () => {
        const identity = await repo(canonical);
        const self = identity.self;

        if (!isFullOid(input.headSha) || !isFullOid(input.baseSha)) {
          throw new RefusedError("baseSha and headSha must both be full 40-character object ids");
        }

        // An identical re-submission of an existing change request is a NO-OP, not a failure:
        // git itself answers "Everything up-to-date" and never reaches the remote helper, so
        // there is no id to scrape. Deciding it here makes the answer the same either way.
        if (input.changeRef !== undefined) {
          const existing = await getChange(canonical, input.changeRef);
          const latest = existing.revisions[existing.revisions.length - 1];
          if (latest?.head === input.headSha) {
            return {
              ref: existing.id,
              revision: latest.id,
              created: false,
              url: renderExplorerUrl(deps.explorerUrl, {
                rid: canonical,
                id: existing.id,
                kind: "patches",
              }),
            };
          }
        }

        const scratch = await mkdtemp(join(deps.scratchDir, "submit-"));
        try {
          const header = await readBundleHeader(input.bundlePath);
          const carried = header.refs.find((r) => r.sha === input.headSha) ??
            (header.refs.length === 1 ? header.refs[0] : undefined);
          if (carried === undefined) {
            throw new RefusedError(
              `the bundle carries ${header.refs.length} refs and none is ${input.headSha}`,
            );
          }

          // A scratch repository, NOT a clone: `objects/info/alternates` borrows storage's object
          // database, so the bundle's prerequisites resolve and the push has nothing to upload but
          // the new commits.
          orThrow("git init", await exec.git(scratch, ["init", "--quiet", "-b", "ryph-tmp", "."]));
          await mkdir(`${scratch}/.git/objects/info`, { recursive: true });
          await writeFile(
            `${scratch}/.git/objects/info/alternates`,
            `${exec.storageDir(canonical)}/objects\n`,
          );

          const verified = await exec.git(scratch, ["bundle", "verify", input.bundlePath]);
          if (verified.code !== 0) {
            throw new RefusedError(
              `the bundle does not apply to this repository: ${
                verified.stderr.trim().slice(0, 500)
              }`,
            );
          }
          orThrow(
            "git fetch <bundle>",
            await exec.git(scratch, [
              "fetch",
              "--quiet",
              input.bundlePath,
              `+${carried.ref}:refs/heads/ryph-change`,
            ]),
          );
          const head = orThrow(
            "git rev-parse",
            await exec.git(scratch, ["rev-parse", "refs/heads/ryph-change"]),
          ).stdout.trim();
          if (head !== input.headSha) {
            throw new RefusedError(
              `the bundle's ${carried.ref} is ${head}, not the ${input.headSha} you named`,
            );
          }
          // git-remote-rad reads the WORKING repository's HEAD when it sets up the patch upstream,
          // and an unborn HEAD makes the push fail with `UnbornBranch` AFTER the COB has already
          // been created — a half-success that leaves a stray change request behind. Measured.
          orThrow(
            "git symbolic-ref",
            await exec.git(scratch, ["symbolic-ref", "HEAD", "refs/heads/ryph-change"]),
          );
          orThrow(
            "git remote add",
            await exec.git(scratch, ["remote", "add", "rad", `rad://${canonical.slice(4)}`]),
          );
          orThrow(
            "git config",
            await exec.git(scratch, [
              "config",
              "remote.rad.pushurl",
              `rad://${canonical.slice(4)}/${self.nid}`,
            ]),
          );

          // The TITLE rides `-o patch.message`; the DESCRIPTION does not, and cannot. git itself
          // refuses with "push options must not have new line characters", so a two-paragraph
          // description is unrepresentable there — measured against git 2.x and rad 1.10.2. The
          // description is therefore set with a `revision.edit` action after the push, which is
          // also the only way to keep its whitespace exactly as the caller wrote it (the helper
          // joins several `-o patch.message` values with a blank line of its own).
          const title = oneLine(input.title);
          const pushArgs = ["push"];
          let target: string;
          if (input.changeRef === undefined) {
            // And a title that is not PLAIN ASCII cannot ride a push option either. git
            // C-quotes an option value that needs quoting before it hands it to a remote helper
            // (`quote_c_style`, transport-helper.c) and `git-remote-rad` does not unquote it, so
            // `-o patch.message=Don’t` reaches the helper as a literal `"patch.message=Don\342…"`
            // and the whole push dies with `unknown push option`. An agent writes these titles,
            // and a typographic apostrophe is what a model reaches for — measured against
            // rad 1.10.2 and git 2.51. So such a title is left off the push and set below,
            // beside the description, where it is just JSON.
            if (isPushOptionSafe(title)) pushArgs.push("-o", `patch.message=${title}`);
            pushArgs.push("-o", `patch.base=${input.baseSha}`);
            if (input.draft) pushArgs.push("-o", "patch.draft");
            target = "refs/patches";
          } else {
            pushArgs.push("-f");
            target = `refs/heads/patches/${await resolveId(canonical, "change", input.changeRef)}`;
          }
          // The announce is ours to make, after the COB has been confirmed — the helper's own
          // sync would block on a node that may not be up.
          pushArgs.push("-o", "no-sync", "rad", `refs/heads/ryph-change:${target}`);

          const pushed = await exec.git(scratch, pushArgs, { timeoutMs: 300_000 });
          if (pushed.code !== 0) {
            throw new Error(
              `git push to ${canonical} failed (exit ${pushed.code}): ` +
                `${pushed.stderr.trim().slice(0, 1000)}`,
            );
          }
          diag.debug("radicle.pushed", { rid: canonical, target, stderr: pushed.stderr.trim() });

          // The hint: `✓ Patch <id> opened` / `✓ Patch <short> updated to revision <id>`.
          const scraped = fullOidsIn(pushed.stderr);
          const changeId = input.changeRef !== undefined
            ? await resolveId(canonical, "change", input.changeRef)
            : scraped[0];
          if (changeId === undefined) {
            throw new Error(
              `the push succeeded but announced no patch id: ${pushed.stderr.trim().slice(0, 500)}`,
            );
          }

          // The confirmation. Everything above is a hint until this read agrees.
          let change = await getChange(canonical, changeId);
          let latest = change.revisions[change.revisions.length - 1];
          if (latest === undefined || latest.head !== input.headSha) {
            throw new Error(
              `the change request ${changeId} does not carry ${input.headSha} after the push ` +
                `(latest revision is ${latest?.head ?? "absent"})`,
            );
          }

          // The description verbatim, with its files, and the title where the push could not
          // carry it, now that there is a revision to hang them on. One op for all: one edit.
          const stored = await storeEmbeds(canonical, input.embeds);
          const sameFiles = (latest.embeds ?? []).map((e) => `${e.name}:${e.oid}`).join() ===
            stored.map((e) => `${e.name}:${e.oid}`).join();
          const edits: Array<Record<string, unknown>> = [];
          if (input.description !== latest.description || !sameFiles) {
            edits.push({
              type: "revision.edit",
              revision: latest.id,
              description: input.description,
              embeds: embedsJson(stored),
            });
          }
          if (input.changeRef === undefined && title !== "" && change.title !== title) {
            edits.push({ type: "edit", title, target: change.target });
          }
          if (edits.length > 0) {
            await updateCobUnlocked(
              canonical,
              "change",
              changeId,
              edits,
              "Set the title and description",
              "submit_change",
              edits.some((e) => e.type === "revision.edit") ? stored : [],
            );
            change = await getChange(canonical, changeId);
            latest = change.revisions[change.revisions.length - 1];
          }
          await announce(canonical);
          return {
            ref: change.id,
            revision: latest.id,
            created: true,
            url: renderExplorerUrl(deps.explorerUrl, {
              rid: canonical,
              id: change.id,
              kind: "patches",
            }),
          };
        } finally {
          await rm(scratch, { recursive: true }).catch(() => {});
        }
      });
    },

    async addComment(rid, kind, given, input) {
      const id = await resolveId(rid, kind, given);
      const stored = await storeEmbeds(rid, input.embeds);
      const files = stored.length > 0 ? { embeds: embedsJson(stored) } : {};
      if (kind === "issue") {
        // An issue has no unthreaded comments: a "top-level" one replies to the ROOT comment,
        // whose id is the issue's own (`rad issue comment` does `reply_to.unwrap_or(root)`). An
        // action with no `replyTo` is accepted by the COB and listed by `rad issue show`, but a
        // client that builds the thread as root + replies — Radicle Desktop — never renders it.
        const action: Record<string, unknown> = {
          type: "comment",
          body: input.body,
          replyTo: input.replyTo ?? id,
          ...files,
        };
        return {
          id: await updateCob(rid, kind, id, [action], "Comment", "add_comment", stored),
        };
      }
      // On a change request a comment hangs off a REVISION — the latest one, which is what a
      // human means by "comment on this patch".
      const change = await getChange(rid, id);
      const revision = change.revisions[change.revisions.length - 1];
      if (revision === undefined) {
        throw new RefusedError(`change request ${id} has no revisions to comment on`, 409);
      }
      const action: Record<string, unknown> = {
        type: "revision.comment",
        revision: revision.id,
        body: input.body,
        ...files,
      };
      if (input.replyTo !== undefined) action.replyTo = input.replyTo;
      return { id: await updateCob(rid, kind, id, [action], "Comment", "add_comment", stored) };
    },

    async editComment(rid, kind, given, commentId, input) {
      const id = await resolveId(rid, kind, given);
      // An edit's embeds REPLACE the comment's, as its body replaces the text.
      const stored = await storeEmbeds(rid, input.embeds);
      const embeds = embedsJson(stored);
      if (kind === "issue") {
        return {
          id: await updateCob(
            rid,
            kind,
            id,
            [{ type: "comment.edit", id: commentId, body: input.body, embeds }],
            "Edit comment",
            "edit_comment",
            stored,
          ),
        };
      }
      // A patch COB has NO `comment.edit` action — measured: it fails with "data did not match
      // any variant". The comment has to be located first, because the edit names its revision
      // (or its review, for an inline remark).
      const located = await locateChangeComment(rid, id, commentId);
      const action = located.reviewId === null
        ? {
          type: "revision.comment.edit",
          revision: located.revisionId,
          comment: commentId,
          body: input.body,
          embeds,
        }
        : {
          type: "review.comment.edit",
          review: located.reviewId,
          comment: commentId,
          body: input.body,
          embeds,
        };
      return {
        id: await updateCob(rid, kind, id, [action], "Edit comment", "edit_comment", stored),
      };
    },

    async reactToComment(rid, kind, given, commentId, input) {
      const id = await resolveId(rid, kind, given);
      const active = input.active ?? true;
      if (kind === "issue") {
        return {
          id: await updateCob(
            rid,
            kind,
            id,
            [{ type: "comment.react", id: commentId, reaction: input.reaction, active }],
            "React",
            "add_reaction",
          ),
        };
      }
      const located = await locateChangeComment(rid, id, commentId);
      const action = located.reviewId === null
        ? {
          type: "revision.comment.react",
          revision: located.revisionId,
          comment: commentId,
          reaction: input.reaction,
          active,
        }
        : {
          type: "review.comment.react",
          review: located.reviewId,
          comment: commentId,
          reaction: input.reaction,
          active,
        };
      return { id: await updateCob(rid, kind, id, [action], "React", "add_reaction") };
    },

    async submitReview(rid, given, input) {
      // The whole review is one write: the verdict and every inline remark are separate COB
      // operations, and a review interleaved between them would be appended to a review this
      // call had already decided did not exist.
      return await lockOn(rid, async () => {
        const id = await resolveId(rid, "change", given);
        const cob = await showCob(rid, "change", id);
        const change = materializeChange(id, cob);
        const revision = change.revisions[change.revisions.length - 1];
        if (revision === undefined) {
          throw new RefusedError(`change request ${id} has no revisions to review`, 409);
        }
        const self = await readSelf();
        const stored = await storeEmbeds(rid, input.summaryEmbeds);
        // A summary with files is written by `review.edit.v2`, the one review action that
        // carries embeds (heartwood's `ReviewEdit::V2`); `review` itself has none.
        const filedEdit = (review: string): Record<string, unknown> => {
          const edit: Record<string, unknown> = {
            type: "review.edit.v2",
            review,
            summary: input.summary ?? "",
            embeds: embedsJson(stored),
          };
          if (input.verdict !== undefined) edit.verdict = input.verdict;
          return edit;
        };
        // Radicle allows ONE review per author per revision. A second call edits the existing one
        // and appends its remarks, rather than failing — which is what the tool contract promises.
        const priorId = existingReviewId(cob, revision.id, self.nid);
        const actions: Array<Record<string, unknown>> = [];
        if (priorId === null) {
          const review: Record<string, unknown> = { type: "review", revision: revision.id };
          if (input.summary !== undefined) review.summary = input.summary;
          if (input.verdict !== undefined) review.verdict = input.verdict;
          actions.push(review);
        } else if (stored.length > 0) {
          actions.push(filedEdit(priorId));
        } else {
          const edit: Record<string, unknown> = { type: "review.edit", review: priorId };
          if (input.summary !== undefined) edit.summary = input.summary;
          if (input.verdict !== undefined) edit.verdict = input.verdict;
          actions.push(edit);
        }
        const reviewId = await updateCobUnlocked(
          rid,
          "change",
          id,
          actions,
          priorId === null ? "Review" : "Update review",
          "submit_review",
          priorId === null ? [] : stored,
        );
        // The review's id is the id of the op that CREATED it; an edit's op id is its own.
        const effectiveReview = priorId ?? reviewId;
        // A NEW review's files follow in an edit of their own: the edit names the review by the
        // id of the op that created it, which no action can know inside that same op.
        if (priorId === null && stored.length > 0) {
          await updateCobUnlocked(
            rid,
            "change",
            id,
            [filedEdit(reviewId)],
            "Embed files",
            "submit_review",
            stored,
          );
        }

        const comments: string[] = [];
        for (const remark of input.remarks ?? []) {
          // Radicle line ranges are half-open over the diff's own 1-based line numbers: line 1
          // is `1..2`. heartwood's review builder starts a range at git's `hunk.new_line_no`,
          // and Radicle Desktop writes `{start: first, end: last + 1}` and renders `R<start>` —
          // an off-by-one here anchors every remark a line high (`R0` for the first line).
          const start = Math.max(1, remark.line);
          const range = { type: "lines", range: { start, end: start + 1 } };
          comments.push(
            await updateCobUnlocked(
              rid,
              "change",
              id,
              [{
                type: "review.comment",
                review: effectiveReview,
                body: remark.body,
                location: {
                  commit: remark.side === "old" ? revision.base : revision.head,
                  path: remark.path,
                  old: remark.side === "old" ? range : null,
                  new: remark.side === "new" ? range : null,
                },
              }],
              "Review comment",
              "submit_review",
            ),
          );
        }
        return { reviewId: effectiveReview, comments, edited: priorId !== null };
      });
    },

    async addLabels(rid, kind, given, labels) {
      // Read-modify-write: the current labels are read and the new set is written whole, so
      // two concurrent calls outside the lock would each drop the other's label.
      return await lockOn(rid, async () => {
        const id = await resolveId(rid, kind, given);
        await requireDelegate(rid, "add_labels");
        const current = kind === "issue"
          ? (await getIssue(rid, id)).labels
          : (await getChange(rid, id)).labels;
        const merged = [...new Set([...current, ...labels])].sort();
        await updateCobUnlocked(
          rid,
          kind,
          id,
          [{ type: "label", labels: merged }],
          "Label",
          "add_labels",
        );
        return merged;
      });
    },
  };

  /** Which revision (and, for an inline remark, which review) a comment on a change lives in. */
  async function locateChangeComment(
    rid: string,
    id: string,
    commentId: string,
  ): Promise<{ revisionId: string; reviewId: string | null }> {
    const change = materializeChange(id, await showCob(rid, "change", id));
    for (const review of change.reviews) {
      if (review.comments.some((c) => c.id === commentId)) {
        return { revisionId: review.revision, reviewId: review.id };
      }
    }
    const comment = change.comments.find((c) => c.id === commentId);
    if (comment?.revision !== undefined) return { revisionId: comment.revision, reviewId: null };
    throw new RefusedError(`no comment ${commentId} on change request ${id}`, 404);
  }
}
