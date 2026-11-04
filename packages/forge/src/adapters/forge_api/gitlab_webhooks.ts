// GitLab's webhooks, turned into ForgeEvent — the only file that knows what a Note Hook, a Merge
// Request Hook or a Push Hook looks like.
//
// A WEBHOOK IS A DOORBELL. The mailroom (@ryph/webhooks) checked the delivery's `X-Gitlab-Token`
// against the token derived for the project and generation its URL names, and wrote both into
// the row (`VERIFIED_SCOPE_HEADER`, `VERIFIED_GENERATION_HEADER`). That proves exactly one thing:
// whoever sent it holds the token a Maintainer of THAT project was shown. Everything in the body
// is that Maintainer's word — the actor, the note's text and author, the merge request's head and
// author, the project's path — so none of it is forwarded. What the body is read for is which
// bell rang: the event, and the handles it names (a note id, an iid, a discussion id). Then:
//
// 1. the control plane is asked whether the project is connected and the token's generation is
//    the one it hands out now (`GitlabHookGate`) — the door asked already, before it stored the
//    row (`gitlabDoorGate`), and this asks again in case a rotation came between; a rotated
//    token is refused before it costs a single API read, and an unconnected project costs
//    nothing either
// 2. GitLab is asked, with the bot's token and under the VERIFIED project, what is true
//    (`GitlabHookReads`): the project's path and URL, the note by (project, noteable, id), the
//    merge request by iid, the default branch's head — a handle naming nothing there is gone
// 3. the event is built from those answers alone, and carries the verified project id
//    (`repo.forgeId`) the control plane matches the repo on, and the stable user id of the actor
//    (`actorId`) it resolves the person by
//
// The one field no read returns is who pushed to or retargeted a merge request: that actor is
// the payload's. It only ever ADDS a subject to the control plane's gate (the author, read from
// GitLab, is asked too), and the one who could forge it holds Maintainer on the project, which
// clears that gate as themselves.
//
// A delivery id is never a header the sender wrote — those are a token holder's to pick, fresh on
// every ring. It is what GitLab answered, under the project: a note's own id, a merge request's
// state, head and last change (`mr:<iid>:<state>:<head>:<updated at>`), the commit the default
// branch is at (`push:<commit>:<branch tag>`). A ring for something that has not changed carries
// the id the first ring did, so the control plane answers it from its record before it asks
// GitLab anything, and this consumer — which remembers the ids it forwarded — does not even
// forward it. Every event forwarded spends, from the budget the reads spend, the GitLab calls the
// control plane may make handling it (`eventCost`): what one delivery can make the bot spend is
// bounded across every project, its own reads and the control plane's together. The most a
// delivery can spend (`hookCostAtMost`) is set aside before the mailroom claims it
// (`gitlabHookAdmission`), least-spent project first, and what it did not spend is given back.
//
// A note can make one command, however many deliveries — GitLab's resends, a Maintainer
// replaying it — name it. The mailroom drops
// those before they cost anything (`gitlabHookDedupeKey`): a note's creation is keyed by its id,
// and a delivery whose key one already taken in the project's queue carries is delivered unread —
// no control-plane question, no GitLab read. What a taken delivery is written down under is this
// consumer's word, never the body's: `note:<id>` once GitLab said that note is in the project
// (`ConsumeOutcome.dedupeKey`). Note ids are global and sequential, so a key taken from the body
// would let a token holder ring first for the next ids and have the real `/ryph` notes dropped as
// duplicates when GitLab rang for them. And a note is a
// command only while it is fresh: a token holder (or GitLab's "Test → Comments") can ring for any
// real note, and one written long before — while the hook was missing, disabled or stale, or
// before the project was connected at all — was never delivered here, so its id dedupes nothing.
// A note written more than `NOTE_MAX_AGE_MS` before the delivery was received, or before the
// project's current connection was made, is consumed and never forwarded.

import { createHash } from "node:crypto";
import { z } from "@zod/zod";
import {
  type ConsumeOutcome,
  type DeliveryAdmission,
  type DeliveryTicket,
  type Hook,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
} from "@ryph/webhooks";
import type { ForgeEvent, ForgeEventRepo } from "../../core/types.ts";
import { describeIssues } from "@ryph/shared/http";
import { actionMarker } from "../../core/provenance.ts";
import type {
  EventSink,
  GitlabHookGate,
  GitlabHookHeard,
  GitlabHookLane,
} from "../../ports/event_sink.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  type GitlabHookProject,
  type GitlabHookReads,
  type GitlabHookUser,
  type HookBudget,
  HookReservation,
  reservedHookReads,
} from "./gitlab_hook_reads.ts";

export interface GitlabWebhookDeps {
  sink: EventSink;
  diag: Diagnostics;
  /** The bot's own GitLab user id (`GitlabConnectApi.self.id`): its notes are dropped, since a
   * note carries no bot flag. */
  botUserId: string;
  /** Whether the verified project is connected and its token current — asked first. */
  gate: GitlabHookGate;
  /** GitLab, asked with the bot's token: what every event is built from. */
  reads: GitlabHookReads;
  /** Whether deliveries spend the GitLab call budget (`hookBudget`): each is then handed a
   * reservation of it by the mailroom (`gitlabHookAdmission`), which its reads and, for an event
   * it forwards, the control plane's calls handling it (`eventCost`) spend. One handed none is
   * retried, never read unbudgeted. Absent: unbudgeted. */
  budget?: HookBudget;
}

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A note's thread, by the per-project number a person sees (`#12`, `!7`). */
const noteable = z.object({ iid: id });

/**
 * Which note rang: its id, what it is on, and — a diff note — the discussion a reply and a
 * resolve act on, which is checked to hold the note before it is used. `action` only ever
 * drops a delivery (an edit carries no instruction), never admits one.
 */
const GitlabNoteSchema = z.object({
  object_attributes: z.object({
    id,
    noteable_type: z.string().trim().min(1).max(40),
    // "create" or "update" — both sent on every supported release (verified on 17.0.8 and
    // 17.11.7). Absent is still read as a creation.
    action: z.string().trim().min(1).max(40).nullable().optional(),
    discussion_id: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
  }),
  issue: noteable.optional(),
  merge_request: noteable.optional(),
});

/**
 * Which merge request rang, and why: `action` is `open`, `reopen`, `update`, `close`, `merge`,
 * `approved`, …; `oldrev` rides only an `update` that pushed commits, `changes.target_branch`
 * only one that retargeted it. `user` is the actor — see the header.
 */
const GitlabMergeRequestSchema = z.object({
  user: z.object({ id, username: z.string().trim().min(1).max(255) }),
  object_attributes: z.object({
    iid: id,
    action: z.string().trim().min(1).max(40).nullable().optional(),
    oldrev: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable().optional(),
  }),
  changes: z.object({ target_branch: z.unknown().optional() }).optional(),
});

/** Which ref moved. Who pushed is a label in the log, never a subject of any decision. */
const GitlabPushSchema = z.object({
  ref: z.string().trim().min(1).max(1_000),
  user_username: z.string().trim().min(1).max(255),
});

/**
 * How long before its delivery was received a note may have been written and still be a
 * command. GitLab sends a Note Hook within seconds of the note, and retries nothing, so an hour
 * is room for a queue that is behind and clocks that disagree — and no room for a note from a
 * day the hook was not listening.
 */
export const NOTE_MAX_AGE_MS = 60 * 60_000;

/** The most the control plane takes as a body (its `ForgeEventSchema`). */
const MAX_FORWARDED_BODY = 65_536;

/** What every write ryph makes ends with (`core/provenance.ts`), less its action id. */
const MARKER_OPENER = actionMarker("\0").split("\0")[0];

/** GitLab said the thing a delivery named is not there (404, 403, 410): no retry brings it. */
class Gone extends Error {}

function repoOf(project: GitlabHookProject): ForgeEventRepo {
  return {
    provider: "gitlab",
    repoRef: project.pathWithNamespace,
    url: project.url,
    forgeId: project.id,
  };
}

function actor(user: GitlabHookUser): { actorLogin: string; actorId: string } {
  return { actorLogin: user.username, actorId: user.id };
}

/** A web page for a human: http(s) only — a self-managed instance may serve plain http. */
function webLink(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A note on an issue or a merge request, as `issue_comment.created` — or, a remark on a line of
 * the diff, as `review_comment.created`, so the 👀 lands on that note and the run answers in its
 * discussion. Null for everything else: an edit, a system note, an internal note or one on a
 * confidential issue (ryph's answer is public where the note was not), a note on a commit or a
 * snippet, and the bot's own.
 *
 * Handles are the adapter's: the thread `issue-<iid>` or
 * `mr-<iid>`, the note `<threadRef>:<noteId>`, and a diff note's remark
 * `<threadRef>:<discussionId>:<noteId>`.
 *
 * `confirmed` is the mailroom key (`gitlabHookDedupeKey`) of a note GitLab said is there, under
 * the verified project, on the thread the delivery named — null for every delivery that ended
 * before GitLab was asked. Only a confirmed key is written down as taken.
 */
async function noteEvent(
  deps: GitlabWebhookDeps,
  projectId: string,
  payload: z.infer<typeof GitlabNoteSchema>,
  receivedAt: string,
  connectedAt: string,
): Promise<{ event: ForgeEvent | null; confirmed: string | null }> {
  const none = { event: null, confirmed: null };
  const attrs = payload.object_attributes;
  if (attrs.action != null && attrs.action !== "create") return none; // edits carry no instruction

  let on: { kind: "issue" | "merge_request"; iid: string };
  let thread: NonNullable<ForgeEvent["thread"]>;
  if (attrs.noteable_type === "Issue" && payload.issue !== undefined) {
    on = { kind: "issue", iid: String(payload.issue.iid) };
    thread = { kind: "issue", ref: `issue-${on.iid}` };
  } else if (attrs.noteable_type === "MergeRequest" && payload.merge_request !== undefined) {
    on = { kind: "merge_request", iid: String(payload.merge_request.iid) };
    thread = { kind: "change_request", ref: `mr-${on.iid}` };
  } else {
    // A commit's or a snippet's note: no thread ryph works in.
    return none;
  }

  const noteId = String(attrs.id);
  // The note first: most rings that are not commands end at it (an old note, a system note, the
  // bot's own), and the project is only read for one that is forwarded.
  const note = await deps.reads.note(projectId, on, noteId);
  if (note === null) throw new Gone(`note ${noteId} on ${thread.ref}`);
  // GitLab says the note is there: from here on, whatever becomes of it, it was taken.
  const confirmed = `note:${noteId}`;
  const taken = (event: ForgeEvent | null) => ({ event, confirmed });
  if (note.system) return taken(null);
  // A replay: written before this connection, or too long before it rang to be a fresh note.
  const written = Date.parse(note.createdAt);
  if (
    written < Date.parse(connectedAt) || Date.parse(receivedAt) - written > NOTE_MAX_AGE_MS
  ) {
    deps.diag.warn("gitlab_webhooks.old_note", {
      projectId,
      noteId,
      createdAt: note.createdAt,
      receivedAt,
    });
    return taken(null);
  }
  if (note.internal) {
    deps.diag.debug("gitlab_webhooks.internal_note", { projectId, noteId });
    return taken(null);
  }
  // The loop guard. GitLab marks no note as a bot's, so the bot is known by its id: every write
  // the forge's tools make is the bot's, and an agent's comment may well say `/ryph ada fix it`.
  // The marker every such write ends with is the second fence — a note carrying one was written
  // by ryph, through whichever account, and is never an instruction.
  if (note.author.id === deps.botUserId) return taken(null);
  if (note.body.includes(MARKER_OPENER)) return taken(null);
  if (on.kind === "issue") {
    const confidential = await deps.reads.issueConfidential(projectId, on.iid);
    if (confidential === null) throw new Gone(`issue ${on.iid}`);
    if (confidential) {
      deps.diag.debug("gitlab_webhooks.confidential_issue", { projectId, iid: on.iid });
      return taken(null);
    }
  }
  const project = await deps.reads.project(projectId);
  if (project === null) throw new Gone(`project ${projectId}`);

  const common = {
    // One command per note, however many deliveries name it.
    deliveryId: `gitlab:${projectId}:note:${noteId}`,
    repo: repoOf(project),
    ...actor(note.author),
    thread,
    body: note.body,
    sourceCommentId: `${thread.ref}:${noteId}`,
    receivedAt,
  };
  // A remark on the diff answers in its discussion — the one the delivery named, once GitLab
  // says that discussion holds this note. Without one the remark has no handle a reply or a
  // resolve could name, and it is answered beside it as a conversation note instead.
  if (
    note.type === "DiffNote" && on.kind === "merge_request" && attrs.discussion_id != null &&
    await deps.reads.discussionHolds(projectId, on.iid, attrs.discussion_id, noteId)
  ) {
    return taken({
      ...common,
      kind: "review_comment.created",
      inline: { commentId: `${thread.ref}:${attrs.discussion_id}:${noteId}` },
    });
  }
  return taken({ ...common, kind: "issue_comment.created" });
}

/**
 * A merge request's end or move, as GitLab says it stands now — the delivery's `action` only
 * says which question to ask:
 * - `merge` / `close`: `change_request.merged` (`merged.heads` the head that merged, never the
 *   merge or squash commit — what GitHub's `head.sha` is too; verified on GitLab 17.11 for every
 *   merge method) or `change_request.closed`, by the merge request's state. `locked` is a merge
 *   under way, retried; still open is a delivery about nothing that happened, consumed.
 * - `open`, `reopen`, an `update` that pushed commits or retargeted it: `change_request.pushed`
 *   with the head, base and author GitLab holds, fetched through `refs/merge-requests/<iid>/head`
 *   (kept in the target project for a fork's merge request too), while it is open.
 * - anything else (approvals, a title or label edit): null.
 */
async function mergeRequestEvent(
  deps: GitlabWebhookDeps,
  projectId: string,
  payload: z.infer<typeof GitlabMergeRequestSchema>,
  receivedAt: string,
): Promise<ForgeEvent | null> {
  const attrs = payload.object_attributes;
  const ending = attrs.action === "merge" || attrs.action === "close";
  const pushed = attrs.action === "open" || attrs.action === "reopen" ||
    (attrs.action === "update" && (attrs.oldrev != null || payload.changes?.target_branch != null));
  if (!ending && !pushed) return null;

  const iid = String(attrs.iid);
  const project = await deps.reads.project(projectId);
  if (project === null) throw new Gone(`project ${projectId}`);
  const mr = await deps.reads.mergeRequest(projectId, iid);
  if (mr === null) throw new Gone(`merge request !${iid}`);
  if (mr.state === "locked") {
    // GitLab is merging it right now; the next attempt reads how that ended.
    throw new Error(`merge request !${iid} is being merged`);
  }

  const ref = `mr-${iid}`;
  const common = {
    // The state GitLab answered, never the delivery's headers: a ring for a merge request that
    // has not changed since carries the id the last one did. `updatedAt` moves with every push,
    // retarget, close, reopen and merge, so each of those is a delivery of its own.
    deliveryId: `gitlab:${projectId}:mr:${iid}:${mr.state}:${mr.headSha}:${mr.updatedAt}`,
    repo: repoOf(project),
    thread: { kind: "change_request" as const, ref },
    body: null,
    sourceCommentId: null,
    receivedAt,
  };
  const pushedBy = { id: String(payload.user.id), username: payload.user.username };
  if (mr.state === "merged") {
    return {
      ...common,
      ...actor(mr.endedBy ?? pushedBy),
      kind: "change_request.merged",
      merged: { baseRef: mr.targetBranch, heads: [mr.headSha] },
    };
  }
  if (mr.state === "closed") {
    return { ...common, ...actor(mr.endedBy ?? pushedBy), kind: "change_request.closed" };
  }
  if (mr.state !== "opened" || !pushed) return null;
  return {
    ...common,
    ...actor(pushedBy),
    kind: "change_request.pushed",
    changeRequest: {
      ref,
      headSha: mr.headSha,
      // Where the delivery said the head moved from: the control plane uses it only to tell a
      // read that is behind this very push from a stale event, and its own read decides.
      before: attrs.oldrev ?? null,
      baseRef: mr.targetBranch,
      author: mr.author.username,
      authorId: mr.author.id,
      fetchRef: `refs/merge-requests/${iid}/head`,
      url: webLink(mr.webUrl),
    },
  };
}

/**
 * A push that names the project's DEFAULT branch, as GitLab says it is now, as `branch.updated`
 * naming the commit GitLab says that branch points at now; everything else is null — another
 * branch, a deleted default, an empty project. Tags arrive as their own event (`Tag Push Hook`)
 * and are consumed unparsed. A bot's push is NOT dropped: a merge landing an MR is exactly the
 * push an environment must hear.
 */
async function pushEvent(
  deps: GitlabWebhookDeps,
  projectId: string,
  payload: z.infer<typeof GitlabPushSchema>,
  receivedAt: string,
): Promise<ForgeEvent | null> {
  const project = await deps.reads.project(projectId);
  if (project === null) throw new Gone(`project ${projectId}`);
  const defaultBranch = project.defaultBranch;
  if (defaultBranch === null || payload.ref !== `refs/heads/${defaultBranch}`) return null;
  const commit = await deps.reads.branchHead(projectId, defaultBranch);
  if (commit === null) return null;
  return {
    // The commit GitLab says the default branch is at, and which branch that is (a name may run
    // to 255 bytes, so it is tagged by digest): a ring for a branch that has not moved since
    // carries the id the last one did.
    deliveryId: `gitlab:${projectId}:push:${commit}:${branchTag(defaultBranch)}`,
    kind: "branch.updated",
    repo: repoOf(project),
    actorLogin: payload.user_username,
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: defaultBranch, commit },
    receivedAt,
  };
}

/**
 * The GitLab mailbox's `dedupeKey`: `note:<id>` for a Note Hook that announces a note's
 * creation, null for every other delivery. Any token holder can ring for a real note as often as
 * the project's budget allows, and every ring would cost the bot the reads above; once one
 * delivery of the note has been taken, the mailroom delivers the rest without a turn of the
 * consumer. The key is the body's word, so it only LOOKS UP: what a taken delivery is written
 * down under is the consumer's (`ConsumeOutcome.dedupeKey`), given once GitLab said that note is
 * in this project. A forged key then names a note a delivered hook of THIS project's queue was
 * confirmed to carry (taken, so answered), or nothing, and the delivery is judged as any other.
 * An edit carries no instruction and no key.
 */
export function gitlabHookDedupeKey(hook: Hook): string | null {
  if (hook.headers["x-gitlab-event"] !== "Note Hook") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(hook.body);
  } catch {
    return null;
  }
  const parsed = GitlabNoteSchema.safeParse(payload);
  if (!parsed.success) return null;
  const attrs = parsed.data.object_attributes;
  if (attrs.action != null && attrs.action !== "create") return null;
  return `note:${attrs.id}`;
}

/** The events this consumer reads. Everything else — `Issue Hook` (no issue event drives ryph;
 * a command is a note), `Tag Push Hook`, `Pipeline Hook`, `Job Hook`, and the `Confidential …`
 * twins, whose text ryph's public answer would leak — is consumed unparsed. */
const READ_EVENTS = new Set(["Note Hook", "Merge Request Hook", "Push Hook"]);

function terminal(message: string): ConsumeOutcome {
  return { kind: "failed", message, terminal: true };
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err);

/**
 * The consumer. The project the delivery is FOR is the one the mailroom verified its token
 * against, at the generation it verified — `hook.headers[VERIFIED_SCOPE_HEADER]` and
 * `[VERIFIED_GENERATION_HEADER]` — and nothing the body says about a project is read. A delivery
 * id is built from what GitLab answered, under the project (see the header); one already
 * forwarded and taken is not forwarded again, and every event forwarded spends `eventCost` of
 * the budget.
 *
 * Terminal: a body that does not parse, a rotated token, and a handle GitLab says is not there.
 * Retried: the control plane or GitLab not answering, and the sink's own retryable verdicts.
 */
export function gitlabWebhookConsumer(
  deps: GitlabWebhookDeps,
): (hook: Hook, ticket?: DeliveryTicket) => Promise<ConsumeOutcome> {
  const forwarded = new Set<string>();
  return async (hook, ticket) => {
    const eventName = hook.headers["x-gitlab-event"];
    if (eventName === undefined || !READ_EVENTS.has(eventName)) return { kind: "ok" };

    const projectId = hook.headers[VERIFIED_SCOPE_HEADER];
    const generation = hook.headers[VERIFIED_GENERATION_HEADER];
    if (
      projectId === undefined || !/^\d{1,20}$/.test(projectId) || generation === undefined ||
      !/^\d{1,10}$/.test(generation)
    ) {
      // Only a mis-registered mailbox stores a row without them: nothing vouches for the project.
      return terminal("the delivery carries no verified project and generation");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(hook.body);
    } catch {
      return terminal("the body is not JSON");
    }
    const parsed = eventName === "Note Hook"
      ? GitlabNoteSchema.safeParse(payload)
      : eventName === "Merge Request Hook"
      ? GitlabMergeRequestSchema.safeParse(payload)
      : GitlabPushSchema.safeParse(payload);
    if (!parsed.success) return terminal(describeIssues(parsed.error));

    const heard: GitlabHookHeard = eventName === "Merge Request Hook" ? "merge_request" : "other";
    let admission;
    try {
      admission = await deps.gate.admit(projectId, generation, heard);
    } catch (err) {
      return {
        kind: "failed",
        message: `the control plane was not asked: ${describe(err)}`,
        terminal: false,
      };
    }
    if (admission.admission === "stale") {
      deps.diag.warn("gitlab_webhooks.stale_token", { hookId: hook.id, projectId, generation });
      return terminal(
        `project ${projectId}'s webhook token was rotated since generation ${generation}`,
      );
    }
    if (admission.admission !== "current") {
      deps.diag.debug("gitlab_webhooks.unconnected", { hookId: hook.id, projectId });
      return { kind: "ok" };
    }

    // What this delivery may spend of the budget, set aside before it was claimed.
    const reservation = ticket instanceof HookReservation ? ticket : null;
    if (deps.budget !== undefined && reservation === null) {
      return {
        kind: "failed",
        message: "the delivery holds no reservation of the GitLab call budget",
        terminal: false,
      };
    }
    const reading = reservation === null ? deps : {
      ...deps,
      reads: reservedHookReads(deps.reads, reservation),
    };

    let event: ForgeEvent | null;
    // The note GitLab confirmed this delivery is about, written down as taken on every ok below.
    let confirmed: string | null = null;
    try {
      if (eventName === "Note Hook") {
        ({ event, confirmed } = await noteEvent(
          reading,
          projectId,
          parsed.data as z.infer<typeof GitlabNoteSchema>,
          hook.receivedAt,
          admission.connectedAt,
        ));
      } else if (eventName === "Merge Request Hook") {
        event = await mergeRequestEvent(
          reading,
          projectId,
          parsed.data as z.infer<typeof GitlabMergeRequestSchema>,
          hook.receivedAt,
        );
      } else {
        event = await pushEvent(
          reading,
          projectId,
          parsed.data as z.infer<typeof GitlabPushSchema>,
          hook.receivedAt,
        );
      }
    } catch (err) {
      if (err instanceof Gone) {
        deps.diag.warn("gitlab_webhooks.gone", { hookId: hook.id, projectId, what: err.message });
        return terminal(`GitLab has no ${err.message} for this delivery`);
      }
      // GitLab did not answer, or not as it does: a retry may read it, and a guess would
      // mis-attribute.
      return {
        kind: "failed",
        message: `GitLab could not be read: ${describe(err)}`,
        terminal: false,
      };
    }
    const ok: ConsumeOutcome = confirmed === null
      ? { kind: "ok" }
      : { kind: "ok", dedupeKey: confirmed };
    if (event === null) return ok;
    if (event.body != null && event.body.length > MAX_FORWARDED_BODY) {
      // A real note, longer than the control plane takes: consumed, and said.
      deps.diag.warn("gitlab_webhooks.note_too_long", {
        deliveryId: event.deliveryId,
        length: event.body.length,
      });
      return ok;
    }

    // Forwarded and taken already: the control plane would answer it from its record. Not even
    // asked, and so not charged to the budget — a ring for the same state again costs the reads
    // above and nothing more.
    if (forwarded.has(event.deliveryId)) {
      deps.diag.debug("gitlab_webhooks.already_forwarded", { deliveryId: event.deliveryId });
      return ok;
    }
    try {
      reservation?.take(eventCost(event));
    } catch (err) {
      return { kind: "failed", message: describe(err), terminal: false };
    }
    deps.diag.debug("gitlab_webhooks.forwarding", {
      deliveryId: event.deliveryId,
      kind: event.kind,
    });
    const outcome = await deps.sink.deliver(event);
    if (outcome.kind !== "ok") return outcome;
    forwarded.add(event.deliveryId);
    // Oldest first: a Set iterates in insertion order.
    if (forwarded.size > FORWARDED_MEMORY) forwarded.delete(forwarded.values().next().value!);
    return ok;
  };
}

/** How many forwarded delivery ids the consumer remembers — the recent past a replay names; an
 * older one reaches the control plane, which answers it from its record. */
const FORWARDED_MEMORY = 10_000;

/**
 * What the control plane may spend of the bot's GitLab rate limit handling `event`, at most —
 * charged to the delivery's reservation of the webhook budget before it is forwarded. A push to a merge request: the lean
 * read of it, the gate asked of its author and its pusher, the checks file, an approval comment,
 * the read again before filing, and the status posted on its head. A merge or a close: the
 * settle's withdrawals. A default branch moving: the `.ryph/` of the repo and of its workspace.
 * A comment: the gate, the 👀 and a reply (a run it starts spends on its own account).
 */
export function eventCost(event: Pick<ForgeEvent, "kind">): number {
  switch (event.kind) {
    case "change_request.pushed":
      return 8;
    case "change_request.merged":
    case "change_request.closed":
      return 3;
    case "branch.updated":
      return 4;
    default:
      return 4;
  }
}

/** The most each event the consumer reads may cost: its reads, at most (a note: the note, the
 * issue's confidentiality or the discussion, the project; a merge request: the project and it; a
 * push: the project and the branch), and the `eventCost` of the dearest event it can forward. */
const COST_AT_MOST: Record<string, number> = {
  "Note Hook": 3 + Math.max(
    eventCost({ kind: "issue_comment.created" }),
    eventCost({ kind: "review_comment.created" }),
  ),
  "Merge Request Hook": 2 + Math.max(
    eventCost({ kind: "change_request.pushed" }),
    eventCost({ kind: "change_request.merged" }),
    eventCost({ kind: "change_request.closed" }),
  ),
  "Push Hook": 2 + eventCost({ kind: "branch.updated" }),
};

/** The most a delivery can make the bot spend of the webhook budget — its reads and the control
 * plane's handling of what it forwards — by the event it names; 0 for one consumed unread. */
export function hookCostAtMost(hook: Hook): number {
  return COST_AT_MOST[hook.headers["x-gitlab-event"] ?? ""] ?? 0;
}

/**
 * The GitLab mailbox's `admitDelivery`: a delivery the mailroom is about to claim reserves the
 * most it can spend (`hookCostAtMost`) of the budget every project shares (`hookBudget`), under
 * its verified project — least-spent project first, whatever the event — or waits, pending, its
 * attempts untouched, for a later scan. Its reservation is handed to the consumer and what it did
 * not spend is given back once it is over.
 */
export function gitlabHookAdmission(budget: HookBudget): (hook: Hook) => DeliveryAdmission {
  return (hook) => {
    const cost = hookCostAtMost(hook);
    if (cost === 0) return { kind: "go" };
    const reservation = budget.reserve(hook.scope ?? "", cost);
    if (reservation === null) {
      return { kind: "wait", reason: `over the GitLab call budget for webhooks (${cost} calls)` };
    }
    return { kind: "go", ticket: reservation };
  };
}

/** A branch name as a short digest: the delivery id must stay bounded, and a GitLab branch may
 * be named in up to 255 bytes. */
export function branchTag(branch: string): string {
  return createHash("sha256").update(branch).digest("hex").slice(0, 16);
}

/** How long the door trusts the control plane's "current" for a (project, generation). A
 * rotation is honoured at the door within this; the consumer asks again regardless. */
export const DOOR_ADMIT_TTL_MS = 60_000;
/** How long it trusts a "stale" or "unconnected": a flood of a rotated token costs the control
 * plane one question per this, and the mailroom nothing. */
export const DOOR_REFUSE_TTL_MS = 5 * 60_000;
/** How long the door waits for the control plane before it answers from what it knows. */
export const DOOR_ASK_TIMEOUT_MS = 2_000;
/** How many (project, generation) answers the door keeps. */
const DOOR_CACHE_MAX = 10_000;

/**
 * The mailroom's `admitScope` for the GitLab mailbox: whether the control plane still wants a
 * delivery whose token the door just verified — a connected project, its current generation —
 * asked BEFORE the row is written, so a rotated token, a demoted Maintainer's or an archived
 * project's costs no storage, no consumer turn and no API read.
 *
 * Kept fast for the sender: answers are cached per (project, generation), and one question per
 * key is in flight at a time. When the control plane does not answer in time, the door goes by
 * the last answer it had, however old; with none, it takes the delivery — the consumer asks
 * again before it reads GitLab, and refuses there (fail closed where it costs something), while
 * the per-project rate limit bounds what a control-plane outage can let in. Losing a real
 * delivery to a blip would cost a command nobody can resend.
 */
export function gitlabDoorGate(
  gate: GitlabHookGate,
  opts: { now(): number; diag: Diagnostics; timeoutMs?: number },
): (projectId: string, generation: string | undefined) => Promise<boolean> {
  const known = new Map<string, { admitted: boolean; at: number }>();
  const asking = new Map<string, Promise<boolean>>();
  const remember = (key: string, admitted: boolean) => {
    known.delete(key);
    known.set(key, { admitted, at: opts.now() });
    // Oldest first: a Map iterates in insertion order, and a refreshed key was re-inserted.
    while (known.size > DOOR_CACHE_MAX) known.delete(known.keys().next().value!);
  };
  const ask = async (key: string, projectId: string, generation: string): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        gate.admit(projectId, generation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("no answer in time")),
            opts.timeoutMs ?? DOOR_ASK_TIMEOUT_MS,
          );
        }),
      ]);
      const admitted = answer.admission === "current";
      remember(key, admitted);
      return admitted;
    } catch (err) {
      const last = known.get(key);
      opts.diag.warn("gitlab_webhooks.door_unanswered", {
        projectId,
        generation,
        fallback: last === undefined ? "admit" : last.admitted ? "admit" : "refuse",
        err: describe(err),
      });
      return last?.admitted ?? true;
    } finally {
      clearTimeout(timer);
    }
  };
  return (projectId, generation) => {
    // The GitLab mailbox always names a generation; a token without one was minted by nobody.
    if (generation === undefined) return Promise.resolve(false);
    const key = `${projectId}:${generation}`;
    const last = known.get(key);
    if (
      last !== undefined &&
      opts.now() - last.at < (last.admitted ? DOOR_ADMIT_TTL_MS : DOOR_REFUSE_TTL_MS)
    ) {
      return Promise.resolve(last.admitted);
    }
    const inFlight = asking.get(key);
    if (inFlight !== undefined) return inFlight;
    const answer = ask(key, projectId, generation).finally(() => asking.delete(key));
    asking.set(key, answer);
    return answer;
  };
}

/**
 * The GitLab mailbox's rate-limit `lane`: which of a project's two delivery budgets a delivery
 * spends. Comments get one of their own. A busy project's merge request churn — labels,
 * approvals, a rebase of every open merge request — is mostly consumed as nothing and its merges
 * and pushes are polled for anyway, but a `/ryph` note dropped is a command lost for good, so no
 * flood of other events may spend its budget. The header is the sender's word: a token holder can
 * label anything a comment, which spends only the comments budget of their own project — and
 * every other name, made up or not, is `other`, never a budget of its own.
 */
export function gitlabHookLane(headers: Headers): GitlabHookLane {
  return headers.get("x-gitlab-event") === "Note Hook" ? "comments" : "other";
}

/** How long the door gathers drops before it tells the control plane: a flood over a project's
 * budget costs one report per this, whatever its size. */
export const DROP_REPORT_MS = 30_000;

/**
 * The GitLab mailbox's `onOverLimit`: the door answered a delivery over one of its project's
 * budgets 202 and stored nothing (`over: "drop"` — a 429 would count toward GitLab disabling the
 * hook, and every later delivery would be lost with it), and this is the only trace left. Drops
 * are counted per (project, generation, lane) and told to the control plane once per
 * `DROP_REPORT_MS`, for the repo page to say which were lost: comments or other events. Bounded
 * like the door's cache: a key not yet counted when `DOOR_CACHE_MAX` are waits for the next
 * report, and the log has it either way.
 */
export function gitlabDropReporter(
  gate: Pick<GitlabHookGate, "dropped">,
  opts: {
    diag: Diagnostics;
    /** Runs `flush` once, later; a test's own clock. */
    schedule?: (flush: () => void, ms: number) => void;
  },
): (projectId: string | null, generation: string | null, lane: string | null) => void {
  const pending = new Map<
    string,
    { projectId: string; generation: string; lane: GitlabHookLane; count: number }
  >();
  let scheduled = false;
  const schedule = opts.schedule ?? ((flush, ms) => {
    const timer = setTimeout(flush, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  const flush = () => {
    scheduled = false;
    const batch = [...pending.values()];
    pending.clear();
    for (const { projectId, generation, lane, count } of batch) {
      gate.dropped(projectId, generation, lane, count).catch((err) =>
        opts.diag.warn("gitlab_webhooks.drop_report_failed", {
          projectId,
          generation,
          lane,
          count,
          err: describe(err),
        })
      );
    }
  };
  return (projectId, generation, laneName) => {
    opts.diag.warn("gitlab_webhooks.dropped_over_budget", {
      projectId,
      generation,
      lane: laneName,
    });
    if (projectId === null || generation === null) return;
    // The door's lanes are `gitlabHookLane`'s; anything else is counted with the other events.
    const lane: GitlabHookLane = laneName === "comments" ? "comments" : "other";
    const key = `${projectId}:${generation}:${lane}`;
    const counted = pending.get(key);
    if (counted !== undefined) counted.count++;
    else if (pending.size < DOOR_CACHE_MAX) {
      pending.set(key, { projectId, generation, lane, count: 1 });
    }
    if (!scheduled) {
      scheduled = true;
      schedule(flush, DROP_REPORT_MS);
    }
  };
}
