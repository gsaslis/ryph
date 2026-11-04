// The bridge's events, reduced to `ForgeEvent` — the Radicle half of what
// `github_webhooks.ts` does for GitHub. Radicle has no webhooks; what arrives here is a POST
// from @ryph/radicle, which held a subscription on the node's control socket (or reconciled
// against storage) and minted a delivery id from the storage state itself.
//
// The payload is already provider-neutral — the bridge deliberately spells no COB vocabulary
// in its field names — so this file is a rename and a validation, not a translation. It is
// still an ingest boundary, and the schema below is `strictObject` like every other one in
// this package: unlike GitHub's hundred-key deliveries, this sender is ours, so an unknown key
// is a version skew worth refusing loudly rather than a payload we must tolerate.
//
// Trust: the mailroom verified the shared bearer before this ran, and every op behind the
// event was signed by its author and checked by the node before the bridge ever saw it. The
// actor DID is therefore not a claim.

import { z } from "@zod/zod";
import type { Hook } from "@ryph/webhooks";
import type { ForgeEvent } from "../../core/types.ts";
import { describeIssues } from "@ryph/shared/http";
import type { DeliverOutcome, EventSink } from "../../ports/event_sink.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

/** A 40-hex collaborative-object id, or any unique prefix of one. */
const cobId = z.string().trim().regex(/^[0-9a-f]{7,40}$/, { error: "not an object id" });

/** A repository id. */
const rid = z.string().trim().regex(/^rad:z[1-9A-HJ-NP-Za-km-z]+$/, {
  error: "not a repository id",
}).max(200);

/** `did:key:z…` — an ed25519 key in multibase base58btc, which is the only DID Radicle uses. */
const did = z.string().trim().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/, {
  error: "not a did:key",
});

/** A bare branch name out of an identity document, held to what may ride a ref. */
const branchName = z.string().trim().regex(/^[A-Za-z0-9._\/-]{1,200}$/, {
  error: "not a branch name",
}).refine((v) => !v.includes("..") && !v.startsWith("-"), { error: "not a branch name" });

/** A full commit id — SHA-1, or SHA-256 for a repository that uses it. */
const commitId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, { error: "not a commit id" });

const threadEventSchema = z.strictObject({
  /** Derived by the bridge from storage state, never random — redelivery is the
   * orchestrator's primary key doing its job. */
  deliveryId: z.string().trim().min(1).max(200),
  kind: z.enum(["comment.created", "change_request.closed"]),
  repoRef: rid,
  actor: z.strictObject({ did, alias: z.string().max(200).optional() }),
  thread: z.strictObject({
    kind: z.enum(["issue", "change_request"]),
    ref: cobId,
  }),
  body: z.string().max(200_000).optional(),
  sourceCommentId: cobId.optional(),
  revision: cobId.optional(),
});

/** A change request merged: the revision(s) that merged, each with the commit its merge
 * recorded. Always named, though possibly none: a merge that names nothing still arrives, and
 * nothing can be judged contained in it. */
const mergedEventSchema = z.strictObject({
  deliveryId: z.string().trim().min(1).max(200),
  kind: z.literal("change_request.merged"),
  repoRef: rid,
  actor: z.strictObject({ did, alias: z.string().max(200).optional() }),
  thread: z.strictObject({ kind: z.literal("change_request"), ref: cobId }),
  merged: z.array(z.strictObject({ revision: cobId, commit: commitId })).max(20),
});

/** The canonical default branch moving. The actor is the node that SAW it — ours: a canonical
 * ref moves when the delegates reach quorum, which is nobody's single act. */
const branchEventSchema = z.strictObject({
  deliveryId: z.string().trim().min(1).max(200),
  kind: z.literal("branch.updated"),
  repoRef: rid,
  actor: z.strictObject({ did, alias: z.string().max(200).optional() }),
  branch: z.strictObject({ ref: branchName, commit: commitId }),
});

/** A change request opened or revised by somebody other than this node: its new head, and the
 * branch it targets (a Radicle change request targets the default branch, always). */
const pushedEventSchema = z.strictObject({
  deliveryId: z.string().trim().min(1).max(200),
  kind: z.literal("change_request.pushed"),
  repoRef: rid,
  actor: z.strictObject({ did, alias: z.string().max(200).optional() }),
  thread: z.strictObject({ kind: z.literal("change_request"), ref: cobId }),
  changeRequest: z.strictObject({
    headSha: commitId,
    baseRef: branchName,
    author: did,
    // Rendered from the bridge's explorer template, for a human to open: a web link or nothing.
    // Anything else is no link, never a reason to refuse the push it rides on.
    url: z.preprocess(
      (v) => typeof v === "string" && v.trim().startsWith("https://") ? v : null,
      z.string().trim().max(2_000).nullable(),
    ),
  }),
});

export const RadicleEventSchema = z.discriminatedUnion("kind", [
  threadEventSchema,
  mergedEventSchema,
  branchEventSchema,
  pushedEventSchema,
]);

/**
 * One bridge delivery as the orchestrator receives it. Null is impossible here — the bridge
 * mints only the kinds ryph acts on, where GitHub sends every star and every ping — so
 * every accepted delivery becomes an event.
 *
 * The kinds are GitHub's own spelling on purpose: `issue_comment.created`,
 * `change_request.merged`, `change_request.closed`, `change_request.pushed` and `branch.updated`
 * are the vocabulary the orchestrator's ladder already reads, and a second dialect for the same
 * facts would be two ladders.
 */
export function normalizeRadicleEvent(
  payload: z.infer<typeof RadicleEventSchema>,
  receivedAt: string,
): ForgeEvent {
  const repo = {
    provider: "radicle" as const,
    repoRef: payload.repoRef,
    // A RID is the repo's whole address on Radicle — there is no clone URL to carry, and the
    // fetchable one is a door on this deployment's bridge, which is nobody else's business.
    url: payload.repoRef,
  };
  if (payload.kind === "change_request.pushed") {
    return {
      deliveryId: payload.deliveryId,
      kind: "change_request.pushed",
      repo,
      actorLogin: payload.actor.did,
      thread: payload.thread,
      body: null,
      sourceCommentId: null,
      changeRequest: {
        ref: payload.thread.ref,
        headSha: payload.changeRequest.headSha,
        // A revision names no head it replaced: a patch's revisions stand side by side.
        before: null,
        baseRef: payload.changeRequest.baseRef,
        author: payload.changeRequest.author,
        // Nothing to fall back on: a Radicle head is fetched by id from the bridge's storage,
        // which holds every revision it has seen.
        fetchRef: null,
        url: payload.changeRequest.url,
      },
      receivedAt,
    };
  }
  if (payload.kind === "branch.updated") {
    return {
      deliveryId: payload.deliveryId,
      kind: "branch.updated",
      repo,
      actorLogin: payload.actor.did,
      thread: null,
      body: null,
      sourceCommentId: null,
      branch: payload.branch,
      receivedAt,
    };
  }
  if (payload.kind === "change_request.merged") {
    return {
      deliveryId: payload.deliveryId,
      kind: "change_request.merged",
      repo,
      actorLogin: payload.actor.did,
      thread: payload.thread,
      body: null,
      sourceCommentId: null,
      // What merged, by commit. No branch: a patch merges into the default branch, always.
      merged: { heads: [...new Set(payload.merged.map((m) => m.commit))] },
      receivedAt,
    };
  }
  return {
    deliveryId: payload.deliveryId,
    kind: payload.kind === "comment.created" ? "issue_comment.created" : payload.kind,
    repo,
    // A DID, where GitHub sends a login. The control plane resolves it against the linked
    // identity auth holds — `external_identities(radicle, login = the DID)` — exactly as it
    // resolves a GitHub login.
    actorLogin: payload.actor.did,
    thread: payload.thread,
    body: payload.body ?? null,
    // The handle a reaction targets. It carries the thread because a Radicle comment is only
    // reachable through the object it hangs on — see the Radicle adapter's `commentHandle`,
    // which is the one place this spelling is made and read.
    sourceCommentId: payload.sourceCommentId === undefined
      ? null
      : `${payload.thread.kind}:${payload.thread.ref}:${payload.sourceCommentId}`,
    receivedAt,
  };
}

/**
 * The mailroom consumer for the "radicle" registration. Same verdict contract as GitHub's: a
 * payload that can never parse is terminal, and only the sink decides whether a delivery
 * failure is worth retrying.
 */
export function radicleEventConsumer(
  deps: { sink: EventSink; diag: Diagnostics },
): (hook: Hook) => Promise<DeliverOutcome> {
  return async (hook) => {
    let payload: unknown;
    try {
      payload = JSON.parse(hook.body);
    } catch {
      return { kind: "failed", message: "the body is not JSON", terminal: true };
    }
    const parsed = RadicleEventSchema.safeParse(payload);
    if (!parsed.success) {
      return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
    }
    const event = normalizeRadicleEvent(parsed.data, hook.receivedAt);
    deps.diag.debug("radicle_events.forwarding", {
      deliveryId: event.deliveryId,
      kind: event.kind,
      ...(parsed.data.kind === "change_request.merged" ? { merged: parsed.data.merged } : {}),
    });
    return await deps.sink.deliver(event);
  };
}
