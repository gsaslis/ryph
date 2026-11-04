// The org skills repo's read, through the pure handler against real git on temp dirs, and the
// binary-safe blob primitive under it. The properties worth pinning are the ones the control
// plane hashes and trusts: the bytes are the repo's exactly (a binary asset included), every path
// is one the listing returned at one pinned commit, the bounds are checked before content is
// read, and "the branch is gone" arrives as its own terminal answer rather than as an outage.

import { test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { catFileBatch, git, gitBounded } from "../src/helpers/git_exec.ts";
import {
  MAX_SKILLS_TREE_BYTES,
  MAX_SKILLS_TREE_ENTRIES,
  readSkillsTree,
} from "../src/helpers/skill_tree.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

const SKILL_MD = `---
name: deploy
description: Use when shipping.
---
# Deploy
`;

/** Only `upstreamUrl` and `fetchAuth` are reached by the read. */
function tokenOnlyForgeApi(): ForgeApi {
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
  } as unknown as ForgeApi;
}

async function build(root: string) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const never = () => Promise.reject(new Error("not part of this surface"));
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: tokenOnlyForgeApi() }, "forge API"),
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir },
  };
  return makeHandler(deps);
}

const ask = (
  handler: (req: Request) => Promise<Response>,
  url: string,
  opts: { commitOrRef?: string; knownTree?: string | null; token?: string | null } = {},
) => {
  const token = opts.token === undefined ? SERVICE_TOKEN : opts.token;
  return handler(
    new Request("http://forge/v1/service/skills-tree", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/skills", tenantId: "42" },
        url,
        commitOrRef: opts.commitOrRef ?? "main",
        knownTree: opts.knownTree ?? null,
      }),
    }),
  );
};

/** Writes `files` under the upstream's work tree and commits them; returns the new head. */
async function commitFiles(
  dir: string,
  files: Record<string, string | Uint8Array>,
  message: string,
) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(`${dir}/${path.split("/").slice(0, -1).join("/")}`, { recursive: true });
    if (typeof content === "string") await writeFile(`${dir}/${path}`, content);
    else await writeFile(`${dir}/${path}`, content);
  }
  await git(dir, "add", ".");
  await commit(dir, message);
  return await git(dir, "rev-parse", "HEAD");
}

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

/** Bytes no text decoding survives: a NUL, an invalid UTF-8 lead byte, a lone CR. */
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00]);

test("the tree comes back byte for byte, with modes, at the commit and tree it names", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "skills");
    const head = await commitFiles(upstream, {
      ".agents/skills/deploy/SKILL.md": SKILL_MD,
      ".agents/skills/deploy/assets/logo.png": BINARY,
      ".agents/skills/deploy/scripts/run.sh": "#!/bin/sh\necho hi  \n",
      ".agents/skills/README.md": "the skills\n",
      "src/app.ts": "outside the prefix\n",
    }, "skills");
    await chmod(`${upstream}/.agents/skills/deploy/scripts/run.sh`, 0o755);
    await git(upstream, "add", ".");
    await commit(upstream, "executable");
    const executable = await git(upstream, "rev-parse", "HEAD");
    assert(executable !== head);

    const res = await ask(handler, upstream);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.kind, "tree");
    assertEquals(body.commit, executable);
    assertEquals(body.tree, await git(upstream, "rev-parse", `${executable}:.agents/skills`));
    const byPath = new Map(
      body.files.map((f: { path: string; mode: string; content: string }) => [f.path, f]),
    );
    // Relative to the prefix, and nothing outside it.
    assertEquals([...byPath.keys()].sort(), [
      "README.md",
      "deploy/SKILL.md",
      "deploy/assets/logo.png",
      "deploy/scripts/run.sh",
    ]);
    const content = (path: string) =>
      Uint8Array.fromBase64((byPath.get(path) as { content: string }).content);
    assertEquals(content("deploy/assets/logo.png"), BINARY);
    // Untrimmed: trailing whitespace is part of the file.
    assertEquals(
      new TextDecoder().decode(content("deploy/scripts/run.sh")),
      "#!/bin/sh\necho hi  \n",
    );
    assertEquals((byPath.get("deploy/scripts/run.sh") as { mode: string }).mode, "100755");
    assertEquals((byPath.get("deploy/SKILL.md") as { mode: string }).mode, "100644");

    // A commit is read as pinned, whatever the branch says now.
    const pinned = await (await ask(handler, upstream, { commitOrRef: head })).json();
    assertEquals(pinned.commit, head);
    assertEquals(
      pinned.files.find((f: { path: string }) => f.path === "deploy/scripts/run.sh").mode,
      "100644",
    );
  });
});

test("the tree the caller already holds is unchanged, and nothing more is read", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "unchanged");
    await commitFiles(upstream, { ".agents/skills/deploy/SKILL.md": SKILL_MD }, "skills");
    const first = await (await ask(handler, upstream)).json();
    // A push elsewhere in the repo moves the commit but not the skills' tree.
    const head = await commitFiles(upstream, { "src/app.ts": "x\n" }, "unrelated");

    const again = await (await ask(handler, upstream, { knownTree: first.tree })).json();
    assertEquals(again, { kind: "unchanged", commit: head, tree: first.tree });
  });
});

test("a repo without .agents/skills answers absent, with the commit it looked at", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    const head = await makeUpstream(upstream, "absent");
    assertEquals(await (await ask(handler, upstream)).json(), { kind: "absent", commit: head });

    // A FILE where the directory should be is no directory either.
    const file = await commitFiles(upstream, { ".agents/skills": "not a directory\n" }, "file");
    assertEquals(await (await ask(handler, upstream)).json(), { kind: "absent", commit: file });
  });
});

test("a submodule at .agents/skills is invalid, saying so, and never an outage", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "vendored");
    // The superproject records only the submodule's commit id, which its object store lacks.
    await git(
      upstream,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"c".repeat(40)},.agents/skills`,
    );
    await commit(upstream, "vendor the skills");
    const head = await git(upstream, "rev-parse", "HEAD");

    const res = await ask(handler, upstream);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals([body.kind, body.commit], ["invalid", head]);
    assertStringIncludes(body.detail, "submodule");
  });
});

test("symlinks and submodules are listed with their mode and never read", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "links");
    await commitFiles(upstream, { ".agents/skills/deploy/SKILL.md": SKILL_MD }, "skills");
    await symlink("/etc/passwd", `${upstream}/.agents/skills/deploy/secret.md`);
    await git(upstream, "add", ".");
    await git(
      upstream,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"c".repeat(40)},.agents/skills/deploy/vendor`,
    );
    await commit(upstream, "links");

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "tree");
    const modes = Object.fromEntries(
      body.files.map((f: { path: string; mode: string; content: string | null }) => [
        f.path,
        [f.mode, f.content],
      ]),
    );
    assertEquals(modes["deploy/secret.md"], ["120000", null]);
    assertEquals(modes["deploy/vendor"], ["160000", null]);
  });
});

test("a tree over the entry or the byte bound is invalid before any content is read", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "bounds");
    const huge = await commitFiles(upstream, {
      ".agents/skills/big/SKILL.md": SKILL_MD,
      ".agents/skills/big/assets/blob.bin": new Uint8Array(MAX_SKILLS_TREE_BYTES),
    }, "too many bytes");
    const bytes = await (await ask(handler, upstream)).json();
    assertEquals([bytes.kind, bytes.commit], ["invalid", huge]);
    assertStringIncludes(bytes.detail, "bytes, over the limit");

    await git(upstream, "rm", "-r", "--quiet", ".agents/skills/big");
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_SKILLS_TREE_ENTRIES; i++) many[`.agents/skills/many/f${i}.md`] = "x";
    await commitFiles(upstream, many, "too many entries");
    const entries = await (await ask(handler, upstream)).json();
    assertEquals(entries.kind, "invalid");
    assertStringIncludes(entries.detail, `${MAX_SKILLS_TREE_ENTRIES + 1} entries`);
  });
});

test("the listing itself is bounded: git is stopped past it, and the tree is invalid", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "listing");
    const head = await commitFiles(upstream, {
      ".agents/skills/deploy/SKILL.md": SKILL_MD,
      ".agents/skills/deploy/references/a.md": "a\n",
    }, "skills");
    // The real executor, held to a ceiling this small listing passes.
    const read = await readSkillsTree({
      dir: upstream,
      commit: head,
      knownTree: null,
      git,
      gitBounded: (cwd, _max, ...args) => gitBounded(cwd, 64, ...args),
      catFile: catFileBatch,
    });
    assertEquals(read.kind, "invalid");
    assert(read.kind === "invalid");
    assertStringIncludes(read.detail, "listing is over");
    // Under the ceiling, the same executor answers the whole listing, untrimmed.
    const whole = await gitBounded(upstream, 1024 * 1024, "ls-tree", "-r", "-z", head);
    assert(whole !== null && whole.endsWith("\0"));
  });
});

test("a branch the upstream does not have is missing-ref, terminally", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "missing-ref");
    const res = await ask(handler, upstream, { commitOrRef: "gone" });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals([body.kind, body.terminal], ["missing-ref", true]);
  });
});

test("no upstream is unavailable; the read is authenticated; a tag is refused", async () => {
  await withRoot(async (root) => {
    const handler = await build(root);
    const gone = await ask(handler, `${root}/never-existed`);
    assertEquals([gone.status, (await gone.json()).kind], [502, "unavailable"]);

    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "auth");
    assertEquals((await ask(handler, upstream, { token: null })).status, 401);
    assertEquals((await ask(handler, upstream, { token: "wrong" })).status, 401);
    const tagged = await ask(handler, upstream, { commitOrRef: "refs/tags/v1" });
    assertEquals([tagged.status, (await tagged.json()).terminal], [400, true]);
    // A tree id that is not one is the request's problem, never a revision argument.
    assertEquals((await ask(handler, upstream, { knownTree: "--all" })).status, 400);
  });
});

test("catFileBatch: bytes as stored, many at once, and refused past its bound", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "batch");
    const files: Record<string, string | Uint8Array> = { "bin/a.bin": BINARY };
    // Enough ids that the pipes fill both ways: writing all before reading would hang.
    for (let i = 0; i < 3000; i++) files[`many/f${i}.txt`] = `${i}\n`.repeat(20);
    await commitFiles(upstream, files, "blobs");
    const listing = await git(upstream, "ls-tree", "-r", "HEAD");
    const ids = listing.split("\n").map((line) => line.split(/\s+/)[2]);

    const read = await catFileBatch(upstream, ids, 1024 * 1024);
    assertEquals(read.size, new Set(ids).size);
    const binId = await git(upstream, "rev-parse", "HEAD:bin/a.bin");
    assertEquals(read.get(binId), BINARY);

    await assertRejects(() => catFileBatch(upstream, ids, 1000), Error, "over the 1000-byte limit");
    await assertRejects(
      () => catFileBatch(upstream, ["d".repeat(40)], 1000),
      Error,
      "missing",
    );
    // A tree is not a blob.
    const tree = await git(upstream, "rev-parse", "HEAD:bin");
    await assertRejects(() => catFileBatch(upstream, [tree], 1000), Error, "is tree");
  });
});
