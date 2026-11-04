// Door ④'s GitLab consumer: a raw delivery (as the mailroom hands it over, the verified project
// and token generation among its headers) rings the bell, the control plane is asked whether
// that generation is current, GitLab is asked what is true, and the ForgeEvent is built from
// GitLab's answers alone — with a fake gate, a fake GitLab and a fake sink, no network anywhere.
// The bodies are payloads captured from GitLab 17.11, values renamed, every key it sends
// included, so a schema that refused unknown keys would fail here.

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { openDbCluster } from "@ryph/db";
import {
  drizzleHookStore,
  type Hook,
  scopeWebhooksDb,
  setup as setupWebhooks,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
} from "@ryph/webhooks";
import {
  branchTag,
  DOOR_ADMIT_TTL_MS,
  DOOR_REFUSE_TTL_MS,
  DROP_REPORT_MS,
  gitlabDoorGate,
  gitlabDropReporter,
  gitlabHookAdmission,
  gitlabHookDedupeKey,
  gitlabHookLane,
  gitlabWebhookConsumer,
} from "../src/adapters/forge_api/gitlab_webhooks.ts";
import type {
  GitlabHookMergeRequest,
  GitlabHookNote,
  GitlabHookReads,
} from "../src/adapters/forge_api/gitlab_hook_reads.ts";
import { hookBudget, HookReservation } from "../src/adapters/forge_api/gitlab_hook_reads.ts";
import { actionMarker, withSignature } from "../src/core/provenance.ts";
import type { DeliverOutcome, GitlabHookAdmission } from "../src/ports/event_sink.ts";
import type { ForgeEvent } from "../src/core/types.ts";

const BOT_ID = "99";
const PROJECT = "4211";
const HEAD = "da1560886d4f094c3e6c9ef40349f7d38b5d27d7";
const LIVE = "c0ffee0000000000000000000000000000000001";
const OLD = "b83d6e391c22777fca1ed3012fce84f633d7fed0";
const DISCUSSION = "6a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7be1";
const REPO = {
  provider: "gitlab" as const,
  repoRef: "acme/platform/app",
  url: "https://gitlab.example.com/acme/platform/app.git",
  forgeId: PROJECT,
};
const ADA = { id: "31", username: "ada.lovelace" };
const GRACE = { id: "57", username: "grace_h" };

// oxlint-disable-next-line no-explicit-any
type Json = any;

function fixture(name: string): Json {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/gitlab/${name}.json`, import.meta.url), "utf8"),
  );
}

/** GitLab as the bot reads it: project 4211, its notes, issues, merge request !7 and branches.
 * Every read is counted; `fail` makes the next reads throw as an unreachable GitLab does. */
function fakeGitlab() {
  const state = {
    project: {
      id: PROJECT,
      pathWithNamespace: REPO.repoRef,
      url: REPO.url,
      defaultBranch: "main" as string | null,
    } as
      | { id: string; pathWithNamespace: string; url: string; defaultBranch: string | null }
      | null,
    notes: new Map<string, GitlabHookNote>([
      ["issue:12:88123", note("88123", "/ryph ada fix the retry")],
      [
        "merge_request:7:88124",
        note("88124", "@ryph-bot please rebase this onto main", {
          type: "DiscussionNote",
        }),
      ],
      [
        "merge_request:7:88125",
        note("88125", "/ryph ada handle the timeout here too", {
          type: "DiffNote",
        }),
      ],
    ]),
    discussions: new Map<string, string[]>([[`7:${DISCUSSION}`, ["88125"]]]),
    confidential: new Map<string, boolean>([["12", false]]),
    mergeRequests: new Map<string, GitlabHookMergeRequest>([["7", {
      iid: "7",
      state: "opened",
      headSha: LIVE,
      targetBranch: "main",
      author: GRACE,
      endedBy: null,
      webUrl: "https://gitlab.example.com/acme/platform/app/-/merge_requests/7",
      updatedAt: MR_UPDATED,
    }]]),
    branches: new Map<string, string>([["main", LIVE]]),
    fail: null as string | null,
  };
  const asked: string[] = [];
  const ask = (what: string) => {
    asked.push(what);
    if (state.fail !== null) throw new Error(state.fail);
  };
  const reads: GitlabHookReads = {
    project(projectId) {
      ask(`project ${projectId}`);
      return Promise.resolve(projectId === PROJECT ? state.project : null);
    },
    note(projectId, on, noteId) {
      ask(`note ${on.kind}:${on.iid}:${noteId}`);
      if (projectId !== PROJECT) return Promise.resolve(null);
      return Promise.resolve(state.notes.get(`${on.kind}:${on.iid}:${noteId}`) ?? null);
    },
    discussionHolds(projectId, iid, discussionId, noteId) {
      ask(`discussion ${iid}:${discussionId}`);
      return Promise.resolve(
        projectId === PROJECT &&
          (state.discussions.get(`${iid}:${discussionId}`) ?? []).includes(noteId),
      );
    },
    issueConfidential(projectId, iid) {
      ask(`issue ${iid}`);
      if (projectId !== PROJECT) return Promise.resolve(null);
      return Promise.resolve(state.confidential.get(iid) ?? null);
    },
    mergeRequest(projectId, iid) {
      ask(`mr ${iid}`);
      if (projectId !== PROJECT) return Promise.resolve(null);
      return Promise.resolve(state.mergeRequests.get(iid) ?? null);
    },
    branchHead(projectId, branch) {
      ask(`branch ${branch}`);
      if (projectId !== PROJECT) return Promise.resolve(null);
      return Promise.resolve(state.branches.get(branch) ?? null);
    },
  };
  /** Merge request !7 changed on GitLab at `at` — each push, retarget or reopen does. */
  const touch = (at: string) =>
    state.mergeRequests.set("7", { ...state.mergeRequests.get("7")!, updatedAt: at });
  return { state, reads, asked, touch };
}

/** When every fixture note was written: two seconds before its delivery was received. */
const WRITTEN = "2026-10-14T09:20:00.000Z";
/** When project 4211's current connection was made. */
const CONNECTED = "2026-10-01T08:00:00.000Z";

function note(id: string, body: string, over: Partial<GitlabHookNote> = {}): GitlabHookNote {
  return {
    id,
    body,
    author: ADA,
    system: false,
    internal: false,
    type: null,
    createdAt: WRITTEN,
    ...over,
  };
}

function makeConsumer(
  opts: {
    sinkOutcome?: DeliverOutcome;
    admission?: GitlabHookAdmission["admission"] | (() => Promise<GitlabHookAdmission>);
    connectedAt?: string;
  } = {},
) {
  const delivered: ForgeEvent[] = [];
  const admitted: string[] = [];
  const heards: string[] = [];
  const warnings: string[] = [];
  const gitlab = fakeGitlab();
  const budget = hookBudget({ perMinute: 1_000_000, now: () => 0 });
  const admit = gitlabHookAdmission(budget);
  const consume = gitlabWebhookConsumer({
    sink: {
      deliver(event) {
        delivered.push(event);
        return Promise.resolve(opts.sinkOutcome ?? { kind: "ok" });
      },
    },
    diag: { debug: () => {}, warn: (event) => warnings.push(event) },
    botUserId: BOT_ID,
    gate: {
      admit(projectId, generation, heard) {
        admitted.push(`${projectId}@${generation}`);
        heards.push(heard ?? "door");
        const a = opts.admission ?? "current";
        if (typeof a === "function") return a();
        return Promise.resolve(
          a === "current"
            ? { admission: a, connectedAt: opts.connectedAt ?? CONNECTED }
            : { admission: a },
        );
      },
      dropped: () => Promise.resolve(),
    },
    reads: gitlab.reads,
    budget,
  });
  // Every delivery is handed what the mailroom's admission reserves for it, as in production —
  // and a delivery that spent past `hookCostAtMost` would fail here.
  const spent: number[] = [];
  const consumer = async (h: Hook) => {
    const admission = admit(h);
    assert(admission.kind === "go");
    const ticket = admission.ticket;
    try {
      return await consume(h, ticket);
    } finally {
      if (ticket instanceof HookReservation) spent.push(ticket.used);
      ticket?.release();
    }
  };
  return { consumer, delivered, admitted, heards, warnings, gitlab, spent };
}

const EVENT_OF: Record<string, string> = {
  note: "Note Hook",
  merge: "Merge Request Hook",
  push: "Push Hook",
};

/** A delivery as the mailroom stores it: GitLab's headers plus the scope and generation the
 * door verified. */
function hook(body: Json, over: Partial<Hook> & { event?: string } = {}): Hook {
  const { event, ...rest } = over;
  const kind = body?.object_kind as string | undefined;
  return {
    id: "wh-0000000001",
    registrationId: "gitlab",
    scope: PROJECT,
    seq: 1,
    headers: {
      "x-gitlab-event": event ?? EVENT_OF[kind === "merge_request" ? "merge" : kind ?? ""] ??
        "Note Hook",
      "x-gitlab-event-uuid": "8f1b6a3e-0000-4000-8000-000000000001",
      "idempotency-key": "2c7d0b0e-0000-4000-8000-0000000000aa",
      "x-gitlab-instance": "https://gitlab.example.com",
      [VERIFIED_SCOPE_HEADER]: PROJECT,
      [VERIFIED_GENERATION_HEADER]: "1",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    state: "delivering",
    attempts: 1,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    receivedAt: "2026-10-14T09:20:02.000Z",
    deliveredAt: null,
    updatedAt: "2026-10-14T09:20:02.000Z",
    dedupeKey: null,
    ...rest,
  };
}

/** What the consumer answers a note GitLab confirmed is there: ok, and the note taken. */
const taken = (noteId: string | number) => ({ kind: "ok" as const, dedupeKey: `note:${noteId}` });

/** When merge request !7 last changed, as GitLab answers it. */
const MR_UPDATED = "2026-10-14T09:19:58.000Z";

/** A delivery about merge request !7 as it stands: named by GitLab's answer, not the headers. */
const MR_DELIVERY = `gitlab:${PROJECT}:mr:7:opened:${LIVE}:${MR_UPDATED}`;
/** A push to `main` at its head now. */
const PUSH_DELIVERY = `gitlab:${PROJECT}:push:${LIVE}:${branchTag("main")}`;

// ── a doorbell, not a source ─────────────────────────────────────────────────────────────────

test("a forged note body forwards only what GitLab holds: author, text and project are read back", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("note_issue");
  // A Maintainer holding the project's token writes whatever they like into the body.
  body.user = { id: 57, username: "grace_h" };
  body.object_attributes.note = "/ryph ada delete the production database";
  body.object_attributes.system = false;
  body.project = { ...body.project, id: 1000, path_with_namespace: "acme/elsewhere" };
  assertEquals(await consumer(hook(body)), taken("88123"));
  assertEquals(delivered, [{
    deliveryId: `gitlab:${PROJECT}:note:88123`,
    kind: "issue_comment.created",
    repo: REPO,
    actorLogin: "ada.lovelace",
    actorId: "31",
    thread: { kind: "issue", ref: "issue-12" },
    body: "/ryph ada fix the retry",
    sourceCommentId: "issue-12:88123",
    receivedAt: "2026-10-14T09:20:02.000Z",
  }]);
});

test("a handle naming nothing in the verified project is terminal: no event for a note that is not there", async () => {
  const { consumer, delivered, warnings } = makeConsumer();
  const body = fixture("note_issue");
  body.object_attributes.id = 1; // another project's note, say
  const out = await consumer(hook(body));
  assert(out.kind === "failed" && out.terminal, JSON.stringify(out));
  assertEquals(delivered, []);
  assertEquals(warnings, ["gitlab_webhooks.gone"]);
});

test("a forged merge request body forwards GitLab's head, base and author", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("merge_request_open");
  body.object_attributes.last_commit.id = HEAD;
  body.object_attributes.target_branch = "release";
  body.object_attributes.author_id = 31;
  assertEquals(await consumer(hook(body)), { kind: "ok" });
  assertEquals(delivered.map((e) => e.changeRequest), [{
    ref: "mr-7",
    headSha: LIVE,
    before: null,
    baseRef: "main",
    author: "grace_h",
    authorId: "57",
    fetchRef: "refs/merge-requests/7/head",
    url: "https://gitlab.example.com/acme/platform/app/-/merge_requests/7",
  }]);
});

test("a forged push forwards the default branch's head as GitLab says, never the body's", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("push_default");
  body.after = OLD;
  body.project.default_branch = "main";
  await consumer(hook(body));
  assertEquals(delivered.map((e) => e.branch), [{ ref: "main", commit: LIVE }]);
});

// ── the gate: generations and connection ─────────────────────────────────────────────────────

test("a rotated token is refused terminally before GitLab is asked", async () => {
  const { consumer, delivered, admitted, gitlab, warnings } = makeConsumer({ admission: "stale" });
  const out = await consumer(hook(fixture("note_issue")));
  assert(out.kind === "failed" && out.terminal);
  assertEquals(admitted, [`${PROJECT}@1`]);
  assertEquals(gitlab.asked, [], "a stale token costs no API read");
  assertEquals(delivered, []);
  assertEquals(warnings, ["gitlab_webhooks.stale_token"]);
});

test("a project no connected repo is consumed without a read", async () => {
  const { consumer, delivered, gitlab } = makeConsumer({ admission: "unconnected" });
  assertEquals(await consumer(hook(fixture("merge_request_open"))), { kind: "ok" });
  assertEquals(gitlab.asked, []);
  assertEquals(delivered, []);
});

test("a control plane that cannot be asked is a retryable failure", async () => {
  const { consumer, delivered } = makeConsumer({
    admission: () => Promise.reject(new Error("connection refused")),
  });
  const out = await consumer(hook(fixture("note_issue")));
  assert(out.kind === "failed" && !out.terminal);
  assertEquals(delivered, []);
});

test("a delivery with no verified project or generation is refused: nothing vouches for it", async () => {
  const { consumer, delivered, admitted } = makeConsumer();
  const body = fixture("note_issue");
  for (const header of [VERIFIED_SCOPE_HEADER, VERIFIED_GENERATION_HEADER]) {
    const headers = { ...hook(body).headers };
    delete headers[header];
    const missing = await consumer(hook(body, { headers }));
    assert(missing.kind === "failed" && missing.terminal, header);
  }
  const malformed = await consumer(hook(body, {
    headers: { ...hook(body).headers, [VERIFIED_SCOPE_HEADER]: "4211; 1000" },
  }));
  assert(malformed.kind === "failed" && malformed.terminal);
  assertEquals(delivered, []);
  assertEquals(admitted, []);
});

// ── notes ────────────────────────────────────────────────────────────────────────────────────

test("a note on a merge request is a change_request thread, `mr-<iid>`: the two iid spaces never meet", async () => {
  const { consumer, delivered } = makeConsumer();
  await consumer(hook(fixture("note_merge_request")));
  assertEquals(delivered.map((e) => [e.kind, e.thread, e.sourceCommentId, e.inline]), [
    ["issue_comment.created", { kind: "change_request", ref: "mr-7" }, "mr-7:88124", undefined],
  ]);
  assertEquals(delivered[0].body, "@ryph-bot please rebase this onto main");
});

test("a diff note is a review_comment.created naming its discussion, once GitLab says it holds the note", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(fixture("note_diff"))), taken("88125"));
  assertEquals(delivered, [{
    deliveryId: `gitlab:${PROJECT}:note:88125`,
    kind: "review_comment.created",
    repo: REPO,
    actorLogin: "ada.lovelace",
    actorId: "31",
    thread: { kind: "change_request", ref: "mr-7" },
    body: "/ryph ada handle the timeout here too",
    sourceCommentId: "mr-7:88125",
    inline: { commentId: `mr-7:${DISCUSSION}:88125` },
    receivedAt: "2026-10-14T09:20:02.000Z",
  }]);
});

test("a diff note whose named discussion does not hold it, or names none, is answered beside it", async () => {
  const elsewhere = fixture("note_diff");
  elsewhere.object_attributes.discussion_id = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  const none = fixture("note_diff");
  delete none.object_attributes.discussion_id;
  for (const body of [elsewhere, none]) {
    const { consumer, delivered } = makeConsumer();
    await consumer(hook(body));
    assertEquals(delivered.map((e) => [e.kind, e.sourceCommentId, e.inline]), [
      ["issue_comment.created", "mr-7:88125", undefined],
    ]);
  }
});

test("notes on a commit or a snippet are consumed: no thread ryph works in", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  assertEquals(await consumer(hook(fixture("note_commit"))), { kind: "ok" });
  assertEquals(delivered.length, 0);
  assertEquals(gitlab.asked, []);
});

test("system notes, internal notes, notes on a confidential issue and edits are consumed", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.notes.set("issue:12:88123", note("88123", "/ryph ada x", { system: true }));
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  gitlab.state.notes.set("issue:12:88123", note("88123", "/ryph ada x", { internal: true }));
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  gitlab.state.notes.set("issue:12:88123", note("88123", "/ryph ada x"));
  gitlab.state.confidential.set("12", true);
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  const edited = fixture("note_merge_request");
  edited.object_attributes.action = "update";
  assertEquals(await consumer(hook(edited)), { kind: "ok" });
  assertEquals(delivered.length, 0);
});

test("a note with no action is a creation, as an older instance sends it", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("note_issue");
  delete body.object_attributes.action;
  await consumer(hook(body));
  assertEquals(delivered.length, 1);
});

test("the bot's own notes are never commands, whatever the body claims", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  for (const [key, id] of [["issue:12:88123", "88123"], ["merge_request:7:88125", "88125"]]) {
    gitlab.state.notes.set(
      key,
      note(id, "/ryph ada go", { author: { id: BOT_ID, username: "ryph-bot" } }),
    );
  }
  for (const name of ["note_issue", "note_diff"]) {
    assertEquals(await consumer(hook(fixture(name))), taken(fixture(name).object_attributes.id));
  }
  assertEquals(delivered.length, 0);
});

test("a note carrying ryph's action marker is never a command, whoever's account wrote it", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  const text = withSignature(
    "/ryph ada fix this",
    { agentName: "Ada", runUrl: null, requestedBy: "grace_h", requestedVia: null },
    "fa-01jb7k3m9x4q8zt2vw6hn5c0fe",
    "gitlab",
  );
  assert(text.includes(actionMarker("fa-01jb7k3m9x4q8zt2vw6hn5c0fe")));
  gitlab.state.notes.set("issue:12:88123", note("88123", text));
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  assertEquals(delivered.length, 0);
});

test("a note longer than the control plane takes is consumed and said, never failed", async () => {
  const { consumer, delivered, warnings, gitlab } = makeConsumer();
  gitlab.state.notes.set("issue:12:88123", note("88123", "/ryph ada " + "x".repeat(70_000)));
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  assertEquals(delivered.length, 0);
  assertEquals(warnings, ["gitlab_webhooks.note_too_long"]);
});

test("an old note rung again is never a command: written over an hour before receipt, or before the connection", async () => {
  // A Maintainer holds the token, and GitLab's "Test → Comments" resends a real note: either
  // can ring for a `/ryph` note written long ago that no delivery ever carried here — while the
  // hook was missing, disabled or stale — and its author would be acting now.
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.notes.set(
    "issue:12:88123",
    note("88123", "/ryph ada fix the retry", { createdAt: "2026-10-14T08:20:01.000Z" }),
  );
  assertEquals(await consumer(hook(fixture("note_issue"))), taken("88123"));
  assertEquals(delivered, [], "written an hour and a second before it was received");

  // Within the hour, but before the project was connected (again): not this connection's.
  const reconnected = makeConsumer({ connectedAt: "2026-10-14T09:20:01.000Z" });
  assertEquals(await reconnected.consumer(hook(fixture("note_issue"))), taken("88123"));
  assertEquals(reconnected.delivered, []);

  // The bound is the receipt, not the attempt: a delivery that waited out retries is still on
  // time if it rang in time.
  const retried = makeConsumer();
  retried.gitlab.state.notes.set(
    "issue:12:88123",
    note("88123", "/ryph ada fix the retry", { createdAt: "2026-10-14T08:21:00.000Z" }),
  );
  await retried.consumer(hook(fixture("note_issue"), { attempts: 7 }));
  assertEquals(retried.delivered.map((e) => e.deliveryId), [`gitlab:${PROJECT}:note:88123`]);
});

test("a note's delivery id is its own: every ring of it — a resend, a replay — is one command", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("note_issue");
  await consumer(hook(body));
  const headers = { ...hook(body).headers, "idempotency-key": "another-key" };
  // Taken once already: the ring again is not even forwarded, and were it (a restart forgot), it
  // would carry the id the control plane already decided.
  assertEquals(await consumer(hook(body, { headers })), taken("88123"));
  assertEquals(delivered.map((e) => e.deliveryId), [`gitlab:${PROJECT}:note:88123`]);
});

test("a note rung again is dropped by the mailroom before a single GitLab read or control-plane question", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    const { consumer, delivered, admitted, gitlab } = makeConsumer();
    const store = drizzleHookStore(webhooksDb.db);
    const mailroom = setupWebhooks({
      store,
      diag: { debug: () => {}, warn: () => {} },
      now: () => new Date("2026-10-14T09:20:03.000Z"),
    });
    mailroom.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: "m",
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      dedupeKey: gitlabHookDedupeKey,
      consumer,
    });
    const ring = (id: string, body: Json, idempotencyKey: string) => {
      const { seq: _seq, ...row } = hook(body, { id, state: "pending", attempts: 0 });
      return store.recordHook({
        ...row,
        headers: { ...row.headers, "idempotency-key": idempotencyKey },
      });
    };
    const body = fixture("note_issue");
    await ring("wh-0000000001", body, "first");
    await mailroom.sweep();
    const firstReads = gitlab.asked.length;
    assert(firstReads > 0);
    assertEquals(delivered.length, 1);

    // GitLab's "Test → Comments", or a token holder's script: the same note, rung again and again.
    for (let i = 2; i <= 6; i++) await ring(`wh-000000000${i}`, body, `replay-${i}`);
    // An edit of it is not the note's creation and is judged on its own.
    const edit = structuredClone(body);
    edit.object_attributes.action = "update";
    await ring("wh-0000000007", edit, "edit");
    await mailroom.sweep();

    assertEquals(gitlab.asked.length, firstReads); // not one read more
    assertEquals(admitted.length, 2); // the first ring, and the edit
    assertEquals(delivered.length, 1);
    assertEquals((await store.getHook("wh-0000000006"))?.state, "delivered");
  } finally {
    await cluster.close();
  }
});

test("a forged ring for a note id GitLab never confirmed cannot suppress the real note later", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    let admission: GitlabHookAdmission["admission"] = "current";
    const { consumer, delivered } = makeConsumer({
      admission: () =>
        Promise.resolve(
          admission === "current"
            ? { admission, connectedAt: CONNECTED }
            : { admission } as GitlabHookAdmission,
        ),
    });
    const store = drizzleHookStore(webhooksDb.db);
    const mailroom = setupWebhooks({
      store,
      diag: { debug: () => {}, warn: () => {} },
      now: () => new Date("2026-10-14T09:20:03.000Z"),
    });
    mailroom.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: "m",
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      dedupeKey: gitlabHookDedupeKey,
      consumer,
    });
    const ring = (id: string, body: Json) => {
      const { seq: _seq, ...row } = hook(body, { id, state: "pending", attempts: 0 });
      return store.recordHook(row);
    };
    // A token holder guesses the next note ids and rings for them first, in every shape the
    // consumer accepts without asking GitLab: on a commit, on an issue the body leaves out, and
    // before the project is connected at all.
    const real = fixture("note_issue");
    const onCommit = structuredClone(real);
    onCommit.object_attributes.noteable_type = "Commit";
    const noIssue = structuredClone(real);
    delete noIssue.issue;
    await ring("wh-0000000001", onCommit);
    await ring("wh-0000000002", noIssue);
    admission = "unconnected";
    await mailroom.sweep();
    await ring("wh-0000000003", real);
    await mailroom.sweep();
    for (const id of ["wh-0000000001", "wh-0000000002", "wh-0000000003"]) {
      const forged = await store.getHook(id);
      assertEquals(forged?.state, "delivered");
      assertEquals(forged?.dedupeKey, null); // GitLab confirmed nothing, so nothing is known taken
    }
    assertEquals(delivered.length, 0);

    // The real note 88123 is written, and GitLab rings for it: a command, forwarded.
    admission = "current";
    await ring("wh-0000000004", real);
    await mailroom.sweep();
    assertEquals(delivered.map((e) => e.deliveryId), [`gitlab:${PROJECT}:note:88123`]);
    assertEquals((await store.getHook("wh-0000000004"))?.dedupeKey, "note:88123");
  } finally {
    await cluster.close();
  }
});

test("a note's dedupe key is its id, for a creation only; everything else has none", () => {
  const body = fixture("note_issue");
  assertEquals(gitlabHookDedupeKey(hook(body)), "note:88123");
  const noAction = structuredClone(body);
  delete noAction.object_attributes.action;
  assertEquals(gitlabHookDedupeKey(hook(noAction)), "note:88123");
  const edit = structuredClone(body);
  edit.object_attributes.action = "update";
  assertEquals(gitlabHookDedupeKey(hook(edit)), null);
  assertEquals(gitlabHookDedupeKey(hook(fixture("merge_request_merge")))!, null);
  assertEquals(gitlabHookDedupeKey(hook("not json", { event: "Note Hook" })), null);
  assertEquals(gitlabHookDedupeKey(hook({ object_attributes: { id: "1; drop" } })), null);
});

// ── merge requests ───────────────────────────────────────────────────────────────────────────

test("a merge request opened is a change_request.pushed, the actor the one who acted", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(fixture("merge_request_open"))), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: MR_DELIVERY,
    kind: "change_request.pushed",
    repo: REPO,
    actorLogin: "ada.lovelace",
    actorId: "31",
    thread: { kind: "change_request", ref: "mr-7" },
    body: null,
    sourceCommentId: null,
    changeRequest: {
      ref: "mr-7",
      headSha: LIVE,
      before: null,
      baseRef: "main",
      author: "grace_h",
      authorId: "57",
      fetchRef: "refs/merge-requests/7/head",
      url: "https://gitlab.example.com/acme/platform/app/-/merge_requests/7",
    },
    receivedAt: "2026-10-14T09:20:02.000Z",
  }]);
});

test("a merge request's delivery is admitted as one, every other as not: merges arrive only so", async () => {
  const { consumer, heards } = makeConsumer();
  await consumer(hook(fixture("merge_request_open")));
  await consumer(hook(fixture("note_issue")));
  await consumer(hook(fixture("push_default")));
  assertEquals(heards, ["merge_request", "other", "other"]);
});

test("reopen, an update that pushed commits, and a retarget are pushes; a push names where it moved from", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  const reopened = fixture("merge_request_open");
  reopened.object_attributes.action = "reopen";
  let minute = 0;
  for (
    const body of [
      reopened,
      fixture("merge_request_update_push"),
      fixture("merge_request_update_retarget"),
    ]
  ) {
    gitlab.touch(`2026-10-14T09:2${minute++}:00.000Z`); // each one changed it on GitLab
    assertEquals(await consumer(hook(body)), { kind: "ok" });
  }
  assertEquals(delivered.map((e) => [e.kind, e.changeRequest?.before, e.changeRequest?.baseRef]), [
    ["change_request.pushed", null, "main"],
    ["change_request.pushed", OLD, "main"],
    ["change_request.pushed", null, "main"],
  ]);
});

test("updates that move nothing, approvals and other actions are consumed without a read", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  assertEquals(await consumer(hook(fixture("merge_request_update_title"))), { kind: "ok" });
  assertEquals(await consumer(hook(fixture("merge_request_approved"))), { kind: "ok" });
  for (const action of ["unapproved", "approval", "unapproval", null]) {
    const body = fixture("merge_request_approved");
    body.object_attributes.action = action;
    assertEquals(await consumer(hook(body)), { kind: "ok" });
  }
  assertEquals(delivered.length, 0);
  assertEquals(gitlab.asked, []);
});

test("a merge names GitLab's target and head at the merge, and who merged it", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.mergeRequests.set("7", {
    ...gitlab.state.mergeRequests.get("7")!,
    state: "merged",
    endedBy: GRACE,
  });
  assertEquals(await consumer(hook(fixture("merge_request_merge"))), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: `gitlab:${PROJECT}:mr:7:merged:${LIVE}:${MR_UPDATED}`,
    kind: "change_request.merged",
    repo: REPO,
    actorLogin: "grace_h",
    actorId: "57",
    thread: { kind: "change_request", ref: "mr-7" },
    body: null,
    sourceCommentId: null,
    merged: { baseRef: "main", heads: [LIVE] },
    receivedAt: "2026-10-14T09:20:02.000Z",
  }]);
});

test("a close is a change_request.closed only when GitLab says closed; a forged one for an open MR is nothing", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  await consumer(hook(fixture("merge_request_close")));
  await consumer(hook(fixture("merge_request_merge")));
  assertEquals(delivered, [], "the merge request is open");
  gitlab.state.mergeRequests.set("7", { ...gitlab.state.mergeRequests.get("7")!, state: "closed" });
  await consumer(hook(fixture("merge_request_close")));
  assertEquals(delivered.map((e) => [e.kind, e.thread]), [
    ["change_request.closed", { kind: "change_request", ref: "mr-7" }],
  ]);
});

test("a merge request being merged (`locked`) is retried, not settled", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.mergeRequests.set("7", { ...gitlab.state.mergeRequests.get("7")!, state: "locked" });
  const out = await consumer(hook(fixture("merge_request_merge")));
  assert(out.kind === "failed" && !out.terminal);
  assertEquals(delivered, []);
});

test("a merge request GitLab does not have is terminal — the queue is never held for it", async () => {
  const { consumer, delivered } = makeConsumer();
  const body = fixture("merge_request_open");
  body.object_attributes.iid = 404;
  const out = await consumer(hook(body));
  assert(out.kind === "failed" && out.terminal);
  assertEquals(delivered, []);
});

test("a merge request's page is a link only when it is a web one", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  for (const url of ["javascript:alert(1)", "http://gitlab.internal/a/b/-/merge_requests/7"]) {
    gitlab.state.mergeRequests.set("7", {
      ...gitlab.state.mergeRequests.get("7")!,
      webUrl: url,
      updatedAt: `2026-10-14T09:2${url.length % 10}:00.000Z`,
    });
    await consumer(hook(fixture("merge_request_open")));
  }
  assertEquals(delivered.map((e) => e.changeRequest?.url), [
    null,
    "http://gitlab.internal/a/b/-/merge_requests/7",
  ]);
});

// ── pushes ───────────────────────────────────────────────────────────────────────────────────

test("a push to the default branch is a branch.updated naming the branch and its head now", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(hook(fixture("push_default"))), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: PUSH_DELIVERY,
    kind: "branch.updated",
    repo: REPO,
    actorLogin: "ada.lovelace",
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: "main", commit: LIVE },
    receivedAt: "2026-10-14T09:20:02.000Z",
  }]);
});

test("a renamed default branch arrives as a branch.updated naming the new one", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.project!.defaultBranch = "trunk";
  gitlab.state.branches.set("trunk", HEAD);
  const body = fixture("push_default");
  body.ref = "refs/heads/trunk";
  await consumer(hook(body));
  assertEquals(delivered.map((e) => e.branch), [{ ref: "trunk", commit: HEAD }]);
});

test("pushes that move no default branch are consumed: other branches, a deleted default, empty projects", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  const other = fixture("push_default");
  other.ref = "refs/heads/feat/x";
  assertEquals(await consumer(hook(other)), { kind: "ok" });
  gitlab.state.branches.delete("main");
  assertEquals(await consumer(hook(fixture("push_default"))), { kind: "ok" });
  gitlab.state.project!.defaultBranch = null;
  assertEquals(await consumer(hook(fixture("push_default"))), { kind: "ok" });
  assertEquals(delivered.length, 0);
});

// ── the door's general contract ──────────────────────────────────────────────────────────────

test("events ryph does not read are consumed unparsed, confidential notes among them", async () => {
  const { consumer, delivered, admitted } = makeConsumer();
  for (
    const event of [
      "Issue Hook",
      "Confidential Issue Hook",
      "Confidential Note Hook",
      "Tag Push Hook",
      "Pipeline Hook",
      "Job Hook",
      "Deployment Hook",
      "Release Hook",
    ]
  ) {
    assertEquals(await consumer(hook("not even json", { event })), { kind: "ok" });
  }
  assertEquals(delivered.length, 0);
  assertEquals(admitted, []);
});

test("a payload that can never parse fails terminally — retrying reshapes nothing", async () => {
  const { consumer, delivered } = makeConsumer();
  const notJson = await consumer(hook("certainly not json", { event: "Note Hook" }));
  assert(notJson.kind === "failed" && notJson.terminal);
  const wrongShape = await consumer(hook({ object_kind: "note" }));
  assert(wrongShape.kind === "failed" && wrongShape.terminal);
  assertEquals(delivered.length, 0);
});

test("GitLab not answering is a retryable failure, never a guess", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  gitlab.state.fail = "GitLab answered 502";
  for (const name of ["note_issue", "merge_request_open", "push_default"]) {
    const out = await consumer(hook(fixture(name)));
    assert(out.kind === "failed" && !out.terminal, name);
    assert(out.message.includes("502"));
  }
  assertEquals(delivered.length, 0);
});

test("a merge request's or a push's delivery id is what GitLab answered, never a header the sender wrote", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  const fresh = (body: Json, n: number) =>
    hook(body, {
      id: `wh-000000000${n}`,
      headers: {
        ...hook(body).headers,
        "idempotency-key": `replay-${n}`,
        "x-gitlab-event-uuid": `uuid-${n}`,
      },
    });
  // A token holder replays one merge request update and one push, each with fresh headers.
  for (let n = 1; n <= 3; n++) {
    assertEquals(await consumer(fresh(fixture("merge_request_update_push"), n)), { kind: "ok" });
    assertEquals(await consumer(fresh(fixture("push_default"), n)), { kind: "ok" });
  }
  const ids = delivered.map((e) => e.deliveryId);
  assertEquals(ids, [MR_DELIVERY, PUSH_DELIVERY], "each state forwarded once");
  // A genuinely new head is a new state, and flows.
  gitlab.state.mergeRequests.set("7", {
    ...gitlab.state.mergeRequests.get("7")!,
    headSha: HEAD,
    updatedAt: "2026-10-14T09:30:00.000Z",
  });
  gitlab.state.branches.set("main", HEAD);
  await consumer(fresh(fixture("merge_request_update_push"), 4));
  await consumer(fresh(fixture("push_default"), 4));
  assertEquals(delivered.slice(2).map((e) => [e.kind, e.deliveryId]), [
    [
      "change_request.pushed",
      `gitlab:${PROJECT}:mr:7:opened:${HEAD}:2026-10-14T09:30:00.000Z`,
    ],
    ["branch.updated", `gitlab:${PROJECT}:push:${HEAD}:${branchTag("main")}`],
  ]);
});

test("each event forwarded spends what the control plane may call GitLab for; a replay spends nothing", async () => {
  const { consumer, delivered, spent } = makeConsumer();
  await consumer(hook(fixture("merge_request_update_push")));
  await consumer(hook(fixture("push_default")));
  await consumer(hook(fixture("note_issue")));
  // Two reads and 8; two reads and 4; three reads and 4.
  assertEquals(spent, [10, 6, 7]);
  // The same states rung again: read, not forwarded, and not charged.
  await consumer(hook(fixture("merge_request_update_push")));
  await consumer(hook(fixture("push_default")));
  assertEquals(spent.slice(3), [2, 2]);
  assertEquals(delivered.length, 3);
});

test("a delivery reserves the most it can spend, and what it did not spend comes back", async () => {
  // Every shape a reservation must cover, with what each costs at most.
  const cases: Array<[string, Json, number]> = [
    ["note on an issue", fixture("note_issue"), 7],
    ["diff note", fixture("note_diff"), 7],
    ["merge request push", fixture("merge_request_update_push"), 10],
    ["merge", fixture("merge_request_merge"), 10],
    ["push", fixture("push_default"), 6],
  ];
  for (const [what, body, most] of cases) {
    const reserved: number[] = [];
    const used: number[] = [];
    let tokens = 0;
    const budget = {
      reserve(_scope: string, cost: number) {
        reserved.push(cost);
        tokens -= cost;
        return new HookReservation(cost, () => {}, (unused) => tokens += unused);
      },
    };
    const gitlab = fakeGitlab();
    const consumer = gitlabWebhookConsumer({
      sink: { deliver: () => Promise.resolve({ kind: "ok" }) },
      diag: { debug: () => {}, warn: () => {} },
      botUserId: BOT_ID,
      gate: {
        admit: () => Promise.resolve({ admission: "current", connectedAt: CONNECTED }),
        dropped: () => Promise.resolve(),
      },
      reads: gitlab.reads,
      budget,
    });
    const admission = gitlabHookAdmission(budget)(hook(body));
    assert(admission.kind === "go" && admission.ticket instanceof HookReservation);
    const out = await consumer(hook(body), admission.ticket);
    assertEquals(out.kind, "ok", what);
    used.push(admission.ticket.used);
    admission.ticket.release();
    assertEquals(reserved, [most], what);
    assertEquals(tokens, -used[0], `${what}: all but what was spent is back`);
  }
  // A forged ring for a note that is not there: seven reserved, one spent, six back.
  const { consumer, spent } = makeConsumer();
  const forged = fixture("note_issue");
  forged.object_attributes.id = 1;
  assertEquals((await consumer(hook(forged))).kind, "failed");
  assertEquals(spent, [1]);
  // An event read unparsed reserves nothing.
  const none = gitlabHookAdmission({ reserve: () => assert(false) as never })(
    hook({}, { event: "Pipeline Hook" }),
  );
  assertEquals(none, { kind: "go" });
});

test("a budgeted consumer handed no reservation retries rather than read unbudgeted", async () => {
  const gitlab = fakeGitlab();
  const consumer = gitlabWebhookConsumer({
    sink: { deliver: () => Promise.resolve({ kind: "ok" }) },
    diag: { debug: () => {}, warn: () => {} },
    botUserId: BOT_ID,
    gate: {
      admit: () => Promise.resolve({ admission: "current", connectedAt: CONNECTED }),
      dropped: () => Promise.resolve(),
    },
    reads: gitlab.reads,
    budget: hookBudget({ perMinute: 600, now: () => 0 }),
  });
  const out = await consumer(hook(fixture("note_issue")));
  assert(out.kind === "failed" && !out.terminal && out.message.includes("reservation"));
  assertEquals(gitlab.asked, []);
});

test("a delivery the control plane did not take is forwarded again when rung again", async () => {
  let refuse = true;
  const delivered: string[] = [];
  const gitlab = fakeGitlab();
  const consumer = gitlabWebhookConsumer({
    sink: {
      deliver(event) {
        delivered.push(event.deliveryId);
        return Promise.resolve(
          refuse ? { kind: "failed", message: "behind", terminal: false } : { kind: "ok" },
        );
      },
    },
    diag: { debug: () => {}, warn: () => {} },
    botUserId: BOT_ID,
    gate: {
      admit: () => Promise.resolve({ admission: "current", connectedAt: CONNECTED }),
      dropped: () => Promise.resolve(),
    },
    reads: gitlab.reads,
  });
  await consumer(hook(fixture("push_default")));
  refuse = false;
  await consumer(hook(fixture("push_default")));
  await consumer(hook(fixture("push_default")));
  assertEquals(delivered, [PUSH_DELIVERY, PUSH_DELIVERY]);
});

test("the sink's verdict travels through unchanged", async () => {
  const { consumer } = makeConsumer({
    sinkOutcome: { kind: "failed", message: "orchestrator unreachable", terminal: false },
  });
  const outcome = await consumer(hook(fixture("note_issue")));
  assert(outcome.kind === "failed" && !outcome.terminal);
});

test("every fixture's event is one the control plane can take: refs, handles and bounds", async () => {
  const { consumer, delivered, gitlab } = makeConsumer();
  let minute = 0;
  for (
    const name of [
      "note_issue",
      "note_merge_request",
      "note_diff",
      "merge_request_open",
      "merge_request_update_push",
      "merge_request_update_retarget",
      "push_default",
    ]
  ) {
    gitlab.touch(`2026-10-14T09:2${minute++}:00.000Z`); // each merge request event changed it
    assertEquals(
      await consumer(hook(fixture(name))),
      name.startsWith("note_") ? taken(fixture(name).object_attributes.id) : { kind: "ok" },
      name,
    );
  }
  assertEquals(delivered.length, 7);
  // The orchestrator's `forgeThreadRef`: what a thread ref and a comment handle may spell.
  const handle = /^[A-Za-z0-9._:-]{1,200}$/;
  for (const e of delivered) {
    if (e.thread !== null) assert(handle.test(e.thread.ref), e.thread.ref);
    if (e.sourceCommentId !== null) assert(handle.test(e.sourceCommentId), e.sourceCommentId);
    if (e.inline !== undefined) assert(handle.test(e.inline.commentId), e.inline.commentId);
    assert(e.deliveryId.length <= 200);
  }
});

// ── the door's question ──────────────────────────────────────────────────────────────────────

/** The door's gate over a control plane the test answers, on a clock the test moves. */
function doorGate(answer: (generation: string) => Promise<GitlabHookAdmission>) {
  let now = 0;
  const asked: string[] = [];
  const warnings: string[] = [];
  const admit = gitlabDoorGate({
    admit(projectId, generation, heard) {
      asked.push(`${projectId}@${generation}${heard === undefined ? "" : `:${heard}`}`);
      return answer(generation);
    },
    dropped: () => Promise.resolve(),
  }, {
    now: () => now,
    diag: { debug: () => {}, warn: (event) => warnings.push(event) },
    timeoutMs: 20,
  });
  return { admit, asked, warnings, advance: (ms: number) => now += ms };
}

const CURRENT: GitlabHookAdmission = { admission: "current", connectedAt: CONNECTED };

test("the door asks the control plane once per project and generation, and records nothing", async () => {
  const door = doorGate((g) => Promise.resolve(g === "2" ? CURRENT : { admission: "stale" }));
  assertEquals(await door.admit(PROJECT, "1"), false);
  assertEquals(await door.admit(PROJECT, "2"), true);
  // Answered from memory, a "current" for a minute, a refusal for longer.
  assertEquals(await Promise.all([door.admit(PROJECT, "1"), door.admit(PROJECT, "2")]), [
    false,
    true,
  ]);
  assertEquals(door.asked, [`${PROJECT}@1`, `${PROJECT}@2`], "no `heard`: nothing recorded");
  door.advance(DOOR_ADMIT_TTL_MS);
  await door.admit(PROJECT, "1");
  await door.admit(PROJECT, "2");
  assertEquals(door.asked.length, 3, "the admission expired, the refusal did not");
  door.advance(DOOR_REFUSE_TTL_MS);
  await door.admit(PROJECT, "1");
  assertEquals(door.asked.length, 4);
  // A token naming no generation was minted by nobody.
  assertEquals(await door.admit(PROJECT, undefined), false);
});

test("a flood at the door asks the control plane once, however many arrive together", async () => {
  let release: (a: GitlabHookAdmission) => void = () => {};
  const door = doorGate(() => new Promise((resolve) => release = resolve));
  const flood = Array.from({ length: 50 }, () => door.admit(PROJECT, "1"));
  await Promise.resolve();
  release({ admission: "stale" });
  assertEquals(new Set(await Promise.all(flood)), new Set([false]));
  assertEquals(door.asked.length, 1);
});

test("a control plane that does not answer: the door goes by its last answer, and with none takes the delivery", async () => {
  let down = false;
  const door = doorGate((g) =>
    down
      ? new Promise(() => {}) // hangs: the door's own timeout ends the wait
      : Promise.resolve(g === "1" ? { admission: "stale" } : CURRENT)
  );
  assertEquals(await door.admit(PROJECT, "1"), false);
  assertEquals(await door.admit(PROJECT, "2"), true);
  down = true;
  door.advance(DOOR_REFUSE_TTL_MS);
  // A rotated token stays refused through an outage; a current one stays taken.
  assertEquals(await door.admit(PROJECT, "1"), false);
  assertEquals(await door.admit(PROJECT, "2"), true);
  // Never asked before: stored, for the consumer — which asks again, and fails closed — to judge.
  assertEquals(await door.admit(PROJECT, "3"), true);
  assertEquals(door.warnings, [
    "gitlab_webhooks.door_unanswered",
    "gitlab_webhooks.door_unanswered",
    "gitlab_webhooks.door_unanswered",
  ]);
});

// ── drops over budget ────────────────────────────────────────────────────────────────────────

test("a delivery's lane is comments for a Note Hook and other for every other name, made up or not", () => {
  const lane = (event?: string) =>
    gitlabHookLane(new Headers(event === undefined ? {} : { "x-gitlab-event": event }));
  assertEquals(lane("Note Hook"), "comments");
  assertEquals(lane("Merge Request Hook"), "other");
  assertEquals(lane("Push Hook"), "other");
  assertEquals(lane("Confidential Note Hook"), "other");
  assertEquals(lane("note hook"), "other");
  assertEquals(lane(), "other");
});

test("drops over a project's budgets are told to the control plane in one batch per window, by lane", async () => {
  const told: string[] = [];
  const warnings: string[] = [];
  const timers: { flush: () => void; ms: number }[] = [];
  let failNext = false;
  const drop = gitlabDropReporter({
    dropped(projectId, generation, lane, count) {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("control plane down"));
      }
      told.push(`${projectId}@${generation}:${lane}:${count}`);
      return Promise.resolve();
    },
  }, {
    diag: { debug: () => {}, warn: (event) => warnings.push(event) },
    schedule: (flush, ms) => timers.push({ flush, ms }),
  });

  // A flood: one report scheduled, however many drops.
  for (let i = 0; i < 500; i++) drop("42", "3", "other");
  drop("42", "3", "comments");
  drop("43", "1", "other");
  drop("43", "1", "made-up"); // no lane the door has: counted with the other events
  drop(null, null, "other"); // a mailbox without scopes has nobody to tell
  assertEquals(timers.map((t) => t.ms), [DROP_REPORT_MS]);
  assertEquals(told, []);
  timers.shift()!.flush();
  await Promise.resolve();
  assertEquals(told, ["42@3:other:500", "42@3:comments:1", "43@1:other:2"]);
  assertEquals(warnings.filter((w) => w === "gitlab_webhooks.dropped_over_budget").length, 504);

  // The next drop starts the next window; a report that fails is said in the log.
  failNext = true;
  drop("42", "3", "comments");
  assertEquals(timers.length, 1);
  timers.shift()!.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert(warnings.includes("gitlab_webhooks.drop_report_failed"));
});

// ── the budget every project shares ─────────────────────────────────────────────────────────

test("a flood of cheap deliveries from many projects cannot starve another project's command, and a budget wait spends no attempt", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    let now = Date.parse("2026-10-14T09:19:00.000Z");
    const PER_MINUTE = 60;
    const budget = hookBudget({ perMinute: PER_MINUTE, now: () => now });
    const gitlab = fakeGitlab();
    const delivered: ForgeEvent[] = [];
    const deps = {
      sink: {
        deliver(event: ForgeEvent) {
          delivered.push(event);
          return Promise.resolve({ kind: "ok" as const });
        },
      },
      diag: { debug: () => {}, warn: () => {} },
      botUserId: BOT_ID,
      gate: {
        admit: () => Promise.resolve({ admission: "current" as const, connectedAt: CONNECTED }),
        dropped: () => Promise.resolve(),
      },
      reads: gitlab.reads,
      budget,
    };
    const store = drizzleHookStore(webhooksDb.db);
    const mailroom = setupWebhooks({
      store,
      diag: { debug: () => {}, warn: () => {} },
      now: () => new Date(now),
    });
    mailroom.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: "m",
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      dedupeKey: gitlabHookDedupeKey,
      // A short ladder, so a command that keeps losing its attempts is lost within the test.
      policy: { baseBackoffMs: 2_000, maxBackoffMs: 8_000, maxAttempts: 5 },
      admitDelivery: gitlabHookAdmission(budget),
      consumer: gitlabWebhookConsumer(deps),
    });

    // Eight projects whose token holder rings, without pause, for notes that are not there: each
    // costs one read and ends terminally, so those queues never wait on a clock of their own.
    const flooders = ["1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008"];
    let forged = 0;
    const ring = (scope: string, body: Json, id: string, receivedAt: string) => {
      const { seq: _seq, ...row } = hook(body, {
        id,
        scope,
        state: "pending",
        attempts: 0,
        receivedAt,
        updatedAt: receivedAt,
      });
      return store.recordHook({
        ...row,
        headers: { ...row.headers, [VERIFIED_SCOPE_HEADER]: scope },
      });
    };
    const flood = async () => {
      const at = new Date(now).toISOString();
      for (const scope of flooders) {
        for (let i = 0; i < 2; i++) {
          const body = fixture("note_issue");
          body.object_attributes.id = 900_000 + ++forged;
          await ring(scope, body, `wh-f${forged}`, at);
        }
      }
    };

    // The flood drains the bucket, and keeps it drained.
    for (let tick = 0; tick < 30; tick++) {
      await flood();
      await mailroom.sweep();
      now += 2_000;
    }
    // Project 4211's /ryph note lands in the middle of it.
    await ring(PROJECT, fixture("note_issue"), "wh-innocent", "2026-10-14T09:20:02.000Z");
    const started = now;
    let innocent = await store.getHook("wh-innocent");
    for (let tick = 0; tick < 60 && innocent?.state === "pending"; tick++) {
      await flood();
      await mailroom.sweep();
      now += 2_000;
      innocent = await store.getHook("wh-innocent");
    }

    assertEquals(innocent?.state, "delivered", `the command was ${innocent?.state}`);
    assertEquals(delivered.map((e) => e.deliveryId), [`gitlab:${PROJECT}:note:88123`]);
    // Waiting for the budget is not a failed delivery: the one attempt is the one that delivered.
    assertEquals(innocent?.attempts, 1);
    assert(Date.parse(innocent!.deliveredAt!) - started < 60_000, "delivered within a minute");
    // And the flood was served all the while, with no more than the budget allows: a minute's
    // worth to start with, and a call a second since.
    const spent = gitlab.asked.length + 4 * delivered.length;
    const elapsed = (now - Date.parse("2026-10-14T09:19:00.000Z")) / 1_000;
    assert(spent <= PER_MINUTE + elapsed, `spent ${spent} in ${elapsed} s`);
    assert(spent >= elapsed * 0.8, `the budget is used, not hoarded: ${spent} in ${elapsed} s`);
  } finally {
    await cluster.close();
  }
});
