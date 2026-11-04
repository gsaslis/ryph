// What a git subprocess can run, and what it can see.
//
// Both halves are proven with REAL hooks, because a hook is exactly the mechanism at stake: a
// `.git/hooks/pre-commit` is writable by the repo's setup.yml steps and by the agent, and the
// runner's own `git commit` at finalize (and `git push`, carrying the credential in its
// environment) is what would execute it. So: a planted hook never runs at all, and the one hook
// that does run — the runner's own, from its own directory — gets an environment with no
// brand-scoped credential in it. Signing the checkout's config asks for is off the same way: the
// runner signs nothing, so a planted `gpg.program` never runs and cannot fail its git.

import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CODENAME, ENV_PREFIX, RUN_TRAILER } from "../src/core/brand.ts";
import { git, gitHooksDir } from "../src/helpers/git_exec.ts";
import { installRunTrailer } from "../src/helpers/checkout.ts";

/** A repo with one staged file, ready to commit. */
async function stagedRepo(root: string): Promise<string> {
  const repo = `${root}/repo`;
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(`${repo}/f.txt`, "work\n");
  await git(repo, "add", "-A");
  return repo;
}

/** Identity on the command line: the hermetic env has no user config to read one from. */
const identity = [
  "-c",
  "user.name=tester",
  "-c",
  "user.email=tester@test.local",
  "-c",
  "commit.gpgsign=false",
];

const hookScript = (out: string) => `#!/bin/sh\nenv > "${out}"\n`;

test("a checkout-planted hook never runs, and the hook that does sees no RYPH_*", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-hooks-"));
  const secret = `${ENV_PREFIX}_HOOK_PROBE_TOKEN`;
  // The shape of the real thing: the run token, the git credential and the MCP token all sit in
  // this process's environment under this prefix while the run's git commands execute.
  process.env[secret] = "SECRET-abc123";
  const planted = `${root}/planted-env`;
  const probe = `${root}/runner-hook-env`;
  try {
    const repo = await stagedRepo(root);
    // What a hostile repo (or the agent) writes. Both names, because commit-msg is also the
    // name of the runner's own hook — a planted one must not shadow it either.
    for (const name of ["pre-commit", "commit-msg"]) {
      await writeFile(`${repo}/.git/hooks/${name}`, hookScript(planted), { mode: 0o755 });
    }
    // The runner's own hooks directory is the only one git reads, so a hook there records the
    // exact environment any hook would have received.
    const probeHook = `${gitHooksDir()}/pre-commit`;
    await writeFile(probeHook, hookScript(probe), { mode: 0o755 });
    try {
      await git(repo, ...identity, "commit", "-m", "work");
    } finally {
      await rm(probeHook);
    }

    assertEquals(
      await stat(planted).then(() => true, () => false),
      false,
      "a hook planted in the checkout ran",
    );
    const env = await readFile(probe, "utf8");
    assert(!env.includes(`${ENV_PREFIX}_`), `a git child saw brand-scoped variables:\n${env}`);
    // The allowlist is an allowlist, not a blocklist: what git needs is still there.
    assertStringIncludes(env, "PATH=");
  } finally {
    delete process.env[secret];
    await rm(root, { recursive: true });
  }
});

test("the run trailer still lands, from the runner's own hooks directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-trailer-"));
  const installed = [`${gitHooksDir()}/commit-msg`, `${gitHooksDir()}/${CODENAME}-run-id`];
  try {
    const repo = await stagedRepo(root);
    await installRunTrailer(repo, "wi-test-0001");
    await git(repo, ...identity, "commit", "-m", "work");
    assertEquals(
      await git(repo, "log", "-1", `--format=%(trailers:key=${RUN_TRAILER},valueonly)`),
      "wi-test-0001",
    );
  } finally {
    // The process-wide hooks directory is shared with every other test in this process; a run
    // owns it for its lifetime, a test only for its own.
    for (const file of installed) await rm(file).catch(() => {});
    await rm(root, { recursive: true });
  }
});

test("signing the checkout's config turns on runs no program and fails no commit, merge or tag", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-signing-"));
  const ran = `${root}/gpg-ran`;
  try {
    const repo = await stagedRepo(root);
    // What the agent can write into its own checkout's config: signing on, through a program of
    // its choosing, and merges that refuse an unsigned side.
    const gpg = `${root}/gpg`;
    await writeFile(gpg, `#!/bin/sh\ntouch "${ran}"\nexit 1\n`, { mode: 0o755 });
    for (
      const [key, value] of [
        ["commit.gpgsign", "true"],
        ["tag.gpgsign", "true"],
        ["gpg.program", gpg],
        ["merge.verifySignatures", "true"],
      ]
    ) {
      await git(repo, "config", key, value);
    }
    const id = ["-c", "user.name=tester", "-c", "user.email=tester@test.local"];
    await git(repo, ...id, "commit", "-m", "work");
    await git(repo, "branch", "side");
    await git(repo, "checkout", "-q", "side");
    await writeFile(`${repo}/g.txt`, "side\n");
    await git(repo, "add", "-A");
    await git(repo, ...id, "commit", "-m", "side");
    await git(repo, "checkout", "-q", "main");
    await git(repo, ...id, "merge", "--no-ff", "--no-edit", "side");
    await git(repo, ...id, "tag", "-a", "-m", "t", "v1");

    assertEquals(await stat(ran).then(() => true, () => false), false, "gpg.program ran");
    assertEquals(await git(repo, "log", "-1", "--format=%G?"), "N");
  } finally {
    await rm(root, { recursive: true });
  }
});
