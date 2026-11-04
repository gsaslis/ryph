// Checks for any change request: a push to a pull request or
// a Radicle patch asks for its head's checks, read at the change request's base, and reports the
// verdict there — joining a suite that already answered for that head, so a head someone checked
// opens green at once. The engine first, then the forge's event door and the readers' surfaces.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import type { ChangeRequestHeadOutcome, ForgePermission } from "../src/ports/forge.ts";
import { type CheckRequest, type ForgeSource, isForgeSource } from "../src/core/check_types.ts";
import { liveCeiling, resolveNetworkScope } from "../src/core/egress.ts";
import { type ChangeRequestPush, checkRecordName } from "../src/core/checks.ts";
import { COMMENT_CLAIM_STALE_MS } from "../src/core/check_approvals.ts";
import { checksWorld, HEAD, sha, T0 } from "./checks_world.ts";
import { fakeIdentityDirectory, fakeRunnerControl, imageConfig } from "./doubles.ts";

type World = Awaited<ReturnType<typeof checksWorld>>;

const OTHER = sha("e");

const pushOf = (w: World, over: Partial<ChangeRequestPush> = {}): ChangeRequestPush => ({
  connectedRepoId: w.api.id,
  ref: "42",
  headSha: HEAD,
  baseRef: "main",
  fetchRef: "refs/pull/42/head",
  url: "https://github.com/acme/api/pull/42",
  ...over,
});

const pushRequests = (w: World, ref = "42"): CheckRequest[] =>
  [...w.checkStore.requests.values()].filter((r) =>
    r.kind === "push" && isForgeSource(r.source) && r.source.changeRequest === ref
  );

/** A host the deployment's allowlist names: a scope that came out empty would not have it. */
const ALLOWED = "registry.npmjs.org";

/** A world whose own run asked for nothing, and whose allowlist is not empty, so a pod scoped
 * to nothing would show. */
const quietWorld = (opts: Parameters<typeof checksWorld>[0] = {}) =>
  checksWorld({
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

test("a push asks for its head's checks, and the forge hears queued, then the verdict", async () => {
  const w = await quietWorld();
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "checks-requested");
  const [request] = pushRequests(w);
  assertEquals([request.state, request.runId, request.patchId, request.checksRef], [
    "pending",
    null,
    null,
    "main",
  ]);
  const source = request.source as ForgeSource;
  assertEquals(source, {
    runId: null,
    changeRequest: "42",
    fetchRef: "refs/pull/42/head",
    branchName: "pull/42/head",
    baseRef: "main",
    url: "https://github.com/acme/api/pull/42",
  });
  // Its row is filed with it, due at once.
  const row = (await w.checkStore.findForgeReport({ requestId: request.id }))!;
  assertEquals([row.patchId, row.checksRef, row.headSha], [null, "main", HEAD]);

  // Read at the base on the tick, and its checks posted queued in the same tick.
  await w.service.tick();
  let suite = w.onlySuite();
  assertEquals([suite.state, suite.source.runId], ["queued", null]);
  assertEquals(w.reports.length, 1);
  assertEquals(w.reports[0].checks.map((c) => c.status), ["queued", "queued"]);
  await w.service.tick();
  suite = w.onlySuite();
  assertEquals(suite.state, "running");

  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.reports.at(-1)!.suite.conclusion, "success");
  assertEquals((await w.checkStore.getSuite(suite.id))!.state, "passed");
});

test("a head already checked opens green at once, with no second pod", async () => {
  const w = await quietWorld();
  // The run's own ask, settled green: the run has no network policy, so its scope is the one a
  // head no run shipped gets too.
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.networkScope.hosts, [ALLOWED]);
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.launched.specs.length, 1);

  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  assertEquals(w.suites().length, 1, "joined, not claimed");
  assertEquals(w.launched.specs.length, 1, "no second pod");
  const [request] = pushRequests(w);
  assertEquals([request.state, request.suiteId], ["active", suite.id]);
  assertEquals(w.reports.length, 1);
  assertEquals(w.reports[0].suite.conclusion, "success");
  assertEquals(w.reports[0].checks.map((c) => c.conclusion), ["success", "success"]);
});

test("a push's pod gets the scope an agent with no policy gets, the same for every runless ask", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  const first = w.onlySuite();
  const ceiling = await liveCeiling(w.store, w.config.egress.policy);
  const expected = resolveNetworkScope(null, ceiling);
  assert(expected.kind === "ok");
  assertEquals(first.networkScope, expected.scope);
  assertEquals(first.networkScope.hosts, [ALLOWED]);
  // Another change request on the same head — a second asker with no run — lands on the same
  // identity, so the same suite.
  await w.service.changeRequestPushed(
    pushOf(w, { ref: "43", fetchRef: "refs/pull/43/head", url: null }),
  );
  await w.service.tick();
  assertEquals(w.suites().length, 1);
  const [second] = pushRequests(w, "43");
  assertEquals(second.suiteId, first.id);
});

test("a second push supersedes the first, and cancels its suite still going", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  await w.service.tick();
  const first = w.onlySuite();
  assertEquals(first.state, "running");
  const posted = w.reports.length;

  w.clock.advance(1_000);
  assertEquals(
    await w.service.changeRequestPushed(pushOf(w, { headSha: OTHER })),
    "checks-requested",
  );
  const [old, fresh] = pushRequests(w);
  assertEquals([old.state, fresh.state], ["superseded", "pending"]);
  assertEquals((await w.checkStore.getSuite(first.id))!.state, "cancelled");
  assert(w.launched.discarded.includes(checkRecordName(first)));

  await w.service.tick();
  // The old head's checks are told they were cancelled, and the new head's are queued.
  const cancelled = w.reports.slice(posted).find((r) => r.suiteId === first.id)!;
  assertEquals(cancelled.checks.map((c) => c.conclusion), ["cancelled", "cancelled"]);
  assert(w.reports.slice(posted).some((r) => r.headSha === OTHER));
  // And then nothing more about the old head, whatever touches its suite.
  const told = w.reports.length;
  await w.checkStore.touchForgeReports(first, w.clock.now().toISOString());
  await w.service.tick();
  assertEquals(w.reports.slice(told).filter((r) => r.suiteId === first.id), []);
});

test("the same head and base again is a no-op; a retargeted base is a new ask", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "unchanged");
  assertEquals(pushRequests(w).length, 1);
  // A base that is no branch of the repo is judged by the default branch: the same ask.
  assertEquals(
    await w.service.changeRequestPushed(pushOf(w, { baseRef: "refs/pull/7/head" })),
    "unchanged",
  );
  w.files.set("release", structuredClone(w.files.get("*")!));
  assertEquals(
    await w.service.changeRequestPushed(pushOf(w, { baseRef: "release" })),
    "checks-requested",
  );
  const [old, fresh] = pushRequests(w);
  assertEquals([old.state, fresh.state, fresh.checksRef], ["superseded", "pending", "release"]);
});

test("a change request merged or closed withdraws its asks; a settled suite stays settled", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  const running = w.onlySuite();
  await w.service.changeRequestEnded({ connectedRepoId: w.api.id, ref: "42" });
  assertEquals(pushRequests(w)[0].state, "superseded");
  assertEquals((await w.checkStore.getSuite(running.id))!.state, "cancelled");

  // A head whose suite already passed keeps its verdict.
  const v = await quietWorld();
  await v.service.changeRequestPushed(pushOf(v));
  await v.service.tick();
  v.launched.finish(v.nameOf(v.onlySuite()), { lint: 0, test: 0 });
  await v.service.tick();
  await v.service.changeRequestEnded({ connectedRepoId: v.api.id, ref: "42" });
  assertEquals(v.onlySuite().state, "passed");
});

test("only the change request's own events end a push ask: the release sweep keeps it", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  w.clock.advance(5 * 60_000);
  await w.service.tick();
  assertEquals(pushRequests(w)[0].state, "active");
  assertEquals(w.onlySuite().state, "running");
});

test("a pending patch ask whose patch was set aside is withdrawn by the sweep", async () => {
  const w = await quietWorld();
  // The base cannot be read, so the birth's ask stays pending.
  w.files.set("*", { kind: "unavailable", detail: "forge down" });
  const patch = w.patchOf();
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  const [asked] = await w.checkStore.listRequestsForPatches([patch.id]);
  assertEquals(asked.state, "pending");
  await w.store.savePatch({ ...patch, state: "rejected" });
  w.clock.advance(2 * 60_000);
  await w.service.tick();
  assertEquals((await w.checkStore.getRequest(asked.id))!.state, "superseded");
});

test("a forge-sourced suite re-runs from its change request, at the default scope", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 1, test: 0 });
  await w.service.tick();
  const outcome = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  assert(outcome.kind === "rerun");
  assertEquals(outcome.suite.generation, 2);
  assertEquals(outcome.suite.source, suite.source);
  assertEquals(outcome.suite.networkScope, suite.networkScope);
  assertEquals(outcome.suite.networkScope.hosts, [ALLOWED]);
});

test("the gateway serves a change request's head from the forge, not a bundle", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  await w.service.tick();
  const suite = w.onlySuite();
  const header = w.launched.specs[0].clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.replace("Authorization: Basic ", "")).split(":")[1];
  const { sha256Hex } = await import("@ryph/sealed");
  const grant = (await w.service.gitGrant(await sha256Hex(token)))!;
  assertEquals(grant.runId, suite.id);
  assertEquals(grant.repos[0].candidate, {
    headSha: HEAD,
    branchName: "pull/42/head",
    fetchRef: "refs/pull/42/head",
  });
  assertEquals(grant.repos[0].ref, "main");
  assertEquals(grant.repos[0].targetRef, undefined);
});

test("a clone that failed on a change request's head retries on a run's bundle of it", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  const suite = w.onlySuite();
  // The run asks for the same head while the pod is up: same identity, so it joins.
  await w.request();
  assertEquals(w.suites().length, 1);
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
  assertEquals(retried.source.runId, w.run.id);
});

test("a withdraw that read a request before it resolved still cancels the suite it got", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  // What the closing event's handler read: the request still pending, naming no suite.
  const stale = await w.checkStore.listPushRequests(w.api.id, "42");
  assertEquals(stale[0].suiteId, null);
  await w.service.tick();
  const suite = w.onlySuite();
  const list = w.checkStore.listPushRequests;
  w.checkStore.listPushRequests = () => Promise.resolve(structuredClone(stale));
  await w.service.changeRequestEnded({ connectedRepoId: w.api.id, ref: "42" });
  w.checkStore.listPushRequests = list;
  const [request] = pushRequests(w);
  assertEquals([request.state, request.suiteId], ["superseded", suite.id], "not written back");
  assertEquals((await w.checkStore.getSuite(suite.id))!.state, "cancelled");
});

test("a close withdraws a push ask still being read, and keeps a suite a run still wants", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.changeRequestEnded({ connectedRepoId: w.api.id, ref: "42" });
  assertEquals(pushRequests(w)[0].state, "superseded");
  await w.service.tick();
  assertEquals(w.suites(), [], "read at the base for nobody");

  const v = await quietWorld();
  await v.request();
  await v.service.changeRequestPushed(pushOf(v));
  await v.service.tick();
  const shared = v.onlySuite();
  assertEquals(pushRequests(v)[0].suiteId, shared.id);
  await v.service.changeRequestEnded({ connectedRepoId: v.api.id, ref: "42" });
  assertEquals((await v.checkStore.getSuite(shared.id))!.state, "running");
});

test("the same push again files the forge row that never landed", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  const [request] = pushRequests(w);
  const row = (await w.checkStore.findForgeReport({ requestId: request.id }))!;
  w.checkStore.reports.delete(row.id);
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "unchanged");
  assert(await w.checkStore.findForgeReport({ requestId: request.id }) !== null);
});

test("a set-aside push's suite re-run on the forge is reported again, generation 2", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 1, test: 0 });
  await w.service.tick();
  assertEquals((await w.checkStore.getSuite(suite.id))!.state, "failed");
  w.clock.advance(1_000);
  await w.service.changeRequestPushed(pushOf(w, { headSha: OTHER }));
  await w.service.tick();
  const told = w.reports.length;
  const rerun = await w.service.forgeRerequested({
    connectedRepoId: w.api.id,
    headSha: HEAD,
    externalId: `${suite.id}:1:lint`,
    deliveryId: "d-rerun",
  });
  assertEquals(rerun, "checks-rerun");
  await w.service.tick();
  const again = w.reports.slice(told).filter((r) => r.suiteId === suite.id);
  assert(again.length > 0 && again.every((r) => r.generation === 2), JSON.stringify(again));
});

test("a set-aside push that only ever showed another suite stops with what it last posted", async () => {
  const w = await quietWorld();
  // The run's suite on the head, running; then the base stops answering, so the push's own ask
  // stays pending and its row shows the run's suite meanwhile.
  await w.request();
  await w.service.tick();
  const runs = w.onlySuite();
  w.files.set("*", { kind: "unavailable", detail: "forge down" });
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  assertEquals(w.reports.map((r) => [r.headSha, r.suiteId]), [[HEAD, runs.id]]);
  w.clock.advance(1_000);
  await w.service.changeRequestPushed(pushOf(w, { headSha: OTHER }));
  const told = w.reports.length;
  w.launched.finish(w.nameOf(runs), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.reports.slice(told).filter((r) => r.headSha === HEAD), []);
});

/** Hides the change request's requests from the next `listPushRequests`: what a call that ran
 * beside another read before the other's request was in. */
const hideOnce = (w: World) => {
  const list = w.checkStore.listPushRequests;
  w.checkStore.listPushRequests = () => {
    w.checkStore.listPushRequests = list;
    return Promise.resolve([]);
  };
};

test("two pushes of different heads handled side by side leave the later-filed one", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  w.clock.advance(1_000);
  // The second call read before the first's request landed, so it supersedes nothing up front.
  hideOnce(w);
  assertEquals(
    await w.service.changeRequestPushed(pushOf(w, { headSha: OTHER })),
    "checks-requested",
  );
  assertEquals(pushRequests(w).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "pending"],
  ]);

  // And the other way round: a later-filed request lands while the earlier call is still going.
  const v = await quietWorld();
  const create = v.checkStore.createRequest;
  v.checkStore.createRequest = async (request) => {
    v.checkStore.createRequest = create;
    await create(request);
    v.clock.advance(1_000);
    await v.service.changeRequestPushed(pushOf(v, { headSha: OTHER }));
  };
  assertEquals(await v.service.changeRequestPushed(pushOf(v)), "unchanged");
  assertEquals(pushRequests(v).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "pending"],
  ]);
});

test("two deliveries of one head handled side by side keep the earliest request", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  w.clock.advance(1_000);
  hideOnce(w);
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "unchanged");
  const [first, second] = pushRequests(w);
  assertEquals([first.state, second.state], ["pending", "superseded"]);
  assert(first.createdAt < second.createdAt);
});

test("the same push again withdraws any other ask of the change request still live", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  w.clock.advance(1_000);
  // A leftover: another head's ask that a crash left live beside it.
  hideOnce(w);
  const create = w.checkStore.createRequest;
  w.checkStore.createRequest = async (request) => {
    w.checkStore.createRequest = create;
    await create(request);
    throw new Error("crashed before the supersede");
  };
  await assertRejects(() => w.service.changeRequestPushed(pushOf(w, { headSha: OTHER })));
  assertEquals(pushRequests(w).filter((r) => r.state === "pending").length, 2);
  // HEAD's delivery again (it is live once more): it stands, and the leftover goes.
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "unchanged");
  assertEquals(pushRequests(w).map((r) => [r.commit, r.state]), [
    [HEAD, "pending"],
    [OTHER, "superseded"],
  ]);
});

test("a ryph patch moving the change request on keeps the patch head's push ask", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w, { headSha: OTHER }));
  w.clock.advance(1_000);
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.changeRequestEnded({ connectedRepoId: w.api.id, ref: "42", exceptHead: HEAD });
  assertEquals(pushRequests(w).map((r) => [r.commit, r.state]), [
    [OTHER, "superseded"],
    [HEAD, "pending"],
  ]);
});

test("a close still withdraws with change-request checks turned off since", async () => {
  const w = await quietWorld();
  await w.service.changeRequestPushed(pushOf(w));
  const off = await quietWorld({ policy: { changeRequests: false } });
  // The same store, as a restart with the knob off would read it.
  for (const [id, r] of w.checkStore.requests) off.checkStore.requests.set(id, r);
  await off.service.changeRequestEnded({ connectedRepoId: off.api.id, ref: "42" });
  assertEquals(pushRequests(off)[0].state, "superseded");
});

test("change-request checks off: a push asks for nothing", async () => {
  const w = await quietWorld({ policy: { changeRequests: false } });
  assertEquals(w.service.changeRequests, false);
  assertEquals(await w.service.changeRequestPushed(pushOf(w)), "off");
  assertEquals(pushRequests(w), []);
});

// ---- the forge's event door, and the readers' surfaces --------------------------------------

const USER = {
  kind: "user",
  userId: "u-2",
  email: "grace@example.com",
  name: "Grace",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-2",
  via: "session",
} as const;
const FORGE_TOKEN = "forge-service-token";

/** The radicle repo the Radicle door tests connect beside acme/api. */
const RID = "rad:z2oo6c5ceo8RPkRsxHBE2LBz7uHsC";

const gitlabBot = (url: string) => ({
  mode: "bot" as const,
  login: "ryph-bot",
  accountId: `1@${url}`,
  url,
  signIn: true,
});

async function app(
  opts: {
    /** Per subject; anyone unnamed is allowed. */
    permission?: Record<string, ForgePermission>;
    role?: "member" | "operator";
    /** RYPH_APP_URL, which outside contributions' approval pages need. Unset: none. */
    appUrl?: string;
    /** The forge's GitLab, in bot mode. Unset: no GitLab. */
    gitlabUrl?: string;
  } = {},
) {
  const w = await quietWorld();
  const identities = fakeIdentityDirectory();
  // Grace, the caller, is grace on GitHub.
  identities.link(USER.userId, "grace");
  // The comments the forge was asked to post and edit, by id.
  const comments = new Map<string, { thread: string; body: string }>();
  const commentLog: string[] = [];
  w.forge.postComment = (_repo, thread, body) => {
    const commentId = `c-${comments.size + 1}`;
    comments.set(commentId, { thread: thread.ref, body });
    commentLog.push(`post ${commentId}`);
    return Promise.resolve({ commentId });
  };
  w.forge.updateComment = (_repo, commentId, body) => {
    const comment = comments.get(commentId);
    if (!comment) return Promise.reject(new Error("404 — no such comment"));
    comments.set(commentId, { ...comment, body });
    commentLog.push(`edit ${commentId}`);
    return Promise.resolve();
  };
  // The change request as the forge reads it live; each test moves it. `onRead` runs after
  // every read, so a test can move it between the read before filing and the one after.
  const live: {
    read: "open" | "closed" | "merged" | "gone" | "unavailable";
    headSha: string;
    /** Unset: the author's head is the newest, as on GitHub. */
    authorHeadSha?: string;
    baseRef: string;
    openedByUs: boolean;
    reads: number;
    onRead?: (n: number) => void;
  } = { read: "open", headSha: HEAD, baseRef: "main", openedByUs: false, reads: 0 };
  w.forge.fetchChangeRequestHead = (_repo, ref) => {
    const answer = (): ChangeRequestHeadOutcome =>
      live.read === "unavailable"
        ? { kind: "unavailable" }
        : live.read === "gone"
        ? { kind: "gone" }
        : {
          kind: "head",
          head: {
            ref,
            state: live.read === "open" ? "open" : "closed",
            merged: live.read === "merged",
            headSha: live.headSha,
            authorHeadSha: live.authorHeadSha ?? live.headSha,
            baseRef: live.baseRef,
            openedByUs: live.openedByUs,
            mergedHeads: live.read === "merged" ? [live.headSha] : [],
          },
        };
    const out = answer();
    live.reads++;
    live.onRead?.(live.reads);
    return Promise.resolve(out);
  };
  const asked: Array<{ subject: string | null; atLeast: string }> = [];
  w.forge.checkPermission = (_repo, who, atLeast) => {
    asked.push({ subject: who.subject, atLeast });
    return Promise.resolve(opts.permission?.[who.subject ?? ""] ?? "allowed");
  };
  const user = { ...USER, caps: capsClaimOf(opts.role ?? "member") };
  const handler = makeHandler({
    store: w.store,
    provisioner: w.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    // Grace started no task.
    authenticate: (() => Promise.resolve(user)) as unknown as Authenticate,
    forgeToken: FORGE_TOKEN,
    forge: w.forge,
    identityDirectory: opts.appUrl === undefined
      ? fakeIdentityDirectory().directory
      : identities.directory,
    environments: w.environmentService,
    checks: w.checksService,
    checksAwaiting: w.checksAwaiting,
    now: w.clock.now,
    ...(opts.gitlabUrl === undefined ? {} : {
      gitlabMode: {
        current: () => gitlabBot(opts.gitlabUrl!),
        get: () => Promise.resolve(gitlabBot(opts.gitlabUrl!)),
      },
    }),
    config: {
      ...imageConfig(),
      ...w.config,
      ...(opts.appUrl === undefined ? {} : { appUrl: opts.appUrl }),
    },
  });
  const call = async (method: string, path: string, body?: unknown, bearer = "user-token") =>
    await handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const event = (
    over: Record<string, unknown> = {},
    change: Record<string, unknown> = {},
  ) => ({
    deliveryId: "d-1",
    kind: "change_request.pushed",
    repo: { provider: "github", repoRef: "acme/api", url: "https://github.com/acme/api" },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: "42" },
    body: null,
    sourceCommentId: null,
    changeRequest: {
      ref: "42",
      headSha: HEAD,
      baseRef: "main",
      fetchRef: "refs/pull/42/head",
      url: "https://github.com/acme/api/pull/42",
      author: "grace",
      before: null,
      ...change,
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const send = async (body: unknown) => {
    const res = await call("POST", "/v1/forge/events", body, FORGE_TOKEN);
    return { status: res.status, body: await res.json() };
  };
  return { ...w, call, event, send, asked, live, comments, commentLog, identities };
}

test("the event door: a trusted push asks; a redelivery changes nothing", async () => {
  const a = await app();
  assertEquals((await a.send(a.event())).body, { outcome: "checks-requested" });
  assertEquals(a.asked, [{ subject: "grace", atLeast: "write" }], "author and actor are one");
  // The same delivery again is answered from the record; another naming the same head and base
  // files nothing new.
  assertEquals((await a.send(a.event())).body, { outcome: "deduped" });
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, {
    outcome: "checks-unchanged",
  });
  assertEquals(pushRequests(a).length, 1);
  assertEquals((await a.send(a.event({ deliveryId: "d-3", thread: null }))).body, {
    outcome: "no-command",
  });
  assertEquals(
    (await a.send(a.event({
      deliveryId: "d-4",
      repo: { provider: "github", repoRef: "acme/nope", url: "x" },
    }))).body,
    { outcome: "repo-not-connected" },
  );
  // A link that is not https never reaches the app.
  assertEquals((await a.send(a.event({}, { url: "javascript:alert(1)" }))).status, 400);
  assertEquals((await a.send(a.event({}, { fetchRef: "refs/tags/v1" }))).status, 400);
});

test("the event door: a delivery replayed once it was decided asks the forge nothing", async () => {
  // A GitLab token holder can ring for the same merge request state as often as its budget
  // allows; the forge names the delivery by that state, so each ring after the first is this.
  const a = await app();
  assertEquals((await a.send(a.event())).body, { outcome: "checks-requested" });
  const [reads, asked] = [a.live.reads, a.asked.length];
  assertEquals((await a.send(a.event())).body, { outcome: "deduped" });
  assertEquals(a.live.reads, reads, "no change request read");
  assertEquals(a.asked.length, asked, "no permission asked");
  // A genuinely new state is another delivery, and is judged.
  a.live.headSha = OTHER;
  assertEquals(
    (await a.send(a.event({ deliveryId: "d-2" }, { headSha: OTHER }))).body,
    { outcome: "checks-requested" },
  );
  assert(a.live.reads > reads);
});

test("the event door: the author must be trusted, and the actor too when another", async () => {
  // A maintainer pushing onto (or reopening) a stranger's pull request runs nothing.
  const stranger = await app({ permission: { mallory: "denied" } });
  assertEquals(
    (await stranger.send(stranger.event({}, { author: "mallory" }))).body,
    { outcome: "denied" },
  );
  assertEquals(pushRequests(stranger), []);
  assertEquals(stranger.reports, []);
  // A stranger pushing onto a maintainer's pull request runs nothing either.
  const actor = await app({ permission: { mallory: "denied" } });
  assertEquals(
    (await actor.send(actor.event({ actorLogin: "mallory" }))).body,
    { outcome: "denied" },
  );
  assertEquals(actor.asked.map((q) => q.subject), ["grace", "mallory"]);
  assertEquals(pushRequests(actor), []);
  const unknown = await app({ permission: { grace: "unknown" } });
  assertEquals((await unknown.send(unknown.event())).status, 503);
  assertEquals(pushRequests(unknown), []);
});

test("the event door on GitLab asks about the author's and pusher's account ids, never usernames", async () => {
  const URL = "https://gitlab.example";
  // Mallory's account id is denied; the username she holds now is a trusted person's old one.
  const a = await app({ permission: { [`57@${URL}`]: "denied" }, appUrl: APP, gitlabUrl: URL });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-gl",
    provider: "gitlab",
    installationId: null,
    repoRef: "acme/app",
    url: `${URL}/acme/app.git`,
  });
  await a.store.createGitlabProject("cr-gl", "100", URL, T0);
  const push = (deliveryId: string, iid: string, author: { login: string; id?: string }) =>
    a.event({
      deliveryId,
      repo: { provider: "gitlab", repoRef: "acme/app", url: `${URL}/acme/app.git`, forgeId: "100" },
      actorLogin: "ada.lovelace",
      actorId: "31",
      thread: { kind: "change_request", ref: `mr-${iid}` },
    }, {
      ref: `mr-${iid}`,
      fetchRef: `refs/merge-requests/${iid}/head`,
      url: `${URL}/acme/app/-/merge_requests/${iid}`,
      author: author.login,
      ...(author.id === undefined ? {} : { authorId: author.id }),
    });
  // A permitted author: asked about by `<id>@<url>`, as is the pusher, and the head is checked.
  assertEquals((await a.send(push("d-1", "7", { login: "grace_h", id: "42" }))).body, {
    outcome: "checks-requested",
  });
  assertEquals(a.asked, [
    { subject: `42@${URL}`, atLeast: "write" },
    { subject: `31@${URL}`, atLeast: "write" },
  ]);
  assertEquals(pushRequests(a, "mr-7").length, 1);
  // A non-permitted author under the same username: denied by id, so it waits for approval.
  a.asked.length = 0;
  assertEquals((await a.send(push("d-2", "8", { login: "grace_h", id: "57" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.asked, [{ subject: `57@${URL}`, atLeast: "write" }]);
  assertEquals(pushRequests(a, "mr-8"), []);
  // An author whose id the forge did not read is nobody to ask about: it waits too, unasked.
  a.asked.length = 0;
  assertEquals((await a.send(push("d-3", "9", { login: "grace_h" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.asked, []);
  assertEquals(pushRequests(a, "mr-9"), []);
});

test("the event door on Radicle asks for delegacy, with the command allowlist as fallback", async () => {
  const a = await app({ permission: { "did:key:zAda": "denied" } });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-rad",
    provider: "radicle",
    installationId: null,
    repoRef: RID,
    url: RID,
  });
  const radicle = (over: Record<string, unknown> = {}) =>
    a.event({
      repo: { provider: "radicle", repoRef: RID, url: RID },
      actorLogin: "did:key:zAda",
      thread: { kind: "change_request", ref: "a".repeat(40) },
      ...over,
    }, { ref: "a".repeat(40), fetchRef: null, url: null, author: "did:key:zAda" });
  assertEquals((await a.send(radicle())).body, { outcome: "denied" });
  assertEquals(a.asked, [{ subject: "did:key:zAda", atLeast: "admin" }]);
  await a.store.addRepoCommandAllowlistEntry({
    connectedRepoId: "cr-rad",
    provider: "radicle",
    subject: "did:key:zAda",
    addedBy: "u-1",
    createdAt: T0,
  });
  assertEquals((await a.send(radicle({ deliveryId: "d-2" }))).body, {
    outcome: "checks-requested",
  });
  const [request] = pushRequests(a, "a".repeat(40));
  assertEquals((request.source as ForgeSource).branchName, `patches/${"a".repeat(40)}`);
});

test("the event door: a call that failed half way is finished by the retry", async () => {
  const a = await app();
  const upsert = a.checkStore.upsertForgeReport;
  a.checkStore.upsertForgeReport = () => Promise.reject(new Error("db down"));
  // Thrown to the server, which answers 500, and the mailroom retries.
  await assertRejects(() => a.send(a.event()), Error, "db down");
  a.checkStore.upsertForgeReport = upsert;
  const [request] = pushRequests(a);
  assertEquals(await a.checkStore.findForgeReport({ requestId: request.id }), null);
  // The mailroom's retry of the same delivery: the request stands, its row is filed.
  assertEquals((await a.send(a.event())).body, { outcome: "checks-unchanged" });
  assertEquals(pushRequests(a).length, 1);
  assert(await a.checkStore.findForgeReport({ requestId: request.id }) !== null);
});

test("the event door: a head one of our live patches carries on this change request is the patch's", async () => {
  const a = await app();
  // A person's earlier push to the change request, then a ryph run pushes onto it.
  a.live.headSha = OTHER;
  await a.send(a.event({}, { headSha: OTHER }));
  a.live.headSha = HEAD;
  await a.store.createPatch(a.patchOf({ forgeRef: "42" }));
  a.asked.length = 0;
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, { outcome: "ryph-patch" });
  assertEquals(a.asked, [], "not even the permission is asked");
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [[OTHER, "superseded"]]);
});

test("the event door: a patch that is set aside, or another change request's, skips nothing", async () => {
  const a = await app();
  await a.store.createPatch(a.patchOf({ state: "rejected" }));
  assertEquals((await a.send(a.event())).body, { outcome: "checks-requested" });
  const b = await app();
  await b.store.createPatch(b.patchOf({ state: "submitted", forgeRef: "7" }));
  assertEquals((await b.send(b.event())).body, { outcome: "checks-requested" });
});

test("the event door: a merge withdraws the change request's push asks", async () => {
  const a = await app();
  await a.send(a.event());
  await a.checksService.tick();
  const suite = a.onlySuite();
  const merged = await a.send(a.event({
    deliveryId: "d-9",
    kind: "change_request.merged",
    changeRequest: undefined,
  }));
  assertEquals(merged.body, { outcome: "no-such-patch" });
  assertEquals(pushRequests(a)[0].state, "superseded");
  assertEquals((await a.checkStore.getSuite(suite.id))!.state, "cancelled");
});

test("a change request's suite is a reader of every task's; a member without write's is not", async () => {
  // Grace has no GitHub identity linked here, so no write on the repo (checks_local_test.ts has
  // the writer who reads it).
  const member = await app();
  await member.send(member.event());
  await member.checksService.tick();
  const hidden = member.onlySuite();
  assertEquals((await member.call("GET", `/v1/check-suites/${hidden.id}`)).status, 404);
  assertEquals(
    (await (await member.call("GET", "/v1/check-suites?asked=push")).json()).suites,
    [],
  );

  const a = await app({ role: "operator" });
  await a.send(a.event());
  await a.checksService.tick();
  const suite = a.onlySuite();
  a.launched.logs.set(`${a.nameOf(suite)}/check-test`, "ok\n");
  a.launched.finish(a.nameOf(suite), { lint: 0, test: 0 });
  await a.checksService.tick();
  assertEquals((await a.call("GET", `/v1/check-suites/${suite.id}`)).status, 200);
  assertEquals(
    (await a.call("GET", `/v1/check-suites/${suite.id}/log?generation=1&check=test`)).status,
    200,
  );
  const list = await (await a.call("GET", "/v1/check-suites?asked=push")).json();
  assertEquals(list.suites.length, 1);
  assertEquals(list.suites[0].branch, "pull/42/head");
  assertEquals(list.suites[0].askedBy, [
    { kind: "push", label: "#42", href: "https://github.com/acme/api/pull/42" },
  ]);
  assertEquals(
    (await (await a.call("GET", "/v1/check-suites?asked=tool")).json()).suites,
    [],
  );
});

test("the event door reads the change request live: closed or gone files nothing", async () => {
  const a = await app();
  await a.send(a.event());
  // A late delivery after the merge: the live read says closed, and the push ask goes.
  a.live.read = "merged";
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }, { headSha: OTHER }))).body, {
    outcome: "change-request-closed",
  });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [[HEAD, "superseded"]]);
  a.live.read = "gone";
  assertEquals((await a.send(a.event({ deliveryId: "d-3" }))).body, {
    outcome: "change-request-closed",
  });
  assertEquals(pushRequests(a).length, 1);
  a.live.read = "unavailable";
  assertEquals((await a.send(a.event({ deliveryId: "d-4" }))).status, 503);
});

test("the event door: a head that is no longer the live one changes nothing", async () => {
  const a = await app();
  a.live.headSha = OTHER;
  await a.send(a.event({}, { headSha: OTHER }));
  // The earlier head's delivery, arriving late.
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, { outcome: "checks-stale" });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [[OTHER, "pending"]]);
});

test("the event door: the live base is the base, whatever the event said", async () => {
  const a = await app();
  a.files.set("release", structuredClone(a.files.get("*")!));
  a.live.baseRef = "release";
  await a.send(a.event({}, { baseRef: "main" }));
  assertEquals(pushRequests(a)[0].checksRef, "release");
});

test("the event door: on ryph's own pull request only the pusher is asked", async () => {
  const a = await app({ permission: { "ryph[bot]": "denied" } });
  // Ryph opened #42; a person pushes a fixup onto it.
  a.live.openedByUs = true;
  assertEquals(
    (await a.send(a.event({ actorLogin: "grace" }, { author: "ryph[bot]" }))).body,
    { outcome: "checks-requested" },
  );
  assertEquals(a.asked.map((q) => q.subject), ["grace"]);
  // A stranger pushing onto it is still refused.
  const b = await app({ permission: { mallory: "denied", "ryph[bot]": "denied" } });
  b.live.openedByUs = true;
  assertEquals(
    (await b.send(b.event({ actorLogin: "mallory" }, { author: "ryph[bot]" }))).body,
    { outcome: "denied" },
  );
});

test("the event door: ryph having pushed onto a person's pull request exempts nobody", async () => {
  const a = await app({ permission: { mallory: "denied" } });
  // A ryph run delivered onto mallory's pull request #42 (so a patch of ours carries its ref),
  // but ryph did not open it.
  await a.store.createPatch(a.patchOf({ headSha: OTHER, forgeRef: "42", state: "submitted" }));
  assertEquals(
    (await a.send(a.event({ actorLogin: "grace" }, { author: "mallory" }))).body,
    { outcome: "denied" },
  );
  assertEquals(pushRequests(a), []);
});

test("the event door: a forge read behind this very push is retried, not called stale", async () => {
  const a = await app();
  // The forge still reads the head this push moved away from.
  a.live.headSha = OTHER;
  assertEquals((await a.send(a.event({}, { before: OTHER }))).status, 503);
  assertEquals(pushRequests(a), []);
  // A head that is neither: stale.
  a.live.headSha = sha("f");
  assertEquals((await a.send(a.event({}, { before: OTHER }))).body, { outcome: "checks-stale" });
});

test("the event door: a read still behind three minutes after the push is stale, not retried", async () => {
  const a = await app();
  // Pushed back to where it was (OTHER → HEAD → OTHER): the first push's `before` is live for good.
  a.live.headSha = OTHER;
  assertEquals((await a.send(a.event({}, { before: OTHER }))).status, 503);
  a.clock.advance(3 * 60_000);
  assertEquals((await a.send(a.event({}, { before: OTHER }))).body, { outcome: "checks-stale" });
  // The same from an event the forge received long ago, the clock where it was.
  const b = await app();
  b.live.headSha = OTHER;
  assertEquals(
    (await b.send(b.event({ receivedAt: "2025-12-31T23:56:59.000Z" }, { before: OTHER }))).body,
    { outcome: "checks-stale" },
  );
  assertEquals([...pushRequests(a), ...pushRequests(b)], []);
});

test("the event door: a stale push withdraws a live ask of its own head, and only that", async () => {
  const a = await app();
  await a.send(a.event({ deliveryId: "d-1" }));
  // OTHER's delivery crashed after filing, before its supersede: both asks are live.
  a.live.headSha = OTHER;
  hideOnce(a);
  const create = a.checkStore.createRequest;
  a.checkStore.createRequest = async (request) => {
    a.checkStore.createRequest = create;
    await create(request);
    throw new Error("crashed before the supersede");
  };
  await assertRejects(() => a.send(a.event({ deliveryId: "d-2" }, { headSha: OTHER })));
  assertEquals(pushRequests(a).filter((r) => r.state === "pending").length, 2);
  // HEAD's delivery again, with OTHER live and not what the push moved away from.
  assertEquals((await a.send(a.event({ deliveryId: "d-3" }, { before: sha("f") }))).body, {
    outcome: "checks-stale",
  });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [
    [HEAD, "superseded"],
    [OTHER, "pending"],
  ]);
});

test("the event door: a change request closed before the read after filing leaves nothing live", async () => {
  const a = await app();
  a.live.onRead = (n) => {
    if (n === 1) a.live.read = "closed";
  };
  assertEquals((await a.send(a.event())).body, { outcome: "checks-stale" });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [[HEAD, "superseded"]]);
});

test("the event door: a redelivery whose read after filing finds the head moved withdraws its ask", async () => {
  const a = await app();
  assertEquals((await a.send(a.event({ deliveryId: "d-1" }))).body, {
    outcome: "checks-requested",
  });
  // The same head again; between its first read and the one after, a newer push lands.
  a.live.onRead = (n) => {
    if (n === 3) a.live.headSha = OTHER;
  };
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, { outcome: "checks-stale" });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [[HEAD, "superseded"]]);
});

test("the event door: a push found stale after filing withdraws only its own ask", async () => {
  const a = await app();
  a.live.headSha = OTHER;
  await a.send(a.event({ deliveryId: "d-1" }, { headSha: OTHER }));
  // A slow delivery of an older head: the first read is from before the newer push landed,
  // the read after filing sees the live head.
  a.live.headSha = HEAD;
  a.live.onRead = (n) => {
    if (n === 3) a.live.headSha = OTHER;
  };
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, {
    outcome: "checks-stale",
  });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [
    [OTHER, "pending"],
    [HEAD, "superseded"],
  ]);
});

test("the event door: a retarget that kept the head, handled first, outlives a slow push read at the old base", async () => {
  const a = await app();
  a.files.set("release", structuredClone(a.files.get("*")!));
  // The retarget's own delivery, handled first: the head at its new base.
  a.live.baseRef = "release";
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }, { baseRef: "release" }))).body, {
    outcome: "checks-requested",
  });
  // A slower delivery of the same head whose first read was from before the retarget; the read
  // after filing sees the base moved. The head alone is still live, but its base is not.
  a.live.baseRef = "main";
  a.live.onRead = (n) => {
    if (n === 3) a.live.baseRef = "release";
  };
  assertEquals((await a.send(a.event({ deliveryId: "d-1" }))).body, { outcome: "checks-stale" });
  assertEquals(pushRequests(a).map((r) => [r.checksRef, r.state]), [
    ["release", "pending"],
    ["main", "superseded"],
  ]);
});

test("the event door: a redelivery whose read after filing finds the base moved withdraws its ask", async () => {
  const a = await app();
  a.files.set("release", structuredClone(a.files.get("*")!));
  assertEquals((await a.send(a.event({ deliveryId: "d-1" }))).body, {
    outcome: "checks-requested",
  });
  a.live.onRead = (n) => {
    if (n === 3) a.live.baseRef = "release";
  };
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, { outcome: "checks-stale" });
  assertEquals(pushRequests(a).map((r) => [r.checksRef, r.state]), [["main", "superseded"]]);
  // A base that is no branch of the repo is judged by the default branch: no move at all.
  const b = await app();
  b.live.onRead = (n) => {
    if (n === 1) b.live.baseRef = "refs/pull/7/head";
  };
  assertEquals((await b.send(b.event())).body, { outcome: "checks-requested" });
});

test("the event door: a read after filing that does not answer leaves it all for the retry", async () => {
  const a = await app();
  a.live.headSha = OTHER;
  await a.send(a.event({ deliveryId: "d-1" }, { headSha: OTHER }));
  a.live.headSha = HEAD;
  a.live.onRead = (n) => {
    if (n === 3) a.live.read = "unavailable";
  };
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).status, 503);
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [
    [OTHER, "pending"],
    [HEAD, "pending"],
  ]);
  // The retry, the forge answering again with HEAD live: HEAD stands, OTHER goes.
  a.live.read = "open";
  a.live.onRead = undefined;
  assertEquals((await a.send(a.event({ deliveryId: "d-2" }))).body, {
    outcome: "checks-unchanged",
  });
  assertEquals(pushRequests(a).map((r) => [r.commit, r.state]), [
    [OTHER, "superseded"],
    [HEAD, "pending"],
  ]);
});

test("the event door: a Radicle patch end to end, its author a DID asked for delegacy", async () => {
  const a = await app();
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-rad",
    provider: "radicle",
    installationId: null,
    repoRef: RID,
    url: RID,
  });
  const patchId = "b".repeat(40);
  const sent = await a.send(a.event({
    repo: { provider: "radicle", repoRef: RID, url: RID },
    actorLogin: "did:key:zBob",
    thread: { kind: "change_request", ref: patchId },
  }, { ref: patchId, fetchRef: null, url: null, author: "did:key:zBob" }));
  assertEquals(sent.body, { outcome: "checks-requested" });
  assertEquals(a.asked, [{ subject: "did:key:zBob", atLeast: "admin" }]);
  await a.checksService.tick();
  await a.checksService.tick();
  const suite = a.onlySuite();
  assertEquals([suite.connectedRepoId, suite.source.branchName], ["cr-rad", `patches/${patchId}`]);
  a.launched.finish(a.nameOf(suite), { lint: 0, test: 0 });
  await a.checksService.tick();
  assertEquals(a.reports.at(-1)!.suite.conclusion, "success");
});

test("the event door judges a Radicle patch by its author's revision, not a later one", async () => {
  const a = await app();
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-rad",
    provider: "radicle",
    installationId: null,
    repoRef: RID,
    url: RID,
  });
  // Someone else added a revision on top of the author's: the patch's newest head is theirs.
  a.live.headSha = OTHER;
  a.live.authorHeadSha = HEAD;
  const patchId = "c".repeat(40);
  const event = (headSha: string, deliveryId: string) =>
    a.event({
      deliveryId,
      repo: { provider: "radicle", repoRef: RID, url: RID },
      actorLogin: "did:key:zBob",
      thread: { kind: "change_request", ref: patchId },
    }, { ref: patchId, headSha, fetchRef: null, url: null, author: "did:key:zBob" });
  assertEquals((await a.send(event(OTHER, "d-1"))).body, { outcome: "checks-stale" });
  assertEquals((await a.send(event(HEAD, "d-2"))).body, { outcome: "checks-requested" });
  assertEquals(pushRequests(a, patchId).map((r) => r.commit), [HEAD]);
});

// ---- outside contributions: a comment, an approval page, and checks once approved ----------

const APP = "https://ryph.example";

/** A stranger's push: mallory opened #42 from a fork, and pushed to it. */
const strangerPush = (a: Awaited<ReturnType<typeof app>>, over: Record<string, unknown> = {}) =>
  a.event({ actorLogin: "mallory", ...over }, { author: "mallory" });

const onlyApprovalId = (a: Awaited<ReturnType<typeof app>>): string => {
  const ids = [...a.checkStore.approvals.values()].filter((x) => x.state === "pending")
    .map((x) => x.id);
  assertEquals(ids.length, 1);
  return ids[0];
};

const onlyApprovalIdOrNull = (a: Awaited<ReturnType<typeof app>>) =>
  [...a.checkStore.approvals.values()].find((x) => x.state === "pending") ?? null;

test("an outside contribution gets a comment linking its approval page, once per head", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  assertEquals((await a.send(strangerPush(a))).body, { outcome: "checks-awaiting-approval" });
  assertEquals(pushRequests(a), [], "nothing runs before someone approves");
  const id = onlyApprovalId(a);
  const approval = (await a.checkStore.getApproval(id))!;
  assertEquals(
    [approval.changeRequest, approval.headSha, approval.author, approval.commentId],
    ["42", HEAD, "mallory", "c-1"],
  );
  const comment = a.comments.get("c-1")!;
  assertEquals(comment.thread, "42");
  assert(comment.body.includes(`(${APP}/checks/approvals/${id})`), comment.body);
  assert(comment.body.includes(HEAD.slice(0, 7)));
  // A redelivery, or another delivery of the same head, posts nothing more.
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.commentLog, ["post c-1"]);
  assertEquals(a.checkStore.approvals.size, 1);
});

test("an outside contribution to a repo that declares no checks gets no comment", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  a.files.set("*", { kind: "absent", commit: HEAD });
  assertEquals((await a.send(strangerPush(a))).body, { outcome: "checks-none" });
  assertEquals(a.commentLog, []);
  assertEquals(a.checkStore.approvals.size, 0);
  // A checks file that cannot be read yet is retried, never commented on blind.
  a.files.set("*", { kind: "unavailable", detail: "forge down" });
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).status, 503);
  assertEquals(a.commentLog, []);
});

test("an outside contribution into a base the forge serves no commit of gets no comment", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  // The forge refused the base outright (not a branch it serves): no declaration to read.
  a.files.set("*", { kind: "invalid", commit: null, detail: "main is not a branch of the repo" });
  assertEquals((await a.send(strangerPush(a))).body, { outcome: "checks-none" });
  assertEquals(a.commentLog, []);
  assertEquals(a.checkStore.approvals.size, 0);
  // A file that is there but invalid still declares checks: the push waits for approval.
  a.files.set("*", { kind: "invalid", commit: HEAD, detail: "checks.yml is over 64 KiB" });
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.commentLog, ["post c-1"]);
});

test("approving runs the head's checks, names the approver in the comment, and sends back", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  await a.send(strangerPush(a));
  const id = onlyApprovalId(a);

  const view = await a.call("GET", `/v1/check-approvals/${id}`);
  assertEquals(view.status, 200);
  const shown = (await view.json()).approval;
  assertEquals(
    [shown.state, shown.author, shown.headSha, shown.url, shown.repo.repoRef],
    ["pending", "mallory", HEAD, "https://github.com/acme/api/pull/42", "acme/api"],
  );

  const res = await a.call("POST", `/v1/check-approvals/${id}/approve`);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.returnTo, "https://github.com/acme/api/pull/42");
  assertEquals([body.approval.state, body.approval.approvedByLogin], ["approved", "grace"]);
  // Asked exactly as a trusted push is: at the live base, reported on the change request.
  const [request] = pushRequests(a);
  assertEquals([request.commit, request.checksRef], [HEAD, "main"]);
  assert(await a.checkStore.findForgeReport({ requestId: request.id }) !== null);
  const comment = a.comments.get("c-1")!.body;
  assert(comment.includes("@grace approved"), comment);
  assert(!comment.includes("/checks/approvals/"), "the link is gone once approved");
  // Approving again changes nothing, and a redelivery of the approved head runs as trusted.
  assertEquals((await a.call("POST", `/v1/check-approvals/${id}/approve`)).status, 200);
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).body, {
    outcome: "checks-unchanged",
  });
  assertEquals(pushRequests(a).length, 1);
  assertEquals(a.commentLog, ["post c-1", "edit c-1"]);
});

test("a new push needs approving again, in the same comment", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  await a.send(strangerPush(a));
  const first = onlyApprovalId(a);
  assertEquals((await a.call("POST", `/v1/check-approvals/${first}/approve`)).status, 200);

  a.live.headSha = OTHER;
  assertEquals(
    (await a.send(a.event({ deliveryId: "d-2", actorLogin: "mallory" }, {
      author: "mallory",
      headSha: OTHER,
    }))).body,
    { outcome: "checks-awaiting-approval" },
  );
  const second = onlyApprovalId(a);
  assert(second !== first);
  assertEquals(a.commentLog, ["post c-1", "edit c-1", "edit c-1"]);
  const comment = a.comments.get("c-1")!.body;
  assert(comment.includes(`/checks/approvals/${second}`), comment);
  assert(comment.includes(`Checks on \`${HEAD.slice(0, 7)}\` were approved by @grace`), comment);
  // Only the approved head was asked for.
  assertEquals(pushRequests(a).map((r) => r.commit), [HEAD]);

  // A third head before anyone approved the second sets the second aside.
  a.live.headSha = sha("f");
  await a.send(a.event({ deliveryId: "d-3", actorLogin: "mallory" }, {
    author: "mallory",
    headSha: sha("f"),
  }));
  assertEquals((await a.checkStore.getApproval(second))!.state, "superseded");
  const stale = await a.call("POST", `/v1/check-approvals/${second}/approve`);
  assertEquals(stale.status, 409);
  assertEquals(pushRequests(a).map((r) => r.commit), [HEAD]);
});

test("approving reads the change request live: moved on or closed approves nothing", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  await a.send(strangerPush(a));
  const id = onlyApprovalId(a);
  // The author pushed again, and that delivery has not arrived yet.
  a.live.headSha = OTHER;
  assertEquals((await a.call("POST", `/v1/check-approvals/${id}/approve`)).status, 409);
  assertEquals((await a.checkStore.getApproval(id))!.state, "superseded");
  assertEquals(pushRequests(a), []);

  const b = await app({ permission: { mallory: "denied" }, appUrl: APP });
  await b.send(strangerPush(b));
  const closed = onlyApprovalId(b);
  b.live.read = "unavailable";
  assertEquals((await b.call("POST", `/v1/check-approvals/${closed}/approve`)).status, 503);
  assertEquals((await b.checkStore.getApproval(closed))!.state, "pending");
  b.live.read = "merged";
  assertEquals((await b.call("POST", `/v1/check-approvals/${closed}/approve`)).status, 409);
  assertEquals((await b.checkStore.getApproval(closed))!.state, "closed");
  assertEquals(pushRequests(b), []);
});

test("only someone who may command agents on the repo may approve", async () => {
  // Grace is linked, but GitHub says she has no write on acme/api.
  const a = await app({ permission: { mallory: "denied", grace: "denied" }, appUrl: APP });
  await a.send(strangerPush(a));
  const id = onlyApprovalId(a);
  assertEquals((await a.call("POST", `/v1/check-approvals/${id}/approve`)).status, 403);
  assertEquals((await a.checkStore.getApproval(id))!.state, "pending");
  assertEquals(pushRequests(a), []);
  assertEquals(a.commentLog, ["post c-1"]);
  assertEquals((await a.call("POST", "/v1/check-approvals/ca-nobody/approve")).status, 404);
  assertEquals((await a.call("GET", "/v1/check-approvals/ca-nobody")).status, 404);
});

test("an approval page is read by whoever may push to its repo, not by repos:read alone", async () => {
  // Grace reads repos, and holds the approval's link from the public comment, but has no write.
  const a = await app({ permission: { mallory: "denied", grace: "denied" }, appUrl: APP });
  await a.send(strangerPush(a));
  const id = onlyApprovalId(a);
  const hidden = await a.call("GET", `/v1/check-approvals/${id}`);
  assertEquals(hidden.status, 404, "exactly as an unknown one");
  assertEquals(await hidden.json(), { error: "no such check approval" });
  // With write on the repo she reads it; so does a reader of every task.
  const b = await app({ permission: { mallory: "denied" }, appUrl: APP });
  await b.send(strangerPush(b));
  assertEquals((await b.call("GET", `/v1/check-approvals/${onlyApprovalId(b)}`)).status, 200);
  const c = await app({
    permission: { mallory: "denied", grace: "denied" },
    appUrl: APP,
    role: "operator",
  });
  await c.send(strangerPush(c));
  assertEquals((await c.call("GET", `/v1/check-approvals/${onlyApprovalId(c)}`)).status, 200);
});

test("two deliveries of one head racing post one approval comment between them", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  const post = a.forge.postComment;
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  a.forge.postComment = async (...args) => {
    await held;
    return await post(...args);
  };
  // The first delivery is posting when its overlapping redelivery arrives.
  const first = a.send(strangerPush(a));
  while (onlyApprovalIdOrNull(a)?.commentClaimedAt == null) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const second = await a.send(strangerPush(a, { deliveryId: "d-2" }));
  assertEquals(second.status, 503, "the mailroom retries it");
  release();
  assertEquals((await first).body, { outcome: "checks-awaiting-approval" });
  // The retry finds the comment posted, and posts none of its own.
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.commentLog, ["post c-1"]);
  const approval = (await a.checkStore.getApproval(onlyApprovalId(a)))!;
  assertEquals([approval.commentId, approval.commentClaimedAt], ["c-1", null]);
});

test("a comment claim left by a delivery that died is taken over once stale", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  const post = a.forge.postComment;
  // The first delivery claims the comment and never comes back: its handler died mid-post.
  a.forge.postComment = () => new Promise(() => {});
  void a.send(strangerPush(a));
  while (onlyApprovalIdOrNull(a)?.commentClaimedAt == null) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  a.forge.postComment = post;
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-2" }))).status, 503);
  a.clock.advance(COMMENT_CLAIM_STALE_MS + 1);
  assertEquals((await a.send(strangerPush(a, { deliveryId: "d-3" }))).body, {
    outcome: "checks-awaiting-approval",
  });
  assertEquals(a.commentLog, ["post c-1"]);
  assertEquals((await a.checkStore.getApproval(onlyApprovalId(a)))!.commentId, "c-1");
});

test("a non-delegate's Radicle patch waits for a delegate's approval, as a fork's PR does", async () => {
  const PATCH = "b".repeat(40);
  const EXPLORER = `https://app.radicle.example/nodes/seed/${RID}/patches/${PATCH}`;
  const a = await app({
    permission: { "did:key:zMallory": "denied", "did:key:zEve": "denied" },
    appUrl: APP,
  });
  await a.store.createConnectedRepo({
    ...a.api,
    id: "cr-rad",
    provider: "radicle",
    installationId: null,
    repoRef: RID,
    url: RID,
  });
  const push = (deliveryId: string) =>
    a.event({
      deliveryId,
      repo: { provider: "radicle", repoRef: RID, url: RID },
      actorLogin: "did:key:zMallory",
      thread: { kind: "change_request", ref: PATCH },
    }, { ref: PATCH, fetchRef: null, url: EXPLORER, author: "did:key:zMallory" });
  // Anyone may open a patch from their own namespace: a non-delegate's runs nothing by itself.
  assertEquals((await a.send(push("d-1"))).body, { outcome: "checks-awaiting-approval" });
  assertEquals(pushRequests(a, PATCH), []);
  const id = onlyApprovalId(a);
  const comment = a.comments.get("c-1")!;
  assertEquals(comment.thread, PATCH);
  assert(comment.body.includes("A delegate of this repository"), comment.body);
  assert(comment.body.includes(`/checks/approvals/${id}`), comment.body);

  // A linked non-delegate may not approve: delegacy is the bar, asked live of their DID.
  a.identities.link(USER.userId, "did:key:zEve", "radicle");
  assertEquals((await a.call("POST", `/v1/check-approvals/${id}/approve`)).status, 403);
  assertEquals(pushRequests(a, PATCH), []);

  // A delegate approves: the head is asked, the comment names their DID, and they go back.
  a.identities.link(USER.userId, "did:key:zGrace", "radicle");
  const res = await a.call("POST", `/v1/check-approvals/${id}/approve`);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).returnTo, EXPLORER);
  assertEquals(pushRequests(a, PATCH).map((r) => r.commit), [HEAD]);
  assert(a.comments.get("c-1")!.body.includes("`did:key:zGrace` approved"));
  assert(a.asked.some((q) => q.subject === "did:key:zGrace" && q.atLeast === "admin"));
});

test("an approval comment that cannot be posted is retried by the mailroom", async () => {
  const a = await app({ permission: { mallory: "denied" }, appUrl: APP });
  const post = a.forge.postComment;
  a.forge.postComment = () => Promise.reject(new Error("502"));
  assertEquals((await a.send(strangerPush(a))).status, 503);
  a.forge.postComment = post;
  assertEquals((await a.send(strangerPush(a))).body, { outcome: "checks-awaiting-approval" });
  assertEquals(a.commentLog, ["post c-1"]);
  assertEquals((await a.checkStore.getApproval(onlyApprovalId(a)))!.commentId, "c-1");
});
