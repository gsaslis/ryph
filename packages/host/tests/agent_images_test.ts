// An agent's images across the service seams, over real HTTP: the control plane's routes on one
// port, the forge's service surface on another, and the chat service in between — each with its
// own HTTP adapter and the token it presents in a deployment. Only the outside world is faked:
// GitHub (a recorded ForgeApi) and the chat platform (the chat suite's recording transport).
//
// What this proves that each package's own suite cannot: the shapes on both sides of every seam
// agree (the forge's strict schemas take what the orchestrator sends, the resolve and bytes
// routes answer what the forge's and chat's adapters parse), the tokens match, and a final
// summary naming an image the run does not hold still reaches the forge thread.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
// The control plane, its test doubles, and the forge and chat packages by path: these are the
// far ends of each wire, and the point is that they are the code that runs, not copies of it.
import { type Authenticate, makeHandler } from "../../orchestrator/src/http/app.ts";
import { memoryTaskStore } from "../../orchestrator/tests/memory_store.ts";
import { bootstrapEnv } from "../../orchestrator/tests/bootstrap_helpers.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "../../orchestrator/tests/doubles.ts";
import { noopForge } from "../../orchestrator/src/adapters/forge/noop.ts";
import { httpForge } from "../../orchestrator/src/adapters/forge/http.ts";
import { makeInboxSignal } from "../../orchestrator/src/core/inbox_signal.ts";
import { sweepProgressComments } from "../../orchestrator/src/core/reaper.ts";
import { DEFAULT_SERVICE_POLICY } from "../../orchestrator/src/core/services.ts";
import { inProcessRunImages } from "../../orchestrator/src/http/service_images.ts";
import type { AttachmentStore } from "../../orchestrator/src/ports/attachment_store.ts";
import { makeHandler as makeForgeHandler } from "../../forge/src/http/app.ts";
import { type ForgeApi, providerRegistry } from "../../forge/src/ports/forge_api.ts";
import type { GithubAppApi, GithubDelivery } from "../../forge/src/ports/github_app.ts";
import { githubChangeTransport } from "../../forge/src/adapters/change_transport/github.ts";
import { localFsRepoCache } from "../../forge/src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../../forge/src/adapters/patch_store/local_fs.ts";
import { httpRunImages as forgeRunImages } from "../../forge/src/adapters/run_images/http.ts";
import { httpRunImages as chatRunImages } from "../../chat/src/adapters/run_images/http.ts";
import { callTool } from "../../chat/src/mcp/tools.ts";
import { bindRun, makeApi, makeSlackRoom } from "../../chat/tests/api.ts";

const FORGE_TOKEN = "forge-service-token";
const CHAT_TOKEN = "chat-service-token";
const APP_URL = "http://app.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");

const MEMBER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;

async function refOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return "img-" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

function memoryBlobs(): AttachmentStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    put(key, bytes) {
      blobs.set(key, bytes.slice());
      return Promise.resolve();
    },
    get(key) {
      const bytes = blobs.get(key);
      return Promise.resolve(bytes === undefined ? null : new Response(bytes as BodyInit).body);
    },
    delete(key) {
      blobs.delete(key);
      return Promise.resolve();
    },
  };
}

/** The control plane, listening: the user, runner and service surfaces on one port. */
async function controlPlane() {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [{
      fullName: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      private: true,
    }],
  });
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(MEMBER)) as unknown as Authenticate,
    forgeToken: FORGE_TOKEN,
    chatToken: CHAT_TOKEN,
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    inbox: makeInboxSignal(),
    attachmentStore: memoryBlobs(),
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: APP_URL,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  };
  const handler = makeHandler(deps);
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  const url = `http://127.0.0.1:${server.addr.port}`;
  const call = (method: string, path: string, body: unknown, token = "t") =>
    handler(
      new Request(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  return { deps, store, launches, identities, clock, server, url, call, handler };
}

type ControlPlane = Awaited<ReturnType<typeof controlPlane>>;

/** A connected repo, an agent and a live run on them, with its runner token. */
async function liveRun(cp: ControlPlane) {
  cp.identities.link(MEMBER.userId, "noop-ada-lovelace");
  await (await cp.call("POST", "/v1/installations", { installationId: "42" })).body?.cancel();
  const repo = await (await cp.call("POST", "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const agent = await (await cp.call("POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const created = await cp.call("POST", "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Fix the login page", instructions: "It is broken." },
    connectedRepoId: repo.id,
  });
  assertEquals(created.status, 201);
  const { runId, taskId } = await created.json();
  const { RYPH_RUN_TOKEN: runToken } = await bootstrapEnv(cp.handler, cp.launches.at(-1)!.env!);
  const beat = await cp.call("POST", `/v1/runs/${runId}/heartbeat`, {
    seq: 0,
    phase: "running",
  }, runToken);
  await beat.body?.cancel();
  return { runId, taskId, runToken, repo };
}

/** The runner's upload of a tool image, under the ref the model was shown. */
async function keepImage(cp: ControlPlane, runId: string, runToken: string, bytes: Uint8Array) {
  const res = await cp.handler(
    new Request(`${cp.url}/v1/runs/${runId}/runner/attachments?ref=${await refOf(bytes)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${runToken}` },
      body: bytes as BodyInit,
    }),
  );
  assertEquals(res.status, 201);
  return (await res.json()) as { id: string };
}

/** The forge's service surface, listening, over a GitHub that records what it is asked to write. */
async function forgeService(root: string, orchestratorUrl: string) {
  const diag = silentDiagnostics();
  const updates: Array<{ commentId: string; body: string }> = [];
  const posts: Array<{ body: string }> = [];
  const github = new Proxy({
    upstreamUrl: (_repo: unknown, url: string) => url,
    postComment(_repo: unknown, _thread: unknown, body: string) {
      posts.push({ body });
      return Promise.resolve({ commentId: "1001" });
    },
    updateComment(_repo: unknown, commentId: string, body: string) {
      updates.push({ commentId, body });
      return Promise.resolve();
    },
  } as Record<string, unknown>, {
    get: (target, key) =>
      key in target
        ? target[key as string]
        : () => Promise.reject(new Error(`not here: ${String(key)}`)),
  }) as unknown as ForgeApi & GithubAppApi & GithubDelivery;
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${root}/cache`, diag });
  const handler = makeForgeHandler({
    keys: { resolve: () => Promise.resolve(null) },
    cache,
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github }, "forge API"),
    transports: providerRegistry(
      { github: githubChangeTransport({ api: github, cache, diag }) },
      "change transport",
    ),
    // As forge/src/main.ts wires it: the control plane's URL and the forge's own service token.
    images: forgeRunImages({ orchestratorUrl, forgeToken: FORGE_TOKEN, diag }),
    serviceToken: FORGE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  });
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  return { server, url: `http://127.0.0.1:${server.addr.port}`, updates, posts };
}

test("a run's final summary reaches the forge thread with its image as a ryph link", async () => {
  const cp = await controlPlane();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const forge = await forgeService(root, cp.url);
  try {
    const { runId, taskId, runToken, repo } = await liveRun(cp);
    const kept = await keepImage(cp, runId, runToken, PNG);
    const ref = await refOf(PNG);
    const missing = await refOf(GIF);

    // The run's status comment, as a forge-started run opens it.
    const at = cp.clock.now().toISOString();
    await cp.store.saveProgressComment({
      runId,
      taskId,
      connectedRepoId: repo.id,
      threadKind: "issue",
      threadRef: "7",
      commentId: "1001",
      lastPosted: { state: "running", phase: null },
      attempts: 0,
      concludedAt: null,
      createdAt: at,
      updatedAt: at,
    });

    // The final summary shows the run's screenshot, and names one it never took: the result
    // keeps only the first, and the page shows the second as its alt.
    const done = await cp.call("POST", `/v1/runs/${runId}/result`, {
      status: "success",
      branches: [],
      summary: `Fixed it. ![the [login] page](${ref}) and ![a guess](${missing})`,
    }, runToken);
    assertEquals(done.status, 200);
    await done.body?.cancel();
    const task = await (await cp.call("GET", `/v1/tasks/${taskId}`, undefined)).json();
    assertEquals(task.runs.at(-1).result.images, [
      { ref, attachmentId: kept.id, mime: "image/png", alt: "the [login] page" },
    ]);

    // The sweep edits the comment through the real forge client, which renders the ref against
    // the run over the control plane's forge route. The unknown ref went as its alt, so the
    // edit is not refused.
    await sweepProgressComments({
      store: cp.store,
      forge: httpForge({ baseUrl: forge.url, forgeToken: FORGE_TOKEN, diag: silentDiagnostics() }),
      identityDirectory: null,
      diag: silentDiagnostics(),
      now: cp.clock.now,
      appUrl: APP_URL,
    });
    assertEquals(forge.updates.length, 1);
    const body = forge.updates[0].body;
    assertStringIncludes(
      body,
      `[Image: the \\[login\\] page](${APP_URL}/images/${runId}/${kept.id})`,
    );
    assertStringIncludes(body, "and a guess");
    assert(!body.includes("img-"), body);

    // A body naming an image the run does not hold is refused at the forge, terminally.
    const refused = await fetch(`${forge.url}/v1/service/comment`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${FORGE_TOKEN}` },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
        thread: { kind: "issue", ref: "7" },
        body: `![x](${missing})`,
        runId,
      }),
    });
    assertEquals(refused.status, 422);
    assertStringIncludes((await refused.json()).error, missing);

    // The bytes a Radicle embed is written from: the forge's adapter reads and sniffs them.
    const bytes = await forgeRunImages({
      orchestratorUrl: cp.url,
      forgeToken: FORGE_TOKEN,
      diag: silentDiagnostics(),
    }).bytes(runId, kept.id);
    assertEquals([bytes.mime, bytes.bytes], ["image/png", PNG]);
  } finally {
    await forge.server.shutdown();
    await cp.server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a chat post's image is resolved and fetched from the control plane, then uploaded", async () => {
  const cp = await controlPlane();
  const api = await makeApi();
  try {
    const { runId, runToken } = await liveRun(cp);
    const kept = await keepImage(cp, runId, runToken, PNG);
    const ref = await refOf(PNG);

    // The chat service's images, as chat/src/main.ts wires them: the control plane's URL and
    // the chat service token.
    const real = chatRunImages({ orchestratorUrl: cp.url, chatToken: CHAT_TOKEN });
    api.images.resolve = real.resolve;
    api.images.fetch = real.fetch;

    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, runId, "C0OPS:1727530000.000100");
    api.slack.sent.length = 0;
    const result = await callTool({ service: api.service, runId }, "post", {
      text: `Fixed. ![login page after the fix](${ref})`,
    });
    assertEquals(result, { content: [{ type: "text", text: "Posted. 1 image went with it." }] });
    assertEquals(api.slack.sent.map((m) => m.text), ["[Ada] Fixed. login page after the fix"]);
    const [sent] = api.slack.imagesSent;
    assertEquals(sent.images.map((i) => [i.label, i.mime, i.url]), [
      ["login page after the fix", "image/png", `${APP_URL}/images/${runId}/${kept.id}`],
    ]);
    assertEquals(sent.images[0].bytes, PNG, "the bytes came from the control plane");

    // The single binary reads the same answers in process, with no route between.
    const inProcess = inProcessRunImages(cp.deps);
    assertEquals(
      await inProcess.resolve(runId, [ref]),
      await real.resolve(runId, [ref]),
    );
    assertEquals(await inProcess.fetch(runId, kept.id), PNG);
  } finally {
    await api.close();
    await cp.server.shutdown();
  }
});
