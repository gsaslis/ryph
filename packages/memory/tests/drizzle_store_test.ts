// The store over real PostgreSQL (PGlite): the shape round-trips, the filters narrow, full-text
// search ranks and normalises, and the append-only log comes back in order.

import { assert, assertEquals } from "@std/assert";
import { drizzleMemoryStore } from "../src/adapters/store/drizzle.ts";
import { searchTerms } from "../src/adapters/store/drizzle.ts";
import { reusableDbSuite } from "./reusable_db.ts";
import { memory, proposal, T0 } from "./fixtures.ts";

const { test, makeTestDb } = reusableDbSuite("memory store");

test("a memory round-trips through the flattened subject and audience columns", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    const m = memory({
      audience: { kind: "agent", agentId: "a-1" },
      evidence: { sha: "abc", paths: ["x"] },
    });
    await store.insertMemory(m);
    assertEquals(await store.getMemory("mem-1"), m);
    const org = memory({ id: "mem-2", subject: { kind: "org" } });
    await store.insertMemory(org);
    assertEquals((await store.getMemory("mem-2"))?.subject, { kind: "org" });

    await store.saveMemory({ ...m, confirmations: 3, status: "needs-verification" });
    const saved = await store.getMemory("mem-1");
    assertEquals(saved?.confirmations, 3);
    assertEquals(saved?.status, "needs-verification");
  } finally {
    await handle.close();
  }
});

test("listMemories narrows by subject, audience, kind and status", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertMemory(memory({ id: "mem-1" }));
    await store.insertMemory(memory({ id: "mem-2", subject: { kind: "org" }, kind: "decision" }));
    await store.insertMemory(
      memory({ id: "mem-3", audience: { kind: "agent", agentId: "a-9" }, status: "retired" }),
    );
    const ids = async (q: Parameters<typeof store.listMemories>[0]) =>
      (await store.listMemories(q)).map((s) => s.memory.id).sort();

    assertEquals(await ids({ tenantId: "default" }), ["mem-1", "mem-2", "mem-3"]);
    assertEquals(await ids({ tenantId: "default", subjects: [{ kind: "org" }] }), ["mem-2"]);
    assertEquals(
      await ids({ tenantId: "default", audiences: [{ kind: "agent", agentId: "a-9" }] }),
      ["mem-3"],
    );
    assertEquals(await ids({ tenantId: "default", statuses: ["canon"] }), ["mem-1", "mem-2"]);
    assertEquals(await ids({ tenantId: "default", kinds: ["decision"] }), ["mem-2"]);
    assertEquals(await ids({ tenantId: "other" }), []);
  } finally {
    await handle.close();
  }
});

test("full-text search ranks by overlap and normalises the best match to 1", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertMemory(
      memory({ id: "mem-1", text: "App tests are vitest; deno task test runs them" }),
    );
    await store.insertMemory(
      memory({ id: "mem-2", text: "The deploy renders manifests with kustomize" }),
    );
    await store.insertMemory(
      memory({ id: "mem-3", text: "Vitest tests live beside the module they test" }),
    );

    const hits = await store.listMemories({
      tenantId: "default",
      query: "how do I run the vitest test suite",
      matchOnly: true,
    });
    assertEquals(hits.map((h) => h.memory.id).includes("mem-2"), false, "no shared term");
    assertEquals(hits[0].relevance, 1);
    assert(hits.every((h) => h.relevance > 0 && h.relevance <= 1));

    // Without matchOnly the brief gets every row, non-matches at relevance 0.
    const all = await store.listMemories({ tenantId: "default", query: "vitest" });
    assertEquals(all.length, 3);
    assertEquals(all.find((h) => h.memory.id === "mem-2")?.relevance, 0);

    // A query with no usable term matches nothing when a match is required.
    assertEquals(
      await store.listMemories({ tenantId: "default", query: "?!", matchOnly: true }),
      [],
    );
    assertEquals(searchTerms("Hello, World! a"), "hello | world");
  } finally {
    await handle.close();
  }
});

test("findByNormalizedText finds the live twin on the same subject only", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertMemory(memory({ id: "mem-1", text: "The build needs `--no-lock`." }));
    await store.insertMemory(
      memory({ id: "mem-2", text: "The build needs --no-lock", subject: { kind: "org" } }),
    );
    const found = await store.findByNormalizedText(
      "default",
      { kind: "repo", url: "github.com/acme/app" },
      "the build needs no lock",
    );
    assertEquals(found?.id, "mem-1");
    const audience = { kind: "agent" as const, agentId: "a-private" };
    assertEquals(
      await store.findByNormalizedText(
        "default",
        found!.subject,
        "the build needs no lock",
        audience,
      ),
      null,
    );
    await store.insertMemory(memory({
      id: "mem-private",
      text: "The build needs --no-lock",
      audience,
    }));
    assertEquals(
      (await store.findByNormalizedText(
        "default",
        found!.subject,
        "the build needs no lock",
        audience,
      ))
        ?.id,
      "mem-private",
    );
    await store.saveMemory({ ...found!, status: "retired" });
    assertEquals(
      await store.findByNormalizedText(
        "default",
        { kind: "repo", url: "github.com/acme/app" },
        "the build needs no lock",
      ),
      null,
    );
  } finally {
    await handle.close();
  }
});

test("proposals, feedback and runs round-trip; the log keeps arrival order", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    const p = proposal({ subject: null, audience: null });
    await store.insertProposal(p);
    assertEquals(await store.getProposal("prop-1"), p);
    await store.saveProposal({ ...p, status: "rejected", resolution: { reason: "noise" } });
    assertEquals((await store.getProposal("prop-1"))?.status, "rejected");
    assertEquals(
      (await store.listProposals({ tenantId: "default", statuses: ["pending"] })).length,
      0,
    );

    await store.appendFeedback("default", {
      kind: "briefed",
      memoryId: "mem-1",
      runId: "r-1",
      at: T0,
    });
    await store.appendFeedback("default", {
      kind: "refute",
      memoryId: "mem-1",
      runId: "r-1",
      reason: "moved",
      replacementProposalId: null,
      at: T0,
    });
    await store.appendFeedback("default", {
      kind: "outcome",
      runId: "r-1",
      status: "success",
      at: T0,
    });
    const forRun = await store.listFeedbackForRun("r-1");
    assertEquals(forRun.map((f) => f.kind), ["briefed", "refute", "outcome"]);
    const forMemory = await store.listFeedbackForMemory("mem-1");
    assertEquals(forMemory.map((f) => f.kind), ["refute", "briefed"]);
    assertEquals(forMemory[0], {
      kind: "refute",
      memoryId: "mem-1",
      runId: "r-1",
      reason: "moved",
      replacementProposalId: null,
      at: T0,
    });

    const run = {
      runId: "r-1",
      taskId: "t-1",
      tenantId: "default",
      agentId: "a-1",
      repos: ["github.com/acme/app"],
      briefed: ["mem-1", "mem-2"],
      outcome: null,
      createdAt: T0,
    };
    await store.putRun(run);
    assertEquals(await store.getRun("r-1"), { ...run, agentOnly: false });
    await store.putRun({ ...run, agentOnly: true });
    assertEquals((await store.getRun("r-1"))?.agentOnly, true);
    await store.putRun({ ...run, outcome: "success" });
    assertEquals((await store.getRun("r-1"))?.outcome, "success");
    assertEquals((await store.listRunsForMemory("mem-2")).map((r) => r.runId), ["r-1"]);
    assertEquals(await store.listRunsForMemory("mem-9"), []);
  } finally {
    await handle.close();
  }
});

test("patchMemory moves counters in place, so two bumps from stale copies both land", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertMemory(memory({ id: "mem-1" }));
    const stale = (await store.getMemory("mem-1"))!;
    await Promise.all([
      store.patchMemory(stale.id, { lastConfirmedAt: T0 }, { confirmations: 1 }),
      store.patchMemory(stale.id, { status: "needs-verification" }, { confirmations: 1 }),
    ]);
    const after = await store.getMemory("mem-1");
    assertEquals(after?.confirmations, 2);
    assertEquals(after?.status, "needs-verification");
    assertEquals(after?.lastConfirmedAt, T0);
    const edited = await store.patchMemory("mem-1", {
      text: "Renamed claim",
      subject: { kind: "org" },
    });
    assertEquals(edited?.text, "Renamed claim");
    assertEquals(edited?.subject, { kind: "org" });
    assertEquals(await store.patchMemory("mem-nope", {}), null);
  } finally {
    await handle.close();
  }
});

test("a proposal resolves once: the transition and the promotion are compare-and-swaps", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertProposal(proposal({ id: "prop-1" }));
    await store.insertMemory(memory({ id: "mem-old" }));
    const promoted = await store.promote({
      proposal: {
        ...proposal({ id: "prop-1" }),
        status: "promoted",
        resolution: { memoryId: "mem-new" },
      },
      memory: memory({ id: "mem-new", supersedes: "mem-old" }),
      supersedes: "mem-old",
    });
    assertEquals(promoted, true);
    assertEquals((await store.getMemory("mem-old"))?.supersededBy, "mem-new");
    assertEquals((await store.getMemory("mem-old"))?.status, "retired");
    // Resolved already: neither a second promotion nor a rejection lands, and nothing is written.
    const again = await store.promote({
      proposal: {
        ...proposal({ id: "prop-1" }),
        status: "promoted",
        resolution: { memoryId: "mem-x" },
      },
      memory: memory({ id: "mem-x" }),
      supersedes: null,
    });
    assertEquals(again, false);
    assertEquals(await store.getMemory("mem-x"), null);
    assertEquals(
      await store.transitionProposal("prop-1", "pending", {
        ...proposal({ id: "prop-1" }),
        status: "rejected",
        resolution: { reason: "late" },
      }),
      false,
    );
    assertEquals((await store.getProposal("prop-1"))?.status, "promoted");
  } finally {
    await handle.close();
  }
});

test("a run's outcome settles once; its patches are rows that settle once each", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.putRun({
      runId: "r-1",
      taskId: "t-1",
      tenantId: "default",
      agentId: "a-1",
      repos: ["github.com/acme/api", "github.com/acme/web"],
      briefed: [],
      outcome: null,
      createdAt: T0,
    });
    assertEquals((await store.claimRunOutcome("r-1", "success"))?.outcome, "success");
    assertEquals(await store.claimRunOutcome("r-1", "failure"), null);
    assertEquals(await store.claimRunOutcome("r-nope", "success"), null);
    assertEquals((await store.getRuns(["r-1", "r-nope"])).map((r) => r.runId), ["r-1"]);

    const change = (patchId: string, repo: string, seq: number, carries: string[] = []) => ({
      patchId,
      runId: "r-1",
      tenantId: "default",
      repo,
      generation: 1,
      seq,
      headSha: null,
      forgeUrl: null,
      carries,
      fate: "pending" as const,
      createdAt: T0,
      updatedAt: T0,
    });
    // The seq is the STORE's to assign, in the order the patches are reported — handed in from
    // a list read moments earlier, two concurrent reports computed the same number and shared it.
    assertEquals(
      await store.insertChange(change("p-web", "github.com/acme/web", 0)),
      change("p-web", "github.com/acme/web", 0),
    );
    await store.insertChange(change("p-api", "github.com/acme/api", 1));
    assertEquals(await store.getChange("p-api"), change("p-api", "github.com/acme/api", 1));
    assertEquals(await store.getChange("p-nope"), null);
    // Idempotent by patch id: the same patch reported again is recorded once and keeps its
    // place in the run, which is what the route's documented idempotency actually promises.
    assertEquals(
      await store.insertChange(change("p-api", "github.com/acme/api", 1)),
      change("p-api", "github.com/acme/api", 1),
    );
    // In birth order, which is now the order they were written in.
    assertEquals((await store.listChangesForRun("r-1")).map((c) => c.patchId), ["p-web", "p-api"]);
    assertEquals(await store.listChangesForRun("r-nope"), []);
    await store.saveChange({
      ...change("p-api", "github.com/acme/api", 1),
      headSha: "abc1234",
      forgeUrl: "https://gh/acme/api/pull/7",
    });
    assertEquals((await store.getChange("p-api"))?.forgeUrl, "https://gh/acme/api/pull/7");
    // What a patch carries is a union, and only `addCarries` writes it: a whole-row save of a copy
    // read before an edge arrived does not take the edge back.
    await store.addCarries("p-api", ["p-web"]);
    await store.addCarries("p-api", ["p-web", "p-old"]);
    await store.addCarries("p-nope", ["p-web"]);
    await store.saveChange(change("p-api", "github.com/acme/api", 1));
    assertEquals((await store.getChange("p-api"))?.carries, ["p-old", "p-web"]);
    assertEquals(await store.getChange("p-nope"), null);
    await store.insertChange(change("p-born", "github.com/acme/api", 2, ["p-api"]));
    assertEquals((await store.getChange("p-born"))?.carries, ["p-api"]);
    // Settled once: the second report of a patch is refused, and so is an unknown patch.
    assertEquals(
      (await store.settleChange("p-api", "landed", "2026-09-02T00:00:00.000Z"))?.fate,
      "landed",
    );
    assertEquals((await store.getChange("p-api"))?.updatedAt, "2026-09-02T00:00:00.000Z");
    assertEquals(await store.settleChange("p-api", "dropped", T0), null);
    assertEquals(await store.settleChange("p-nope", "landed", T0), null);
    assertEquals((await store.getChange("p-web"))?.fate, "pending");
    // The one revision: a dropped patch that merged after all. Dropped again, or a second
    // landing, writes nothing.
    assertEquals((await store.settleChange("p-web", "dropped", T0))?.fate, "dropped");
    assertEquals(await store.settleChange("p-web", "dropped", T0), null);
    assertEquals((await store.settleChange("p-web", "landed", T0))?.fate, "landed");
    assertEquals(await store.settleChange("p-web", "landed", T0), null);
  } finally {
    await handle.close();
  }
});

test("bindProposals takes the run's unbound introduced claims for this repo, once", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    // The subject every `proposal()` fixture carries.
    const REPO = "github.com/acme/app";
    const run = (runId: string) => ({ kind: "run" as const, runId, taskId: "t-1" });
    await store.insertProposal(proposal({ id: "prop-a", basis: "introduced", origin: run("r-1") }));
    await store.insertProposal(proposal({ id: "prop-b", basis: "introduced", origin: run("r-1") }));
    // Not this run's, not introduced, already bound, already resolved: none of these bind.
    await store.insertProposal(proposal({ id: "prop-c", basis: "introduced", origin: run("r-2") }));
    await store.insertProposal(proposal({ id: "prop-d", basis: "observed", origin: run("r-1") }));
    await store.insertProposal(
      proposal({ id: "prop-e", basis: "introduced", origin: run("r-1"), changeId: "p-0" }),
    );
    await store.insertProposal(
      proposal({ id: "prop-f", basis: "introduced", origin: run("r-1"), status: "rejected" }),
    );
    // About another repo, and about the org: the first waits for its own patch, the second
    // names no repo and binds to whatever the run ships.
    await store.insertProposal(proposal({
      id: "prop-g",
      basis: "introduced",
      origin: run("r-1"),
      subject: { kind: "repo", url: "github.com/acme/other" },
    }));
    await store.insertProposal(proposal({
      id: "prop-h",
      basis: "introduced",
      origin: run("r-1"),
      subject: { kind: "org" },
    }));

    const bound = await store.bindProposals("r-1", "p-1", REPO, false);
    assertEquals(bound.map((p) => [p.id, p.changeId]), [["prop-a", "p-1"], ["prop-b", "p-1"], [
      "prop-h",
      "p-1",
    ]]);
    assertEquals(await store.bindProposals("r-1", "p-2", REPO, false), []);
    assertEquals((await store.getProposal("prop-a"))?.changeId, "p-1");
    assertEquals((await store.getProposal("prop-c"))?.changeId, null);
    assertEquals((await store.getProposal("prop-e"))?.changeId, "p-0");
    // The other repo's claim is still unbound, and binds to that repo's own patch.
    assertEquals((await store.getProposal("prop-g"))?.changeId, null);
    assertEquals(
      (await store.bindProposals("r-1", "p-3", "github.com/acme/other", false))
        .map((p) => p.id),
      ["prop-g"],
    );
  } finally {
    await handle.close();
  }
});

test("listProposals narrows to a run's introduced claims", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertProposal(proposal({ id: "prop-1", basis: "introduced" }));
    await store.insertProposal(proposal({ id: "prop-2", basis: "observed" }));
    await store.insertProposal(
      proposal({
        id: "prop-3",
        basis: "introduced",
        origin: { kind: "run", runId: "r-9", taskId: "t" },
      }),
    );
    const found = await store.listProposals({
      tenantId: "default",
      runId: "r-1",
      basis: "introduced",
    });
    assertEquals(found.map((p) => p.id), ["prop-1"]);
  } finally {
    await handle.close();
  }
});

test("listProposals narrows to what one person proposed by hand", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertProposal(proposal({ id: "prop-1" }));
    await store.insertProposal(
      proposal({ id: "prop-2", origin: { kind: "human", userId: "u-1", via: "token" } }),
    );
    await store.insertProposal(
      proposal({ id: "prop-3", origin: { kind: "human", userId: "u-2" } }),
    );
    const found = await store.listProposals({ tenantId: "default", proposedBy: "u-1" });
    assertEquals(found.map((p) => p.id), ["prop-2"]);
    assertEquals(found[0].origin, { kind: "human", userId: "u-1", via: "token" });
  } finally {
    await handle.close();
  }
});

test("listProposals narrows to what one person proposed with an API token", async () => {
  const handle = await makeTestDb();
  const store = drizzleMemoryStore(handle);
  try {
    await store.insertProposal(
      proposal({ id: "prop-1", origin: { kind: "human", userId: "u-1" } }),
    );
    await store.insertProposal(
      proposal({ id: "prop-2", origin: { kind: "human", userId: "u-1", via: "token" } }),
    );
    await store.insertProposal(
      proposal({ id: "prop-3", origin: { kind: "human", userId: "u-2", via: "token" } }),
    );
    const found = await store.listProposals({
      tenantId: "default",
      proposedBy: "u-1",
      proposedVia: "token",
    });
    assertEquals(found.map((p) => p.id), ["prop-2"]);
    const anyone = await store.listProposals({ tenantId: "default", proposedVia: "token" });
    assertEquals(anyone.map((p) => p.id), ["prop-2", "prop-3"]);
  } finally {
    await handle.close();
  }
});
