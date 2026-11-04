// Door ④'s Radicle consumer: a bridge delivery (as the mailroom hands it over) becomes a
// ForgeEvent, or fails terminally. No node, no network — the payload is the contract.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { Hook } from "@ryph/webhooks";
import { radicleEventConsumer } from "../src/adapters/forge_api/radicle_events.ts";
import type { DeliverOutcome } from "../src/ports/event_sink.ts";
import type { ForgeEvent } from "../src/core/types.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const DID = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";
const COB = "a".repeat(40);
const OP = "b".repeat(40);

const silent = { debug: () => {}, warn: () => {} };

function makeConsumer(sinkOutcome: DeliverOutcome = { kind: "ok" }) {
  const delivered: ForgeEvent[] = [];
  const consumer = radicleEventConsumer({
    sink: {
      deliver(event) {
        delivered.push(event);
        return Promise.resolve(sinkOutcome);
      },
    },
    diag: silent,
  });
  return { consumer, delivered };
}

function hook(payload: unknown, over: Partial<Hook> = {}): Hook {
  return {
    id: "wh-0000000001",
    registrationId: "radicle",
    scope: null,
    seq: 1,
    headers: { authorization: "Bearer bridge-secret" },
    body: JSON.stringify(payload),
    state: "delivering",
    attempts: 1,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    dedupeKey: null,
    ...over,
  };
}

const comment = (over: Record<string, unknown> = {}) => ({
  deliveryId: `${RID}:${COB}:${OP}:0`,
  kind: "comment.created",
  repoRef: RID,
  actor: { did: DID, alias: "grace" },
  thread: { kind: "issue", ref: COB },
  body: "/ryph ada fix it",
  sourceCommentId: OP,
  ...over,
});

test("a comment becomes the same event kind the other forge sends, with the DID as the actor", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(comment())), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: `${RID}:${COB}:${OP}:0`,
    // GitHub's spelling on purpose: the orchestrator's ladder reads one vocabulary, not two.
    kind: "issue_comment.created",
    repo: { provider: "radicle", repoRef: RID, url: RID },
    // Not a claim: every op was signed by its author and checked by the node before the
    // bridge ever saw it.
    actorLogin: DID,
    thread: { kind: "issue", ref: COB },
    body: "/ryph ada fix it",
    // The handle a 👀 targets — it carries the thread, because a Radicle comment is only
    // reachable through the object it hangs on.
    sourceCommentId: `issue:${COB}:${OP}`,
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a change request's fate travels as the kind it already is", async () => {
  for (const kind of ["change_request.merged", "change_request.closed"] as const) {
    const { consumer, delivered } = makeConsumer();
    await consumer(hook({
      deliveryId: `${RID}:${COB}:${kind === "change_request.merged" ? "merged" : "closed"}`,
      kind,
      repoRef: RID,
      actor: { did: DID },
      thread: { kind: "change_request", ref: COB },
      ...(kind === "change_request.merged" ? { merged: [] } : {}),
    }));
    assertEquals(delivered[0].kind, kind);
    assertEquals(delivered[0].body, null);
    assertEquals(delivered[0].sourceCommentId, null);
  }
});

test("a merge names what merged, by commit: the revision the delegates merged", async () => {
  const { consumer, delivered } = makeConsumer();
  const merge = (merged?: unknown) => ({
    deliveryId: `${RID}:${COB}:merged`,
    kind: "change_request.merged",
    repoRef: RID,
    actor: { did: DID },
    thread: { kind: "change_request", ref: COB },
    ...(merged === undefined ? {} : { merged }),
  });
  await consumer(hook(merge([
    { revision: OP, commit: "c".repeat(40) },
    { revision: COB, commit: "c".repeat(40) },
  ])));
  // No branch: a patch merges into the default branch, which the control plane holds.
  assertEquals(delivered[0].merged, { heads: ["c".repeat(40)] });
  // A merge whose state recorded no full commit names none, and still travels.
  await consumer(hook(merge([])));
  assertEquals(delivered[1].merged, { heads: [] });
  // A close merged nothing.
  await consumer(hook({ ...merge(), kind: "change_request.closed" }));
  assertEquals(delivered[2].merged, undefined);
  // A merge always says what merged: one without the list is a payload this version refuses.
  const unnamed = await consumer(hook(merge()));
  assert(unnamed.kind === "failed" && unnamed.terminal);
  // A head that is not a full commit id is a payload this version cannot read.
  const bad = await consumer(hook(merge([{ revision: OP, commit: "c".repeat(7) }])));
  assert(bad.kind === "failed" && bad.terminal);
});

test("a payload this version cannot read is terminal, never a retry forever", async () => {
  const { consumer, delivered } = makeConsumer();
  const bad = [
    "not json at all",
    JSON.stringify(comment({ repoRef: "acme/app" })),
    JSON.stringify(comment({ actor: { did: "ada" } })),
    JSON.stringify(comment({ kind: "issue.opened" })),
    // strictObject: this sender is ours, so an unknown key is a version skew worth refusing.
    JSON.stringify({ ...comment(), surprise: true }),
  ];
  for (const body of bad) {
    const outcome = await consumer(hook(null, { body }));
    assert(outcome.kind === "failed" && outcome.terminal, body.slice(0, 40));
  }
  assertEquals(delivered, [], "nothing unreadable ever reached the orchestrator");
});

test("the sink's verdict travels through unchanged", async () => {
  const { consumer } = makeConsumer({ kind: "failed", message: "503", terminal: false });
  assertEquals(await consumer(hook(comment())), {
    kind: "failed",
    message: "503",
    terminal: false,
  });
});

const moved = (over: Record<string, unknown> = {}) => ({
  deliveryId: `${RID}:heads/main:${"c".repeat(40)}`,
  kind: "branch.updated",
  repoRef: RID,
  actor: { did: DID },
  branch: { ref: "main", commit: "c".repeat(40) },
  ...over,
});

test("the canonical default branch moving becomes the same branch.updated GitHub's push does", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(moved())), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: `${RID}:heads/main:${"c".repeat(40)}`,
    kind: "branch.updated",
    repo: { provider: "radicle", repoRef: RID, url: RID },
    actorLogin: DID,
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: "main", commit: "c".repeat(40) },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a branch.updated this version cannot read is terminal", async () => {
  const { consumer, delivered } = makeConsumer();
  const bad = [
    moved({ branch: { ref: "../main", commit: "c".repeat(40) } }),
    moved({ branch: { ref: "main", commit: "nope" } }),
    moved({ branch: undefined }),
    // A branch event carries no thread, and a thread event no branch — one shape per kind.
    moved({ thread: { kind: "issue", ref: COB } }),
    comment({ branch: { ref: "main", commit: "c".repeat(40) } }),
  ];
  for (const payload of bad) {
    const outcome = await consumer(hook(payload));
    assert(outcome.kind === "failed" && outcome.terminal, JSON.stringify(payload).slice(0, 80));
  }
  assertEquals(delivered, []);
});

const HEAD = "c".repeat(40);
const AUTHOR = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const CR = { headSha: HEAD, baseRef: "main", author: AUTHOR, url: null };

const pushed = (over: Record<string, unknown> = {}) => ({
  deliveryId: `${RID}:${COB}:${OP}:0`,
  kind: "change_request.pushed",
  repoRef: RID,
  actor: { did: DID },
  thread: { kind: "change_request", ref: COB },
  changeRequest: CR,
  ...over,
});

test("a stranger's revision becomes the same change_request.pushed a pull request push does", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(pushed())), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: `${RID}:${COB}:${OP}:0`,
    kind: "change_request.pushed",
    repo: { provider: "radicle", repoRef: RID, url: RID },
    actorLogin: DID,
    thread: { kind: "change_request", ref: COB },
    body: null,
    sourceCommentId: null,
    // The ref is the patch id, as `patches.forge_ref` files it; nothing to fetch it through but
    // its id.
    changeRequest: {
      ref: COB,
      headSha: HEAD,
      before: null,
      baseRef: "main",
      author: AUTHOR,
      fetchRef: null,
      url: null,
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);

  const linked = makeConsumer();
  const url = `https://app.radicle.xyz/nodes/seed/${RID}/patches/${COB}`;
  await linked.consumer(hook(pushed({ changeRequest: { ...CR, url } })));
  assertEquals(linked.delivered[0].changeRequest?.url, url);

  // A link that is not a web link is no link — the push it rides on still travels.
  for (const bad of ["http://explorer.example/x", "javascript:alert(1)", 7]) {
    const unlinked = makeConsumer();
    assertEquals(
      await unlinked.consumer(hook(pushed({ changeRequest: { ...CR, url: bad } }))),
      { kind: "ok" },
    );
    assertEquals(unlinked.delivered[0].changeRequest?.url, null, String(bad));
  }
});

test("a change_request.pushed this version cannot read is terminal", async () => {
  const { consumer, delivered } = makeConsumer();
  const bad = [
    pushed({ thread: { kind: "issue", ref: COB } }),
    pushed({ changeRequest: { ...CR, headSha: "main" } }),
    pushed({ changeRequest: { ...CR, baseRef: "../etc" } }),
    pushed({ changeRequest: { ...CR, author: "grace" } }),
    pushed({ changeRequest: { ...CR, at: "2026-01-01T00:00:00.000Z" } }),
    pushed({ changeRequest: { headSha: HEAD, baseRef: "main", url: null } }),
    pushed({ changeRequest: { ...CR, fetchRef: null } }),
    pushed({ body: "a push carries no instruction" }),
  ];
  for (const payload of bad) {
    const outcome = await consumer(hook(payload));
    assert(outcome.kind === "failed" && outcome.terminal, JSON.stringify(payload).slice(-80));
  }
  assertEquals(delivered, []);
});
