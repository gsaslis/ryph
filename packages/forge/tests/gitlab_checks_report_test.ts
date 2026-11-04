// ryph's checks on GitLab: commit statuses named `ryph / <name>`, idempotent by GitLab's own
// state machine — and CI read back from the same channel, worst first, honest about what GitLab
// did not list.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { gitlabForgeApi } from "../src/adapters/forge_api/gitlab.ts";
import { type CheckReport, type CheckRunReport, ForgeApiError } from "../src/ports/forge_api.ts";
import { GITLAB_TOKEN_NAMES, staticUserToken } from "../src/helpers/user_token.ts";
import { silentDiagnostics } from "./util.ts";
import { gitlabProjectRef } from "../src/gitlab_account.ts";

const TOKEN = "glpat-checksToken0000001";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const P = "42"; // `acme/app`'s id
/** The project, by its id on the instance under test, which `makeApi` sets. */
const repo = { repoRef: "acme/app", tenantId: null, forgeId: "" };

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

async function fakeGitlab() {
  const calls: Call[] = [];
  let respond: (call: Call) => Response | null = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v4/, "") + url.search;
    if (path === "/user") return Response.json({ id: 9, username: "ryph-bot" });
    if (path === "/version") return Response.json({ version: "17.4.0" });
    if (path === "/personal_access_tokens/self") {
      return Response.json({ scopes: ["api", "read_repository", "write_repository"] });
    }
    const call = { method: req.method, path, body: await req.json().catch(() => ({})) };
    calls.push(call);
    return respond(call) ?? Response.json({ message: "404 Project Not Found" }, { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    calls,
    set: (fn: (call: Call) => Response | null) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

const makeApi = (base: string) => {
  repo.forgeId = gitlabProjectRef(base, P);
  return gitlabForgeApi({
    mode: "bot",
    url: base,
    token: staticUserToken(TOKEN, GITLAB_TOKEN_NAMES),
    webhookSecret: null,
    oauth: null,
    group: null,
    diag: silentDiagnostics(),
  });
};

const check = (name: string, over: Partial<CheckRunReport> = {}): CheckRunReport => ({
  name,
  status: "queued",
  conclusion: null,
  title: `${name}: queued`,
  summary: "long markdown that a status cannot carry",
  startedAt: null,
  completedAt: null,
  externalId: `cs-0123456789:1:${name}`,
  forgeRef: null,
  ...over,
});

const report = (
  checks: CheckRunReport[],
  detailsUrl: string | null = "https://ryph.example/checks/cs-0123456789",
): CheckReport => ({
  headSha: HEAD,
  suiteId: "cs-0123456789",
  generation: 1,
  detailsUrl,
  suite: { state: "running", conclusion: null, summary: "" },
  checks,
});

/** Statuses accept every post and answer an id. */
const accepting = () => {
  let id = 100;
  return ({ method }: Call) =>
    method === "POST" ? Response.json({ id: ++id, status: "pending" }, { status: 201 }) : null;
};

// ---- reporting ------------------------------------------------------------------------------

test("a report posts one status per check, `ryph / <name>`, pointing at the suite page", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(accepting());
    const out = await api.reportChecks(repo, report([check("lint"), check("test")]));
    assertEquals(out, { kind: "reported", refs: { lint: "101", test: "102" } });
    assertEquals(gl.calls.map((c) => `${c.method} ${c.path}`), [
      `POST /projects/${P}/statuses/${HEAD}`,
      `POST /projects/${P}/statuses/${HEAD}`,
    ]);
    assertEquals(gl.calls[0].body, {
      state: "pending",
      name: "ryph / lint",
      target_url: "https://ryph.example/checks/cs-0123456789",
      description: "lint: queued",
    });
    // The summary has no place on a status: it lives on the suite page.
    assert(!JSON.stringify(gl.calls[0].body).includes("long markdown"));
  } finally {
    await gl.shutdown();
  }
});

test("every lifecycle and verdict maps onto a GitLab state that gates a merge the same way", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(accepting());
    const cases: Array<[Partial<CheckRunReport>, string]> = [
      [{ status: "queued" }, "pending"],
      [{ status: "in_progress" }, "running"],
      [{ status: "completed", conclusion: "success" }, "success"],
      [{ status: "completed", conclusion: "neutral" }, "success"],
      [{ status: "completed", conclusion: "failure" }, "failed"],
      [{ status: "completed", conclusion: "timed_out" }, "failed"],
      [{ status: "completed", conclusion: "action_required" }, "failed"],
      [{ status: "completed", conclusion: null }, "failed"],
      [{ status: "completed", conclusion: "cancelled" }, "canceled"],
    ];
    await api.reportChecks(repo, report(cases.map(([over], i) => check(`c${i}`, over)), null));
    assertEquals(gl.calls.map((c) => c.body.state), cases.map(([, state]) => state));
    // No suite page: no target_url at all, never an empty one.
    assert(!("target_url" in gl.calls[0].body));
  } finally {
    await gl.shutdown();
  }
});

test("a title past GitLab's 255 is clipped, never refused", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(accepting());
    await api.reportChecks(repo, report([check("lint", { title: "x".repeat(400) })]));
    assert(String(gl.calls[0].body.description).length <= 255);
  } finally {
    await gl.shutdown();
  }
});

test("a status already standing is success — GitLab's refused transition is a converged retry", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(() =>
      Response.json({
        message:
          `Cannot transition status via :run from :running (Reason(s): Status cannot transition via "run")`,
      }, { status: 400 })
    );
    const out = await api.reportChecks(
      repo,
      report([
        check("lint", { status: "in_progress", forgeRef: "55" }),
        check("test", { status: "in_progress" }),
      ]),
    );
    assertEquals(out, { kind: "reported", refs: { lint: "55" } });
  } finally {
    await gl.shutdown();
  }
});

test("a head GitLab finds no ref of its own for rides its merge request's head ref", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    let id = 300;
    gl.set(({ method, path, body }) => {
      if (method === "GET" && path === `/projects/${P}/repository/commits/${HEAD}/merge_requests`) {
        return Response.json([
          { iid: 3, state: "merged", sha: "f".repeat(40) },
          { iid: 7, state: "opened", sha: HEAD },
        ]);
      }
      if (method !== "POST") return null;
      // GitLab 17.11's answers for a commit no branch of the project holds, and for one only a
      // protected branch holds, to a Developer.
      if (body.ref === undefined && body.name === "ryph / lint") {
        return Response.json({ message: "404 References for commit Not Found" }, { status: 404 });
      }
      if (body.ref === undefined) {
        return Response.json({ message: "403 Forbidden" }, { status: 403 });
      }
      return Response.json({ id: ++id, status: "pending" }, { status: 201 });
    });
    const out = await api.reportChecks(repo, report([check("lint"), check("test")]));
    assertEquals(out, { kind: "reported", refs: { lint: "301", test: "302" } });
    // One lookup for the whole report; every post after it names the ref.
    assertEquals(gl.calls.filter((c) => c.method === "GET").length, 1);
    assertEquals(
      gl.calls.filter((c) => c.method === "POST").map((c) => c.body.ref ?? null),
      [null, "refs/merge-requests/7/head", null, "refs/merge-requests/7/head"],
    );

    // No merge request has it as its head: the 404 stands, worth asking about again.
    gl.set(({ method }) =>
      method === "GET"
        ? Response.json([])
        : Response.json({ message: "404 References for commit Not Found" }, { status: 404 })
    );
    const err = await assertRejects(
      () => api.reportChecks(repo, report([check("lint")])),
      ForgeApiError,
    );
    assert(!err.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("an account that may not post statuses is unsupported, and the rest is not attempted", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(() => Response.json({ message: "403 Forbidden" }, { status: 403 }));
    const out = await api.reportChecks(repo, report([check("lint"), check("test")]));
    assertEquals(out.kind, "unsupported");
    assert(out.kind === "unsupported");
    assertStringIncludes(out.reason, "Developer");
    // One post, and one look for a merge request whose head ref it might ride.
    assertEquals(gl.calls.map((c) => c.method), ["POST", "GET"]);
  } finally {
    await gl.shutdown();
  }
});

test("a commit GitLab has not seen yet is worth asking about again; a gone project is not", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(() => Response.json({ message: "404 Commit Not Found" }, { status: 404 }));
    const unseen = await assertRejects(
      () => api.reportChecks(repo, report([check("lint")])),
      ForgeApiError,
    );
    assert(!unseen.terminal);
    gl.set(() => null); // 404 Project Not Found
    const gone = await assertRejects(
      () => api.reportChecks(repo, report([check("lint")])),
      ForgeApiError,
    );
    assert(gone.terminal);
    gl.set(() => Response.json({ message: "x" }, { status: 502 }));
    const flaky = await assertRejects(
      () => api.reportChecks(repo, report([check("lint")])),
      ForgeApiError,
    );
    assert(!flaky.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("an empty report posts nothing, and a repo naming a tenant is refused terminally", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    assertEquals(await api.reportChecks(repo, report([])), { kind: "reported", refs: {} });
    const err = await assertRejects(
      () => api.reportChecks({ repoRef: "acme/app", tenantId: "1" }, report([check("x")])),
      ForgeApiError,
    );
    assert(err.terminal);
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

// ---- reading --------------------------------------------------------------------------------

const status = (name: string, s: string, extra: Record<string, unknown> = {}) => ({
  name,
  status: s,
  target_url: `https://ci/${name}`,
  ...extra,
});

test("CI is read from the commit's statuses, each mapped to a lifecycle and a verdict", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(({ path }) =>
      path === `/projects/${P}/repository/commits/${HEAD}/statuses?per_page=100&page=1`
        ? Response.json([
          status("build", "success"),
          status("lint", "failed", { allow_failure: true }),
          status("test", "failed"),
          status("deploy", "manual"),
          status("e2e", "running"),
          status("pages", "created"),
          status("docs", "skipped"),
          status("old", "canceled"),
        ], { headers: { "x-total": "8" } })
        : null
    );
    const out = await api.readChecks(repo, HEAD);
    assert(out.kind === "reported");
    assertEquals(out.partial, null);
    assertEquals(out.unlisted, 0);
    assertEquals(out.cut, 0);
    const by = Object.fromEntries(out.items.map((c) => [c.name, [c.status, c.conclusion]]));
    assertEquals(by, {
      build: ["completed", "success"],
      lint: ["completed", "neutral"],
      test: ["completed", "failure"],
      deploy: ["completed", "action_required"],
      e2e: ["in_progress", null],
      pages: ["queued", null],
      docs: ["completed", "skipped"],
      old: ["completed", "cancelled"],
    });
    // Worst first: the failing ones lead.
    assertEquals(out.items.slice(0, 2).map((c) => c.name).sort(), ["deploy", "test"]);
    assertEquals(out.items[0].detailsUrl?.startsWith("https://ci/"), true);
  } finally {
    await gl.shutdown();
  }
});

test("checks are ordered worst first BEFORE the cut, and what GitLab never listed is its own count", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    const listed = [
      ...Array.from({ length: 60 }, (_, i) => status(`ok${i}`, "success")),
      status("red", "failed"),
    ];
    gl.set(() => Response.json(listed, { headers: { "x-total": "75" } }));
    const out = await api.readChecks(repo, HEAD);
    assert(out.kind === "reported");
    assertEquals(out.items[0].name, "red");
    assertEquals(out.items.length, 50);
    assertEquals(out.cut, 11);
    assertEquals(out.unlisted, 14);
    // No total said: nothing is assumed about the rest.
    gl.set(() => Response.json([status("a", "success")]));
    const silent = await api.readChecks(repo, HEAD);
    assert(silent.kind === "reported");
    assertEquals(silent.unlisted, 0);
  } finally {
    await gl.shutdown();
  }
});

test("CI that may not be read, or would not answer, is said — and a dated limit carries when", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(() => Response.json({ message: "403 Forbidden" }, { status: 403 }));
    const refused = await api.readChecks(repo, HEAD);
    assertEquals(refused.kind, "unavailable");

    gl.set(() => Response.json({ message: "x" }, { status: 503 }));
    const down = await api.readChecks(repo, HEAD);
    assert(down.kind === "unavailable");
    assertStringIncludes(down.reason, "503");

    gl.set(() =>
      Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "60" } })
    );
    const limited = await api.readChecks(repo, HEAD);
    assert(limited.kind === "unavailable");
    assertEquals(limited.retryAfterMs, 60_000);
  } finally {
    await gl.shutdown();
  }
});

test("every forge-authored string is clamped at the boundary", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await makeApi(gl.base);
    gl.set(() =>
      Response.json([{ name: "n".repeat(5_000), status: "success", target_url: "u".repeat(5_000) }])
    );
    const out = await api.readChecks(repo, HEAD);
    assert(out.kind === "reported");
    assert(out.items[0].name.length <= 121);
    assert((out.items[0].detailsUrl ?? "").length <= 501);
  } finally {
    await gl.shutdown();
  }
});
