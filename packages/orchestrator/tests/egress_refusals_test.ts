// Refused egress, from the proxy's POST to the words a person reads.
//
// The failure this file exists to keep fixed is one that was measured on a live deployment: the
// proxy refused `dl.deno.land`, wrote one line to its own stderr, and nothing downstream ever
// heard. A run failed in setup saying only `tunnel error: unsuccessful`, and two environment
// builds that were refused a host settled `ready` and shipped images missing what it was for.
//
// So the assertions here are about ARRIVAL and WORDING, not about the proxy's policy — that is
// egress_test.ts, which drives both halves of the token format. This drives the route, the two
// records, and what the run, the card and the agent's message end up saying.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { mintEgressToken } from "../src/core/egress.ts";
import { composeBuildResult } from "../src/core/environment_messages.ts";
import { toEnvironmentView } from "../src/http/environments_api.ts";
import type { Environment } from "../src/core/types.ts";
import { fakeRunnerControl } from "./doubles.ts";
import { sha, tree, world, type WorldOptions } from "./environment_world.ts";

const KEY = new Uint8Array(32).fill(5);
const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: ["*"],
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;

/** A world with an egress key, which is the only condition on the refusal route being mounted. */
async function app(opts: WorldOptions = {}) {
  const w = await world({
    egress: {
      policy: {
        mode: "proxy",
        bundles: ["npm"],
        hosts: [],
        proxyUrl: "http://egress-proxy.test:7460",
      },
      key: KEY,
      tokenTtlMs: 60 * 60 * 1000,
    },
    ...opts,
  });
  const handler = makeHandler({
    store: w.store,
    provisioner: w.deps.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forge: w.forge,
    environments: w.service,
    now: w.clock.now,
    config: { ...w.config, harnessKinds: ["pi", "echo"] },
  });
  /** The proxy's POST: the subject's own claim as the bearer, host and port as the body. */
  const report = async (subjectId: string, host: string, port = 443, token?: string) =>
    await handler(
      new Request("http://orchestrator.test/v1/egress/refusals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${
            token ?? await mintEgressToken(KEY, {
              runId: subjectId,
              expiresAt: Math.floor(w.clock.now().getTime() / 1000) + 600,
              hosts: ["registry.npmjs.org"],
            })
          }`,
        },
        body: JSON.stringify({ host, port }),
      }),
    );
  const get = async (path: string) =>
    await handler(
      new Request(`http://orchestrator.test${path}`, {
        headers: { authorization: "Bearer t" },
      }),
    );
  return { ...w, handler, report, get };
}

async function startedRun(a: Awaited<ReturnType<typeof app>>) {
  const started = await a.startRepo();
  assertEquals(started.kind, "started");
  return (started as { runId: string }).runId;
}

/** Queues a default-branch build of acme/api and parks its builder. */
async function queuedBuild(a: Awaited<ReturnType<typeof app>>): Promise<Environment> {
  const subject = (await a.service!.loadSubject("repo", "cr-api"))!;
  return await a.service!.enqueue({
    subject,
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit: sha("a") }],
    definition: tree("a"),
    dockerfile: true,
    machine: null,
    trigger: "push",
  });
}

test("a refusal reaches the run's events, naming the host and the bundle an admin could use", async () => {
  const a = await app();
  const runId = await startedRun(a);

  assertEquals((await a.report(runId, "dl.deno.land")).status, 204);

  const events = (await a.store.listEvents(runId)).filter((e) => e.kind === "egress.refused");
  assertEquals(events.length, 1);
  assertStringIncludes(events[0].detail ?? "", "dl.deno.land:443");
  // The catalogue's own answer, not a guess: `dl.deno.land` is the Deno bundle's.
  assertStringIncludes(events[0].detail ?? "", "Deno & JSR");
  // And who may act on it. Never the agent, never an ordinary user.
  assertStringIncludes(events[0].detail ?? "", "an admin can allow it");
});

test("the refused hosts are folded into what a person reads off the run", async () => {
  const a = await app();
  const runId = await startedRun(a);
  await a.report(runId, "dl.deno.land");
  await a.report(runId, "nobody.example.test", 80);

  const run = (await a.store.getRun(runId))!;
  const detail = await (await a.get(`/v1/tasks/${run.taskId}`)).json();
  const note: string = detail.runs[0].egressNote;
  assert(note !== null, "the run's outcome said nothing about the refusals");
  assertStringIncludes(note, "The egress proxy refused 2 connections");
  assertStringIncludes(note, "dl.deno.land");
  assertStringIncludes(note, "Deno & JSR");
  // A host no bundle covers degrades to the other half of the remedy rather than to silence.
  assertStringIncludes(note, "nobody.example.test");
  assertStringIncludes(note, "no bundle in the catalogue covers it");
  assertStringIncludes(note, "Settings → Internet access");
});

test("a build that SUCCEEDED while being refused a host still says so", async () => {
  const a = await app();
  const row = await queuedBuild(a);
  const [build] = await a.builder.parked(1);

  assertEquals((await a.report(row.id, "dl.deno.land")).status, 204);
  // The build ends well, which is the whole case: a RUN step swallowed the download's exit code.
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  await a.service!.idle();

  const settled = a.environmentStore.rows.get(row.id)!;
  assertEquals(settled.status, "ready");
  // The settle writes the whole row, so this is also the regression test for it dropping the
  // refusals recorded while the build ran.
  assertEquals(settled.egressRefusals?.map((r) => r.host), ["dl.deno.land"]);

  const card = toEnvironmentView(settled);
  assert(card.egressNote !== null, "a ready build said nothing about being refused");
  assertStringIncludes(card.egressNote, "may have finished anyway");
  assertStringIncludes(card.egressNote, "dl.deno.land");
  assertStringIncludes(card.egressNote, "Deno & JSR");
});

test("the build-result message an agent reads names the refused hosts, fenced", async () => {
  const a = await app();
  const row = await queuedBuild(a);
  const [build] = await a.builder.parked(1);
  await a.report(row.id, "dl.deno.land");
  await a.report(row.id, "nobody.example.test");
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  await a.service!.idle();

  const message = composeBuildResult({
    patch: { id: "p-1", path: "api", headSha: sha("b") },
    branch: "ryph/thing",
    environment: a.environmentStore.rows.get(row.id)!,
    nonce: "deadbeefdeadbeef",
  });
  assertStringIncludes(message, "The egress proxy refused 2 connections");
  // The remedy, and who owns it — an agent must not go looking for a control it does not have.
  assertStringIncludes(message, "YOU CANNOT CHANGE THIS");
  assertStringIncludes(message, "Settings → Internet access");
  // Fenced like the build's own words: the names came out of what the repo chose to dial.
  assertStringIncludes(message, "<<<build-output-deadbeefdeadbeef>>>");
  assertStringIncludes(message, `dl.deno.land:443 — the "Deno & JSR" bundle`);
  assertStringIncludes(message, "nobody.example.test:443 — no bundle in the catalogue covers it");
});

test("a report for an ended subject is dropped, and says so", async () => {
  const a = await app();

  // A run that is over. 410 rather than 204: the proxy is being told to stop reporting for
  // this claim, which is a different instruction from "recorded".
  const runId = await startedRun(a);
  const run = (await a.store.getRun(runId))!;
  await a.store.saveRunResult({ ...run, state: "succeeded" });
  const ended = await a.report(runId, "dl.deno.land");
  assertEquals(ended.status, 410);
  assertEquals((await ended.json()).code, "subject_ended");
  assertEquals((await a.store.getRun(runId))!.egressRefusals, null);
  assertEquals((await a.store.listEvents(runId)).filter((e) => e.kind === "egress.refused"), []);

  // A build that has settled, and a subject that was never here at all — the same answer.
  const row = await queuedBuild(a);
  const [build] = await a.builder.parked(1);
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  await a.service!.idle();
  assertEquals((await a.report(row.id, "dl.deno.land")).status, 410);
  assertEquals((await a.report("env-nobody", "dl.deno.land")).status, 410);
});

test("the same host twice is recorded once, and a flood stops at the cap", async () => {
  const a = await app();
  const runId = await startedRun(a);

  // Dedupe is on host AND port: `:80` and `:443` are two different missing grants.
  for (let i = 0; i < 3; i++) assertEquals((await a.report(runId, "dl.deno.land")).status, 204);
  await a.report(runId, "dl.deno.land", 80);
  assertEquals((await a.store.getRun(runId))!.egressRefusals?.length, 2);
  assertEquals(
    (await a.store.listEvents(runId)).filter((e) => e.kind === "egress.refused").length,
    2,
    "a repeat wrote a second line into the trail",
  );

  // A loop that discovers a new name every attempt. The cap holds, and — because it drops
  // rather than evicts — the hosts that explain the failure are the ones that survive.
  for (let i = 0; i < 50; i++) await a.report(runId, `h${i}.example.test`);
  const refusals = (await a.store.getRun(runId))!.egressRefusals!;
  assertEquals(refusals.length, 20);
  assertEquals(refusals[0].host, "dl.deno.land");
});

test("the route is the claim's, and the claim names the subject", async () => {
  const a = await app();
  const runId = await startedRun(a);

  // No bearer, a forged one, and one signed by a key this deployment does not hold: one answer.
  assertEquals(
    (await a.handler(
      new Request("http://orchestrator.test/v1/egress/refusals", {
        method: "POST",
        body: JSON.stringify({ host: "dl.deno.land", port: 443 }),
      }),
    )).status,
    401,
  );
  assertEquals((await a.report(runId, "dl.deno.land", 443, "v1.nonsense.sig")).status, 401);
  const foreign = await mintEgressToken(new Uint8Array(32).fill(9), {
    runId,
    expiresAt: Math.floor(a.clock.now().getTime() / 1000) + 600,
    hosts: [],
  });
  assertEquals((await a.report(runId, "dl.deno.land", 443, foreign)).status, 401);

  // A valid claim for ANOTHER subject cannot report against this run: the id is read off the
  // signature, so there is no body field to point somewhere else.
  const elsewhere = await mintEgressToken(KEY, {
    runId: "r-somebody-else",
    expiresAt: Math.floor(a.clock.now().getTime() / 1000) + 600,
    hosts: [],
  });
  assertEquals((await a.report(runId, "dl.deno.land", 443, elsewhere)).status, 410);
  assertEquals((await a.store.getRun(runId))!.egressRefusals, null);

  // A host that is not one a CONNECT line could carry dies at the ingest boundary.
  assertEquals((await a.report(runId, "not a host")).status, 400);
  assertEquals((await a.report(runId, "dl.deno.land", 0)).status, 400);
});

test("without an egress key the route is not mounted at all", async () => {
  const w = await world();
  const handler = makeHandler({
    store: w.store,
    provisioner: w.deps.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forge: w.forge,
    environments: w.service,
    now: w.clock.now,
    config: { ...w.config, harnessKinds: ["pi", "echo"] },
  });
  const res = await handler(
    new Request("http://orchestrator.test/v1/egress/refusals", {
      method: "POST",
      headers: { authorization: "Bearer anything" },
      body: JSON.stringify({ host: "dl.deno.land", port: 443 }),
    }),
  );
  assertEquals(res.status, 404);
});
