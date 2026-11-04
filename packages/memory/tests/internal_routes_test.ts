// The orchestrator's surface: service-authed, the brief as JSON (or null), the outcome as a 204.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { call, makeApi, SERVICE } from "./api.ts";
import { memory, proposal } from "./fixtures.ts";

const BRIEF_BODY = {
  taskId: "t-1",
  agentId: "a-1",
  repos: ["https://github.com/acme/app"],
  task: { title: "Fix tests", instructions: "vitest is red" },
  budgetTokens: 500,
};

test("brief and outcome take the service token and nothing else", async () => {
  const { handle } = makeApi();
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/brief", BRIEF_BODY, "user-secret")).status,
    401,
  );
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/brief", BRIEF_BODY, null)).status,
    401,
  );
  assertEquals(
    (await call(
      handle,
      "POST",
      "/internal/v1/runs/r-1/outcome",
      { status: "success" },
      "admin-secret",
    )).status,
    401,
  );
});

test("a brief is composed, frozen as text with ids, or null; an outcome is a 204", async () => {
  const { handle, store } = makeApi();
  const empty = await call(handle, "POST", "/internal/v1/runs/r-0/brief", BRIEF_BODY, SERVICE);
  assertEquals(empty.status, 200);
  assertEquals(await empty.json(), { brief: null });

  await store.insertMemory(memory({ id: "mem-1", text: "vitest runs the app tests" }));
  const res = await call(handle, "POST", "/internal/v1/runs/r-1/brief", BRIEF_BODY, SERVICE);
  assertEquals(res.status, 200);
  const { brief } = await res.json();
  assertEquals(brief.memoryIds, ["mem-1"]);
  assertEquals(typeof brief.text, "string");
  assertEquals((await store.getRun("r-1"))?.agentId, "a-1");

  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/brief", { agentId: "" }, SERVICE)).status,
    400,
  );

  const outcome = await call(
    handle,
    "POST",
    "/internal/v1/runs/r-1/outcome",
    { status: "success" },
    SERVICE,
  );
  assertEquals(outcome.status, 204);
  assertEquals((await store.getMemory("mem-1"))?.briefedSuccesses, 1);
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/outcome", { status: "won" }, SERVICE))
      .status,
    400,
  );
  // A run never briefed: still a 204.
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-9/outcome", { status: "lost" }, SERVICE))
      .status,
    204,
  );
});

test("a staleness report doubts the run's briefed memories and answers 204, even for an unknown run", async () => {
  const { handle, store } = makeApi();
  await store.insertMemory(memory({ id: "mem-1", evidence: { sha: "abc1234", paths: ["a.ts"] } }));
  const briefed = await call(handle, "POST", "/internal/v1/runs/r-1/brief", BRIEF_BODY, SERVICE);
  assertEquals((await briefed.json()).brief.evidence, [
    { memoryId: "mem-1", repo: "https://github.com/acme/app", sha: "abc1234", paths: ["a.ts"] },
  ]);
  const denied = await call(
    handle,
    "POST",
    "/internal/v1/runs/r-1/stale",
    { stale: [] },
    "user-secret",
  );
  assertEquals(denied.status, 401);
  const res = await call(handle, "POST", "/internal/v1/runs/r-1/stale", {
    stale: [{ memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "def5678" }],
  }, SERVICE);
  assertEquals(res.status, 204);
  assertEquals((await store.getMemory("mem-1"))?.status, "needs-verification");
  // The commit the runner diffed to rides into the log: a confirmation from this run reads it
  // back and moves the claim's evidence there.
  assertEquals(
    store.feedback.filter((f) => f.kind === "stale").map((f) =>
      (f as { headSha: unknown }).headSha
    ),
    ["def5678"],
  );
  const unknown = await call(handle, "POST", "/internal/v1/runs/r-nope/stale", {
    stale: [{ memoryId: "mem-1", changedPaths: [] }],
  }, SERVICE);
  assertEquals(unknown.status, 204);
  const bad = await call(handle, "POST", "/internal/v1/runs/r-1/stale", { stale: "x" }, SERVICE);
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});

test("a patch report binds the run's introduced claims; a change report settles them; both answer 204", async () => {
  const { handle, store } = makeApi();
  await call(handle, "POST", "/internal/v1/runs/r-1/brief", BRIEF_BODY, SERVICE);
  const scope = (await store.getRun("r-1"))!;
  await store.insertProposal(proposal({
    id: "prop-intro",
    basis: "introduced",
    origin: { kind: "run", runId: scope.runId, taskId: scope.taskId },
  }));
  const PATCH = {
    patchId: "p-1",
    repo: "https://github.com/acme/app",
    generation: 1,
    headSha: "abc1234",
    forgeUrl: null,
    carries: [],
  };
  const change = (body: unknown, token: string | null = SERVICE) =>
    call(handle, "POST", "/internal/v1/runs/r-1/change", body, token);

  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/patches", PATCH, "user-secret")).status,
    401,
  );
  const malformed = await call(handle, "POST", "/internal/v1/runs/r-1/patches", {
    ...PATCH,
    generation: 0,
  }, SERVICE);
  assertEquals(malformed.status, 400);
  await malformed.body?.cancel();
  // What a patch carries is required, on both reports.
  const { carries: _, ...uncarried } = PATCH;
  const noCarries = await call(handle, "POST", "/internal/v1/runs/r-1/patches", uncarried, SERVICE);
  assertEquals(noCarries.status, 400);
  await noCarries.body?.cancel();
  const opened = await call(handle, "POST", "/internal/v1/runs/r-1/patches", PATCH, SERVICE);
  assertEquals(opened.status, 204);
  assertEquals((await store.getProposal("prop-intro"))?.changeId, "p-1");
  assertEquals((await store.getChange("p-1"))?.repo, "github.com/acme/app");
  // The patch again, now a pull request: the URL lands, nothing else moves.
  const submitted = await call(handle, "POST", "/internal/v1/runs/r-1/patches", {
    ...PATCH,
    forgeUrl: "https://gh/acme/app/pull/4",
  }, SERVICE);
  assertEquals(submitted.status, 204);
  assertEquals((await store.getChange("p-1"))?.forgeUrl, "https://gh/acme/app/pull/4");
  assertEquals((await store.getChange("p-1"))?.seq, 0);

  assertEquals(
    (await change({ patchId: "p-1", fate: "landed", carries: [] }, "user-secret")).status,
    401,
  );
  const bad = await change({ patchId: "p-1", fate: "merged", carries: [] });
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const unnamed = await change({ fate: "landed", carries: [] });
  assertEquals(unnamed.status, 400, "a fate names its patch");
  await unnamed.body?.cancel();
  // Dropped while the run goes on: the claim still waits — another patch may come. Once the
  // run has concluded, it is rejected.
  assertEquals((await change({ patchId: "p-1", fate: "dropped", carries: [] })).status, 204);
  assertEquals((await store.getProposal("prop-intro"))?.status, "pending");
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-1/outcome", { status: "success" }, SERVICE))
      .status,
    204,
  );
  assertEquals((await store.getProposal("prop-intro"))?.status, "rejected");
  assertEquals((await store.getChange("p-1"))?.fate, "dropped");
  // A patch or a fate for a run this service never briefed is still a 204.
  assertEquals(
    (await call(handle, "POST", "/internal/v1/runs/r-9/patches", PATCH, SERVICE)).status,
    204,
  );
  assertEquals(await store.getChange("p-1-unknown"), null);
  const unknown = await call(
    handle,
    "POST",
    "/internal/v1/runs/r-9/change",
    { patchId: "p-9", fate: "landed", carries: [] },
    SERVICE,
  );
  assertEquals(unknown.status, 204);
  const uncarriedFate = await change({ patchId: "p-1", fate: "landed" });
  assertEquals(uncarriedFate.status, 400);
  await uncarriedFate.body?.cancel();
});
