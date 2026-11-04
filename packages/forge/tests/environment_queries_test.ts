// The three reads environments are decided by — the `.ryph/` tree id, the default branch's
// head, and what kind of branch a ref is — through the pure handler against real git on temp
// dirs. The properties pinned here are the threat model's (one fixed path, an id and never
// content) and the cache's (a commit read writes no ref), plus the answers themselves.

import { execFileSync } from "node:child_process";
import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import { git } from "../src/helpers/git_exec.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = { provider: "github", repoRef: "acme/app", tenantId: "42" };

/** Pull request heads by number, as a test sets them: which repo each head lives in. */
type Pulls = Map<string, string | null>;

/** Only what these routes reach, plus GitHub's classification rule over `pulls`. */
function forgeApi(pulls: Pulls): ForgeApi {
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
    classifyBranch: (repo: { repoRef: string }, branch: string) => {
      const pull = /^pull\/(\d+)\/head$/.exec(branch);
      if (pull === null) return Promise.resolve("branch");
      if (!pulls.has(pull[1])) {
        return Promise.reject(new ForgeApiError(`no pull request #${pull[1]}`, true));
      }
      return Promise.resolve(pulls.get(pull[1]) === repo.repoRef ? "branch" : "foreign");
    },
  } as unknown as ForgeApi;
}

async function build(root: string, pulls: Pulls = new Map()) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const never = () => Promise.reject(new Error("not part of this surface"));
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: forgeApi(pulls) }, "forge API"),
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir },
  };
  const handler = makeHandler(deps);
  const ask = async (path: string, body: Record<string, unknown>, token = SERVICE_TOKEN) => {
    const res = await handler(
      new Request(`http://forge/v1/service/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ repo: REPO, ...body }),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  return { deps, ask };
}

/** Adds `.ryph/` with one file to the upstream's current branch; answers the new commit. */
async function addRyph(dir: string, text = "FROM quay.io/ryph/ryph-universal:1\n") {
  await mkdir(`${dir}/.ryph`, { recursive: true });
  await writeFile(`${dir}/.ryph/Dockerfile`, text);
  await git(dir, "add", ".");
  await commit(dir, "describe the machine");
  return await git(dir, "rev-parse", "HEAD");
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("ryph-tree answers the .ryph tree id at a branch, and the commit it read", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const head = await addRyph(upstream);

    const res = await ask("ryph-tree", { url: upstream, commitOrRef: "main" });
    assertEquals(res.status, 200);
    assertEquals(res.body.commit, head);
    assertEquals(res.body.tree, await git(upstream, "rev-parse", `${head}:.ryph`));
    // Ids and a yes/no, nothing else: no byte of the Dockerfile crosses the wire.
    assertEquals(Object.keys(res.body).sort(), [
      "commit",
      "dockerfile",
      "dockerfileBlob",
      "fullTree",
      "tree",
    ]);
    assertEquals(res.body.fullTree, res.body.tree, "nothing left out");
    assertEquals(res.body.dockerfile, true);
    assertEquals(
      res.body.dockerfileBlob,
      await git(upstream, "rev-parse", `${head}:.ryph/Dockerfile`),
    );
  });
});

test("ryph-tree says no Dockerfile where .ryph holds only setup, or a directory by that name", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await mkdir(`${upstream}/.ryph/Dockerfile`, { recursive: true });
    await writeFile(`${upstream}/.ryph/Dockerfile/README`, "not a file\n");
    await writeFile(`${upstream}/.ryph/setup.yml`, "steps: []\n");
    await git(upstream, "add", ".");
    await commit(upstream, "setup only");

    const res = await ask("ryph-tree", { url: upstream, commitOrRef: "main" });
    assertEquals(res.status, 200);
    assertEquals(typeof res.body.tree, "string");
    assertEquals(res.body.dockerfile, false);
    assertEquals(res.body.dockerfileBlob, null);
  });
});

test("ryph-tree moves when anything under .ryph does, and only then", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const first = await addRyph(upstream);
    await writeFile(`${upstream}/src.txt`, "code only\n");
    await git(upstream, "add", ".");
    await commit(upstream, "code only");
    const codeOnly = await git(upstream, "rev-parse", "HEAD");
    const changed = await addRyph(upstream, "FROM rust:1.97\n");

    const tree = async (c: string) =>
      (await ask("ryph-tree", { url: upstream, commitOrRef: c })).body.tree;
    assertEquals(await tree(codeOnly), await tree(first));
    assert(await tree(changed) !== await tree(first));
  });
});

test("ryph-tree leaves out the files no build reads, and answers git's own id for the rest", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await mkdir(`${upstream}/.ryph/scripts`, { recursive: true });
    await writeFile(`${upstream}/.ryph/setup.yml`, "steps: [{ run: .ryph/scripts/a.sh }]\n");
    await writeFile(`${upstream}/.ryph/scripts/a.sh`, "true\n");
    await writeFile(`${upstream}/.ryph/scripts/checks.yml`, "not the check definition\n");
    await git(upstream, "add", ".");
    await commit(upstream, "setup");
    const setup = await git(upstream, "rev-parse", "HEAD");
    for (const name of ["checks.yml", "checks.yaml", "services.yml", "services.yaml"]) {
      await writeFile(`${upstream}/.ryph/${name}`, "{}\n");
    }
    await writeFile(`${upstream}/.ryph/environment.md`, "# The machine\n");
    await git(upstream, "add", ".");
    await commit(upstream, "checks, services and a description");
    const described = await git(upstream, "rev-parse", "HEAD");
    await writeFile(`${upstream}/.ryph/scripts/a.sh`, "false\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a script setup runs");
    const script = await git(upstream, "rev-parse", "HEAD");

    const tree = async (c: string) =>
      (await ask("ryph-tree", { url: upstream, commitOrRef: c })).body.tree;
    // Nothing to leave out: the tree's own id.
    assertEquals(await tree(setup), await git(upstream, "rev-parse", `${setup}:.ryph`));
    // Left out, the id is the one git gives the tree without them, subdirectory and all.
    assertEquals(await tree(described), await tree(setup));
    const full = (await ask("ryph-tree", { url: upstream, commitOrRef: described })).body.fullTree;
    assertEquals(full, await git(upstream, "rev-parse", `${described}:.ryph`));
    assert(await tree(described) !== await git(upstream, "rev-parse", `${described}:.ryph`));
    // Anything else under .ryph/ counts, a file a setup step runs included.
    assert(await tree(script) !== await tree(described));
  });
});

test("ryph-tree hashes a name that is not UTF-8 as git stores it", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    // Built with plumbing: a filesystem may refuse such a name, git does not.
    const mktree = (lines: Buffer[]) =>
      execFileSync("git", ["mktree"], { cwd: upstream, input: Buffer.concat(lines) })
        .toString().trim();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: upstream,
      input: "true\n",
    }).toString().trim();
    const entry = (name: Buffer) =>
      Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from("\n")]);
    const odd = Buffer.from([0x73, 0xff, 0x2e, 0x73, 0x68]); // "s\xff.sh"
    const machine = mktree([entry(odd)]);
    const withChecks = mktree([entry(Buffer.from("checks.yml")), entry(odd)]);
    const top = mktree([Buffer.from(`040000 tree ${withChecks}\t.ryph\n`)]);
    const parent = await git(upstream, "rev-parse", "HEAD");
    const commit = execFileSync("git", ["commit-tree", top, "-p", parent, "-m", "odd name"], {
      cwd: upstream,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).toString().trim();
    await git(upstream, "update-ref", "refs/heads/main", commit);

    const res = await ask("ryph-tree", { url: upstream, commitOrRef: "main" });
    assertEquals(res.body.tree, machine);
  });
});

test("ryph-tree of a .ryph holding only what no build reads is the empty tree, not none", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await mkdir(`${upstream}/.ryph`, { recursive: true });
    await writeFile(`${upstream}/.ryph/checks.yml`, "checks: {}\n");
    await git(upstream, "add", ".");
    await commit(upstream, "checks only");

    const res = await ask("ryph-tree", { url: upstream, commitOrRef: "main" });
    assertEquals(res.body.tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    assertEquals(res.body.fullTree, await git(upstream, "rev-parse", "main:.ryph"));
    assertEquals(res.body.dockerfile, false);
  });
});

test("ryph-tree's Dockerfile id moves with the Dockerfile, not with the rest of .ryph", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const first = await addRyph(upstream);
    await writeFile(`${upstream}/.ryph/setup.yml`, "steps: []\n");
    await git(upstream, "add", ".");
    await commit(upstream, "setup only");
    const setup = await git(upstream, "rev-parse", "HEAD");
    const changed = await addRyph(upstream, "FROM rust:1.97\n");

    const read = async (c: string) =>
      (await ask("ryph-tree", { url: upstream, commitOrRef: c })).body;
    const [a, b, c] = [await read(first), await read(setup), await read(changed)];
    assert(a.tree !== b.tree);
    assertEquals(b.dockerfileBlob, a.dockerfileBlob);
    assert(c.dockerfileBlob !== a.dockerfileBlob);
  });
});

test("ryph-tree is null where the commit has no .ryph directory — a file there included", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    const bare = await makeUpstream(upstream);
    assertEquals((await ask("ryph-tree", { url: upstream, commitOrRef: bare })).body, {
      commit: bare,
      tree: null,
      fullTree: null,
      dockerfile: false,
      dockerfileBlob: null,
    });

    await writeFile(`${upstream}/.ryph`, "not a directory\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a file named .ryph");
    const file = await git(upstream, "rev-parse", "HEAD");
    assertEquals((await ask("ryph-tree", { url: upstream, commitOrRef: file })).body.tree, null);
  });
});

test("ryph-tree reads a commit by id without writing a ref for it", async () => {
  await withRoot(async (root) => {
    const { ask, deps } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await git(upstream, "checkout", "--quiet", "-b", "side");
    const side = await addRyph(upstream);
    // The commit is reachable from no branch upstream any more — only its id names it.
    await git(upstream, "checkout", "--quiet", "main");
    await git(upstream, "branch", "--quiet", "-D", "side");

    const res = await ask("ryph-tree", { url: upstream, commitOrRef: side });
    assertEquals(res.status, 200);
    assertEquals(res.body.commit, side);
    assertMatch(res.body.tree, /^[0-9a-f]{40}$/);

    const { dir } = await deps.cache.ensureCommit({ url: upstream }, side, anonymous);
    assertEquals(await git(dir, "for-each-ref", "--format=%(refname)"), "");
  });
});

test("ryph-tree says it could not ask rather than guessing, and refuses what is not a ref", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);

    const missing = await ask("ryph-tree", { url: upstream, commitOrRef: "f".repeat(40) });
    assertEquals(missing.status, 502);
    const gone = await ask("ryph-tree", { url: `${root}/nowhere`, commitOrRef: "main" });
    assertEquals(gone.status, 502);
    const tag = await ask("ryph-tree", { url: upstream, commitOrRef: "refs/tags/v1" });
    assertEquals([tag.status, tag.body.terminal], [400, true]);
    // A path never crosses the wire: the schema refuses a key it does not know.
    const path = await ask("ryph-tree", { url: upstream, commitOrRef: "main", path: "src" });
    assertEquals(path.status, 400);
    const denied = await ask("ryph-tree", { url: upstream, commitOrRef: "main" }, "wrong");
    assertEquals(denied.status, 401);
  });
});

test("ryph-tree is strict: a warm entry with the upstream gone is 502, not yesterday's tree", async () => {
  await withRoot(async (root) => {
    const { deps, ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await addRyph(upstream);
    assertEquals((await ask("ryph-tree", { url: upstream, commitOrRef: "main" })).status, 200);

    await rm(upstream, { recursive: true });
    const gone = await ask("ryph-tree", { url: upstream, commitOrRef: "main" });
    assertEquals(gone.status, 502);
    // The entry is untouched by the strict read: the clone door would still serve it.
    assertEquals((await deps.cache.find({ url: upstream }, "main"))?.freshness, { kind: "fresh" });
  });
});

test("default-branch-head reads the branch off the upstream's HEAD, not off a guess", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    const head = await makeUpstream(upstream);
    assertEquals((await ask("default-branch-head", { url: upstream })).body, {
      ref: "main",
      commit: head,
    });

    // The default is renamed upstream, and moves: both are what the answer now says.
    await git(upstream, "checkout", "--quiet", "-b", "trunk");
    const trunk = await addRyph(upstream);
    assertEquals((await ask("default-branch-head", { url: upstream })).body, {
      ref: "trunk",
      commit: trunk,
    });

    const gone = await ask("default-branch-head", { url: `${root}/nowhere` });
    assertEquals(gone.status, 502);
  });
});

test("branch-kind: the default, the repo's own branches, and a fork's pull request", async () => {
  await withRoot(async (root) => {
    const pulls: Pulls = new Map([["7", "acme/app"], ["8", "stranger/app"], ["9", null]]);
    const { ask } = await build(root, pulls);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);

    const kind = async (ref: string) => (await ask("branch-kind", { url: upstream, ref })).body;
    assertEquals(await kind("main"), { kind: "default" });
    assertEquals(await kind("refs/heads/main"), { kind: "default" });
    assertEquals(await kind("feat/x"), { kind: "branch" });
    assertEquals(await kind("refs/pull/7/head"), { kind: "branch" });
    assertEquals(await kind("refs/pull/8/head"), { kind: "foreign" });
    // A deleted fork is nobody's own.
    assertEquals(await kind("refs/pull/9/head"), { kind: "foreign" });

    const unknown = await ask("branch-kind", { url: upstream, ref: "refs/pull/10/head" });
    assertEquals([unknown.status, unknown.body.terminal], [404, true]);
    const tag = await ask("branch-kind", { url: upstream, ref: "refs/tags/v1" });
    assertEquals(tag.status, 400);
  });
});

test("the cache's commit read is served from disk once held, and refuses what is not an id", async () => {
  await withRoot(async (root) => {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const upstream = `${root}/upstream`;
    const head = await makeUpstream(upstream);
    const { dir } = await cache.ensureCommit({ url: upstream }, head, anonymous);
    // Upstream gone: an object the entry already holds needs no contact.
    await rm(upstream, { recursive: true });
    assertEquals((await cache.ensureCommit({ url: upstream }, head, anonymous)).dir, dir);
    await assertRejects(() => cache.ensureCommit({ url: upstream }, "main", anonymous));
    await assertRejects(() => cache.ensureCommit({ url: upstream }, "e".repeat(40), anonymous));
  });
});

test("ryph-base: a branch behind a default branch that moved its .ryph changed nothing", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const start = await addRyph(upstream);
    // A code-only branch off `start`, then the default branch moves its `.ryph/`.
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/src.txt`, "code only\n");
    await git(upstream, "add", ".");
    await commit(upstream, "code only");
    const codeOnly = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "main");
    const moved = await addRyph(upstream, "FROM rust:1.97\n");

    const res = await ask("ryph-base", { url: upstream, head: codeOnly, base: "main" });
    assertEquals(res.status, 200);
    assertEquals(res.body, {
      base: moved,
      mergeBase: start,
      tree: await git(upstream, "rev-parse", `${start}:.ryph`),
      changed: [],
    });
  });
});

test("ryph-base names the paths a branch changed under .ryph, and only those", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const start = await addRyph(upstream);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/.ryph/setup.yml`, "steps: []\n");
    await writeFile(`${upstream}/.ryph/checks.yml`, "checks: {}\n");
    await writeFile(`${upstream}/src.txt`, "and code\n");
    await git(upstream, "add", ".");
    await commit(upstream, "setup and code");
    const head = await git(upstream, "rev-parse", "HEAD");

    const res = await ask("ryph-base", { url: upstream, head, base: "main" });
    assertEquals(res.status, 200);
    assertEquals(res.body.mergeBase, start);
    // checks.yml is no build's input, so it is never named.
    assertEquals(res.body.changed, [".ryph/setup.yml"]);
    assert(res.body.tree !== await git(upstream, "rev-parse", `${head}:.ryph`));
  });
});

test("ryph-base names a path with spaces or non-ASCII verbatim, never C-quoted", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await addRyph(upstream);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/.ryph/notes ü.md`, "prose\n");
    await git(upstream, "add", ".");
    await commit(upstream, "an unusual name");
    const head = await git(upstream, "rev-parse", "HEAD");

    const res = await ask("ryph-base", { url: upstream, head, base: "main" });
    assertEquals(res.status, 200);
    assertEquals(res.body.changed, [".ryph/notes ü.md"]);
  });
});

test("ryph-base: no shared history is a null merge base, and bad asks are refused", async () => {
  await withRoot(async (root) => {
    const { ask } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await git(upstream, "checkout", "--quiet", "--orphan", "other");
    await addRyph(upstream);
    const orphan = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "main");

    const res = await ask("ryph-base", { url: upstream, head: orphan, base: "main" });
    assertEquals(res.status, 200);
    assertEquals(res.body.mergeBase, null);
    assertEquals(res.body.tree, null);
    assertEquals(res.body.changed, []);

    const missing = await ask("ryph-base", { url: upstream, head: "f".repeat(40), base: "main" });
    assertEquals(missing.status, 502);
    const tag = await ask("ryph-base", { url: upstream, head: orphan, base: "refs/tags/v1" });
    assertEquals(tag.status, 400);
    const notCommit = await ask("ryph-base", { url: upstream, head: "main", base: "main" });
    assertEquals(notCommit.status, 400);
    const path = await ask("ryph-base", { url: upstream, head: orphan, base: "main", path: "x" });
    assertEquals(path.status, 400);
  });
});
