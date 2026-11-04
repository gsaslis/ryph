// The hermetic executor presents no credential it was not handed (helpers/git_exec.ts, "no
// ambient credential"): a fetch the service sends anonymously must stay anonymous on a developer's
// machine — no helper from any config scope, no `~/.netrc`, no ssh key — or the runner reads and
// writes as whoever runs it. And the one credential it IS handed still arrives.
//
// KEEP IN STEP with packages/forge/tests/git_credentials_test.ts: the two executors are
// duplicates and so are their tests.

import { test } from "bun:test";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { git, makeGit } from "../src/helpers/git_exec.ts";

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

/** A git server that only ever asks for a password, recording each Authorization it is sent. */
async function challengingServer() {
  const auths: Array<string | null> = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    auths.push(req.headers.get("authorization"));
    return new Response("auth required", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="ryph-test"' },
    });
  });
  return { origin: `http://127.0.0.1:${server.addr.port}`, auths, server };
}

async function scratch(fn: (tmp: string) => Promise<void>) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true });
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test("a credential helper in the repository's own config never runs, and the fetch fails unprompted", async () => {
  await scratch(async (tmp) => {
    const { origin, auths, server } = await challengingServer();
    try {
      await git(tmp, "init", "--quiet", "repo");
      const marker = `${tmp}/helper-ran`;
      await git(
        `${tmp}/repo`,
        "config",
        "credential.helper",
        `!f() { touch ${marker}; echo username=dev; echo password=secret; }; f`,
      );
      // The same helper, arriving the way Apple's built-in config and an ambient
      // GIT_CONFIG_PARAMETERS would bring it.
      await withEnv(
        { GIT_CONFIG_PARAMETERS: `'credential.helper'='!touch ${marker}'` },
        async () => {
          const err = await assertRejects(() => git(`${tmp}/repo`, "fetch", `${origin}/x.git`));
          assertStringIncludes(String(err), "terminal prompts disabled");
        },
      );
      assertEquals(await exists(marker), false, "the helper ran");
      assertEquals(auths.filter((a) => a !== null), []);
    } finally {
      await server.shutdown();
    }
  });
});

test("~/.netrc is not consulted", async () => {
  await scratch(async (tmp) => {
    const { origin, auths, server } = await challengingServer();
    try {
      await writeFile(`${tmp}/.netrc`, "machine 127.0.0.1 login dev password secret\n", {
        mode: 0o600,
      });
      await withEnv({ HOME: tmp }, async () => {
        await assertRejects(() => git(tmp, "ls-remote", `${origin}/x.git`));
      });
      assertEquals(auths.length > 0, true, "git never reached the server");
      assertEquals(auths.filter((a) => a !== null), []);
    } finally {
      await server.shutdown();
    }
  });
});

test("ssh is refused outright, before any key or agent is offered", async () => {
  await scratch(async (tmp) => {
    const err = await assertRejects(() => git(tmp, "ls-remote", "ssh://git@127.0.0.1:1/x.git"));
    assertStringIncludes(String(err), "transport 'ssh' not allowed");
  });
});

test("the injected extraheader still reaches its origin, behind the helper reset", async () => {
  await scratch(async (tmp) => {
    const { origin, auths, server } = await challengingServer();
    try {
      const authed = makeGit({ debug() {} }, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: "Authorization: Bearer injected",
      });
      await assertRejects(() => authed(tmp, "ls-remote", `${origin}/x.git`));
      assertEquals(auths[0], "Bearer injected");
      // And the reset sits in front of it, where no caller can leave it out.
      const pairs = await authed(tmp, "config", "--list", "--show-scope");
      assertStringIncludes(pairs, "command\tcredential.helper=\n");
    } finally {
      await server.shutdown();
    }
  });
});
