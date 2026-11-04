// Turning a node's event stream into deliveries — and, more importantly, not depending on it.
//
// heartwood is explicit that the stream is lossy: `subscribe` is a bounded channel, a consumer
// that falls behind is dropped without being told, and NOTHING is replayed after a reconnect or
// a node restart. So the design here is:
//
//   the stream is the fast path.  RECONCILE is the correctness path.
//
// Reconcile walks every seeded repository's COB references in storage and processes any whose
// oid differs from its cursor. It runs at start, on every EOF (with backoff), and on a timer.
// If the socket never worked at all, the bridge would still deliver everything — just later.
//
// It watches one thing besides COBs: the repository's CANONICAL default branch — the
// `refs/heads/<default>` the node recomputes once the delegates reach quorum — and mints a
// `branch.updated` when it moves. A peer's own copy under `refs/namespaces/<nid>/` never counts,
// for the reason a fork's push does not on GitHub. Its last-seen commit is kept in the same
// cursor store, under the canonical ref's own name, and read back rather than taken from the
// event: whether a fetch's `refsFetched` names the canonical ref itself, or only the delegates'
// namespaced copies it was computed from, is not something this consumer depends on.
//
// Out of a change request's ops it mints two kinds: a comment, and a REVISION — the op that
// opens a change request and every push after it — as `change_request.pushed`, naming the head
// and the default branch (the only target a Radicle change request has). The control plane
// runs the repository's checks on it, as GitHub's `synchronize` has it do for a pull request.
//
// Four rules the consumer keeps:
// - DRAIN FIRST. An event is copied into memory and acknowledged by being copied; the socket is
//   never made to wait on a subprocess, or the node evicts us and we lose the fast path.
// - OUR OWN OPS ARE NOT NEWS. Every op is signed, so "did ryph write this" is a comparison, not
//   a heuristic. Ops authored by our NID are dropped before anything is minted.
// - FIRST SIGHT IS NOT A BACKLOG. A repository with no cursors at all has its cursors SET and
//   nothing emitted. Seeding a five-year-old repository must not replay five years of comments
//   into somebody's inbox.
// - A CURSOR MOVES ONLY OVER DELIVERED EVENTS. Storage is the only copy: a cursor that advanced
//   past a POST the mailroom refused would make that comment unreachable forever, because the
//   next reconcile compares equal and never looks again. So one retryable failure holds the
//   reference's cursor and the whole `old..new` range is re-sent next pass; a TERMINAL refusal
//   (400, 422 — a payload that will never be accepted) advances, because wedging a reference
//   forever over one unsendable event loses everything said after it.

import { createHash } from "node:crypto";
import type { RadExec } from "../ports/rad.ts";
import {
  isRefsFetched,
  type NodeControl,
  type NodeEvent,
  type RefsFetched,
  type RefUpdate,
} from "../ports/node.ts";
import type { CursorStore } from "../ports/cursor_store.ts";
import type { BridgeEvent, EventSink } from "../ports/event_sink.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { CHANGE_TYPE, ISSUE_TYPE, type RadicleService, type ThreadKind } from "./service.ts";
import { latestRevision, materializeChange, mergedHeadsOf, toDid } from "./materialize.ts";
import { normalizeRid, renderExplorerUrl } from "../helpers/ids.ts";
import { withRepoLock } from "../helpers/repo_lock.ts";
import type { RepoIdentity } from "./types.ts";

/** `refs/namespaces/<nid>/refs/cobs/<type>/<cob id>` — the only refs this consumer cares about. */
const COB_REF =
  /^refs\/namespaces\/(z[1-9A-HJ-NP-Za-km-z]+)\/refs\/cobs\/([A-Za-z0-9.]+)\/([0-9a-f]{40})$/;

/** A default branch name as an identity document spells one, held to what may ride a ref —
 * the rule the git door's HEAD applies too (helpers/export_repo.ts). */
const BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,200}$/;
const isBranchName = (branch: string): boolean =>
  BRANCH_NAME.test(branch) && !branch.includes("..") && !branch.startsWith("-");

/** Where the canonical default branch's last-seen commit is kept: under the canonical ref's own
 * name, which no COB reference (`refs/namespaces/…`) can collide with. */
const headCursor = (branch: string): string => `refs/heads/${branch}`;
const isHeadCursor = (ref: string): boolean => ref.startsWith("refs/heads/");

/** A `refsFetched` update that could have moved a branch: the canonical ref itself, or a
 * peer's copy of one (the delegates' copies are what the canonical one is computed from). */
const TOUCHES_BRANCH = /^(refs\/namespaces\/[^/]+\/)?refs\/heads\//;

/** Which COB action kinds are somebody saying something. */
const COMMENT_ACTIONS = new Set(["comment", "revision.comment", "review.comment"]);

/** A change request's revision: its first (the one that opens it) and every push after. */
const REVISION_ACTION = "revision";

/** A change request's state set by its author — `{ status: "open" | "draft" | "archived" }`. */
const LIFECYCLE_ACTION = "lifecycle";

/** A page for a human to open, so only ever a web link: anything else is no link at all. */
const webLink = (url: string | null): string | null => url?.startsWith("https://") ? url : null;

/** A full commit id, as a revision's `oid` must be. */
const FULL_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The key the consumer's work on one repository holds in user mode — and the one a disconnect
 * clears that repository's cursors under, so neither can interleave with the other. Its own
 * namespace beside the service's per-RID write lock: the consumer never takes that one (it only
 * reads), so holding this while the service holds that cannot deadlock.
 */
export const consumerLockKey = (rid: string): string => `events:${rid}`;

export interface ParsedCobRef {
  nid: string;
  typeName: string;
  cob: string;
}

export function parseCobRef(ref: string): ParsedCobRef | null {
  const match = COB_REF.exec(ref);
  if (match === null) return null;
  return { nid: match[1], typeName: match[2], cob: match[3] };
}

/** The ref a `refsFetched` update wrote, or null for a delete or a skip. */
function updateName(update: RefUpdate): string | null {
  return "updated" in update
    ? update.updated.name
    : "created" in update
    ? update.created.name
    : null;
}

function kindOf(typeName: string): ThreadKind | null {
  if (typeName === ISSUE_TYPE) return "issue";
  if (typeName === CHANGE_TYPE) return "change";
  return null;
}

/** One entry of `rad cob log --format json`. */
interface CobOp {
  id: string;
  author: string;
  timestamp: number;
  actions: Array<Record<string, unknown>>;
}

export interface EventConsumerDeps {
  service: RadicleService;
  exec: RadExec;
  node: NodeControl;
  cursors: CursorStore;
  sink: EventSink;
  diag: Diagnostics;
  /** The slow timer. Default 300s. */
  reconcileIntervalMs?: number;
  /**
   * The PULL timer — how often every seeded repository is fetched from the network. Default
   * 60s, deliberately tighter than the reconcile: see `pull` for why a bridge that only
   * listens hears nothing.
   */
  pullIntervalMs?: number;
  /** The budget for one repository's pull. Generous on purpose — see `pull`. Default 45s. */
  pullTimeoutMs?: number;
  /** How long to wait after an EOF before resubscribing. Doubles up to 30s. */
  reconnectDelayMs?: number;
  /** `RYPH_RADICLE_EXPLORER_URL`, so a pushed change request can carry its page. */
  explorerUrl?: string | null;
  /**
   * USER MODE: treat the node's `localRefsAnnounced` as news about a tracked repository, and
   * reconcile it. See `handle`. Off in a deployment, where the only local writer is this bridge.
   */
  reconcileLocalWrites?: boolean;
  /**
   * Whether a change request's new head is minted as `change_request.pushed` — the control
   * plane's cue to run its checks. Default on; a user-mode bridge, which runs no checks, says
   * off, and then neither a stranger's revision nor a reopen asks for any.
   */
  mintPushes?: boolean;
  /**
   * USER MODE: each repository's reconcile and fetch handling runs under `consumerLockKey`, with
   * its scope asked again inside. A repository disconnected while a pass was on its way to it
   * (the pass snapshots the tracked set first) is then skipped, rather than given its cursors
   * back — which would make the next connect a replay instead of a first sight. Off in a
   * deployment, whose repositories never leave scope that way, so its passes stay concurrent.
   */
  serializeByRepo?: boolean;
}

export interface EventConsumer {
  /** Starts the subscription loop and the reconcile timer. Returns immediately. */
  start(): void;
  stop(): Promise<void>;
  /** One reconcile pass over every seeded repository. Answers how many events it minted. */
  reconcile(): Promise<number>;
  /** One pull pass: `rad sync --fetch` over every seeded repository, in turn. */
  pull(): Promise<void>;
  /** Processes one event synchronously — what the loop does, exposed so a test can drive it. */
  handle(event: NodeEvent): Promise<number>;
  /** Waits for the in-memory queue to empty. */
  idle(): Promise<void>;
}

export function makeEventConsumer(deps: EventConsumerDeps): EventConsumer {
  const { service, exec, node, cursors, sink, diag } = deps;
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? 300_000;
  const pullIntervalMs = deps.pullIntervalMs ?? 60_000;
  const pullTimeoutMs = deps.pullTimeoutMs ?? 45_000;
  const baseDelayMs = deps.reconnectDelayMs ?? 1_000;

  const queue: NodeEvent[] = [];
  let pumping: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pullTimer: ReturnType<typeof setInterval> | null = null;
  let loop: Promise<void> | null = null;
  const abort = new AbortController();

  const ourNid = async (): Promise<string> => {
    const did = await service.selfDid();
    return did.startsWith("did:key:") ? did.slice("did:key:".length) : did;
  };

  /** The op ids a reference gained, oldest first. `old` null: everything it reaches. */
  const newOps = async (rid: string, oldOid: string | null, newOid: string): Promise<string[]> => {
    const dir = service.storageDir(rid);
    const range = oldOid === null ? [newOid] : [`${oldOid}..${newOid}`];
    const out = await exec.git(dir, ["rev-list", "--reverse", ...range]);
    if (out.code !== 0) {
      // An old cursor whose commit storage no longer has (a redacted COB, a pruned object):
      // fall back to the whole reachable history rather than skipping the reference entirely.
      if (oldOid !== null) return await newOps(rid, null, newOid);
      diag.warn("events.rev_list_failed", { rid, newOid, err: out.stderr.trim().slice(0, 300) });
      return [];
    }
    return out.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  };

  /** Every op of a COB, by id — `rad cob log` is per OBJECT, not per reference. */
  const opsOf = async (rid: string, kind: ThreadKind, cob: string): Promise<Map<string, CobOp>> => {
    const out = await exec.rad([
      "cob",
      "log",
      "--repo",
      rid,
      "--type",
      kind === "issue" ? ISSUE_TYPE : CHANGE_TYPE,
      "--object",
      cob,
      "--format",
      "json",
    ]);
    const ops = new Map<string, CobOp>();
    if (out.code !== 0) {
      diag.warn("events.cob_log_failed", { rid, cob, err: out.stderr.trim().slice(0, 300) });
      return ops;
    }
    for (const line of out.stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as CobOp;
        if (typeof parsed.id === "string") ops.set(parsed.id, parsed);
      } catch {
        diag.warn("events.unreadable_op", { rid, cob, line: line.slice(0, 200) });
      }
    }
    return ops;
  };

  /**
   * Whether a delivery that failed may be given up on.
   *
   * `held` is the one answer that must not advance the cursor: the mailroom was restarting, the
   * socket was dead, it answered 503. The event exists only in storage, and a cursor that moved
   * past it would make it unreachable forever — the next reconcile would compare equal and
   * never look again. `done` covers a success and a TERMINAL refusal (400, 422): a payload this
   * consumer will never be able to send is not a reason to wedge the reference and re-send the
   * same rejected thing on every pass for the life of the deployment.
   */
  type DeliveryOutcome = "done" | "held";

  /**
   * The sink is down for the REST OF THIS PASS. Reset when one begins.
   *
   * Deliveries are sequential and each one waits out the sink's timeout, so a mailroom that is
   * unreachable costs `refs × events × timeout` per pass — in one cluster, a NetworkPolicy that
   * dropped the bridge's POSTs made a pass take minutes and hold every cursor anyway. The first
   * RETRYABLE failure is all the evidence needed: the rest of the pass holds its cursors
   * without asking, which is the same end state, reached in seconds. A TERMINAL refusal says
   * nothing about the sink's health and does not trip it.
   */
  let sinkDown = false;

  const deliver = async (event: BridgeEvent): Promise<DeliveryOutcome> => {
    if (sinkDown) return "held";
    const outcome = await sink.deliver(event);
    if (outcome.kind === "ok") return "done";
    diag.warn("events.delivery_failed", {
      deliveryId: event.deliveryId,
      terminal: outcome.terminal,
      err: outcome.message,
    });
    if (outcome.terminal) return "done";
    sinkDown = true;
    return "held";
  };

  /**
   * How many consecutive reconciles have held each reference's cursor, so a mailroom that has
   * been down for an hour writes a handful of lines rather than one per pass per reference.
   * The RETRY cadence is not in here: that is the reconcile timer and the reconnect backoff,
   * which already widen on their own.
   */
  const holds = new Map<string, number>();

  /**
   * The repository's default branch as its identity document names it now, or null when it
   * cannot be read or could not ride a ref — the base every change request targets.
   */
  const defaultBranchOf = async (rid: string): Promise<string | null> => {
    let branch: string;
    try {
      branch = (await service.repo(rid)).defaultBranch;
    } catch (err) {
      diag.warn("events.identity_unreadable", { rid, err: String(err) });
      return null;
    }
    if (!isBranchName(branch)) {
      diag.warn("events.default_branch_unusable", { rid, branch: branch.slice(0, 200) });
      return null;
    }
    return branch;
  };

  /** One COB reference that moved. Answers how many events were minted. */
  const processRef = async (
    rid: string,
    ref: string,
    parsed: ParsedCobRef,
    newOid: string,
  ): Promise<number> => {
    const kind = kindOf(parsed.typeName);
    if (kind === null) return 0; // an identity COB, or a type invented after this bridge
    const self = await ourNid();
    const oldOid = await cursors.get(rid, ref);
    if (oldOid === newOid) return 0;

    // The materialization the reads below use comes out of the COB cache, which is only
    // refreshed by the node's OWN fetch. Refresh it here for the object that just moved.
    await service.recache(rid, kind, parsed.cob);

    let minted = 0;
    // The cursor moves only if EVERY delivery for this reference got somewhere. One held
    // delivery holds the whole `old..new` range, and the next pass re-sends all of it — the
    // delivery ids are derived, so the ones that already landed are the consumer's primary key
    // doing its job, not duplicates.
    let held = false;
    // A change request as it stands NOW: which revision is its latest, and whether it is still
    // open. Read before the ops, because a revision is only news while it is both.
    const change = kind === "change"
      ? materializeChange(parsed.cob, await service.showCob(rid, "change", parsed.cob))
      : null;
    const latest = change === null ? undefined : latestRevision(change);
    // Our own namespace is walked only for a change request, and only for a reopen (below):
    // everything else ryph writes is not news.
    if (parsed.nid !== self || change !== null) {
      const ids = await newOps(rid, oldOid, newOid);
      const ops = await opsOf(rid, kind, parsed.cob);
      // The branch a revision targets, read once per reference and only when one is there.
      let baseRef: string | null | undefined;
      /** A `change_request.pushed` for `headSha`, minted from one action of one op. */
      const push = async (opId: string, index: number, author: string, headSha: string) => {
        if (change === null || deps.mintPushes === false) return;
        if (baseRef === undefined) baseRef = await defaultBranchOf(rid);
        if (baseRef === null) return;
        const event: BridgeEvent = {
          deliveryId: `${rid}:${parsed.cob}:${opId}:${index}`,
          kind: "change_request.pushed",
          repoRef: rid,
          actor: { did: toDid(author) },
          thread: { kind: "change_request", ref: parsed.cob },
          changeRequest: {
            headSha,
            baseRef,
            author: change.author.did,
            url: webLink(renderExplorerUrl(deps.explorerUrl, {
              rid,
              id: parsed.cob,
              kind: "patches",
            })),
          },
        };
        if (await deliver(event) === "held") held = true;
        minted++;
      };
      for (const opId of ids) {
        const op = ops.get(opId);
        if (op === undefined) continue;
        // Belt and braces: the reference is in a namespace, but the op carries its own author.
        const ours = parsed.nid === self || op.author === self;
        for (let index = 0; index < (op.actions ?? []).length; index++) {
          const action = op.actions[index];
          const type = typeof action?.type === "string" ? action.type : "";
          if (change !== null && type === LIFECYCLE_ACTION) {
            // A change request REOPENED — archived, and now open again — asks for its checks
            // anew: the head is the one it had, and whatever was asked for it was withdrawn
            // when it closed. Whoever reopened it, ryph included (only the author may), since
            // the control plane decides who may make it run; and only while it is still open.
            // A draft marked ready is the same op, and asks again for a head already asked
            // for — the control plane's to recognise.
            const status = (action.state as { status?: unknown } | undefined)?.status;
            if (status !== "open" || change.state !== "open") continue;
            if (latest === undefined || !FULL_OID.test(latest.head)) continue;
            await push(opId, index, op.author, latest.head);
            continue;
          }
          if (ours) continue;
          if (change !== null && type === REVISION_ACTION) {
            // A new head — the change request opening, or a later push. Ours never reach here
            // (the patch flow asked for its own checks); whether a stranger's head may run is
            // the control plane's call, made against the repository's delegates.
            //
            // Only the LATEST revision of a change request still open counts — latest by its
            // AUTHOR, as heartwood's `Patch::latest` and the forge's thread read have it, so the
            // head checked is the head the control plane reads back. A stranger's revision on
            // top is a proposal, not the change request, and never hides the author's. A
            // namespace seen for the first time walks its whole history, and every older
            // revision in it is a head nobody wants checked any more; nor does a merged or
            // archived change request. A draft is still open, as a draft pull request's pushes
            // are on GitHub.
            if (latest === undefined || opId !== latest.id) continue;
            if (change.state === "merged" || change.state === "archived") continue;
            const headSha = typeof action.oid === "string" ? action.oid : "";
            if (!FULL_OID.test(headSha)) {
              diag.warn("events.revision_without_head", { rid, cob: parsed.cob, opId });
              continue;
            }
            await push(opId, index, op.author, headSha);
            continue;
          }
          if (!COMMENT_ACTIONS.has(type)) continue;
          const body = typeof action.body === "string" ? action.body : "";
          const event: BridgeEvent = {
            deliveryId: `${rid}:${parsed.cob}:${opId}:${index}`,
            kind: "comment.created",
            repoRef: rid,
            actor: { did: toDid(op.author) },
            thread: { kind: kind === "issue" ? "issue" : "change_request", ref: parsed.cob },
            body,
            sourceCommentId: opId,
          };
          if (typeof action.revision === "string") event.revision = action.revision;
          if (await deliver(event) === "held") held = true;
          minted++;
        }
      }
    }

    // The lifecycle events are read from the MATERIALIZED state, not from an action: `merged`
    // is a threshold over several delegates' ops, so no single op means it. The delivery id is
    // stable, so a redelivery is the orchestrator's primary key doing its job
    // (`lifecycleDeliveryId`).
    if (change !== null) {
      if (change.state === "merged" || change.state === "archived") {
        const merged = change.state === "merged";
        const actorDid = merged ? (change.merges[0]?.did ?? toDid(parsed.nid)) : toDid(parsed.nid);
        // What merged, by commit: a delegate may merge an OLDER revision than the latest, and
        // only the control plane's containment question tells which pushes the merge carried.
        const heads = mergedHeadsOf(change).filter((m) =>
          FULL_OID.test(m.commit) && FULL_OID.test(m.revision)
        );
        if (merged && heads.length === 0) {
          diag.warn("events.merge_without_head", { rid, cob: parsed.cob });
        }
        const outcome = await deliver({
          deliveryId: lifecycleDeliveryId(rid, parsed.cob, merged ? heads : null),
          kind: merged ? "change_request.merged" : "change_request.closed",
          repoRef: rid,
          actor: { did: actorDid },
          thread: { kind: "change_request", ref: parsed.cob },
          ...(merged ? { merged: heads } : {}),
        });
        if (outcome === "held") held = true;
        minted++;
      }
    }

    if (held) {
      // Left exactly where it was, so the next reconcile — the timer, an EOF, or the event the
      // node sends when the reference moves again — walks the same range and tries again.
      const key = `${rid} ${ref}`;
      const attempts = (holds.get(key) ?? 0) + 1;
      holds.set(key, attempts);
      // Warn on the 1st, 2nd, 4th, 8th … hold and stay quiet in between: an outage that lasts
      // must not drown the log it is going to be diagnosed from.
      const details = { rid, ref, from: oldOid, to: newOid, attempts };
      if ((attempts & (attempts - 1)) === 0) diag.warn("events.cursor_held", details);
      else diag.debug("events.cursor_held", details);
      return minted;
    }
    holds.delete(`${rid} ${ref}`);
    await cursors.set(rid, ref, newOid);
    return minted;
  };

  /** Every COB reference a storage repository holds right now. */
  const listCobRefs = async (
    rid: string,
  ): Promise<Array<{ ref: string; oid: string; parsed: ParsedCobRef }>> => {
    const out = await exec.git(service.storageDir(rid), [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/namespaces/",
    ]);
    if (out.code !== 0) {
      diag.debug("events.for_each_ref_failed", { rid, err: out.stderr.trim().slice(0, 200) });
      return [];
    }
    const refs: Array<{ ref: string; oid: string; parsed: ParsedCobRef }> = [];
    for (const line of out.stdout.split("\n")) {
      const [oid, ref] = line.trim().split(" ");
      if (!oid || !ref) continue;
      const parsed = parseCobRef(ref);
      if (parsed === null) continue;
      refs.push({ ref, oid, parsed });
    }
    return refs;
  };

  /**
   * A repository nobody has ever had a cursor for gets its cursors SET and nothing emitted —
   * the "first sight is not a backlog" rule. Answers whether it did that.
   */
  const seedIfFirstSight = async (
    rid: string,
    refs: Array<{ ref: string; oid: string }>,
  ): Promise<boolean> => {
    // COB cursors only: the default branch's own cursor says nothing about whether the
    // repository's conversations were ever read.
    if ((await cursors.listByRepo(rid)).some((c) => !isHeadCursor(c.ref))) return false;
    for (const { ref, oid } of refs) await cursors.set(rid, ref, oid);
    diag.debug("events.first_sight", { rid, refs: refs.length });
    return true;
  };

  /**
   * The canonical default branch, read back out of storage and compared with its cursor.
   * Answers how many events it minted (0 or 1).
   *
   * The same delivery rules as a COB reference: first sight of a repository's default branch
   * SETS the cursor and emits nothing (the head a repository was seeded at is not news, and a
   * deployment upgrading into this must not announce every repository at once), and the cursor
   * moves only over a delivered event. The branch is the identity document's, read live, so a
   * renamed default arrives as a `branch.updated` naming the new one — the control plane's cue
   * to correct its record of it.
   */
  const trackDefaultHead = async (rid: string): Promise<number> => {
    let identity: RepoIdentity;
    try {
      identity = await service.repo(rid);
    } catch (err) {
      diag.debug("events.identity_unreadable", { rid, err: String(err) });
      return 0;
    }
    const branch = identity.defaultBranch;
    if (!isBranchName(branch)) {
      diag.warn("events.default_branch_unusable", { rid, branch: branch.slice(0, 200) });
      return 0;
    }
    const out = await exec.git(service.storageDir(rid), [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ]);
    if (out.code !== 0) {
      // No quorum yet, or a repository still arriving: nothing canonical to watch.
      diag.debug("events.no_canonical_head", { rid, branch });
      return 0;
    }
    const commit = out.stdout.trim();
    const key = headCursor(branch);
    const seen = await cursors.get(rid, key);
    if (seen === commit) return 0;
    if (seen === null && !(await cursors.listByRepo(rid)).some((c) => isHeadCursor(c.ref))) {
      await cursors.set(rid, key, commit);
      diag.debug("events.first_sight_of_default", { rid, branch, commit });
      return 0;
    }
    const outcome = await deliver({
      deliveryId: `${rid}:heads/${branch}:${commit}`,
      kind: "branch.updated",
      repoRef: rid,
      actor: { did: identity.self.did },
      branch: { ref: branch, commit },
    });
    if (outcome === "held") {
      // Left where it was: the next pass compares unequal and sends it again.
      diag.debug("events.default_head_held", { rid, branch, from: seen, to: commit });
      return 1;
    }
    await cursors.set(rid, key, commit);
    return 1;
  };

  const reconcileRepo = async (rid: string): Promise<number> => {
    const refs = await listCobRefs(rid);
    const moved = await trackDefaultHead(rid).catch((err) => {
      diag.warn("events.default_head_failed", { rid, err: String(err) });
      return 0;
    });
    if (refs.length === 0) return moved;
    if (await seedIfFirstSight(rid, refs)) return moved;
    let minted = moved;
    for (const { ref, oid, parsed } of refs) {
      try {
        minted += await processRef(rid, ref, parsed, oid);
      } catch (err) {
        diag.warn("events.ref_failed", { rid, ref, err: String(err) });
      }
    }
    return minted;
  };

  /** `work` on one repository, under its consumer lock and only while it is still in scope —
   * in user mode. A deployment runs it as it always did. */
  const inScopeOnly = async (
    rid: string,
    work: () => Promise<number>,
  ): Promise<number> => {
    if (!deps.serializeByRepo) return await work();
    return await withRepoLock(
      consumerLockKey(rid),
      async () => (await service.inScope(rid)) ? await work() : 0,
    );
  };

  const reconcile = async (): Promise<number> => {
    sinkDown = false;
    let minted = 0;
    for (const rid of await service.seededRepos()) {
      try {
        minted += await inScopeOnly(rid, () => reconcileRepo(rid));
      } catch (err) {
        diag.warn("events.reconcile_failed", { rid, err: String(err) });
      }
    }
    diag.debug("events.reconciled", { minted });
    return minted;
  };

  const handle = async (event: NodeEvent): Promise<number> => {
    sinkDown = false;
    if (!isRefsFetched(event)) {
      // `localRefsAnnounced` carries only a sigrefs oid and describes what was written on THIS
      // node. In a deployment that is only ever the bridge itself, and not news. In user mode
      // it is also the person: a patch merged on their own node (`git push rad`, `rad patch
      // merge`) never arrives as a fetch, so without this its `change_request.merged` and the
      // `branch.updated` behind it would wait for the slow timer. The event names the
      // repository and nothing else useful (`{rid, refs: {remote, at}, timestamp}`, measured
      // against rad 1.10.3), so the answer is that repository's whole reconcile — which also
      // keeps the person's own comments and revisions out, by the same rule as everywhere.
      //
      // Only as fast as the person's own tools announce: `git-remote-rad` skips the announce
      // when the node knows no seed for the repository, and then the reconcile timer is what
      // delivers it, as it always would have.
      if (deps.reconcileLocalWrites && event.type === "localRefsAnnounced") {
        // Canonical before anything compares or stores it: a RID spelled any other way would be
        // a second set of cursors for the same repository.
        let announced: string;
        try {
          announced = normalizeRid(String(event.rid ?? ""));
        } catch {
          diag.debug("events.unreadable_rid", { type: event.type, rid: String(event.rid) });
          return 0;
        }
        if (await service.inScope(announced)) {
          return await inScopeOnly(announced, () => reconcileRepo(announced));
        }
      }
      // Everything else that is not a fetch is somebody else's business.
      return 0;
    }
    let rid: string;
    try {
      rid = normalizeRid(event.rid);
    } catch {
      diag.debug("events.unreadable_rid", { type: event.type, rid: String(event.rid) });
      return 0;
    }
    // A user-mode node fetches every repository its owner seeds; only the tracked ones are ours.
    if (!(await service.inScope(rid))) return 0;
    return await inScopeOnly(rid, () => fetched(rid, event));
  };

  /** One `refsFetched` for a repository in scope. */
  const fetched = async (rid: string, event: RefsFetched): Promise<number> => {
    // A fetch that wrote any branch — the canonical one, or a delegate's copy it is computed
    // from — is when the default can have moved. Read back, not read off the event: see the
    // note at the top of this file.
    let minted = 0;
    if (event.updated.some((u) => TOUCHES_BRANCH.test(updateName(u) ?? ""))) {
      minted += await trackDefaultHead(rid).catch((err) => {
        diag.warn("events.default_head_failed", { rid, err: String(err) });
        return 0;
      });
    }
    const refs = await listCobRefs(rid);
    if (await seedIfFirstSight(rid, refs)) return minted;
    const current = new Map(refs.map((r) => [r.ref, r]));
    for (const update of event.updated) {
      const name = updateName(update);
      if (name === null) continue; // a delete or a skip moves nothing forward
      const entry = current.get(name);
      if (entry === undefined) continue; // named a ref storage no longer has
      try {
        minted += await processRef(rid, name, entry.parsed, entry.oid);
      } catch (err) {
        diag.warn("events.ref_failed", { rid, ref: name, err: String(err) });
      }
    }
    return minted;
  };

  /**
   * Fetch every seeded repository from the network, one at a time.
   *
   * WHY A BRIDGE THAT ONLY LISTENS HEARS NOTHING. Radicle's gossip does not guarantee that a
   * `refs announcement` reaches us: it walks the peers each node is connected to. Measured on
   * a GKE deployment — a maintainer's laptop connected to seven community nodes and none of the big
   * seeds pushed new sigrefs; they reached five community nodes and never iris, rosa or clem,
   * which were the only sessions that node had. Four minutes later this bridge had seen nothing,
   * while `rad sync --fetch` brought the refs down immediately. Waiting to be told is not a
   * delivery mechanism, so the bridge ASKS.
   *
   * Everything downstream is unchanged: the node emits `refsFetched` for a fetch WE asked for
   * too, so the subscription mints the events; the reconcile pass that follows is the belt to
   * that braces, for a stream that is down.
   *
   * Sequential, and each repository bounded by its own budget: one unreachable seed must not
   * hold up the rest, and two passes must never overlap — `pulling` is that guard, so a pass
   * that outlives its interval means the next tick is skipped rather than doubled.
   */
  const pullOnce = async (): Promise<void> => {
    // A policy a disconnect could not remove while the node was down is owed before anything
    // else is asked of it. A no-op in a deployment.
    await service.retryPendingUnseeds();
    for (const rid of await service.seededRepos()) {
      if (stopped) return;
      try {
        await service.fetchFromNetwork(rid, pullTimeoutMs);
      } catch (err) {
        // Non-fatal by contract. Nobody serving it, a seed that refused, a node that is still
        // fetching: the next pass asks again, and storage keeps answering in the meantime.
        diag.debug("events.pull_failed", { rid, err: String(err) });
      }
    }
  };

  let pulling: Promise<void> | null = null;

  const pull = (): Promise<void> => {
    if (pulling !== null) {
      diag.debug("events.pull_skipped", { reason: "the previous pull is still running" });
      return pulling;
    }
    pulling = pullOnce().finally(() => {
      pulling = null;
    });
    return pulling;
  };

  const pump = (): void => {
    if (pumping !== null) return;
    pumping = (async () => {
      while (queue.length > 0) {
        const event = queue.shift()!;
        try {
          await handle(event);
        } catch (err) {
          diag.warn("events.handle_failed", { type: event.type, err: String(err) });
        }
      }
    })().finally(() => {
      pumping = null;
      // A push that landed while the last iteration was unwinding would otherwise sit there.
      if (queue.length > 0 && !stopped) pump();
    });
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      abort.signal.addEventListener("abort", () => {
        clearTimeout(id);
        resolve();
      }, { once: true });
    });

  /**
   * Reconciles the timers start, tracked so `stop` can wait for them: a pass still writing
   * cursors when the host closes the database under it fails halfway, and loudly.
   */
  const inFlight = new Set<Promise<unknown>>();
  const tracked = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  };

  const run = async (): Promise<void> => {
    await service.retryPendingUnseeds().catch((err) =>
      diag.warn("events.unseed_retry_failed", { err: String(err) })
    );
    let delay = baseDelayMs;
    while (!stopped) {
      // Every (re)connect begins with a reconcile: whatever the stream missed while we were
      // away is exactly what this catches.
      await reconcile().catch((err) => diag.warn("events.reconcile_threw", { err: String(err) }));
      try {
        for await (const item of node.subscribe(abort.signal)) {
          if (item.kind === "eof") {
            diag.warn("events.stream_ended", { reason: item.reason });
            break;
          }
          // Drain first: into memory, and never make the node wait for a subprocess.
          queue.push(item.event);
          pump();
          delay = baseDelayMs;
        }
      } catch (err) {
        diag.warn("events.subscribe_threw", { err: String(err) });
      }
      if (stopped) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };

  return {
    start() {
      if (loop !== null) return;
      stopped = false;
      loop = run();
      timer = setInterval(() => {
        if (stopped) return;
        tracked(reconcile()).catch((err) =>
          diag.warn("events.timer_reconcile_failed", { err: String(err) })
        );
      }, reconcileIntervalMs);
      // The pull runs on its own, tighter cadence, and reconciles after itself — twice over:
      // a fetch that landed while the subscription was down would otherwise sit in storage
      // unnoticed, and a cursor HELD by an unreachable mailroom would otherwise wait for the
      // slow timer (300s) rather than the pull's (60s) before anything tried it again.
      pullTimer = setInterval(() => {
        if (stopped) return;
        tracked(pull().then(() => stopped ? 0 : reconcile()))
          .catch((err) => diag.warn("events.timer_pull_failed", { err: String(err) }));
      }, pullIntervalMs);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (pullTimer !== null) clearInterval(pullTimer);
      pullTimer = null;
      abort.abort();
      await loop?.catch(() => {});
      await pumping?.catch(() => {});
      await pulling?.catch(() => {});
      await Promise.allSettled([...inFlight]);
      loop = null;
    },
    reconcile,
    pull,
    handle,
    async idle() {
      while (queue.length > 0 || pumping !== null) await pumping ?? Promise.resolve();
    },
  };
}

/**
 * The delivery id of a change request's lifecycle event: `closed` for an archive (`merged`
 * null), else `merged`, with a digest of EVERY commit that merged, sorted, when the state names
 * one. So a later merge of the patch at another commit is a delivery of its own rather than a
 * duplicate of the first — rare, since heartwood's push merges only an open or draft patch, but
 * two delegates can each merge a revision before they sync, and the one that syncs late may be
 * the OLDER merge, which changes no newest head: only the whole set tells it apart. One id cannot
 * hold all twenty heads, so it holds their SHA-256.
 */
export function lifecycleDeliveryId(
  rid: string,
  cob: string,
  merged: ReadonlyArray<{ commit: string }> | null,
): string {
  if (merged === null) return `${rid}:${cob}:closed`;
  if (merged.length === 0) return `${rid}:${cob}:merged`;
  const commits = [...new Set(merged.map((m) => m.commit))].sort();
  const digest = createHash("sha256").update(commits.join("\n")).digest("hex");
  return `${rid}:${cob}:merged:${digest}`;
}
