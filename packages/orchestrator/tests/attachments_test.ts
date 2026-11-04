import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Attachments: the images a run is handed. The sniff decides the format whatever the client
// claims; the cap and the allowlist refuse at the door; an image belongs to one run and rides
// one message; the run page reads it back inert, the runner reads only what it was handed; and a
// run can START with images, frozen onto its work item.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { MAX_AGENT_UPLOADS_IN_FLIGHT } from "../src/http/runner_api.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import { postMessage } from "../src/core/inbox.ts";
import {
  attachmentKey,
  imageMarker,
  inspectImage,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_UNCLAIMED_ATTACHMENTS,
  sniffImage,
  storeAgentAttachment,
  storeAttachment,
  sweepUnclaimedAttachments,
  UNCLAIMED_ATTACHMENT_TTL_MS,
} from "../src/core/attachments.ts";
import { startTask, type StartTaskDeps } from "../src/core/start_task.ts";

/** A start with this app's ports, and none of the ones these tests do not exercise. */
function startTaskDeps(
  deps:
    & Pick<StartTaskDeps, "store" | "provisioner" | "diag" | "now" | "config">
    & Partial<StartTaskDeps>,
): StartTaskDeps {
  return {
    forge: null,
    serviceCatalogue: null,
    skillCatalogue: null,
    skills: null,
    memoryAccess: null,
    identityDirectory: null,
    environments: null,
    modelAccess: null,
    attachmentStore: null,
    chatAccess: null,
    platformModel: null,
    ...deps,
  };
}
import type { AttachmentStore } from "../src/ports/attachment_store.ts";
import type { RunMessage } from "../src/core/types.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0x24,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

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
const VIEWER = { ...MEMBER, caps: capsClaimOf("viewer") };

function memoryBlobs(): AttachmentStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
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

function buildApp() {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const { control } = fakeRunnerControl();
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [{
      fullName: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      private: true,
    }],
  });
  const caller = { principal: MEMBER as typeof MEMBER | typeof VIEWER };
  const attachmentStore = memoryBlobs();
  const deps = {
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(caller.principal)) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    chatToken: "chat-service-token",
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    inbox: makeInboxSignal(),
    attachmentStore,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: null,
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
  return {
    handler: makeHandler(deps),
    deps,
    store,
    caller,
    launches,
    identities,
    attachmentStore,
    clock,
  };
}

type App = ReturnType<typeof buildApp>;
const URL_BASE = "http://orchestrator.test";
const json = (app: App, method: string, path: string, body: unknown = {}, token = "t") =>
  app.handler(
    new Request(`${URL_BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
const upload = (app: App, runId: string, bytes: Uint8Array, type = "image/png") =>
  app.handler(
    new Request(`${URL_BASE}/v1/runs/${runId}/attachments`, {
      method: "POST",
      headers: { "content-type": type, authorization: "Bearer t" },
      body: bytes as BodyInit,
    }),
  );
const del = (app: App, path: string) =>
  app.handler(
    new Request(`${URL_BASE}${path}`, { method: "DELETE", headers: { authorization: "Bearer t" } }),
  );
const get = (app: App, path: string, token = "t") =>
  app.handler(new Request(`${URL_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }));

/** A connected repo and an agent (made once per app), and a task on them: a live
 * run, and its runner token. */
async function liveRun(app: App) {
  if (made.get(app) === undefined) {
    app.identities.link(MEMBER.userId, "noop-ada-lovelace");
    await json(app, "POST", "/v1/installations", { installationId: "42" });
    const repo = await (await json(app, "POST", "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    })).json();
    const agent = await (await json(app, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    made.set(app, { repo, agent });
  }
  const { repo, agent } = made.get(app)!;
  const created = await json(app, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Look at this", instructions: "What is wrong?" },
    connectedRepoId: repo.id,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201);
  const { runId, taskId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await json(app, "POST", `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { runId, taskId, runToken, repo, agent };
}
const made = new WeakMap<App, { repo: { id: string }; agent: { id: string } }>();

test("sniffing decides the format from the bytes alone; anything else is refused", () => {
  assertEquals(sniffImage(PNG), "image/png");
  assertEquals(sniffImage(JPEG), "image/jpeg");
  assertEquals(sniffImage(GIF), "image/gif");
  assertEquals(sniffImage(new TextEncoder().encode("GIF87a")), "image/gif");
  assertEquals(sniffImage(WEBP), "image/webp");
  assertEquals(sniffImage(SVG), null);
  assertEquals(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WAVE")), null);
  assertEquals(sniffImage(PNG.slice(0, 7)), null, "a truncated signature is no signature");
  assertEquals(sniffImage(new Uint8Array()), null);

  assertEquals(inspectImage(PNG), { kind: "image", mime: "image/png" });
  assertEquals(inspectImage(new Uint8Array()).kind, "refused");
  const svg = inspectImage(SVG);
  assert(svg.kind === "refused" && svg.status === 415);
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  const over = inspectImage(big);
  assert(over.kind === "refused" && over.status === 413);
  const atCap = new Uint8Array(MAX_ATTACHMENT_BYTES);
  atCap.set(PNG);
  assertEquals(inspectImage(atCap).kind, "image");
  assertEquals(imageMarker(2), "[image 2]");
});

test("an upload is sniffed, stored under the run, and answered as id, type and size", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  // The claimed type is ignored: these bytes are a JPEG.
  const res = await upload(app, runId, JPEG, "image/png");
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.mime, "image/jpeg");
  assertEquals(body.bytes, JPEG.length);
  const stored = (await app.store.getAttachment(body.id))!;
  assertEquals(stored.runId, runId);
  assertEquals(stored.source, "user");
  assertEquals(stored.claimedBy, null);
  assertEquals(stored.storageKey, attachmentKey(runId, body.id));
  assertEquals(stored.sha256.length, 64);
  assertEquals(app.attachmentStore.blobs.get(stored.storageKey), JPEG);

  // An SVG wearing an image type, nothing at all, and too much are each refused, and nothing
  // is stored for any of them.
  assertEquals((await upload(app, runId, SVG)).status, 415);
  assertEquals((await upload(app, runId, new Uint8Array())).status, 400);
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  assertEquals((await upload(app, runId, big)).status, 413);
  assertEquals(app.attachmentStore.blobs.size, 1);
});

test("uploading takes the right to post, and an unknown or terminal run refuses", async () => {
  const app = buildApp();
  const { runId, taskId } = await liveRun(app);
  app.caller.principal = VIEWER;
  assertEquals((await upload(app, runId, PNG)).status, 403);
  app.caller.principal = MEMBER;
  assertEquals((await upload(app, "r-nope", PNG)).status, 404);
  await json(app, "POST", `/v1/tasks/${taskId}/cancel`);
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunTransition({ ...run, state: "cancelled" }, run);
  const ended = await upload(app, runId, PNG);
  assertEquals(ended.status, 409);
  // The reason travels with the words, as a message's refusal carries it.
  assertEquals(await ended.json(), { error: "run is terminal (cancelled)", reason: "terminal" });
});

test("a message carries images once: by this run's ids, in order, and never twice", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const other = await liveRun(app);
  const a = await (await upload(app, runId, PNG)).json();
  const b = await (await upload(app, runId, JPEG)).json();
  const foreign = await (await upload(app, other.runId, PNG)).json();

  // Text may be empty when there are images; never when there are none.
  const posted = await json(app, "POST", `/v1/runs/${runId}/messages`, {
    text: "",
    attachmentIds: [b.id, a.id],
  });
  assertEquals(posted.status, 201);
  const { message } = await posted.json() as { message: RunMessage };
  assertEquals(message.attachments, [
    { id: b.id, mime: "image/jpeg" },
    { id: a.id, mime: "image/png" },
  ]);
  assertEquals((await app.store.getAttachment(a.id))!.claimedBy, message.id);
  assertEquals((await json(app, "POST", `/v1/runs/${runId}/messages`, { text: " " })).status, 400);

  // Sent once: the same image cannot ride a second message.
  const again = await json(app, "POST", `/v1/runs/${runId}/messages`, {
    text: "again",
    attachmentIds: [a.id],
  });
  assertEquals(again.status, 409);
  // Another run's image reads as no image at all; a repeat and too many are malformed.
  const c = await (await upload(app, runId, PNG)).json();
  for (
    const ids of [[foreign.id], ["att-nope"], [c.id, c.id], Array.from({ length: 11 }, () => c.id)]
  ) {
    const res = await json(app, "POST", `/v1/runs/${runId}/messages`, {
      text: "x",
      attachmentIds: ids,
    });
    assertEquals(res.status, 400, JSON.stringify(ids));
  }
  // Nothing was claimed by a refusal.
  assertEquals((await app.store.getAttachment(c.id))!.claimedBy, null);

  // The runner pulls the refs with the message.
  const pulled = await (await get(app, `/v1/runs/${runId}/messages?after=-1`, runToken)).json();
  assertEquals(pulled.messages[0].attachments, message.attachments);
});

test("postMessage takes images from any producer, as the run page's door does", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  const run = (await app.store.getRun(runId))!;
  const stored = await storeAttachment(app.deps, run, GIF, "chat");
  assert(stored.kind === "stored");
  assertEquals(stored.attachment.source, "chat");
  const outcome = await postMessage(app.deps, run, {
    kind: "chat",
    sender: { kind: "chat", name: "Grace", id: "42" },
    text: `look ${imageMarker(1)}`,
    attachmentIds: [stored.attachment.id],
  });
  assert(outcome.kind === "posted");
  assertEquals(outcome.message.attachments, [{ id: stored.attachment.id, mime: "image/gif" }]);
  // A deployment with no store refuses an image, never drops it.
  const none = await storeAttachment({ ...app.deps, attachmentStore: null }, run, GIF, "chat");
  assert(none.kind === "refused" && none.status === 503);
});

test("the run page reads an image back inert; only from the run that owns it", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  const other = await liveRun(app);
  const a = await (await upload(app, runId, PNG)).json();

  const res = await get(app, `/v1/runs/${runId}/attachments/${a.id}`);
  assertEquals(res.status, 200);
  assertEquals(new Uint8Array(await res.arrayBuffer()), PNG);
  assertEquals(res.headers.get("content-type"), "image/png");
  // Never shown from a cache that outlived the session that read it.
  assertEquals(res.headers.get("cache-control"), "private, no-cache");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("content-disposition"), `inline; filename="${a.id}.png"`);
  assertEquals(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");

  // A viewer may look; another run's path does not serve it.
  app.caller.principal = VIEWER;
  assertEquals((await get(app, `/v1/runs/${runId}/attachments/${a.id}`)).status, 200);
  app.caller.principal = MEMBER;
  const wrong = await get(app, `/v1/runs/${other.runId}/attachments/${a.id}`);
  assertEquals(wrong.status, 404);
  await wrong.body?.cancel();
  assertEquals((await get(app, `/v1/runs/${runId}/attachments/att-nope`)).status, 404);
});

test("the runner reads an image it was handed, with its own token, and nothing else", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const other = await liveRun(app);
  const sent = await (await upload(app, runId, PNG)).json();
  const unsent = await (await upload(app, runId, JPEG)).json();
  await json(app, "POST", `/v1/runs/${runId}/messages`, { text: "", attachmentIds: [sent.id] });

  const path = (run: string, id: string) => `/v1/runs/${run}/runner/attachments/${id}`;
  const res = await get(app, path(runId, sent.id), runToken);
  assertEquals(res.status, 200);
  assertEquals(new Uint8Array(await res.arrayBuffer()), PNG);
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  // Not yet handed over: not the runner's to read.
  assertEquals((await get(app, path(runId, unsent.id), runToken)).status, 404);
  // The wrong token, or another run's token, learns nothing.
  assertEquals((await get(app, path(runId, sent.id), "nope")).status, 401);
  assertEquals((await get(app, path(runId, sent.id), other.runToken)).status, 401);
  assertEquals((await get(app, path(other.runId, sent.id), other.runToken)).status, 404);
});

test("a run starts with images: stored under it, claimed by the task, frozen onto the work item", async () => {
  const app = buildApp();
  const { agent, repo } = await liveRun(app);
  const agentRow = (await app.store.getAgent(agent.id))!;
  const repoRow = (await app.store.getConnectedRepo(repo.id))!;
  const args = {
    agent: agentRow,
    spec: { title: "From the thread", instructions: `Fix what ${imageMarker(1)} shows.` },
    repos: [{
      connectedRepo: repoRow,
      url: repoRow.url,
      ref: "main",
      path: "app",
      name: "acme/app",
      description: null,
    }],
    origin: "forge" as const,
    requestedByUserId: MEMBER.userId,
  };
  const started = await startTask(startTaskDeps(app.deps), {
    ...args,
    images: [{ bytes: PNG, source: "forge" }, { bytes: WEBP, source: "forge" }],
  });
  assert(started.kind === "started");
  const run = (await app.store.getRun(started.runId))!;
  assertEquals(run.workItem.attachments?.map((a) => a.mime), ["image/png", "image/webp"]);
  const rows = await app.store.listAttachmentsByIds(run.workItem.attachments!.map((a) => a.id));
  assertEquals(rows.map((r) => [r.runId, r.claimedBy, r.source]), [
    [run.id, "task", "forge"],
    [run.id, "task", "forge"],
  ]);
  // The spec route hands the runner the refs; the runner door serves the bytes.
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  const spec = await (await get(app, `/v1/runs/${run.id}/spec`, runToken)).json();
  assertEquals(spec.workItem.attachments, run.workItem.attachments);
  const bytes = await get(
    app,
    `/v1/runs/${run.id}/runner/attachments/${run.workItem.attachments![0].id}`,
    runToken,
  );
  assertEquals(new Uint8Array(await bytes.arrayBuffer()), PNG);
  // A task image cannot be sent again in a message.
  const resent = await json(app, "POST", `/v1/runs/${run.id}/messages`, {
    text: "",
    attachmentIds: [run.workItem.attachments![0].id],
  });
  assertEquals(resent.status, 409);

  // A start with an image it cannot take is refused whole, before anything is written.
  const blobs = app.attachmentStore.blobs.size;
  const tasks = (await app.store.listTasks()).tasks.length;
  const refused = await startTask(startTaskDeps(app.deps), {
    ...args,
    images: [{ bytes: SVG, source: "forge" }],
  });
  assert(refused.kind === "refused" && refused.status === 415);
  assertEquals(
    refused.error,
    "image 1: not a supported image: PNG, JPEG, GIF and WebP are accepted",
  );
  const tooMany = await startTask(startTaskDeps(app.deps), {
    ...args,
    images: Array.from({ length: 11 }, () => ({ bytes: PNG, source: "forge" as const })),
  });
  assert(tooMany.kind === "refused" && tooMany.status === 400);
  assertEquals(app.attachmentStore.blobs.size, blobs);
  assertEquals((await app.store.listTasks()).tasks.length, tasks);
  // No images: no field on the work item at all.
  const plain = await startTask(startTaskDeps(app.deps), args);
  assert(plain.kind === "started");
  assertEquals((await app.store.getRun(plain.runId))!.workItem.attachments, undefined);
});

/** The `startTask` args of a forge-commanded start on the app's connected repo. */
async function forgeStartArgs(app: App) {
  const { agent, repo } = await liveRun(app);
  const agentRow = (await app.store.getAgent(agent.id))!;
  const repoRow = (await app.store.getConnectedRepo(repo.id))!;
  return {
    agent: agentRow,
    spec: { title: "From the thread", instructions: `Fix what ${imageMarker(1)} shows.` },
    repos: [{
      connectedRepo: repoRow,
      url: repoRow.url,
      ref: "main",
      path: "app",
      name: "acme/app",
      description: null,
    }],
    origin: "forge" as const,
    requestedByUserId: MEMBER.userId,
  };
}

test("a start's image rows ride the run's own insert, and a refused or failed insert takes the blobs back", async () => {
  const app = buildApp();
  const args = await forgeStartArgs(app);
  const images = [{ bytes: PNG, source: "forge" as const }, {
    bytes: JPEG,
    source: "forge" as const,
  }];
  const blobsBefore = app.attachmentStore.blobs.size;
  // Rows are never written beside the run, only with it: a crash between two statements must
  // not leave a run naming images it has no rows for.
  const store = {
    ...app.store,
    createUnclaimedAttachment: () =>
      Promise.reject(new Error("a start's rows are written outside its insert")),
  };

  const started = await startTask(startTaskDeps({ ...app.deps, store }), { ...args, images });
  assert(started.kind === "started");

  // The live-run cap answered at the insert (a race past the door's own count): refused, and
  // the blobs stored for it are gone again, so a retried start does not pile them up.
  const refused = await startTask(
    startTaskDeps({
      ...app.deps,
      store: { ...store, createTask: () => Promise.resolve("full" as const) },
      config: { ...app.deps.config, limits: { ...app.deps.config.limits, concurrency: 1_000 } },
    }),
    { ...args, images },
  );
  assert(refused.kind === "refused" && refused.status === 429);
  assertEquals(app.attachmentStore.blobs.size, blobsBefore + 2, "only the started run's blobs");

  // An insert that throws takes them back too, and the throw still reaches the caller.
  const broken = { ...store, createTask: () => Promise.reject(new Error("db down")) };
  const err = await startTask(startTaskDeps({ ...app.deps, store: broken }), { ...args, images })
    .catch((e) => e);
  assert(err instanceof Error && err.message === "db down");
  assertEquals(app.attachmentStore.blobs.size, blobsBefore + 2);

  // The started one: rows and blobs both, under its id.
  const run = (await app.store.getRun(started.runId))!;
  const rows = await app.store.listAttachmentsByIds(run.workItem.attachments!.map((a) => a.id));
  assertEquals(rows.length, 2);
  for (const row of rows) assert(app.attachmentStore.blobs.has(row.storageKey));
});

test("unclaimed uploads are capped per run, and the run page can take one back", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  const ids: string[] = [];
  for (let i = 0; i < MAX_UNCLAIMED_ATTACHMENTS; i++) {
    const res = await upload(app, runId, PNG);
    assertEquals(res.status, 201);
    ids.push((await res.json()).id);
  }
  const over = await upload(app, runId, PNG);
  assertEquals(over.status, 409);
  assertEquals(await over.json(), {
    error: `this run already holds ${MAX_UNCLAIMED_ATTACHMENTS} images waiting to be sent; ` +
      "send or remove some first",
    reason: "cap",
  });
  assertEquals(app.attachmentStore.blobs.size, MAX_UNCLAIMED_ATTACHMENTS);

  // Taking one back: row and blob gone, and the slot is free again.
  const path = (id: string) => `/v1/runs/${runId}/attachments/${id}`;
  app.caller.principal = VIEWER;
  assertEquals((await del(app, path(ids[0]))).status, 403);
  app.caller.principal = MEMBER;
  assertEquals((await del(app, path(ids[0]))).status, 204);
  assertEquals(await app.store.getAttachment(ids[0]), null);
  assertEquals(app.attachmentStore.blobs.size, MAX_UNCLAIMED_ATTACHMENTS - 1);
  assertEquals((await del(app, path(ids[0]))).status, 404);
  assertEquals((await upload(app, runId, PNG)).status, 201);

  // A sent image is the conversation's: not taken back, and not this run's path's to remove
  // from another run.
  await json(app, "POST", `/v1/runs/${runId}/messages`, { text: "", attachmentIds: [ids[1]] });
  assertEquals((await del(app, path(ids[1]))).status, 404);
  assert((await app.store.getAttachment(ids[1])) !== null);
  const other = await liveRun(app);
  assertEquals((await del(app, `/v1/runs/${other.runId}/attachments/${ids[2]}`)).status, 404);
  assert((await app.store.getAttachment(ids[2])) !== null);
});

test("uploads racing for the last free slots: the write refuses past the cap and the blob goes back", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  const run = (await app.store.getRun(runId))!;
  for (let i = 0; i < MAX_UNCLAIMED_ATTACHMENTS - 10; i++) {
    assert((await storeAttachment(app.deps, run, PNG, "user")).kind === "stored");
  }
  // Thirty in flight at once, every one past the early count before any is written.
  const raced = await Promise.all(
    Array.from({ length: 30 }, () => storeAttachment(app.deps, run, PNG, "user")),
  );
  assertEquals(raced.filter((r) => r.kind === "stored").length, 10);
  for (const r of raced) {
    if (r.kind === "refused") assertEquals([r.status, r.reason], [409, "cap"]);
  }
  assertEquals(await app.store.countUnclaimedAttachments(runId), MAX_UNCLAIMED_ATTACHMENTS);
  assertEquals(app.attachmentStore.blobs.size, MAX_UNCLAIMED_ATTACHMENTS, "no orphan blobs");
  // A terminal run's refusal shares the status and says the other thing.
  const ended = await storeAttachment(app.deps, { ...run, state: "succeeded" }, PNG, "user");
  assert(ended.kind === "refused");
  assertEquals([ended.status, ended.reason], [409, "terminal"]);
});

test("the reaper sweeps uploads no message carried once they are a day old, and nothing else", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  const sent = await (await upload(app, runId, PNG)).json();
  await json(app, "POST", `/v1/runs/${runId}/messages`, { text: "", attachmentIds: [sent.id] });
  const stale = await (await upload(app, runId, JPEG)).json();
  app.clock.advance(UNCLAIMED_ATTACHMENT_TTL_MS - 1000);
  const fresh = await (await upload(app, runId, GIF)).json();
  app.clock.advance(2000);

  await sweepUnclaimedAttachments(app.deps);
  assertEquals(await app.store.getAttachment(stale.id), null);
  assertEquals(app.attachmentStore.blobs.has(attachmentKey(runId, stale.id)), false);
  assert((await app.store.getAttachment(fresh.id)) !== null, "younger than a day");
  assert((await app.store.getAttachment(sent.id)) !== null, "a sent image is never swept");
  assert(app.attachmentStore.blobs.has(attachmentKey(runId, sent.id)));
});

test("a re-run carries the images its task started with, as copies under the new run", async () => {
  const app = buildApp();
  const args = await forgeStartArgs(app);
  const started = await startTask(startTaskDeps(app.deps), {
    ...args,
    images: [{ bytes: PNG, source: "forge" }, { bytes: WEBP, source: "forge" }],
  });
  assert(started.kind === "started");
  const source = (await app.store.getRun(started.runId))!;
  const body = {
    agentId: args.agent.id,
    spec: source.workItem.spec,
    connectedRepoId: args.repos[0].connectedRepo.id,
    rerunOf: started.taskId,
  };
  const res = await json(app, "POST", "/v1/tasks", body);
  assertEquals(res.status, 201);
  const rerun = (await app.store.getRun((await res.json()).runId))!;
  const refs = rerun.workItem.attachments!;
  // Same images, same order — the order the markers count — under ids and keys of its own.
  assertEquals(refs.map((r) => r.mime), ["image/png", "image/webp"]);
  const rows = new Map(
    (await app.store.listAttachmentsByIds(refs.map((r) => r.id))).map((a) => [a.id, a]),
  );
  const sourceRows = new Map(
    (await app.store.listAttachmentsByIds(source.workItem.attachments!.map((r) => r.id)))
      .map((a) => [a.id, a]),
  );
  for (const [i, ref] of refs.entries()) {
    const row = rows.get(ref.id)!;
    const original = sourceRows.get(source.workItem.attachments![i].id)!;
    assertEquals([row.runId, row.claimedBy, row.source], [rerun.id, "task", "forge"]);
    assertEquals(row.sha256, original.sha256);
    assert(row.storageKey !== original.storageKey);
    assert(app.attachmentStore.blobs.has(row.storageKey));
  }

  // A task the caller cannot see is no task to re-run; one whose images are gone is refused
  // rather than started with markers pointing at nothing.
  assertEquals((await json(app, "POST", "/v1/tasks", { ...body, rerunOf: "t-nope" })).status, 404);
  app.attachmentStore.blobs.delete(sourceRows.values().next().value!.storageKey);
  assertEquals((await json(app, "POST", "/v1/tasks", body)).status, 409);
  // A task that started with no images re-runs with none.
  const plain = await startTask(startTaskDeps(app.deps), args);
  assert(plain.kind === "started");
  const again = await json(app, "POST", "/v1/tasks", { ...body, rerunOf: plain.taskId });
  assertEquals(again.status, 201);
  const againRun = (await app.store.getRun((await again.json()).runId))!;
  assertEquals(againRun.workItem.attachments, undefined);
});

/** The ref the runner sends with an image: `img-` and 12 hex of its SHA-256. */
async function refOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "img-" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** A PNG of its own: the same bytes twice are one image now. */
const pngNo = (n: number) => new Uint8Array([...PNG, n & 0xff, n >> 8]);

const agentUpload = async (
  app: App,
  runId: string,
  bytes: Uint8Array,
  token: string,
  ref?: string,
) =>
  app.handler(
    new Request(
      `${URL_BASE}/v1/runs/${runId}/runner/attachments?ref=${ref ?? await refOf(bytes)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
        body: bytes as BodyInit,
      },
    ),
  );

test("the runner keeps a tool's image: stored claimed, as the agent's, served by both doors", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const res = await agentUpload(app, runId, JPEG, runToken);
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(Object.keys(body).sort(), ["bytes", "id", "mime"]);
  assertEquals([body.mime, body.bytes], ["image/jpeg", JPEG.length]);
  const stored = (await app.store.getAttachment(body.id))!;
  assertEquals([stored.runId, stored.source, stored.claimedBy], [runId, "agent", "tool"]);
  assertEquals(app.attachmentStore.blobs.get(stored.storageKey), JPEG);

  // The run page and the runner both read it back.
  const user = await get(app, `/v1/runs/${runId}/attachments/${body.id}`);
  assertEquals(user.status, 200);
  assertEquals(new Uint8Array(await user.arrayBuffer()), JPEG);
  const runner = await get(app, `/v1/runs/${runId}/runner/attachments/${body.id}`, runToken);
  assertEquals(runner.status, 200);
  assertEquals(new Uint8Array(await runner.arrayBuffer()), JPEG);

  // Assistant markdown can read by ref without loading the originating tool event.
  const ref = await refOf(JPEG);
  const byRef = await get(app, `/v1/runs/${runId}/attachments/${ref}`);
  assertEquals(byRef.status, 200);
  assertEquals(byRef.headers.get("content-type"), "image/jpeg");
  assertEquals(byRef.headers.get("cache-control"), "private, no-cache");
  assertEquals(new Uint8Array(await byRef.arrayBuffer()), JPEG);
  const other = await liveRun(app);
  for (
    const path of [
      `/v1/runs/${other.runId}/attachments/${ref}`,
      `/v1/runs/${runId}/attachments/img-000000000000`,
      `/v1/runs/${runId}/attachments/img-invalid`,
    ]
  ) {
    const missing = await get(app, path);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  }

  // It is the conversation's already: no message carries it, nobody takes it back, the sweep
  // leaves it, and it holds no slot of the composer's.
  const carried = await json(app, "POST", `/v1/runs/${runId}/messages`, {
    text: "",
    attachmentIds: [body.id],
  });
  assertEquals(carried.status, 409);
  await carried.body?.cancel();
  assertEquals((await del(app, `/v1/runs/${runId}/attachments/${body.id}`)).status, 404);
  app.clock.advance(UNCLAIMED_ATTACHMENT_TTL_MS + 1);
  await sweepUnclaimedAttachments(app.deps);
  assert((await app.store.getAttachment(body.id)) !== null);
  assertEquals(await app.store.countUnclaimedAttachments(runId), 0);
});

test("the runner's image door: its token only, sniffed and capped, and refused once terminal", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const other = await liveRun(app);
  const refused = async (res: Response) => {
    await res.body?.cancel();
    return res.status;
  };
  // A user's credentials are not a run token, another run's token is not this one's, and an
  // unknown run reads the same.
  assertEquals(await refused(await agentUpload(app, runId, PNG, "t")), 401);
  assertEquals(await refused(await agentUpload(app, runId, PNG, other.runToken)), 401);
  assertEquals(await refused(await agentUpload(app, "r-nope", PNG, runToken)), 401);
  assertEquals(await refused(await agentUpload(app, runId, SVG, runToken)), 415);
  assertEquals(await refused(await agentUpload(app, runId, new Uint8Array(), runToken)), 400);
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  assertEquals(await refused(await agentUpload(app, runId, big, runToken)), 413);
  assertEquals(app.attachmentStore.blobs.size, 0);

  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });
  assertEquals(await refused(await agentUpload(app, runId, PNG, runToken)), 409);
  assertEquals(app.attachmentStore.blobs.size, 0);
});

test("a run keeps at most MAX_AGENT_ATTACHMENTS tool images, then 409 cap; the composer's cap is its own", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const run = (await app.store.getRun(runId))!;
  for (let i = 0; i < MAX_AGENT_ATTACHMENTS - 1; i++) {
    const image = pngNo(i);
    assert(
      (await storeAgentAttachment(app.deps, run, image, await refOf(image))).kind === "stored",
    );
  }
  assertEquals((await agentUpload(app, runId, pngNo(1000), runToken)).status, 201);
  const over = await agentUpload(app, runId, pngNo(1001), runToken);
  assertEquals(over.status, 409);
  assertEquals(await over.json(), { error: "cap" });
  assertEquals(app.attachmentStore.blobs.size, MAX_AGENT_ATTACHMENTS, "no orphan blob");
  // The composer still has every one of its slots.
  assertEquals((await upload(app, runId, PNG)).status, 201);
});

/** A row of the agent's, `bytes` big on paper, written straight to the store with no blob: what
 * the budget counts without a test buffering hundreds of megabytes. */
const seedAgentRow = (app: App, runId: string, id: string, bytes: number) =>
  app.store.createAgentAttachment({
    id,
    runId,
    mime: "image/png",
    bytes,
    sha256: "0".repeat(64),
    ref: `img-${id}`,
    source: "agent",
    storageKey: `attachments/${runId}/${id}`,
    claimedBy: "tool",
    createdAt: new Date(0).toISOString(),
  }, { maxCount: Infinity, maxBytes: Infinity });

/** A body that records whether anyone read it. */
function watchedBody(bytes: Uint8Array) {
  const seen = { pulled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled = true;
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { body, seen };
}

test("a run keeps at most MAX_AGENT_ATTACHMENT_BYTES of tool images in all; past it an image is 409 bytes", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  // Forty 5 MiB images are the whole budget: the count is far off, the bytes are not.
  for (let i = 0; i < MAX_AGENT_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES; i++) {
    assertEquals(
      await seedAgentRow(app, runId, `att-seed-${i}`, MAX_ATTACHMENT_BYTES),
      { kind: "created" },
    );
  }
  const over = await agentUpload(app, runId, PNG, runToken);
  assertEquals(over.status, 409);
  assertEquals(await over.json(), { error: "bytes" });
  assertEquals(app.attachmentStore.blobs.size, 0, "nothing written, nothing taken back");

  // The rule is the locked write, not the look before it: a row that would cross the budget by
  // one byte is refused there too.
  const other = await liveRun(app);
  await seedAgentRow(app, other.runId, "att-big", MAX_AGENT_ATTACHMENT_BYTES - 4);
  const row = (n: number) => ({
    id: `att-edge-${n}`,
    runId: other.runId,
    mime: "image/png" as const,
    bytes: n,
    sha256: "0".repeat(64),
    ref: `img-edge-${n}`,
    source: "agent" as const,
    storageKey: `attachments/${other.runId}/att-edge-${n}`,
    claimedBy: "tool",
    createdAt: new Date(0).toISOString(),
  });
  const limits = { maxCount: MAX_AGENT_ATTACHMENTS, maxBytes: MAX_AGENT_ATTACHMENT_BYTES };
  assertEquals(await app.store.createAgentAttachment(row(5), limits), { kind: "full" });
  assertEquals(await app.store.createAgentAttachment(row(4), limits), { kind: "created" });

  // A refusal by the locked write is told apart too: the look before it saw room (a racing
  // upload filled it meanwhile), the write did not, and the image is refused as `bytes`.
  const raced = await liveRun(app);
  await seedAgentRow(app, raced.runId, "att-full", MAX_AGENT_ATTACHMENT_BYTES - 4);
  const usage = app.store.agentAttachmentUsage.bind(app.store);
  let looks = 0;
  const racing = {
    ...app.deps,
    store: {
      createAgentAttachment: app.store.createAgentAttachment.bind(app.store),
      agentAttachmentsByRefs: app.store.agentAttachmentsByRefs.bind(app.store),
      agentAttachmentUsage: (id: string) =>
        looks++ === 0 ? Promise.resolve({ count: 0, bytes: 0 }) : usage(id),
    },
  };
  const refused = await storeAgentAttachment(
    racing,
    (await app.store.getRun(raced.runId))!,
    PNG,
    await refOf(PNG),
  );
  assertEquals(refused.kind === "refused" && refused.reason, "bytes");
});

test("a capped run's upload is refused before its body is read or the store is touched", async () => {
  const app = buildApp();
  let puts = 0;
  const put = app.attachmentStore.put;
  app.attachmentStore.put = (key, bytes) => {
    puts += 1;
    return put(key, bytes);
  };
  const upload = (runId: string, token: string, body: ReadableStream<Uint8Array>) =>
    app.handler(
      new Request(`${URL_BASE}/v1/runs/${runId}/runner/attachments?ref=img-0123456789ab`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
        body,
      }),
    );

  // At the count.
  const byCount = await liveRun(app);
  for (let i = 0; i < MAX_AGENT_ATTACHMENTS; i++) {
    await seedAgentRow(app, byCount.runId, `att-c${i}`, 1);
  }
  const counted = watchedBody(PNG);
  const res = await upload(byCount.runId, byCount.runToken, counted.body);
  assertEquals([res.status, await res.json()], [409, { error: "cap" }]);
  assertEquals(counted.seen.pulled, false);

  // At the bytes.
  const byBytes = await liveRun(app);
  await seedAgentRow(app, byBytes.runId, "att-b", MAX_AGENT_ATTACHMENT_BYTES);
  const summed = watchedBody(PNG);
  const res2 = await upload(byBytes.runId, byBytes.runToken, summed.body);
  assertEquals([res2.status, await res2.json()], [409, { error: "bytes" }]);
  assertEquals(summed.seen.pulled, false);
  assertEquals(puts, 0);
});

test("at most MAX_AGENT_UPLOADS_IN_FLIGHT tool uploads per run at once; the next is 429", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const other = await liveRun(app);
  const held: Array<() => void> = [];
  const put = app.attachmentStore.put;
  app.attachmentStore.put = (key, bytes) =>
    new Promise<void>((resolve) => held.push(() => resolve(put(key, bytes))));
  const waitFor = async (n: number) => {
    while (held.length < n) await new Promise((r) => setTimeout(r, 1));
  };

  const first = Array.from(
    { length: MAX_AGENT_UPLOADS_IN_FLIGHT },
    (_, i) => agentUpload(app, runId, pngNo(i), runToken),
  );
  await waitFor(MAX_AGENT_UPLOADS_IN_FLIGHT);
  const busy = await agentUpload(app, runId, pngNo(100), runToken);
  assertEquals(busy.status, 429);
  await busy.body?.cancel();
  // Another run is not held up by this one's.
  const elsewhere = agentUpload(app, other.runId, PNG, other.runToken);
  await waitFor(MAX_AGENT_UPLOADS_IN_FLIGHT + 1);

  for (const release of held) release();
  for (const res of [...await Promise.all(first), await elsewhere]) {
    assertEquals(res.status, 201);
    await res.body?.cancel();
  }
  // The slots come back once the uploads are done.
  app.attachmentStore.put = put;
  const after = await agentUpload(app, runId, pngNo(101), runToken);
  assertEquals(after.status, 201);
  await after.body?.cancel();
});

// Image refs: the name an agent writes a tool's image by (core/image_refs.ts).

test("an image is stored under its ref: bytes that do not hash to it are refused, the same ref twice is one row", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const status = async (res: Response) => {
    await res.body?.cancel();
    return res.status;
  };
  assertEquals(await status(await agentUpload(app, runId, PNG, runToken, "")), 400);
  assertEquals(await status(await agentUpload(app, runId, PNG, runToken, "img-nothex!!!!!!")), 400);
  const wrong = await agentUpload(app, runId, PNG, runToken, await refOf(JPEG));
  assertEquals(wrong.status, 400);
  assertEquals((await wrong.json()).error, `the image's bytes do not hash to ${await refOf(JPEG)}`);
  assertEquals(app.attachmentStore.blobs.size, 0);

  const first = await agentUpload(app, runId, PNG, runToken);
  assertEquals(first.status, 201);
  const kept = await first.json();
  assertEquals((await app.store.getAttachment(kept.id))?.ref, await refOf(PNG));
  // Again: the row already kept, no second blob, nothing counted.
  const again = await agentUpload(app, runId, PNG, runToken);
  assertEquals([again.status, await again.json()], [200, kept]);
  assertEquals(app.attachmentStore.blobs.size, 1);
  assertEquals(await app.store.agentAttachmentUsage(runId), { count: 1, bytes: PNG.length });
  // Another run's same screenshot is its own.
  const other = await liveRun(app);
  assertEquals(await status(await agentUpload(app, other.runId, PNG, other.runToken)), 201);
});

const service = (app: App, method: string, path: string, token: string, body?: unknown) =>
  app.handler(
    new Request(`${URL_BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

test("the forge and chat resolve a run's refs, and serve only its tool images' bytes", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const kept = await (await agentUpload(app, runId, PNG, runToken)).json();
  const ref = await refOf(PNG);
  // A person's upload to the run is no tool image: it neither resolves nor is served.
  const person = await (await upload(app, runId, JPEG)).json();
  const missing = await refOf(GIF);
  // The run is over, and its images still resolve (a status comment is written after the end);
  // what is missing is not waited on.
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });

  for (
    const [surface, token] of [["forge", "forge-service-token"], ["chat", "chat-service-token"]]
  ) {
    const resolve = (refs: string[], as = token) =>
      service(app, "POST", `/v1/${surface}/runs/${runId}/images/resolve`, as, { refs });
    assertEquals((await resolve([ref], "nope")).status, 401);
    assertEquals((await resolve([])).status, 400);
    assertEquals((await resolve(["img-1"])).status, 400);
    const started = Date.now();
    const res = await resolve([ref, missing, ref]);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      images: [{ ref, attachmentId: kept.id, mime: "image/png", url: null }],
      unknown: [missing],
    });
    assert(Date.now() - started < 1_000, "a concluded run waits on nothing");

    const bytes = (id: string, run = runId, as = token) =>
      service(app, "GET", `/v1/${surface}/runs/${run}/attachments/${id}`, as);
    const served = await bytes(kept.id);
    assertEquals(served.status, 200);
    assertEquals(new Uint8Array(await served.arrayBuffer()), PNG);
    for (
      const res of [
        await bytes(person.id),
        await bytes(kept.id, "r-other"),
        await bytes(kept.id, runId, "x"),
      ]
    ) {
      assert(res.status === 404 || res.status === 401);
      await res.body?.cancel();
    }
  }
});

test("a live run's missing ref is waited on: the upload may still be in flight", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const ref = await refOf(PNG);
  const asked = service(
    app,
    "POST",
    `/v1/forge/runs/${runId}/images/resolve`,
    "forge-service-token",
    {
      refs: [ref],
    },
  );
  await new Promise((r) => setTimeout(r, 300));
  const kept = await (await agentUpload(app, runId, PNG, runToken)).json();
  const res = await asked;
  assertEquals((await res.json()).images.map((i: { attachmentId: string }) => i.attachmentId), [
    kept.id,
  ]);
});

test("the runner checks a summary's refs; the result keeps the words and the images they show", async () => {
  const app = buildApp();
  const { runId, taskId, runToken } = await liveRun(app);
  const kept = await (await agentUpload(app, runId, PNG, runToken)).json();
  const ref = await refOf(PNG);
  const missing = await refOf(GIF);
  const check = await json(app, "POST", `/v1/runs/${runId}/runner/images/resolve`, {
    refs: [ref, missing],
  }, runToken);
  assertEquals((await check.json()).unknown, [missing]);

  // A patch description naming an image the run does not have is refused, naming it.
  const branch = {
    connectedRepoId: made.get(app)!.repo.id,
    path: "app",
    name: "ryph/ada/x",
    line: "work",
    headSha: "a".repeat(40),
    commits: [],
    generation: 1,
    carries: [],
  };
  const patch = await json(app, "POST", `/v1/runs/${runId}/patches`, {
    branch,
    baseSha: "b".repeat(40),
    description: `Fixed: ![after](${missing})`,
  }, runToken);
  assertEquals(patch.status, 400);
  const why = (await patch.json()).error as string;
  assert(why.includes(missing) && why.includes("a tool returned in this run"), why);

  const summary = `Fixed the login page.\n\n![login after the fix](${ref})\n![gone](${missing})`;
  const done = await json(app, "POST", `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [],
    summary,
  }, runToken);
  assertEquals(done.status, 200);
  await done.body?.cancel();
  const task = await (await get(app, `/v1/tasks/${taskId}`)).json();
  const result = task.runs.at(-1).result;
  assertEquals(result.summary, summary);
  assertEquals(result.images, [
    { ref, attachmentId: kept.id, mime: "image/png", alt: "login after the fix" },
  ]);
});
