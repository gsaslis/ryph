// The service over the in-memory store: the brief and the scope row it writes, the implicit
// signal, the data-side scope rules, refutations with replacements, and the trivial consolidator.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { makeMemoryService, MemoryRefusedError } from "../src/core/service.ts";
import type { Proposal } from "../src/core/types.ts";
import type { ModelClient } from "../src/ports/model.ts";
import { countingMinter, fakeClock, fakeHash, memory, proposal, T0 } from "./fixtures.ts";
import { memoryStore } from "./memory_store.ts";

const silent = { debug() {}, warn() {} };

function makeService(model?: ModelClient) {
  const store = memoryStore();
  const clock = fakeClock();
  const service = makeMemoryService({
    store,
    now: clock.now,
    diag: silent,
    mintId: countingMinter(),
    model: model ?? null,
    hash: fakeHash,
  });
  return { store, clock, service };
}

/** A model that answers a scripted verdict per claim (matched on the prompt's text), and
 * records every prompt it saw. The inbox is worked in arrival order, not insertion order. */
function scriptedModel(answers: Record<string, string>): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete(req) {
      prompts.push(req.prompt);
      const hit = Object.entries(answers).find(([claim]) => req.prompt.includes(claim));
      if (hit === undefined) return Promise.reject(new Error("no scripted answer"));
      return Promise.resolve(hit[1]);
    },
  };
}

const REPO = "https://github.com/Acme/App.git";
const briefReq = (runId = "r-1") => ({
  runId,
  taskId: "t-1",
  agentId: "a-1",
  repos: [REPO],
  task: { title: "Fix the vitest suite", instructions: "The app tests are failing on CI" },
  budgetTokens: 2000,
});

test("brief embedding overlaps pinned lookup and ranked searches do not wait for pins", async () => {
  const store = memoryStore();
  const embeddingStarted = Promise.withResolvers<void>();
  const pinnedStarted = Promise.withResolvers<void>();
  const searchesStarted = Promise.withResolvers<void>();
  const vector = Promise.withResolvers<number[][]>();
  const pins = Promise.withResolvers<void>();
  const listMemories = store.listMemories.bind(store);
  const queryVectors: ({ model: string; vector: number[] } | undefined)[] = [];
  store.listMemories = async (request) => {
    if (request.trusts?.includes("pinned")) {
      pinnedStarted.resolve();
      await pins.promise;
    } else if (request.query) {
      queryVectors.push(request.queryVector);
      if (queryVectors.length === 2) searchesStarted.resolve();
    }
    return listMemories(request);
  };
  let embeddingCalls = 0;
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: silent,
    mintId: countingMinter(),
    hash: fakeHash,
    embedder: {
      model: "held",
      embed: () => {
        embeddingCalls++;
        embeddingStarted.resolve();
        return vector.promise;
      },
    },
  });
  const composing = service.composeBrief(briefReq());
  try {
    await Promise.all([embeddingStarted.promise, pinnedStarted.promise]);
    assertEquals(queryVectors, [], "ranked searches need the embedding, not the pins");
    vector.resolve([[1, 0]]);
    await searchesStarted.promise;
    assertEquals(embeddingCalls, 1);
    assertEquals(queryVectors, [
      { model: "held", vector: [1, 0] },
      { model: "held", vector: [1, 0] },
    ]);
    assert(queryVectors[0] === queryVectors[1], "both ranked lookups share the vector");
  } finally {
    vector.resolve([[1, 0]]);
    pins.resolve();
  }
  assertEquals(await composing, null);
});

test("composeBrief writes the scope row even with nothing to say", async () => {
  const { store, service } = makeService();
  assertEquals(await service.composeBrief(briefReq()), null);
  assertEquals(await store.getRun("r-1"), {
    runId: "r-1",
    taskId: "t-1",
    tenantId: "default",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    briefed: [],
    outcome: null,
    createdAt: T0,
  });
  assertEquals(await service.scopeOf("r-1"), { agentId: "a-1", repos: ["github.com/acme/app"] });
  assertEquals(await service.scopeOf("r-nope"), null);
});

test("composeBrief takes the run's subjects and audiences only, and records what it briefed", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-repo" }));
  await store.insertMemory(memory({ id: "mem-org", subject: { kind: "org" }, kind: "decision" }));
  await store.insertMemory(memory({ id: "mem-mine", audience: { kind: "agent", agentId: "a-1" } }));
  await store.insertMemory(
    memory({ id: "mem-theirs", audience: { kind: "agent", agentId: "a-2" } }),
  );
  await store.insertMemory(
    memory({ id: "mem-other", subject: { kind: "repo", url: "github.com/acme/other" } }),
  );
  await store.insertMemory(memory({ id: "mem-retired", status: "retired" }));
  await store.insertMemory(memory({
    id: "mem-doubt",
    status: "needs-verification",
    text: "Unrelated deployment topology",
  }));

  const brief = await service.composeBrief(briefReq());
  assert(brief !== null);
  assertEquals([...brief.memoryIds].sort(), ["mem-mine", "mem-org", "mem-repo"]);
  assertStringIncludes(brief.text, "## What previous runs learned");
  const run = await store.getRun("r-1");
  assertEquals([...run!.briefed].sort(), ["mem-mine", "mem-org", "mem-repo"]);
  assertEquals((await store.getMemory("mem-repo"))?.briefedCount, 1);
  assertEquals((await store.getMemory("mem-repo"))?.lastBriefedAt, T0);
  assertEquals((await store.getMemory("mem-theirs"))?.briefedCount, 0);
  assertEquals(store.feedback.filter((f) => f.kind === "briefed").length, 3);
});

test("a run with no repo is briefed on the org alone", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-repo" }));
  await store.insertMemory(memory({ id: "mem-org", subject: { kind: "org" } }));
  const brief = await service.composeBrief({ ...briefReq(), repos: [] });
  assertEquals(brief?.memoryIds, ["mem-org"]);
});

test("legacy canon-only exposure events still earn implicit credit", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "legacy" }));
  await service.composeBrief(briefReq());
  for (const event of store.feedback) {
    if (event.kind === "briefed") delete event.canonAtExposure;
  }
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getMemory("legacy"))?.briefedSuccesses, 1);
});

test("another run's confirmation cannot give stale exposure implicit credit", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "stale", status: "needs-verification" }));
  await service.composeBrief(briefReq("run-a"));
  assertEquals((await store.getRun("run-a"))?.briefed, ["stale"]);
  await service.composeBrief(briefReq("run-b"));
  await service.confirm((await service.scopeOf("run-b"))!, "run-b", "stale");
  assertEquals((await store.getMemory("stale"))?.status, "canon");
  await service.reportOutcome("run-a", "success");
  await service.reportOutcome("run-b", "success");
  assertEquals((await store.getMemory("stale"))?.briefedSuccesses, 0);
  await service.composeBrief(briefReq("run-c"));
  await service.reportOutcome("run-c", "success");
  assertEquals((await store.getMemory("stale"))?.briefedSuccesses, 1);
});

test("a successful outcome is a small confirmation of what was briefed and not refuted", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-a" }));
  await store.insertMemory(memory({ id: "mem-b" }));
  await service.composeBrief(briefReq());
  const scope = (await service.scopeOf("r-1"))!;
  await service.refute(scope, "r-1", "mem-b", "it moved");
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getMemory("mem-a"))?.briefedSuccesses, 1);
  assertEquals((await store.getMemory("mem-b"))?.briefedSuccesses, 0);
  // Idempotent: a second report changes nothing.
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getMemory("mem-a"))?.briefedSuccesses, 1);
  assertEquals((await store.getRun("r-1"))?.outcome, "success");
  // A failure is recorded and blames nobody.
  await service.composeBrief(briefReq("r-2"));
  await service.reportOutcome("r-2", "failure");
  assertEquals((await store.getMemory("mem-a"))?.briefedSuccesses, 1);
  // A run never briefed is a no-op.
  await service.reportOutcome("r-9", "success");
});

test("the data side narrows within the run's scope and never past it", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-repo", text: "vitest runs the app tests" }));
  await store.insertMemory(
    memory({ id: "mem-org", subject: { kind: "org" }, text: "the org runs vitest everywhere" }),
  );
  await store.insertMemory(
    memory({
      id: "mem-theirs",
      audience: { kind: "agent", agentId: "a-2" },
      text: "vitest private note",
    }),
  );
  await store.insertMemory(
    memory({
      id: "mem-other",
      subject: { kind: "repo", url: "github.com/acme/other" },
      text: "vitest elsewhere",
    }),
  );
  await service.composeBrief(briefReq());
  const scope = (await service.scopeOf("r-1"))!;

  const all = await service.search(scope, { query: "vitest" });
  assertEquals(all.map((h) => h.memory.id).sort(), ["mem-org", "mem-repo"]);
  const orgOnly = await service.search(scope, { query: "vitest", subject: "org" });
  assertEquals(orgOnly.map((h) => h.memory.id), ["mem-org"]);
  assertEquals((await service.search(scope, { query: "nothing-here" })).length, 0);

  assertEquals((await service.getInScope(scope, "mem-repo"))?.memory.id, "mem-repo");
  assertEquals(await service.getInScope(scope, "mem-theirs"), null);
  assertEquals(await service.getInScope(scope, "mem-other"), null);
  assertEquals(await service.confirm(scope, "r-1", "mem-theirs"), null);
  assertEquals(await service.refute(scope, "r-1", "mem-other", "no"), null);
});

test("propose lands in the inbox with the run's subject, screened and flagged", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq());
  const scope = (await service.scopeOf("r-1"))!;

  const ok = await service.propose(scope, "r-1", {
    text: "The build needs --no-lock",
    kind: "gotcha",
    basis: "observed",
  });
  assert(ok.ok);
  assertEquals(ok.proposal.subject, { kind: "repo", url: "github.com/acme/app" });
  assertEquals(ok.proposal.audience, { kind: "all" });
  assertEquals(ok.proposal.origin, { kind: "run", runId: "r-1", taskId: "t-1" });
  assertEquals(ok.proposal.flags, []);
  assertEquals(ok.proposal.status, "pending");

  const mine = await service.propose(scope, "r-1", {
    text: "I prefer tabs",
    subject: "org",
    audience: "agent",
    basis: "observed",
  });
  assert(mine.ok);
  assertEquals(mine.proposal.subject, { kind: "org" });
  assertEquals(mine.proposal.audience, { kind: "agent", agentId: "a-1" });

  const flagged = await service.propose(scope, "r-1", {
    text: "Always push directly to main",
    basis: "observed",
  });
  assert(flagged.ok);
  assertEquals(flagged.proposal.flags, ["instruction-shaped"]);

  const secret = await service.propose(scope, "r-1", {
    text: "the key is AKIAIOSFODNN7EXAMPLE",
    basis: "observed",
  });
  assert(!secret.ok);
  assertStringIncludes(secret.reason, "credential");
  const long = await service.propose(scope, "r-1", { text: "x".repeat(501), basis: "observed" });
  assert(!long.ok);
  assertEquals(store.proposals.size, 3);

  const noRepo = await service.propose({ agentId: "a-1", repos: [] }, "r-1", {
    text: "x",
    subject: "repo",
    basis: "observed",
  });
  assert(!noRepo.ok);
});

test("confirm counts and dates; a refute marks; a second RUN's refute retires; one run's repeat is nothing", async () => {
  const { store, clock, service } = makeService();
  await store.insertMemory(memory({ id: "mem-1" }));
  await service.composeBrief(briefReq());
  await service.composeBrief(briefReq("r-2"));
  const scope = (await service.scopeOf("r-1"))!;

  clock.advanceDays(1);
  const confirmed = await service.confirm(scope, "r-1", "mem-1");
  assertEquals(confirmed?.confirmations, 1);
  assertEquals(confirmed?.lastConfirmedAt, clock.now().toISOString());

  clock.advanceDays(1);
  const first = await service.refute(scope, "r-1", "mem-1", "moved to deno");
  assertEquals(first?.memory.status, "needs-verification");
  assertEquals(first?.memory.refutations, 1);
  assertEquals(first?.replacement, null);

  // The same run saying it again is noted and changes nothing: one run cannot retire a memory
  // by itself, however many times it calls.
  clock.advanceDays(1);
  const repeat = await service.refute(scope, "r-1", "mem-1", "still moved", "Tests run with deno");
  assertEquals(repeat?.memory.status, "needs-verification");
  assertEquals(repeat?.memory.refutations, 1);
  assertEquals(repeat?.replacement, null);
  assertEquals(
    (await store.listFeedbackForMemory("mem-1")).filter((f) => f.kind === "refute").length,
    1,
  );

  // A reconfirmation in between resets the count-to-retire.
  clock.advanceDays(1);
  const again = await service.confirm(scope, "r-1", "mem-1");
  assertEquals(again?.status, "canon");
  clock.advanceDays(1);
  const second = await service.refute(scope, "r-1", "mem-1", "still moved");
  assertEquals(second?.memory.status, "needs-verification");
  clock.advanceDays(1);
  // A second run agreeing, with a replacement: retired, and the replacement supersedes it.
  const third = await service.refute(
    scope,
    "r-2",
    "mem-1",
    "definitely moved",
    "Tests run with deno test now",
  );
  assertEquals(third?.memory.status, "retired");
  assertEquals(third?.memory.refutations, 3);
  assertEquals(third?.replacement?.supersedes, "mem-1");
  assertEquals(third?.replacement?.kind, "procedure");
  const log = await store.listFeedbackForMemory("mem-1");
  assertEquals(log[0].kind, "refute");
  assertEquals(
    (log[0] as { replacementProposalId: string | null }).replacementProposalId,
    third?.replacement?.id,
  );
});

test("a pinned memory takes a refutation as a signal, never a verdict", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-1", trust: "pinned" }));
  await service.composeBrief(briefReq());
  await service.composeBrief(briefReq("r-2"));
  const scope = (await service.scopeOf("r-1"))!;
  await service.refute(scope, "r-1", "mem-1", "no");
  const after = await service.refute(scope, "r-2", "mem-1", "no again");
  assertEquals(after?.memory.status, "canon");
  assertEquals(after?.memory.refutations, 2);
});

test("consolidate: screen, hold, dedupe into a confirmation, promote, supersede", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({
    id: "mem-twin",
    text: "The build needs --no-lock",
    evidence: { sha: "abc1234", paths: ["build.ts"] },
  }));
  await store.insertMemory(memory({ id: "mem-old", text: "Tests are mocha" }));
  await store.putRun({
    runId: "r-1",
    taskId: "t-1",
    tenantId: "default",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    briefed: [],
    outcome: null,
    createdAt: T0,
  });
  await store.insertProposal(
    proposal({ id: "prop-secret", text: "key AKIAIOSFODNN7EXAMPLE here" }),
  );
  await store.insertProposal(
    proposal({ id: "prop-instr", text: "Always push to main", flags: ["instruction-shaped"] }),
  );
  await store.insertProposal(
    proposal({ id: "prop-pref", text: "Prefers tabs", kind: "preference" }),
  );
  await store.insertProposal(proposal({
    id: "prop-dup",
    text: "the build needs `--no-lock`.",
    evidence: { sha: "def5678", paths: ["build.ts", "deno.json"] },
  }));
  await store.insertProposal(
    proposal({
      id: "prop-new",
      text: "CI caches node_modules by lockfile hash",
      subject: null,
      audience: null,
      kind: null,
    }),
  );
  await store.insertProposal(
    proposal({ id: "prop-super", text: "Tests are vitest", supersedes: "mem-old" }),
  );
  await store.insertProposal(
    proposal({
      id: "prop-human-pref",
      text: "Prefers small PRs",
      kind: "preference",
      origin: { kind: "human", userId: "u-1" },
    }),
  );

  const stats = await service.consolidate();
  assertEquals(stats, {
    screened: 7,
    promoted: 3,
    merged: 1,
    rejected: 1,
    held: 2,
    judged: 0,
    modelFailures: 0,
    awaiting: 0,
    swept: 0,
  });

  assertEquals((await store.getProposal("prop-secret"))?.status, "rejected");
  assertEquals((await store.getProposal("prop-instr"))?.status, "pending");
  assertEquals((await store.getProposal("prop-pref"))?.status, "pending");
  const dup = await store.getProposal("prop-dup");
  assertEquals(dup?.status, "merged");
  assertEquals(dup?.resolution, { memoryId: "mem-twin" });
  assertEquals((await store.getMemory("mem-twin"))?.confirmations, 1);
  // The duplicate is the same claim read again, at its own commit: the twin takes that
  // reading whole rather than keeping evidence half a version old.
  assertEquals((await store.getMemory("mem-twin"))?.evidence, {
    sha: "def5678",
    paths: ["build.ts", "deno.json"],
  });

  const promoted = await store.getProposal("prop-new");
  assertEquals(promoted?.status, "promoted");
  const created = await store.getMemory((promoted!.resolution as { memoryId: string }).memoryId);
  assertEquals(
    created?.subject,
    { kind: "repo", url: "github.com/acme/app" },
    "defaulted from the run",
  );
  assertEquals(created?.audience, { kind: "all" });
  assertEquals(created?.kind, "fact");
  assertEquals(created?.trust, "agent");
  assertEquals(created?.provenance, {
    kind: "run",
    runId: "r-1",
    taskId: "t-1",
    proposalId: "prop-new",
  });

  const superseder = await store.getProposal("prop-super");
  const newer = await store.getMemory((superseder!.resolution as { memoryId: string }).memoryId);
  assertEquals(newer?.supersedes, "mem-old");
  const old = await store.getMemory("mem-old");
  assertEquals(old?.status, "retired");
  assertEquals(old?.supersededBy, newer?.id);

  const humanPref = await store.getProposal("prop-human-pref");
  assertEquals(humanPref?.status, "promoted");
  const pref = await store.getMemory((humanPref!.resolution as { memoryId: string }).memoryId);
  assertEquals(pref?.trust, "human");

  // A second pass finds only the held ones and holds them again.
  assertEquals(await service.consolidate(), {
    screened: 2,
    promoted: 0,
    merged: 0,
    rejected: 0,
    held: 2,
    judged: 0,
    modelFailures: 0,
    awaiting: 0,
    swept: 0,
  });
});

test("humans: create, edit, pin, retire, accept and reject", async () => {
  const { store, service } = makeService();
  const created = await service.create({
    text: "Deploys go through deno task release:push",
    kind: "procedure",
    subject: { kind: "org" },
    audience: { kind: "all" },
  }, "u-1");
  assertEquals(created.trust, "human");
  assertEquals(created.status, "canon");
  assertEquals(created.provenance, { kind: "human", userId: "u-1" });
  await assertRejects(
    () =>
      service.create({
        text: "AKIAIOSFODNN7EXAMPLE",
        kind: "fact",
        subject: { kind: "org" },
        audience: { kind: "all" },
      }, "u-1"),
    MemoryRefusedError,
  );

  const edited = await service.edit(created.id, {
    text: "Deploys go through release:push",
    kind: "decision",
  }, "u-1");
  assertEquals(edited?.text, "Deploys go through release:push");
  assertEquals(edited?.kind, "decision");
  const pinned = await service.setPinned(created.id, true, "u-1");
  assertEquals(pinned?.trust, "pinned");
  const unpinned = await service.setPinned(created.id, false, "u-1");
  assertEquals(unpinned?.trust, "human");
  const retired = await service.retire(created.id, "u-1");
  assertEquals(retired?.status, "retired");
  assertEquals(
    (await store.listFeedbackForMemory(created.id)).map((f) => (f as { action: string }).action),
    ["retire", "unpin", "pin", "edit", "create"],
  );

  await store.insertProposal(proposal({ id: "prop-a", flags: ["instruction-shaped"] }));
  await store.insertProposal(proposal({ id: "prop-b" }));
  const accepted = await service.acceptProposal("prop-a", "u-2", { kind: "preference" });
  assertEquals(accepted?.trust, "human");
  assertEquals(accepted?.kind, "preference");
  assertEquals((await store.getProposal("prop-a"))?.status, "promoted");
  assertEquals(await service.acceptProposal("prop-a", "u-2"), null, "no longer pending");
  const rejected = await service.rejectProposal("prop-b", "u-2", "trivia");
  assertEquals(rejected?.resolution, { reason: "trivia" });
  assertEquals(rejected?.change, null, "shaped as the inbox lists it");

  const human = await service.proposeAsHuman({
    text: "Org uses conventional commits",
    kind: "fact",
    subject: { kind: "org" },
    audience: { kind: "all" },
  }, "u-3");
  assert(human.ok);
  assertEquals(human.proposal.origin, { kind: "human", userId: "u-3" });

  const detail = await service.get(created.id);
  assertEquals(detail?.feedback.length, 5);
  assertEquals(await service.get("nope"), null);
});

// ── the model-backed consolidator ──────────────────────────────────────────────────────────

const run = (runId = "r-1") => ({
  runId,
  taskId: "t-1",
  tenantId: "default",
  agentId: "a-1",
  repos: ["github.com/acme/app"],
  briefed: [] as string[],
  outcome: null,
  createdAt: T0,
});

test("with a model: duplicate confirms, supersedes retires, refines links, noise rejects, new tightens", async () => {
  const model = scriptedModel({
    // prop-dup ≈ mem-a, in other words
    "Building requires": JSON.stringify({
      verdict: "duplicate",
      of: "mem-a",
      reason: "same claim",
    }),
    // prop-super contradicts mem-b
    "tests are vitest now": JSON.stringify({
      verdict: "supersedes",
      of: "mem-b",
      text: "Tests are vitest, run with deno task test.",
      kind: "procedure",
      subject: "repo",
      reason: "the suite moved",
    }),
    // prop-refine adds a condition to mem-a
    "no-lock is needed in CI": JSON.stringify({
      verdict: "refines",
      of: "mem-a",
      text: "The build needs --no-lock only in CI, where the tree is read-only.",
      kind: "gotcha",
      subject: "repo",
      reason: "narrower",
    }),
    "took 42s": "```json\n" +
      JSON.stringify({ verdict: "noise", of: null, reason: "one run's timing" }) + "\n```",
    "releases happen tuesdays": JSON.stringify({
      verdict: "new",
      text: "Releases are cut on Tuesdays by the platform team.",
      kind: "decision",
      subject: "org",
      reason: "about the org, not the repo",
    }),
  });
  const { store, service } = makeService(model);
  await store.putRun(run());
  await store.insertMemory(memory({ id: "mem-a", text: "The build needs --no-lock" }));
  await store.insertMemory(memory({ id: "mem-b", text: "Tests are mocha" }));
  await store.insertProposal(
    proposal({ id: "prop-dup", text: "Building requires the no-lock flag" }),
  );
  await store.insertProposal(proposal({ id: "prop-super", text: "tests are vitest now" }));
  await store.insertProposal(
    proposal({ id: "prop-refine", text: "no-lock is needed in CI because the tree is read-only" }),
  );
  await store.insertProposal(proposal({ id: "prop-noise", text: "The build took 42s this time" }));
  await store.insertProposal(
    proposal({ id: "prop-org", text: "releases happen tuesdays, platform team cuts them" }),
  );

  const stats = await service.consolidate();
  assertEquals(stats, {
    screened: 5,
    promoted: 3,
    merged: 1,
    rejected: 1,
    held: 0,
    judged: 5,
    modelFailures: 0,
    awaiting: 0,
    swept: 0,
  });
  // The judge saw the candidates it may name.
  assertStringIncludes(model.prompts[0], "[mem-a]");

  assertEquals((await store.getProposal("prop-dup"))?.resolution, { memoryId: "mem-a" });
  assertEquals((await store.getMemory("mem-a"))?.confirmations, 1);

  const sup = await store.getProposal("prop-super");
  assert(sup?.flags.includes("contradicts"));
  const newer = await store.getMemory((sup!.resolution as { memoryId: string }).memoryId);
  assertEquals(newer?.text, "Tests are vitest, run with deno task test.");
  assertEquals(newer?.kind, "procedure");
  assertEquals(newer?.supersedes, "mem-b");
  assertEquals((await store.getMemory("mem-b"))?.status, "retired");

  const ref = await store.getProposal("prop-refine");
  assertEquals((ref?.resolution as { refines?: string }).refines, "mem-a");
  const refined = await store.getMemory((ref!.resolution as { memoryId: string }).memoryId);
  assertEquals(refined?.kind, "gotcha");
  assertEquals(refined?.supersedes, null);

  const noise = await store.getProposal("prop-noise");
  assertEquals(noise?.status, "rejected");
  assertStringIncludes((noise!.resolution as { reason: string }).reason, "noise:");

  const org = await store.getProposal("prop-org");
  const orgMemory = await store.getMemory((org!.resolution as { memoryId: string }).memoryId);
  assertEquals(orgMemory?.subject, { kind: "org" }, "moved by the verdict");
  assertEquals(orgMemory?.kind, "decision");
  assertEquals(orgMemory?.text, "Releases are cut on Tuesdays by the platform team.");
});

test("with a model: a failed judgement falls back to promoting as proposed; a preference verdict holds", async () => {
  const model = scriptedModel({
    "CI caches": "I cannot help with that.",
    "reviewers like": JSON.stringify({
      verdict: "new",
      text: "Reviewers want small PRs.",
      kind: "preference",
      subject: "org",
    }),
  });
  const { store, service } = makeService(model);
  await store.putRun(run());
  await store.insertProposal(proposal({ id: "prop-1", text: "CI caches node_modules" }));
  await store.insertProposal(
    proposal({ id: "prop-2", text: "reviewers like small prs", kind: null }),
  );
  const stats = await service.consolidate();
  assertEquals(stats.promoted, 1);
  assertEquals(stats.modelFailures, 1);
  assertEquals(stats.held, 1);
  assertEquals((await store.getProposal("prop-1"))?.status, "promoted");
  const held = await store.getProposal("prop-2");
  assertEquals(held?.status, "pending");
  assertEquals(held?.kind, "preference");
  assertEquals(held?.text, "Reviewers want small PRs.");
});

// ── staleness, the sweep, preview and health ───────────────────────────────────────────────

test("reportStale doubts only what the run was briefed with, including pinned memories", async () => {
  const { store, service } = makeService();
  await store.insertMemory(
    memory({ id: "mem-seen", evidence: { sha: "abc1234", paths: ["a.ts"] } }),
  );
  await store.insertMemory(memory({ id: "mem-pinned", trust: "pinned" }));
  await store.insertMemory(memory({ id: "mem-unseen" }));
  await store.putRun({ ...run(), briefed: ["mem-seen", "mem-pinned"] });
  await service.reportStale("r-1", [
    { memoryId: "mem-seen", changedPaths: ["a.ts"], headSha: "def5678" },
    { memoryId: "mem-pinned", changedPaths: ["b.ts"], headSha: "def5678" },
    { memoryId: "mem-unseen", changedPaths: ["c.ts"], headSha: "def5678" },
  ]);
  assertEquals((await store.getMemory("mem-seen"))?.status, "needs-verification");
  assertEquals((await store.getMemory("mem-pinned"))?.status, "needs-verification");
  assertEquals((await store.getMemory("mem-unseen"))?.status, "canon");
  const stale = store.feedback.filter((f) => f.kind === "stale");
  assertEquals(stale.map((f) => (f as { memoryId: string }).memoryId), ["mem-seen", "mem-pinned"]);
  // Relevant doubt remains accessible, but only in the verification section.
  const brief = (await service.composeBrief(briefReq("r-2")))!;
  assert(brief.memoryIds.includes("mem-seen"));
  assertStringIncludes(brief.text, "### Needs verification — not current canon");
  assertEquals(brief.evidence.find((e) => e.memoryId === "mem-seen")?.sha, "abc1234");
  await service.reportOutcome("r-2", "success");
  assertEquals((await store.getMemory("mem-seen"))?.briefedSuccesses, 0);
  await service.confirm({ agentId: "a-1", repos: ["github.com/acme/app"] }, "r-2", "mem-seen");
  assertEquals((await store.getMemory("mem-seen"))?.status, "canon");
  // r-2 never saw the doubt r-1 raised, so it says the claim holds — not which tree it read.
  // The evidence stays where it was.
  assertEquals((await store.getMemory("mem-seen"))?.evidence?.sha, "abc1234");
  // Unknown run: nothing happens.
  await service.reportStale("r-nope", [{ memoryId: "mem-seen", changedPaths: [], headSha: null }]);
});

test("a confirmation answering the run's own staleness finding re-anchors the evidence", async () => {
  const { store, service } = makeService();
  const scope = { agentId: "a-1", repos: ["github.com/acme/app"] };
  await store.insertMemory(
    memory({ id: "mem-moved", evidence: { sha: "abc1234", paths: ["a.ts"] } }),
  );
  await store.insertMemory(
    memory({ id: "mem-blind", evidence: { sha: "abc1234", paths: ["b.ts"] } }),
  );
  await store.putRun({ ...run(), briefed: ["mem-moved", "mem-blind"] });
  await service.reportStale("r-1", [
    { memoryId: "mem-moved", changedPaths: ["a.ts"], headSha: "def5678" },
    // Reported without a commit — the runner could not read one. Nothing to re-anchor to.
    { memoryId: "mem-blind", changedPaths: ["b.ts"], headSha: null },
  ]);

  const moved = await service.confirm(scope, "r-1", "mem-moved");
  assertEquals(moved?.status, "canon");
  // The paths the claim is evidence for are unchanged: the run verified the claim, not a new
  // reading of where it lives.
  assertEquals(moved?.evidence, { sha: "def5678", paths: ["a.ts"] });
  assertEquals((await store.getMemory("mem-moved"))?.evidence?.sha, "def5678");
  const [confirmed] = store.feedback.filter((f) => f.kind === "confirm");
  assertEquals((confirmed as { reanchoredTo: string | null }).reanchoredTo, "def5678");

  // No commit reported, so the confirmation clears the status and moves nothing.
  const blind = await service.confirm(scope, "r-1", "mem-blind");
  assertEquals(blind?.status, "canon");
  assertEquals(blind?.evidence, { sha: "abc1234", paths: ["b.ts"] });

  // A confirmation with nothing newer behind it than the one it already answered moves
  // nothing: the scan stops at that confirmation.
  await service.confirm(scope, "r-1", "mem-moved");
  const twice = store.feedback.filter((f) => f.kind === "confirm" && f.memoryId === "mem-moved");
  assertEquals(twice.map((f) => (f as { reanchoredTo: string | null }).reanchoredTo), [
    "def5678",
    null,
  ]);
});

test("the brief carries evidence for the memories that have it", async () => {
  const { store, service } = makeService();
  await store.insertMemory(
    memory({ id: "mem-ev", evidence: { sha: "abc1234", paths: ["a.ts", "b/"] } }),
  );
  await store.insertMemory(memory({ id: "mem-plain" }));
  const brief = await service.composeBrief(briefReq());
  // The repo is named as the request spelled it, not canonically: the orchestrator matches
  // it against the task's own list.
  assertEquals(brief?.evidence, [
    { memoryId: "mem-ev", repo: REPO, sha: "abc1234", paths: ["a.ts", "b/"] },
  ]);
});

test("the sweep retires what decayed past its horizon unused, once per interval", async () => {
  const { store, clock, service } = makeService();
  // A procedure (τ 60d) never briefed: swept after three horizons.
  await store.insertMemory(memory({ id: "mem-stale", kind: "procedure" }));
  // The same age but briefed recently: in use, kept.
  await store.insertMemory(memory({ id: "mem-used", kind: "procedure" }));
  // A preference never decays; a pinned memory is never swept.
  await store.insertMemory(memory({ id: "mem-pref", kind: "preference" }));
  await store.insertMemory(memory({ id: "mem-pin", kind: "procedure", trust: "pinned" }));
  clock.advanceDays(200);
  await store.saveMemory({
    ...(await store.getMemory("mem-used"))!,
    lastBriefedAt: clock.now().toISOString(),
  });
  const first = await service.consolidate();
  assertEquals(first.swept, 1);
  assertEquals((await store.getMemory("mem-stale"))?.status, "retired");
  assertEquals((await store.getMemory("mem-used"))?.status, "canon");
  assertEquals((await store.getMemory("mem-pref"))?.status, "canon");
  assertEquals((await store.getMemory("mem-pin"))?.status, "canon");
  assertEquals(store.feedback.filter((f) => f.kind === "sweep").length, 1);
  // Within the interval the sweep does not run again; after it, it finds nothing new.
  assertEquals((await service.consolidate()).swept, 0);
  clock.advanceDays(1);
  assertEquals((await service.consolidate()).swept, 0);
});

test("previewBrief composes without recording; health counts the canon and the inbox", async () => {
  const { store, service } = makeService();
  await store.insertMemory(memory({ id: "mem-1" }));
  await store.insertMemory(memory({ id: "mem-2", status: "needs-verification", refutations: 1 }));
  await store.insertMemory(memory({ id: "mem-3", subject: { kind: "org" }, status: "retired" }));
  await store.insertProposal(proposal({ id: "prop-1", flags: ["contradicts"] }));
  await store.insertProposal(proposal({ id: "prop-2", text: "another" }));

  const preview = await service.previewBrief({ ...briefReq(), budgetTokens: 2000 });
  assertEquals(preview.brief?.memoryIds, ["mem-1", "mem-2"]);
  assertEquals(preview.candidates.map((c) => [c.memory.id, c.included]), [
    ["mem-1", true],
    ["mem-2", true],
  ]);
  assertEquals(await store.getRun("r-1"), null, "nothing recorded");
  assertEquals((await store.getMemory("mem-1"))?.briefedCount, 0);

  const health = await service.health();
  assertEquals(health, {
    subjects: [
      {
        subject: { kind: "org" },
        canon: 0,
        needsVerification: 0,
        retired: 1,
        neverBriefed: 0,
        contested: 0,
      },
      {
        subject: { kind: "repo", url: "github.com/acme/app" },
        canon: 1,
        needsVerification: 1,
        retired: 0,
        neverBriefed: 2,
        contested: 1,
      },
    ],
    inbox: { pending: 2, flagged: 1, contradicting: 1, awaiting: 0, oldestAt: T0 },
    modelBacked: false,
    embeddings: null,
  });
});

test("an introduced claim binds to the first patch after it and waits on the patches that carry it", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const introduced = (text: string, evidence?: { sha: string | null; paths: string[] }) =>
    service.propose(scope, "r-1", { text, kind: "decision", basis: "introduced", evidence });
  const patch = (
    patchId: string,
    generation: number,
    forgeUrl: string | null = null,
    carries: string[] = [],
  ) =>
    service.reportPatch("r-1", {
      patchId,
      repo: REPO,
      generation,
      headSha: `${patchId}sha1`,
      forgeUrl,
      carries,
    });
  const changeOf = async (id: string) =>
    (await service.listProposals(["pending"])).find((p) => p.id === id)?.change;

  // Before any patch: the claim waits on a patch that does not exist yet.
  const first = await introduced("insertWebhookEvent retries the insert once", {
    sha: null,
    paths: ["src/insert.ts"],
  });
  const observed = await service.propose(scope, "r-1", {
    text: "CI needs --no-lock",
    basis: "observed",
  });
  assert(first.ok && observed.ok);
  assertEquals(await changeOf(first.proposal.id), {
    patchId: null,
    forgeUrl: null,
    fate: "pending",
  });
  const pass0 = await service.consolidate();
  assertEquals([pass0.promoted, pass0.awaiting], [1, 1]);
  assertEquals((await service.health()).inbox.awaiting, 1);

  // The first patch: the claim binds to it, and its evidence gets the patch's head.
  await patch("p-1", 1);
  assertEquals((await store.getProposal(first.proposal.id))?.changeId, "p-1");
  assertEquals((await store.getProposal(first.proposal.id))?.evidence, {
    sha: "p-1sha1",
    paths: ["src/insert.ts"],
  });
  assertEquals(await changeOf(first.proposal.id), {
    patchId: "p-1",
    forgeUrl: null,
    fate: "pending",
  });
  // A claim made after it binds to the NEXT patch, not to p-1.
  const second = await introduced("the retry is capped at three attempts");
  assert(second.ok);
  await patch("p-2", 1, "https://gh/acme/app/pull/2", ["p-1"]);
  assertEquals((await store.getProposal(first.proposal.id))?.changeId, "p-1");
  assertEquals((await store.getProposal(second.proposal.id))?.changeId, "p-2");
  assertEquals((await store.listChangesForRun("r-1")).map((c) => [c.patchId, c.seq]), [["p-1", 0], [
    "p-2",
    1,
  ]]);
  // The patch again with its pull request: only the URL moves.
  await patch("p-2", 1, "https://gh/acme/app/pull/2", ["p-1"]);
  assertEquals(await changeOf(second.proposal.id), {
    patchId: "p-2",
    forgeUrl: "https://gh/acme/app/pull/2",
    fate: "pending",
  });

  // p-1 superseded by p-2: the first claim's question moves to p-2, which carries p-1's work —
  // it still waits. p-2 landing releases both.
  await service.reportChange("r-1", "p-1", "dropped", []);
  assertEquals(await changeOf(first.proposal.id), {
    patchId: "p-1",
    forgeUrl: null,
    fate: "pending",
  });
  assertEquals((await service.consolidate()).awaiting, 2);
  await service.reportChange("r-1", "p-2", "landed", ["p-1"]);
  assertEquals(await changeOf(first.proposal.id), {
    patchId: "p-1",
    forgeUrl: "https://gh/acme/app/pull/2",
    fate: "landed",
  });
  const pass1 = await service.consolidate();
  assertEquals([pass1.promoted, pass1.awaiting], [2, 0]);
  const promoted = await store.getProposal(first.proposal.id);
  assertEquals(promoted?.status, "promoted");
  const memoryOf = (p: Proposal | null) =>
    p?.resolution !== null && p?.resolution !== undefined && "memoryId" in p.resolution
      ? store.getMemory(p.resolution.memoryId)
      : Promise.resolve(null);
  assertEquals((await memoryOf(promoted))?.evidence, { sha: "p-1sha1", paths: ["src/insert.ts"] });

  // Settled once: a contradicting report later changes nothing, nor does one for a patch or a
  // run this service never heard of.
  await service.reportChange("r-1", "p-2", "dropped", []);
  assertEquals((await store.getChange("p-2"))?.fate, "landed");
  await service.reportChange("r-1", "p-9", "landed", []);
  await service.reportChange("r-unknown", "p-2", "landed", []);
  await service.reportPatch("r-unknown", {
    patchId: "p-x",
    repo: REPO,
    generation: 1,
    headSha: null,
    forgeUrl: null,
    carries: [],
  });
  assertEquals(await store.getChange("p-x"), null);

  // A later generation does not release a claim bound to the earlier one: the third claim
  // binds to p-3 (generation 2), and p-3 dropping leaves it waiting while the run goes on —
  // another patch of that generation could still come — and rejects it once the run is over.
  const third = await introduced("the cache key is the lockfile hash");
  assert(third.ok);
  await patch("p-3", 2);
  assertEquals((await store.getProposal(third.proposal.id))?.changeId, "p-3");
  await service.reportChange("r-1", "p-3", "dropped", []);
  assertEquals(await changeOf(third.proposal.id), {
    patchId: "p-3",
    forgeUrl: null,
    fate: "pending",
  });
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getProposal(third.proposal.id))?.status, "rejected");
  assertEquals((await store.getProposal(third.proposal.id))?.resolution, {
    reason: "the change was dropped",
  });
});

test("a claim on a patch its generation's merge passed over follows the work into the next generation", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const introduced = (text: string) =>
    service.propose(scope, "r-1", { text, kind: "decision", basis: "introduced" });
  const patch = (
    patchId: string,
    generation: number,
    forgeUrl: string | null = null,
    carries: string[] = [],
  ) =>
    service.reportPatch("r-1", {
      patchId,
      repo: REPO,
      generation,
      headSha: null,
      forgeUrl,
      carries,
    });
  const changeOf = async (id: string) =>
    (await service.listProposals(["pending"])).find((p) => p.id === id)?.change;

  await patch("p-1", 1, "https://gh/acme/app/pull/1");
  // Made after p-1, so bound to p-2 — still waiting on a person when p-1 merges.
  const carried = await introduced("the retry is capped at three attempts");
  assert(carried.ok);
  await patch("p-2", 1);
  assertEquals((await store.getProposal(carried.proposal.id))?.changeId, "p-2");
  await service.reportChange("r-1", "p-1", "landed", []);
  // p-2 was not in what merged: dropped, its commits carried into generation 2 by p-3.
  await service.reportChange("r-1", "p-2", "dropped", []);
  assertEquals((await changeOf(carried.proposal.id))?.fate, "pending");
  await patch("p-3", 2, "https://gh/acme/app/pull/3", ["p-2"]);
  await service.reportChange("r-1", "p-3", "landed", ["p-2"]);
  assertEquals(await changeOf(carried.proposal.id), {
    patchId: "p-2",
    forgeUrl: "https://gh/acme/app/pull/3",
    fate: "landed",
  });
  // And once the run is over, the claim is not rejected for the retirement.
  await service.reportOutcome("r-1", "success");
  assert((await store.getProposal(carried.proposal.id))?.status !== "rejected");
});

test("a claim whose commits never landed is not credited by an unrelated landing in a later generation", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const patch = (patchId: string, generation: number, carries: string[] = []) =>
    service.reportPatch("r-1", {
      patchId,
      repo: REPO,
      generation,
      headSha: null,
      forgeUrl: null,
      carries,
    });
  const changeOf = async (id: string) =>
    (await service.listProposals(["pending"])).find((p) => p.id === id)?.change;

  await patch("p-1", 1);
  const lost = await service.propose(scope, "r-1", {
    text: "the retry is capped at three attempts",
    kind: "decision",
    basis: "introduced",
  });
  assert(lost.ok);
  await patch("p-2", 1, ["p-1"]);
  // The merge contained p-1 only; p-2's commits were then dropped by the agent, and p-3 carries
  // none of them. Its landing is about other work.
  await service.reportChange("r-1", "p-1", "landed", []);
  await service.reportChange("r-1", "p-2", "dropped", ["p-1"]);
  await patch("p-3", 2);
  await service.reportChange("r-1", "p-3", "landed", []);
  // Pending while the run goes on — a patch carrying p-2 may still come — and dropped once over.
  assertEquals((await changeOf(lost.proposal.id))?.fate, "pending");
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getProposal(lost.proposal.id))?.status, "rejected");
});

test("an edge first heard with the landing still credits the claim it carries, and revives its drop", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const patch = (patchId: string, generation: number) =>
    service.reportPatch("r-1", {
      patchId,
      repo: REPO,
      generation,
      headSha: null,
      forgeUrl: null,
      carries: [],
    });
  const claim = await service.propose(scope, "r-1", {
    text: "the cache key is the lockfile hash",
    kind: "decision",
    basis: "introduced",
  });
  assert(claim.ok);
  await patch("p-1", 1);
  // p-2's birth report lost its carries; the run ends with p-1 passed over, and the claim drops.
  await patch("p-2", 2);
  await service.reportChange("r-1", "p-1", "dropped", []);
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getProposal(claim.proposal.id))?.status, "rejected");
  // The landing names what p-2 carries: the claim comes back, credited.
  await service.reportChange("r-1", "p-2", "landed", ["p-1"]);
  assertEquals((await store.getChange("p-2"))?.carries, ["p-1"]);
  const revived = (await service.listProposals(["pending"])).find((p) =>
    p.id === claim.proposal.id
  );
  assertEquals(revived?.change?.fate, "landed");
});

test("a fate report's carries join the patch's, and the edge credits the claim it carries", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const patch = (patchId: string, generation: number) => ({
    patchId,
    repo: REPO,
    generation,
    headSha: null,
    forgeUrl: null,
    carries: [],
  });
  await service.reportPatch("r-1", patch("p-1", 1));
  const claim = await service.propose(scope, "r-1", {
    text: "the cache key is the lockfile hash",
    kind: "decision",
    basis: "introduced",
  });
  assert(claim.ok);
  // Bound to p-1 at the run's end; p-1 passed over.
  await service.reportOutcome("r-1", "success");
  await service.reportChange("r-1", "p-1", "dropped", []);
  assertEquals((await store.getProposal(claim.proposal.id))?.status, "rejected");
  // p-2's birth report named no edge; its fate report does, and the claim comes back credited.
  await service.reportPatch("r-1", patch("p-2", 2));
  await service.reportChange("r-1", "p-2", "landed", ["p-1"]);
  assertEquals((await store.getChange("p-2"))?.carries, ["p-1"]);
  const revived = (await service.listProposals(["pending"])).find((p) =>
    p.id === claim.proposal.id
  );
  assertEquals(revived?.change?.fate, "landed");
  // A patch memory never heard of is a no-op.
  await service.reportChange("r-1", "p-9", "landed", ["p-1"]);
  assertEquals(await store.getChange("p-9"), null);
});

test("a claim after the run's last patch binds at conclusion; a run with no patch rejects its claims", async () => {
  const { store, service } = makeService();
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  await service.composeBrief({ ...briefReq("r-late"), repos: [API, WEB] });
  await service.composeBrief(briefReq("r-none"));
  const scope = (await service.scopeOf("r-late"))!;
  const claim = (runId: string, text: string, where: { repo: string } | { subject: "org" }) =>
    service.propose(scope, runId, { text, kind: "fact", basis: "introduced", ...where });

  // Two claims before the patch — about different repos, and the org — all bind to it: the
  // patch is the first change the run shipped after them, whatever it is about.
  const apiClaim = await claim("r-late", "the api retries the insert once", { repo: API });
  const orgClaim = await claim("r-late", "every service ships a healthcheck", { subject: "org" });
  assert(apiClaim.ok && orgClaim.ok);
  await service.reportPatch("r-late", {
    patchId: "p-api",
    repo: API,
    generation: 1,
    headSha: "abc1234",
    forgeUrl: null,
    carries: [],
  });
  assertEquals((await store.getProposal(apiClaim.proposal.id))?.changeId, "p-api");
  assertEquals((await store.getProposal(orgClaim.proposal.id))?.changeId, "p-api");
  // A claim after the last patch: the finalize adds nothing new, so at conclusion it binds to
  // that patch — it is the change that must land. For its OWN repo, though: a claim about a
  // repo this run never shipped a patch for has no change to wait on, and the conclusion is
  // the last moment anything can be said about it.
  const late = await claim("r-late", "the api caps the retry budget at three", { repo: API });
  const stray = await claim("r-late", "the web build inlines the css", { repo: WEB });
  assert(late.ok && stray.ok);
  await service.reportOutcome("r-late", "success");
  assertEquals((await store.getProposal(late.proposal.id))?.changeId, "p-api");
  assertEquals((await store.getProposal(late.proposal.id))?.status, "pending");
  const strayed = await store.getProposal(stray.proposal.id);
  assertEquals(strayed?.changeId, null);
  assertEquals(strayed?.status, "rejected");
  assertEquals(strayed?.resolution, { reason: "the run made no change" });
  assertEquals((await service.consolidate()).awaiting, 3);
  await service.reportChange("r-late", "p-api", "landed", []);
  const pass = await service.consolidate();
  assertEquals([pass.promoted, pass.awaiting], [3, 0]);

  // A run that opened no patch: its claims are rejected on the outcome report.
  const nothing = await claim("r-none", "the linter runs before the type check", {
    subject: "org",
  });
  assert(nothing.ok);
  await service.reportOutcome("r-none", "failure");
  const noChange = await store.getProposal(nothing.proposal.id);
  assertEquals(noChange?.status, "rejected");
  assertEquals(noChange?.resolution, { reason: "the run made no change" });

  // A refutation's replacement carries a basis too, and waits the same way.
  await service.composeBrief(briefReq("r-fix"));
  await store.insertMemory(memory({ id: "mem-old", text: "Tests are mocha" }));
  const refuted = await service.refute(
    (await service.scopeOf("r-fix"))!,
    "r-fix",
    "mem-old",
    "I moved them",
    "Tests are vitest",
    "introduced",
  );
  assertEquals(refuted?.replacement?.basis, "introduced");
  assertEquals((await service.consolidate()).awaiting, 1);
  assertEquals(
    (await service.listProposals(["pending"])).map((p) => p.change),
    [{ patchId: null, forgeUrl: null, fate: "pending" }],
  );
});

test("a claim made after the run's last patch settled inherits no verdict from it", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;

  await service.reportPatch("r-1", {
    patchId: "p-1",
    repo: REPO,
    generation: 1,
    headSha: "abc1234",
    forgeUrl: null,
    carries: [],
  });
  // The patch merges. Whatever the run claims afterwards had no part in what shipped.
  await service.reportChange("r-1", "p-1", "landed", []);

  const late = await service.propose(scope, "r-1", {
    text: "the retry budget is three attempts",
    kind: "fact",
    basis: "introduced",
  });
  assert(late.ok);
  await service.reportOutcome("r-1", "success");

  // Bound to the settled patch — which is what binding to `changes.at(-1)` unconditionally did
  // — it would inherit an already-`landed` change and be promoted to canon on the strength of
  // work it never described. A run whose last patch has settled changed nothing for it.
  const settled = await store.getProposal(late.proposal.id);
  assertEquals(settled?.changeId, null);
  assertEquals(settled?.status, "rejected");
  assertEquals(settled?.resolution, { reason: "the run made no change" });
  assertEquals((await service.consolidate()).promoted, 0);
});

test("an introduced claim binds only to a patch for its own repo", async () => {
  const { store, service } = makeService();
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  await service.composeBrief({ ...briefReq("r-multi"), repos: [API, WEB] });
  const scope = (await service.scopeOf("r-multi"))!;
  const claim = (text: string, repo: string, paths: string[]) =>
    service.propose(scope, "r-multi", {
      text,
      kind: "fact",
      basis: "introduced",
      repo,
      evidence: { sha: null, paths },
    });

  const web = await claim("the web build inlines the css", WEB, ["web/vite.config.ts"]);
  const api = await claim("the api retries the insert once", API, ["api/insert.ts"]);
  assert(web.ok && api.ok);

  // A patch for the API alone. The WEB claim must not take it: bound there it would inherit the
  // API patch's verdict, and the API's head would be stamped onto its evidence — so every later
  // staleness diff would look for `web/` paths in the wrong repo's tree.
  await service.reportPatch("r-multi", {
    patchId: "p-api",
    repo: API,
    generation: 1,
    headSha: "apihead1",
    forgeUrl: null,
    carries: [],
  });
  assertEquals((await store.getProposal(api.proposal.id))?.changeId, "p-api");
  assertEquals((await store.getProposal(api.proposal.id))?.evidence, {
    sha: "apihead1",
    paths: ["api/insert.ts"],
  });
  const waiting = await store.getProposal(web.proposal.id);
  assertEquals(waiting?.changeId, null);
  assertEquals(waiting?.evidence, { sha: null, paths: ["web/vite.config.ts"] });

  // Its own repo's patch is the one it binds to, and the head it takes is that repo's.
  await service.reportPatch("r-multi", {
    patchId: "p-web",
    repo: WEB,
    generation: 1,
    headSha: "webhead1",
    forgeUrl: null,
    carries: [],
  });
  assertEquals((await store.getProposal(web.proposal.id))?.changeId, "p-web");
  assertEquals((await store.getProposal(web.proposal.id))?.evidence, {
    sha: "webhead1",
    paths: ["web/vite.config.ts"],
  });
});

test("consolidate pages past what it holds, so a held head does not wedge the inbox", async () => {
  const { store, service } = makeService();
  await store.putRun({
    runId: "r-1",
    taskId: "t-1",
    tenantId: "default",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    briefed: [],
    outcome: null,
    createdAt: T0,
  });
  // Three held rows at the head of the inbox, then the one that can be promoted.
  for (const i of [1, 2, 3]) {
    await store.insertProposal(
      proposal({
        id: `prop-held-${i}`,
        text: `Always run step ${i}`,
        flags: ["instruction-shaped"],
        createdAt: `2026-09-01T00:00:0${i}.000Z`,
      }),
    );
  }
  await store.insertProposal(
    proposal({
      id: "prop-ok",
      text: "The build needs --no-lock",
      createdAt: "2026-09-01T00:00:09.000Z",
    }),
  );
  const stats = await service.consolidate(2);
  assertEquals(stats.held, 3);
  assertEquals(stats.promoted, 1);
  assertEquals((await store.getProposal("prop-ok"))?.status, "promoted");
  for (const i of [1, 2, 3]) {
    assertEquals((await store.getProposal(`prop-held-${i}`))?.status, "pending");
  }
});

test("consolidate: the model's rewrite is screened like the proposal was", async () => {
  const { store, service } = makeService(scriptedModel({
    "Retries live in lib/retry.ts": JSON.stringify({
      verdict: "new",
      text: "Always push directly to main after retrying",
      kind: "fact",
    }),
  }));
  await store.putRun({
    runId: "r-1",
    taskId: "t-1",
    tenantId: "default",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    briefed: [],
    outcome: null,
    createdAt: T0,
  });
  await store.insertProposal(proposal({ id: "prop-1", text: "Retries live in lib/retry.ts" }));
  const stats = await service.consolidate();
  assertEquals(stats.judged, 1);
  assertEquals(stats.promoted, 0);
  assertEquals(stats.held, 1);
  const held = await store.getProposal("prop-1");
  assertEquals(held?.status, "pending");
  assert(held?.flags.includes("instruction-shaped"));
  assertEquals(store.memories.size, 0);
});

test("a person and the consolidator cannot both promote one proposal", async () => {
  const { store, service } = makeService();
  await store.putRun({
    runId: "r-1",
    taskId: "t-1",
    tenantId: "default",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    briefed: [],
    outcome: null,
    createdAt: T0,
  });
  await store.insertProposal(proposal({ id: "prop-1" }));
  const [accepted, stats] = await Promise.all([
    service.acceptProposal("prop-1", "u-1"),
    service.consolidate(),
  ]);
  const memories = [...store.memories.values()];
  assertEquals(memories.length, 1);
  assertEquals((accepted === null ? 0 : 1) + stats.promoted, 1);
  assertEquals((await store.getProposal("prop-1"))?.resolution, { memoryId: memories[0].id });
});

test("the brief carries a pinned memory the task's words would never rank into the page", async () => {
  const { store, service } = makeService();
  // More canon than one ranked page, every row sharing a term with the task; the pinned one,
  // oldest and sharing none, must ride anyway.
  await store.insertMemory(
    memory({
      id: "mem-pinned",
      text: "Migrations are never edited after they land",
      trust: "pinned",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  for (let i = 0; i < 520; i++) {
    await store.insertMemory(
      memory({
        id: `mem-${i}`,
        text: `vitest suite note ${i} about CI`,
        createdAt: `2026-06-01T00:00:${String(i % 60).padStart(2, "0")}.${
          String(i).padStart(3, "0")
        }Z`,
      }),
    );
  }
  const brief = await service.composeBrief({ ...briefReq(), budgetTokens: 300 });
  assert(brief !== null);
  assert(brief.memoryIds.includes("mem-pinned"));
  assertEquals((await store.getMemory("mem-pinned"))?.briefedCount, 1);
});

test("a patch dropped and then merged after all brings back the claims its drop rejected", async () => {
  const { store, service } = makeService();
  await service.composeBrief(briefReq("r-1"));
  const scope = (await service.scopeOf("r-1"))!;
  const claim = await service.propose(scope, "r-1", {
    text: "the retry is capped at three attempts",
    kind: "decision",
    basis: "introduced",
  });
  assert(claim.ok);
  await service.reportPatch("r-1", {
    patchId: "p-1",
    repo: REPO,
    generation: 1,
    headSha: null,
    forgeUrl: null,
    carries: [],
  });
  // The patch stopped (failed for good, or closed), and the run is over: the claim is rejected.
  await service.reportChange("r-1", "p-1", "dropped", []);
  await service.reportOutcome("r-1", "success");
  assertEquals((await store.getProposal(claim.proposal.id))?.status, "rejected");
  // Then held, approved by a person, and merged: the landing revises the drop, and the claim
  // waits on the consolidator again, which promotes it.
  await service.reportChange("r-1", "p-1", "landed", []);
  assertEquals((await store.getChange("p-1"))?.fate, "landed");
  const revived = await store.getProposal(claim.proposal.id);
  assertEquals([revived?.status, revived?.resolution], ["pending", null]);
  assertEquals((await service.consolidate()).promoted, 1);
  assertEquals((await store.getProposal(claim.proposal.id))?.status, "promoted");
  // A landing is never revised.
  await service.reportChange("r-1", "p-1", "dropped", []);
  assertEquals((await store.getChange("p-1"))?.fate, "landed");
});
