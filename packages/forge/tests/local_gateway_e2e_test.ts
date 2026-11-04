// A `local` repo end to end through the whole forge, against real git: connected by its path
// (the describe route), cloned through door ① by a client that never sees that path, the run's
// work back through door ② as a bundle, and the approved patch delivered by the submit route —
// the branch appearing in the repository on disk. Then the path is swapped for a symlink out of
// the root, and the gateway stops serving it.

import { test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { localForgeApi } from "../src/adapters/forge_api/local.ts";
import { localChangeTransport } from "../src/adapters/change_transport/local.ts";
import { providerRegistry } from "../src/ports/forge_api.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { git, makeGit } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const RUN_TOKEN = "virtual-key-run-a";
const SERVICE_TOKEN = "service-secret";
const REPO = "cr-local";
const NAMESPACE = "ryph/ada/r-a";
const BRANCH = `${NAMESPACE}/work`;

test("a local repo: connected, cloned through door ①, bundled through ②, delivered into its directory", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const root = `${tmp}/root`;
  const path = `${root}/app`;
  const baseSha = await makeUpstream(path);
  const diag = silentDiagnostics();
  const stagingDir = `${tmp}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${tmp}/cache`, diag });
  const patches = localFsPatchStore(`${tmp}/patches`, diag);

  // The row the control plane writes from the describe route's answer, as a grant member.
  const keys: KeyStore = {
    resolve: (token) =>
      Promise.resolve(
        token === RUN_TOKEN
          ? {
            runId: "r-a",
            repos: [{
              connectedRepoId: REPO,
              provider: "local" as const,
              repoRef: path,
              url: path,
              ref: "main",
              branchNamespace: NAMESPACE,
              tenantId: null,
            }],
          }
          : null,
      ),
  };
  const deps: AppDeps = {
    keys,
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
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, makeHandler(deps));
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const service = (route: string, body: unknown) =>
    fetch(`${origin}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    // ---- connect: the path as a person types it, answered with the row's values.
    const described = await service("/v1/service/local/describe", { path: `${root}/app` });
    assertEquals(await described.json(), { repoRef: path, url: path, defaultBranch: "main" });

    // ---- door ①: the run clones the gateway, never the path.
    const client = makeGit({ debug() {} }, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${RUN_TOKEN}`)}`,
    });
    const ws = `${tmp}/workspace`;
    await mkdir(ws);
    const cloneUrl = `${origin}/v1/git/r-a/${REPO}/repo.git`;
    await client(ws, "clone", "--quiet", "--", cloneUrl, ".");
    await client(ws, "checkout", "--quiet", "--end-of-options", "main");
    assertEquals(await git(ws, "rev-parse", "HEAD"), baseSha);
    assert(!(await readFile(`${ws}/.git/config`, "utf8")).includes(path));

    // ---- the run's work, and door ②.
    await git(ws, "checkout", "--quiet", "-b", BRANCH);
    await writeFile(`${ws}/work.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${tmp}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
    const intake = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: await readFile(bundlePath),
    });
    assertEquals(intake.status, 201);
    const { bundleKey } = await intake.json();

    // ---- approval: the submit route delivers into the directory.
    const submitted = await service("/v1/service/submit", {
      bundleKey,
      branchName: BRANCH,
      headSha,
      repo: { provider: "local", repoRef: path, tenantId: null },
      repoUrl: path,
      baseBranch: "main",
      title: "Do the work",
      body: "the report",
      runId: "r-a",
    });
    assertEquals(submitted.status, 201);
    assertEquals(await submitted.json(), { ref: BRANCH, url: null });
    assertEquals(await git(path, "rev-parse", `refs/heads/${BRANCH}`), headSha);
    assertEquals(await git(path, "symbolic-ref", "--short", "HEAD"), "main");

    // ---- the path swapped for a symlink out of the root: nothing is served from it.
    await makeUpstream(`${tmp}/outside`, "outside");
    await rename(path, `${root}/moved`);
    await symlink(`${tmp}/outside`, path);
    const ws2 = `${tmp}/workspace-2`;
    await mkdir(ws2);
    await assertRejects(() => client(ws2, "clone", "--quiet", "--", cloneUrl, "."));
  } finally {
    await server.shutdown();
    await rm(tmp, { recursive: true });
  }
});

/** A forge serving one `local` grant member at `path`, with the local provider on under `root`
 * or, with `root` null, off altogether — no adapter, no transport, no root. */
async function gateway(tmp: string, path: string, root: string | null) {
  const diag = silentDiagnostics();
  const stagingDir = `${tmp}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${tmp}/cache`, diag });
  const keys: KeyStore = {
    resolve: (token) =>
      Promise.resolve(
        token === RUN_TOKEN
          ? {
            runId: "r-a",
            repos: [{
              connectedRepoId: REPO,
              provider: "local" as const,
              repoRef: path,
              url: path,
              ref: "main",
              branchNamespace: NAMESPACE,
              tenantId: null,
            }],
          }
          : null,
      ),
  };
  const deps: AppDeps = {
    keys,
    cache,
    patches: localFsPatchStore(`${tmp}/patches`, diag),
    diag,
    forges: providerRegistry(
      { local: root === null ? null : localForgeApi({ root }) },
      "forge API",
    ),
    transports: providerRegistry(
      { local: root === null ? null : localChangeTransport({ root, cache, diag }) },
      "change transport",
    ),
    localRoot: root,
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, makeHandler(deps));
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const client = makeGit({ debug() {} }, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${RUN_TOKEN}`)}`,
  });
  return {
    origin,
    client,
    cloneUrl: `${origin}/v1/git/r-a/${REPO}/repo.git`,
    advertise: () =>
      fetch(`${origin}/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Basic ${btoa(`x-access-token:${RUN_TOKEN}`)}` },
      }),
    service: (route: string, body: unknown) =>
      fetch(`${origin}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    shutdown: () => server.shutdown(),
  };
}

test("a local grant on a forge with the local provider off is refused, never fetched from its path", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  // Under no root at all: the forge has none.
  const secret = `${tmp}/not-under-any-root/secret`;
  await makeUpstream(secret, "TOP SECRET");
  const g = await gateway(tmp, secret, null);
  try {
    const refused = await g.advertise();
    assertEquals(refused.status, 502);
    const text = await refused.text();
    assertFalse(text.includes(tmp), `the refusal names no host path: ${text}`);
    const ws = `${tmp}/ws`;
    await mkdir(ws);
    await assertRejects(() => g.client(ws, "clone", "--quiet", "--", g.cloneUrl, "."));
    assertFalse(await exists(`${ws}/README.md`));
    // Nothing was fetched into the cache from the path either.
    assertEquals(await dirEntries(`${tmp}/cache`), []);
  } finally {
    await g.shutdown();
    await rm(tmp, { recursive: true });
  }
});

test("a .git under the root whose commondir leads outside it is never connected, served or delivered into", async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const root = `${tmp}/root`;
  const outside = `${tmp}/outside/repo`;
  const baseSha = await makeUpstream(outside, "OUTSIDE THE ROOT");
  await git(outside, "checkout", "--quiet", "-b", "other");
  // A hand-made `.git` DIRECTORY inside the root: a HEAD, and a commondir naming the outside
  // repository's store — git then reads and writes that store as this one's.
  const path = `${root}/innocent`;
  await mkdir(`${path}/.git`, { recursive: true });
  await writeFile(`${path}/.git/HEAD`, "ref: refs/heads/main\n");
  await writeFile(`${path}/.git/commondir`, `${outside}/.git\n`);
  const g = await gateway(tmp, path, root);
  try {
    const described = await g.service("/v1/service/local/describe", { path });
    assertEquals(described.status, 422);
    assertEquals((await described.json()).reason, "not_a_repository");

    // A row connected before the rule existed (or the file planted after): door ① refuses it.
    const refused = await g.advertise();
    assertEquals(refused.status, 502);
    const text = await refused.text();
    assertFalse(text.includes(tmp), `the refusal names no host path: ${text}`);

    // And so does delivery, with a bundle built from the outside repository's own history.
    const ws = `${tmp}/ws`;
    await git(tmp, "clone", "--quiet", "--", outside, ws);
    await git(ws, "checkout", "--quiet", "-b", BRANCH, baseSha);
    await writeFile(`${ws}/w.txt`, "w\n");
    await git(ws, "add", ".");
    await commit(ws, "w");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${tmp}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
    const transport = localChangeTransport({
      root,
      cache: localFsRepoCache({ root: `${tmp}/cache2`, diag: silentDiagnostics() }),
      diag: silentDiagnostics(),
    });
    const outcome = await transport.deliver({
      repo: { repoRef: path, tenantId: null },
      repoUrl: path,
      bundlePath,
      branchName: BRANCH,
      baseBranch: "main",
      headSha,
      title: "t",
      description: "",
      embeds: [],
      draft: false,
      existingRef: null,
    });
    assertEquals(outcome.kind, "failed");
    assert(outcome.kind === "failed" && outcome.terminal);
    assertFalse(outcome.message.includes(tmp), `no host path: ${outcome.message}`);
    assertEquals(
      await git(outside, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`).catch(
        () => null,
      ),
      null,
    );
  } finally {
    await g.shutdown();
    await rm(tmp, { recursive: true });
  }
});

const exists = (path: string) => lstat(path).then(() => true, () => false);

async function dirEntries(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) out.push(entry.name);
  } catch {
    // No cache directory at all: nothing was fetched.
  }
  return out;
}
