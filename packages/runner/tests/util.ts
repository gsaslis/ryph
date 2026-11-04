// Shared test fixture: a complete run environment on the fake column — seeded origin,
// empty checkout dir, collecting narrator, the brief from the spec.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCtx } from "../src/core/run.ts";
import type { MemoryBrief, RepoEntry, WorkItem } from "../src/core/types.ts";
import type { OrchestratorGateway } from "../src/ports/orchestrator_gateway.ts";
import type { RunActions } from "../src/ports/run_actions.ts";
import { cliGitTransport } from "../src/adapters/git/cli.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { echoHarness } from "../src/adapters/harness/echo.ts";
import { type CollectingNarrator, collectingNarrator } from "./doubles/narrator.ts";
import { specMemoryStore } from "../src/adapters/memory/spec.ts";
import { noopInbox } from "../src/adapters/orchestrator/noop.ts";

export interface RunFixture {
  item: WorkItem;
  ctx: RunCtx;
  narrator: CollectingNarrator;
  originUrl: string;
  /** The checkout root the run clones under. */
  checkoutRoot: string;
  /** The one repo's clone: `<checkoutRoot>/<path>`, where the echo harness writes. */
  checkoutDir: string;
  /** The run's default line's branch in the fixture's one repo: `<namespace>/work`. */
  branchName: string;
  cleanup(): Promise<void>;
}

/** A repo entry with every field the schema needs, for tests that only care about a few. */
export function repoEntry(overrides: Partial<RepoEntry> & Pick<RepoEntry, "url">): RepoEntry {
  return {
    connectedRepoId: "cr-1",
    name: "test/repo",
    ref: "main",
    path: "repo",
    branchNamespace: "runner/ada/wi-test-0001",
    description: null,
    ...overrides,
  };
}

export async function makeRunFixture(
  orchestrator: OrchestratorGateway,
  opts: {
    /** The brief the spec carries, as the orchestrator rendered it. A bare string is a brief
     * with no evidence. */
    brief?: string | MemoryBrief;
    /** Extra files seeded into the origin repo, path → content. */
    repoFiles?: Record<string, string>;
    /**
     * Further repos in the checkout, each its own throwaway origin under the given path — the
     * multi-repo shape. The fixture's `checkoutDir` and `branchName` still name the first.
     */
    moreRepos?: Array<{ path: string; files?: Record<string, string>; description?: string }>;
  } = {},
): Promise<RunFixture> {
  const origin = await makeThrowawayOrigin({ files: opts.repoFiles });
  const more = await Promise.all(
    (opts.moreRepos ?? []).map(async (r) => ({
      ...r,
      origin: await makeThrowawayOrigin({ files: r.files }),
    })),
  );
  const checkoutRoot = await mkdtemp(join(tmpdir(), "runner-checkout-"));

  const narrator = collectingNarrator();
  const brief: MemoryBrief | undefined = typeof opts.brief === "string"
    ? { text: opts.brief, memoryIds: [], evidence: [] }
    : opts.brief;

  const item: WorkItem = {
    id: "wi-test-0001",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: {
      title: "test: echo the task",
      instructions: "Write the task into AGENT_NOTES.md.",
    },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref }),
      ...more.map((r) =>
        repoEntry({
          url: r.origin.url,
          ref: r.origin.ref,
          path: r.path,
          name: `test/${r.path}`,
          description: r.description ?? null,
        })
      ),
    ],
    workspace: null,
    harness: { kind: "echo" },
    // No clock to speak of: nothing speaks to a fixture's run, so it ends at the agent's first
    // settle unless a test says otherwise.
    lifetime: { idleMs: 0, attendedIdleMs: 0 },
    canOpenPatches: true,
    canPublishArtifacts: false,
  };

  return {
    item,
    ctx: {
      orchestrator,
      harness: echoHarness(),
      git: cliGitTransport(noopDiagnostics()),
      narrator,
      memory: specMemoryStore(brief),
      diag: noopDiagnostics(),
      injectedCtx: { systemPrompt: "You are ada.", ...(brief ? { brief } : {}) },
      checkoutRoot,
      inbox: noopInbox(),
    },
    narrator,
    originUrl: origin.url,
    checkoutRoot,
    checkoutDir: `${checkoutRoot}/${item.repos[0].path}`,
    branchName: `${item.repos[0].branchNamespace}/work`,
    cleanup: async () => {
      await origin.cleanup();
      for (const r of more) await r.origin.cleanup();
      await rm(checkoutRoot, { recursive: true });
    },
  };
}

/** The run's actions, once the core binds them: what a test harness says how the run went
 * through, as an agent does with `report_outcome` and `finish`. */
export function bindActions(fx: RunFixture): () => RunActions {
  let bound: RunActions | null = null;
  const prior = fx.ctx.onActions;
  fx.ctx.onActions = (actions) => {
    bound = actions;
    prior?.(actions);
  };
  return () => {
    if (bound === null) throw new Error("the run has not bound its actions yet");
    return bound;
  };
}
