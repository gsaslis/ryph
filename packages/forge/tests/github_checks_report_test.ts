// Posting ryph's check suite as GitHub check runs, against a fake GitHub server: created as the
// App under a token narrowed to `checks: write`, updated by ref, adopted by external id when a
// response was lost, and an installation without the permission answered as `unsupported`
// rather than retried forever.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { githubForgeApi } from "../src/adapters/forge_api/github.ts";
import { type CheckReport, type CheckRunReport, ForgeApiError } from "../src/ports/forge_api.ts";
import { silentDiagnostics } from "./util.ts";

const APP_ID = "999";
const HEAD = "c".repeat(40);
const repo = { repoRef: "acme/app", tenantId: "42" };

async function testKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

interface Call {
  method: string;
  path: string;
  // oxlint-disable-next-line no-explicit-any
  body: any;
}

/** A GitHub answer forced onto one route. */
interface Forced {
  status: number;
  message: string;
}

/** A fake GitHub holding check runs in memory. `mintStatus` refuses the token mint when set;
 * `list` and `post` force the answer of the run listing and of posting a run. */
async function fakeGithub(
  opts: {
    mintStatus?: number;
    runs?: Array<Record<string, unknown>>;
    list?: Forced;
    post?: Forced;
  } = {},
) {
  const calls: Call[] = [];
  const runs: Array<Record<string, unknown>> = opts.runs ?? [];
  let nextId = 5000;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const body = req.body === null ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path, body });
    const answer = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status });
    if (req.method === "POST" && url.pathname.endsWith("/access_tokens")) {
      if (opts.mintStatus !== undefined) {
        return answer(opts.mintStatus, {
          message: "The permissions requested are not granted to this installation.",
        });
      }
      return answer(201, { token: "ghs_checks", expires_at: null });
    }
    if (req.method === "GET" && url.pathname === `/repos/acme/app/commits/${HEAD}/check-runs`) {
      if (opts.list !== undefined) return answer(opts.list.status, { message: opts.list.message });
      return answer(200, { total_count: runs.length, check_runs: runs });
    }
    if (req.method === "POST" && url.pathname === "/repos/acme/app/check-runs") {
      if (opts.post !== undefined) return answer(opts.post.status, { message: opts.post.message });
      const run = { id: nextId++, app: { id: Number(APP_ID) }, ...body };
      runs.push(run);
      return answer(201, run);
    }
    const patch = url.pathname.match(/^\/repos\/acme\/app\/check-runs\/(\d+)$/);
    if (req.method === "PATCH" && patch) {
      const run = runs.find((r) => String(r.id) === patch[1]);
      if (run === undefined) return answer(404, { message: "Not Found" });
      Object.assign(run, body);
      return answer(200, run);
    }
    return answer(404, { message: "not found" });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    calls,
    runs,
    shutdown: () => server.shutdown(),
  };
}

async function makeApi(base: string) {
  return await githubForgeApi({
    appId: APP_ID,
    privateKeyPem: await testKeyPem(),
    oauth: { clientId: "Iv1.client", clientSecret: "shhh" },
    apiBase: base,
    oauthBase: base,
    diag: silentDiagnostics(),
  });
}

function check(name: string, over: Partial<CheckRunReport> = {}): CheckRunReport {
  return {
    name,
    status: "queued",
    conclusion: null,
    title: `${name}: queued`,
    summary: "The commands `.ryph/checks.yml` declares at the base commit …",
    startedAt: null,
    completedAt: null,
    externalId: `cs-0123456789:1:${name}`,
    forgeRef: null,
    ...over,
  };
}

function report(checks: CheckRunReport[], over: Partial<CheckReport> = {}): CheckReport {
  return {
    headSha: HEAD,
    suiteId: "cs-0123456789",
    generation: 1,
    detailsUrl: "https://ryph.example/checks/cs-0123456789",
    suite: { state: "queued", conclusion: null, summary: "queued" },
    checks,
    ...over,
  };
}

test("a fresh report posts one check run per check, named `ryph / <name>`, under checks: write only", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(repo, report([check("lint"), check("test")]));
    assertEquals(out.kind, "reported");
    assert(out.kind === "reported");
    assertEquals(Object.keys(out.refs).sort(), ["lint", "test"]);

    const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
    assertEquals(mint?.body, { repositories: ["app"], permissions: { checks: "write" } });

    const posts = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/check-runs"));
    assertEquals(posts.map((p) => p.body.name), ["ryph / lint", "ryph / test"]);
    const first = posts[0].body;
    assertEquals(first.head_sha, HEAD);
    assertEquals(first.external_id, "cs-0123456789:1:lint");
    assertEquals(first.status, "queued");
    assertEquals(first.details_url, "https://ryph.example/checks/cs-0123456789");
    // A queued run carries no conclusion — GitHub refuses one on anything not completed.
    assert(!("conclusion" in first));
    assertEquals(first.output.title, "lint: queued");

    // The lookup asked only for this App's runs on the commit.
    const lookup = gh.calls.find((c) => c.method === "GET");
    assert(lookup?.path.includes(`app_id=${APP_ID}`));
    assert(lookup?.path.includes("filter=all"));
  } finally {
    await gh.shutdown();
  }
});

test("a known ref is updated in place, with no lookup and no second run", async () => {
  const gh = await fakeGithub({
    runs: [{ id: 77, app: { id: Number(APP_ID) }, external_id: "cs-0123456789:1:test" }],
  });
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(
      repo,
      report([check("test", {
        forgeRef: "77",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-09-30T10:00:00Z",
        completedAt: "2026-09-30T10:05:00Z",
      })]),
    );
    assert(out.kind === "reported");
    assertEquals(out.refs, { test: "77" });
    assertEquals(gh.calls.filter((c) => c.method === "GET").length, 0);
    const patch = gh.calls.find((c) => c.method === "PATCH");
    assertEquals(patch?.path, "/repos/acme/app/check-runs/77");
    assertEquals(patch?.body.conclusion, "success");
    assertEquals(patch?.body.completed_at, "2026-09-30T10:05:00Z");
    assertEquals(gh.runs.length, 1);
  } finally {
    await gh.shutdown();
  }
});

test("a lost response is adopted by external id — this App's run, never another's", async () => {
  const gh = await fakeGithub({
    runs: [
      // Another App's run under the same external id: never touched.
      { id: 10, app: { id: 1 }, external_id: "cs-0123456789:1:test" },
      // Ours, from the attempt whose response was lost.
      { id: 11, app: { id: Number(APP_ID) }, external_id: "cs-0123456789:1:test" },
      // Ours, but an older generation: a re-run is a NEW run, not this one.
      { id: 12, app: { id: Number(APP_ID) }, external_id: "cs-0123456789:0:lint" },
    ],
  });
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(repo, report([check("test"), check("lint")]));
    assert(out.kind === "reported");
    assertEquals(out.refs.test, "11");
    assert(out.refs.lint !== "12");
    const patches = gh.calls.filter((c) => c.method === "PATCH").map((c) => c.path);
    assertEquals(patches, ["/repos/acme/app/check-runs/11"]);
    // One lookup serves the whole report.
    assertEquals(gh.calls.filter((c) => c.method === "GET").length, 1);
  } finally {
    await gh.shutdown();
  }
});

test("a ref that no longer names a run is posted afresh", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(repo, report([check("test", { forgeRef: "404404" })]));
    assert(out.kind === "reported");
    assert(out.refs.test !== "404404");
    assertEquals(gh.runs.length, 1);
  } finally {
    await gh.shutdown();
  }
});

test("an installation that never granted Checks: write is unsupported, and nothing is posted", async () => {
  const gh = await fakeGithub({ mintStatus: 422 });
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(repo, report([check("test")]));
    assertEquals(out.kind, "unsupported");
    assert(out.kind === "unsupported");
    assert(out.reason.includes("Checks: write"));
    assertEquals(gh.calls.filter((c) => !c.path.endsWith("/access_tokens")).length, 0);
  } finally {
    await gh.shutdown();
  }
});

test("a mint refused for any other reason is a failure to retry, not unsupported", async () => {
  const gh = await fakeGithub({ mintStatus: 403 });
  try {
    const api = await makeApi(gh.base);
    const out = await api.reportChecks(repo, report([check("test")]));
    assertEquals(out.kind, "failed");
    assert(out.kind === "failed" && !out.terminal);
  } finally {
    await gh.shutdown();
  }
});

test("action_required without a details URL is posted as failure, which GitHub accepts", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    await api.reportChecks(
      repo,
      report([check("test", { status: "completed", conclusion: "action_required" })], {
        detailsUrl: null,
      }),
    );
    const post = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/check-runs"));
    assertEquals(post?.body.conclusion, "failure");
    assert(!("details_url" in post!.body));
  } finally {
    await gh.shutdown();
  }
});

test("a summary past GitHub's cap is clipped, never refused", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    // Past what the wire allows too — the adapter holds GitHub's own bound regardless.
    await api.reportChecks(repo, report([check("test", { summary: "x".repeat(70_000) })]));
    const post = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/check-runs"));
    assert(post!.body.output.summary.length <= 65_535);
  } finally {
    await gh.shutdown();
  }
});

test("a repo with no installation is a terminal refusal", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const err = await assertRejects(
      () => api.reportChecks({ repoRef: "acme/app", tenantId: null }, report([check("test")])),
      ForgeApiError,
    );
    assert(err.terminal);
  } finally {
    await gh.shutdown();
  }
});

test("a commit GitHub has not seen yet is worth asking about again", async () => {
  const unseen = { status: 422, message: `No commit found for SHA: ${HEAD}` };
  for (const forced of [{ list: unseen }, { post: unseen }]) {
    const gh = await fakeGithub(forced);
    try {
      const api = await makeApi(gh.base);
      const err = await assertRejects(
        () => api.reportChecks(repo, report([check("test")])),
        ForgeApiError,
      );
      assert(!err.terminal, JSON.stringify(forced));
    } finally {
      await gh.shutdown();
    }
  }
});

test("a listing GitHub cannot find is final: a deleted repo, or access taken away", async () => {
  const gh = await fakeGithub({ list: { status: 404, message: "Not Found" } });
  try {
    const api = await makeApi(gh.base);
    const err = await assertRejects(
      () => api.reportChecks(repo, report([check("test")])),
      ForgeApiError,
    );
    assert(err.terminal);
  } finally {
    await gh.shutdown();
  }
});

test("any other refusal of a posted run stays terminal", async () => {
  const gh = await fakeGithub({ post: { status: 422, message: "Invalid request." } });
  try {
    const api = await makeApi(gh.base);
    const err = await assertRejects(
      () => api.reportChecks(repo, report([check("test")])),
      ForgeApiError,
    );
    assert(err.terminal);
  } finally {
    await gh.shutdown();
  }
});
