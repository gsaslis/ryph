import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Artifacts: a run of an agent whose switch is on publishes an HTML page every member can open.
// The live switch decides a publish, the frozen one what the runner offers, and an edit cannot
// undo an admin's switch it read before; only the agent that created an artifact may version or
// fetch it, by `mayVersion`, and a deleted one is gone; the title, the document's size and image
// refs are held at the door, and a run hands the sanitizer one page at a time and at most so many
// an hour, deletes or not; the same page again is answered before the sanitizer; the content route serves the document made at publish, its images inlined,
// with exactly the sandbox headers and an exact-match ETag; the list, the page and the delete
// take their capabilities; and the task page lists what its runs published, and when.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { inProcessArtifactHtml, memoryArtifactStore } from "./artifact_doubles.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import {
  ARTIFACT_CONTENT_HEADERS,
  ARTIFACT_CSP,
  ARTIFACT_PREAMBLE,
  ARTIFACT_SKILL,
  artifactEtag,
  cleanArtifactTitle,
  MAX_ARTIFACT_ATTEMPTS_PER_HOUR,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_INLINED_BYTES,
  MAX_ARTIFACT_SERVED_BYTES,
  mayVersion,
  titleIsVisible,
} from "../src/core/artifacts.ts";
import { startTask, type StartTaskDeps } from "../src/core/start_task.ts";
import { chatConversationKey } from "../src/core/thread_context.ts";
import { MAX_TAG_ATTRIBUTES, MAX_TREE_NODES } from "../src/helpers/artifact_html.ts";
import { directorySkillCatalogue } from "../src/adapters/skill_catalogue/directory.ts";
import type { AttachmentStore } from "../src/ports/attachment_store.ts";
import type { ArtifactHtmlPreparer } from "../src/ports/artifact_html.ts";
import type { ArtifactThumbnailRenderer } from "../src/ports/artifact_thumbnail.ts";
import { thumbnailKey } from "../src/core/artifact_thumbnails.ts";
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
const REF_B = "img-ba9876543210";

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
const VIEWER = { ...MEMBER, userId: "u-2", caps: capsClaimOf("viewer") };
const OPERATOR = { ...MEMBER, userId: "u-3", caps: capsClaimOf("operator") };
/** Another member, who asked for none of the artifacts here. */
const OTHER_MEMBER = { ...MEMBER, userId: "u-5" };
/** A token that can read tasks but was minted without artifacts:read. */
const NO_ARTIFACTS = { ...MEMBER, userId: "u-4", caps: ["tasks:read", "tasks:read-all"] as const };
/** The member's own API token, narrowed to reading artifacts — it cannot ask for work. */
const READ_ONLY_ASKER = { ...MEMBER, via: "token", caps: ["artifacts:read"] } as const;

// ---------------------------------------------------------------------------
// Titles, and the versioning rule (the served document's own suite is artifact_html_test.ts)
// ---------------------------------------------------------------------------

test("titles: controls and separators become spaces, format characters go, an invisible one is not a title", () => {
  assertEquals(cleanArtifactTitle(" A\tB\u0085C\u202eD\u2066E\u2069 "), "A B CDE");
  // Zero-width characters, the directional marks and the line and paragraph separators.
  assertEquals(
    cleanArtifactTitle("Q\u200b3\u200e \u200frep\u061cort\u2028final\u2029draft\ufeff"),
    "Q3 report final draft",
  );
  for (const invisible of ["\u3164", "\u200b\u200b", " \u3164 \u2800 ", "\u115f\u1160", "\u0301"]) {
    assertEquals(titleIsVisible(cleanArtifactTitle(invisible)), false, JSON.stringify(invisible));
  }
  assertEquals(titleIsVisible("\u3164A"), true);
});

test("mayVersion: the same agent, and the same task, chat thread or person", () => {
  const artifact = {
    agentId: "a-1",
    requestedBy: "u-1",
    deletedAt: null,
    requestOrigin: "user" as const,
    originChatroomId: null,
    originConversation: null,
  };
  const asker = {
    agentId: "a-1",
    taskId: "t-2",
    requestedBy: "u-1",
    requestOrigin: "user" as const,
    chatroomId: null,
    conversation: null,
  };
  assertEquals(mayVersion(artifact, ["t-1"], asker), true, "the same person");
  assertEquals(mayVersion(artifact, ["t-1"], { ...asker, requestedBy: "u-2" }), false);
  assertEquals(mayVersion(artifact, ["t-2"], { ...asker, requestedBy: "u-2" }), true, "same task");
  assertEquals(mayVersion(artifact, ["t-2"], { ...asker, agentId: "a-2" }), false);
  assertEquals(mayVersion({ ...artifact, deletedAt: "x" }, ["t-2"], asker), false);
  // A chat's or an automation's run acts for an owner who did not ask for this page.
  for (const origin of ["chat", "automation"] as const) {
    assertEquals(mayVersion(artifact, ["t-1"], { ...asker, requestOrigin: origin }), false);
    assertEquals(mayVersion({ ...artifact, requestOrigin: origin }, ["t-1"], asker), false);
  }
  // The same chat conversation, whoever owns the room.
  const inChat = {
    ...artifact,
    requestOrigin: "chat" as const,
    originChatroomId: "room",
    originConversation: "thread:C1:1.2",
  };
  const chatAsker = {
    ...asker,
    requestOrigin: "chat" as const,
    requestedBy: "u-9",
    chatroomId: "room",
    conversation: "thread:C1:1.2",
  };
  assertEquals(mayVersion(inChat, ["t-1"], chatAsker), true);
  assertEquals(mayVersion(inChat, ["t-1"], { ...chatAsker, conversation: "other" }), false);
  assertEquals(mayVersion(inChat, ["t-1"], { ...chatAsker, chatroomId: "other" }), false);
  assertEquals(mayVersion(inChat, ["t-1"], { ...chatAsker, conversation: null }), false);
});

test("mayVersion: a run on a fork's head reaches only its own task's artifacts", () => {
  const artifact = {
    agentId: "a-1",
    requestedBy: "u-1",
    deletedAt: null,
    requestOrigin: "user" as const,
    originChatroomId: null,
    originConversation: null,
  };
  const asker = {
    agentId: "a-1",
    taskId: "t-2",
    requestedBy: "u-1",
    requestOrigin: "forge" as const,
    chatroomId: null,
    conversation: null,
    confined: true,
  };
  // The same person asked for it elsewhere: not this run's to rewrite or read back.
  assertEquals(mayVersion(artifact, ["t-1"], asker), false);
  assertEquals(mayVersion(artifact, ["t-1"], { ...asker, confined: undefined }), true);
  assertEquals(mayVersion(artifact, ["t-2"], asker), true, "its own task's");
});

test("mayVersion: a later mention in the same Zulip topic or Slack or Discord thread may update; on Telegram only the same task", () => {
  type Mention = Parameters<typeof chatConversationKey>[0];
  /** Whether a task started by `later` may update the page a task started by `first` made. */
  const follows = (first: Mention, later: Mention) =>
    mayVersion(
      {
        agentId: "a-1",
        requestedBy: "owner",
        deletedAt: null,
        requestOrigin: "chat",
        originChatroomId: "room",
        originConversation: chatConversationKey(first),
      },
      ["t-1"],
      {
        agentId: "a-1",
        taskId: "t-2",
        requestedBy: "owner",
        requestOrigin: "chat",
        chatroomId: "room",
        conversation: chatConversationKey(later),
      },
    );
  // Zulip: the thread key is the mention's own id, so only the stream and topic join them;
  // Zulip matches topics whatever their case.
  const zulip = (id: string, stream: string, topic: string): Mention => ({
    threadKey: id,
    channel: { id: stream },
    topic,
  });
  assertEquals(
    follows(zulip("101", "7", "Weekly report"), zulip("205", "7", "weekly REPORT")),
    true,
  );
  assertEquals(follows(zulip("101", "7", "Weekly report"), zulip("205", "7", "Other")), false);
  assertEquals(
    follows(zulip("101", "7", "Weekly report"), zulip("205", "8", "Weekly report")),
    false,
  );
  // Slack: a reply in the thread carries the thread's key; another thread does not.
  const slack = (key: string): Mention => ({ threadKey: key, channel: { id: "C1" }, topic: null });
  assertEquals(follows(slack("C1:1700.1"), slack("C1:1700.1")), true);
  assertEquals(follows(slack("C1:1700.1"), slack("C1:1800.2")), false);
  // Discord: a mention at the top of a channel keys the thread it starts, and one inside the
  // thread carries the same key — and the thread's name, which is no identity.
  const discord = (key: string, topic: string | null): Mention => ({
    threadKey: key,
    channel: { id: "800000000000000010" },
    topic,
  });
  const started = "800000000000000010:800000000000001000";
  assertEquals(follows(discord(started, null), discord(started, "cache is cold")), true);
  assertEquals(
    follows(
      discord(started, "cache is cold"),
      discord("800000000000000010:800000000000002000", "cache is cold"),
    ),
    false,
    "two threads of one name are two conversations",
  );
  // Telegram: one key for the whole group, which is no conversation.
  const telegram: Mention = { threadKey: "", channel: { id: "-100" }, topic: null };
  assertEquals(chatConversationKey(telegram), null);
  assertEquals(follows(telegram, telegram), false);
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

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

type Caller =
  | typeof MEMBER
  | typeof VIEWER
  | typeof OPERATOR
  | typeof NO_ARTIFACTS
  | typeof OTHER_MEMBER
  | typeof READ_ONLY_ASKER;

function buildApp(
  opts: {
    htmlSlots?: number;
    artifactHtml?: ArtifactHtmlPreparer;
    artifactThumbnail?: ArtifactThumbnailRenderer;
  } = {},
) {
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
  const caller = { principal: MEMBER as Caller };
  const attachmentStore = memoryBlobs();
  const artifacts = memoryArtifactStore(store);
  const deps = {
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(caller.principal)) as unknown as Authenticate,
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    inbox: makeInboxSignal(),
    attachmentStore,
    artifacts,
    artifactHtml: opts.artifactHtml ?? inProcessArtifactHtml({ maxInFlight: opts.htmlSlots }),
    artifactThumbnail: opts.artifactThumbnail,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: "https://ryph.test/",
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
    artifacts,
    clock,
  };
}

type App = ReturnType<typeof buildApp>;
const BASE = "http://orchestrator.test";
const json = (app: App, method: string, path: string, body: unknown = {}, token = "t") =>
  app.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
const get = (app: App, path: string, token = "t") =>
  app.handler(new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }));
const del = (app: App, path: string) =>
  app.handler(
    new Request(`${BASE}${path}`, { method: "DELETE", headers: { authorization: "Bearer t" } }),
  );
const as = async <T>(app: App, who: Caller, fn: () => Promise<T>): Promise<T> => {
  const before = app.caller.principal;
  app.caller.principal = who;
  try {
    return await fn();
  } finally {
    app.caller.principal = before;
  }
};

const repos = new WeakMap<App, { id: string }>();

/** An agent (artifacts on unless said otherwise) and a live run of it, with its runner token. */
async function agentWithRun(app: App, opts: { name?: string; artifacts?: boolean } = {}) {
  if (repos.get(app) === undefined) {
    app.identities.link(MEMBER.userId, "noop-ada-lovelace");
    app.identities.name(MEMBER.userId, "Ada Lovelace");
    await json(app, "POST", "/v1/installations", { installationId: "42" });
    repos.set(
      app,
      await (await json(app, "POST", "/v1/connected-repos", {
        installationId: "42",
        repoRef: "acme/app",
      })).json(),
    );
  }
  const name = opts.name ?? "Ada";
  // Switching artifacts on is an admin's (agents:policy).
  const agent = await as(app, OPERATOR, async () =>
    await (await json(app, "POST", "/v1/agents", {
      name,
      email: `${name.toLowerCase()}@example.com`,
      harnessKind: "echo",
      canPublishArtifacts: opts.artifacts ?? true,
    })).json());
  return { agent, ...await runOf(app, agent.id) };
}

async function runOf(app: App, agentId: string) {
  const created = await json(app, "POST", "/v1/tasks", {
    agentId,
    spec: { title: "Research it", instructions: "Give an overview" },
    connectedRepoId: repos.get(app)!.id,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201);
  const { runId, taskId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await json(app, "POST", `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { runId, taskId, runToken };
}

const publish = (
  app: App,
  run: { runId: string; runToken: string },
  body: { title: string; html: string; artifactId?: string },
) => json(app, "POST", `/v1/runs/${run.runId}/artifacts`, body, run.runToken);

/** The app's in-process sanitizer, for counting what reached it and holding it. */
const inProcessHtml = (app: App) =>
  app.deps.artifactHtml as ReturnType<typeof inProcessArtifactHtml>;

/** A tag with one attribute too many, distinct per `i`. */
const tooManyAttributes = (i: number) =>
  Array.from({ length: MAX_TAG_ATTRIBUTES + 1 }, (_, k) => ` a${i}x${k}`).join("");

async function refOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "img-" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** A tool image of the run, as the runner keeps one: its ref. */
async function keepImage(app: App, run: { runId: string; runToken: string }, bytes = PNG) {
  const ref = await refOf(bytes);
  const res = await app.handler(
    new Request(`${BASE}/v1/runs/${run.runId}/runner/attachments?ref=${ref}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${run.runToken}`,
      },
      body: bytes as BodyInit,
    }),
  );
  assertEquals(res.status, 201);
  return ref;
}

// A PNG header with the renderer's fixed dimensions; the core only sniffs, never decodes it.
function thumbnailPng(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, 1200);
  new DataView(bytes.buffer).setUint32(20, 750);
  return bytes;
}

test("thumbnails: lazy, prepared images, durable version cache, private reads and deletion", async () => {
  const rendered: string[] = [];
  const app = buildApp({
    artifactThumbnail: {
      render: (html) => {
        rendered.push(html);
        return Promise.resolve(thumbnailPng());
      },
    },
  });
  const run = await agentWithRun(app);
  const ref = await keepImage(app, run);
  const { id } =
    await (await publish(app, run, { title: "Page", html: `<h1>One</h1><img src="${ref}">` }))
      .json();
  assertEquals(rendered.length, 0, "publish does not render");
  const path = `/v1/artifacts/${id}/versions/1/thumbnail`;
  const first = await as(app, VIEWER, () => get(app, path));
  assertEquals(first.status, 200);
  assertEquals(first.headers.get("content-type"), "image/png");
  assertEquals(first.headers.get("cache-control"), "private, no-cache");
  assertStringIncludes(rendered[0], "data:image/png;base64,");
  const etag = first.headers.get("etag")!;
  const conditional = () =>
    app.handler(new Request(`${BASE}${path}`, { headers: { "if-none-match": etag } }));
  assertEquals((await conditional()).status, 304);
  assertEquals((await as(app, NO_ARTIFACTS, conditional)).status, 404);
  // A new handler/replica reuses the blob, not an in-memory rendering.
  const replica = makeHandler(app.deps);
  assertEquals((await replica(new Request(`${BASE}${path}`))).status, 200);
  assertEquals(rendered.length, 1);
  await publish(app, run, { title: "Page", html: "<h1>Two</h1>", artifactId: id });
  assertEquals((await get(app, `/v1/artifacts/${id}/versions/2/thumbnail`)).status, 200);
  assertEquals(rendered.length, 2);
  assertEquals((await get(app, `/v1/artifacts/${id}/versions/3/thumbnail`)).status, 404);
  assertEquals((await del(app, `/v1/artifacts/${id}`)).status, 204);
  assertEquals(await app.deps.attachmentStore.get(thumbnailKey(id, 1)), null);
  assertEquals(await app.deps.attachmentStore.get(thumbnailKey(id, 2)), null);
  assertEquals(
    (await conditional()).status,
    404,
    "deleted artifacts cannot validate a cached image",
  );
});

test("thumbnails: duplicate views share work, overload is not queued, deletion fences late completion", async () => {
  let release!: (bytes: Uint8Array) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => started = resolve);
  let calls = 0;
  const app = buildApp({
    artifactThumbnail: {
      render: () => {
        calls++;
        started();
        return new Promise<Uint8Array>((resolve) => release = resolve);
      },
    },
  });
  const run = await agentWithRun(app);
  const { id } = await (await publish(app, run, { title: "Page", html: "<h1>One</h1>" })).json();
  const path = `/v1/artifacts/${id}/versions/1/thumbnail`;
  const first = get(app, path);
  await began;
  const second = get(app, path);
  await del(app, `/v1/artifacts/${id}`);
  release(thumbnailPng());
  assertEquals((await first).status, 404);
  assertEquals((await second).status, 404);
  assertEquals(calls, 1);
  assertEquals(await app.deps.attachmentStore.get(thumbnailKey(id, 1)), null);
});

test("thumbnails: renderer faults back off and do not affect publication or the document", async () => {
  let calls = 0;
  const app = buildApp({
    artifactThumbnail: {
      render: () => {
        calls++;
        return Promise.reject(new Error("renderer down"));
      },
    },
  });
  const run = await agentWithRun(app);
  const { id } = await (await publish(app, run, { title: "Page", html: "<h1>One</h1>" })).json();
  const path = `/v1/artifacts/${id}/versions/1/thumbnail`;
  assertEquals((await get(app, path)).status, 503);
  assertEquals((await get(app, path)).status, 503);
  assertEquals(calls, 1);
  assertEquals((await get(app, `/v1/artifacts/${id}/versions/1/content`)).status, 200);
  const disabled = makeHandler({ ...app.deps, artifactThumbnail: null });
  assertEquals((await disabled(new Request(`${BASE}${path}`))).status, 503);
});

test("publish: a new artifact, then a new version of it, each with its run event and link", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  // The switch is frozen onto the run, for the runner to offer the tool by.
  assertEquals((await app.store.getRun(run.runId))!.workItem.canPublishArtifacts, true);

  const first = await publish(app, run, { title: " Overview ", html: "<h1>One</h1>" });
  assertEquals(first.status, 201);
  const { id, version, url } = await first.json();
  assert(id.startsWith("art-"));
  assertEquals([version, url], [1, `https://ryph.test/artifacts/${id}`]);

  app.clock.advance(1000);
  const second = await publish(app, run, {
    title: "Overview, revised",
    html: "<h1>Two</h1>",
    artifactId: id,
  });
  assertEquals(second.status, 200);
  assertEquals(await second.json(), { id, version: 2, url });

  const events = (await app.store.listEvents(run.runId))
    .filter((e) => e.kind === "artifact-published");
  assertEquals(events.map((e) => e.detail), [
    'Published "Overview" (version 1)',
    'Published "Overview, revised" (version 2)',
  ]);

  const page = await (await get(app, `/v1/artifacts/${id}`)).json();
  assertEquals(page.title, "Overview, revised");
  assertEquals(page.currentVersion, 2);
  assertEquals(page.agent, { id: run.agent.id, name: "Ada" });
  assertEquals([page.originRunId, page.originTaskId], [run.runId, run.taskId]);
  assertEquals(page.requestedBy, { id: MEMBER.userId, name: "Ada Lovelace" });
  assertEquals(
    page.versions.map((v: Record<string, unknown>) => [v.version, v.title, v.runId, v.taskId]),
    [[1, "Overview", run.runId, run.taskId], [2, "Overview, revised", run.runId, run.taskId]],
  );
});

test("publish: only the agent that made an artifact may version it, and never once deleted", async () => {
  const app = buildApp();
  const ada = await agentWithRun(app);
  const { id } = await (await publish(app, ada, { title: "Ada's", html: "<p>a</p>" })).json();

  // Another agent learns nothing: the same answer as an id that never existed.
  const bob = await agentWithRun(app, { name: "Bob" });
  const theirs = await publish(app, bob, { title: "Bob's", html: "<p>b</p>", artifactId: id });
  assertEquals(theirs.status, 404);
  const unknown = await publish(app, bob, { title: "?", html: "<p>?</p>", artifactId: "art-nope" });
  assertEquals(unknown.status, 404);
  assertEquals((await theirs.json()).error, (await unknown.json()).error.replace("art-nope", id));

  // A later run of the SAME agent may.
  const again = await runOf(app, ada.agent.id);
  const later = await publish(app, again, { title: "Ada's v2", html: "<p>a2</p>", artifactId: id });
  assertEquals([later.status, (await later.json()).version], [200, 2]);

  await as(app, OPERATOR, () => del(app, `/v1/artifacts/${id}`));
  const gone = await publish(app, again, { title: "Ada's v3", html: "<p>a3</p>", artifactId: id });
  assertEquals(gone.status, 404);
});

test("publish: refused while the agent's switch reads off live, whatever the run was told", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const off = await json(app, "PATCH", `/v1/agents/${run.agent.id}`, {
    canPublishArtifacts: false,
  });
  assertEquals([off.status, (await off.json()).canPublishArtifacts], [200, false]);
  // The run still holds the switch it was frozen with; the publish reads the agent.
  assertEquals((await app.store.getRun(run.runId))!.workItem.canPublishArtifacts, true);
  const refused = await publish(app, run, { title: "T", html: "<p>x</p>" });
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "may not publish artifacts");

  // An agent created without it never could, and its runs are told so.
  const plain = await agentWithRun(app, { name: "Cy", artifacts: false });
  assertEquals((await app.store.getRun(plain.runId))!.workItem.canPublishArtifacts, false);
  assertEquals((await publish(app, plain, { title: "T", html: "<p>x</p>" })).status, 403);
  assertEquals(app.artifacts.rows.size, 0);
});

test("publish: a sanitizer that is unavailable refuses the publish as 503 and stores nothing", async () => {
  const unavailable: ArtifactHtmlPreparer = {
    reserve: () => ({
      kind: "slot",
      prepare: () => Promise.resolve({ kind: "unavailable" }),
      release: () => {},
    }),
    close: () => {},
  };
  const app = buildApp({ artifactHtml: unavailable });
  const run = await agentWithRun(app);
  const refused = await publish(app, run, { title: "T", html: "<p>x</p>" });
  assertEquals(refused.status, 503);
  assertStringIncludes((await refused.json()).error, "sanitizer is unavailable");
  assertEquals(app.artifacts.rows.size, 0);
});

test("publish: the title, the size and a concluded run are held at the door", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  assertEquals((await publish(app, run, { title: "  ", html: "<p>x</p>" })).status, 400);
  assertEquals((await publish(app, run, { title: "x".repeat(201), html: "<p>x</p>" })).status, 400);

  const big = await publish(app, run, {
    title: "Big",
    html: "é".repeat(MAX_ARTIFACT_HTML_BYTES / 2 + 1),
  });
  assertEquals(big.status, 413);
  assertStringIncludes((await big.json()).error, "at most 2097152 bytes");
  // At the cap exactly is fine.
  const atCap = await publish(app, run, {
    title: "Full",
    html: "a".repeat(MAX_ARTIFACT_HTML_BYTES),
  });
  assertEquals(atCap.status, 201);

  // A small document the parse grows past what ryph reads: every distinct <b> left open is
  // rebuilt after each closing </div>, so 15 KB builds 300,000 elements.
  const reopened = (bolds: string, divs: number) =>
    "<div>".repeat(divs) + bolds + "</div>x".repeat(divs);
  const bold = Array.from({ length: 300 }, (_, i) => `<b a=${i}>`).join("");
  const grown = await publish(app, run, { title: "Grown", html: reopened(bold, 1_000) });
  assertEquals(grown.status, 400);
  const complex = (await grown.json()).error;
  assertStringIncludes(complex, "too complex");
  assertStringIncludes(complex, `more than ${MAX_TREE_NODES}`);
  // Fewer elements, each with a long attribute: the tree fits, the served document would not.
  const long = Array.from({ length: 40 }, (_, i) => `<b a=${i}${"y".repeat(2_000)}>`).join("");
  const written = await publish(app, run, { title: "Long", html: reopened(long, 2_000) });
  assertEquals(written.status, 400);
  assertStringIncludes(
    (await written.json()).error,
    `at most ${MAX_ARTIFACT_SERVED_BYTES} bytes (4 MiB)`,
  );

  // Another run's token speaks for nothing here.
  const other = await agentWithRun(app, { name: "Bob" });
  const forged = await json(
    app,
    "POST",
    `/v1/runs/${run.runId}/artifacts`,
    { title: "T", html: "<p>x</p>" },
    other.runToken,
  );
  assertEquals(forged.status, 401);

  await json(app, "POST", `/v1/runs/${run.runId}/result`, {
    status: "success",
    summary: "done",
    branches: [],
  }, run.runToken);
  const late = await publish(app, run, { title: "Late", html: "<p>x</p>" });
  assertEquals(late.status, 409);
});

test("publish: every image ref must be one of the run's own; the content route inlines them", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const ref = await keepImage(app, run);

  const unknown = await publish(app, run, {
    title: "Pics",
    html: `<img src="${ref}"><img src="${REF_B}">`,
  });
  assertEquals(unknown.status, 400);
  const error = (await unknown.json()).error;
  assertStringIncludes(error, REF_B);
  assert(!error.includes(ref), error);

  // Another run's image is not this run's.
  const other = await agentWithRun(app, { name: "Bob" });
  const theirs = await keepImage(app, other, new Uint8Array([...PNG, 7]));
  assertEquals(
    (await publish(app, run, { title: "P", html: `<img src="${theirs}">` })).status,
    400,
  );

  const ok = await publish(app, run, {
    title: "Pics",
    html: `<!doctype html><html><head></head><body><img src="${ref}" alt="shot"></body></html>`,
  });
  assertEquals(ok.status, 201);
  const { id } = await ok.json();

  const res = await get(app, `/v1/artifacts/${id}/versions/1/content`);
  assertEquals(res.status, 200);
  const body = await res.text();
  const b64 = btoa(String.fromCharCode(...PNG));
  assertEquals(
    body,
    `<!DOCTYPE html><html><head>${ARTIFACT_PREAMBLE}</head><body>` +
      `<img src="data:image/png;base64,${b64}" alt="shot"></body></html>`,
  );
  // Exactly the §5 headers, a length and the version's ETag.
  const etag = artifactEtag(id, 1);
  assertEquals(Object.fromEntries(res.headers), {
    ...ARTIFACT_CONTENT_HEADERS,
    etag,
    "content-length": String(new TextEncoder().encode(body).byteLength),
  });
  // The app's ARTIFACT_CSP is held to this same literal, byte for byte.
  assertEquals(
    res.headers.get("content-security-policy"),
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ " +
      "https://cdnjs.cloudflare.com/ajax/libs/; style-src 'unsafe-inline' " +
      "https://fonts.googleapis.com https://cdn.jsdelivr.net/npm/ " +
      "https://cdnjs.cloudflare.com/ajax/libs/; font-src https://fonts.gstatic.com " +
      "https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/ data:; " +
      "img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; " +
      "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  );
  assertEquals(res.headers.get("content-security-policy"), ARTIFACT_CSP);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  assertEquals(res.headers.get("cache-control"), "private, no-cache");
  assertEquals(etag, `"${id}.1.r2"`);

  // Asked again with its ETag: a 304 with the same guards and no body.
  const again = await app.handler(
    new Request(`${BASE}/v1/artifacts/${id}/versions/1/content`, {
      headers: { authorization: "Bearer t", "if-none-match": `W/"x", ${etag}` },
    }),
  );
  assertEquals(again.status, 304);
  assertEquals(await again.text(), "");
  assertEquals(again.headers.get("etag"), etag);
  assertEquals(again.headers.get("content-security-policy"), ARTIFACT_CSP);
  // Anything but this version's exact ETag gets the document: an older rendering's, a wildcard,
  // a weak tag.
  for (const header of [`"${id}.1.r1"`, "*", `W/${etag}`]) {
    const res = await app.handler(
      new Request(`${BASE}/v1/artifacts/${id}/versions/1/content`, {
        headers: { authorization: "Bearer t", "if-none-match": header },
      }),
    );
    assertEquals(res.status, 200, header);
    await res.body?.cancel();
  }

  // A viewer who cannot see the run still sees its images, through the artifact.
  const viewed = await as(app, VIEWER, () => get(app, `/v1/artifacts/${id}/versions/1/content`));
  assertEquals([viewed.status, (await viewed.text()).includes(b64)], [200, true]);
});

test("content: unknown, deleted, malformed and unreadable versions are all a 404", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const { id } = await (await publish(app, run, { title: "T", html: "<p>x</p>" })).json();
  for (
    const path of [
      `/v1/artifacts/${id}/versions/2/content`,
      `/v1/artifacts/${id}/versions/01/content`,
      `/v1/artifacts/${id}/versions/0/content`,
      `/v1/artifacts/art-nope/versions/1/content`,
    ]
  ) {
    const res = await get(app, path);
    assertEquals(res.status, 404, path);
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  }
  // Without artifacts:read: the same 404, never a 403 that says it exists.
  const hidden = await as(
    app,
    NO_ARTIFACTS,
    () => get(app, `/v1/artifacts/${id}/versions/1/content`),
  );
  assertEquals(hidden.status, 404);
  await as(app, OPERATOR, () => del(app, `/v1/artifacts/${id}`));
  assertEquals((await get(app, `/v1/artifacts/${id}/versions/1/content`)).status, 404);
});

test("list, page and delete: a viewer reads every artifact, only an operator deletes", async () => {
  const app = buildApp();
  const ada = await agentWithRun(app);
  const ids: string[] = [];
  for (const title of ["First", "Second", "Third"]) {
    app.clock.advance(1000);
    ids.push((await (await publish(app, ada, { title, html: `<p>${title}</p>` })).json()).id);
  }

  const listed = await as(app, VIEWER, () => get(app, "/v1/artifacts"));
  assertEquals(listed.status, 200);
  const all = await listed.json();
  assertEquals(all.artifacts.map((a: { title: string }) => a.title), ["Third", "Second", "First"]);
  assertEquals(all.next, null);
  assertEquals(all.artifacts[0], {
    id: ids[2],
    title: "Third",
    currentVersion: 1,
    agent: { id: ada.agent.id, name: "Ada" },
    originRunId: ada.runId,
    originTaskId: ada.taskId,
    url: `https://ryph.test/artifacts/${ids[2]}`,
    createdAt: all.artifacts[0].createdAt,
    updatedAt: all.artifacts[0].updatedAt,
  });

  // Paged: two, then the rest.
  const page1 = await (await get(app, "/v1/artifacts?limit=2")).json();
  assertEquals(page1.artifacts.map((a: { id: string }) => a.id), [ids[2], ids[1]]);
  const page2 = await (await get(app, `/v1/artifacts?limit=2&before=${page1.next}`)).json();
  assertEquals([page2.artifacts.map((a: { id: string }) => a.id), page2.next], [[ids[0]], null]);
  assertEquals((await get(app, "/v1/artifacts?before=nonsense")).status, 400);
  assertEquals((await get(app, "/v1/artifacts?limit=0")).status, 400);

  // A version moves an artifact to the top.
  app.clock.advance(1000);
  await publish(app, ada, { title: "First, again", html: "<p>1</p>", artifactId: ids[0] });
  const moved = await (await get(app, "/v1/artifacts")).json();
  assertEquals(moved.artifacts[0].id, ids[0]);

  // Reading takes artifacts:read; deleting takes artifacts:manage.
  assertEquals((await as(app, NO_ARTIFACTS, () => get(app, "/v1/artifacts"))).status, 403);
  assertEquals(
    (await as(app, NO_ARTIFACTS, () => get(app, `/v1/artifacts/${ids[1]}`))).status,
    403,
  );
  assertEquals((await as(app, VIEWER, () => get(app, `/v1/artifacts/${ids[1]}`))).status, 200);
  const viewerDelete = await as(app, VIEWER, () => del(app, `/v1/artifacts/${ids[1]}`));
  assertEquals([viewerDelete.status, (await viewerDelete.json()).capability], [
    403,
    "artifacts:manage",
  ]);
  assertEquals(
    (await as(app, OTHER_MEMBER, () => del(app, `/v1/artifacts/${ids[1]}`))).status,
    403,
    "a member who did not ask for it cannot either",
  );
  // Who may: an operator, and whoever first asked for it — and the page says so.
  const canDelete = async (who: Caller, id: string) =>
    (await (await as(app, who, () => get(app, `/v1/artifacts/${id}`))).json()).canDelete;
  assertEquals(
    [
      await canDelete(VIEWER, ids[1]),
      await canDelete(OTHER_MEMBER, ids[1]),
      await canDelete(MEMBER, ids[1]),
      await canDelete(OPERATOR, ids[1]),
    ],
    [false, false, true, true],
  );
  // The asker's own read-only token (artifacts:read without tasks:create) takes nothing down.
  assertEquals(await canDelete(READ_ONLY_ASKER, ids[2]), false);
  const readOnlyDelete = await as(app, READ_ONLY_ASKER, () => del(app, `/v1/artifacts/${ids[2]}`));
  assertEquals([readOnlyDelete.status, (await readOnlyDelete.json()).capability], [
    403,
    "artifacts:manage",
  ]);
  assertEquals((await as(app, OPERATOR, () => del(app, `/v1/artifacts/${ids[1]}`))).status, 204);
  assertEquals((await as(app, OPERATOR, () => del(app, `/v1/artifacts/${ids[1]}`))).status, 404);
  assertEquals((await del(app, `/v1/artifacts/${ids[2]}`)).status, 204, "the asker deletes");
  // Purged: the tombstone keeps no title and no versions.
  assertEquals(app.artifacts.rows.get(ids[2])?.title, "");
  assertEquals(app.artifacts.versionRows.get(ids[2]), undefined);

  // Deleted is gone from every read.
  assertEquals((await get(app, `/v1/artifacts/${ids[1]}`)).status, 404);
  const after = await (await get(app, "/v1/artifacts")).json();
  assert(!after.artifacts.some((a: { id: string }) => a.id === ids[1]));
});

test("task detail: lists the artifacts its runs created or versioned, with the versions they did", async () => {
  const app = buildApp();
  const ada = await agentWithRun(app);
  const mine = (await (await publish(app, ada, { title: "Mine", html: "<p>1</p>" })).json()).id;
  await publish(app, ada, { title: "Mine v2", html: "<p>2</p>", artifactId: mine });
  // Versioned by a later task of the same agent: listed there with only its own version.
  const later = await runOf(app, ada.agent.id);
  await publish(app, later, { title: "Mine v3", html: "<p>3</p>", artifactId: mine });
  const dropped = (await (await publish(app, ada, { title: "Dropped", html: "<p>x</p>" })).json())
    .id;
  await as(app, OPERATOR, () => del(app, `/v1/artifacts/${dropped}`));

  const detail = await (await get(app, `/v1/tasks/${ada.taskId}`)).json();
  assertEquals(detail.artifacts, [{
    id: mine,
    title: "Mine v3",
    currentVersion: 3,
    updatedAt: detail.artifacts[0].updatedAt,
    versions: [
      { version: 1, runId: ada.runId, createdAt: detail.artifacts[0].versions[0].createdAt },
      { version: 2, runId: ada.runId, createdAt: detail.artifacts[0].versions[1].createdAt },
    ],
  }]);
  assert(detail.artifacts[0].versions.every((v: { createdAt: string }) => v.createdAt !== ""));
  const laterDetail = await (await get(app, `/v1/tasks/${later.taskId}`)).json();
  assertEquals(
    laterDetail.artifacts.map((a: { versions: Array<{ version: number; runId: string }> }) =>
      a.versions.map(({ version, runId }) => ({ version, runId }))
    ),
    [[{ version: 3, runId: later.runId }]],
  );
  // A reader without artifacts:read sees the task, not its artifacts.
  const hidden = await as(app, NO_ARTIFACTS, () => get(app, `/v1/tasks/${ada.taskId}`));
  assertEquals((await hidden.json()).artifacts, []);
});

test("start: an agent that may publish artifacts is pinned to the design skill over its own switch", async () => {
  const app = buildApp();
  const { agent } = await agentWithRun(app);
  const row = (await app.store.getAgent(agent.id))!;
  const repo = (await app.store.getConnectedRepo(repos.get(app)!.id))!;
  const deps: StartTaskDeps = {
    ...app.deps,
    forge: null,
    serviceCatalogue: null,
    skillCatalogue: await directorySkillCatalogue(),
    skills: null,
    memoryAccess: null,
    environments: null,
    modelAccess: null,
    chatAccess: null,
    platformModel: null,
  };
  const start = async (canPublishArtifacts: boolean) => {
    const started = await startTask(deps, {
      // pi reads skills; the agent turned the design skill off for itself.
      agent: {
        ...row,
        harnessKind: "pi",
        canPublishArtifacts,
        skillPolicy: {
          catalogue: { disabled: [ARTIFACT_SKILL] },
          org: { enabled: true, disabled: [] },
          workingRepos: { enabled: true },
        },
      },
      spec: { title: "Research", instructions: "Overview please" },
      repos: [{
        connectedRepo: repo,
        url: repo.url,
        ref: "main",
        path: "app",
        name: "acme/app",
        description: null,
      }],
      origin: "user",
      requestedByUserId: MEMBER.userId,
    });
    assert(started.kind === "started", JSON.stringify(started));
    const run = (await app.store.getRun(started.runId))!;
    return (run.skills?.skills ?? []).map((s) => s.name);
  };
  assert((await start(true)).includes(ARTIFACT_SKILL));
  // Without the switch the skill is not given at all: it is about a tool the run does not hold.
  assert(!(await start(false)).includes(ARTIFACT_SKILL));
});

test("publish: a document is never refused for text that looks like a tag; characters and titles are held at the door", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  // Hidden by a parser trick, or written in a script string: the publish goes; what is served
  // is what the browser's parse leaves, the live tags out.
  const hidden = await publish(app, run, {
    title: "T",
    html: '<svg><foreignObject><div></foreignObject><style><!--</style><base href="x">' +
      '<script>const s = "<meta http-equiv=refresh content=0>";</script>',
  });
  assertEquals(hidden.status, 201);
  const { id: hiddenId } = await hidden.json();
  const served = await (await get(app, `/v1/artifacts/${hiddenId}/versions/1/content`)).text();
  assert(!served.includes('<base href="x">'), served);
  assertStringIncludes(served, 'const s = "<meta http-equiv=refresh content=0>";');
  // fetch_artifact answers the document as the agent wrote it.
  const fetched =
    await (await get(app, `/v1/runs/${run.runId}/artifacts/${hiddenId}`, run.runToken))
      .json();
  assertStringIncludes(fetched.html, '<base href="x">');

  assertEquals((await publish(app, run, { title: "T", html: "<p>\0</p>" })).status, 400);
  assertEquals((await publish(app, run, { title: "T\0", html: "<p>x</p>" })).status, 400);
  // A title of nothing visible is no title.
  for (const title of ["\u3164", "\u200b \u200b", "\u202e\u202c"]) {
    const invisible = await publish(app, run, { title, html: "<p>x</p>" });
    assertEquals(invisible.status, 400, JSON.stringify(title));
    assertStringIncludes((await invisible.json()).error, "visible");
  }

  const ok = await publish(app, run, {
    title: "\u202eReport\u202c\nfor\u200b ada\u2028v2",
    html: "<p>y</p>",
  });
  assertEquals(ok.status, 201);
  const { id } = await ok.json();
  assertEquals((await (await get(app, `/v1/artifacts/${id}`)).json()).title, "Report for ada v2");
  const events = (await app.store.listEvents(run.runId))
    .filter((e) => e.kind === "artifact-published").map((e) => e.detail);
  assertEquals(events.at(-1), 'Published "Report for ada v2" (version 1)');
});

test("publish: a run hands the sanitizer at most so many pages an hour, refused ones and deleted ones counted", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const html = inProcessHtml(app);
  // Half refused by the sanitizer, half published; one of those then deleted.
  const half = MAX_ARTIFACT_ATTEMPTS_PER_HOUR / 2;
  for (let i = 0; i < half; i++) {
    app.clock.advance(60_000);
    const crafted = await publish(app, run, { title: `C${i}`, html: `<p${tooManyAttributes(i)}>` });
    assertEquals(crafted.status, 400);
  }
  let first = "";
  for (let i = 0; i < half; i++) {
    app.clock.advance(60_000);
    const res = await publish(app, run, { title: `P${i}`, html: `<p>${i}</p>` });
    assertEquals(res.status, 201);
    if (i === 0) first = (await res.json()).id;
  }
  assertEquals(html.prepared(), MAX_ARTIFACT_ATTEMPTS_PER_HOUR);
  assertEquals((await as(app, OPERATOR, () => del(app, `/v1/artifacts/${first}`))).status, 204);
  const over = await publish(app, run, { title: "One more", html: "<p>more</p>" });
  assertEquals(over.status, 429);
  const error = (await over.json()).error;
  assertStringIncludes(
    error,
    `${MAX_ARTIFACT_ATTEMPTS_PER_HOUR} pages to publish in the last hour`,
  );
  // The first went 29 minutes before the thirtieth.
  assertStringIncludes(error, "in 31 minutes");
  assertEquals(html.prepared(), MAX_ARTIFACT_ATTEMPTS_PER_HOUR, "refused before the sanitizer");
  // The same page again is answered before the sanitizer and the hour.
  const same = await publish(app, run, { title: `P${half - 1}`, html: `<p>${half - 1}</p>` });
  assertEquals([same.status, (await same.json()).unchanged], [200, true]);
  app.clock.advance(30 * 60_000);
  assertEquals((await publish(app, run, { title: "One more", html: "<p>more</p>" })).status, 429);
  // Once the first is an hour old, one more goes.
  app.clock.advance(60_000);
  assertEquals((await publish(app, run, { title: "One more", html: "<p>more</p>" })).status, 201);
});

test("publish: one page of a run's at a time, and only so many of everyone's; past either it is refused at once", async () => {
  // Two slots, not production's one, so a second run can hold one while a third finds none.
  const app = buildApp({ htmlSlots: 2 });
  const html = inProcessHtml(app);
  const ada = await agentWithRun(app);
  const bob = await runOf(app, ada.agent.id);
  const cy = await runOf(app, ada.agent.id);
  const open = html.hold();
  const slow = publish(app, ada, { title: "Slow", html: "<p>slow</p>" });
  // Let the held publish reach the sanitizer.
  while (html.prepared() < 1) await new Promise((r) => setTimeout(r, 1));
  const again = await publish(app, ada, { title: "Other", html: "<p>other</p>" });
  assertEquals(again.status, 429);
  assertStringIncludes((await again.json()).error, "still being finished");
  // Another run takes the second slot; a third finds none.
  const bobs = publish(app, bob, { title: "Bob", html: "<p>bob</p>" });
  while (html.prepared() < 2) await new Promise((r) => setTimeout(r, 1));
  const full = await publish(app, cy, { title: "Cy", html: "<p>cy</p>" });
  assertEquals(full.status, 429);
  const words = (await full.json()).error;
  assertStringIncludes(words, "as many pages as it can at once");
  assertEquals(words.match(/try again/gi)?.length, 1, words);
  open();
  assertEquals([(await slow).status, (await bobs).status], [201, 201]);
  // Neither refusal was counted, and the slots are free again.
  assertEquals(html.prepared(), 2);
  assertEquals((await publish(app, cy, { title: "Cy", html: "<p>cy</p>" })).status, 201);
});

test("publish: the same new page twice from one run is one page", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const first = await publish(app, run, { title: "Report", html: "<h1>Q3</h1>" });
  assertEquals(first.status, 201);
  const { id, url } = await first.json();
  // The answer was lost; the agent publishes again without the id.
  const again = await publish(app, run, { title: "Report", html: "<h1>Q3</h1>" });
  assertEquals(again.status, 200);
  assertEquals(await again.json(), { id, version: 1, url, unchanged: true });
  assertEquals(app.artifacts.rows.size, 1);
  // Another run of the same agent publishing the same page makes its own.
  const other = await runOf(app, run.agent.id);
  assertEquals((await publish(app, other, { title: "Report", html: "<h1>Q3</h1>" })).status, 201);
});

test("agents: an edit read before an admin switched publishing off cannot switch it back on", async () => {
  const app = buildApp();
  const { agent } = await agentWithRun(app);
  const base = app.store;
  let reads = 0;
  const racing = {
    ...base,
    async getAgent(id: string) {
      const read = await base.getAgent(id);
      if (++reads === 1 && read !== null) await base.setAgentCanPublishArtifacts(id, true, false);
      return read;
    },
  };
  const handler = makeHandler({ ...app.deps, store: racing });
  const renamed = await handler(
    new Request(`${BASE}/v1/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ name: "Renamed" }),
    }),
  );
  assertEquals(renamed.status, 200);
  const after = (await base.getAgent(agent.id))!;
  assertEquals([after.name, after.canPublishArtifacts], ["Renamed", false]);
  // A full-row save never writes the switch; the conditional write does.
  await base.saveAgent({ ...after, canPublishArtifacts: true });
  assertEquals((await base.getAgent(agent.id))!.canPublishArtifacts, false);
});

test("publish: the same title and document again change nothing and say so", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const { id } = await (await publish(app, run, { title: "T", html: "<p>x</p>" })).json();
  const same = await publish(app, run, { title: "T", html: "<p>x</p>", artifactId: id });
  assertEquals(same.status, 200);
  assertEquals(await same.json(), {
    id,
    version: 1,
    url: `https://ryph.test/artifacts/${id}`,
    unchanged: true,
  });
  const events = (await app.store.listEvents(run.runId))
    .filter((e) => e.kind === "artifact-published");
  assertEquals(events.length, 1, "no event for nothing");
});

test("publish: another person's task of the same agent cannot version a page someone else asked for", async () => {
  const app = buildApp();
  const ada = await agentWithRun(app);
  const { id } = await (await publish(app, ada, { title: "Ada's", html: "<p>a</p>" })).json();
  // Bob asks the same agent: a run for him may not rewrite Ada's page.
  app.identities.link(OTHER_MEMBER.userId, "noop-bob");
  const bob = await as(app, OTHER_MEMBER, () => runOf(app, ada.agent.id));
  const theirs = await publish(app, bob, { title: "Bob's", html: "<p>b</p>", artifactId: id });
  assertEquals(theirs.status, 404);
  // Nor read it back: fetching follows the versioning rule.
  const fetched = await get(app, `/v1/runs/${bob.runId}/artifacts/${id}`, bob.runToken);
  assertEquals(fetched.status, 404, "fetching follows the versioning rule");
  // Ada's next task may.
  const again = await runOf(app, ada.agent.id);
  assertEquals(
    (await publish(app, again, { title: "Ada's v2", html: "<p>a2</p>", artifactId: id })).status,
    200,
  );
  // The page names who asked for each version.
  const page = await (await get(app, `/v1/artifacts/${id}`)).json();
  assertEquals(
    page.versions.map((v: { requestedBy: unknown }) => v.requestedBy),
    [{ id: MEMBER.userId, name: "Ada Lovelace" }, { id: MEMBER.userId, name: "Ada Lovelace" }],
  );
});

test("publish: images over the byte caps are refused, and an update carries the refs it already shows", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const ref = await keepImage(app, run);
  const { id } = await (await publish(app, run, {
    title: "Pics",
    html: `<img src="${ref}">`,
  })).json();

  // A later run of the same task-less agent, for the same person: the ref is not one of ITS
  // images, but the version it updates shows it, so it carries.
  const later = await runOf(app, run.agent.id);
  const carried = await publish(app, later, {
    title: "Pics v2",
    html: `<p>more</p><img src="${ref}">`,
    artifactId: id,
  });
  assertEquals(carried.status, 200);
  const served = await (await get(app, `/v1/artifacts/${id}/versions/2/content`)).text();
  assertStringIncludes(served, `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
  // Without an artifact to update, the same ref is unknown to that run.
  assertEquals(
    (await publish(app, later, { title: "New", html: `<img src="${ref}">` })).status,
    400,
  );

  // Inlined: every use counts. A big image used many times passes the 2 MiB document cap but
  // not the 16 MiB inline one.
  const big = new Uint8Array(600 * 1024);
  big.set(PNG);
  big[100] = 1;
  const bigRef = await keepImage(app, run, big);
  const many = await publish(app, run, {
    title: "Many",
    html: `<img src="${bigRef}">`.repeat(30),
  });
  assertEquals(many.status, 400);
  assertStringIncludes((await many.json()).error, `${MAX_ARTIFACT_INLINED_BYTES} bytes (16 MiB)`);
  assertEquals(
    (await publish(app, run, { title: "Once", html: `<img src="${bigRef}">` })).status,
    201,
  );
  assert(MAX_ARTIFACT_IMAGE_BYTES === 10 * 1024 * 1024);
});

test("fetch: a run reads back its agent's artifact as published; nothing else", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const ref = await keepImage(app, run);
  const html = `<!doctype html><img src="${ref}">`;
  const { id } = await (await publish(app, run, { title: "T", html })).json();
  const res = await get(app, `/v1/runs/${run.runId}/artifacts/${id}`, run.runToken);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { id, title: "T", version: 1, html });

  const other = await agentWithRun(app, { name: "Bob" });
  assertEquals(
    (await get(app, `/v1/runs/${other.runId}/artifacts/${id}`, other.runToken)).status,
    404,
  );
  assertEquals(
    (await get(app, `/v1/runs/${run.runId}/artifacts/${id}`, other.runToken)).status,
    401,
  );
  // The switch off, live: refused.
  await json(app, "PATCH", `/v1/agents/${run.agent.id}`, { canPublishArtifacts: false });
  assertEquals((await get(app, `/v1/runs/${run.runId}/artifacts/${id}`, run.runToken)).status, 403);
});

test("agents: switching artifacts on takes agents:policy, off anyone who may edit", async () => {
  const app = buildApp();
  const created = await json(app, "POST", "/v1/agents", {
    name: "Cy",
    email: "cy@example.com",
    harnessKind: "echo",
    canPublishArtifacts: true,
  });
  assertEquals([created.status, (await created.json()).capability], [403, "agents:policy"]);
  const plain = await (await json(app, "POST", "/v1/agents", {
    name: "Cy",
    email: "cy@example.com",
    harnessKind: "echo",
  })).json();
  const on = await json(app, "PATCH", `/v1/agents/${plain.id}`, { canPublishArtifacts: true });
  assertEquals([on.status, (await on.json()).capability], [403, "agents:policy"]);
  const byAdmin = await as(
    app,
    OPERATOR,
    () => json(app, "PATCH", `/v1/agents/${plain.id}`, { canPublishArtifacts: true }),
  );
  assertEquals(byAdmin.status, 200);
  // Resent as it is, or switched off: a member may.
  assertEquals(
    (await json(app, "PATCH", `/v1/agents/${plain.id}`, { canPublishArtifacts: true })).status,
    200,
  );
  assertEquals(
    (await json(app, "PATCH", `/v1/agents/${plain.id}`, { canPublishArtifacts: false })).status,
    200,
  );
});

test("publish: an archived agent publishes nothing, whatever its switch says", async () => {
  const app = buildApp();
  const run = await agentWithRun(app);
  const agent = (await app.store.getAgent(run.agent.id))!;
  await app.store.saveAgent({ ...agent, archivedAt: new Date().toISOString() });
  assertEquals((await publish(app, run, { title: "T", html: "<p>x</p>" })).status, 403);
});
