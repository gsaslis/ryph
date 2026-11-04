// The `local` provider's path rules, against real directories and real git: what a person may
// connect (the describe route and the helper under it), and the re-check every later use makes
// — a path swapped for a symlink since it was connected names somewhere else, and is refused.

import { test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { localForgeApi } from "../src/adapters/forge_api/local.ts";
import { localChangeTransport } from "../src/adapters/change_transport/local.ts";
import { ForgeApiError, providerRegistry, wholeRepoVisibility } from "../src/ports/forge_api.ts";
import { describeLocalRepo, recheckLocalRepo, refPathIsPlain } from "../src/helpers/local_repo.ts";
import { isContainedIn, isLocalRepoRef } from "../src/core/local_repo.ts";
import { git } from "../src/helpers/git_exec.ts";
import { RunGrantRepoSchema, SubmitRequestSchema } from "../src/schema.ts";
import { makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

/** A temp dir laid out as `<tmp>/root` (the allowed root) with one repository at
 * `<tmp>/root/repo`, and `<tmp>/outside` beside it. Every path is the REAL one — macOS's temp
 * dir sits behind a symlink, and the rules compare real paths. */
async function world() {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const root = `${tmp}/root`;
  const repo = `${root}/repo`;
  await makeUpstream(repo);
  await mkdir(`${tmp}/outside`, { recursive: true });
  return { tmp, root, repo, cleanup: () => rm(tmp, { recursive: true }) };
}

const describe = (path: string, root: string) => describeLocalRepo(path, root, git);

async function refusal(path: string, root: string): Promise<string> {
  const out = await describe(path, root);
  assertFalse(out.ok, `${path} should be refused`);
  return out.reason;
}

test("containment is by path segment, never by string prefix", () => {
  assert(isContainedIn("/srv/repos/app", "/srv/repos"));
  assert(isContainedIn("/srv/repos", "/srv/repos"));
  assert(isContainedIn("/srv/repos/app", "/srv/repos/"));
  assertFalse(isContainedIn("/srv/repos-evil/app", "/srv/repos"));
  assertFalse(isContainedIn("/srv/reposx", "/srv/repos"));
  // "/" is never a root: it would mean the whole disk.
  assertFalse(isContainedIn("/srv/repos", "/"));
});

test("a local repoRef is an absolute, normalized path and nothing else", () => {
  assert(isLocalRepoRef("/Users/ada/code/app"));
  assertFalse(isLocalRepoRef("code/app"));
  assertFalse(isLocalRepoRef("/"));
  assertFalse(isLocalRepoRef("/Users/ada/code/app/"));
  assertFalse(isLocalRepoRef("/Users/ada/../root"));
  assertFalse(isLocalRepoRef("/Users/ada/./app"));
  assertFalse(isLocalRepoRef("/Users//ada"));
  assertFalse(isLocalRepoRef("/Users/ada\nfoo"));
  assertFalse(isLocalRepoRef("/Users/ada\0foo"));
  assertFalse(isLocalRepoRef("/Users/ada\x7f"));
  // Edge whitespace is refused, not trimmed: `/srv/app ` is a directory of its own.
  assertFalse(isLocalRepoRef("/Users/ada/app "));
  assertFalse(isLocalRepoRef("/Users/ada/app\u00a0"));
  assert(isLocalRepoRef("/Users/ada/my app"));
});

test("the wire never trims a local repoRef into another path, and still trims a forge's", () => {
  const grant = {
    connectedRepoId: "cr_aaaaaaaaaaaaaaaaaaaa",
    url: "/srv/root/proj",
    ref: "main",
    branchNamespace: "ryph/a/r-1",
    provider: "local",
    repoRef: "/srv/root/proj ",
    tenantId: null,
  };
  // Trimmed, this would have named /srv/root/proj — a different directory.
  assertFalse(RunGrantRepoSchema.safeParse(grant).success);
  const exact = RunGrantRepoSchema.safeParse({ ...grant, repoRef: "/srv/root/proj" });
  assert(exact.success);
  assertEquals(exact.data.repoRef, "/srv/root/proj");
  const github = RunGrantRepoSchema.safeParse({
    ...grant,
    provider: "github",
    repoRef: " acme/app ",
    url: "https://github.com/acme/app",
    tenantId: "42",
  });
  assert(github.success);
  assertEquals(github.data.repoRef, "acme/app");
});

test("the wire: a local repo has no tenant, and its change request is a branch", () => {
  const base = {
    bundleKey: "r-1/abc.bundle",
    branchName: "ryph/ada/r-1",
    headSha: "a".repeat(40),
    repoUrl: "/Users/ada/app",
    baseBranch: "main",
    title: "t",
    body: "",
  };
  const local = { provider: "local", repoRef: "/Users/ada/app", tenantId: null };
  assert(SubmitRequestSchema.safeParse({ ...base, repo: local }).success);
  assert(
    SubmitRequestSchema.safeParse({ ...base, repo: local, changeRequest: "ryph/ada/r-1" }).success,
  );
  assertFalse(
    SubmitRequestSchema.safeParse({ ...base, repo: { ...local, tenantId: "42" } }).success,
  );
  assertFalse(
    SubmitRequestSchema.safeParse({ ...base, repo: { ...local, repoRef: "Users/ada" } }).success,
  );
  assertFalse(
    SubmitRequestSchema.safeParse({ ...base, repo: local, changeRequest: "a..b" }).success,
  );
  // Elsewhere a change request is still a thread reference, slash-free.
  const github = { provider: "github", repoRef: "acme/app", tenantId: "42" };
  assertFalse(
    SubmitRequestSchema.safeParse({ ...base, repo: github, changeRequest: "ryph/x" }).success,
  );
  assert(SubmitRequestSchema.safeParse({ ...base, repo: github, changeRequest: "7" }).success);
});

test("describe: a repository under the root, by its real path and its HEAD branch", async () => {
  const w = await world();
  try {
    await git(w.repo, "checkout", "--quiet", "-b", "develop");
    assertEquals(await describe(w.repo, w.root), {
      ok: true,
      repo: { path: w.repo, defaultBranch: "develop" },
    });
    // A symlink INSIDE the root to a repository inside the root resolves to that repository.
    await symlink(w.repo, `${w.root}/alias`);
    const aliased = await describe(`${w.root}/alias`, w.root);
    assert(aliased.ok);
    assertEquals(aliased.repo.path, w.repo);
    // A root given through a symlink is resolved too.
    await symlink(w.root, `${w.tmp}/root-link`);
    assert((await describe(w.repo, `${w.tmp}/root-link`)).ok);
  } finally {
    await w.cleanup();
  }
});

test("describe refuses every path that is not a plain repository under the root", async () => {
  const w = await world();
  try {
    // Not absolute.
    assertEquals(await refusal("root/repo", w.root), "not_absolute");
    assertEquals(await refusal("", w.root), "not_absolute");
    assertEquals(await refusal("~/repo", w.root), "not_absolute");

    // A symlink inside the root that leads out of it.
    await makeUpstream(`${w.tmp}/outside/repo`);
    await symlink(`${w.tmp}/outside/repo`, `${w.root}/escape`);
    assertEquals(await refusal(`${w.root}/escape`, w.root), "outside_root");
    // `..` back out, spelled textually inside the root: not a canonical path, refused as such.
    assertEquals(await refusal(`${w.root}/../outside/repo`, w.root), "not_absolute");
    // The prefix trick: `<tmp>/root-evil` starts with `<tmp>/root`.
    await makeUpstream(`${w.tmp}/root-evil`);
    assertEquals(await refusal(`${w.tmp}/root-evil`, w.root), "outside_root");
    // A root that does not exist holds nothing.
    assertEquals(await refusal(w.repo, `${w.tmp}/nowhere`), "outside_root");

    assertEquals(await refusal(`${w.root}/missing`, w.root), "not_found");
    await writeFile(`${w.root}/file.txt`, "x");
    assertEquals(await refusal(`${w.root}/file.txt`, w.root), "not_directory");
    await mkdir(`${w.root}/plain`);
    assertEquals(await refusal(`${w.root}/plain`, w.root), "not_a_repository");
    // A subdirectory of a repository is not its root, even though git would walk up to it.
    await mkdir(`${w.repo}/sub`);
    assertEquals(await refusal(`${w.repo}/sub`, w.root), "not_a_repository");

    // A linked worktree: `.git` is a file pointing into the main repository.
    await git(w.repo, "worktree", "add", "--quiet", "-b", "wt", `${w.root}/wt`);
    assertEquals(await refusal(`${w.root}/wt`, w.root), "linked_worktree");
    // A submodule checkout's `.git` file, by hand.
    await mkdir(`${w.root}/submodule`);
    await writeFile(`${w.root}/submodule/.git`, "gitdir: ../repo/.git/modules/x\n");
    assertEquals(await refusal(`${w.root}/submodule`, w.root), "linked_worktree");
    // A `.git` that is a symlink could point anywhere at all.
    await mkdir(`${w.root}/linked-git`);
    await symlink(`${w.tmp}/outside/repo/.git`, `${w.root}/linked-git/.git`);
    assertEquals(await refusal(`${w.root}/linked-git`, w.root), "not_a_repository");

    // Bare, either way it can be: a bare layout, or a `.git` directory configured bare.
    await git(w.root, "init", "--quiet", "--bare", `${w.root}/bare.git`);
    assertEquals(await refusal(`${w.root}/bare.git`, w.root), "bare_repository");
    await makeUpstream(`${w.root}/configured-bare`);
    await git(`${w.root}/configured-bare`, "config", "core.bare", "true");
    assertEquals(await refusal(`${w.root}/configured-bare`, w.root), "bare_repository");

    // No branch to start from: an unborn HEAD, and a detached one.
    await mkdir(`${w.root}/unborn`);
    await git(`${w.root}/unborn`, "init", "--quiet", "-b", "main");
    assertEquals(await refusal(`${w.root}/unborn`, w.root), "no_default_branch");
    await makeUpstream(`${w.root}/detached`);
    await git(`${w.root}/detached`, "checkout", "--quiet", "--detach");
    assertEquals(await refusal(`${w.root}/detached`, w.root), "no_default_branch");
  } finally {
    await w.cleanup();
  }
});

test("re-check: a connected path swapped for a symlink is refused, wherever it now leads", async () => {
  const w = await world();
  try {
    assert(recheckLocalRepo(w.repo, w.root).ok);
    const api = localForgeApi({ root: w.root });
    const repo = { repoRef: w.repo, tenantId: null };
    assertEquals(api.upstreamUrl(repo, w.repo), w.repo);

    // The repository moves aside, and a symlink to a repository OUTSIDE the root takes its place.
    await makeUpstream(`${w.tmp}/outside/secret`);
    await rename(w.repo, `${w.root}/moved`);
    await symlink(`${w.tmp}/outside/secret`, w.repo);
    const err = assertThrows(() => api.upstreamUrl(repo, w.repo), ForgeApiError);
    assert(err.terminal);
    assertEquals(recheckLocalRepo(w.repo, w.root).ok, false);

    // A symlink to another repository INSIDE the root is still not the one that was connected.
    await rm(w.repo);
    await symlink(`${w.root}/moved`, w.repo);
    // The error travels to callers that hand it to a run: it says what, never where.
    const moved = assertThrows(
      () => api.upstreamUrl(repo, w.repo),
      ForgeApiError,
      "no longer where it was connected",
    );
    assertFalse(moved.message.includes(w.tmp), moved.message);

    // A parent directory swapped is the same as the leaf.
    await rm(w.repo);
    await rename(`${w.root}/moved`, w.repo);
    assert(recheckLocalRepo(w.repo, w.root).ok);
    await rename(w.root, `${w.tmp}/real-root`);
    await mkdir(w.root);
    await symlink(`${w.tmp}/real-root/repo`, `${w.root}/repo`);
    assertThrows(() => api.upstreamUrl(repo, w.repo), ForgeApiError);
  } finally {
    await w.cleanup();
  }
});

test("the local ForgeApi: allowed, private, and terminal for everything a forge would hold", async () => {
  const api = localForgeApi({ root: "/nowhere" });
  const repo = { repoRef: "/nowhere/app", tenantId: null };
  assertEquals(await api.checkPermission(repo, null, "write"), "allowed");
  assertEquals(await api.checkPermission(repo, "ada", "admin"), "allowed");
  assertEquals(await api.fetchAuth(repo, "/nowhere/app"), null);
  assertEquals(
    await api.repoVisibility(null, ["/nowhere/app"]),
    new Map([["/nowhere/app", wholeRepoVisibility(true)]]),
  );
  assertEquals((await api.readChecks(repo, "a".repeat(40))).kind, "unavailable");
  assertEquals(
    (await api.reportChecks(repo, {
      headSha: "a".repeat(40),
      suiteId: "s",
      generation: 1,
      detailsUrl: null,
      suite: { state: "passed", conclusion: "success", summary: "" },
      checks: [],
    })).kind,
    "unsupported",
  );
  for (
    const call of [
      () => api.postComment(repo, { kind: "issue", ref: "1" }, "hi"),
      () => api.fetchThread(repo, { kind: "issue", ref: "1" }),
      () => api.describeChangeRequest(repo, "1"),
      () => api.readChangeRequestState(repo, "1"),
      () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
      () => api.listIssues(repo, { state: "open", labels: [], page: 1 }),
    ]
  ) {
    const err = await assertRejects(call, ForgeApiError, "not supported here");
    assert(err.terminal, "a refusal no retry can change is terminal");
  }
});

/** The service surface over a local root, or with the local provider off. */
async function service(tmp: string, localRoot: string | null) {
  const diag = silentDiagnostics();
  const stagingDir = `${tmp}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${tmp}/cache`, diag });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache,
    patches: localFsPatchStore(`${tmp}/patches`, diag),
    diag,
    forges: providerRegistry(
      { local: localRoot === null ? null : localForgeApi({ root: localRoot }) },
      "forge API",
    ),
    transports: providerRegistry(
      {
        local: localRoot === null ? null : localChangeTransport({ root: localRoot, cache, diag }),
      },
      "change transport",
    ),
    localRoot,
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  return makeHandler(deps);
}

const call = (
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body: unknown,
  token: string | null = SERVICE_TOKEN,
) =>
  handler(
    new Request(`http://forge${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

test("the describe route: authenticated, 200 with the real path, 422 with a reason, 501 when off", async () => {
  const w = await world();
  try {
    const handler = await service(w.tmp, w.root);
    const route = "/v1/service/local/describe";

    assertEquals((await call(handler, "POST", route, { path: w.repo }, null)).status, 401);
    assertEquals((await call(handler, "POST", route, { path: w.repo }, "wrong")).status, 401);

    const ok = await call(handler, "POST", route, { path: w.repo });
    assertEquals(ok.status, 200);
    assertEquals(await ok.json(), { repoRef: w.repo, url: w.repo, defaultBranch: "main" });

    const outside = await call(handler, "POST", route, { path: `${w.tmp}/outside` });
    assertEquals(outside.status, 422);
    const body = await outside.json();
    assertEquals(body.reason, "outside_root");
    assert(typeof body.error === "string" && body.error.length > 0);

    assertEquals((await call(handler, "POST", route, { nope: 1 })).status, 400);

    const providers = await call(handler, "GET", "/v1/service/providers", undefined);
    assertEquals(await providers.json(), {
      providers: ["local"],
      github: null,
      gitlab: null,
      radicle: null,
    });

    const off = await service(w.tmp, null);
    assertEquals((await call(off, "POST", route, { path: w.repo })).status, 501);
    assertEquals((await call(off, "POST", route, { path: w.repo }, null)).status, 401);
    const none = await call(off, "GET", "/v1/service/providers", undefined);
    assertEquals(await none.json(), { providers: [], github: null, gitlab: null, radicle: null });
  } finally {
    await w.cleanup();
  }
});

test("describe answers outside_root for a path outside the root before asking the disk", async () => {
  const w = await world();
  try {
    // One that exists and one that does not: the same answer, so the route reveals nothing
    // about the disk outside the root.
    const there = await describe(`${w.tmp}/outside`, w.root);
    const missing = await describe(`${w.tmp}/outside/nothing-here`, w.root);
    assertFalse(there.ok);
    assertFalse(missing.ok);
    assertEquals(there.reason, "outside_root");
    assertEquals(missing.reason, "outside_root");
    assertEquals(there.root, w.root);
    assertEquals(missing.root, w.root);
    // Spelled with `..` from inside the root: refused before the disk is asked.
    const dotted = await describe(`${w.root}/../outside/nothing-here`, w.root);
    assertFalse(dotted.ok);
    assertEquals(dotted.reason, "not_absolute");
    // Inside the root, a missing path is `not_found`; and a symlink inside the root that leads
    // out of it is still `outside_root`, after realPath — whether or not what it leads to exists.
    assertEquals(await refusal(`${w.root}/nothing-here`, w.root), "not_found");
    await symlink(`${w.tmp}/outside`, `${w.root}/out`);
    assertEquals(await refusal(`${w.root}/out/nothing-here`, w.root), "outside_root");
    assertEquals(await refusal(`${w.root}/out`, w.root), "outside_root");
    // The root given through a symlink: `root` is its real path.
    await symlink(w.root, `${w.tmp}/root-link`);
    const viaLink = await describe(`${w.tmp}/outside`, `${w.tmp}/root-link`);
    assertFalse(viaLink.ok);
    assertEquals(viaLink.root, w.root);
  } finally {
    await w.cleanup();
  }
});

test("describe refuses a real path the wire could not carry back", async () => {
  const w = await world();
  try {
    await makeUpstream(`${w.root}/proj `);
    const out = await describe(`${w.root}/proj `, w.root);
    assertFalse(out.ok);
    assertEquals(out.reason, "not_a_repository");
    assertStringIncludes(out.message, "edge whitespace");
    await makeUpstream(`${w.root}/tab\there`);
    assertEquals(await refusal(`${w.root}/tab\there`, w.root), "not_a_repository");
  } finally {
    await w.cleanup();
  }
});

test("a .git whose store is not its own is refused at connect AND on every use", async () => {
  const w = await world();
  try {
    const lender = `${w.tmp}/outside/lender`;
    await makeUpstream(lender, "lender");
    /** A fresh repository under the root, `arrange`d, then asked both ways. */
    const refusedBothWays = async (name: string, arrange: (repo: string) => Promise<void>) => {
      const repo = `${w.root}/${name}`;
      await makeUpstream(repo);
      assert((await describe(repo, w.root)).ok, `${name} is fine before it is arranged`);
      await arrange(repo);
      const described = await describe(repo, w.root);
      assertFalse(described.ok, `${name}: describe`);
      assertEquals(described.reason, "not_a_repository", `${name}: ${described.message}`);
      const rechecked = recheckLocalRepo(repo, w.root);
      assertFalse(rechecked.ok, `${name}: re-check`);
      assertEquals(rechecked.reason, "not_a_repository");
      assertFalse(rechecked.summary.includes(w.tmp), rechecked.summary);
    };

    await refusedBothWays(
      "commondir",
      (r) => writeFile(`${r}/.git/commondir`, `${lender}/.git\n`),
    );
    await refusedBothWays(
      "gitdir",
      (r) => writeFile(`${r}/.git/gitdir`, `${lender}/.git\n`),
    );
    const swap = async (r: string, entry: string) => {
      await rename(`${r}/.git/${entry}`, `${r}/.git/${entry}.real`);
      await symlink(`${lender}/.git/${entry}`, `${r}/.git/${entry}`);
    };
    await refusedBothWays("objects-link", (r) => swap(r, "objects"));
    await refusedBothWays("refs-link", (r) => swap(r, "refs"));
    await refusedBothWays("head-link", (r) => swap(r, "HEAD"));
    await refusedBothWays("pack-link", (r) => swap(r, "objects/pack"));
    await refusedBothWays("heads-link", (r) => swap(r, "refs/heads"));
    await refusedBothWays(
      "alternates",
      (r) => writeFile(`${r}/.git/objects/info/alternates`, `${lender}/.git/objects\n`),
    );
    await refusedBothWays(
      "http-alternates",
      (r) => writeFile(`${r}/.git/objects/info/http-alternates`, "https://example.com/x\n"),
    );

    // An EMPTY alternates file lends nothing, and is what removing the lines leaves.
    const emptied = `${w.root}/emptied`;
    await makeUpstream(emptied);
    await writeFile(`${emptied}/.git/objects/info/alternates`, "");
    assert((await describe(emptied, w.root)).ok);
    assert(recheckLocalRepo(emptied, w.root).ok);
  } finally {
    await w.cleanup();
  }
});

test("a symlink at ANY depth of the store is refused at connect and on every use — a loose object, a branch file, a reflog directory", async () => {
  const w = await world();
  try {
    // Another repository outside the root, its objects loose and its branch a plain file: what
    // a symlink one level deeper than a fan-out directory would otherwise serve as this repo's.
    const other = `${w.tmp}/outside/other`;
    await makeUpstream(other, "SECRET OUTSIDE");
    const api = localForgeApi({ root: w.root });

    const refusedBothWays = async (name: string, arrange: (repo: string) => Promise<void>) => {
      const repo = `${w.root}/${name}`;
      await makeUpstream(repo, name);
      assert((await describe(repo, w.root)).ok, `${name} is fine before it is arranged`);
      await arrange(repo);
      const described = await describe(repo, w.root);
      assertFalse(described.ok, `${name}: describe`);
      assertEquals(described.reason, "not_a_repository", `${name}: ${described.message}`);
      const rechecked = recheckLocalRepo(repo, w.root);
      assertFalse(rechecked.ok, `${name}: re-check`);
      assertFalse(rechecked.summary.includes(w.tmp), rechecked.summary);
      // The gateway's fetch asks the adapter first, which is the same re-check.
      assertThrows(() => api.upstreamUrl({ repoRef: repo, tenantId: null }, repo), ForgeApiError);
    };

    await refusedBothWays("loose-objects", async (repo) => {
      for (const fan of readdirSync(`${other}/.git/objects`, { withFileTypes: true })) {
        if (!/^[0-9a-f]{2}$/.test(fan.name)) continue;
        await mkdir(`${repo}/.git/objects/${fan.name}`, { recursive: true });
        for (
          const obj of readdirSync(`${other}/.git/objects/${fan.name}`, { withFileTypes: true })
        ) {
          const at = `${repo}/.git/objects/${fan.name}/${obj.name}`;
          await rm(at).catch(() => {});
          await symlink(`${other}/.git/objects/${fan.name}/${obj.name}`, at);
        }
      }
    });
    await refusedBothWays("branch-file", async (repo) => {
      await rm(`${repo}/.git/refs/heads/main`);
      await symlink(`${other}/.git/refs/heads/main`, `${repo}/.git/refs/heads/main`);
    });
    await refusedBothWays("logs-refs", async (repo) => {
      await mkdir(`${w.tmp}/outside/logs-refs`);
      await rm(`${repo}/.git/logs/refs`, { recursive: true });
      await symlink(`${w.tmp}/outside/logs-refs`, `${repo}/.git/logs/refs`);
    });
    await refusedBothWays("reftable-entry", async (repo) => {
      await mkdir(`${repo}/.git/reftable`);
      await writeFile(`${w.tmp}/outside/table`, "");
      await symlink(`${w.tmp}/outside/table`, `${repo}/.git/reftable/tables.list`);
    });

    // A store with plenty of real nesting and no link is still a repository.
    const deep = `${w.root}/deep`;
    await makeUpstream(deep);
    await git(deep, "branch", "ryph/ada/r-1");
    assert((await describe(deep, w.root)).ok);
    assert(recheckLocalRepo(deep, w.root).ok);
  } finally {
    await w.cleanup();
  }
});

test("the ref write's path is plain from .git down: a symlinked logs/refs is caught at the push", async () => {
  const w = await world();
  try {
    assert(refPathIsPlain(w.repo, "ryph/ada/r-1"));
    // Above `logs/refs/heads`, where a look that starts at `heads` cannot see it: lstat of
    // `logs/refs/heads/ryph` follows the linked parent and answers "a real directory".
    await mkdir(`${w.tmp}/outside/heads/ryph`, { recursive: true });
    await rm(`${w.repo}/.git/logs/refs`, { recursive: true });
    await symlink(`${w.tmp}/outside`, `${w.repo}/.git/logs/refs`);
    assertFalse(refPathIsPlain(w.repo, "ryph/ada/r-1"));
    await rm(`${w.repo}/.git/logs/refs`);
    await mkdir(`${w.repo}/.git/logs/refs/heads`, { recursive: true });
    assert(refPathIsPlain(w.repo, "ryph/ada/r-1"));
    // And the loose ref's side, one level up from where the branch is written.
    await rename(`${w.repo}/.git/refs/heads`, `${w.tmp}/outside/real-heads`);
    await symlink(`${w.tmp}/outside/real-heads`, `${w.repo}/.git/refs/heads`);
    assertFalse(refPathIsPlain(w.repo, "ryph/ada/r-1"));
  } finally {
    await w.cleanup();
  }
});

test("describe is no oracle for files outside the root, through a link inside it", async () => {
  const w = await world();
  try {
    // A symlink inside the root that leads to `/`: whether a file out there exists must not be
    // readable off which refusal comes back.
    await symlink("/", `${w.root}/up`);
    assertEquals(await refusal(`${w.root}/up/etc/passwd`, w.root), "outside_root");
    assertEquals(await refusal(`${w.root}/up/etc/definitely-not-here`, w.root), "outside_root");
    assertEquals(await refusal(`${w.root}/up/no-such-dir/x`, w.root), "outside_root");
    // A link that dangles: followed by its text, to where it would lead.
    await symlink(`${w.tmp}/outside/not-yet`, `${w.root}/dangling-out`);
    assertEquals(await refusal(`${w.root}/dangling-out`, w.root), "outside_root");
    assertEquals(await refusal(`${w.root}/dangling-out/deeper`, w.root), "outside_root");
    await symlink("not-yet-here", `${w.root}/dangling-in`);
    assertEquals(await refusal(`${w.root}/dangling-in`, w.root), "not_found");
    // A loop is not followed forever, and is no answer about anywhere.
    await symlink(`${w.root}/loop-b`, `${w.root}/loop-a`);
    await symlink(`${w.root}/loop-a`, `${w.root}/loop-b`);
    assertEquals(await refusal(`${w.root}/loop-a/x`, w.root), "outside_root");
    // Inside, a missing path is still simply not there.
    assertEquals(await refusal(`${w.root}/repo/missing`, w.root), "not_found");
  } finally {
    await w.cleanup();
  }
});

test("the describe route: an outside_root refusal names the allowed root", async () => {
  const w = await world();
  try {
    const handler = await service(w.tmp, w.root);
    const res = await call(handler, "POST", "/v1/service/local/describe", {
      path: `${w.tmp}/outside`,
    });
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.reason, "outside_root");
    assertEquals(body.root, w.root);
    // Only on outside_root.
    const missing = await call(handler, "POST", "/v1/service/local/describe", {
      path: `${w.root}/missing`,
    });
    assertEquals(await missing.json().then((b) => [b.reason, "root" in b]), ["not_found", false]);
  } finally {
    await w.cleanup();
  }
});

test("regression F7: a non-canonical path is refused before the disk is asked — no `..` oracle after a symlink", async () => {
  const w = await world();
  try {
    await mkdir(`${w.root}/d`);
    await mkdir(`${w.tmp}/outside/etc`, { recursive: true });
    await writeFile(`${w.tmp}/outside/etc/hosts`, "x\n");
    await symlink(`${w.tmp}/outside/etc/sub`, `${w.root}/d/link`);
    await mkdir(`${w.tmp}/outside/etc/sub`);
    // `link/..` is the parent of where the link points (outside the root), not `d`: whether
    // `hosts` exists out there must not be readable off the answer.
    for (
      const path of [
        `${w.root}/d/link/../hosts`,
        `${w.root}/d/link/../no-such-file`,
        `${w.root}/./repo`,
        `${w.root}//repo`,
        `${w.repo}/`,
      ]
    ) {
      assertEquals(await refusal(path, w.root), "not_absolute", path);
    }
    // The canonical spelling still connects.
    assert((await describe(w.repo, w.root)).ok);
  } finally {
    await w.cleanup();
  }
});
