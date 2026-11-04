// A thread named the way a person writes it — GitLab's `!1` / `#3`, a bare number, GitHub's
// `#12`, a Radicle COB-id prefix — reaches the control plane's ledger in the ONE spelling it
// records, for every write tool. Driven through the real HTTP grants adapter against a stand-in
// that holds each body to the orchestrator's own reserve schema, as the live route does: a
// shorthand forwarded as typed was a 400 there, and every such write failed.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { ForgeToolActionReserveSchema } from "../../orchestrator/src/schema.ts";
import { httpToolGrants } from "../src/adapters/tool_grants/http.ts";
import { parseThreadSpelling } from "../src/adapters/forge_api/gitlab_client.ts";
import { makeToolService, type ToolRequest } from "../src/core/tool_service.ts";
import type { ForgeProvider, ToolGrant } from "../src/core/types.ts";
import {
  type ForgeApi,
  ForgeApiError,
  providerRegistry,
  wholeRepoVisibility,
} from "../src/ports/forge_api.ts";
import { silentDiagnostics } from "./util.ts";

const RUN = "r-0123456789";
const REPO = "cr-0123456789";
const COB = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function grantFor(provider: ForgeProvider, repoRef: string, originRef: string): ToolGrant {
  return {
    runId: RUN,
    repos: [{
      connectedRepoId: REPO,
      provider,
      repoRef,
      tenantId: provider === "github" ? "7" : null,
      ...(provider === "gitlab" ? { forgeId: "42@https://gitlab.test" } : {}),
    }],
    sourceRepos: [],
    origin: { connectedRepoId: REPO, kind: "change_request", ref: originRef },
    opened: [],
    capabilities: {
      read: true,
      createIssues: null,
      comment: { where: "any", max: 50 },
      review: { where: "origin", max: 50 },
      closeIssues: { where: "any", max: 50 },
      labels: ["bug"],
    },
    provenance: {
      agentName: "Ada",
      runUrl: "https://ryph.test/tasks/t-1",
      requestedBy: "grace",
      requestedVia: null,
    },
  };
}

/** GitLab's number spaces as this test sets them: issues 3 and 5, merge requests 1 and 5. */
const ISSUES = new Set([3, 5]);
const MRS = new Set([1, 5]);

/** A forge that answers like the provider it stands in for, and records the thread every write
 * was made on. */
function fakeForge(provider: ForgeProvider) {
  const writes: Array<{ tool: string; ref: string }> = [];
  const threadKind = (ref: string): "issue" | "change_request" => {
    if (provider !== "gitlab") return /^(1|12|a1b2)/.test(ref) ? "change_request" : "issue";
    const parsed = parseThreadSpelling(ref);
    if (parsed === null) throw new ForgeApiError(`${ref} is not a GitLab thread`, true);
    if (!("bare" in parsed)) return parsed.kind;
    const n = parsed.bare;
    if (ISSUES.has(n) && MRS.has(n)) {
      throw new ForgeApiError(
        `${n} names both issue #${n} and merge request !${n} — say which`,
        true,
      );
    }
    if (ISSUES.has(n)) return "issue";
    if (MRS.has(n)) return "change_request";
    throw new ForgeApiError(`there is no issue or merge request ${n}`, true);
  };
  const api = {
    threadKind: (_repo: unknown, ref: string) => Promise.resolve().then(() => threadKind(ref)),
    repoVisibility: (_t: unknown, refs: string[]) =>
      Promise.resolve(new Map(refs.map((r) => [r, wholeRepoVisibility(false)]))),
    repoLabels: () => Promise.resolve({ labels: ["bug"], complete: true }),
    createComment(_repo: unknown, thread: { ref: string }) {
      writes.push({ tool: "add_comment", ref: thread.ref });
      return Promise.resolve({ url: "https://forge.test/c" });
    },
    replyToReviewComment(_repo: unknown, ref: string) {
      writes.push({ tool: "reply", ref });
      return Promise.resolve({ url: "https://forge.test/r" });
    },
    resolveReviewThread: () => Promise.resolve(),
    addLabels(_repo: unknown, thread: { ref: string }) {
      writes.push({ tool: "add_labels", ref: thread.ref });
      return Promise.resolve({ url: "https://forge.test/l" });
    },
    createReview(_repo: unknown, ref: string) {
      writes.push({ tool: "submit_review", ref });
      return Promise.resolve({ url: "https://forge.test/v" });
    },
    closeIssue(_repo: unknown, ref: string) {
      writes.push({ tool: "close_issue", ref });
      return Promise.resolve({ url: "https://forge.test/x" });
    },
    listChangeRequestPatches: () =>
      Promise.resolve({ files: [], complete: true, headSha: "c".repeat(40) }),
  } as unknown as ForgeApi;
  return { api, writes };
}

/** An orchestrator stand-in holding every reserve to the real schema; `answer` overrides. */
async function withWorld(
  provider: ForgeProvider,
  grant: ToolGrant,
  body: (w: {
    call(request: ToolRequest): Promise<{ ok: boolean; text: string }>;
    reserved: Array<{ tool: string; threadRef: string | null }>;
    writes: Array<{ tool: string; ref: string }>;
  }) => Promise<void>,
  answer?: (path: string) => Response | null,
) {
  const reserved: Array<{ tool: string; threadRef: string | null }> = [];
  let actions = 0;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const json = await req.json();
    const override = answer?.(path) ?? null;
    if (override !== null) return override;
    if (path === "/v1/forge/tool-grants/resolve") return Response.json(grant);
    if (path === "/v1/forge/tool-actions") {
      const parsed = ForgeToolActionReserveSchema.safeParse(json);
      if (!parsed.success) {
        return Response.json({ error: "threadRef: not a thread reference" }, { status: 400 });
      }
      reserved.push({ tool: parsed.data.tool, threadRef: parsed.data.threadRef });
      return Response.json({ actionId: `fa-${String(++actions).padStart(10, "0")}` }, {
        status: 201,
      });
    }
    if (path.startsWith("/v1/forge/tool-actions/")) return Response.json({});
    return new Response(null, { status: 404 });
  });
  const forge = fakeForge(provider);
  try {
    const service = makeToolService({
      grants: httpToolGrants({
        orchestratorUrl: `http://127.0.0.1:${server.addr.port}`,
        forgeToken: "t",
        diag: silentDiagnostics(),
        cacheTtlMs: 0,
      }),
      forges: providerRegistry({ [provider]: forge.api }, "forge API"),
      diag: silentDiagnostics(),
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });
    await body({
      call: (request) => service.call(RUN, request),
      reserved,
      writes: forge.writes,
    });
  } finally {
    await server.shutdown();
  }
}

/** Every write tool on `thread`, as `kind` decides which apply. */
function writesOn(repo: string, thread: string, kind: "issue" | "change_request"): ToolRequest[] {
  const comment: ToolRequest = {
    tool: "add_comment",
    repo,
    thread,
    body: "Seen.",
    resolve: false,
  };
  const labels: ToolRequest = { tool: "add_labels", repo, thread, labels: ["bug"] };
  return kind === "change_request"
    ? [
      comment,
      labels,
      { tool: "submit_review", repo, thread, body: "Looks right.", comments: [] },
      {
        tool: "add_comment",
        repo,
        thread,
        body: "Done.",
        replyTo: `${thread}:d1:9`,
        resolve: true,
      },
    ]
    : [
      comment,
      labels,
      { tool: "close_issue", repo, thread, reason: "completed", comment: "Fixed." },
    ];
}

test("GitLab: !1, #3, a bare number and the recorded spelling all reserve as mr-N / issue-N", async () => {
  const cases: Array<[string, "issue" | "change_request", string]> = [
    ["!1", "change_request", "mr-1"],
    ["mr-1", "change_request", "mr-1"],
    ["1", "change_request", "mr-1"],
    ["#3", "issue", "issue-3"],
    ["issue-3", "issue", "issue-3"],
    ["3", "issue", "issue-3"],
  ];
  for (const [spelled, kind, recorded] of cases) {
    await withWorld("gitlab", grantFor("gitlab", "acme/widgets", "mr-1"), async (w) => {
      const requests = writesOn("acme/widgets", spelled, kind);
      for (const request of requests) {
        const answer = await w.call(request);
        assert(answer.ok, `${request.tool} on ${spelled}: ${answer.text}`);
      }
      assert(w.reserved.length >= requests.length, `${spelled}: every write reserved`);
      assert(
        w.reserved.every((r) => r.threadRef === recorded),
        `${spelled}: ${JSON.stringify(w.reserved)}`,
      );
      assert(w.writes.every((x) => x.ref === recorded), `${spelled}: ${JSON.stringify(w.writes)}`);
    });
  }
});

test("GitLab: a bare number naming both, or neither, is refused by name and nothing is reserved", async () => {
  await withWorld("gitlab", grantFor("gitlab", "acme/widgets", "mr-1"), async (w) => {
    const both = await w.call({
      tool: "add_comment",
      repo: "acme/widgets",
      thread: "5",
      body: "Which?",
      resolve: false,
    });
    assert(!both.ok);
    assertStringIncludes(both.text, "names both issue #5 and merge request !5");
    const neither = await w.call({
      tool: "submit_review",
      repo: "acme/widgets",
      thread: "9",
      body: "?",
      comments: [],
    });
    assert(!neither.ok);
    assertStringIncludes(neither.text, "no issue or merge request 9");
    assertEquals(w.reserved, []);
    assertEquals(w.writes, []);
  });
});

test("GitLab: a bare number is held to the grant by the thread it resolves to, and named so", async () => {
  await withWorld("gitlab", grantFor("gitlab", "acme/widgets", "mr-1"), async (w) => {
    // 3 is an issue: not the origin, so the review is refused as one — by its recorded name.
    const issue = await w.call({
      tool: "submit_review",
      repo: "acme/widgets",
      thread: "3",
      body: "?",
      comments: [],
    });
    assert(!issue.ok);
    assertStringIncludes(issue.text, "issue-3");
    assertEquals(w.reserved, []);
  });
});

test("GitHub: #12 reserves as 12", async () => {
  await withWorld("github", grantFor("github", "acme/api", "12"), async (w) => {
    for (const request of writesOn("acme/api", "#12", "change_request")) {
      const answer = await w.call(request);
      assert(answer.ok, `${request.tool}: ${answer.text}`);
    }
    assert(w.reserved.length > 0 && w.reserved.every((r) => r.threadRef === "12"));
    assert(w.writes.every((x) => x.ref === "12"));
  });
});

test("Radicle: a COB-id prefix of the run's own thread reserves as its full id", async () => {
  await withWorld(
    "radicle",
    grantFor("radicle", "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5", COB),
    async (w) => {
      const answer = await w.call({
        tool: "submit_review",
        repo: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
        thread: "a1b2c3d",
        body: "Fine.",
        comments: [],
      });
      assert(answer.ok, answer.text);
      assertEquals(w.reserved, [{ tool: "submit_review", threadRef: COB }]);
      assertEquals(w.writes, [{ tool: "submit_review", ref: COB }]);
    },
  );
});

test("a reserve the control plane answers 400 is its refusal, not an outage; a 503 is an outage", async () => {
  const grant = grantFor("gitlab", "acme/widgets", "mr-1");
  const comment: ToolRequest = {
    tool: "add_comment",
    repo: "acme/widgets",
    thread: "!1",
    body: "Hi.",
    resolve: false,
  };
  await withWorld(
    "gitlab",
    grant,
    async (w) => {
      const answer = await w.call(comment);
      assert(!answer.ok);
      assertStringIncludes(
        answer.text,
        "The control plane refused to record this write (threadRef: not a thread reference)",
      );
      assert(!answer.text.includes("could not reach"), answer.text);
      assertEquals(w.writes, []);
    },
    (path) =>
      path === "/v1/forge/tool-actions"
        ? Response.json({ error: "threadRef: not a thread reference" }, { status: 400 })
        : null,
  );
  await withWorld("gitlab", grant, async (w) => {
    const answer = await w.call(comment);
    assert(!answer.ok);
    assertStringIncludes(answer.text, "could not reach the control plane to record this write");
    assertEquals(w.writes, []);
  }, (path) => path === "/v1/forge/tool-actions" ? new Response("down", { status: 503 }) : null);
});

test("a grant lookup the control plane answers 4xx is its refusal, not an outage", async () => {
  await withWorld(
    "gitlab",
    grantFor("gitlab", "acme/widgets", "mr-1"),
    async (w) => {
      const answer = await w.call({
        tool: "add_comment",
        repo: "acme/widgets",
        thread: "!1",
        body: "Hi.",
        resolve: false,
      });
      assert(!answer.ok);
      assertStringIncludes(answer.text, "The control plane refused to look up this run's access");
      assertStringIncludes(answer.text, "unauthorized");
      assert(!answer.text.includes("could not reach"), answer.text);
    },
    (path) =>
      path === "/v1/forge/tool-grants/resolve"
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : null,
  );
});
