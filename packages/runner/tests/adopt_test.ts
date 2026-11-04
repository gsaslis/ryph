// Adopting a baked checkout: an environment image holds each repo already cloned, set up and
// built; the run moves it to its own commit in place — mtimes of what did not change kept, the
// build outputs kept, the image's refs gone — and falls back to a fresh clone when it cannot.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { readdirSync } from "node:fs";
import { serve } from "@ryph/service";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { adoptInPlace, clearStrays } from "../src/helpers/adopt.ts";
import { git } from "../src/helpers/git_exec.ts";
import { cliGitTransport } from "../src/adapters/git/cli.ts";
import { gatewayGitTransport } from "../src/adapters/git/gateway.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { makeThrowawayOrigin, type ThrowawayOrigin } from "./fixtures/origin.ts";
import { repoEntry } from "./util.ts";

const OLD = new Date("2020-01-01T00:00:00Z");

/** A commit pushed to the origin's `main`, changing `files`. Answers its sha. */
async function pushCommit(origin: ThrowawayOrigin, files: Record<string, string>) {
  const work = await mkdtemp(join(tmpdir(), "runner-push-"));
  try {
    await git(work, "clone", "-q", "--", origin.url, ".");
    for (const [name, content] of Object.entries(files)) {
      await writeFile(`${work}/${name}`, content);
    }
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "next");
    await git(work, "push", "-q", "origin", "main");
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

/**
 * What an environment build leaves at `/ryph/work/<path>`: a clone of the origin at its current
 * commit, with a gitignored build output, then copied the way a layer extraction does — new
 * inodes, the same mtimes — so the index's cached stat data no longer matches the files.
 */
async function bakedCheckout(origin: ThrowawayOrigin, root: string, path: string) {
  const build = await mkdtemp(join(tmpdir(), "runner-build-"));
  try {
    await git(build, "clone", "-q", "--", origin.url, "repo");
    const dir = `${build}/repo`;
    await writeFile(`${dir}/.git/info/exclude`, "target/\n");
    await mkdir(`${dir}/target`);
    await writeFile(`${dir}/target/warm.o`, "compiled\n");
    // Refs the build's clone may carry and the run must not see.
    await git(dir, "branch", "build-leftover");
    await git(dir, "tag", "v0-leftover");
    for (const file of ["README.md", "changed.txt", "unchanged.txt", "target/warm.o"]) {
      await utimes(`${dir}/${file}`, OLD, OLD).catch((err) => {
        if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
      });
    }
    const copy = await command("cp", { args: ["-Rp", dir, `${root}/${path}`] }).output();
    assert(copy.success, new TextDecoder().decode(copy.stderr));
  } finally {
    await rm(build, { recursive: true });
  }
  return `${root}/${path}`;
}

test("adopt: moves the checkout to the run's commit in place, keeping unchanged mtimes and the warm build", async () => {
  const origin = await makeThrowawayOrigin({
    files: { "changed.txt": "one\n", "unchanged.txt": "same\n" },
  });
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    const dir = await bakedCheckout(origin, root, "api");
    const next = await pushCommit(origin, { "changed.txt": "two\n" });

    const transport = cliGitTransport(noopDiagnostics());
    await transport.adopt(repoEntry({ url: origin.url, ref: "main", path: "api" }), dir);

    assertEquals(await git(dir, "rev-parse", "HEAD"), next);
    assertEquals(await readFile(`${dir}/changed.txt`, "utf8"), "two\n");
    // Git rewrote the file that differs and nothing else.
    assertEquals((await stat(`${dir}/unchanged.txt`)).mtime?.getTime(), OLD.getTime());
    assertNotEquals((await stat(`${dir}/changed.txt`)).mtime?.getTime(), OLD.getTime());
    // The build's outputs are the point of the image; nothing cleaned them.
    assertEquals(await readFile(`${dir}/target/warm.o`, "utf8"), "compiled\n");
    assertEquals((await stat(`${dir}/target/warm.o`)).mtime?.getTime(), OLD.getTime());
    // Left as a clone would be: on the branch, tracking origin, which is the run's URL.
    assertEquals(await git(dir, "symbolic-ref", "--short", "HEAD"), "main");
    assertEquals(await git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}"), "origin/main");
    assertEquals(await git(dir, "remote", "get-url", "origin"), origin.url);
    assertEquals(await git(dir, "status", "--porcelain"), "");
  } finally {
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});

test("adopt: the image's refs are pruned to the run's one branch", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    const dir = await bakedCheckout(origin, root, "api");
    await git(dir, "remote", "add", "builder", "/somewhere/else");
    await adoptInPlace(git, dir, origin.url, "main");
    assertEquals(
      (await git(dir, "for-each-ref", "--format=%(refname)")).split("\n").sort(),
      ["refs/heads/main", "refs/remotes/origin/main"],
    );
    assertEquals(await git(dir, "remote"), "origin");
    // No reflog is left pointing at what the image knew.
    assertEquals(await git(dir, "reflog", "show", "--all"), "");
  } finally {
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});

test("adopt: a commit id checks out detached, and no branch survives", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    const dir = await bakedCheckout(origin, root, "api");
    const next = await pushCommit(origin, { "changed.txt": "two\n" });
    // A local origin serves any commit by id, which is what the forge gateway does too.
    const sha = await adoptInPlace(git, dir, origin.url, next);
    assertEquals(sha, next);
    assertEquals(await git(dir, "rev-parse", "HEAD"), next);
    await assertRejects(() => git(dir, "symbolic-ref", "-q", "HEAD"));
    assertEquals(await git(dir, "for-each-ref", "--format=%(refname)"), "");
  } finally {
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});

test("adopt: a bad fetch throws, and so does a checkout that is not clean", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    const dir = await bakedCheckout(origin, root, "api");
    await assertRejects(() => adoptInPlace(git, dir, `${root}/no-such-origin`, "main"), Error);
    await assertRejects(() => adoptInPlace(git, dir, origin.url, "no-such-branch"), Error);

    const dirty = await bakedCheckout(origin, root, "web");
    await writeFile(`${dirty}/stray.txt`, "not the build's\n");
    await assertRejects(
      () => adoptInPlace(git, dirty, origin.url, "main"),
      Error,
      "the baked checkout is not clean (stray.txt)",
    );
  } finally {
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});

test("adopt through the gateway: the adopted checkout can ship, as a cloned one can", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  const received: string[] = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    received.push(new URL(req.url).pathname);
    await req.arrayBuffer();
    return new Response(JSON.stringify({ headSha: "x", bundleKey: "k" }), { status: 201 });
  });
  try {
    const dir = await bakedCheckout(origin, root, "api");
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: `http://127.0.0.1:${server.addr.port}`,
      token: "ryph-git-virtual-key",
      runId: "r-1",
    });
    const entry = repoEntry({
      connectedRepoId: "cr-api",
      url: origin.url,
      ref: "main",
      path: "api",
      branchNamespace: "ryph/ada/r-1",
    });
    const checkout = await transport.adopt(entry, dir);
    const baseSha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "ryph/ada/r-1");
    await writeFile(`${dir}/work.txt`, "work\n");
    await git(dir, "add", "work.txt");
    await git(dir, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "work");
    await transport.push(checkout, entry, { name: "ryph/ada/r-1", baseSha });
    // The adopt asked the gateway about the base it landed on, then the push hit the intake.
    assertEquals(received, ["/v1/git/r-1/cr-api/base", "/v1/patches/cr-api"]);
    // The credential never lands in the checkout's config, adopted or cloned.
    assert(!(await readFile(`${dir}/.git/config`, "utf8")).includes("ryph-git-virtual-key"));
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});

test("clearStrays: everything under the root but the run's repos goes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    await mkdir(`${root}/api`);
    await mkdir(`${root}/removed-member/.git`, { recursive: true });
    await writeFile(`${root}/.order`, "api\nremoved-member\n");
    assertEquals(await clearStrays(root, ["api", "web"]), [".order", "removed-member"]);
    assertEquals(readdirSync(root, { withFileTypes: true }).map((e) => e.name), ["api"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("adopt: a run on a change request keeps what it merges into as origin/<target>", async () => {
  const origin = await makeThrowawayOrigin({ files: { "changed.txt": "one\n" } });
  const root = await mkdtemp(join(tmpdir(), "runner-work-"));
  try {
    const dir = await bakedCheckout(origin, root, "api");
    // The change request's branch, then main moving on past where it forked.
    const work = await mkdtemp(join(tmpdir(), "runner-cr-"));
    let crHead: string;
    try {
      await git(work, "clone", "-q", "--", origin.url, ".");
      await git(work, "checkout", "-q", "-b", "feature/x");
      await writeFile(`${work}/cr.txt`, "cr\n");
      await git(work, "add", "-A");
      await git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "cr");
      await git(work, "push", "-q", "origin", "feature/x");
      crHead = await git(work, "rev-parse", "HEAD");
    } finally {
      await rm(work, { recursive: true });
    }
    const mainTip = await pushCommit(origin, { "changed.txt": "two\n" });

    const transport = cliGitTransport(noopDiagnostics());
    await transport.adopt(
      repoEntry({ url: origin.url, ref: "feature/x", targetRef: "main", path: "api" }),
      dir,
    );

    // On the change request's head — the target's fetch came after, and did not move it.
    assertEquals(await git(dir, "rev-parse", "HEAD"), crHead);
    assertEquals(await git(dir, "rev-parse", "refs/remotes/origin/main"), mainTip);
    const refs = (await git(dir, "for-each-ref", "--format=%(refname)")).split("\n").sort();
    assertEquals(refs, [
      "refs/heads/feature/x",
      "refs/remotes/origin/feature/x",
      "refs/remotes/origin/main",
    ]);
  } finally {
    await rm(root, { recursive: true });
    await origin.cleanup();
  }
});
