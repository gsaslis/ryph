// Scope over HTTP: a member sees the tasks they asked for and the tasks on repos the forge lets
// them write, a `-all` holder sees everything, a task outside the scope is a 404 like one that
// never existed, the forge's answers turn over on the cache's clock, and a run view carries the
// grants the record-holding services verify.

import { test } from "bun:test";
import { capsClaimOf, type Role } from "@ryph/auth";
import { verifyRunGrant } from "@ryph/sealed";
import { assert, assertEquals } from "@std/assert";
import { type Authenticate, makeHandler, type Principal } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { REPO_ACCESS_TTL_MS } from "../src/core/scope.ts";
import { UNKNOWN_VERDICT_TTL_MS } from "../src/http/scope.ts";
import { mapWithConcurrency } from "../src/helpers/concurrency.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import type { Forge } from "../src/ports/forge.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const API = {
  fullName: "acme/api",
  url: "https://github.com/acme/api.git",
  defaultBranch: "main",
  private: true,
};
const KEYS = { history: "history-token", models: "models-token", tools: "tools-token" };

const person = (userId: string, role: Role, via: "session" | "token" = "session"): Principal => ({
  kind: "user",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  caps: capsClaimOf(role),
  emailVerified: true,
  sid: `s-${userId}`,
  via,
});

function buildApp() {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const identities = fakeIdentityDirectory();
  // Write access by login: the forge's word, switchable so a test can watch the cache turn.
  const writers = new Set(["ada"]);
  // The forge can also fail to answer, which is neither yes nor no.
  let unreachable = false;
  const base = noopForge(silentDiagnostics(), { repos: [API] });
  const forge: Forge = {
    ...base,
    checkPermission: (_repo, identity) =>
      Promise.resolve(
        unreachable
          ? "unknown"
          : identity.subject !== null && writers.has(identity.subject)
          ? "allowed"
          : "denied",
      ),
  };
  let caller: Principal = person("ada", "member");
  const handler = makeHandler({
    store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(caller)) as Authenticate,
    forgeToken: "forge-service-token",
    runGrantKeys: KEYS,
    forge,
    githubConnect: base,
    identityDirectory: identities.directory,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    call,
    clock,
    writers,
    as: (
      userId: string,
      role: Role,
      via?: "session" | "token",
    ) => (caller = person(userId, role, via)),
    link: (userId: string, login: string) => identities.link(userId, login),
    forgeDown: (down: boolean) => unreachable = down,
  };
}

/** Ada connects the repo and starts a task on it; the task's id comes back. */
async function adaStartsATask(app: ReturnType<typeof buildApp>): Promise<string> {
  app.link("ada", "ada");
  app.as("ada", "member");
  assertEquals((await app.call("POST", "/v1/installations", { installationId: "42" })).status, 201);
  const repo = await (await app.call("POST", "/v1/connected-repos", {
    installationId: "42",
    repoRef: API.fullName,
  })).json();
  const agent = await (await app.call("POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const created = await app.call("POST", "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Build it", instructions: "Run the checks." },
    connectedRepoId: repo.id,
  });
  assertEquals(created.status, 201);
  return (await created.json()).taskId;
}

const listed = async (app: ReturnType<typeof buildApp>) =>
  ((await (await app.call("GET", "/v1/tasks")).json()).tasks as { id: string }[])
    .map((row) => row.id);

test("a member sees their own tasks and the tasks on repos they can write, nothing else", async () => {
  const app = buildApp();
  const taskId = await adaStartsATask(app);
  assertEquals(await listed(app), [taskId], "the requester sees it");

  // Bob is linked but the forge denies him write: the task is not his to see, and every door
  // answers as if it did not exist.
  app.link("bob", "bob");
  app.as("bob", "member");
  assertEquals(await listed(app), []);
  assertEquals((await app.call("GET", `/v1/tasks/${taskId}`)).status, 404);
  assertEquals((await app.call("POST", `/v1/tasks/${taskId}/cancel`)).status, 404);
  assertEquals((await app.call("GET", `/v1/tasks?ids=${taskId}`)).status, 200);
  assertEquals((await (await app.call("GET", `/v1/tasks?ids=${taskId}`)).json()).tasks, []);

  // Carol may write the repo: the forge's word makes the task hers to see, and to steer.
  app.link("carol", "carol");
  app.writers.add("carol");
  app.as("carol", "member");
  assertEquals(await listed(app), [taskId]);
  assertEquals((await app.call("GET", `/v1/tasks/${taskId}`)).status, 200);

  // An operator holds `tasks:read-all`: everything, with no forge asked.
  app.as("dan", "operator");
  assertEquals(await listed(app), [taskId]);
});

test("the forge's answers are cached per user and turn over after the TTL", async () => {
  const app = buildApp();
  const taskId = await adaStartsATask(app);
  app.link("bob", "bob");
  app.as("bob", "member");
  assertEquals(await listed(app), []);

  // The forge changes its mind, but the cache has not: nothing until it turns over.
  app.writers.add("bob");
  assertEquals(await listed(app), []);
  app.clock.advance(REPO_ACCESS_TTL_MS + 1);
  assertEquals(await listed(app), [taskId]);
});

test("a verdict the forge could not give is held briefly, in-process, then asked again", async () => {
  const app = buildApp();
  const taskId = await adaStartsATask(app);
  app.link("bob", "bob");
  app.as("bob", "member");
  app.writers.add("bob");

  // Nothing while the forge is dark — read as not writable, like a denial.
  app.forgeDown(true);
  assertEquals(await listed(app), []);
  app.forgeDown(false);
  // Right after it recovers, a poll still reads the held verdict rather than asking again on
  // every one: this is the fix (the same page polls every 3s, and "unknown" used to be asked
  // about on each one, holding a rate limit open for as long as it lasted).
  assertEquals(await listed(app), []);
  // Once the hold expires, the next request asks again and sees the recovered forge.
  app.clock.advance(UNKNOWN_VERDICT_TTL_MS + 1);
  assertEquals(await listed(app), [taskId]);
});

test("a task started with an API token records that origin, and stays its owner's", async () => {
  const app = buildApp();
  const first = await adaStartsATask(app);
  app.as("ada", "member", "token");
  const detail = await (await app.call("GET", `/v1/tasks/${first}`)).json();
  assertEquals(detail.task.origin, "user");
  const created = await app.call("POST", "/v1/tasks", {
    agentId: detail.agent.id,
    spec: { title: "From a script", instructions: "Run the checks." },
    connectedRepoId: detail.task.repos[0].connectedRepoId,
  });
  assertEquals(created.status, 201);
  const { taskId } = await created.json();
  const scripted = await (await app.call("GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(scripted.task.origin, "token");
  assertEquals(scripted.task.requestedByUserId, "ada");
});

test("a run view carries one grant per service, each verifying with that service's key, for its reader", async () => {
  const app = buildApp();
  const taskId = await adaStartsATask(app);
  const detail = await (await app.call("GET", `/v1/tasks/${taskId}`)).json();
  const run = detail.runs[0];
  const now = app.clock.now();
  assert(typeof run.grants.history === "string");
  assert(await verifyRunGrant(KEYS.history, run.grants.history, run.id, "ada", now));
  assert(await verifyRunGrant(KEYS.models, run.grants.models, run.id, "ada", now));
  assert(await verifyRunGrant(KEYS.tools, run.grants.tools, run.id, "ada", now));
  assert(!await verifyRunGrant(KEYS.models, run.grants.history, run.id, "ada", now));
  // Bound to the person it was shown to: nobody else's bearer rides it.
  assert(!await verifyRunGrant(KEYS.history, run.grants.history, run.id, "grace", now));
});

test("mapWithConcurrency never runs more than the limit at once, and every item lands", async () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, 5, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // A spread of delays so slower and faster items interleave, not a strict batch of 5.
    await new Promise((resolve) => setTimeout(resolve, (n % 3) * 2));
    inFlight--;
    return n * 2;
  });
  assertEquals(results, items.map((n) => n * 2), "every item lands, in its own order");
  assert(peak <= 5, `never more than the limit in flight at once (saw ${peak})`);
  assert(peak > 1, "the limit is a cap, not an accidental serialization");
});

test("mapWithConcurrency past the item count runs every item exactly once", async () => {
  const seen: number[] = [];
  const results = await mapWithConcurrency([1, 2, 3], 50, (n) => {
    seen.push(n);
    return Promise.resolve(n + 1);
  });
  assertEquals(results, [2, 3, 4]);
  assertEquals(seen.sort(), [1, 2, 3]);
});
