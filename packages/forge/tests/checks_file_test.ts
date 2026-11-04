// The checks-file read, through the pure handler against real git on temp dirs — and, at the
// end, the report route beside it, whose only job is to carry the adapter's answer and its
// terminality back to the control plane.
//
// This file is the JUDGE of a change, so the properties worth pinning are the ones that keep a
// judge honest: every fact comes from one pinned commit, "could not ask" never arrives looking
// like "the repo declares nothing", and — unlike the services read — a cache the upstream could
// not refresh is never answered from at all.

import { execFileSync } from "node:child_process";
import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { MAX_CHECKS_FILE_BYTES, MAX_SERVICES_FILE_BYTES } from "../src/http/service.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import {
  type CheckReport,
  type ForgeApi,
  ForgeApiError,
  providerRegistry,
  type ReportChecksOutcome,
} from "../src/ports/forge_api.ts";
import { git } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

const CHECKS = `checks:
  - name: test
    run: deno task test
`;

const SERVICES = `services:
  db:
    uses: postgres@18
`;

/** Only `upstreamUrl` and `fetchAuth` are reached by the read; `reportChecks` by the report. */
function tokenOnlyForgeApi(reportChecks: ForgeApi["reportChecks"]): ForgeApi {
  const never = () => Promise.reject(new Error("not part of this surface"));
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
    postComment: never,
    reportChecks,
  } as unknown as ForgeApi;
}

async function build(
  root: string,
  reportChecks: ForgeApi["reportChecks"] = () =>
    Promise.reject(new Error("not part of this surface")),
) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const never = () => Promise.reject(new Error("not part of this surface"));
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: tokenOnlyForgeApi(reportChecks) }, "forge API"),
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir },
  };
  return { handler: makeHandler(deps), deps };
}

const ask = (
  handler: (req: Request) => Promise<Response>,
  url: string,
  commitOrRef = "main",
  token: string | null = SERVICE_TOKEN,
) =>
  handler(
    new Request("http://forge/v1/service/checks-file", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
        url,
        commitOrRef,
      }),
    }),
  );

/** Writes `files` under the upstream's work tree and commits them; returns the new head. */
async function commitFiles(dir: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(`${dir}/${path.split("/").slice(0, -1).join("/")}`, { recursive: true });
    await writeFile(`${dir}/${path}`, text);
  }
  await git(dir, "add", ".");
  await commit(dir, message);
  return await git(dir, "rev-parse", "HEAD");
}

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("a declaration comes back with its commit, blob, .ryph tree, Dockerfile and services — one commit", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "checks");
    const head = await commitFiles(upstream, {
      ".ryph/checks.yml": CHECKS,
      ".ryph/services.yml": SERVICES,
      ".ryph/Dockerfile": "FROM scratch\n",
    }, "declare checks");

    const res = await ask(handler, upstream);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.kind, "file");
    assertEquals(body.text, CHECKS);
    assertEquals(body.path, ".ryph/checks.yml");
    assertEquals(body.commit, head);
    // The ids are git's own, so a report can name them and anybody can check them.
    assertEquals(body.blob, await git(upstream, "rev-parse", `${head}:.ryph/checks.yml`));
    // The `.ryph` tree as every environment read answers it: without what no build reads.
    const dockerfile = await git(upstream, "rev-parse", `${head}:.ryph/Dockerfile`);
    const machineOnly = execFileSync("git", ["mktree"], {
      cwd: upstream,
      input: `100644 blob ${dockerfile}\tDockerfile\n`,
    }).toString().trim();
    assertEquals(body.ryphTree, machineOnly);
    assertEquals(body.dockerfile, true);
    assertEquals(body.services, { kind: "file", text: SERVICES });
  });
});

test("services and the Dockerfile are read at the SAME commit as the checks, never the branch", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "pinned");
    const first = await commitFiles(upstream, { ".ryph/checks.yml": CHECKS }, "checks only");
    // The branch moves on: services and a Dockerfile appear only after the pinned commit.
    await commitFiles(upstream, {
      ".ryph/services.yml": SERVICES,
      ".ryph/Dockerfile": "FROM scratch\n",
    }, "later");

    const body = await (await ask(handler, upstream, first)).json();
    assertEquals(body.kind, "file");
    assertEquals(body.commit, first);
    assertEquals(body.dockerfile, false);
    assertEquals(body.services, { kind: "absent" });
  });
});

test("a repo with no checks file answers absent, with the commit it looked at", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    const head = await makeUpstream(upstream);
    assertEquals(await (await ask(handler, upstream)).json(), { kind: "absent", commit: head });
  });
});

test("the .yaml spelling is read too, and .yml wins when both exist", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "yaml");
    await commitFiles(upstream, { ".ryph/checks.yaml": CHECKS }, "the other spelling");
    const yaml = await (await ask(handler, upstream)).json();
    assertEquals(yaml.kind, "file");
    assertEquals(yaml.path, ".ryph/checks.yaml");

    await commitFiles(upstream, { ".ryph/checks.yml": "checks: []\n" }, "both spellings");
    const both = await (await ask(handler, upstream)).json();
    assertEquals(both.path, ".ryph/checks.yml");
    assertEquals(both.text, "checks: []\n");
  });
});

test("a checks file over the byte ceiling is invalid — read bounded, never truncated", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "huge");
    const head = await commitFiles(upstream, {
      ".ryph/checks.yml": `# ${"x".repeat(MAX_CHECKS_FILE_BYTES)}\n`,
    }, "too big");

    const res = await ask(handler, upstream);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.kind, "invalid");
    assertEquals(body.commit, head);
    assertStringIncludes(body.detail, "over the");
  });
});

test("an oversized services file is the services arm's invalid, not the whole read's", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "services-huge");
    await commitFiles(upstream, {
      ".ryph/checks.yml": CHECKS,
      ".ryph/services.yml": `# ${"x".repeat(MAX_SERVICES_FILE_BYTES)}\n`,
    }, "services too big");

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "file");
    assertEquals(body.services.kind, "invalid");
    assertStringIncludes(body.services.detail, "services.yml");
  });
});

test('no cache and no upstream is "unavailable" — never "absent"', async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const res = await ask(handler, `${root}/never-existed`);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).kind, "unavailable");
  });
});

test("a warm cache with the upstream gone is unavailable: a stale base is a wrong judge", async () => {
  await withRoot(async (root) => {
    const { handler, deps } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "stale");
    const head = await commitFiles(upstream, { ".ryph/checks.yml": CHECKS }, "checks");
    // Warmed exactly as a previous clone would have — then the upstream goes away.
    await deps.cache.serveBase({ url: upstream }, "main", anonymous);
    await rm(upstream, { recursive: true });

    // The services read would answer here, marked stale. This one must not answer at all.
    const res = await ask(handler, upstream);
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.kind, "unavailable");
    assert(!("text" in body));

    // A COMMIT the entry already holds is immutable, so reading it needs no upstream: that is
    // not staleness, it is the same bytes.
    const pinned = await (await ask(handler, upstream, head)).json();
    assertEquals(pinned.kind, "file");
    assertEquals(pinned.commit, head);
  });
});

test("a branch the upstream does not have is refused terminally, not retried", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "missing-ref");
    const res = await ask(handler, upstream, "gone");
    assertEquals(res.status, 404);
    assertEquals((await res.json()).terminal, true);
  });
});

test("a commit the upstream does not have is unavailable, not absent", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "missing-commit");
    const res = await ask(handler, upstream, "d".repeat(40));
    assertEquals(res.status, 502);
    assertEquals((await res.json()).kind, "unavailable");
  });
});

test("the read is service-authenticated, and a tag ref is refused terminally", async () => {
  await withRoot(async (root) => {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "auth");
    assertEquals((await ask(handler, upstream, "main", null)).status, 401);
    assertEquals((await ask(handler, upstream, "main", "wrong")).status, 401);

    const tagged = await ask(handler, upstream, "refs/tags/v1");
    assertEquals(tagged.status, 400);
    assertEquals((await tagged.json()).terminal, true);
  });
});

const REPORT = {
  headSha: "c".repeat(40),
  suiteId: "cs-0123456789",
  generation: 1,
  detailsUrl: null,
  suite: { state: "queued", conclusion: null, summary: "queued" },
  checks: [{
    name: "test",
    status: "queued",
    conclusion: null,
    title: "test: queued",
    summary: "queued",
    startedAt: null,
    completedAt: null,
    externalId: "cs-0123456789:1:test",
    forgeRef: null,
  }],
};

const postReport = (handler: (req: Request) => Promise<Response>, body: unknown) =>
  handler(
    new Request("http://forge/v1/service/checks/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify(body),
    }),
  );

test("the report route carries the adapter's answer, and its terminality, back", async () => {
  await withRoot(async (root) => {
    let answer: () => Promise<ReportChecksOutcome> = () =>
      Promise.resolve({ kind: "reported", refs: { test: "77" } });
    let asked: CheckReport | null = null;
    const { handler } = await build(root, (_repo, report) => {
      asked = report;
      return answer();
    });
    const repo = { provider: "github", repoRef: "acme/app", tenantId: "42" };

    const reported = await postReport(handler, { repo, report: REPORT });
    assertEquals(reported.status, 200);
    assertEquals(await reported.json(), { kind: "reported", refs: { test: "77" } });

    answer = () => Promise.resolve({ kind: "unsupported", reason: "no Checks: write" });
    const unsupported = await postReport(handler, { repo, report: REPORT });
    assertEquals(unsupported.status, 200);
    assertEquals((await unsupported.json()).kind, "unsupported");

    answer = () => Promise.reject(new ForgeApiError("422 from GitHub", true));
    const refused = await postReport(handler, { repo, report: REPORT });
    assertEquals(refused.status, 422);
    assertEquals((await refused.json()).terminal, true);

    answer = () => Promise.reject(new ForgeApiError("GitHub is down", false));
    const down = await postReport(handler, { repo, report: REPORT });
    assertEquals(down.status, 502);
    assertEquals((await down.json()).terminal, false);

    answer = () => Promise.resolve({ kind: "failed", message: "nope", terminal: true });
    assertEquals((await postReport(handler, { repo, report: REPORT })).status, 422);

    // Older generations to finish ride inside the suite, and reach the adapter as sent.
    answer = () => Promise.resolve({ kind: "reported", refs: {} });
    const withPrevious = { ...REPORT, suite: { ...REPORT.suite, previousGenerations: [1, 2] } };
    assertEquals((await postReport(handler, { repo, report: withPrevious })).status, 200);
    assertEquals(asked!.suite.previousGenerations, [1, 2]);
    for (const wrong of [[0], ["1"], 1]) {
      const res = await postReport(handler, {
        repo,
        report: { ...REPORT, suite: { ...REPORT.suite, previousGenerations: wrong } },
      });
      assertEquals(res.status, 400, JSON.stringify(wrong));
    }

    // A report the schema refuses never reaches the adapter.
    answer = () => Promise.reject(new Error("must not be reached"));
    const bad = await postReport(handler, {
      repo,
      report: { ...REPORT, checks: [{ ...REPORT.checks[0], name: "Not A Name" }] },
    });
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).terminal, true);
  });
});
