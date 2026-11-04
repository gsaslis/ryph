// Fakes carry their own tests: a fake with wrong behavior poisons every test
// built on top of it.

import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { cliGitTransport } from "../src/adapters/git/cli.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { specMemoryStore } from "../src/adapters/memory/spec.ts";
import { git } from "../src/helpers/git_exec.ts";
import { repoEntry } from "./util.ts";

test("fakeOrchestratorGateway: confirms delivery and collects", async () => {
  const orchestrator = fakeOrchestratorGateway();
  orchestrator.reportProgress({ workItemId: "wi-1", phase: "running" });
  await orchestrator.reportResult({
    status: "failure",
    reason: "x",
    summary: "s",
    branches: [],
  });
  assertEquals(orchestrator.progressReports.length, 1);
  assertEquals(orchestrator.results.length, 1);
});

test("specMemoryStore: hands the spec's brief through, and null when there is none", async () => {
  const brief = { text: "## What previous runs learned\n- x", memoryIds: ["x"], evidence: [] };
  assertEquals(await specMemoryStore(brief).loadSnapshot(), brief);
  assertEquals(await specMemoryStore(undefined).loadSnapshot(), null);
  assertEquals(await specMemoryStore(null).loadSnapshot(), null);
});

test("makeThrowawayOrigin: seeded and clonable through the real adapter", async () => {
  const origin = await makeThrowawayOrigin();
  try {
    const workDir = await mkdtemp(join(tmpdir(), "runner-clone-test-"));
    const ws = await cliGitTransport(noopDiagnostics()).clone(
      repoEntry({ url: origin.url, ref: origin.ref }),
      workDir,
    );
    const readme = await readFile(`${ws.dir}/README.md`, "utf8");
    assert(readme.includes("seeded repo"));
    const branch = await git(ws.dir, "rev-parse", "--abbrev-ref", "HEAD");
    assertEquals(branch, "main");
    // A plain origin serves what it holds; nothing caches between it and the clone.
    assertEquals(ws.freshness, { kind: "fresh" });
    await rm(workDir, { recursive: true });
  } finally {
    await origin.cleanup();
  }
});
