// The ArtifactStore contract, held to BOTH implementations: the drizzle store over a real
// PostgreSQL (PGlite, or RYPH_TEST_DB) and the in-memory double the route suites run on. New
// artifacts and versions numbered in order, the versioning rule (same task, same chat
// conversation, same person), an unchanged publish writing nothing (a new one included), the
// version cap, the per-run hourly attempts (a delete gives none back), a deleted artifact purged
// and gone from every read, a concluded run refusing every write, the list's order and paging,
// and what a task's runs published.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  type ArtifactPublish,
  MAX_ARTIFACT_ATTEMPTS_PER_HOUR,
  MAX_ARTIFACT_VERSIONS,
} from "../src/core/artifacts.ts";
import type { Attachment, Run, Task } from "../src/core/types.ts";
import type { ArtifactStore } from "../src/ports/artifact_store.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import { drizzleArtifactStore } from "../src/adapters/store/drizzle_artifacts.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { memoryArtifactStore } from "./artifact_doubles.ts";
import { memoryTaskStore } from "./memory_store.ts";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

/** An agent, and a running run on a task, for the table's foreign key and the lock to take. */
async function seed(
  tasks: TaskStore,
  runId = "r-1",
  agentId = "a-1",
  requestedBy = "u-1",
  how: { origin?: Task["origin"]; chat?: [string, string] } = {},
): Promise<Run> {
  if ((await tasks.getAgent(agentId)) === null) {
    await tasks.createAgent({
      id: agentId,
      name: "Ada",
      handle: agentId,
      email: "ada@example.com",
      systemPrompt: null,
      harnessKind: "echo",
      modelPolicy: null,
      toolPolicy: null,
      memoryPolicy: null,
      forgePolicy: null,
      networkPolicy: null,
      limitPolicy: null,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    } as never);
  }
  const run = {
    id: runId,
    taskId: `t-${runId}`,
    agentId,
    state: "running",
    phase: null,
    heartbeatSeq: 0,
    lastHeartbeatAt: null,
    desiredState: null,
    cancelRequestedAt: null,
    attended: false,
    idleDeadlineAt: null,
    originThreadRepoId: null,
    originThreadKind: null,
    originThreadRef: null,
    originChatroomId: how.chat?.[0] ?? null,
    originThreadKey: how.chat?.[1] ?? null,
    tokenHash: "h",
    controlToken: "c",
    handle: null,
    launchedAt: null,
    branchNamespace: "b",
    image: null,
    environmentId: null,
    environment: null,
    environmentWait: null,
    workItem: {} as never,
    injectedContext: null,
    modelScope: null,
    toolScope: null,
    forgeScope: null,
    services: null,
    networkScope: { mode: "open" } as never,
    limits: { deadlineMs: null, spendUsd: null, callsInFlight: null } as never,
    egressRefusals: null,
    result: null,
    memoryOutcomeReportedAt: null,
    skillsReportedAt: null,
    createdAt: T0,
    updatedAt: T0,
  } as unknown as Run;
  await tasks.createTask({
    id: `t-${runId}`,
    agentId,
    spec: { title: "T", instructions: "I" },
    repos: [],
    workspaceId: null,
    origin: how.origin ?? (how.chat ? "chat" : "user"),
    requestedByUserId: requestedBy,
    requestedVia: null,
    targetChangeRequest: null,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    purpose: null,
    createdAt: T0,
  } as never, run);
  return run;
}

const publish = (over: Partial<ArtifactPublish> = {}): ArtifactPublish => ({
  newId: "art-1",
  artifactId: null,
  runId: "r-1",
  taskId: "t-r-1",
  agentId: "a-1",
  requestedBy: "u-1",
  requestOrigin: "user",
  chatroomId: null,
  conversation: null,
  title: "Report",
  html: "<h1>Report</h1>",
  servedHtml: "<html><head></head><body><h1>Report</h1></body></html>",
  bytes: 15,
  images: [],
  at: T0,
  ...over,
});

const implementations: Array<
  [string, () => Promise<{ store: ArtifactStore; tasks: TaskStore }>]
> = [
  ["drizzle", async () => {
    const handle = await makeTestDb();
    return { store: drizzleArtifactStore(handle), tasks: drizzleTaskStore(handle) };
  }],
  ["memory", () => {
    const tasks = memoryTaskStore();
    return Promise.resolve({ store: memoryArtifactStore(tasks), tasks });
  }],
];

for (const [kind, make] of implementations) {
  test(`${kind}: a new artifact, then its versions in order, each with its images`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const image: Attachment = {
      id: "at-1",
      runId: "r-1",
      mime: "image/png",
      bytes: 12,
      sha256: "0123456789ab".padEnd(64, "0"),
      ref: "img-0123456789ab",
      source: "agent",
      storageKey: "attachments/r-1/at-1",
      claimedBy: "tool",
      createdAt: T0,
    };
    assertEquals(
      await tasks.createAgentAttachment(image, { maxCount: 10, maxBytes: 1_000_000 }),
      { kind: "created" },
    );

    assertEquals(await store.publish(publish()), {
      kind: "published",
      id: "art-1",
      version: 1,
      created: true,
    });
    assertEquals(
      await store.publish(publish({
        newId: "art-unused",
        artifactId: "art-1",
        title: "Report v2",
        html: '<img src="img-0123456789ab">',
        servedHtml: '<img src="ryph-img:img-0123456789ab">',
        images: [{ ref: "img-0123456789ab", attachmentId: "at-1" }],
        at: T1,
      })),
      { kind: "published", id: "art-1", version: 2, created: false },
    );
    assertEquals(await store.get("art-unused"), null);
    assertEquals(await store.get("art-1"), {
      id: "art-1",
      title: "Report v2",
      agentId: "a-1",
      originRunId: "r-1",
      requestedBy: "u-1",
      requestOrigin: "user",
      originChatroomId: null,
      originConversation: null,
      currentVersion: 2,
      createdAt: T0,
      updatedAt: T1,
      deletedAt: null,
    });
    assertEquals(await store.versions("art-1"), [
      {
        version: 1,
        title: "Report",
        runId: "r-1",
        taskId: "t-r-1",
        requestedBy: "u-1",
        bytes: 15,
        createdAt: T0,
      },
      {
        version: 2,
        title: "Report v2",
        runId: "r-1",
        taskId: "t-r-1",
        requestedBy: "u-1",
        bytes: 15,
        createdAt: T1,
      },
    ]);
    assertEquals(await store.versionContent("art-1", 1), {
      html: "<h1>Report</h1>",
      servedHtml: "<html><head></head><body><h1>Report</h1></body></html>",
      images: [],
    });
    assertEquals(await store.versionContent("art-1", 2), {
      html: '<img src="img-0123456789ab">',
      servedHtml: '<img src="ryph-img:img-0123456789ab">',
      images: [{ ref: "img-0123456789ab", attachmentId: "at-1" }],
    });
    assertEquals(await store.versionContent("art-1", 3), null);
  });

  test(`${kind}: another agent, a deleted artifact or an unknown id is not found`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await seed(tasks, "r-2", "a-2");
    await store.publish(publish());
    assertEquals(
      await store.publish(
        publish({ runId: "r-2", taskId: "t-r-2", agentId: "a-2", artifactId: "art-1" }),
      ),
      { kind: "not_found" },
    );
    assertEquals(await store.publish(publish({ artifactId: "art-nope" })), { kind: "not_found" });
    assertEquals(await store.delete("art-1", T1), true);
    assertEquals(await store.delete("art-1", T2), false, "deleting twice deletes nothing");
    assertEquals(await store.publish(publish({ artifactId: "art-1" })), { kind: "not_found" });
    assertEquals(await store.get("art-1"), null);
    assertEquals(await store.versions("art-1"), []);
    assertEquals(await store.versionContent("art-1", 1), null);
    assertEquals(await store.list({ limit: 10, before: null }), []);
    assertEquals(await store.forRuns(["r-1"]), []);
  });

  test(`${kind}: a concluded or unknown run takes no write`, async () => {
    const { store, tasks } = await make();
    const run = await seed(tasks);
    await store.publish(publish());
    await tasks.saveRunResult({ ...run, state: "succeeded" });
    assertEquals(await store.publish(publish({ newId: "art-2" })), { kind: "concluded" });
    assertEquals(await store.publish(publish({ artifactId: "art-1" })), { kind: "concluded" });
    assertEquals(await store.publish(publish({ runId: "r-nope" })), { kind: "concluded" });
    assertEquals((await store.get("art-1"))?.currentVersion, 1);
  });

  test(`${kind}: the list is newest first and pages on a cursor; a task's runs list theirs`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await seed(tasks, "r-2");
    await store.publish(publish({ newId: "art-a", at: T0 }));
    await store.publish(publish({ newId: "art-b", html: "<h1>B</h1>", at: T1 }));
    await store.publish(publish({ newId: "art-c", runId: "r-2", at: T1 }));
    const ids = async (before: { updatedAt: string; id: string } | null, limit = 10) =>
      (await store.list({ limit, before })).map((a) => a.id);
    assertEquals(await ids(null), ["art-c", "art-b", "art-a"]);
    assertEquals(await ids(null, 2), ["art-c", "art-b"]);
    assertEquals(await ids({ updatedAt: T1, id: "art-b" }), ["art-a"]);
    assertEquals(await ids({ updatedAt: T1, id: "art-c" }), ["art-b", "art-a"]);

    // A version from the second run moves art-a to the top, and lists it for that run too.
    await store.publish(publish({
      artifactId: "art-a",
      runId: "r-2",
      taskId: "t-r-2",
      html: "<h1>Report, again</h1>",
      at: T2,
    }));
    assertEquals(await ids(null), ["art-a", "art-c", "art-b"]);
    const of = async (runIds: string[]) =>
      (await store.forRuns(runIds)).map((r) => [r.artifact.id, r.versions.map((v) => v.version)]);
    assertEquals(await of(["r-1"]), [["art-a", [1]], ["art-b", [1]]]);
    assertEquals(await of(["r-2"]), [["art-a", [2]], ["art-c", [1]]]);
    assertEquals(await of(["r-1", "r-2"]), [["art-a", [1, 2]], ["art-b", [1]], ["art-c", [1]]]);
    assertEquals(await of([]), []);
    // Each version says when it was published.
    assertEquals((await store.forRuns(["r-1", "r-2"]))[0].versions, [
      { version: 1, runId: "r-1", createdAt: T0 },
      { version: 2, runId: "r-2", createdAt: T2 },
    ]);
  });
}

for (const [kind, make] of implementations) {
  test(`${kind}: a version comes from the same agent, in a task that made one or for the first asker`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    // The same agent, another task, another person: not theirs to rewrite.
    await seed(tasks, "r-2", "a-1", "u-2");
    // The same agent, another task, the person who first asked: theirs.
    await seed(tasks, "r-3", "a-1", "u-1");
    await store.publish(publish());
    const other = publish({
      runId: "r-2",
      taskId: "t-r-2",
      requestedBy: "u-2",
      artifactId: "art-1",
      html: "<p>2</p>",
    });
    assertEquals(await store.publish(other), { kind: "not_found" });
    const asker = publish({ runId: "r-3", taskId: "t-r-3", artifactId: "art-1", html: "<p>3</p>" });
    assertEquals((await store.publish(asker)).kind, "published");
    // A later run of the first task, for whoever: the task made a version, so it may.
    await seed(tasks, "r-4", "a-1", "u-2");
    const sameTask = publish({
      runId: "r-4",
      taskId: "t-r-1",
      requestedBy: "u-2",
      artifactId: "art-1",
      html: "<p>4</p>",
    });
    assertEquals(await store.publish(sameTask), {
      kind: "published",
      id: "art-1",
      version: 3,
      created: false,
    });
    assertEquals(
      (await store.versions("art-1")).map((v) => [v.version, v.taskId, v.requestedBy]),
      [[1, "t-r-1", "u-1"], [2, "t-r-3", "u-1"], [3, "t-r-1", "u-2"]],
    );
  });

  test(`${kind}: a chat conversation versions what it asked for; a room's owner or an automation is not the asker`, async () => {
    const { store, tasks } = await make();
    // Asked in a chat thread: the run acts for the room's owner, u-1.
    await seed(tasks, "r-1", "a-1", "u-1", { chat: ["room-1", "thread-1"] });
    const inChat = {
      requestOrigin: "chat" as const,
      chatroomId: "room-1",
      conversation: "thread-1",
    };
    await store.publish(publish(inChat));
    // A later mention in the same conversation: another task.
    await seed(tasks, "r-2", "a-1", "u-1", { chat: ["room-1", "thread-1"] });
    const again = publish({
      ...inChat,
      runId: "r-2",
      taskId: "t-r-2",
      artifactId: "art-1",
      html: "<p>2</p>",
    });
    assertEquals((await store.publish(again)).kind, "published");
    // Another conversation of the same room, for the same owner.
    await seed(tasks, "r-3", "a-1", "u-1", { chat: ["room-1", "thread-2"] });
    const otherThread = publish({
      ...inChat,
      conversation: "thread-2",
      runId: "r-3",
      taskId: "t-r-3",
      artifactId: "art-1",
      html: "<p>3</p>",
    });
    assertEquals(await store.publish(otherThread), { kind: "not_found" });
    // The room's owner asking in the app: they did not ask for the chat's page.
    await seed(tasks, "r-4", "a-1", "u-1");
    const owner = publish({ runId: "r-4", taskId: "t-r-4", artifactId: "art-1", html: "<p>4</p>" });
    assertEquals(await store.publish(owner), { kind: "not_found" });

    // Made by an automation's fire: no other task of the owner's versions it, and it versions
    // nothing the owner asked for in the app.
    await seed(tasks, "r-5", "a-1", "u-1", { origin: "automation" });
    await store.publish(publish({
      newId: "art-auto",
      runId: "r-5",
      taskId: "t-r-5",
      requestOrigin: "automation",
      html: "<p>auto</p>",
    }));
    await seed(tasks, "r-6", "a-1", "u-1");
    assertEquals(
      await store.publish(
        publish({ runId: "r-6", taskId: "t-r-6", artifactId: "art-auto", html: "<p>6</p>" }),
      ),
      { kind: "not_found" },
    );
    await store.publish(publish({ newId: "art-app", runId: "r-6", taskId: "t-r-6" }));
    assertEquals(
      await store.publish(publish({
        runId: "r-5",
        taskId: "t-r-5",
        requestOrigin: "automation",
        artifactId: "art-app",
        html: "<p>5</p>",
      })),
      { kind: "not_found" },
    );
    // The row keeps how it was asked for.
    const row = await store.get("art-1");
    assertEquals([row?.requestOrigin, row?.originChatroomId, row?.originConversation], [
      "chat",
      "room-1",
      "thread-1",
    ]);
  });

  test(`${kind}: the same title and document again write nothing; the caps hold`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.publish(publish());
    assertEquals(
      await store.publish(publish({ artifactId: "art-1", at: T1 })),
      { kind: "unchanged", id: "art-1", version: 1 },
    );
    assertEquals((await store.get("art-1"))?.updatedAt, T0, "nothing was written");
    // A new title alone is a new version.
    assertEquals(
      (await store.publish(publish({ artifactId: "art-1", title: "Renamed" }))).kind,
      "published",
    );

    // The same page published as NEW again by the run that made it: that page, nothing written.
    assertEquals(
      await store.publish(publish({ newId: "art-dup", title: "Renamed", at: T1 })),
      { kind: "unchanged", id: "art-1", version: 2 },
    );
    assertEquals(await store.get("art-dup"), null);
    // Another run's identical page is its own.
    await seed(tasks, "r-twin");
    assertEquals(
      (await store.publish(
        publish({ newId: "art-twin", runId: "r-twin", taskId: "t-r-twin", title: "Renamed" }),
      )).kind,
      "published",
    );

    // What a new publish of the same page asks before anything is sanitized.
    assertEquals(await store.createdByRunWith("r-1", "Renamed", "<h1>Report</h1>"), {
      id: "art-1",
      version: 2,
    });
    assertEquals(await store.createdByRunWith("r-1", "Report", "<h1>Report</h1>"), null);
    assertEquals(await store.createdByRunWith("r-twin", "Renamed", "<h1>Report</h1>"), {
      id: "art-twin",
      version: 1,
    });

    // The artifact's cap: a hundred versions, from any number of runs.
    await seed(tasks, "r-cap");
    await store.publish(publish({ newId: "art-cap", runId: "r-cap", taskId: "t-r-cap" }));
    for (let v = 2; v <= MAX_ARTIFACT_VERSIONS; v++) {
      const runId = `r-cap${Math.floor(v / 25)}`;
      if (v % 25 === 0 || v === 2) await seed(tasks, runId).catch(() => {});
      assertEquals(
        (await store.publish(publish({
          artifactId: "art-cap",
          runId,
          taskId: `t-${runId}`,
          html: `<p>${v}</p>`,
        }))).kind,
        "published",
        `version ${v}`,
      );
    }
    await seed(tasks, "r-last");
    assertEquals(
      await store.publish(publish({
        artifactId: "art-cap",
        runId: "r-last",
        taskId: "t-r-last",
        html: "<p>one too many</p>",
      })),
      { kind: "too_many_versions" },
    );
  });

  test(`${kind}: a run's attempts are counted over the hour, and a delete gives none back`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const minute = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();
    for (let i = 0; i < MAX_ARTIFACT_ATTEMPTS_PER_HOUR; i++) {
      assertEquals(await store.recordAttempt("r-1", minute(i)), { kind: "recorded" }, `#${i}`);
    }
    await store.publish(publish({ at: minute(29) }));
    assertEquals(await store.delete("art-1", minute(30)), true);
    // Full: free again when the oldest is an hour old.
    assertEquals(await store.recordAttempt("r-1", minute(40)), {
      kind: "rate_limited",
      retryAt: minute(60),
    });
    // The refusal is not an attempt: at the hour, exactly one more goes.
    assertEquals(await store.recordAttempt("r-1", minute(60)), { kind: "recorded" });
    assertEquals((await store.recordAttempt("r-1", minute(60))).kind, "rate_limited");
    // Each run has its own hour.
    await seed(tasks, "r-2");
    assertEquals(await store.recordAttempt("r-2", minute(60)), { kind: "recorded" });
    // A concluded run makes none.
    await tasks.saveRunResult({ ...(await tasks.getRun("r-2"))!, state: "succeeded" });
    assertEquals(await store.recordAttempt("r-2", minute(61)), { kind: "concluded" });
  });
}
