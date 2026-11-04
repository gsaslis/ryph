// Local asks: a person asks for a repo's checks on a commit of
// their own from their machine — a branch they pushed, or a bundle they upload — before any change
// request exists. The suite is the runless one a push request reproduces, so the pull request
// opened on that commit and base joins it and is reported at once. The engine first, then the
// routes: their gates in order, the bundle's way through the forge, the ask read back, and who
// may read what came of it.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler, type Principal } from "../src/http/app.ts";
import type {
  BranchHeadOutcome,
  ForgePermission,
  GithubMode,
  StageCheckBundleOutcome,
} from "../src/ports/forge.ts";
import {
  type CheckRequest,
  type ForgeSource,
  isForgeSource,
  isLocalBundleSource,
  localBundleKey,
  type LocalBundleSource,
} from "../src/core/check_types.ts";
import { liveCeiling, resolveNetworkScope } from "../src/core/egress.ts";
import {
  type ChangeRequestPush,
  LOCAL_REQUEST_TTL_MS,
  type LocalChecksInput,
} from "../src/core/checks.ts";
import { sha256Hex } from "@ryph/sealed";
import { checksWorld, HEAD, sha, T0 } from "./checks_world.ts";
import { remoteChecksClient } from "../src/adapters/remote_checks/http.ts";
import { fakeIdentityDirectory, fakeRunnerControl, imageConfig } from "./doubles.ts";

type World = Awaited<ReturnType<typeof quietWorld>>;

const OTHER = sha("e");
const THIRD = sha("f");
/** A host the deployment's allowlist names, so a pod scoped to nothing would show. */
const ALLOWED = "registry.npmjs.org";
const ADA = { userId: "u-1", name: "Ada" };
const GRACE = { userId: "u-2", name: "Grace" };

/** A world whose allowlist is not empty, so the runless scope is visible in a suite, and whose
 * forge answers each branch's live head from `heads` (a branch not in it is absent). */
const quietWorld = async (opts: Parameters<typeof checksWorld>[0] = {}) => {
  const w = await checksWorld({
    ...opts,
    world: {
      ...opts.world,
      egress: {
        policy: { mode: "proxy", bundles: [], hosts: [ALLOWED], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
    },
  });
  const heads = new Map<string, BranchHeadOutcome>();
  const headsAsked: string[] = [];
  w.forge.readBranchHead = (_repo, _url, branch) => {
    headsAsked.push(branch);
    return Promise.resolve(heads.get(branch) ?? { kind: "absent" });
  };
  return Object.assign(w, { heads, headsAsked });
};

/** A person's ask; a pushed one first makes its commit its branch's live head on the forge,
 * unless `pushed: false` leaves the forge as it is. */
const ask = (w: World, over: Partial<LocalChecksInput> & { pushed?: boolean } = {}) => {
  const { pushed = true, ...input } = over;
  const asked: LocalChecksInput = {
    user: ADA,
    repo: w.api,
    commit: HEAD,
    branch: "feat",
    bundled: false,
    ...input,
  };
  if (!asked.bundled && pushed) w.heads.set(asked.branch, { kind: "head", sha: asked.commit });
  return w.service.requestLocal(asked);
};

const localRequests = (w: World): CheckRequest[] =>
  [...w.checkStore.requests.values()].filter((r) => r.kind === "local")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

const pushOf = (w: World, over: Partial<ChangeRequestPush> = {}): ChangeRequestPush => ({
  connectedRepoId: w.api.id,
  ref: "42",
  headSha: HEAD,
  baseRef: "main",
  fetchRef: "refs/pull/42/head",
  url: "https://github.com/acme/api/pull/42",
  ...over,
});

test("a pushed branch is asked about as a local request, read at once, at the runless scope", async () => {
  const w = await quietWorld();
  const answer = await ask(w, { checks: ["lint", "test"] });
  assert(answer.kind === "requested");
  const { request, suite } = answer;
  assertEquals(
    [request.kind, request.state, request.userId, request.runId, request.patchId],
    ["local", "active", ADA.userId, null, null],
  );
  assertEquals([request.changeRequest, request.checksRef], [null, "main"]);
  const source = request.source as ForgeSource;
  assert(isForgeSource(source));
  assertEquals(source, {
    runId: null,
    changeRequest: null,
    fetchRef: "refs/heads/feat",
    branchName: "feat",
    baseRef: "main",
    url: null,
    checks: ["lint", "test"],
    askerName: "Ada",
  });
  // Read at the base within the call: the suite is named in the answer.
  assert(suite !== null);
  assertEquals(suite.state, "queued");
  // Naming every check is the full suite, and the suite keeps where the commit is and nothing
  // about who asked or what they named.
  assertEquals(suite.definition.partial, undefined);
  assertEquals(suite.source, {
    runId: null,
    changeRequest: null,
    fetchRef: "refs/heads/feat",
    branchName: "feat",
    baseRef: "main",
    url: null,
  });
  const expected = resolveNetworkScope(null, await liveCeiling(w.store, w.config.egress.policy));
  assert(expected.kind === "ok");
  assertEquals(suite.networkScope, expected.scope);
  assertEquals(suite.networkScope.hosts, [ALLOWED]);
  // Never reported by itself: no forge row, and nothing posted as it runs and settles.
  assertEquals([...w.checkStore.reports.values()], []);
  await w.service.tick();
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  assertEquals(w.reports, []);
});

test("the pull request opened on the same commit and base joins the settled suite and reports at once", async () => {
  const w = await quietWorld();
  await ask(w);
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.launched.specs.length, 1);
  assertEquals(w.reports, []);

  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "checks-requested");
  await w.service.tick();
  assertEquals(w.suites().length, 1, "joined, not claimed");
  assertEquals(w.launched.specs.length, 1, "no second pod");
  const push = [...w.checkStore.requests.values()].find((r) => r.kind === "push")!;
  assertEquals([push.state, push.suiteId], ["active", suite.id]);
  assertEquals(w.reports.length, 1);
  assertEquals(w.reports[0].suite.conclusion, "success");
  assertEquals(w.reports[0].checks.map((c) => c.conclusion), ["success", "success"]);
});

test("a partial local ask never stands in for the pull request's checks", async () => {
  const w = await quietWorld();
  await ask(w, { checks: ["lint"] });
  await w.service.tick();
  const partial = w.onlySuite();
  assertEquals(partial.definition.partial, true);
  w.launched.finish(w.nameOf(partial), { lint: 0 });
  await w.service.tick();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  assertEquals(w.suites().length, 2, "the push claims the full suite of its own");
  assert(w.reports.every((r) => r.suiteId !== partial.id));
});

test("an uploaded bundle is asked about as a user's bundle, and the gateway serves it by its key", async () => {
  const w = await quietWorld();
  const answer = await ask(w, { bundled: true, commit: OTHER, branch: "wip/x" });
  assert(answer.kind === "requested");
  const source = answer.request.source as LocalBundleSource;
  assert(isLocalBundleSource(source));
  assertEquals(source, {
    runId: null,
    userId: ADA.userId,
    bundleKey: await localBundleKey(ADA.userId, "wip/x", "main", w.api.id, OTHER),
    branchName: "wip/x",
    baseRef: "main",
    askerName: "Ada",
  });
  // The branch's key, then the base's, are each the first 16 hex of the sha256 of its name.
  assertEquals(
    source.bundleKey,
    `users/${ADA.userId}/e4158e7d1998f8cb/0d6e4079e36703eb/${w.api.id}/${OTHER}.bundle`,
  );
  assertEquals(w.headsAsked, [], "an upload proves itself: no branch head is read");
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.state, "running");
  const header = w.launched.specs[0].clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.replace("Authorization: Basic ", "")).split(":")[1];
  const grant = (await w.service.gitGrant(await sha256Hex(token)))!;
  assertEquals(grant.runId, suite.id);
  assertEquals(grant.repos[0].candidate, {
    headSha: OTHER,
    branchName: "wip/x",
    bundleKey: source.bundleKey,
  });
  assertEquals(grant.repos[0].ref, "main");
});

test("the same ask again answers the request standing; a newer commit on the branch supersedes it", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested");
  const again = await ask(w);
  assert(again.kind === "requested");
  assertEquals(again.request.id, first.request.id);
  assertEquals(localRequests(w).length, 1);
  // A base that is no branch of the repo is judged by the default branch: the same ask.
  const odd = await ask(w, { base: "refs/pull/7/head" });
  assert(odd.kind === "requested");
  assertEquals(odd.request.id, first.request.id);

  // Another person's ask on a branch of the same name, and the same person's on another branch,
  // are theirs alone.
  w.clock.advance(1_000);
  await ask(w, { user: GRACE, commit: THIRD });
  w.clock.advance(1_000);
  await ask(w, { branch: "other", commit: THIRD });
  w.clock.advance(1_000);
  const old = first.suite!;
  const newer = await ask(w, { commit: OTHER });
  assert(newer.kind === "requested");
  assertEquals(
    localRequests(w).map((r) => [r.userId, r.source.branchName, r.commit.slice(0, 1), r.state]),
    [
      ["u-1", "feat", "d", "superseded"],
      ["u-2", "feat", "f", "active"],
      ["u-1", "other", "f", "active"],
      ["u-1", "feat", "e", "active"],
    ],
  );
  assertEquals((await w.checkStore.getSuite(old.id))!.state, "cancelled");
});

test("another base or another set of checks on the same commit is a new ask that replaces the first", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  w.files.set("release", structuredClone(w.files.get("*")!));
  const full = await ask(w);
  assert(full.kind === "requested");
  const partial = await ask(w, { checks: ["lint"] });
  assert(partial.kind === "requested");
  assert(partial.request.id !== full.request.id);
  assertEquals((await w.checkStore.getRequest(full.request.id))!.state, "superseded");
  assertEquals(partial.suite!.definition.partial, true);
  const released = await ask(w, { base: "release", checks: ["lint"] });
  assert(released.kind === "requested");
  assertEquals(released.request.checksRef, "release");
  assertEquals((await w.checkStore.getRequest(partial.request.id))!.state, "superseded");
});

test("the same ask on a suite that was cancelled or could not run runs it again", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested");
  const stored = w.checkStore.suites.get(first.suite!.id)!;
  stored.state = "error";
  stored.reason = "the platform could not run it";
  const again = await ask(w);
  assert(again.kind === "requested");
  assert(again.request.id !== first.request.id);
  assertEquals((await w.checkStore.getRequest(first.request.id))!.state, "superseded");
  assertEquals(again.suite!.id, first.suite!.id);
  assertEquals([again.suite!.state, again.suite!.generation], ["queued", 2]);
});

/** A person's ask run to its end, each check exiting as given: its suite, settled. */
const ranLocal = async (
  w: World,
  exits: Record<string, number>,
  over: Partial<LocalChecksInput> = {},
) => {
  const asked = await ask(w, over);
  assert(asked.kind === "requested");
  await w.service.tick();
  w.launched.finish(w.nameOf(w.checkStore.suites.get(asked.suite!.id)!), exits);
  await w.service.tick();
  return w.checkStore.suites.get(asked.suite!.id)!;
};

test("the same ask on a suite that failed retries its failures", async () => {
  const w = await quietWorld();
  const failed = await ranLocal(w, { lint: 0, test: 1 });
  assertEquals(failed.state, "failed");
  const [first] = localRequests(w);

  const again = await ask(w);
  assert(again.kind === "requested");
  assert(again.request.id !== first.id);
  assertEquals((await w.checkStore.getRequest(first.id))!.state, "superseded");
  assertEquals([again.suite!.id, again.suite!.generation], [failed.id, 2]);
  const rows = await w.checkStore.listResults(failed.id, 2);
  assertEquals(rows.map((r) => [r.name, r.state]), [["lint", "passed"], ["test", "queued"]]);
});

test("a delegated ask of a failed suite retries it only when its sender's ask would", async () => {
  const w = await quietWorld();
  const failed = await ranLocal(w, { lint: 0, test: 1 }, { delegationId: "a:run-1" });
  assertEquals(failed.state, "failed");

  // The same sender request again, flag or none: its own answer, nothing run.
  const resent = await ask(w, { delegationId: "a:run-1", retryFailed: true });
  assert(resent.kind === "requested");
  assertEquals(resent.request.id, localRequests(w)[0].id);
  // A patch's or a push's ask upstream reads the failure.
  const reads = await ask(w, { delegationId: "a:patch-1" });
  assert(reads.kind === "requested");
  assertEquals(w.checkStore.suites.get(failed.id)!.generation, 1);
  assertEquals([reads.suite!.id, reads.suite!.state], [failed.id, "failed"]);

  // A run's or a person's ask upstream retries it.
  const retries = await ask(w, { delegationId: "a:run-2", retryFailed: true });
  assert(retries.kind === "requested");
  assertEquals([retries.suite!.id, retries.suite!.generation], [failed.id, 2]);
  // What the asker wants of a failure is the request's, never the suite's.
  assertEquals("retryFailed" in retries.suite!.source, false);
  assertEquals(
    await w.checkStore.listResults(failed.id, 2).then((rows) => rows.map((r) => r.state)),
    [
      "passed",
      "queued",
    ],
  );
});

test("a person has at most so many asks going on other branches; re-asking on one never counts", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0, maxLocalPerUser: 2 } });
  assert((await ask(w, { branch: "a" })).kind === "requested");
  assert((await ask(w, { branch: "b", commit: OTHER })).kind === "requested");
  assertEquals(await w.service.localQuota(ADA.userId, w.api.id, "c"), { live: 2, max: 2 });
  assertEquals(await w.service.localQuota(ADA.userId, w.api.id, "a"), { live: 1, max: 2 });
  assertEquals(await ask(w, { branch: "c", commit: THIRD }), { kind: "quota", live: 2, max: 2 });
  // The same branch again, a newer commit: it replaces the one it counts.
  assert((await ask(w, { branch: "a", commit: THIRD })).kind === "requested");
  // Someone else's asks are theirs.
  assert((await ask(w, { user: GRACE, branch: "c" })).kind === "requested");

  // An ask whose suite settled costs nothing any more, though it stands for its day.
  const v = await quietWorld({ policy: { maxLocalPerUser: 1 } });
  await ask(v, { branch: "a" });
  assertEquals((await ask(v, { branch: "b", commit: OTHER })).kind, "quota");
  await v.service.tick();
  v.launched.finish(v.nameOf(v.onlySuite()), { lint: 0, test: 1 });
  await v.service.tick();
  assertEquals(v.onlySuite().state, "failed");
  assert((await ask(v, { branch: "b", commit: OTHER })).kind === "requested");
});

test("a local ask runs out after a day: a suite still going is cancelled, a settled one stays", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const going = await ask(w);
  assert(going.kind === "requested");
  await w.service.tick();
  w.clock.advance(LOCAL_REQUEST_TTL_MS - 60_000);
  await w.service.tick();
  assertEquals((await w.checkStore.getRequest(going.request.id))!.state, "active", "not yet");
  w.clock.advance(2 * 60_000);
  await w.service.tick();
  assertEquals((await w.checkStore.getRequest(going.request.id))!.state, "superseded");
  assertEquals((await w.checkStore.getSuite(going.suite!.id))!.state, "cancelled");

  const v = await quietWorld();
  const settled = await ask(v);
  assert(settled.kind === "requested");
  await v.service.tick();
  v.launched.finish(v.nameOf(v.onlySuite()), { lint: 0, test: 0 });
  await v.service.tick();
  v.clock.advance(LOCAL_REQUEST_TTL_MS + 60_000);
  await v.service.tick();
  assertEquals((await v.checkStore.getRequest(settled.request.id))!.state, "superseded");
  assertEquals(v.onlySuite().state, "passed");
});

test("a suite a pull request's push also wants outlives the local ask that started it", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested");
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  await ask(w, { commit: OTHER });
  assertEquals((await w.checkStore.getRequest(first.request.id))!.state, "superseded");
  assertEquals((await w.checkStore.getSuite(first.suite!.id))!.state, "queued");
});

test("a base the forge does not answer in time leaves the ask pending for the tick", async () => {
  const w = await quietWorld({ answerWithinMs: 5 });
  const read = w.forge.readChecksFile;
  let answer: () => void = () => {};
  w.forge.readChecksFile = (...args) => new Promise((done) => (answer = () => done(read(...args))));
  const pending = await ask(w);
  assert(pending.kind === "requested");
  assertEquals([pending.request.state, pending.suite], ["pending", null]);
  // The call that made it is still reading it: the tick leaves it alone until its backstop.
  assert(pending.request.nextAttemptAt! > w.clock.now().toISOString());
  answer();
  await w.checksService.idle();
  const stood = (await w.checkStore.getRequest(pending.request.id))!;
  assertEquals(stood.state, "active");
  assert(stood.suiteId !== null);
});

test("a check the base does not declare refuses the ask, with the reason", async () => {
  const w = await quietWorld();
  const answer = await ask(w, { checks: ["nope"] });
  assert(answer.kind === "requested");
  assertEquals(answer.request.state, "refused");
  assertStringIncludes(answer.request.note!, "nope is not a check");
  assertEquals(answer.suite, null);
  assertEquals(w.suites(), []);
});

test("local asks off: nothing is filed", async () => {
  const w = await quietWorld({ policy: { local: false } });
  assertEquals(w.service.local, false);
  assertEquals(await ask(w), { kind: "off" });
  assertEquals(localRequests(w), []);
});

test("a local suite re-runs from where its commit was, at the runless scope", async () => {
  const w = await quietWorld();
  await ask(w, { bundled: true });
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 1, test: 0 });
  await w.service.tick();
  const outcome = await w.service.rerun(suite.id, { kind: "user", userId: ADA.userId });
  assert(outcome.kind === "rerun");
  assertEquals(outcome.suite.generation, 2);
  assertEquals(outcome.suite.source, suite.source);
  assertEquals(outcome.suite.networkScope.hosts, [ALLOWED]);
});

test("a clone that failed on a person's bundle retries on a pull request's head of it", async () => {
  const w = await quietWorld();
  await ask(w, { bundled: true });
  await w.service.tick();
  const suite = w.onlySuite();
  assert(isLocalBundleSource(suite.source));
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  assertEquals(w.suites().length, 1, "the push joined it");
  w.launched.inspections.set(w.nameOf(suite), {
    kind: "setup_failed",
    cloneDone: false,
    step: "clone",
    exitCode: 128,
    why: "the candidate was not served",
  });
  await w.service.tick();
  const retried = w.onlySuite();
  assertEquals(retried.state, "queued");
  assert(isForgeSource(retried.source));
  assertEquals((retried.source as ForgeSource).fetchRef, "refs/pull/42/head");
});

// ---- the routes -----------------------------------------------------------------------------

type Caller = {
  kind: "user";
  userId: string;
  name: string;
  role: "viewer" | "member" | "operator";
};

async function app(
  opts: {
    caller?: Caller | { kind: "break-glass" };
    /** Per forge login; anyone unnamed is allowed. */
    permission?: Record<string, ForgePermission>;
    world?: Parameters<typeof checksWorld>[0];
    checks?: boolean;
    githubMode?: GithubMode;
  } = {},
) {
  const w = await quietWorld(opts.world);
  const identities = fakeIdentityDirectory();
  identities.link("u-1", "ada");
  identities.link("u-2", "grace");
  identities.link("u-3", "linus");
  const permission = { ...opts.permission };
  w.forge.checkPermission = (_repo, who) =>
    Promise.resolve(permission[who.subject ?? ""] ?? "allowed");
  const caller = { current: opts.caller ?? { kind: "user", ...ADA, role: "member" } as Caller };
  const principal = (): Principal =>
    caller.current.kind === "break-glass" ? { kind: "break-glass" } : {
      kind: "user",
      userId: caller.current.userId,
      email: `${caller.current.userId}@example.com`,
      name: caller.current.name,
      caps: capsClaimOf(caller.current.role),
      emailVerified: true,
      sid: "s-1",
      via: "token",
    };
  const handler = makeHandler({
    store: w.store,
    provisioner: w.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    authenticate: (() => Promise.resolve(principal())) as unknown as Authenticate,
    forge: w.forge,
    ...(opts.githubMode
      ? {
        githubMode: {
          current: () => opts.githubMode,
          get: () => Promise.resolve(opts.githubMode!),
        },
      }
      : {}),
    identityDirectory: identities.directory,
    environments: w.environmentService,
    checks: opts.checks === false ? null : w.checksService,
    checksAwaiting: opts.checks === false ? null : w.checksAwaiting,
    now: w.clock.now,
    config: { ...imageConfig(), ...w.config },
  });
  const call = async (method: string, path: string, body?: unknown) =>
    await handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const askJson = async (body: Record<string, unknown> = {}, opts: { pushed?: boolean } = {}) => {
    const sent = { repo: w.api.repoRef, commit: HEAD, branch: "feat", ...body };
    if (
      opts.pushed !== false && typeof sent.branch === "string" && typeof sent.commit === "string"
    ) {
      w.heads.set(sent.branch.replace(/^refs\/heads\//, ""), { kind: "head", sha: sent.commit });
    }
    const res = await call("POST", "/v1/check-suites", sent);
    return { status: res.status, body: await res.json() };
  };
  const upload = async (
    query: string,
    body: ReadableStream<Uint8Array> | null = new Blob([new Uint8Array([1, 2, 3])]).stream(),
    delegated = false,
  ) => {
    const res = await handler(
      new Request(
        `http://orchestrator.test/v1/${
          delegated ? "check-delegations" : "check-suites"
        }/bundle?${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream", authorization: "Bearer t" },
          body,
        },
      ),
    );
    return { status: res.status, body: await res.json() };
  };
  const as = (next: Caller | { kind: "break-glass" }) => {
    caller.current = next as Caller;
  };
  return { ...w, call, askJson, upload, as, permission };
}

const MEMBER = (who: { userId: string; name: string }): Caller => ({
  kind: "user",
  ...who,
  role: "member",
});

test("the routes' gates, in order: capability, off, body, repo, write, a person, the cap", async () => {
  // A viewer holds no checks:request, and is told so before anything is read.
  const viewer = await app({ caller: { kind: "user", ...ADA, role: "viewer" } });
  const refused = await viewer.askJson();
  assertEquals(refused.status, 403);
  assertEquals(refused.body.capability, "checks:request");
  assertEquals((await viewer.upload(`repo=acme/api&branch=feat`)).status, 403);

  // Checks off, or local asks off: the routes are not there.
  assertEquals((await (await app({ checks: false })).askJson()).status, 404);
  const off = await app({ world: { policy: { local: false } } });
  assertEquals((await off.askJson()).status, 404);
  assertEquals((await off.upload(`repo=acme/api&branch=feat`)).status, 404);

  const a = await app();
  assertEquals((await a.askJson({ commit: "nope" })).status, 400);
  assertEquals((await a.askJson({ branch: "-x" })).status, 400);
  assertEquals((await a.askJson({ checks: ["Not A Check"] })).status, 400);
  assertEquals((await a.askJson({ repo: "acme/nope" })).body, { error: "no such repo" });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-old",
    repoRef: "acme/old",
    archivedAt: T0,
  });
  const archived = await a.askJson({ repo: "acme/old" });
  assertEquals(archived.status, 409);
  assertEquals(archived.body.code, undefined, "only a branch head's 409 carries the code");

  // Write on the repo, asked live through the caller's linked identity.
  a.permission.ada = "denied";
  const denied = await a.askJson();
  assertEquals(denied.status, 403);
  assertStringIncludes(denied.body.error, "@ada does not have write");
  a.as(MEMBER({ userId: "u-9", name: "Nobody" }));
  assertStringIncludes((await a.askJson()).body.error, "link your GitHub account");

  // Break-glass has no person behind it to ask for, or to show the suite to.
  a.as({ kind: "break-glass" });
  assertEquals((await a.askJson()).status, 403);
  assertEquals(localRequests(a), []);
});

test("delegation routes validate identity and preserve local authorization gates", async () => {
  const sent = { repo: "acme/api", branch: "feat", commit: HEAD };
  const a = await app();
  for (const delegationId of [undefined, "", "bad/id", "x".repeat(257)]) {
    assertEquals(
      (await a.call("POST", "/v1/check-delegations", { ...sent, delegationId })).status,
      400,
    );
  }
  for (
    const extra of [{ force: true }, { image: "sender/image" }, { config: {} }, {
      retryFailed: "yes",
    }]
  ) {
    assertEquals(
      (await a.call("POST", "/v1/check-delegations", {
        ...sent,
        delegationId: "a:run",
        ...extra,
      })).status,
      400,
    );
  }
  assertEquals((await a.upload("repo=acme/api&branch=feat", undefined, true)).status, 400);
  assertEquals(
    (await a.upload("repo=acme/api&branch=feat&delegationId=a&delegationId=b", undefined, true))
      .status,
    400,
  );
  for (const retry of ["retryFailed=yes", "retryFailed=true&retryFailed=true"]) {
    assertEquals(
      (await a.upload(`repo=acme/api&branch=feat&delegationId=a&${retry}`, undefined, true))
        .status,
      400,
    );
  }
  assertEquals(localRequests(a), []);
  a.permission.ada = "denied";
  assertEquals(
    (await a.call("POST", "/v1/check-delegations", { ...sent, delegationId: "a:run" })).status,
    403,
  );
  assertEquals(
    (await a.upload("repo=acme/api&branch=feat&delegationId=a:run", undefined, true)).status,
    403,
  );
  a.as({ kind: "break-glass" });
  assertEquals(
    (await a.call("POST", "/v1/check-delegations", { ...sent, delegationId: "a:run" })).status,
    403,
  );
  const off = await app({ checks: false });
  assertEquals((await off.call("POST", "/v1/check-delegations", sent)).status, 404);
});

test("remote-configured receivers reject delegation chains before staging uploads or filing requests", async () => {
  const a = await app();
  Object.defineProperty(a.checksService, "remote", { value: true });
  let staged = false;
  a.forge.stageCheckBundle = () => {
    staged = true;
    throw new Error("must not stage");
  };
  // Even malformed metadata is not inspected on a receiver that delegates elsewhere.
  assertEquals((await a.call("POST", "/v1/check-delegations", {})).status, 409);
  assertEquals((await a.upload("", undefined, true)).status, 409);
  assertEquals(staged, false);
  assertEquals(localRequests(a), []);
  assertEquals((await a.checksService.localUploads(ADA.userId)).used, 0);
  a.as({ kind: "user", ...ADA, role: "viewer" });
  assertEquals((await a.call("POST", "/v1/check-delegations", {})).status, 403);
});

test("delegation cancellation authenticates the owner and never exposes another person's request", async () => {
  const a = await app();
  const calls: Array<[string, string]> = [];
  a.checksService.cancelDelegation = (id, userId) => {
    calls.push([id, userId]);
    return Promise.resolve(id === "cq-owned" && userId === ADA.userId);
  };
  const cancel = (id: string) => a.call("DELETE", `/v1/check-delegations/${id}`);
  const response = await cancel("cq-owned");
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
  assertEquals((await cancel("cq-owned")).status, 204, "idempotent cancellation");
  assertEquals((await cancel("cq-missing")).status, 404);
  a.as(MEMBER(GRACE));
  assertEquals((await cancel("cq-owned")).status, 404);
  assertEquals(calls.at(-1), ["cq-owned", GRACE.userId]);
  const count = calls.length;
  a.as({ kind: "user", ...ADA, role: "viewer" });
  assertEquals((await cancel("cq-owned")).status, 403);
  a.as({ kind: "break-glass" });
  assertEquals((await cancel("cq-owned")).status, 404);
  assertEquals(calls.length, count, "non-person callers cannot withdraw another person's request");
});

test("delegation declarations read the receiver's selected base behind live write gates, without quota", async () => {
  const a = await app({ world: { policy: { maxLocalPerUser: 1 } } });
  await a.askJson();
  const path = "/v1/check-delegations/declaration?repo=acme/api";
  a.reads.length = 0;
  const selected = await a.call("GET", `${path}&base=refs/heads/release`);
  assertEquals(selected.status, 200);
  assertEquals((await selected.json()).kind, "file");
  assertEquals(a.reads, ["release"]);
  a.reads.length = 0;
  assertEquals((await a.call("GET", path)).status, 200);
  assertEquals(a.reads, ["main"]);
  assertEquals(localRequests(a).length, 1, "reading declarations creates no request");
  assertEquals((await a.call("GET", `${path}&base=refs/pull/1/head`)).status, 400);
  assertEquals((await a.call("GET", `${path}&base=HEAD`)).status, 400);
  assertEquals((await a.call("GET", "/v1/check-delegations/declaration")).status, 400);
  a.reads.length = 0;
  a.permission.ada = "denied";
  assertEquals((await a.call("GET", path)).status, 403);
  assertEquals(a.reads, []);
  a.as({ kind: "break-glass" });
  assertEquals((await a.call("GET", path)).status, 403);
  a.as({ kind: "user", ...ADA, role: "viewer" });
  assertEquals((await a.call("GET", path)).status, 403);
  a.as(MEMBER(ADA));
  Object.defineProperty(a.checksService, "remote", { value: true });
  assertEquals((await a.call("GET", path)).status, 409);
  assertEquals(a.reads, []);
});

test("delegation snapshots expose receiver execution state only to the PAT owner", async () => {
  const a = await app();
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const response = await a.call("POST", "/v1/check-delegations", {
    repo: a.api.repoRef,
    branch: "feat",
    commit: HEAD,
    delegationId: "source:run-snapshot",
  });
  assertEquals(response.status, 201);
  const submitted = await response.json();
  const path = `/v1/check-delegations/${submitted.request.id}`;
  const own = await a.call("GET", path);
  assertEquals(own.status, 200);
  const snapshot = await own.json();
  assertEquals(snapshot.requestId, submitted.request.id);
  assertEquals(snapshot.suite.id, submitted.suite.id);
  assertEquals(snapshot.suite.generation, 1);
  assertEquals(snapshot.suite.remote, undefined);
  assert(Array.isArray(snapshot.results));
  const longTail = "x".repeat(4 * 1024 * 1024) + "last output";
  await a.checkStore.upsertResults([{
    suiteId: submitted.suite.id,
    generation: snapshot.suite.generation,
    name: "test",
    state: "passed",
    exitCode: 0,
    startedAt: null,
    finishedAt: null,
    logKey: null,
    logTail: longTail,
    watchedChanged: null,
    forgeRef: null,
    inheritedFrom: null,
  }]);
  const bounded = await (await a.call("GET", path)).json();
  assertEquals(
    bounded.results.find((result: { name: string }) => result.name === "test").logTail,
    longTail.slice(-16_384),
  );
  assertEquals(
    (await a.checkStore.listResults(submitted.suite.id, snapshot.suite.generation))
      .find((result) => result.name === "test")!.logTail,
    longTail,
    "polling does not truncate stored logs",
  );
  const ordinary = await a.askJson({ branch: "ordinary" });
  assertEquals(
    (await a.call("GET", `/v1/check-delegations/${ordinary.body.request.id}`)).status,
    404,
  );
  assertEquals((await a.call("GET", "/v1/check-delegations/missing")).status, 404);
  a.as(MEMBER(GRACE));
  assertEquals((await a.call("GET", path)).status, 404);
  a.as({ kind: "user", userId: "operator", name: "Operator", role: "operator" });
  assertEquals((await a.call("GET", path)).status, 404, "read-all does not grant snapshot access");
  a.as({ kind: "break-glass" });
  assertEquals((await a.call("GET", path)).status, 404);
  a.as({ kind: "user", ...ADA, role: "viewer" });
  assertEquals((await a.call("GET", path)).status, 403);
});

test("delegation snapshots reject remote-backed suites but retain reads of old local execution", async () => {
  const a = await app();
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const submitted = await a.call("POST", "/v1/check-delegations", {
    repo: a.api.repoRef,
    branch: "feat",
    commit: HEAD,
    delegationId: "source:old-local",
  });
  assertEquals(submitted.status, 201);
  const body = await submitted.json();
  const path = `/v1/check-delegations/${body.request.id}`;
  const local = (await a.checkStore.getSuite(body.suite.id))!;
  a.checkStore.suites.set(local.id, {
    ...local,
    remote: { endpoint: "https://other.test", requestId: "cq-other", suiteId: "cs-other" },
  });
  const refused = await a.call("GET", path);
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).suite, undefined);
  a.checkStore.suites.set(local.id, local);
  Object.defineProperty(a.checksService, "remote", { value: true });
  assertEquals(
    (await a.call("GET", path)).status,
    200,
    "old local suites remain readable after reconfiguration",
  );
});

test("pushed delegation forwards identity, verifies head, and polls under PAT ownership", async () => {
  const a = await app();
  const original = a.checksService.requestLocal.bind(a.checksService);
  const inputs: LocalChecksInput[] = [];
  a.checksService.requestLocal = (input) => {
    inputs.push(input);
    return original(input);
  };
  const sent = {
    repo: a.api.repoRef,
    branch: "refs/heads/feat",
    commit: HEAD,
    delegationId: "source:run-1",
  };
  assertEquals((await a.call("POST", "/v1/check-delegations", sent)).status, 409);
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const response = await a.call("POST", "/v1/check-delegations", sent);
  assertEquals(response.status, 201);
  const body = await response.json();
  assertEquals(inputs.at(-1)!.delegationId, sent.delegationId);
  assertEquals(inputs.at(-1)!.retryFailed, false);
  assertEquals(inputs.at(-1)!.branch, "feat");
  assertEquals(inputs.at(-1)!.user.userId, ADA.userId);
  // A sender's run or person asked: a failed suite this joins retries its failures.
  await a.call("POST", "/v1/check-delegations", { ...sent, retryFailed: true });
  assertEquals(inputs.at(-1)!.retryFailed, true);
  assertEquals((await a.call("GET", `/v1/check-requests/${body.request.id}`)).status, 200);
  a.as(MEMBER(GRACE));
  assertEquals((await a.call("GET", `/v1/check-requests/${body.request.id}`)).status, 404);
});

test("bundle delegation stages an unpushed head and forwards identity without branch-head lookup", async () => {
  const a = await app();
  const original = a.checksService.requestLocal.bind(a.checksService);
  let input: LocalChecksInput | undefined;
  a.checksService.requestLocal = (asked) => {
    input = asked;
    return original(asked);
  };
  a.forge.stageCheckBundle = async (_repo, _url, _ask, body) => {
    await body.cancel();
    return {
      kind: "staged",
      headSha: OTHER,
      bundleKey: await localBundleKey(ADA.userId, "feat", "main", a.api.id, OTHER),
    };
  };
  const answer = await a.upload(
    "repo=acme/api&branch=feat&delegationId=source:run-2&check=lint&retryFailed=true",
    undefined,
    true,
  );
  assertEquals(answer.status, 201);
  assertEquals(input?.delegationId, "source:run-2");
  assertEquals(input?.retryFailed, true);
  assertEquals(input?.commit, OTHER);
  assertEquals(input?.bundled, true);
  assertEquals(input?.checks, ["lint"]);
  assertEquals(a.headsAsked, []);
});

test("a pushed ask answers 201 with the suite, by repo id or case-blind address", async () => {
  const a = await app();
  const first = await a.askJson({ repo: "ACME/Api" });
  assertEquals(first.status, 201);
  assertEquals(first.body.request.state, "active");
  assert(first.body.request.id.startsWith("cq-"));
  assertEquals(first.body.request.suiteId, first.body.suite.id);
  assertEquals(first.body.suite.state, "queued");
  assertEquals(first.body.suite.requestedBy, [{ kind: "local", runId: null, patchId: null }]);
  const again = await a.askJson({ repo: a.api.id });
  assertEquals(again.status, 201);
  assertEquals(again.body.request.id, first.body.request.id, "the same ask, idempotently");
});

test("an ask by address skips a newer row of the other GitHub mode, left from a switch", async () => {
  const a = await app({ githubMode: { mode: "app", signIn: true } });
  // App → user → App: the user-mode row of the same repo is live, and newer.
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-user-leftover",
    installationId: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  const asked = await a.askJson({ repo: a.api.repoRef });
  assertEquals(asked.status, 201);
  assertEquals(asked.body.suite.connectedRepoId, a.api.id);
});

test("an address on GitHub and GitLab at once is read on the remote's host, never guessed", async () => {
  const a = await app();
  a.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: { mode: "app", signIn: true },
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://GitLab.example.com:8443",
        url: "https://GitLab.example.com:8443",
        signIn: false,
      },
      radicle: null,
    });
  // The same owner/name as a GitLab project, connected later and live: the newest live row.
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gitlab-twin",
    provider: "gitlab",
    installationId: null,
    url: "https://gitlab.example.com:8443/acme/api.git",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  // Connected on the forge's own instance: its id is GitLab's there.
  await a.store.createGitlabProject(
    "cr-gitlab-twin",
    "7",
    "https://GitLab.example.com:8443",
    "2030-01-01T00:00:00.000Z",
  );
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const ask = async (query: string) => {
    const res = await a.call("POST", `/v1/check-suites${query}`, {
      repo: "acme/api",
      commit: HEAD,
      branch: "feat",
    });
    return { status: res.status, body: await res.json() };
  };
  // No host: two forges, so a refusal that says so rather than either repo.
  const unsaid = await ask("");
  assertEquals(unsaid.status, 409);
  assertStringIncludes(unsaid.body.error, "github and gitlab");
  // github.com is GitHub's row, whichever is newer.
  const onGithub = await ask("?host=github.com");
  assertEquals(onGithub.status, 201);
  assertEquals(onGithub.body.suite.connectedRepoId, a.api.id);
  // The deployment's GitLab host, port and all, is GitLab's.
  const onGitlab = await ask("?host=gitlab.example.com:8443");
  // (The GitLab row's own gate answers: Ada has linked no GitLab account.)
  assertEquals(onGitlab.status, 403);
  assertStringIncludes(onGitlab.body.error, "GitLab");
  // Any other host breaks no tie: still two forges.
  assertEquals((await ask("?host=gitlab.com")).status, 409);
  // An id names one row, host or not.
  const byId = await a.call("POST", "/v1/check-suites", {
    repo: "cr-gitlab-twin",
    commit: HEAD,
    branch: "feat",
  });
  assertEquals(byId.status, 403);
  // The bundle route reads the same host.
  assertEquals((await a.upload("repo=acme%2Fapi&branch=feat")).status, 409);
});

test("an ask by address skips a GitLab row connected on another instance", async () => {
  const a = await app();
  a.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: { mode: "app", signIn: true },
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example.com",
        url: "https://gitlab.example.com",
        signIn: false,
      },
      radicle: null,
    });
  // Live and newer, but its project id is the old instance's: nobody's here.
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gitlab-old",
    provider: "gitlab",
    installationId: null,
    url: "https://gitlab.old.example/acme/api.git",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  await a.store.createGitlabProject(
    "cr-gitlab-old",
    "7",
    "https://gitlab.old.example",
    "2030-01-01T00:00:00.000Z",
  );
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const res = await a.call("POST", "/v1/check-suites", {
    repo: "acme/api",
    commit: HEAD,
    branch: "feat",
  });
  assertEquals(res.status, 201, await res.clone().text());
  assertEquals((await res.json()).suite.connectedRepoId, a.api.id);
});

test("a host breaks a tie only: a remote on a host no forge is known by still finds its repo", async () => {
  const a = await app();
  a.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: { mode: "app", signIn: true },
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example.com:8443",
        url: "https://gitlab.example.com:8443",
        signIn: false,
      },
      radicle: null,
    });
  // A GitLab project of its own, under another address.
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gitlab-web",
    provider: "gitlab",
    repoRef: "acme/sub/web",
    installationId: null,
    url: "https://gitlab.example.com:8443/acme/sub/web.git",
  });
  // Connected on the forge's own instance: its id is GitLab's there.
  await a.store.createGitlabProject(
    "cr-gitlab-web",
    "7",
    "https://gitlab.example.com:8443",
    "2030-01-01T00:00:00.000Z",
  );
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const ask = async (repo: string, host: string) => {
    const res = await a.call("POST", `/v1/check-suites?${new URLSearchParams({ host })}`, {
      repo,
      commit: HEAD,
      branch: "feat",
    });
    return { status: res.status, body: await res.json() };
  };
  // GitHub remotes on hosts that are not github.com by name: an ssh alias, ssh over 443.
  for (const host of ["github-work", "ssh.github.com:443", "GitHub.com"]) {
    const asked = await ask("acme/api", host);
    assertEquals(asked.status, 201, host);
    assertEquals(asked.body.suite.connectedRepoId, a.api.id, host);
  }
  // GitLab remotes: ssh on another port, and a clone host the instance URL does not name.
  // (The GitLab row's own gate answers: Ada has linked no GitLab account.)
  for (const host of ["gitlab.example.com:2222", "git.example.com"]) {
    const asked = await ask("acme/sub/web", host);
    assertEquals(asked.status, 403, host);
    assertStringIncludes(asked.body.error, "GitLab", host);
  }
  // The delegated declaration read too, whose sender names its own GitLab's host.
  const declaration = await a.call(
    "GET",
    `/v1/check-delegations/declaration?${new URLSearchParams({
      repo: "acme/sub/web",
      base: "main",
      host: "gitlab.internal:443",
    })}`,
  );
  assertEquals(declaration.status, 403);
});

test("a twin on two forges is told apart by its host, port and ssh name aside", async () => {
  const a = await app();
  a.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: { mode: "app", signIn: true },
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example.com:8443",
        url: "https://gitlab.example.com:8443",
        signIn: false,
      },
      radicle: null,
    });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gitlab-twin",
    provider: "gitlab",
    installationId: null,
    url: "https://gitlab.example.com:8443/acme/api.git",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  // Connected on the forge's own instance: its id is GitLab's there.
  await a.store.createGitlabProject(
    "cr-gitlab-twin",
    "7",
    "https://gitlab.example.com:8443",
    "2030-01-01T00:00:00.000Z",
  );
  a.heads.set("feat", { kind: "head", sha: HEAD });
  const ask = async (host: string) => {
    const res = await a.call("POST", `/v1/check-suites?${new URLSearchParams({ host })}`, {
      repo: "acme/api",
      commit: HEAD,
      branch: "feat",
    });
    return { status: res.status, body: await res.json() };
  };
  const ssh443 = await ask("ssh.github.com:443");
  assertEquals(ssh443.status, 201);
  assertEquals(ssh443.body.suite.connectedRepoId, a.api.id);
  // GitLab's ssh port is not its web port: the host is the same instance.
  const sshPort = await ask("gitlab.example.com:2222");
  assertEquals(sshPort.status, 403);
  assertStringIncludes(sshPort.body.error, "GitLab");
  // A host neither forge is known by cannot break the tie: refused as ambiguous, never guessed.
  const alias = await ask("github-work");
  assertEquals(alias.status, 409);
  assertStringIncludes(alias.body.error, "github and gitlab");
});

test("a delegated ask names its repo's host, so a twin on the other forge is no ambiguity", async () => {
  const a = await app();
  a.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: { mode: "app", signIn: true },
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example.com",
        url: "https://gitlab.example.com",
        signIn: false,
      },
      radicle: null,
    });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gitlab-twin",
    provider: "gitlab",
    installationId: null,
    url: "https://gitlab.example.com/acme/api.git",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  // Connected on the forge's own instance: its id is GitLab's there.
  await a.store.createGitlabProject(
    "cr-gitlab-twin",
    "7",
    "https://gitlab.example.com",
    "2030-01-01T00:00:00.000Z",
  );
  a.heads.set("feat", { kind: "head", sha: HEAD });
  // The sender's client, talking to this receiver.
  const sent: string[] = [];
  const remote = remoteChecksClient({ url: "https://receiver.example", token: "pat" }, {
    readBundle: () => Promise.resolve(null),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).slice("https://receiver.example/api".length);
      if (path === "/v1/auth/token") return Response.json({ accessToken: "t", expiresIn: 3600 });
      sent.push(path);
      return await a.call(
        init?.method ?? "GET",
        path,
        init?.body ? JSON.parse(String(init.body)) : undefined,
      );
    }) as typeof fetch,
  });
  assertEquals((await remote.readChecksFile(a.api, "main")).kind, "file");
  const snapshot = await remote.submit({
    repo: a.api,
    request: {
      id: "cq-sender",
      suiteId: null,
      rerunOf: null,
      connectedRepoId: "cr-sender",
      commit: HEAD,
      runId: null,
      patchId: null,
      changeRequest: null,
      userId: "u-sender",
      kind: "local",
      state: "pending",
      note: null,
      source: {
        runId: null,
        branchName: "feat",
        baseRef: "main",
        changeRequest: null,
        fetchRef: null,
        url: null,
      },
      checksRef: "main",
      reportedGeneration: null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: T0,
      expiresAt: null,
    },
  });
  assertEquals(snapshot.suite?.connectedRepoId, a.api.id);
  assert(sent.every((p) => !p.startsWith("/v1/check-delegations?") || p.includes("host=")));
  assertStringIncludes(sent.join(" "), "/v1/check-delegations?host=github.com");
});

test("a person past their cap is answered 429; the same branch again is not", async () => {
  const a = await app({ world: { policy: { maxConcurrent: 0, maxLocalPerUser: 1 } } });
  assertEquals((await a.askJson()).status, 201);
  const capped = await a.askJson({ branch: "other", commit: OTHER });
  assertEquals(capped.status, 429);
  assertStringIncludes(capped.body.error, "RYPH_CHECKS_MAX_LOCAL_PER_USER");
  assertEquals((await a.upload(`repo=acme/api&branch=other`)).status, 429);
  assertEquals(a.forge.checkBundles, [], "refused before the upload is read");
  assertEquals((await a.askJson({ commit: OTHER })).status, 201);
});

test("an ask still being read answers 202, and its request reads back for its asker alone", async () => {
  const a = await app({ world: { answerWithinMs: 5 } });
  const read = a.forge.readChecksFile;
  let answer: () => void = () => {};
  a.forge.readChecksFile = (...args) => new Promise((done) => (answer = () => done(read(...args))));
  const pending = await a.askJson();
  assertEquals(pending.status, 202);
  assertEquals(pending.body.suite, null);
  assertEquals(pending.body.request.state, "pending");
  const id = pending.body.request.id;
  const get = async () => {
    const res = await a.call("GET", `/v1/check-requests/${id}`);
    return { status: res.status, body: await res.json() };
  };
  assertEquals((await get()).body, {
    request: { id, state: "pending", suiteId: null },
    suite: null,
  });
  answer();
  await a.checksService.idle();
  const resolved = await get();
  assertEquals(resolved.body.request.state, "active");
  assertEquals(resolved.body.suite.id, resolved.body.request.suiteId);

  // Someone else is told there is no such request; a reader of every task is not.
  a.as(MEMBER(GRACE));
  assertEquals((await get()).status, 404);
  a.as({ kind: "user", ...GRACE, role: "operator" });
  assertEquals((await get()).status, 200);
  // Only a local ask reads back here.
  await a.checksService.changeRequestPushed(pushOf(a));
  const push = [...a.checkStore.requests.values()].find((r) => r.kind === "push")!;
  assertEquals((await a.call("GET", `/v1/check-requests/${push.id}`)).status, 404);
  assertEquals((await a.call("GET", "/v1/check-requests/cq-nobody0000")).status, 404);
});

test("an ask the base refuses answers 422 with the reason", async () => {
  const a = await app();
  const refused = await a.askJson({ checks: ["nope"] });
  assertEquals(refused.status, 422);
  assertStringIncludes(refused.body.error, "nope is not a check");
  assertEquals(refused.body.request.state, "refused");
  assertStringIncludes(refused.body.request.reason, "nope is not a check");
});

test("a bundle is streamed to the forge under the user and filed on the head it answers", async () => {
  const a = await app();
  const res = await a.upload(`repo=acme/api&branch=refs/heads/wip&base=main&check=lint`);
  assertEquals(res.status, 201);
  const [staged] = a.forge.checkBundles;
  assertEquals(staged.ask, {
    connectedRepoId: a.api.id,
    userId: ADA.userId,
    branchName: "wip",
    baseRef: "main",
  });
  assertEquals([...staged.bytes], [1, 2, 3]);
  const request = (await a.checkStore.getRequest(res.body.request.id))!;
  assert(isLocalBundleSource(request.source));
  assertEquals(request.source.checks, ["lint"]);
  assertEquals(
    request.source.bundleKey,
    await localBundleKey(ADA.userId, "wip", "main", a.api.id, request.commit),
  );
  assertEquals(res.body.suite.commit, request.commit);
  // Without a base, the repo's default branch judges, and the forge verifies against it.
  await a.upload(`repo=acme/api&branch=wip2`);
  assertEquals(a.forge.checkBundles[1].ask.baseRef, "main");
});

test("the bundle route: every gate before a byte is read, and the forge's answers mapped", async () => {
  const a = await app({ permission: { ada: "denied" } });
  let pulled = false;
  const watched = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true;
      controller.close();
    },
  }, { highWaterMark: 0 });
  assertEquals((await a.upload(`repo=acme/api&branch=feat`, watched)).status, 403);
  assertEquals(pulled, false);
  assertEquals(a.forge.checkBundles, []);
  delete a.permission.ada;

  assertEquals((await a.upload(`branch=feat`)).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=a..b`)).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=feat&check=NO`)).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=feat`, null)).status, 400);

  const answers: StageCheckBundleOutcome[] = [
    { kind: "refused", status: 400, error: "bundle declares x", detail: "the prerequisites" },
    { kind: "refused", status: 413, error: "bundle exceeds the size limit", detail: null },
    { kind: "unavailable", error: "base cache unavailable" },
    { kind: "staged", headSha: OTHER, bundleKey: `users/u-1/elsewhere/${OTHER}.bundle` },
    // Filed under the right branch but another base than the ask's: misfiled too.
    {
      kind: "staged",
      headSha: OTHER,
      bundleKey: await localBundleKey(ADA.userId, "feat", "release", a.api.id, OTHER),
    },
  ];
  const statuses: number[] = [];
  for (const outcome of answers) {
    a.forge.stageCheckBundle = async (_repo, _url, _ask, body) => {
      await body.cancel();
      return outcome;
    };
    const res = await a.upload(`repo=acme/api&branch=feat`);
    statuses.push(res.status);
    if (outcome.kind === "refused" && outcome.detail !== null) {
      assertEquals(res.body, { error: "bundle declares x", detail: "the prerequisites" });
    }
  }
  assertEquals(statuses, [400, 413, 503, 503, 503]);
  assertEquals(localRequests(a), [], "nothing filed for a bundle that was not kept");
});

test("a local suite reads for its asker, a writer of its repo and a reader of everything", async () => {
  const a = await app();
  const asked = await a.askJson();
  const suiteId = asked.body.suite.id;
  a.launched.logs.set(`${a.nameOf(a.onlySuite())}/check-test`, "ok\n");
  await a.checksService.tick();
  a.launched.finish(a.nameOf(a.onlySuite()), { lint: 0, test: 0 });
  await a.checksService.tick();
  const read = async () => (await a.call("GET", `/v1/check-suites/${suiteId}`)).status;
  const log = async () =>
    (await a.call("GET", `/v1/check-suites/${suiteId}/log?generation=1&check=test`)).status;
  const listed = async () =>
    (await (await a.call("GET", "/v1/check-suites?asked=local")).json()).suites;

  // The asker, even with write taken away since.
  a.permission.ada = "denied";
  assertEquals([await read(), await log()], [200, 200]);
  const [row] = await listed();
  assertEquals(row.branch, "feat");
  assertEquals(row.askedBy, [{ kind: "local", label: "Ada · local", href: null }]);

  // Another member without write on the repo sees nothing; one with it sees it all.
  a.as(MEMBER({ userId: "u-3", name: "Linus" }));
  a.permission.linus = "denied";
  assertEquals([await read(), await log()], [404, 404]);
  assertEquals(await listed(), []);
  a.as(MEMBER(GRACE));
  assertEquals([await read(), await log()], [200, 200]);
  assertEquals((await listed()).length, 1);
  a.as({ kind: "user", userId: "u-4", name: "Op", role: "operator" });
  assertEquals(await read(), 200);
});

test("a push's suite now reads for a writer of its repo, not only for a reader of everything", async () => {
  const a = await app({ caller: MEMBER(GRACE) });
  await a.checksService.changeRequestPushed(pushOf(a));
  await a.checksService.tick();
  const suite = a.onlySuite();
  assertEquals((await a.call("GET", `/v1/check-suites/${suite.id}`)).status, 200);
  const list = await (await a.call("GET", "/v1/check-suites?asked=push")).json();
  assertEquals(list.suites.length, 1);
  a.as(MEMBER({ userId: "u-3", name: "Linus" }));
  a.permission.linus = "denied";
  assertEquals((await a.call("GET", `/v1/check-suites/${suite.id}`)).status, 404);
});

// ---- review round: keys per branch, the pushed head proven, renewals, races, the upload cap --

test("a bundle's key names its branch: the same commit on two branches is two bundles", async () => {
  // The forge's own vectors: the first 16 hex of the sha256 of the branch's name.
  assertEquals(
    await localBundleKey("u-1", "feature/fast-path", "main", "cr-1", OTHER),
    `users/u-1/39209061847d9847/0d6e4079e36703eb/cr-1/${OTHER}.bundle`,
  );
  assertEquals(
    await localBundleKey("u-1", "second", "main", "cr-1", OTHER),
    `users/u-1/16367aacb67a4a01/0d6e4079e36703eb/cr-1/${OTHER}.bundle`,
  );
  // And its base: the same commit on one branch against two bases is two bundles, since each
  // one's prerequisites were proven against its own base only.
  assertEquals(
    await localBundleKey("u-1", "second", "release", "cr-1", OTHER),
    `users/u-1/16367aacb67a4a01/a4d451ec23463726/cr-1/${OTHER}.bundle`,
  );
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const one = await ask(w, { bundled: true, commit: OTHER, branch: "feature/fast-path" });
  const two = await ask(w, { bundled: true, commit: OTHER, branch: "second" });
  assert(one.kind === "requested" && two.kind === "requested");
  const keyOf = (r: CheckRequest) => (r.source as LocalBundleSource).bundleKey;
  assert(keyOf(one.request) !== keyOf(two.request));
  // One suite (the source is not its identity), wanted by both.
  assertEquals(one.suite!.id, two.suite!.id);
  assertEquals(localRequests(w).map((r) => r.state), ["active", "active"]);
  // The first branch moves on: the suite stays for the second, and launches from a bundle that
  // is still there (the first's is never deleted, and a failed clone takes the second's).
  await ask(w, { bundled: true, commit: THIRD, branch: "feature/fast-path" });
  const shared = (await w.checkStore.getSuite(one.suite!.id))!;
  assertEquals(shared.state, "queued");
  assert(isLocalBundleSource(shared.source));
  assert([keyOf(one.request), keyOf(two.request)].includes(shared.source.bundleKey));
});

test("a pushed commit must be its branch's live head on the forge, or nothing is filed", async () => {
  const w = await quietWorld();
  const refusals: Array<[BranchHeadOutcome | undefined, number, string]> = [
    [undefined, 409, "is not the head of feat on the forge; push it, or upload a bundle"],
    [{ kind: "head", sha: OTHER }, 409, "is not the head of feat"],
    [{ kind: "unsupported" }, 409, "upload a bundle"],
    [{ kind: "unavailable", error: "502" }, 503, "try again"],
  ];
  for (const [head, status, words] of refusals) {
    if (head === undefined) w.heads.delete("feat");
    else w.heads.set("feat", head);
    const answer = await ask(w, { pushed: false });
    assert(answer.kind === "refused", JSON.stringify(answer));
    assertEquals(answer.status, status);
    assertStringIncludes(answer.error, words);
    assertEquals(answer.code, status === 409 ? "not-branch-head" : undefined);
  }
  assertEquals(localRequests(w), []);
  assertEquals(w.headsAsked, ["feat", "feat", "feat", "feat"]);
  w.heads.set("feat", { kind: "head", sha: HEAD });
  assertEquals((await ask(w, { pushed: false })).kind, "requested");
});

test("the routes answer a pushed commit that is not the head 409, and a forge that cannot say 503", async () => {
  const a = await app();
  a.heads.set("feat", { kind: "head", sha: OTHER });
  const stale = await a.askJson({}, { pushed: false });
  assertEquals(stale.status, 409);
  assertStringIncludes(stale.body.error, "upload a bundle");
  assertEquals(stale.body.code, "not-branch-head");
  a.heads.delete("feat");
  assertEquals((await a.askJson({}, { pushed: false })).body.code, "not-branch-head");
  a.heads.set("feat", { kind: "unsupported" });
  assertEquals((await a.askJson({}, { pushed: false })).body.code, "not-branch-head");
  a.heads.set("feat", { kind: "unavailable", error: "forge down" });
  assertEquals((await a.askJson({}, { pushed: false })).status, 503);
  assertEquals(localRequests(a), []);
});

test("the same ask again gives it another day; one past its day is replaced, never answered", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested");
  const day = (r: CheckRequest) => Date.parse(r.expiresAt!) - Date.parse(r.createdAt);
  assertEquals(day(first.request), LOCAL_REQUEST_TTL_MS);
  w.clock.advance(LOCAL_REQUEST_TTL_MS - 60 * 60_000);
  const again = await ask(w);
  assert(again.kind === "requested");
  assertEquals(again.request.id, first.request.id);
  assertEquals(
    Date.parse(again.request.expiresAt!),
    w.clock.now().getTime() + LOCAL_REQUEST_TTL_MS,
  );
  // Past where the first day would have ended: the sweep leaves it, its day was renewed.
  w.clock.advance(2 * 60 * 60_000);
  await w.service.tick();
  assertEquals((await w.checkStore.getRequest(first.request.id))!.state, "active");

  // Its day over but the sweep not round yet: a new request, the old one withdrawn.
  w.clock.advance(LOCAL_REQUEST_TTL_MS);
  const late = await ask(w);
  assert(late.kind === "requested");
  assert(late.request.id !== first.request.id);
  assertEquals((await w.checkStore.getRequest(first.request.id))!.state, "superseded");
  assertEquals(late.suite!.id, first.suite!.id, "the suite it shared is not cancelled between");
});

test("two asks on one branch handled side by side leave the newest-filed, whichever way round", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  await ask(w);
  w.clock.advance(1_000);
  // The second call read before the first's request landed, so it supersedes nothing up front.
  const list = w.checkStore.listLiveLocalRequests;
  w.checkStore.listLiveLocalRequests = () => {
    w.checkStore.listLiveLocalRequests = list;
    return Promise.resolve([]);
  };
  const second = await ask(w, { commit: OTHER });
  assert(second.kind === "requested");
  assertEquals(localRequests(w).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "active"],
  ]);

  // And the other way round: a later-filed ask lands while the earlier call is still going.
  const v = await quietWorld({ policy: { maxConcurrent: 0 } });
  const create = v.checkStore.createRequest;
  let inner: Awaited<ReturnType<typeof ask>> | undefined;
  v.checkStore.createRequest = async (request) => {
    v.checkStore.createRequest = create;
    await create(request);
    v.clock.advance(1_000);
    inner = await ask(v, { commit: OTHER });
  };
  const outer = await ask(v);
  assert(outer.kind === "requested" && inner?.kind === "requested");
  assertEquals(localRequests(v).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "active"],
  ]);
  // The earlier call answers with what stands on the branch.
  assertEquals(outer.request.id, inner.request.id);

  // The same instant, neither seeing the other up front: the id decides.
  const u = await quietWorld({ policy: { maxConcurrent: 0 } });
  await ask(u);
  const uList = u.checkStore.listLiveLocalRequests;
  u.checkStore.listLiveLocalRequests = () => {
    u.checkStore.listLiveLocalRequests = uList;
    return Promise.resolve([]);
  };
  await ask(u, { commit: OTHER });
  const all = localRequests(u);
  const live = all.filter((r) => r.state !== "superseded");
  assertEquals(live.length, 1);
  assertEquals(live[0].id, all.map((r) => r.id).sort().at(-1));
});

test("uploads are capped per person per hour, before the body is read; pushed asks are not", async () => {
  const a = await app({ world: { policy: { maxUploadsPerHour: 2 } } });
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 201);
  // Re-asking on the same branch is another upload.
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 201);
  const capped = await a.upload(`repo=acme/api&branch=one`);
  assertEquals(capped.status, 429);
  assertStringIncludes(capped.body.error, "RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR");
  assertEquals(a.forge.checkBundles.length, 2, "refused before the upload is read");
  assertEquals((await a.askJson({ branch: "pushed" })).status, 201);
  // Someone else's uploads are theirs.
  a.as(MEMBER(GRACE));
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 201);
  a.as(MEMBER(ADA));
  a.clock.advance(60 * 60_000 + 1);
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 201);
});

// ---- review round 2: attempts counted, a re-ask never undoes a newer ask, refs refused ------

test("an upload the forge refuses still counts against the hourly cap, and a day's attempts are kept", async () => {
  const a = await app({ world: { policy: { maxUploadsPerHour: 2 } } });
  a.forge.stageCheckBundle = async (_repo, _url, _ask, body) => {
    await body.cancel();
    return { kind: "refused", status: 400, error: "bundle declares x", detail: null };
  };
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=one`)).status, 429);
  assertEquals(localRequests(a), [], "nothing was filed, and still the cap holds");
  assertEquals(await a.checksService.localUploads(ADA.userId), { used: 2, max: 2 });
  // The minute sweep prunes attempts a day old, never the hour's.
  a.clock.advance(60 * 60_000 + 1);
  await a.checksService.tick();
  assertEquals(await a.checksService.localUploads(ADA.userId), { used: 0, max: 2 });
  assertEquals(
    await a.checkStore.countLocalUploadsSince(ADA.userId, "2000-01-01T00:00:00.000Z"),
    2,
  );
  a.clock.advance(LOCAL_REQUEST_TTL_MS);
  await a.checksService.tick();
  assertEquals(
    await a.checkStore.countLocalUploadsSince(ADA.userId, "2000-01-01T00:00:00.000Z"),
    0,
  );
});

test("a re-ask of the standing commit racing a newer ask on the branch never undoes the newer one", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested" && first.suite !== null);
  w.clock.advance(1_000);
  const create = w.checkStore.createRequest;
  let inner: Awaited<ReturnType<typeof ask>> | undefined;
  w.checkStore.createRequest = async (request) => {
    w.checkStore.createRequest = create;
    await create(request);
    w.clock.advance(1_000);
    // The standing commit asked again while the newer ask is mid-call: the newer one is not its
    // to answer for, so it files its own rather than renew the old one and withdraw the new.
    w.heads.set("feat", { kind: "head", sha: HEAD });
    inner = await w.service.requestLocal({
      user: ADA,
      repo: w.api,
      commit: HEAD,
      branch: "feat",
      bundled: false,
    });
  };
  const outer = await ask(w, { commit: OTHER });
  assert(outer.kind === "requested" && inner?.kind === "requested");
  const standing = localRequests(w).filter((r) => r.state === "active" || r.state === "pending");
  assertEquals(standing.length, 1, "one ask stands");
  assertEquals(standing[0].commit, HEAD, "the newest-filed: the re-ask's own");
  assertEquals([outer.request.id, inner.request.id], [standing[0].id, standing[0].id]);
  assertEquals(
    (await w.checkStore.getSuite(first.suite.id))!.state,
    "queued",
    "the suite the standing ask wants is not cancelled",
  );
});

test("a branch or base that is another ref, or HEAD, is refused 400, never asked of the forge", async () => {
  const a = await app();
  for (const branch of ["refs/tags/v1", "refs/pull/1/head", "HEAD", "refs/heads/"]) {
    assertEquals((await a.askJson({ branch }, { pushed: false })).status, 400, branch);
    assertEquals(
      (await a.upload(`repo=acme/api&branch=${encodeURIComponent(branch)}`)).status,
      400,
      branch,
    );
  }
  assertEquals((await a.askJson({ base: "refs/tags/v1" })).status, 400);
  assertEquals((await a.upload(`repo=acme/api&branch=feat&base=HEAD`)).status, 400);
  assertEquals(a.headsAsked, []);
  assertEquals(a.forge.checkBundles, []);
  // `refs/heads/<name>` is the bare name, for the branch and the base alike.
  const ok = await a.askJson({ branch: "refs/heads/feat", base: "refs/heads/main" });
  assertEquals(ok.status, 201);
  assertEquals(a.headsAsked, ["feat"]);
  assertEquals(ok.body.suite.checksRef, "main");
});

// ---- review round 3: caps that hold side by side, renewals that stand ------------------------

test("uploads side by side cannot slip past the hourly cap, and a refusal costs nothing", async () => {
  const a = await app({ world: { policy: { maxUploadsPerHour: 2 } } });
  const res = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) => a.upload(`repo=acme/api&branch=b${i}`)),
  );
  // Each counts itself with the others it can see, so however they interleave, never more than
  // the cap pass (side by side to the last await, none may): never all six, as counting before
  // recording let through.
  const passed = res.filter((r) => r.status === 201).length;
  assert(passed <= 2, `${passed} passed`);
  assert(res.every((r) => r.status === 201 || r.status === 429));
  assertEquals(a.forge.checkBundles.length, passed, "only the ones that passed were read");
  // A refusal took its own attempt back: what stands is what passed, and the budget is left.
  assertEquals(await a.checksService.localUploads(ADA.userId), { used: passed, max: 2 });
  if (passed < 2) assertEquals((await a.upload(`repo=acme/api&branch=later`)).status, 201);
});

test("asks on two branches side by side cannot both slip under the person's cap", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0, maxLocalPerUser: 2 } });
  assert((await ask(w, { branch: "a" })).kind === "requested");
  w.clock.advance(1_000);
  // Two more branches at once, each reading before the other filed.
  const list = w.checkStore.listLiveLocalRequests;
  let reads = 0;
  w.checkStore.listLiveLocalRequests = async (userId) => {
    const rows = await list(userId);
    // The first read of each call misses the other's ask.
    return ++reads <= 2 ? rows.filter((r) => r.source.branchName === "a") : rows;
  };
  w.heads.set("b", { kind: "head", sha: OTHER });
  w.heads.set("c", { kind: "head", sha: THIRD });
  const [b, c] = await Promise.all([
    w.service.requestLocal({ user: ADA, repo: w.api, commit: OTHER, branch: "b", bundled: false }),
    w.service.requestLocal({ user: ADA, repo: w.api, commit: THIRD, branch: "c", bundled: false }),
  ]);
  w.checkStore.listLiveLocalRequests = list;
  const live = localRequests(w).filter((r) => r.state === "pending" || r.state === "active");
  assert(live.length <= 2, JSON.stringify(live.map((r) => r.source.branchName)));
  assert(b.kind === "quota" || c.kind === "quota");
  // The ask on `a` was never replaced by a refused one.
  assert(live.some((r) => r.source.branchName === "a"));
});

test("a renewal that lands after the expiry sweep listed the ask keeps it", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested" && first.suite !== null);
  await w.service.tick();
  w.clock.advance(LOCAL_REQUEST_TTL_MS - 1);
  // The sweep lists the ask as expired, then waits while the re-ask renews it.
  const list = w.checkStore.listExpiredLocalRequests;
  let listed!: () => void;
  const wasListed = new Promise<void>((done) => (listed = done));
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  w.checkStore.listExpiredLocalRequests = async (now, limit) => {
    const rows = await list(now, limit);
    if (rows.length > 0) {
      listed();
      await gate;
    }
    return rows;
  };
  const getSuite = w.checkStore.getSuite;
  let ticking: Promise<void> | undefined;
  w.checkStore.getSuite = async (id) => {
    w.checkStore.getSuite = getSuite;
    w.clock.advance(2);
    ticking = w.service.tick();
    await wasListed;
    return await getSuite(id);
  };
  const again = await ask(w);
  release();
  await ticking;
  assert(again.kind === "requested");
  assertEquals(again.request.id, first.request.id, "the renewed ask is the answer");
  assertEquals((await w.checkStore.getRequest(first.request.id))!.state, "active", "and stands");
  assertEquals((await w.checkStore.getSuite(first.suite.id))!.state, "queued");
});

test("a re-ask whose ask a newer one withdrew meanwhile answers the newer one", async () => {
  const w = await quietWorld({ policy: { maxConcurrent: 0 } });
  const first = await ask(w);
  assert(first.kind === "requested" && first.suite !== null);
  w.clock.advance(1_000);
  const getSuite = w.checkStore.getSuite;
  let newer: Awaited<ReturnType<typeof ask>> | undefined;
  w.checkStore.getSuite = async (id) => {
    w.checkStore.getSuite = getSuite;
    // A newer push lands, and is asked about, between the re-ask's read and its renewal.
    newer = await ask(w, { commit: OTHER });
    w.clock.advance(1_000);
    return await getSuite(id);
  };
  w.heads.set("feat", { kind: "head", sha: HEAD });
  const again = await w.service.requestLocal({
    user: ADA,
    repo: w.api,
    commit: HEAD,
    branch: "feat",
    bundled: false,
  });
  assert(again.kind === "requested" && newer?.kind === "requested");
  assertEquals(localRequests(w).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "active"],
  ]);
  assertEquals(again.request.id, newer.request.id);
  assertEquals((await w.checkStore.getSuite(newer.suite!.id))!.state, "queued");
});
