// A run on a baked environment, end to end on the fake column: the checkout root already holds
// each repo as an environment build left it, and the run adopts every one in place — its setup
// runs again in the run phase on the warm tree — falls back to a fresh clone for one it cannot
// adopt, and tells the agent which machine it is on ahead of everything the repos say.

import { test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REPO_CONFIG_DIR } from "../src/core/brand.ts";
import { run } from "../src/core/run.ts";
import type { RunEnvironment } from "../src/core/types.ts";
import type { GitTransport } from "../src/ports/git_transport.ts";
import type { HarnessInput } from "../src/ports/harness.ts";
import { SETUP_PHASE_ENV } from "../src/helpers/environment.ts";
import { git } from "../src/helpers/git_exec.ts";
import { MACHINE_HEADING } from "../src/helpers/machine.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { bindActions, makeRunFixture, type RunFixture } from "./util.ts";
import type { RunActions } from "../src/ports/run_actions.ts";

/** Every repo's setup appends the phase it ran in to a gitignored file. */
const PHASE_FILES = {
  [`${REPO_CONFIG_DIR}/setup.yml`]: `steps:\n  - run: echo "$${SETUP_PHASE_ENV}" >> .phase\n`,
  [`${REPO_CONFIG_DIR}/environment.md`]: "Run the tests with `make test`.",
  ".gitignore": ".phase\n",
};

/**
 * Bakes `path` into the fixture's root the way an environment build does: a clone of its
 * origin at the current commit, with the image-phase setup already run in it. Answers the
 * commit it was built from.
 */
async function bake(fx: RunFixture, path: string): Promise<string> {
  const entry = fx.item.repos.find((r) => r.path === path)!;
  const dir = `${fx.checkoutRoot}/${path}`;
  await git(fx.checkoutRoot, "clone", "-q", "--", entry.url, path);
  await writeFile(`${dir}/.phase`, "image\n");
  return await git(dir, "rev-parse", "HEAD");
}

/** A new commit on an origin's main, so the run has something to move to. */
async function advance(url: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "runner-push-"));
  try {
    await git(work, "clone", "-q", "--", url, ".");
    await writeFile(`${work}/CHANGELOG.md`, "moved on\n");
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "next");
    await git(work, "push", "-q", "origin", "main");
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

function environment(commits: Record<string, string>): RunEnvironment {
  return {
    id: "env-1",
    image: "registry.test/ryph-envs/repo-1@sha256:abc",
    baked: true,
    commits,
    builtAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    toolchains: { rustc: "1.97.1", node: "24.3.0" },
    ref: "main",
  };
}

/** A harness that records what it was handed and commits nothing. */
function recordingHarness(into: { input: HarnessInput | null }, actions: () => RunActions) {
  return {
    run(input: HarnessInput) {
      into.input = input;
      actions().reportOutcome({ outcome: "no-changes" });
      return Promise.resolve({ summary: "looked around", interrupted: false });
    },
  };
}

test("e2e baked: every member is adopted in place, set up again in the run phase, and described first", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: PHASE_FILES,
    moreRepos: [{ path: "web", files: PHASE_FILES }, { path: "docs", files: PHASE_FILES }],
  });
  const seen = { input: null as HarnessInput | null };
  fx.ctx.harness = recordingHarness(seen, bindActions(fx));
  try {
    // The image holds repo and web; docs joined the workspace after the build.
    const builtRepo = await bake(fx, "repo");
    const builtWeb = await bake(fx, "web");
    // What else the image carried: a member since removed, and the builder's bookkeeping.
    await mkdir(`${fx.checkoutRoot}/removed-member/.git`, { recursive: true });
    await writeFile(`${fx.checkoutRoot}/.order`, "repo\nweb\nremoved-member\n");
    const head = await advance(fx.item.repos[0].url);
    fx.ctx.environment = environment({ repo: builtRepo, web: builtWeb });

    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");

    // Adopted, not re-cloned: the image phase's output is still there, and the run phase ran
    // on top of it — on the run's own commit, on the run's branch.
    assertEquals(await readFile(`${fx.checkoutRoot}/repo/.phase`, "utf8"), "image\nrun\n");
    assertEquals(await readFile(`${fx.checkoutRoot}/web/.phase`, "utf8"), "image\nrun\n");
    assertEquals(await readFile(`${fx.checkoutRoot}/docs/.phase`, "utf8"), "run\n");
    assertEquals(await git(`${fx.checkoutRoot}/repo`, "rev-parse", "HEAD"), head);
    assertEquals(
      await git(`${fx.checkoutRoot}/repo`, "symbolic-ref", "--short", "HEAD"),
      fx.branchName,
    );
    assertEquals(
      readdirSync(fx.checkoutRoot, { withFileTypes: true }).map((e) => e.name).sort(),
      ["docs", "repo", "web"],
    );

    // The machine is the platform's own block, whole, and the repos' prose is a block apart.
    const env = seen.input?.machine ?? "";
    assert(env.startsWith(MACHINE_HEADING), env);
    assertStringIncludes(env, "`registry.test/ryph-envs/repo-1@sha256:abc`, built 3 hours ago");
    assertStringIncludes(
      env,
      `| \`repo/\` | \`${builtRepo.slice(0, 12)}\` | \`${
        head.slice(0, 12)
      }\` | prepared in the image (warm) |`,
    );
    assertStringIncludes(env, "| `web/` |");
    assertStringIncludes(env, "| `docs/` | — |");
    assertStringIncludes(env, "cloned fresh — the image has none for it (cold)");
    // And the standing facts of a run, which no spec supplies (what the probe found is the
    // test machine's business — machine_test.ts pins the rendering).
    // Whatever the test machine happens to carry: both renderings say this much.
    assertStringIncludes(env, "on `PATH`");
    assertStringIncludes(env, "This run can be spoken to");
    assertStringIncludes(seen.input?.environment ?? "", "make test");
  } finally {
    await fx.cleanup();
  }
});

test("e2e baked: a run-phase setup step that fails on the adopted tree warns, and its dirt is discarded", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      ...PHASE_FILES,
      "lock.json": "{}\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n" +
        `  - run: echo "$${SETUP_PHASE_ENV}" >> .phase\n` +
        // the image phase passes; the run phase rewrites a tracked file, then fails
        `  - run: '[ "$${SETUP_PHASE_ENV}" = image ] || { echo moved > lock.json; exit 4; }'\n`,
    },
  });
  const seen = { input: null as HarnessInput | null };
  fx.ctx.harness = recordingHarness(seen, bindActions(fx));
  try {
    const built = await bake(fx, "repo");
    fx.ctx.environment = environment({ repo: built });
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    // adopted (the image's output is still there), set up again, the failed step's change gone
    assertEquals(await readFile(`${fx.checkoutRoot}/repo/.phase`, "utf8"), "image\nrun\n");
    assertEquals(await readFile(`${fx.checkoutRoot}/repo/lock.json`, "utf8"), "{}\n");
    assertEquals(
      await git(`${fx.checkoutRoot}/repo`, "symbolic-ref", "--short", "HEAD"),
      fx.branchName,
    );
    const report = orchestrator.setupFailureReports[0]?.[0];
    assert(report?.kind === "step" && report.discarded && report.code === 4);
    assertStringIncludes(seen.input?.machine ?? "", "**Setup failed in `repo/`.**");
  } finally {
    await fx.cleanup();
  }
});

test("e2e baked: a checkout that cannot be adopted is cloned fresh in its place, and the run says so", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles: PHASE_FILES });
  const seen = { input: null as HarnessInput | null };
  fx.ctx.harness = recordingHarness(seen, bindActions(fx));
  const real: GitTransport = fx.ctx.git;
  // A fetch that fails: the adoption points at an origin that is not there.
  fx.ctx.git = {
    clone: (repo, into) => real.clone(repo, into),
    adopt: (repo, dir) => real.adopt({ ...repo, url: `${fx.checkoutRoot}/gone.git` }, dir),
    push: (from, repo, branch) => real.push(from, repo, branch),
    fetchBase: (from, repo, ref) => real.fetchBase(from, repo, ref),
    fetchChangeRequest: (from, repo, cr) => real.fetchChangeRequest(from, repo, cr),
  };
  try {
    const built = await bake(fx, "repo");
    fx.ctx.environment = environment({ repo: built });

    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");

    // A fresh clone: the image's warm output is gone, the run's setup ran once.
    assertEquals(await readFile(`${fx.checkoutDir}/.phase`, "utf8"), "run\n");
    assertEquals(await git(fx.checkoutDir, "remote", "get-url", "origin"), fx.originUrl);
    const said = orchestrator.progressReports.find((p) =>
      p.message?.includes("the environment image's checkout could not be used")
    );
    assert(said !== undefined, JSON.stringify(orchestrator.progressReports));
    assertEquals(said.phase, "cloning");
    assertStringIncludes(said.message ?? "", "repo: ");
    assertStringIncludes(said.message ?? "", "cloning fresh");
    assertStringIncludes(
      seen.input?.machine ?? "",
      "cloned fresh — the prepared checkout could not be used (cold)",
    );
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run on the default image clones as ever, and is told nothing was prepared", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles: PHASE_FILES });
  const seen = { input: null as HarnessInput | null };
  fx.ctx.harness = recordingHarness(seen, bindActions(fx));
  const adopted: string[] = [];
  const real: GitTransport = fx.ctx.git;
  fx.ctx.git = { ...real, adopt: (repo, dir) => (adopted.push(dir), real.adopt(repo, dir)) };
  try {
    fx.ctx.environment = {
      id: "default",
      image: "quay.io/ryph/ryph-agent@sha256:def",
      baked: false,
      commits: {},
      builtAt: null,
      toolchains: {},
      ref: null,
    };
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");
    assertEquals(adopted, []);
    assertEquals(await readFile(`${fx.checkoutDir}/.phase`, "utf8"), "run\n");
    const env = seen.input?.machine ?? "";
    assertStringIncludes(env, "the platform's default image");
    assertStringIncludes(env, "Nothing was prepared");
  } finally {
    await fx.cleanup();
  }
});
