// The hermetic executor against a hostile parent environment: a forge started from inside a git
// hook, or from a shell that exported `GIT_DIR`, must not have every git it runs pointed at that
// repository instead of the one it named. And the other direction: what a machine needs to reach
// a forge at all — a private CA, a proxy — still reaches git.

import { test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { git, gitBounded, makeGitCapped } from "../src/helpers/git_exec.ts";
import { makeUpstream } from "./util.ts";

/** Runs `fn` with `vars` set in this process's environment, restoring what was there. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("no inherited GIT_* variable reaches git: not GIT_DIR, the object store, nor config", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  try {
    const mine = `${tmp}/mine`;
    const other = `${tmp}/other`;
    await makeUpstream(mine, "mine");
    await makeUpstream(other, "other");
    await withEnv({
      GIT_DIR: `${other}/.git`,
      GIT_WORK_TREE: other,
      GIT_COMMON_DIR: `${other}/.git`,
      GIT_OBJECT_DIRECTORY: `${other}/.git/objects`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `${other}/.git/objects`,
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/evil'",
      GIT_NAMESPACE: "evil",
      GIT_INDEX_FILE: `${other}/.git/index`,
    }, async () => {
      assertEquals(await git(mine, "rev-parse", "--absolute-git-dir"), `${mine}/.git`);
      assertEquals(await git(mine, "rev-parse", "--git-path", "objects"), ".git/objects");
      // The injected config is not there to read.
      await assertRejects(() => git(mine, "config", "--get", "core.hookspath"));
      assertEquals(
        (await gitBounded(mine, 1024, "rev-parse", "--absolute-git-dir"))?.trim(),
        `${mine}/.git`,
      );
      const capped = await makeGitCapped({ debug() {} })(
        mine,
        1024,
        "rev-parse",
        "--absolute-git-dir",
      );
      assertEquals(new TextDecoder().decode(capped.out).trim(), `${mine}/.git`);
      // The README each repository was seeded with says which one git read.
      assertEquals(
        (await git(mine, "show", "HEAD:README.md")).includes("mine"),
        true,
      );
    });
  } finally {
    await rm(tmp, { recursive: true });
  }
});

/** The environment git hands a command it runs, as `git` here spawns it: an alias's shell sees
 * exactly what git was given (plus the few variables git sets for any alias). */
async function envSeenByGit(dir: string): Promise<Map<string, string>> {
  const out = await git(dir, "-c", "alias.show-env=!env", "show-env");
  return new Map(
    out.split("\n").filter((l) => l.includes("=")).map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at), l.slice(at + 1)] as [string, string];
    }),
  );
}

test("the transport settings a machine needs reach git: TLS, proxy and HTTP variables pass", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  try {
    const kept = {
      GIT_SSL_CAINFO: `${tmp}/corp-ca.pem`,
      GIT_SSL_CAPATH: `${tmp}/certs`,
      GIT_SSL_NO_VERIFY: "1",
      GIT_PROXY_SSL_CAINFO: `${tmp}/proxy-ca.pem`,
      GIT_HTTP_USER_AGENT: "corp-agent/1.0",
      GIT_HTTP_LOW_SPEED_LIMIT: "1000",
    };
    await withEnv(kept, async () => {
      const seen = await envSeenByGit(tmp);
      for (const [key, value] of Object.entries(kept)) assertEquals(seen.get(key), value, key);
    });
  } finally {
    await rm(tmp, { recursive: true });
  }
});

test("what redirects git still does not reach it: config channels, the hash, the template, the exec path", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  try {
    await withEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/tmp/evil",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG: `${tmp}/evil.config`,
      GIT_DEFAULT_HASH: "sha256",
      GIT_TEMPLATE_DIR: `${tmp}/evil-template`,
      GIT_CEILING_DIRECTORIES: "/",
      GIT_SHALLOW_FILE: `${tmp}/shallow`,
      GIT_EXTERNAL_DIFF: "touch /tmp/evil-diff",
    }, async () => {
      const seen = await envSeenByGit(tmp);
      for (
        const key of [
          "GIT_CONFIG",
          "GIT_DEFAULT_HASH",
          "GIT_TEMPLATE_DIR",
          "GIT_CEILING_DIRECTORIES",
          "GIT_SHALLOW_FILE",
          "GIT_EXTERNAL_DIFF",
        ]
      ) {
        assertEquals(seen.get(key), undefined, key);
      }
      // The ones the executor sets itself are its own values, not the inherited ones.
      assertEquals(seen.get("GIT_CONFIG_COUNT"), "1");
      assertEquals(seen.get("GIT_CONFIG_KEY_0"), "credential.helper");
      assertEquals(seen.get("GIT_CONFIG_VALUE_0"), "");
      assertEquals(seen.get("GIT_CONFIG_NOSYSTEM"), "1");
      assertEquals(seen.get("GIT_CONFIG_GLOBAL"), "/dev/null");
      // And they had no effect: a repository made here is sha1, as every scratch repo must be.
      await git(tmp, "init", "--quiet", "repo");
      assertEquals(await git(`${tmp}/repo`, "rev-parse", "--show-object-format"), "sha1");
      await assertRejects(() => git(`${tmp}/repo`, "config", "--get", "core.hookspath"));
    });
  } finally {
    await rm(tmp, { recursive: true });
  }
});
