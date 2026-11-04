// The services-file read, through the pure handler against real git on temp dirs.
//
// The properties worth pinning are about AVAILABILITY, not about YAML: this read sits on the
// launch path, so what matters is that a warm cache answers when the upstream is gone, that it
// says so, and that "we could not ask" never arrives looking like "the repo declares nothing".

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { MAX_SERVICES_FILE_BYTES } from "../src/http/service.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { type Git, git, gitRaw } from "../src/helpers/git_exec.ts";
import { readRepoFile, resolveBranch } from "../src/helpers/repo_file.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

const DECLARATION = `services:
  db:
    uses: postgres@18
    port: 5433
`;

/** Only `upstreamUrl` and `fetchAuth` are reached by this route; the rest would be a lie to
 * implement. */
function tokenOnlyForgeApi(): ForgeApi {
  const never = () => Promise.reject(new Error("not part of this surface"));
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
    postComment: never,
    updateComment: never,
    addReaction: never,
    checkPermission: never,
  } as unknown as ForgeApi;
}

const never = () => Promise.reject(new Error("not part of this surface"));

async function build(root: string) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: tokenOnlyForgeApi() }, "forge API"),
    // The transport is never reached here — no bundle is submitted — but door ③ is mounted
    // whole or not at all, and this suite needs it mounted.
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir },
  };
  return { handler: makeHandler(deps), deps };
}

const ask = (
  handler: (req: Request) => Promise<Response>,
  url: string,
  ref = "main",
  token: string | null = SERVICE_TOKEN,
) =>
  handler(
    new Request("http://forge/v1/service/services-file", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
        url,
        ref,
      }),
    }),
  );

/** An upstream carrying a declaration at `.ryph/services.yml`. */
async function upstreamWithServices(dir: string, text = DECLARATION): Promise<void> {
  await makeUpstream(dir, "services");
  await mkdir(`${dir}/.ryph`, { recursive: true });
  await writeFile(`${dir}/.ryph/services.yml`, text);
  await git(dir, "add", ".");
  await commit(dir, "declare services");
}

test("the declaration is read out of the cache entry the clone is served from", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await upstreamWithServices(upstream);

    const res = await ask(handler, upstream);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.kind, "file");
    assertEquals(body.stale, false);
    assertStringIncludes(body.text, "uses: postgres@18");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a repo that declares nothing answers absent, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);

    assertEquals(await (await ask(handler, upstream)).json(), { kind: "absent" });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a warm cache answers with the upstream gone, and says the answer is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, deps } = await build(root);
    const upstream = `${root}/upstream`;
    await upstreamWithServices(upstream);
    // Warm the entry exactly as a previous run's clone would have.
    await deps.cache.refreshBase({ url: upstream }, "main", anonymous);

    // Now the upstream is unreachable — the fetch fails and the entry answers on its own.
    await rm(upstream, { recursive: true });

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "file");
    assertEquals(body.stale, true, "a declaration served without a refresh must say so");
    assertStringIncludes(body.text, "uses: postgres@18");
  } finally {
    await rm(root, { recursive: true });
  }
});

test('no cache and no upstream is "unavailable" — never "absent"', async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    // Launching a run on "absent" here would be the silent-no-database hang this prevents.
    const res = await ask(handler, `${root}/never-existed`);
    assertEquals(res.status, 502);
    assertEquals((await res.json()).kind, "unavailable");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a ref the cache was never fetched for is unavailable, not absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, deps } = await build(root);
    const upstream = `${root}/upstream`;
    await upstreamWithServices(upstream);
    await deps.cache.refreshBase({ url: upstream }, "main", anonymous);
    await rm(upstream, { recursive: true });

    // The entry exists, but holds only `main`: the stale fallback cannot answer for this ref.
    const res = await ask(handler, upstream, "release");
    assertEquals(res.status, 502);
    assertEquals((await res.json()).kind, "unavailable");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a declaration over the byte ceiling is invalid — read bounded, never truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    // Comment bytes: valid YAML, so only the ceiling can be what refuses it.
    await upstreamWithServices(upstream, `# ${"x".repeat(MAX_SERVICES_FILE_BYTES)}\n`);

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "invalid");
    assertStringIncludes(body.detail, "over the");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the .yaml spelling is read too, so it cannot silently declare nothing", async () => {
  // @ryph/runner accepts both spellings for setup.yml, so a repo will assume the same here.
  // Reading only .yml made a .yaml file invisible to the control plane and then blamed the
  // operator's switch when the runner refused the run — a trap with no signpost.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "yaml-spelling");
    await mkdir(`${upstream}/.ryph`, { recursive: true });
    await writeFile(`${upstream}/.ryph/services.yaml`, DECLARATION);
    await git(upstream, "add", ".");
    await commit(upstream, "declare services, the other spelling");

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "file");
    assertStringIncludes(body.text, "uses: postgres@18");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a directory where the file should be reads as absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "dir");
    await mkdir(`${upstream}/.ryph/services.yml`, { recursive: true });
    await writeFile(`${upstream}/.ryph/services.yml/oops.yml`, "services: {}\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a directory, not a file");

    assertEquals((await (await ask(handler, upstream)).json()).kind, "absent");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the read is service-authenticated, and a tag base is refused terminally", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    await upstreamWithServices(upstream);

    assertEquals((await ask(handler, upstream, "main", null)).status, 401);
    assertEquals((await ask(handler, upstream, "main", "wrong")).status, 401);

    const tagged = await ask(handler, upstream, "refs/tags/v1");
    assertEquals(tagged.status, 400);
    assertEquals((await tagged.json()).terminal, true);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the size check and the content read are one blob, however the branch moves between them", async () => {
  // The cache's fetch lock is released before the read, so a concurrent fetch can move the branch
  // at any point. Reading by branch name let a small file pass the size check and an enormous one
  // be decoded in its place; every read is pinned to the commit resolved up front instead.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const repo = `${root}/repo`;
    await upstreamWithServices(repo);
    const huge = `# ${"x".repeat(MAX_SERVICES_FILE_BYTES)}\n`;

    let moved = false;
    const racing: Git = async (cwd, ...args) => {
      const out = await gitRaw(cwd, ...args);
      if (args.includes("-s") && !moved) {
        moved = true;
        await writeFile(`${repo}/.ryph/services.yml`, huge);
        await git(repo, "add", ".");
        await commit(repo, "swap in something the size check never saw");
      }
      return out;
    };

    const read = await readRepoFile({
      dir: repo,
      commit: await resolveBranch(repo, "main", git),
      path: ".ryph/services.yml",
      maxBytes: MAX_SERVICES_FILE_BYTES,
      git: racing,
    });
    assertEquals(moved, true, "the branch must actually have moved mid-read");
    assertEquals(read, { kind: "file", text: DECLARATION });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the declaration arrives byte for byte, because in YAML the whitespace is data", async () => {
  // Through the executor every other git call uses, stdout was trimmed: the blank lines leading
  // this file and the trailing newlines its `|+` scalar keeps were edited away before the control
  // plane ever parsed it.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await build(root);
    const upstream = `${root}/upstream`;
    const text = "\n\nservices:\n  db:\n    uses: postgres@18\n    port: 5433\n" +
      "    env:\n      MOTD: |+\n        kept\n\n\n";
    await upstreamWithServices(upstream, text);

    const body = await (await ask(handler, upstream)).json();
    assertEquals(body.kind, "file");
    assertEquals(body.text, text);
  } finally {
    await rm(root, { recursive: true });
  }
});
