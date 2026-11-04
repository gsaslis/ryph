import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The checks surfaces over HTTP: the runner's two tools (run-token auth), the suite page's three
// routes (capabilities, then the live repo permission for a re-run), the checks page's three
// lists (scoped as the suite page is), the task and patch views,
// the gateway's resolve of a check pod's key, and the forge's re-run button.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import type { ChecksFile, ForgePermission } from "../src/ports/forge.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";
import { BASE, checksFile, checksWorld, HEAD } from "./checks_world.ts";
import { fakeIdentityDirectory, fakeRunnerControl, imageConfig } from "./doubles.ts";

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
const FORGE_TOKEN = "forge-service-token";

async function app(
  opts: {
    checks?: boolean;
    canOpenPatches?: boolean;
    permission?: ForgePermission;
    userId?: string;
    /** The service as a restart that lost its launcher, or its gateway, would build it. */
    refusedReason?: string;
  } = {},
) {
  const w = await checksWorld({ canOpenPatches: opts.canOpenPatches });
  const identities = fakeIdentityDirectory();
  identities.link("u-1", "ada");
  identities.link("u-2", "grace");
  const user = { ...USER, userId: opts.userId ?? USER.userId };
  if (opts.permission !== undefined) {
    const permission = opts.permission;
    w.forge.checkPermission = () => Promise.resolve(permission);
  }
  const handler = makeHandler({
    store: w.store,
    provisioner: w.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    authenticate: (() => Promise.resolve(user)) as unknown as Authenticate,
    forgeToken: FORGE_TOKEN,
    forge: w.forge,
    identityDirectory: identities.directory,
    environments: w.environmentService,
    checks: opts.checks === false
      ? null
      : opts.refusedReason === undefined
      ? w.checksService
      : { ...w.checksService, refusedReason: opts.refusedReason },
    checksAwaiting: opts.checks === false ? null : w.checksAwaiting,
    now: w.clock.now,
    config: { ...imageConfig(), ...w.config },
  });
  const token = (await bootstrapEnv(handler, w.launches[0].env)).RYPH_RUN_TOKEN!;
  const call = (method: string, path: string, body?: unknown, bearer = "user-token") =>
    handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const runnerAsk = (body: unknown, bearer = token) =>
    call("POST", `/v1/runs/${w.run.id}/checks`, body, bearer);
  const good = {
    path: "api",
    headSha: HEAD,
    branch: `${w.run.branchNamespace}/work`,
    baseSha: "a".repeat(40),
  };
  return { ...w, handler, call, runnerAsk, good, token };
}

test("the runner asks for checks with its own run token, and reads them back as text", async () => {
  const a = await app();
  assertEquals((await a.runnerAsk(a.good, "not-the-token")).status, 401);
  assertEquals((await a.runnerAsk({ ...a.good, headSha: "nope" })).status, 400);
  const res = await a.runnerAsk(a.good);
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals(body.state, "queued");
  assertEquals(body.reused, false);
  assert(body.suiteId.startsWith("cs-"));
  assertStringIncludes(body.text, body.suiteId);

  const wrongPath = await a.runnerAsk({ ...a.good, path: "elsewhere" });
  assertEquals(wrongPath.status, 400);
  assertStringIncludes((await wrongPath.json()).error, "no repo at elsewhere");

  const status = await a.call("GET", `/v1/runs/${a.run.id}/checks`, undefined, a.token);
  assertEquals(status.status, 200);
  const read = await status.json();
  assertStringIncludes(read.text, body.suiteId);
  assertEquals(read.awaiting, 1, "the runner is told a verdict is still owed");

  const awaitingOnly = await a.call(
    "GET",
    `/v1/runs/${a.run.id}/checks?awaiting=1`,
    undefined,
    a.token,
  );
  assertEquals(
    await awaitingOnly.json(),
    { owed: [{ id: `${body.suiteId}@1`, requests: [...a.checkStore.requests.keys()] }] },
    "which verdicts, by name, and no text",
  );

  // The spec never waits on the forge: what the checks declare is its own route.
  const spec = await (await a.call("GET", `/v1/runs/${a.run.id}/spec`, undefined, a.token)).json();
  assertEquals(spec.checks, { enabled: true });
  const declared = () => a.call("GET", `/v1/runs/${a.run.id}/checks/declared`, undefined, a.token);
  assertEquals((await declared()).status, 200);
  assertEquals(await (await declared()).json(), {
    declared: [{
      path: "api",
      repoRef: a.api.repoRef,
      checksRef: "main",
      setup: ["npm ci"],
      checks: [
        { name: "lint", run: "deno lint", timeoutSeconds: 900, services: [] },
        { name: "test", run: "deno task test", timeoutSeconds: 1200, services: [] },
      ],
    }],
    unread: [],
  });
  const stranger = await a.call(
    "GET",
    `/v1/runs/${a.run.id}/checks/declared`,
    undefined,
    "not-the-token",
  );
  assertEquals(stranger.status, 401);
  // A base that cannot be read is named, never a 5xx.
  a.forge.readChecksFile = () => Promise.reject(new Error("forge down"));
  a.clock.advance(61_000);
  const blind = await declared();
  assertEquals(blind.status, 200);
  assertEquals(await blind.json(), { declared: [], unread: ["api"] });
});

test("a refused service owes no verdict, so the runner holds no stop on one", async () => {
  const refused = await app({ refusedReason: "cannot run check pods" });
  // A request filed before the restart, still pending in the store.
  await refused.checksService.requestForRun(refused.run, {
    path: "api",
    headSha: HEAD,
    branch: `${refused.run.branchNamespace}/work`,
    baseSha: "a".repeat(40),
  });
  assert((await refused.checksAwaiting(refused.run.id)).length > 0, "the store still owes it");
  const count = await refused.call(
    "GET",
    `/v1/runs/${refused.run.id}/checks?awaiting=1`,
    undefined,
    refused.token,
  );
  assertEquals(await count.json(), { owed: [] });
  const status = await refused.call(
    "GET",
    `/v1/runs/${refused.run.id}/checks`,
    undefined,
    refused.token,
  );
  assertEquals((await status.json()).awaiting, 0);
});

test("the runner may name checks; a malformed name is a 400", async () => {
  const a = await app();
  const bad = await a.runnerAsk({ ...a.good, checks: ["Not A Check"] });
  assertEquals(bad.status, 400);
  const res = await a.runnerAsk({ ...a.good, checks: ["lint"] });
  assertEquals(res.status, 202);
  const body = await res.json();
  assertEquals((await a.checksService.view(body.suiteId, SCOPE_ALL))!.checks.map((c) => c.name), [
    "lint",
  ]);
});

test("the runner's cap is a 429 with an error; no checks here is a 200 saying so", async () => {
  const capped = await checksWorldCapped();
  assertEquals((await capped.runnerAsk(capped.good)).status, 202);
  const second = await capped.runnerAsk({ ...capped.good, headSha: "e".repeat(40) });
  assertEquals(second.status, 429);
  assertStringIncludes((await second.json()).error, "RYPH_CHECKS_MAX_PER_RUN");

  const none = await app({ checks: false });
  const res = await none.runnerAsk(none.good);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).suiteId, null);
  const spec = await (await none.call("GET", `/v1/runs/${none.run.id}/spec`, undefined, none.token))
    .json();
  assertEquals(spec.checks, null);
  const status = await none.call("GET", `/v1/runs/${none.run.id}/checks`, undefined, none.token);
  const read = await status.json();
  assertStringIncludes(read.text, "does not run checks");
  assertEquals(read.awaiting, 0);
  const count = await none.call(
    "GET",
    `/v1/runs/${none.run.id}/checks?awaiting=1`,
    undefined,
    none.token,
  );
  assertEquals(await count.json(), { owed: [] });
  const declared = await none.call(
    "GET",
    `/v1/runs/${none.run.id}/checks/declared`,
    undefined,
    none.token,
  );
  assertEquals([declared.status, await declared.json()], [200, { declared: [], unread: [] }]);
});

async function checksWorldCapped() {
  const a = await app();
  // Re-point the service at a cap of one: the same deps, a stricter policy.
  const { makeChecksService } = await import("../src/core/checks.ts");
  const service = makeChecksService({
    store: a.checkStore,
    tasks: a.store,
    launcher: a.launched.launcher,
    forge: a.forge,
    environments: a.environmentService,
    logs: a.logs,
    diag: a.diag,
    now: a.clock.now,
    config: {
      policy: { ...a.policy, maxPerRun: 1 },
      agentImage: a.config.agentImage,
      runSizes: a.config.runSizes,
      gitGateway: a.config.gitGateway,
      services: a.config.services,
      egress: a.config.egress,
      appUrl: null,
    },
  });
  const handler = makeHandler({
    store: a.store,
    provisioner: a.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: a.diag,
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    checks: service,
    now: a.clock.now,
    config: { ...imageConfig(), ...a.config },
  });
  const runnerAsk = (body: unknown) =>
    handler(
      new Request(`http://orchestrator.test/v1/runs/${a.run.id}/checks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
        body: JSON.stringify(body),
      }),
    );
  return { ...a, runnerAsk };
}

test("a suite's page, its log as escaped text, and a re-run behind write access", async () => {
  const a = await app();
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();

  const page = await a.call("GET", `/v1/check-suites/${suiteId}`);
  assertEquals(page.status, 200);
  const { suite, branch } = await page.json();
  assertEquals([suite.id, suite.state, suite.repoRef], [suiteId, "running", "acme/api"]);
  // The branch beside it, as the list has it.
  const { suites } = await (await a.call("GET", "/v1/check-suites")).json();
  assertEquals(
    branch,
    suites.find((item: { suite: { id: string } }) => item.suite.id === suiteId).branch,
  );
  assertEquals(typeof branch, "string");
  assertEquals((await a.call("GET", "/v1/check-suites/cs-nope000000")).status, 404);

  // Not re-runnable while it runs.
  const early = await a.call("POST", `/v1/check-suites/${suiteId}/rerun`);
  assertEquals(early.status, 409);

  const name = `ryph-check-${suiteId}-g1`;
  a.launched.logs.set(`${name}/check-test`, "<script>alert(1)</script>\nFAIL\n");
  a.launched.finish(name, { lint: 0, test: 1 });
  await a.checksService.tick();

  assertEquals(
    (await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=x&check=test`)).status,
    400,
  );
  assertEquals(
    (await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=1&check=Te`)).status,
    400,
  );
  assertEquals(
    (await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=1&check=zzz`)).status,
    404,
  );
  const log = await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=1&check=test`);
  assertEquals(log.status, 200);
  assertEquals(log.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(log.headers.get("x-content-type-options"), "nosniff");
  assertStringIncludes(await log.text(), "<script>");

  const rerun = await a.call("POST", `/v1/check-suites/${suiteId}/rerun`);
  assertEquals(rerun.status, 200);
  const rerunBody = await rerun.json();
  assertEquals([rerunBody.suite.generation, rerunBody.suite.state], [2, "queued"]);
  assertEquals(
    rerunBody.suite.requestedBy.map((r: { kind: string }) => r.kind).sort(),
    ["rerun", "tool"],
  );
});

test("a re-run needs write on the repo, checked live", async () => {
  const a = await app({ permission: "denied" });
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  a.launched.finish(`ryph-check-${suiteId}-g1`, { lint: 1, test: 0 });
  await a.checksService.tick();
  const refused = await a.call("POST", `/v1/check-suites/${suiteId}/rerun`);
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "does not have write access");
  assertEquals(a.onlySuite().generation, 1);
});

test("a task's detail carries its suites; the approval queue a count per patch", async () => {
  const a = await app();
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  const patch = a.patchOf();
  await a.store.createPatch(patch);
  await a.checksService.tick();
  a.launched.finish(`ryph-check-${suiteId}-g1`, { lint: 0, test: 1 });
  await a.checksService.tick();

  const detail = await (await a.call("GET", `/v1/tasks/${a.run.taskId}`)).json();
  assertEquals(detail.checkSuites.map((s: { id: string }) => s.id), [suiteId]);
  const queue = await (await a.call("GET", "/v1/patches")).json();
  const row = queue.patches.find((p: { id: string }) => p.id === patch.id);
  assertEquals(row.checks, { suiteId, state: "failed", passed: 1, failed: 1, total: 2 });

  const none = await app({ checks: false });
  const empty = await (await none.call("GET", `/v1/tasks/${none.run.taskId}`)).json();
  assertEquals(empty.checkSuites, []);
});

test("the gateway resolves a check pod's key to its candidate, only while it runs", async () => {
  const a = await app();
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  const header = a.launched.specs[0].clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.replace("Authorization: Basic ", "")).split(":")[1];
  const resolve = () => a.call("POST", "/v1/forge/git-keys/resolve", { token }, FORGE_TOKEN);
  const res = await resolve();
  assertEquals(res.status, 200);
  const grant = await res.json();
  assertEquals(grant.runId, suiteId);
  assertEquals(grant.repos[0].candidate, {
    headSha: HEAD,
    branchName: `${a.run.branchNamespace}/work`,
    bundleKey: `${a.run.id}/work/${a.api.id}/${HEAD}.bundle`,
  });
  assertEquals(grant.repos[0].targetRef, undefined, "the base is the branch the run started on");
  a.launched.finish(`ryph-check-${suiteId}-g1`, { lint: 0, test: 0 });
  await a.checksService.tick();
  assertEquals((await resolve()).status, 404);
  assertEquals(
    (await a.call("POST", "/v1/forge/git-keys/resolve", { token: "x".repeat(64) }, FORGE_TOKEN))
      .status,
    404,
  );
});

test("the forge's re-run button: write access, one re-run per delivery", async () => {
  const a = await app();
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  a.launched.finish(`ryph-check-${suiteId}-g1`, { lint: 1, test: 0 });
  await a.checksService.tick();
  const event = (over: Record<string, unknown> = {}) => ({
    deliveryId: "d-1",
    kind: "check_run.rerequested",
    repo: { provider: "github", repoRef: "acme/api", url: "https://github.com/acme/api" },
    actorLogin: "grace",
    thread: null,
    body: null,
    sourceCommentId: null,
    checkRun: { externalId: `${suiteId}:1:lint`, headSha: HEAD, name: "ryph / lint" },
    receivedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const send = async (body: unknown) =>
    await (await a.call("POST", "/v1/forge/events", body, FORGE_TOKEN)).json();

  assertEquals(
    await send(event({
      deliveryId: "d-0",
      repo: { provider: "github", repoRef: "acme/nope", url: "x" },
    })),
    { outcome: "repo-not-connected" },
  );
  assertEquals(await send(event({ deliveryId: "d-00", checkRun: undefined })), {
    outcome: "no-command",
  });
  assertEquals(await send(event()), { outcome: "checks-rerun" });
  assertEquals(a.onlySuite().generation, 2);
  assertEquals(await send(event()), { outcome: "deduped" }, "a redelivery re-runs nothing");
  assertEquals(
    await send(
      event({
        deliveryId: "d-2",
        checkRun: { externalId: "cs-0000000000:1:x", headSha: HEAD, name: "x" },
      }),
    ),
    { outcome: "no-such-suite" },
  );

  const denied = await app({ permission: "denied" });
  const asked = await (await denied.runnerAsk(denied.good)).json();
  const body = event({
    checkRun: { externalId: `${asked.suiteId}:1:lint`, headSha: HEAD, name: "x" },
  });
  assertEquals(
    await (await denied.call("POST", "/v1/forge/events", body, FORGE_TOKEN)).json(),
    { outcome: "denied" },
  );
  const unknown = await app({ permission: "unknown" });
  assertEquals((await unknown.call("POST", "/v1/forge/events", event(), FORGE_TOKEN)).status, 503);

  // "Re-run all checks" names only the head, behind the same gates. A runner's ask was never
  // posted to the forge, so there is nothing of ryph's on the head to re-run.
  const all = (over: Record<string, unknown> = {}) =>
    event({
      kind: "check_suite.rerequested",
      checkRun: undefined,
      checkSuite: { headSha: HEAD },
      ...over,
    });
  assertEquals(await send(all({ deliveryId: "s-0", checkSuite: undefined })), {
    outcome: "no-command",
  });
  assertEquals(await send(all({ deliveryId: "s-1" })), { outcome: "no-such-suite" });
  assertEquals(await send(all({ deliveryId: "s-1" })), { outcome: "deduped" });
  assertEquals(
    await (await denied.call("POST", "/v1/forge/events", all({ deliveryId: "s-2" }), FORGE_TOKEN))
      .json(),
    { outcome: "denied" },
  );
});

test("a suite is read only by those who can see a task that asked for it", async () => {
  // Grace did not start the task and cannot write the repo, and holds no tasks:read-all.
  const a = await app({ userId: "u-2", permission: "denied" });
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  const name = `ryph-check-${suiteId}-g1`;
  a.launched.logs.set(`${name}/check-test`, "FAIL\n");
  a.launched.finish(name, { lint: 0, test: 1 });
  await a.checksService.tick();
  assertEquals((await a.call("GET", `/v1/check-suites/${suiteId}`)).status, 404);
  assertEquals(
    (await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=1&check=test`)).status,
    404,
  );
  assertEquals((await a.call("POST", `/v1/check-suites/${suiteId}/rerun`)).status, 404);

  // The task's own requester reads it.
  const own = await app({ permission: "denied" });
  const mine = await (await own.runnerAsk(own.good)).json();
  assertEquals((await own.call("GET", `/v1/check-suites/${mine.suiteId}`)).status, 200);
});

test("the checks list: newest first, filtered, paged, each with its branch and askers", async () => {
  const a = await app();
  const task = (await a.store.getTask(a.run.taskId))!;
  const first = (await (await a.runnerAsk(a.good)).json()).suiteId;
  await a.checksService.tick();
  a.launched.logs.set(`ryph-check-${first}-g1/check-test`, "FAIL\n");
  a.launched.finish(`ryph-check-${first}-g1`, { lint: 0, test: 1 });
  await a.checksService.tick();
  a.clock.advance(1_000);
  // A newer head replaces it as the run's ask; the first keeps its verdict.
  const second = (await (await a.runnerAsk({ ...a.good, headSha: "e".repeat(40) })).json())
    .suiteId;
  await a.checksService.tick();

  const list = async (query = "") => {
    const res = await a.call("GET", `/v1/check-suites${query}`);
    assertEquals(res.status, 200, query);
    return await res.json();
  };
  const all = await list();
  assertEquals(all.suites.map((s: { suite: { id: string } }) => s.suite.id), [second, first]);
  assertEquals(all.nextCursor, null);
  assertEquals(all.suites[1].branch, `${a.run.branchNamespace}/work`);
  assertEquals(all.suites[1].askedBy, [
    { kind: "tool", label: task.spec.title, href: `/tasks/${task.id}` },
  ]);
  // The tails are the suite page's: a list leaves them out.
  const tails = (checks: Array<{ logTail: string | null }>) => checks.map((c) => c.logTail);
  assertEquals(tails(all.suites[1].suite.checks), [null, null]);
  const page1 = await (await a.call("GET", `/v1/check-suites/${first}`)).json();
  assertEquals(tails(page1.suite.checks).map((t) => t !== null), [false, true]);
  const ids = (body: { suites: Array<{ suite: { id: string } }> }) =>
    body.suites.map((s) => s.suite.id);
  assertEquals(ids(await list("?state=failing")), [first]);
  assertEquals(ids(await list("?state=active")), [second]);
  assertEquals(ids(await list("?state=passed")), []);
  assertEquals(ids(await list(`?repo=${a.api.id}&asked=tool`)), [second, first]);
  assertEquals(ids(await list(`?repo=${a.web.id}`)), []);
  assertEquals(ids(await list("?asked=forge")), []);

  const page = await list("?limit=1");
  assertEquals([ids(page), page.nextCursor === null], [[second], false]);
  const next = await list(`?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
  assertEquals([ids(next), next.nextCursor], [[first], null]);

  assertEquals((await a.call("GET", "/v1/check-suites?state=green")).status, 400);
  assertEquals((await a.call("GET", "/v1/check-suites?asked=bot")).status, 400);
  assertEquals((await a.call("GET", "/v1/check-suites?limit=0")).status, 400);
  assertEquals((await a.call("GET", "/v1/check-suites?cursor=nope")).status, 400);

  // A re-run is a person's; a patch on the head is its change request, linked on the forge.
  assertEquals((await a.call("POST", `/v1/check-suites/${first}/rerun`)).status, 200);
  a.clock.advance(1_000);
  const patch = a.patchOf({ forgeRef: "12", forgeUrl: "https://github.com/acme/api/pull/12" });
  await a.store.createPatch(patch);
  await a.checksService.patchOpened(patch);
  await a.checksService.tick();
  const asked = (await list("?asked=forge")).suites;
  assertEquals(ids({ suites: asked }), [first]);
  assertEquals(asked[0].askedBy, [
    { kind: "tool", label: task.spec.title, href: `/tasks/${task.id}` },
    { kind: "rerun", label: "Run again", href: null },
    { kind: "patch", label: "#12", href: "https://github.com/acme/api/pull/12" },
  ]);
  assertEquals(ids(await list("?asked=patch")), [first]);
});

test("what runs now, against the deployment's check pods", async () => {
  const a = await app();
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  const active = async () => await (await a.call("GET", "/v1/checks/active")).json();
  const queued = await active();
  assertEquals(queued.active.map((s: { suite: { state: string } }) => s.suite.state), ["queued"]);
  assertEquals(queued.capacity, { inUse: 0, total: a.policy.maxConcurrent });
  await a.checksService.tick();
  assertEquals((await active()).capacity, { inUse: 1, total: a.policy.maxConcurrent });
  // A newer suite waiting behind it: the one on a pod still leads the list.
  const running = (await a.checkStore.getSuite(suiteId))!;
  await a.checkStore.claimSuite({
    ...running,
    id: "cs-later",
    checksBlob: "f".repeat(40),
    state: "queued",
    launchedAt: null,
    leaseUntil: null,
    createdAt: new Date(Date.parse(running.createdAt) + 60_000).toISOString(),
  });
  const [asked] = await a.checkStore.listRequestsForSuite(suiteId);
  await a.checkStore.createRequest({ ...asked, id: "cq-later", suiteId: "cs-later" });
  assertEquals(
    (await active()).active.map((s: { suite: { id: string; state: string } }) => s.suite.id),
    [suiteId, "cs-later"],
  );
  await a.checkStore.saveSuiteIf({ ...running, id: "cs-later", state: "passed" }, {
    states: ["queued"],
    generation: running.generation,
  });
  a.launched.finish(`ryph-check-${suiteId}-g1`, { lint: 0, test: 0 });
  await a.checksService.tick();
  assertEquals(await active(), {
    active: [],
    capacity: { inUse: 0, total: a.policy.maxConcurrent },
  });

  const none = await app({ checks: false });
  assertEquals(await (await none.call("GET", "/v1/checks/active")).json(), {
    active: [],
    capacity: { inUse: 0, total: 0 },
  });
  assertEquals(await (await none.call("GET", "/v1/check-suites")).json(), {
    suites: [],
    nextCursor: null,
  });
  assertEquals(await (await none.call("GET", "/v1/checks/repos")).json(), { repos: [] });
});

test("each repo's checks file on its default branch, and its newest full suite", async () => {
  const a = await app();
  const files = new Map<string, () => ChecksFile>([
    ["acme/api", () => checksFile()],
    ["acme/web", () => ({ kind: "absent", commit: BASE })],
  ]);
  a.forge.readChecksFile = (repo) => Promise.resolve(files.get(repo.repoRef)!());
  const repos = async () => {
    const res = await a.call("GET", "/v1/checks/repos");
    assertEquals(res.status, 200);
    const body = await res.json();
    return new Map(
      body.repos.map((r: { repoRef: string }) => [r.repoRef, r] as const),
    ) as Map<string, { file: unknown; latest: { id: string } | null; defaultBranch: string }>;
  };
  // `?repo=` narrows the answer to one repo, by id, and reads only its file off the forge. First,
  // before any read: the files are cached a minute, and a warm cache reads nothing at all.
  const read: string[] = [];
  const reader = a.forge.readChecksFile;
  a.forge.readChecksFile = (repo, ...rest) => {
    read.push(repo.repoRef);
    return reader(repo, ...rest);
  };
  const apiId = (await a.store.listConnectedRepos()).find((r) => r.repoRef === "acme/api")!.id;
  const one = await (await a.call("GET", `/v1/checks/repos?repo=${apiId}`)).json();
  assertEquals(one.repos.map((r: { repoRef: string }) => r.repoRef), ["acme/api"]);
  assertEquals(read, ["acme/api"]);
  a.forge.readChecksFile = reader;
  const before = await repos();
  assertEquals(before.get("acme/api")!.file, {
    state: "declared",
    path: ".ryph/checks.yml",
    commit: BASE,
    setup: ["npm ci"],
    podsNeeded: 1,
    checks: [
      { name: "lint", run: "deno lint", timeoutSeconds: 900, services: [], watch: [] },
      {
        name: "test",
        run: "deno task test",
        timeoutSeconds: 1200,
        services: [],
        watch: ["deno.json"],
      },
    ],
  });
  assertEquals(before.get("acme/api")!.latest, null);
  assertEquals(before.get("acme/web")!.file, { state: "none" });

  // A subset is not the repo's newest run of its checks; the full suite is.
  const subset = (await (await a.runnerAsk({ ...a.good, checks: ["lint"] })).json()).suiteId;
  assertEquals((await repos()).get("acme/api")!.latest, null, subset);
  const full = (await (await a.runnerAsk({ ...a.good, headSha: "e".repeat(40) })).json()).suiteId;
  assertEquals((await repos()).get("acme/api")!.latest?.id, full);
  // A suite judged by another branch's file is not a run of the file shown.
  a.clock.advance(1_000);
  const other = (await (await a.runnerAsk({ ...a.good, headSha: "f".repeat(40) })).json()).suiteId;
  const stored = (await a.checkStore.getSuite(other))!;
  assert(
    await a.checkStore.saveSuiteIf({ ...stored, checksRef: "release" }, {
      states: [stored.state],
      generation: stored.generation,
    }),
  );
  assertEquals((await repos()).get("acme/api")!.latest?.id, full);

  // Past the read cache: an invalid file, one the forge refused, one it could not read.
  files.set("acme/api", () => checksFile({ text: "checks: [{ name: Bad }]" }));
  files.set("acme/web", () => ({ kind: "unavailable", detail: "forge answered 502" }));
  a.clock.advance(61_000);
  const after = await repos();
  const invalid = after.get("acme/api")!.file as { state: string; path: string; commit: string };
  assertEquals([invalid.state, invalid.path, invalid.commit], [
    "invalid",
    ".ryph/checks.yml",
    BASE,
  ]);
  assertEquals(after.get("acme/web")!.file, { state: "unread", error: "forge answered 502" });
  files.set("acme/web", () => ({ kind: "invalid", commit: null, detail: "over the limit" }));
  a.clock.advance(61_000);
  assertEquals((await repos()).get("acme/web")!.file, {
    state: "invalid",
    path: null,
    commit: null,
    error: "over the limit",
  });
});

test("the lists hold only suites a task the caller can see asked for", async () => {
  // Grace did not start the task, cannot write the repo, and holds no tasks:read-all.
  const a = await app({ userId: "u-2", permission: "denied" });
  const { suiteId } = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  assertEquals((await (await a.call("GET", "/v1/check-suites")).json()).suites, []);
  const active = await (await a.call("GET", "/v1/checks/active")).json();
  assertEquals(active.active, []);
  assertEquals(active.capacity.inUse, 1, "the slots are the deployment's, whoever holds them");
  const repos = (await (await a.call("GET", "/v1/checks/repos")).json()).repos;
  assertEquals(repos.find((r: { repoRef: string }) => r.repoRef === "acme/api").latest, null);

  const own = await app({ permission: "denied" });
  const mine = await (await own.runnerAsk(own.good)).json();
  // Grace's task asks for the same suite: Ada's lists leave its run out of `requestedBy`.
  const graces = await own.startRepo(own.api, "main", { requestedByUserId: "u-2" });
  assert(graces.kind === "started");
  const asked = (await own.checkStore.listRequestsForSuite(mine.suiteId))[0];
  await own.checkStore.createRequest({ ...asked, id: "cq-grace", runId: graces.runId });
  const requestedBy = (body: { suite: { requestedBy: Array<{ runId: string | null }> } }) =>
    body.suite.requestedBy.map((r) => r.runId);
  const listed = (await (await own.call("GET", "/v1/check-suites")).json()).suites;
  assertEquals(listed.map((s: { suite: { id: string } }) => s.suite.id), [mine.suiteId]);
  assertEquals(requestedBy(listed[0]), [own.run.id]);
  const running = (await (await own.call("GET", "/v1/checks/active")).json()).active;
  assertEquals(requestedBy(running[0]), [own.run.id]);
  // The suite's page and the run page hold `requestedBy` the same way.
  const page = await (await own.call("GET", `/v1/check-suites/${mine.suiteId}`)).json();
  assertEquals(requestedBy(page), [own.run.id]);
  const detail = await (await own.call("GET", `/v1/tasks/${own.run.taskId}`)).json();
  assertEquals(
    detail.checkSuites.map((s: { requestedBy: Array<{ runId: string | null }> }) =>
      s.requestedBy.map((r) => r.runId)
    ),
    [[own.run.id]],
  );
  assert(suiteId.startsWith("cs-"));
});

test("the runner names commits to look up, and reads one check's whole log", async () => {
  const a = await app();
  const ask = await (await a.runnerAsk(a.good)).json();
  await a.checksService.tick();
  const suite = a.onlySuite();
  a.launched.logs.set(`${a.nameOf(suite)}/check-test`, "first\nsecond\n");
  a.launched.finish(a.nameOf(suite), { lint: 0, test: 1 });
  await a.checksService.tick();

  const status = (query: string) =>
    a.call("GET", `/v1/runs/${a.run.id}/checks?${query}`, undefined, a.token);
  const named = await status(`at=${HEAD}:api&named=1`);
  assertEquals(named.status, 200);
  assertStringIncludes((await named.json()).text, `Checks on api at ${HEAD.slice(0, 10)}`);
  for (
    const bad of [
      "at=nope:api",
      `at=${HEAD}`,
      `at=${HEAD}:`,
      `at=${HEAD.toUpperCase()}:api`,
      `at=${HEAD}:${"x".repeat(300)}`,
      Array.from({ length: 9 }, () => `at=${HEAD}:api`).join("&"),
    ]
  ) {
    assertEquals((await status(bad)).status, 400, bad);
  }

  const log = (path: string, bearer = a.token) =>
    a.call("GET", `/v1/runs/${a.run.id}/checks/${path}`, undefined, bearer);
  const read = await log(`${ask.suiteId}/log?check=test`);
  assertEquals(read.status, 200);
  assertEquals(read.headers.get("x-ryph-check-generation"), "1");
  assertEquals(await read.text(), "first\nsecond\n");
  assertEquals((await log(`${ask.suiteId}/log?check=test`, "not-the-token")).status, 401);
  assertEquals((await log(`${ask.suiteId}/log?check=Bad/Name`)).status, 400);
  assertEquals((await log(`${ask.suiteId}/log?check=test&generation=0`)).status, 400);
  const gone = await log("cs-0000000000/log?check=test");
  assertEquals(gone.status, 404);
  assertStringIncludes((await gone.json()).error, "this run may read");
});

test("a run that may not open patches is told checks are on, and reads them", async () => {
  const a = await app({ canOpenPatches: false });
  const spec = await (await a.call("GET", `/v1/runs/${a.run.id}/spec`, undefined, a.token)).json();
  assertEquals(spec.checks, { enabled: true });
  const status = await a.call(
    "GET",
    `/v1/runs/${a.run.id}/checks?at=${HEAD}:api`,
    undefined,
    a.token,
  );
  assertEquals(status.status, 200);
});
