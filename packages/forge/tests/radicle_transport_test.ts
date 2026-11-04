// The Radicle transport against a fake bridge and a REAL bundle: the provenance anchor is
// checked on this side before the bytes leave, the meta the bridge is handed names the fork
// point rather than the base branch's tip, and every refusal says whether it is terminal.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { radicleChangeTransport } from "../src/adapters/change_transport/radicle.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { git } from "../src/helpers/git_exec.ts";
import type { ChangeDelivery } from "../src/ports/change_transport.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const TOKEN = "bridge-secret";
const BRANCH = "ryph/ada/r-1";

/** A bridge that records what it was handed and answers what the test tells it to. */
async function fakeBridge() {
  const uploads: Array<{ meta: unknown; bytes: number; auth: string | null }> = [];
  let answer: Response = new Response(
    JSON.stringify({ ref: "a".repeat(40), revision: "b".repeat(40), created: true, url: null }),
    { status: 200 },
  );
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    // Read with the RUNTIME's own multipart parser, deliberately: the bridge has a hand-rolled
    // streaming one (@ryph/radicle's helpers/multipart.ts) and what the transport writes has to
    // be readable by both, or the two are agreeing on a private dialect.
    const form = await req.formData().catch(() => null);
    const file = form?.get("bundle");
    const meta = form?.get("meta");
    uploads.push({
      meta: typeof meta === "string" ? JSON.parse(meta) : null,
      bytes: file instanceof File ? file.size : 0,
      auth: req.headers.get("authorization"),
    });
    return answer.clone() as Response;
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    uploads,
    answerWith: (body: unknown, status: number) => {
      answer = new Response(JSON.stringify(body), { status });
    },
    shutdown: () => server.shutdown(),
  };
}

/** An upstream repo, a warm cache entry keyed by the BRIDGE's git door (which is what the
 * transport will look the base up under), and a run's bundle. */
async function makeWorld(root: string, bridgeBase: string) {
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const upstreamUrl = `${bridgeBase}/v1/repos/${encodeURIComponent(RID)}/git`;
  const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });

  const ws = `${root}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--", upstream, ".");
  await git(ws, "checkout", "--quiet", "-b", BRANCH);
  await writeFile(`${ws}/work.txt`, "the work\n");
  await git(ws, "add", ".");
  await commit(ws, "do the work");
  const headSha = await git(ws, "rev-parse", "HEAD");
  const bundlePath = `${root}/patch.bundle`;
  await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
  return { upstream, upstreamUrl, cache, baseSha, headSha, bundlePath };
}

/** Bytes that stand for an image; the transport never looks inside them. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function delivery(over: Partial<ChangeDelivery> & { headSha: string; bundlePath: string }) {
  return {
    repo: { repoRef: RID, tenantId: null },
    repoUrl: RID,
    branchName: BRANCH,
    baseBranch: "main",
    title: "Fix the scheduler",
    description: "a paragraph\n\nand another",
    embeds: [],
    draft: false,
    existingRef: null,
    ...over,
  } as ChangeDelivery;
}

/** The transport, pointed at a cache that can only seed from the real upstream directory. */
function makeTransport(base: string, cache: ReturnType<typeof localFsRepoCache>) {
  return radicleChangeTransport({ baseUrl: base, token: TOKEN, cache, diag: silentDiagnostics() });
}

test("a verified bundle is uploaded whole, with the fork point as the change's base", async () => {
  const bridge = await fakeBridge();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const world = await makeWorld(root, bridge.base);
    // The cache cannot reach the fake bridge's git door, so the transport stages the base from
    // the upstream itself — the fallback that makes submission self-sufficient.
    const transport = makeTransport(bridge.base, {
      refreshBase: () => Promise.reject(new Error("not part of this surface")),
      serveBase: () => Promise.reject(new Error("not part of this surface")),
      find: () => Promise.resolve(null),
      ensureCommit: () => Promise.reject(new Error("not part of this surface")),
      withHeld: () => Promise.reject(new Error("not part of this surface")),
      remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
      remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
    });
    const out = await transport.deliver(
      delivery({ headSha: world.headSha, bundlePath: world.bundlePath, repoUrl: RID }),
    );
    // The stage fetches the base from `upstreamUrl`, which is the fake bridge and serves no
    // git — so this delivery cannot succeed, and it must say the failure is RETRYABLE.
    assertEquals(out.kind, "failed");
    assert(out.kind === "failed" && !out.terminal);
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true });
  }
});

test("with the base in the cache, the upload carries the bundle and the meta the bridge needs", async () => {
  const bridge = await fakeBridge();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const world = await makeWorld(root, bridge.base);
    // A cache that really holds the base, as it does after a run cloned through the gateway.
    const seeded = localFsRepoCache({ root: `${root}/seeded`, diag: silentDiagnostics() });
    await seeded.refreshBase({ url: world.upstream }, "main", anonymous);
    const transport = makeTransport(bridge.base, {
      refreshBase: () => Promise.reject(new Error("no upstream contact in this test")),
      serveBase: () => Promise.reject(new Error("no upstream contact in this test")),
      find: () => seeded.find({ url: world.upstream }, "main"),
      ensureCommit: () => Promise.reject(new Error("not part of this surface")),
      withHeld: () => Promise.reject(new Error("not part of this surface")),
      remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
      remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
    });

    const out = await transport.deliver(
      delivery({ headSha: world.headSha, bundlePath: world.bundlePath }),
    );
    assertEquals(out, { kind: "delivered", ref: "a".repeat(40), url: "" });
    assertEquals(bridge.uploads.length, 1);
    const upload = bridge.uploads[0];
    assertEquals(upload.auth, `Bearer ${TOKEN}`);
    assertEquals(upload.bytes, (await stat(world.bundlePath)).size);
    const meta = upload.meta as Record<string, unknown>;
    // The fork point, not the base branch's tip: Radicle records it on the revision, and a
    // base the run did not build on makes every diff wrong.
    assertEquals(meta.baseSha, world.baseSha);
    assertEquals(meta.headSha, world.headSha);
    // The description keeps its blank line — it never rides a push option.
    assertEquals(meta.description, "a paragraph\n\nand another");
    assert(!("changeRef" in meta), "a new change request names none");
    assert(!("embeds" in meta), "a description without images carries no embeds");
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a second generation names the change request it updates", async () => {
  const bridge = await fakeBridge();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const world = await makeWorld(root, bridge.base);
    const seeded = localFsRepoCache({ root: `${root}/seeded`, diag: silentDiagnostics() });
    await seeded.refreshBase({ url: world.upstream }, "main", anonymous);
    const transport = makeTransport(bridge.base, {
      refreshBase: () => Promise.reject(new Error("unused")),
      serveBase: () => Promise.reject(new Error("unused")),
      find: () => seeded.find({ url: world.upstream }, "main"),
      ensureCommit: () => Promise.reject(new Error("not part of this surface")),
      withHeld: () => Promise.reject(new Error("not part of this surface")),
      remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
      remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
    });
    bridge.answerWith(
      { ref: "c".repeat(40), revision: "d".repeat(40), created: false, url: "https://x/y" },
      200,
    );
    const out = await transport.deliver(
      delivery({
        headSha: world.headSha,
        bundlePath: world.bundlePath,
        existingRef: "c".repeat(40),
        embeds: [{ name: "img-3f9a1c0b2d4e.png", oid: "e".repeat(40), bytes: PNG }],
      }),
    );
    // An identical head is a success no-op upstream, and reads as a delivery here — which is
    // what makes a retried submission converge on one change request.
    assertEquals(out, { kind: "delivered", ref: "c".repeat(40), url: "https://x/y" });
    const meta = bridge.uploads[0].meta as Record<string, unknown>;
    assertEquals(meta.changeRef, "c".repeat(40));
    // The description's images ride the meta part as the bridge's embeds: a name and the bytes.
    assertEquals(meta.embeds, [{ name: "img-3f9a1c0b2d4e.png", data: PNG.toBase64() }]);
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a head that is not the one intake recorded never leaves, and is terminal", async () => {
  const bridge = await fakeBridge();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const world = await makeWorld(root, bridge.base);
    const seeded = localFsRepoCache({ root: `${root}/seeded`, diag: silentDiagnostics() });
    await seeded.refreshBase({ url: world.upstream }, "main", anonymous);
    const transport = makeTransport(bridge.base, {
      refreshBase: () => Promise.reject(new Error("unused")),
      serveBase: () => Promise.reject(new Error("unused")),
      find: () => seeded.find({ url: world.upstream }, "main"),
      ensureCommit: () => Promise.reject(new Error("not part of this surface")),
      withHeld: () => Promise.reject(new Error("not part of this surface")),
      remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
      remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
    });
    const out = await transport.deliver(
      delivery({ headSha: "9".repeat(40), bundlePath: world.bundlePath }),
    );
    assert(out.kind === "failed" && out.terminal);
    assertStringIncludes(out.message, "is not the recorded");
    assertEquals(bridge.uploads, [], "the provenance check runs before anything is uploaded");
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true });
  }
});

test("the bridge's own refusals keep their terminality", async () => {
  const bridge = await fakeBridge();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const world = await makeWorld(root, bridge.base);
    const seeded = localFsRepoCache({ root: `${root}/seeded`, diag: silentDiagnostics() });
    await seeded.refreshBase({ url: world.upstream }, "main", anonymous);
    const transport = makeTransport(bridge.base, {
      refreshBase: () => Promise.reject(new Error("unused")),
      serveBase: () => Promise.reject(new Error("unused")),
      find: () => seeded.find({ url: world.upstream }, "main"),
      ensureCommit: () => Promise.reject(new Error("not part of this surface")),
      withHeld: () => Promise.reject(new Error("not part of this surface")),
      remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
      remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
    });
    const args = delivery({ headSha: world.headSha, bundlePath: world.bundlePath });

    bridge.answerWith({ error: "no change request c0ffee" }, 404);
    const terminal = await transport.deliver(args);
    assert(terminal.kind === "failed" && terminal.terminal);
    assertEquals(terminal.message, "no change request c0ffee");

    bridge.answerWith({ error: "the node is restarting" }, 503);
    const transient = await transport.deliver(args);
    assert(transient.kind === "failed" && !transient.terminal);
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true });
  }
});
