// The Radicle adapter against a fake bridge — every method of the port, the two things that
// are genuinely different here (a comment handle that carries its thread, a capability refusal
// an agent is meant to read), and the registry picking it for a `rad:` repo.
//
// No node, no `rad`, no network beyond 127.0.0.1: the bridge's HTTP surface is the contract,
// and @ryph/radicle's own suite is what proves that surface against real binaries.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { radicleForgeApi } from "../src/adapters/forge_api/radicle.ts";
import { ForgeApiError, providerRegistry, wholeRepoVisibility } from "../src/ports/forge_api.ts";
import type { ForgeApi } from "../src/ports/forge_api.ts";
import type { RadicleBridgeApi } from "../src/ports/radicle_bridge.ts";
import { recordingDiagnostics, silentDiagnostics } from "./util.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const TOKEN = "bridge-secret";
const OURS = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
const THEM = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";
const CHANGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXPLORER = "https://explorer.test/{rid}/{kind}/{id}";
const ISSUE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A repo as the port is addressed with one. Radicle has no tenants: null, always. */
const repo = (repoRef = RID) => ({ repoRef, tenantId: null });

const identityDoc = (over: Record<string, unknown> = {}) => ({
  rid: RID,
  name: "payments",
  description: "the payments service",
  defaultBranch: "main",
  delegates: [OURS],
  threshold: 1,
  visibility: "public",
  allow: [],
  self: { did: OURS, nid: "z6Mkire", alias: "ryph" },
  isDelegate: true,
  isAllowed: true,
  ...over,
});

/** A programmable fake bridge: each test answers the paths it exercises. */
async function fakeBridge() {
  const calls: Array<
    { method: string; path: string; body: unknown; auth: string | null; mode: string | null }
  > = [];
  let respond: (
    method: string,
    path: string,
    body: unknown,
  ) => Response | Promise<Response> | null = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname) + url.search;
    const body = req.body === null ? undefined : await req.json().catch(() => undefined);
    calls.push({
      method: req.method,
      path,
      body,
      auth: req.headers.get("authorization"),
      mode: req.headers.get("x-ryph-radicle-mode"),
    });
    return respond(req.method, path, body) ??
      new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    calls,
    set: (fn: typeof respond) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeApi(base: string, explorerUrl: string | null = null, mode?: "deployment" | "user") {
  return radicleForgeApi({
    baseUrl: base,
    token: TOKEN,
    explorerUrl,
    mode,
    diag: silentDiagnostics(),
  });
}

/** Runs `body` with a fake bridge, and always shuts it down. */
async function withBridge(
  body: (bridge: Awaited<ReturnType<typeof fakeBridge>>, api: ForgeApi) => Promise<void>,
  explorerUrl: string | null = null,
  mode?: "deployment" | "user",
) {
  const bridge = await fakeBridge();
  try {
    await body(bridge, makeApi(bridge.base, explorerUrl, mode));
  } finally {
    await bridge.shutdown();
  }
}

test("every call presents the shared bearer, and a repo that is not a RID never leaves", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json(identityDoc()));
    await api.repoLabels(repo());
    assert(bridge.calls.length > 0);
    for (const call of bridge.calls) assertEquals(call.auth, `Bearer ${TOKEN}`);

    const before = bridge.calls.length;
    const err = await assertRejects(
      () => api.fetchThread(repo("acme/app"), { kind: "issue", ref: ISSUE }),
      ForgeApiError,
    );
    assert(err.terminal, "a repo address that is not a RID is terminal");
    assertEquals(bridge.calls.length, before, "nothing was asked of the bridge");
  });
});

test("every call names the mode this forge was told, and the identity says the bridge's", async () => {
  for (const mode of ["deployment", "user"] as const) {
    await withBridge(
      async (bridge, api) => {
        bridge.set((_m, path) =>
          path === "/v1/identity"
            ? json({ did: OURS, nid: "z6Mk", alias: null, node: null, mode: "user" })
            : json(identityDoc())
        );
        await api.repoLabels(repo());
        const self = await (api as typeof api & RadicleBridgeApi).identity();
        assertEquals(self.mode, "user");
        for (const call of bridge.calls) assertEquals(call.mode, mode);
      },
      null,
      mode,
    );
  }
  // A bridge too old to say is a deployment's.
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ did: OURS, nid: "z6Mk", alias: null, node: null }));
    assertEquals((await (api as typeof api & RadicleBridgeApi).identity()).mode, "deployment");
  });
});

test("admin is delegacy, write is visibility — and an unanswerable read is never a revocation", async () => {
  await withBridge(async (bridge, api) => {
    // A PUBLIC repo is permissionless to contribute to: every peer pushes into its own
    // namespace under its own key, so nobody has to be let in first.
    bridge.set(() => json(identityDoc({ delegates: [THEM] })));
    assertEquals(await api.checkPermission(repo(), OURS, "write"), "allowed");
    assertEquals(await api.checkPermission(repo(), "did:key:zStranger", "write"), "allowed");
    // The subject is not consulted AT ALL on this branch — a caller with no linked Radicle
    // identity passes NULL ("there is no identity"), and "may they contribute to a public
    // repo" is yes for them.
    assertEquals(await api.checkPermission(repo(), null, "write"), "allowed");

    // ADMIN is delegacy, and nothing widens it: the delegates are the keys the canonical refs
    // and the identity document itself are signed against.
    assertEquals(await api.checkPermission(repo(), THEM, "admin"), "allowed");
    assertEquals(await api.checkPermission(repo(), OURS, "admin"), "denied");
    // Nobody holds delegacy anonymously: a null subject is in no set.
    assertEquals(await api.checkPermission(repo(), null, "admin"), "denied");

    // A PRIVATE repo is the one place contributing is gated, because FETCHING is: `allow` is
    // the set of DIDs the node serves it to, so it is the set that can contribute at all.
    // Delegates are in by construction, listed there or not.
    bridge.set(() =>
      json(identityDoc({ visibility: "private", delegates: [THEM], allow: [OURS] }))
    );
    assertEquals(await api.checkPermission(repo(), "did:key:zStranger", "write"), "denied");
    assertEquals(await api.checkPermission(repo(), null, "write"), "denied");
    assertEquals(await api.checkPermission(repo(), OURS, "write"), "allowed");
    assertEquals(await api.checkPermission(repo(), THEM, "write"), "allowed");
    assertEquals(await api.checkPermission(repo(), OURS, "admin"), "denied");

    // A repository this node does not hold says NOTHING about who may write to it: reading a
    // lapsed seed as a revocation would take a deployment's commands down with it. Public's
    // permissive answer is no exception — it is read OUT of an identity document that was
    // never read.
    bridge.set(() => json({ error: "no such repository" }, 404));
    assertEquals(await api.checkPermission(repo(), THEM, "write"), "unknown");
    assertEquals(await api.checkPermission(repo(), THEM, "admin"), "unknown");
    bridge.set(() => json({ error: "boom" }, 500));
    assertEquals(await api.checkPermission(repo(), THEM, "write"), "unknown");
    assertEquals(await api.checkPermission(repo(), THEM, "admin"), "unknown");
  });
});

test("the git door is the upstream, and the bearer is how it is reached", async () => {
  await withBridge(async (bridge, api) => {
    assertEquals(
      api.upstreamUrl(repo(), RID),
      `${bridge.base}/v1/repos/${encodeURIComponent(RID)}/git`,
    );
    assertEquals(await api.fetchAuth(repo(), RID), {
      origin: new URL(bridge.base).origin,
      token: TOKEN,
      // Bearer, not Basic: the bridge's door takes one shared bearer and nothing else, and
      // Basic-framing the same token there is simply a 401.
      scheme: "bearer",
    });
  });
});

test("a progress comment's handle carries its thread, because a Radicle comment has no repo-wide address", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "POST" && path.endsWith(`/issues/${ISSUE}/comments`)) {
        return json({ comment: { id: CHANGE } }, 201);
      }
      if (method === "PATCH" && path.endsWith(`/issues/${ISSUE}/comments/${CHANGE}`)) {
        return json({ comment: { id: CHANGE } });
      }
      if (method === "POST" && path.endsWith(`/comments/${CHANGE}/reactions`)) {
        return json({ reaction: { id: CHANGE } }, 201);
      }
      return null;
    });
    const posted = await api.postComment(repo(), { kind: "issue", ref: ISSUE }, "working on it");
    assertEquals(posted.commentId, `issue:${ISSUE}:${CHANGE}`);

    // The handle is all `updateComment` and `addReaction` are given, and it is enough.
    await api.updateComment(repo(), posted.commentId, "done");
    await api.addReaction(repo(), posted.commentId, "eyes");
    const reaction = bridge.calls.at(-1)!;
    assertEquals(reaction.body, { reaction: "👀" });

    const bad = await assertRejects(
      () => api.updateComment(repo(), "999", "done"),
      ForgeApiError,
    );
    assert(bad.terminal, "a GitHub-shaped comment id names nothing here");
  });
});

test("an issue thread reads as its opening post plus the replies, never the post twice", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path.endsWith(`/issues/${ISSUE}`)) {
        return json({
          issue: {
            id: ISSUE,
            title: "The scheduler test is flaky",
            author: { did: THEM },
            state: "open",
            labels: ["bug"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            body: "It fails one run in five.",
            comments: [
              {
                id: "c0",
                author: { did: THEM },
                body: "It fails one run in five.",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "c1",
                author: { did: OURS },
                body: "/ryph ada look",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
        });
      }
      return null;
    });
    const thread = await api.fetchThread(repo(), { kind: "issue", ref: ISSUE });
    assertEquals(thread.kind, "issue");
    assertEquals(thread.ref, ISSUE);
    assertEquals(thread.body, "It fails one run in five.");
    // The root comment IS the body on Radicle; carrying it again would show the issue twice.
    assertEquals(thread.entries.length, 1);
    assertEquals(thread.entries[0].authorLogin, OURS);
    assertEquals(thread.changeRequest, null);
  });
});

test("a change request's reviews and inline remarks are part of the one conversation", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path === `/v1/repos/${RID}`) return json(identityDoc());
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}`)) {
        return json({
          change: {
            id: CHANGE,
            title: "Fix the scheduler",
            author: { did: OURS },
            state: "open",
            labels: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-03T00:00:00.000Z",
            target: "delegates",
            base: "1".repeat(40),
            head: "2".repeat(40),
            // The author's own latest, under a stranger's revision on top.
            authorHead: "4".repeat(40),
            description: "what it does",
            revisions: [],
            comments: [
              {
                id: "c1",
                author: { did: THEM },
                body: "one thought",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            ],
            reviews: [{
              id: "r1",
              author: { did: THEM },
              revision: "3".repeat(40),
              verdict: "reject",
              summary: "not yet",
              createdAt: "2026-01-03T00:00:00.000Z",
              comments: [{
                id: "rc1",
                author: { did: THEM },
                body: "this line",
                createdAt: "2026-01-03T00:00:01.000Z",
                location: { path: "src/a.ts", line: 12, side: "new" },
              }],
            }],
            files: null,
          },
        });
      }
      return null;
    });
    const thread = await api.fetchThread(repo(), { kind: "change_request", ref: CHANGE });
    assertEquals(thread.entries.map((e) => e.kind), ["comment", "review", "review_comment"]);
    // GitHub's vocabulary for a verdict, because that is the one every consumer already reads.
    assertEquals(thread.entries[1].state, "changes_requested");
    assertEquals(thread.entries[2].location, "src/a.ts:12");
    const head = thread.changeRequest!;
    // A Radicle change request lives in the repository it is against — there is no fork, and
    // its head is exported under `patches/<id>` by the bridge's git door.
    assertEquals(head.headRef, `patches/${CHANGE}`);
    assertEquals(head.headRepoRef, RID);
    assertEquals(head.headSha, "2".repeat(40));
    // What a push event is compared against: the author's latest, not whoever pushed last.
    assertEquals(head.authorHeadSha, "4".repeat(40));
    assertEquals(head.state, "open");
    assertEquals(head.merged, false);
    assertEquals(head.defaultBranch, "main");
  });
});

test("a merged or archived change request is closed, and merged says which", async () => {
  for (const [state, merged] of [["merged", true], ["archived", false]] as const) {
    await withBridge(async (bridge, api) => {
      bridge.set((_m, path) =>
        path === `/v1/repos/${RID}`
          ? json(identityDoc())
          : json({ change: { id: CHANGE, state, head: "2".repeat(40), title: "t" } })
      );
      const head = await api.describeChangeRequest(repo(), CHANGE);
      assertEquals(head.state, "closed");
      assertEquals(head.merged, merged);
    });
  }
});

test("readChangeRequestState: the newest head and the author's, the fate, and whether we opened it", async () => {
  await withBridge(async (bridge, api) => {
    const change = (over: Record<string, unknown>) => ({
      change: {
        id: CHANGE,
        state: "open",
        author: { did: THEM },
        head: "2".repeat(40),
        authorHead: "4".repeat(40),
        title: "t",
        ...over,
      },
    });
    let answer: Record<string, unknown> = change({});
    bridge.set((_m, path) => {
      if (path === `/v1/repos/${RID}`) return json(identityDoc());
      if (path === `/v1/repos/${RID}/changes/${CHANGE}`) return json(answer);
      if (path === `/v1/repos/${RID}/changes/${"9".repeat(40)}`) {
        return json({ error: "the bridge is restarting" }, 503);
      }
      return json({ error: "no such change request" }, 404);
    });

    assertEquals(await api.readChangeRequestState(repo(), CHANGE), {
      ref: CHANGE,
      state: "open",
      merged: false,
      headSha: "2".repeat(40),
      authorHeadSha: "4".repeat(40),
      baseRef: "main",
      openedByUs: false,
      mergedHeads: [],
    });
    // A patch our own node opened; archived is closed, as the thread read has it.
    answer = change({ author: { did: OURS }, state: "archived" });
    const ours = await api.readChangeRequestState(repo(), CHANGE);
    assertEquals([ours?.openedByUs, ours?.state, ours?.merged], [true, "closed", false]);
    // Merged at an OLDER revision: what merged is that revision's commit, never the latest head.
    answer = change({
      state: "merged",
      mergedRevision: { revision: "5".repeat(40), commit: "6".repeat(40) },
      merges: [{ did: THEM, revision: "5".repeat(40), commit: "6".repeat(40) }],
    });
    const merged = await api.readChangeRequestState(repo(), CHANGE);
    assertEquals([merged?.state, merged?.merged], ["closed", true]);
    assertEquals(merged?.headSha, "2".repeat(40));
    assertEquals(merged?.mergedHeads, ["6".repeat(40)]);
    // A state that names no merge: every one recorded, once each; a malformed one is none.
    answer = change({
      state: "merged",
      merges: [
        { did: THEM, revision: "5".repeat(40), commit: "6".repeat(40) },
        { did: OURS, revision: "5".repeat(40), commit: "6".repeat(40) },
        { did: OURS, revision: "5".repeat(40), commit: "not a commit" },
      ],
    });
    assertEquals((await api.readChangeRequestState(repo(), CHANGE))?.mergedHeads, [
      "6".repeat(40),
    ]);
    // More merges than the containment read accepts: the newest twenty.
    const many = Array.from({ length: 25 }, (_, i) => ({
      did: THEM,
      revision: "5".repeat(40),
      commit: i.toString(16).padStart(2, "0").repeat(20),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    answer = change({ state: "merged", merges: many });
    assertEquals(
      (await api.readChangeRequestState(repo(), CHANGE))?.mergedHeads,
      many.slice(5).reverse().map((m) => m.commit),
    );

    assertEquals(await api.readChangeRequestState(repo(), "c".repeat(40)), null);
    const down = await assertRejects(
      () => api.readChangeRequestState(repo(), "9".repeat(40)),
      ForgeApiError,
    );
    assertEquals(down.terminal, false);
  });
});

test("a bridge that sends no author head is said out loud, and reads as no head", async () => {
  const bridge = await fakeBridge();
  const { diag, events } = recordingDiagnostics();
  try {
    const api = radicleForgeApi({ baseUrl: bridge.base, token: TOKEN, explorerUrl: null, diag });
    bridge.set((_m, path) =>
      path === `/v1/repos/${RID}`
        ? json(identityDoc())
        : json({ change: { id: CHANGE, state: "open", head: "2".repeat(40), title: "t" } })
    );
    assertEquals((await api.describeChangeRequest(repo(), CHANGE)).authorHeadSha, "");
    assertEquals((await api.readChangeRequestState(repo(), CHANGE))?.authorHeadSha, "");
    assertEquals(
      events.filter((e) => e.event === "radicle.author_head_missing").map((e) => e.level),
      ["warn", "warn"],
    );
  } finally {
    await bridge.shutdown();
  }
});

test("listings page like the other forge's, and closed change requests are filtered here", async () => {
  await withBridge(async (bridge, api) => {
    const changes = [
      {
        id: "a".repeat(40),
        title: "open one",
        state: "open",
        author: { did: OURS },
        updatedAt: "3",
      },
      {
        id: "b".repeat(40),
        title: "merged one",
        state: "merged",
        author: { did: OURS },
        updatedAt: "2",
      },
      {
        id: "c".repeat(40),
        title: "archived one",
        state: "archived",
        author: { did: THEM },
        updatedAt: "1",
      },
    ];
    bridge.set((method, path) => {
      if (method === "GET" && path.startsWith(`/v1/repos/${RID}/issues?`)) {
        return json({
          issues: [{
            id: ISSUE,
            title: "an issue",
            state: "open",
            author: { did: THEM },
            labels: ["bug"],
            comments: [{ id: "c0" }, { id: "c1" }],
            updatedAt: "2026-01-01T00:00:00.000Z",
          }],
          total: 31,
        });
      }
      if (method === "GET" && path.startsWith(`/v1/repos/${RID}/changes?`)) {
        const state = new URL(`http://x${path}`).searchParams.get("state");
        const wanted = state === null ? changes : changes.filter((c) => c.state === state);
        return json({ changes: wanted, total: wanted.length });
      }
      return null;
    });

    const issues = await api.listIssues(repo(), { state: "open", labels: ["bug"], page: 1 });
    assertEquals(issues.items[0].ref, ISSUE);
    // The root comment is the body, not a reply.
    assertEquals(issues.items[0].comments, 1);
    assert(issues.hasMore, "31 of them, 30 to a page");
    assertStringIncludes(bridge.calls.at(-1)!.path, "label=bug");

    const open = await api.listChangeRequests(repo(), { state: "open", page: 1 });
    assertEquals(open.items.map((c) => c.ref), ["a".repeat(40)]);

    // "closed" is two of Radicle's four states and the bridge filters by exactly one, so the
    // window is walked and filtered on this side.
    const closed = await api.listChangeRequests(repo(), { state: "closed", page: 1 });
    assertEquals(closed.items.map((c) => c.title), ["merged one", "archived one"]);
    assertEquals(closed.hasMore, false);
  });
});

test("labels are what the objects carry, and the answer never claims to be complete", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((_m, path) => {
      if (path.startsWith(`/v1/repos/${RID}/issues`)) {
        return json({ issues: [{ labels: ["bug", "ui"] }], total: 1 });
      }
      return json({ changes: [{ labels: ["ui"] }], total: 1 });
    });
    // Radicle has no label registry: a label is a string an object carries, so a label missing
    // from this answer says nothing about the repository.
    assertEquals(await api.repoLabels(repo()), { labels: ["bug", "ui"], complete: false });
  });
});

test("a thread's kind is probed, change requests first, and two misses are terminal", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((_m, path) => path.includes("/changes/") ? json({ change: { id: CHANGE } }) : null);
    assertEquals(await api.threadKind(repo(), CHANGE), "change_request");

    bridge.set((_m, path) =>
      path.includes("/issues/") ? json({ issue: { id: ISSUE } }) : json({ error: "no" }, 404)
    );
    assertEquals(await api.threadKind(repo(), ISSUE), "issue");

    bridge.set(() => json({ error: "no" }, 404));
    const err = await assertRejects(() => api.threadKind(repo(), ISSUE), ForgeApiError);
    assert(err.terminal);
  });
});

test("a capability the deployment's key does not hold is a refusal the AGENT can read", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() =>
      json({
        error: "forge_capability_unavailable",
        capability: "add_labels",
        reason: `ryph is not a delegate of ${RID}, so it cannot label an issue`,
      }, 403)
    );
    for (
      const act of [
        () => api.addLabels(repo(), { kind: "issue", ref: ISSUE }, ["bug"]),
        () => api.closeIssue(repo(), ISSUE, "completed"),
        () => api.createIssue(repo(), { title: "t", body: "b", labels: ["bug"] }),
      ]
    ) {
      const err = await assertRejects(act, ForgeApiError);
      // Terminal, so it reads to the model as a refusal to act on rather than an outage to
      // retry — and it says what would change the answer.
      assert(err.terminal);
      assertStringIncludes(err.message, "delegate");
      assertStringIncludes(err.message, "Nothing was written");
    }
  });
});

test("a 5xx from the bridge is retryable, a 4xx about the request is not", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ error: "the node is restarting" }, 503));
    const transient = await assertRejects(
      () => api.createComment(repo(), { kind: "issue", ref: ISSUE }, "hi"),
      ForgeApiError,
    );
    assertEquals(transient.terminal, false);

    bridge.set(() => json({ error: `no issue ${ISSUE}` }, 404));
    const gone = await assertRejects(
      () => api.createComment(repo(), { kind: "issue", ref: ISSUE }, "hi"),
      ForgeApiError,
    );
    assertEquals(gone.terminal, true);
  });
});

test("a bridge that is not there is retryable, never a verdict", async () => {
  const api = makeApi("http://127.0.0.1:1");
  const err = await assertRejects(
    () => api.fetchThread(repo(), { kind: "issue", ref: ISSUE }),
    ForgeApiError,
  );
  assertEquals(err.terminal, false);
  assertStringIncludes(err.message, "unreachable");
});

test("a change request's file listing carries the hunks, so a read says where a remark may anchor", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}/diff`)) {
        return json({
          base: "1".repeat(40),
          head: "2".repeat(40),
          complete: true,
          files: [
            { path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
            { path: "logo.png", patch: null },
            // Shown by the diff and missing from the stat — still a changed file.
            { path: "src/extra.ts", patch: "@@ -0,0 +1,2 @@\n+one\n+two" },
          ],
        });
      }
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}`)) {
        return json({
          change: {
            id: CHANGE,
            state: "open",
            head: "2".repeat(40),
            title: "t",
            files: {
              files: [
                { path: "src/a.ts", status: "modified", insertions: 1, deletions: 1 },
                { path: "logo.png", status: "added", insertions: 0, deletions: 0 },
              ],
            },
          },
        });
      }
      return null;
    });

    const files = await api.listChangeRequestFiles(repo(), CHANGE);
    assertEquals(files.hasMore, false);
    assertEquals(files.items, [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      {
        path: "src/extra.ts",
        status: "changed",
        additions: 2,
        deletions: 0,
        patch: "@@ -0,0 +1,2 @@\n+one\n+two",
      },
    ]);
    // Both reads went out together, not one after the other.
    const asked = bridge.calls.map((c) => c.path);
    assert(asked.some((p) => p.endsWith(`/changes/${CHANGE}`)));
    assert(asked.some((p) => p.endsWith(`/changes/${CHANGE}/diff`)));

    // Commits not in storage: the bridge answers no files and "incomplete", and the stat still
    // names every file — with no hunks, which renders as "no diff shown" rather than as a
    // change request that touches nothing.
    bridge.set((method, path) => {
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}/diff`)) {
        return json({ base: "1".repeat(40), head: "2".repeat(40), complete: false, files: [] });
      }
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}`)) {
        return json({
          change: {
            id: CHANGE,
            state: "open",
            head: "2".repeat(40),
            title: "t",
            files: {
              files: [{ path: "src/a.ts", status: "modified", insertions: 1, deletions: 1 }],
            },
          },
        });
      }
      return null;
    });
    const bare = await api.listChangeRequestFiles(repo(), CHANGE);
    assertEquals(bare.items.map((f) => [f.path, f.patch]), [["src/a.ts", null]]);
  });
});

test("a review is checked against the head its remarks were read at, and never carries a verdict", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}/diff`)) {
        return json({
          base: "1".repeat(40),
          head: "2".repeat(40),
          complete: true,
          files: [{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }, {
            path: "logo.png",
            patch: null,
          }],
        });
      }
      if (method === "GET" && path.endsWith(`/changes/${CHANGE}`)) {
        return json({ change: { id: CHANGE, state: "open", head: "2".repeat(40), title: "t" } });
      }
      if (method === "POST" && path.endsWith(`/changes/${CHANGE}/reviews`)) {
        return json({ reviewId: "r1", comments: ["rc1"], edited: false }, 201);
      }
      return null;
    });

    const diff = await api.listChangeRequestPatches(repo(), CHANGE);
    assertEquals(diff.headSha, "2".repeat(40));
    assertEquals(diff.complete, true);
    assertEquals(diff.files[1], { path: "logo.png", patch: null });

    await api.createReview(repo(), CHANGE, {
      body: "looks fine",
      comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "here" }],
      headSha: diff.headSha,
    });
    const posted = bridge.calls.at(-1)!.body as Record<string, unknown>;
    assertEquals(posted.summary, "looks fine");
    assertEquals(posted.remarks, [{ path: "src/a.ts", line: 1, side: "new", body: "here" }]);
    assert(!("verdict" in posted), "a run's review never approves and never blocks a merge");

    // A revision pushed between the check and the write would move the lines under every
    // remark; the head is checked rather than sent, because Radicle anchors to a revision.
    const stale = await assertRejects(
      () =>
        api.createReview(repo(), CHANGE, {
          body: "",
          comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "here" }],
          headSha: "9".repeat(40),
        }),
      ForgeApiError,
    );
    assert(stale.terminal);
    assertStringIncludes(stale.message, "read the diff again");
  });
});

test("an explorer template gives a thread a web address; without one there is none to invent", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ issue: { id: ISSUE } }, 201));
    const opened = await api.createIssue(repo(), { title: "t", body: "b", labels: [] });
    assertEquals(opened.url, `https://app.radicle.xyz/nodes/seed/${RID}/issues/${ISSUE}`);
  }, "https://app.radicle.xyz/nodes/seed/{rid}/{kind}/{id}");

  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ issue: { id: ISSUE } }, 201));
    const opened = await api.createIssue(repo(), { title: "t", body: "b", labels: [] });
    // A private Radicle network has no explorer. "" rather than a fabricated link.
    assertEquals(opened.url, "");
  });

  // A bare origin names no object: rendered, it would give every issue and every patch in every
  // repository the explorer's home page. Ignored, exactly as the bridge ignores it.
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ issue: { id: ISSUE } }, 201));
    const opened = await api.createIssue(repo(), { title: "t", body: "b", labels: [] });
    assertEquals(opened.url, "");
  }, "https://app.radicle.xyz");
});

test("a lost write is looked for on the object it would hang on", async () => {
  const MARKER = "<!-- ryph:action:act-7 -->";
  // A comment that IS there: the write landed and only its response was lost, so the tool
  // surface must report the write rather than let the agent make it twice.
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path === `/v1/repos/${RID}/changes/${CHANGE}`) {
        return json({
          change: {
            id: CHANGE,
            title: "t",
            state: "open",
            comments: [
              { id: "c1", author: { did: THEM }, body: "unrelated", createdAt: "2026-02-01" },
              {
                id: "c2",
                author: { did: OURS },
                body: `done\n\n${MARKER}`,
                createdAt: "2026-02-02",
              },
            ],
          },
        });
      }
      return null;
    });
    assertEquals(
      await api.findMarkedWrite(
        repo(),
        { kind: "comment", threadRef: CHANGE },
        MARKER,
        "2026-01-01",
      ),
      { url: `https://explorer.test/${RID}/patches/${CHANGE}`, createdRef: null },
    );
  }, EXPLORER);

  // And one that is NOT: null, which the caller reads as "you may try again".
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path === `/v1/repos/${RID}/changes/${ISSUE}`) return json({}, 404);
      if (method === "GET" && path === `/v1/repos/${RID}/issues/${ISSUE}`) {
        return json({
          issue: {
            id: ISSUE,
            title: "t",
            state: "open",
            // The first comment IS the issue body; a write of ours is never that, even when
            // the body happens to quote the marker.
            comments: [{ id: "c0", author: { did: THEM }, body: MARKER, createdAt: "2026-02-01" }],
          },
        });
      }
      return null;
    });
    assertEquals(
      await api.findMarkedWrite(
        repo(),
        { kind: "comment", threadRef: ISSUE },
        MARKER,
        "2026-01-01",
      ),
      null,
    );
  });

  // A created issue is found by its BODY, and answers the ref the tool surface reports.
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "GET" && path.startsWith(`/v1/repos/${RID}/issues?`)) {
        return json({
          issues: [
            { id: ISSUE, title: "t", body: `opened\n\n${MARKER}`, createdAt: "2026-02-02" },
          ],
          total: 1,
        });
      }
      return null;
    });
    assertEquals(
      await api.findMarkedWrite(repo(), { kind: "issue" }, MARKER, "2026-01-01"),
      { url: `https://explorer.test/${RID}/issues/${ISSUE}`, createdRef: ISSUE },
    );
  }, EXPLORER);
});

test("a lost write that cannot be LOOKED for throws, and never answers null", async () => {
  // The distinction the tool surface is built on: null means "we looked, nothing is there" and
  // licenses a retry. A bridge that cannot answer must therefore not be able to produce one.
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ error: "the node is down" }, 503));
    const err = await assertRejects(
      () => api.findMarkedWrite(repo(), { kind: "issue" }, "marker", "2026-01-01"),
      ForgeApiError,
    );
    assertEquals(err.terminal, false);
  });
});

test("visibility comes from the identity document, and seeding is the bridge's own surface", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "POST" && path.endsWith("/seed")) return json(identityDoc());
      if (method === "DELETE" && path.endsWith("/seed")) return json({ unseeded: true });
      if (path === "/v1/identity") {
        return json({
          did: OURS,
          nid: "z6Mkire",
          alias: "ryph",
          node: { running: true, sessions: 2 },
        });
      }
      return json(identityDoc({ visibility: "private", allow: [THEM], isAllowed: false }));
    });
    assertEquals(
      await api.repoVisibility(null, [RID]),
      new Map([[RID, wholeRepoVisibility(true)]]),
    );

    const bridgeApi = api as typeof api & RadicleBridgeApi;
    assertEquals((await bridgeApi.identity()).did, OURS);
    const seeded = await bridgeApi.seedRepo(RID);
    assertEquals(seeded.kind, "seeded");
    assertEquals(seeded.kind === "seeded" && seeded.repo.isAllowed, true);
    await bridgeApi.unseedRepo(RID);
  });
});

// The bridge's 409: the policy was written, the node was asked, and the network handed back
// nothing. It is one answer for two situations Radicle cannot tell apart from this side — a
// private repository refuses the fetch at the responding node and is never gossiped, so it
// looks exactly like an id nobody is offering — and it is a VALUE here rather than a throw,
// because the connect flow has something to say about it.
test("a seed the network answered nothing for is an outcome, not a failure", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() =>
      json({
        error: "repo_unavailable",
        rid: RID,
        did: OURS,
        command: `rad id update --allow ${OURS}`,
        seeds: 1,
        triedSeeds: 1,
        reason: "no connected peer answered",
      }, 409)
    );
    const outcome = await (api as typeof api & RadicleBridgeApi).seedRepo(RID);
    assertEquals(outcome, {
      kind: "unavailable",
      rid: RID,
      did: OURS,
      command: `rad id update --allow ${OURS}`,
      seeds: 1,
      triedSeeds: 1,
      reason: "no connected peer answered",
    });
  });

  // Anything else on that route is still a failure, and a 4xx is still terminal.
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ error: "boom" }, 500));
    const err = await assertRejects(
      () => (api as typeof api & RadicleBridgeApi).seedRepo(RID),
      ForgeApiError,
    );
    assert(!err.terminal, "a 500 from the bridge is worth retrying");
  });
});

test("a user-mode bridge's refusal of a blocked repository is an outcome too", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() =>
      json({
        error: "repo_blocked",
        rid: RID,
        command: `rad unblock ${RID}`,
        reason: `your Radicle node blocks ${RID}`,
      }, 409)
    );
    assertEquals(await (api as typeof api & RadicleBridgeApi).seedRepo(RID), {
      kind: "blocked",
      rid: RID,
      command: `rad unblock ${RID}`,
      reason: `your Radicle node blocks ${RID}`,
    });
  });
});

test("the registry hands a rad: repo to Radicle and a GitHub repo to nobody here", async () => {
  await withBridge((bridge, api) => {
    const forges = providerRegistry<ForgeApi>({ radicle: api }, "forge API");
    assertEquals(forges.providers(), ["radicle"]);
    assertEquals(forges.for("radicle"), api);
    assert(!forges.has("github"));
    // A repo naming a provider this deployment does not run is a terminal refusal, never a
    // crash — the caller's retry clock must not read it as an outage.
    const err = assertThrowsForgeApiError(() => forges.for("github"));
    assert(err.terminal);
    return Promise.resolve(void bridge);
  });
});

function assertThrowsForgeApiError(fn: () => unknown): ForgeApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ForgeApiError) return err;
    throw err;
  }
  throw new Error("expected a ForgeApiError");
}

test("a change request is the repo's own branch only when a delegate or our node wrote all of it", async () => {
  const DELEGATE = "did:key:z6MkfLjcGuXNaXm3Qzk4oXBaDPGJwaCj4qc3FbpFbHWqpvUa";
  const change = (author: string, revisions: string[]) => ({
    change: {
      id: CHANGE,
      state: "open",
      head: "2".repeat(40),
      title: "t",
      author: { did: author },
      revisions: revisions.map((did, i) => ({ id: String(i).repeat(40), author: { did } })),
    },
  });
  // Our node is NOT a delegate here: a patch it published counts all the same.
  const doc = identityDoc({ delegates: [DELEGATE], isDelegate: false });
  const cases: Array<[unknown, "branch" | "foreign"]> = [
    [change(DELEGATE, [DELEGATE]), "branch"],
    [change(OURS, [OURS, OURS]), "branch"],
    [change(THEM, [THEM]), "foreign"],
    // A stranger's revision on a delegate's change request could be the head that is served.
    [change(DELEGATE, [DELEGATE, THEM]), "foreign"],
    [{ change: { id: CHANGE, state: "open", title: "t" } }, "foreign"],
  ];
  for (const [answer, expected] of cases) {
    await withBridge(async (bridge, api) => {
      bridge.set((_m, path) => path === `/v1/repos/${RID}` ? json(doc) : json(answer));
      assertEquals(await api.classifyBranch(repo(), `patches/${CHANGE}`), expected);
    });
  }
  // A canonical branch is what the delegates agreed on — the repo's own, with nothing to ask.
  await withBridge(async (bridge, api) => {
    assertEquals(await api.classifyBranch(repo(), "feat/x"), "branch");
    assertEquals(bridge.calls.length, 0);
  });
});

test("a patch answers its REVISIONS, because Radicle keeps no commit list per patch", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((_m, path) =>
      path === `/v1/repos/${RID}` ? json(identityDoc()) : json({
        change: {
          id: CHANGE,
          state: "open",
          title: "Bound the retry queue",
          author: { did: OURS },
          head: "3".repeat(40),
          revisions: [
            {
              id: "1".repeat(40),
              base: "0".repeat(40),
              head: "a".repeat(40),
              author: { did: OURS },
              timestamp: "2026-02-01T09:00:00.000Z",
              description: "Cap the retry queue\n\nand a body.",
            },
            // A later revision usually carries no description of its own: it names itself
            // rather than rendering a line with a hole in it.
            {
              id: "2".repeat(40),
              head: "b".repeat(40),
              author: { did: THEM },
              timestamp: "2026-02-02T09:00:00.000Z",
              description: "",
            },
          ],
        },
      })
    );
    const whole = await api.listChangeRequestCommits(repo(), CHANGE, 50);
    // "revision", never "commit": the rendering says which, and calling one the other would
    // tell an agent it is looking at a history it is not.
    assertEquals(whole.unit, "revision");
    assertEquals(whole.older, 0);
    assertEquals(whole.items.map((c) => c.sha), ["a".repeat(40), "b".repeat(40)]);
    assertEquals(whole.items.map((c) => c.authorLogin), [OURS, THEM]);
    assertEquals(whole.items[0].summary, "Cap the retry queue");
    assertEquals(whole.items[0].revision, { id: "1".repeat(40), base: "0".repeat(40) });
    assertEquals(whole.items[1].summary, `revision ${"2".repeat(12)}`);

    const tail = await api.listChangeRequestCommits(repo(), CHANGE, 1);
    assertEquals(tail.items.map((c) => c.sha), ["b".repeat(40)]);
    assertEquals(tail.older, 1);
  });
});

test("revision comparison goes to storage with explicit revision ids and mode", async () => {
  await withBridge(async (bridge, api) => {
    const expected = {
      from: { id: "1".repeat(40), base: "0".repeat(40), head: "a".repeat(40) },
      to: { id: "2".repeat(40), base: "0".repeat(40), head: "b".repeat(40) },
      mode: "range-diff" as const,
      text: "1: old ! 1: new",
      truncated: false,
    };
    bridge.set((_m, path) => {
      assertStringIncludes(path, `/changes/${CHANGE}/compare?`);
      assertStringIncludes(path, `from=${expected.from.id}`);
      assertStringIncludes(path, `to=${expected.to.id}`);
      assertStringIncludes(path, "mode=range-diff");
      return json(expected);
    });
    assertEquals(
      await api.compareChangeRequest!(repo(), CHANGE, {
        from: expected.from.id,
        to: expected.to.id,
        mode: "range-diff",
      }),
      expected,
    );
  });
});

const HEAD = "c".repeat(40);
const NID_OURS = "z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
const NID_THEM = "z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";

test("CI on Radicle is the job COB: one check per node, its latest run over every job", async () => {
  await withBridge(async (bridge, api) => {
    const run = (
      node: string,
      status: string,
      at: string,
      log = `https://ci.test/${node}/${at}`,
    ) => ({
      node,
      uuid: crypto.randomUUID(),
      log,
      status,
      at,
    });
    bridge.set((method, path) =>
      method === "GET" && path === `/v1/repos/${RID}/jobs?commit=${HEAD}`
        ? json({
          node: NID_OURS,
          jobs: [
            {
              id: "1".repeat(40),
              commit: HEAD,
              runs: [
                run(NID_OURS, "failed", "2026-09-30T10:00:00.000Z"),
                run(NID_THEM, "succeeded", "2026-09-30T10:00:00.000Z"),
              ],
            },
            // A duplicate job for the same commit — a racing node's. Unioned, never a second
            // answer: our re-run on it is the latest thing ryph said.
            {
              id: "2".repeat(40),
              commit: HEAD,
              runs: [run(NID_OURS, "started", "2026-09-30T10:05:00.000Z", "https://ryph.test/r")],
            },
            // A job about another commit is not this commit's, whatever the bridge sent.
            { id: "3".repeat(40), commit: "d".repeat(40), runs: [run(NID_THEM, "failed", "z")] },
          ],
        })
        : null
    );
    const report = await api.readChecks(repo(), HEAD);
    assertEquals(report, {
      kind: "reported",
      headSha: HEAD,
      // Worst first: the one still running, then the pass.
      items: [
        {
          name: "ryph",
          status: "in_progress",
          conclusion: null,
          detailsUrl: "https://ryph.test/r",
        },
        {
          name: `radicle job ${NID_THEM.slice(0, 12)}`,
          status: "completed",
          conclusion: "success",
          detailsUrl: `https://ci.test/${NID_THEM}/2026-09-30T10:00:00.000Z`,
        },
      ],
      cut: 0,
      unlisted: 0,
      partial: null,
    });
  });
});

test("no jobs is 'nothing reported'; a bridge that cannot answer is unavailable, never empty", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ node: NID_OURS, jobs: [] }));
    assertEquals(await api.readChecks(repo(), HEAD), {
      kind: "reported",
      headSha: HEAD,
      items: [],
      cut: 0,
      unlisted: 0,
      partial: null,
    });
    bridge.set(() => json({ error: "internal error" }, 500));
    assertEquals((await api.readChecks(repo(), HEAD)).kind, "unavailable");
  });
  // And a bridge that is not there at all.
  const api = makeApi("http://127.0.0.1:1");
  assertEquals((await api.readChecks(repo(), HEAD)).kind, "unavailable");
});

/** A report of suite `cs-0123456789` generation 2 in `state`. */
const suiteReport = (
  state: string,
  detailsUrl: string | null = "https://ryph.test/checks/cs-0123456789",
) => ({
  headSha: HEAD,
  suiteId: "cs-0123456789",
  generation: 2,
  detailsUrl,
  suite: {
    state: state as "running",
    conclusion: null,
    summary: "",
  },
  checks: [],
});

test("a suite is one job run: started while it runs, finished once it settles", async () => {
  await withBridge(async (bridge, api) => {
    const JOB = "1".repeat(40);
    const UUID = "215e3fbd-0ecf-46b0-ad67-8853b230316b";
    bridge.set((method, path, body) => {
      if (method === "POST" && path === `/v1/repos/${RID}/jobs/runs`) {
        return json({
          jobId: JOB,
          uuid: UUID,
          status: (body as { finish?: string }).finish ?? "started",
          created: true,
          jobCreated: false,
        });
      }
      return null;
    });

    // Running: the run is recorded, nothing is finished. The log is the suite's page, one per
    // GENERATION — the key the bridge finds this run by again.
    assertEquals(await api.reportChecks(repo(), suiteReport("running")), {
      kind: "reported",
      refs: {},
    });
    assertEquals(bridge.calls.map((c) => [c.method, c.path, c.body]), [
      ["POST", `/v1/repos/${RID}/jobs/runs`, {
        commit: HEAD,
        log: "https://ryph.test/checks/cs-0123456789?generation=2",
      }],
    ]);

    // Settled: the same record-or-find, finished in the same call. Succeeded only for "passed".
    for (
      const [state, reason] of [
        ["passed", "succeeded"],
        ["failed", "failed"],
        ["error", "failed"],
      ]
    ) {
      bridge.calls.length = 0;
      await api.reportChecks(repo(), suiteReport(state));
      assertEquals(bridge.calls.map((c) => [c.method, c.path, c.body]), [
        ["POST", `/v1/repos/${RID}/jobs/runs`, {
          commit: HEAD,
          log: "https://ryph.test/checks/cs-0123456789?generation=2",
          finish: reason,
        }],
      ], state);
    }

    // No web address: the run still says whose it is.
    bridge.calls.length = 0;
    await api.reportChecks(repo(), suiteReport("queued", null));
    assertEquals(
      (bridge.calls[0].body as { log: string }).log,
      "urn:ryph:check-suite:cs-0123456789:2",
    );
  });
});

test("a cancelled suite's run is left unfinished, and none is recorded for it", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ recorded: false }));
    assertEquals(await api.reportChecks(repo(), suiteReport("cancelled")), {
      kind: "reported",
      refs: {},
    });
    assertEquals(bridge.calls.map((c) => c.body), [{
      commit: HEAD,
      log: "https://ryph.test/checks/cs-0123456789?generation=2",
      existingOnly: true,
    }]);

    // One that was recorded while it ran is answered as it stands.
    bridge.set(() =>
      json({
        jobId: "1".repeat(40),
        uuid: "u",
        status: "started",
        created: false,
        jobCreated: false,
      })
    );
    assertEquals((await api.reportChecks(repo(), suiteReport("cancelled"))).kind, "reported");
  });
});

test("older generations reported while going are finished in the same call", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((_m, _p, body) =>
      json({
        jobId: "1".repeat(40),
        uuid: "u",
        status: (body as { finish?: string }).finish ?? "started",
        created: true,
        jobCreated: false,
      })
    );
    const report = suiteReport("running");
    await api.reportChecks(repo(), {
      ...report,
      generation: 4,
      // Its own generation, and a later one, are never finished as superseded.
      suite: { ...report.suite, previousGenerations: [1, 3, 3, 4, 5] },
    });
    assertEquals(bridge.calls.map((c) => c.body), [{
      commit: HEAD,
      log: "https://ryph.test/checks/cs-0123456789?generation=4",
      supersedes: [
        "https://ryph.test/checks/cs-0123456789?generation=3",
        "https://ryph.test/checks/cs-0123456789?generation=1",
      ],
    }]);
  });
});

test("ryph's own runs read one check per suite, its newest generation, worst first", async () => {
  await withBridge(async (bridge, api) => {
    const page = "https://ryph.test/checks";
    const ours = (log: string, status: string, at = "2026-09-30T10:00:00.000Z") => ({
      node: NID_OURS,
      uuid: crypto.randomUUID(),
      log,
      status,
      at,
    });
    bridge.set(() =>
      json({
        node: NID_OURS,
        jobs: [{
          id: "1".repeat(40),
          commit: HEAD,
          runs: [
            // Suite A: generation 1 superseded and finished later than generation 2 ran.
            ours(`${page}/cs-a?generation=2`, "succeeded", "2026-09-30T10:00:00.000Z"),
            ours(`${page}/cs-a?generation=1`, "failed", "2026-09-30T10:09:00.000Z"),
            // Suite B, on the same commit, failed: it is not hidden behind suite A's pass.
            ours(`${page}/cs-b?generation=1`, "failed"),
            ours("urn:ryph:check-suite:cs-c:3", "started"),
          ],
        }],
      })
    );
    const report = await api.readChecks(repo(), HEAD);
    assert(report.kind === "reported");
    assertEquals(report.items.map((i) => [i.name, i.conclusion ?? i.status, i.detailsUrl]), [
      ["ryph", "failure", `${page}/cs-b?generation=1`],
      ["ryph", "in_progress", "urn:ryph:check-suite:cs-c:3"],
      ["ryph", "success", `${page}/cs-a?generation=2`],
    ]);
  });
});

test("a commit not on the node yet is retried; a refused report is not; a SHA-256 head never leaves", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set(() => json({ error: `commit ${HEAD} is not in this node's storage` }, 404));
    const missing = await assertRejects(
      () => api.reportChecks(repo(), suiteReport("passed")),
      ForgeApiError,
    );
    assert(!missing.terminal, "the push may still be gossiping in");

    bridge.set(() => json({ error: "log: must be an absolute http(s) or urn URL" }, 400));
    const refused = await assertRejects(
      () => api.reportChecks(repo(), suiteReport("passed")),
      ForgeApiError,
    );
    assert(refused.terminal);

    // A finish the bridge refuses — a verdict already recorded the other way, or a run a
    // duplicate job keeps rad-job from reaching — is terminal too: asking again cannot help.
    bridge.set(() => json({ error: "run already finished as succeeded" }, 409));
    const flipped = await assertRejects(
      () => api.reportChecks(repo(), suiteReport("failed")),
      ForgeApiError,
    );
    assert(flipped.terminal);

    // A 200 whose run does not hold the verdict asked for is not a report that landed.
    bridge.set(() =>
      json({
        jobId: "1".repeat(40),
        uuid: "u",
        status: "started",
        created: false,
        jobCreated: false,
      })
    );
    const unfinished = await assertRejects(
      () => api.reportChecks(repo(), suiteReport("failed")),
      ForgeApiError,
      "not failed",
    );
    assert(unfinished.terminal);

    const before = bridge.calls.length;
    await assertRejects(
      () => api.reportChecks(repo(), { ...suiteReport("passed"), headSha: "e".repeat(64) }),
      ForgeApiError,
    );
    assertEquals(bridge.calls.length, before);
  });
});

test("the history reuses the change the thread read just materialized, not a second GET", async () => {
  await withBridge(async (bridge, api) => {
    const huge = "x".repeat(200_000);
    bridge.set((_m, path) =>
      path === `/v1/repos/${RID}` ? json(identityDoc()) : json({
        change: {
          id: CHANGE,
          state: "open",
          title: "t",
          author: { did: OURS },
          head: "3".repeat(40),
          comments: [],
          reviews: [],
          revisions: [{
            id: "1".repeat(40),
            head: huge,
            // Every one of these is written by whoever pushed the revision, and the rendering
            // spends a fixed budget on the whole change request.
            author: { did: huge },
            timestamp: huge,
            description: huge,
          }],
        },
      })
    );
    await api.fetchThread(repo(), { kind: "change_request", ref: CHANGE });
    const after = bridge.calls.filter((c) => c.path.includes("/changes/")).length;
    const history = await api.listChangeRequestCommits(repo(), CHANGE, 50);
    assertEquals(
      bridge.calls.filter((c) => c.path.includes("/changes/")).length,
      after,
      "the bridge materialized the whole object once; asking again is a round trip for bytes in hand",
    );
    assert(history.items[0].authorLogin.length <= 81);
    assert(history.items[0].sha.length <= 65);
    assert(history.items[0].date.length <= 41);
    assert(history.items[0].summary.length <= 200);

    // The submit path's own look is NOT served from it: a stale change request there is a push
    // this deployment cannot see, on a branch it is about to write to.
    const before = bridge.calls.length;
    await api.describeChangeRequest(repo(), CHANGE);
    assert(bridge.calls.length > before, "describeChangeRequest always asks");
  });
});

test("a body's embeds ride the write as {name, data}, and a write without any carries none", async () => {
  await withBridge(async (bridge, api) => {
    bridge.set((method, path) => {
      if (method === "POST" && path.endsWith("/comments")) {
        return json({ comment: { id: "c1" } }, 201);
      }
      if (method === "PATCH") return json({ comment: { id: "c2" } });
      if (method === "POST" && path.endsWith("/issues")) return json({ issue: { id: ISSUE } }, 201);
      if (method === "GET") {
        return json({ change: { id: CHANGE, state: "open", head: "2".repeat(40), title: "t" } });
      }
      if (path.endsWith("/reviews")) {
        return json({ reviewId: "r1", comments: [], edited: false }, 201);
      }
      return null;
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const embeds = [{ name: "img-3f9a1c0b2d4e.png", oid: "e".repeat(40), bytes }];
    const wire = [{ name: "img-3f9a1c0b2d4e.png", data: bytes.toBase64() }];

    await api.createComment(
      repo(),
      { kind: "issue", ref: ISSUE },
      `[x](${"e".repeat(40)})`,
      embeds,
    );
    assertEquals(bridge.calls.at(-1)!.body, { body: `[x](${"e".repeat(40)})`, embeds: wire });
    const posted = await api.postComment(repo(), { kind: "issue", ref: ISSUE }, "status", embeds);
    assertEquals((bridge.calls.at(-1)!.body as Record<string, unknown>).embeds, wire);
    await api.updateComment(repo(), posted.commentId, "status, edited", embeds);
    assertEquals(bridge.calls.at(-1)!.method, "PATCH");
    assertEquals((bridge.calls.at(-1)!.body as Record<string, unknown>).embeds, wire);
    await api.createIssue(repo(), { title: "t", body: "b", labels: [], embeds });
    assertEquals((bridge.calls.at(-1)!.body as Record<string, unknown>).embeds, wire);
    await api.createReview(repo(), CHANGE, { body: "see", embeds, comments: [], headSha: null });
    assertEquals((bridge.calls.at(-1)!.body as Record<string, unknown>).summaryEmbeds, wire);

    await api.createComment(repo(), { kind: "issue", ref: ISSUE }, "plain");
    assertEquals(bridge.calls.at(-1)!.body, { body: "plain" });
  });
});
