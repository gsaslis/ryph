// The org skills repo's sync: what each forge answer becomes (a version, the same version again,
// a failure counted rather than repeated), the rules the tree is judged by, the races the store's
// write settles (a push against a Sync now, a read outliving its repo), a rules bump forcing a
// re-read, and the push trigger from the forge event route.

import { test } from "bun:test";
import { assert, assertEquals, assertExists } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { drizzleSkillStore } from "../src/adapters/store/drizzle_skills.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import {
  judgeSkillsTree,
  MAX_ORG_SKILL_DIRS,
  MAX_SYNC_WARNINGS,
  type SkillsSyncDeps,
  syncOnPush,
  syncOrgSkills,
} from "../src/core/skills_sync.ts";
import { SKILL_RULES_VERSION, skillDigest } from "../src/core/skills.ts";
import type { ConnectedRepo } from "../src/core/types.ts";
import type { ForgeSkills, SkillsTree } from "../src/ports/forge.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { makeTestDb } from "./db.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const COMMIT_1 = "1".repeat(40);
const COMMIT_2 = "2".repeat(40);
const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const b64 = (s: string | Uint8Array) =>
  (typeof s === "string" ? new TextEncoder().encode(s) : s).toBase64();

function repo(id: string, archivedAt: string | null = null): ConnectedRepo {
  return {
    id,
    provider: "github",
    installationId: "i-1",
    repoRef: `acme/${id}`,
    url: `https://github.com/acme/${id}.git`,
    defaultBranch: "main",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt,
    createdAt: T0,
    updatedAt: T0,
  };
}

function skillMd(name: string, description = `Use when ${name} comes up.`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
}

type TreeFile = Extract<SkillsTree, { kind: "tree" }>["files"][number];
const file = (path: string, content: string | Uint8Array, mode: TreeFile["mode"] = "100644") => ({
  path,
  mode,
  content: b64(content),
});

function treeOf(files: TreeFile[], tree = TREE_A, commit = COMMIT_1): SkillsTree {
  return { kind: "tree", commit, tree, files };
}

/** A forge whose answers the test scripts, recording what it was asked. */
function scriptedForge(answer: (knownTree: string | null) => SkillsTree | Promise<SkillsTree>) {
  const asked: Array<{ repoRef: string; commitOrRef: string; knownTree: string | null }> = [];
  const forge: ForgeSkills = {
    async readSkillsTree(r, _url, commitOrRef, knownTree) {
      asked.push({ repoRef: r.repoRef, commitOrRef, knownTree });
      return await answer(knownTree);
    },
  };
  return { forge, asked };
}

async function world(forge: ForgeSkills | null) {
  const handle = await makeTestDb();
  const tasks = drizzleTaskStore(handle);
  const clock = fakeClock(T0);
  const skills = drizzleSkillStore(handle, clock.now);
  for (const r of [repo("cr-skills"), repo("cr-other"), repo("cr-gone", T0)]) {
    await tasks.createConnectedRepo(r);
  }
  const deps: SkillsSyncDeps = { skills, forge, diag: silentDiagnostics(), now: clock.now };
  return { handle, tasks, skills, clock, deps };
}

test("nothing connected, or an archived repo, has nothing to sync", async () => {
  const { forge, asked } = scriptedForge(() => treeOf([]));
  const w = await world(forge);
  try {
    assertEquals(await syncOrgSkills(w.deps, "reconcile", null), { kind: "not-connected" });
    await w.skills.setOrgRepo({ connectedRepoId: "cr-gone", branch: null }, null);
    assertEquals(await syncOrgSkills(w.deps, "reconcile", null), { kind: "not-connected" });
    assertEquals(asked.length, 0);
  } finally {
    await w.handle.close();
  }
});

test("a tree becomes the version: valid skills kept byte for byte, the rest warned about", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const { forge, asked } = scriptedForge(() =>
    treeOf([
      file("README.md", "the org's skills\n"),
      file("deploy/SKILL.md", skillMd("deploy", "Use when shipping.")),
      file("deploy/assets/logo.png", png),
      file("deploy/scripts/run.sh", "#!/bin/sh\n", "100755"),
      file("deploy/link.md", "", "120000"),
      file("ryph-mine/SKILL.md", skillMd("ryph-mine")),
      file("broken/SKILL.md", "no frontmatter\n"),
    ])
  );
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const outcome = await syncOrgSkills(w.deps, "connect", "u-admin");
    assert(outcome.kind === "synced");
    assertEquals(asked, [{ repoRef: "acme/cr-skills", commitOrRef: "main", knownTree: null }]);
    const { sync } = outcome;
    assertEquals(
      [sync.trigger, sync.outcome, sync.commit, sync.treeId, sync.skillCount, sync.requestedBy],
      ["connect", "synced", COMMIT_1, TREE_A, 1, "u-admin"],
    );
    assertEquals(sync.rulesVersion, SKILL_RULES_VERSION);
    const paths = sync.warnings.map((w) => w.path);
    // The link inside a skill, the reserved name, the file with no frontmatter; never the README.
    assertEquals(paths, ["broken/SKILL.md", "deploy/link.md", "ryph-mine/SKILL.md"]);

    const current = await w.skills.currentOrg();
    assertExists(current);
    assertEquals(current.skills.map((s) => [s.name, s.description]), [[
      "deploy",
      "Use when shipping.",
    ]]);
    const bundle = await w.skills.bundle(current.skills[0].digest);
    assertExists(bundle);
    const byPath = new Map(bundle.files.map((f) => [f.path, f]));
    assertEquals(Uint8Array.fromBase64(byPath.get("assets/logo.png")!.content), png);
    assertEquals(byPath.get("scripts/run.sh")!.executable, true);
    assertEquals(byPath.has("link.md"), false);
    // The digest is the source bytes' and modes', so the runner can check what it fetched.
    assertEquals(
      bundle.digest,
      await skillDigest(
        bundle.files.map((f) => ({
          path: f.path,
          executable: f.executable,
          bytes: Uint8Array.fromBase64(f.content),
        })),
      ),
    );
  } finally {
    await w.handle.close();
  }
});

test("the tree runs already get is up to date: the forge is told it, and no row is added", async () => {
  let tree = TREE_A;
  const { forge, asked } = scriptedForge((knownTree) =>
    knownTree === tree
      ? { kind: "unchanged", commit: COMMIT_2, tree }
      : treeOf([file("deploy/SKILL.md", skillMd("deploy"))], tree)
  );
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    assertEquals((await syncOrgSkills(w.deps, "connect", null)).kind, "synced");
    w.clock.advance(60_000);
    assertEquals(await syncOrgSkills(w.deps, "push", null), { kind: "up-to-date" });
    assertEquals(asked[1].knownTree, TREE_A);
    const settings = (await w.skills.settings()).org!;
    assertEquals([settings.checkedCommit, settings.checkedAt], [
      COMMIT_2,
      "2026-10-01T00:01:00.000Z",
    ]);
    assertEquals((await w.skills.syncs({ limit: 10 })).syncs.length, 1);

    // The tree moves: a second version.
    tree = TREE_B;
    assertEquals((await syncOrgSkills(w.deps, "push", null)).kind, "synced");
    assertEquals((await w.skills.syncs({ limit: 10 })).syncs.length, 2);
  } finally {
    await w.handle.close();
  }
});

test("a version judged by older rules is re-read whole and judged again", async () => {
  const { forge, asked } = scriptedForge(() =>
    treeOf([file("deploy/SKILL.md", skillMd("deploy"))])
  );
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    // What an older release recorded for this very tree.
    await w.skills.recordSync({
      id: "ss-old",
      connectedRepoId: "cr-skills",
      settingsBranch: null,
      branch: "main",
      trigger: "push",
      requestedBy: null,
      startedAt: T0,
    }, {
      kind: "tree",
      commit: COMMIT_1,
      treeId: TREE_A,
      rulesVersion: SKILL_RULES_VERSION - 1,
      skills: [],
      warnings: [],
      finishedAt: T0,
    });
    w.clock.advance(1_000);
    const outcome = await syncOrgSkills(w.deps, "reconcile", null);
    // The forge was not told the tree, so it handed it back whole, and it is a new version.
    assertEquals(asked[0].knownTree, null);
    assert(outcome.kind === "synced");
    assertEquals([outcome.sync.rulesVersion, outcome.sync.skillCount], [SKILL_RULES_VERSION, 1]);
  } finally {
    await w.handle.close();
  }
});

test("no .agents/skills is a version with no skills, and stays one", async () => {
  const { forge } = scriptedForge(() => ({ kind: "absent", commit: COMMIT_1 }));
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const first = await syncOrgSkills(w.deps, "connect", null);
    assert(first.kind === "synced");
    assertEquals([first.sync.treeId, first.sync.skillCount], [null, 0]);
    assertEquals((await w.skills.currentOrg())?.skills, []);
    assertEquals(await syncOrgSkills(w.deps, "reconcile", null), { kind: "up-to-date" });
  } finally {
    await w.handle.close();
  }
});

test("failures are recorded by kind, an identical one counts as a repeat, and runs go stale", async () => {
  let answer: SkillsTree = treeOf([file("deploy/SKILL.md", skillMd("deploy"))]);
  let throws = false;
  const { forge } = scriptedForge(() => {
    if (throws) throw new Error("socket hang up");
    return answer;
  });
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    assertEquals((await syncOrgSkills(w.deps, "connect", null)).kind, "synced");

    answer = { kind: "missing-ref" };
    w.clock.advance(1_000);
    const gone = await syncOrgSkills(w.deps, "reconcile", null);
    assert(gone.kind === "failed");
    assertEquals([gone.sync.failure, gone.sync.error], [
      "missing-ref",
      "branch main no longer exists",
    ]);
    w.clock.advance(1_000);
    const again = await syncOrgSkills(w.deps, "reconcile", null);
    assert(again.kind === "failed");
    assertEquals([again.sync.id, again.sync.repeats], [gone.sync.id, 2]);
    const current = await w.skills.currentOrg();
    assertEquals([current?.lastFailure?.id, current?.skills.length], [gone.sync.id, 1]);

    answer = { kind: "invalid", commit: COMMIT_2, detail: ".agents/skills holds 9 entries" };
    const invalid = await syncOrgSkills(w.deps, "manual", "u-admin");
    assert(invalid.kind === "failed");
    assertEquals([invalid.sync.failure, invalid.sync.commit], ["invalid", COMMIT_2]);

    answer = { kind: "unavailable", detail: "main could not be read from the repo" };
    const down = await syncOrgSkills(w.deps, "manual", null);
    assert(down.kind === "failed");
    assertEquals(down.sync.failure, "unavailable");

    throws = true;
    const broke = await syncOrgSkills(w.deps, "manual", null);
    assert(broke.kind === "failed");
    assertEquals([broke.sync.failure, broke.sync.error], ["error", "socket hang up"]);
  } finally {
    await w.handle.close();
  }
});

test("with no forge every read fails as unavailable", async () => {
  const w = await world(null);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const outcome = await syncOrgSkills(w.deps, "connect", null);
    assert(outcome.kind === "failed");
    assertEquals([outcome.sync.failure, outcome.sync.error], [
      "unavailable",
      "no forge is configured",
    ]);
    // The noop forge says the same: it reads no repo, so it claims no skills.
    const noop = noopForge(silentDiagnostics());
    const read = await noop.readSkillsTree(
      { provider: "github", repoRef: "acme/x", tenantId: null },
      "https://github.com/acme/x.git",
      "main",
      null,
    );
    assertEquals(read.kind, "unavailable");
  } finally {
    await w.handle.close();
  }
});

test("a push and a Sync now racing on one tree record one version", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { forge } = scriptedForge(async () => {
    await gate;
    return treeOf([file("deploy/SKILL.md", skillMd("deploy"))]);
  });
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const both = Promise.all([
      syncOrgSkills(w.deps, "push", null),
      syncOrgSkills(w.deps, "manual", "u-admin"),
    ]);
    release();
    const kinds = (await both).map((o) => o.kind).sort();
    assertEquals(kinds, ["synced", "up-to-date"]);
    assertEquals((await w.skills.syncs({ limit: 10 })).syncs.length, 1);
  } finally {
    await w.handle.close();
  }
});

test("an unchanged answer to a read that named no tree is a failure", async () => {
  const { forge } = scriptedForge(() => ({ kind: "unchanged", commit: COMMIT_1, tree: TREE_A }));
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const outcome = await syncOrgSkills(w.deps, "connect", null);
    assert(outcome.kind === "failed");
    assertEquals(outcome.sync.failure, "error");
    assertEquals(await w.skills.currentOrg(), null);
  } finally {
    await w.handle.close();
  }
});

test("a revert racing the push it reverts leaves runs on the tree the branch holds", async () => {
  const COMMIT_3 = "3".repeat(40);
  const deployAt = (tree: string, commit: string) =>
    treeOf(
      [
        file("deploy/SKILL.md", skillMd("deploy", tree === TREE_A ? "Use it." : "Reverted.")),
      ],
      tree,
      commit,
    );
  // The push's read of the reverted tree is held until the revert's read was answered too.
  const push = Promise.withResolvers<void>();
  const revert = Promise.withResolvers<void>();
  const pushAsked = Promise.withResolvers<void>();
  const revertAsked = Promise.withResolvers<void>();
  let calls = 0;
  const { forge, asked: questions } = scriptedForge(async (knownTree) => {
    switch (calls++) {
      case 0:
        return deployAt(TREE_A, COMMIT_1);
      case 1:
        pushAsked.resolve();
        await push.promise;
        return deployAt(TREE_B, COMMIT_2);
      case 2:
        revertAsked.resolve();
        await revert.promise;
        // The revert put the branch back on A, which is what the read named.
        return { kind: "unchanged", commit: COMMIT_3, tree: knownTree! };
      default:
        return deployAt(TREE_A, COMMIT_3);
    }
  });
  const w = await world(forge);
  try {
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    assertEquals((await syncOrgSkills(w.deps, "connect", null)).kind, "synced");
    w.clock.advance(1_000);
    const first = syncOrgSkills(w.deps, "push", null);
    await pushAsked.promise;
    w.clock.advance(1_000);
    const second = syncOrgSkills(w.deps, "push", null);
    await revertAsked.promise;
    push.resolve();
    assertEquals((await first).kind, "synced");
    revert.resolve();
    // The unchanged answer was about A, but runs are on B by now: it is read again, whole.
    const reread = await second;
    assert(reread.kind === "synced");
    assertEquals(questions.map((q) => q.knownTree), [null, TREE_A, TREE_A, null]);
    const org = await w.skills.currentOrg();
    assertEquals([org?.sync.treeId, org?.sync.commit], [TREE_A, COMMIT_3]);
    assertEquals((await w.skills.settings()).org?.checkedCommit, COMMIT_3);
  } finally {
    await w.handle.close();
  }
});

test("a read that outlives its repo or branch is history and moves nothing", async () => {
  let release!: () => void;
  let gate = new Promise<void>((resolve) => (release = resolve));
  // Resolved once the forge is asked, so the settings move while the read is in flight and not
  // before the sync has read them.
  let asking = Promise.withResolvers<void>();
  const { forge } = scriptedForge(async () => {
    asking.resolve();
    await gate;
    return treeOf([file("deploy/SKILL.md", skillMd("deploy"))]);
  });
  const w = await world(forge);
  try {
    // Another repo is picked while the read of the first is in flight.
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const slow = syncOrgSkills(w.deps, "push", null);
    await asking.promise;
    await w.skills.setOrgRepo({ connectedRepoId: "cr-other", branch: null }, null);
    release();
    const swapped = await slow;
    assert(swapped.kind === "superseded");
    assertEquals(swapped.sync?.connectedRepoId, "cr-skills");
    assertEquals((await w.skills.settings()).org?.currentSyncId, null);

    // Disconnected while in flight.
    gate = new Promise<void>((resolve) => (release = resolve));
    asking = Promise.withResolvers<void>();
    const orphan = syncOrgSkills(w.deps, "push", null);
    await asking.promise;
    await w.skills.setOrgRepo(null, null);
    release();
    assertEquals((await orphan).kind, "superseded");
    assertEquals(await w.skills.currentOrg(), null);
  } finally {
    await w.handle.close();
  }
});

test("the push trigger syncs only the skills repo, on the branch its settings read", async () => {
  const { forge, asked } = scriptedForge(() =>
    treeOf([file("deploy/SKILL.md", skillMd("deploy"))])
  );
  const w = await world(forge);
  try {
    assertEquals(await syncOnPush(w.deps, "cr-skills", "main"), null);
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    assertEquals(await syncOnPush(w.deps, "cr-other", "main"), null);
    assertEquals((await syncOnPush(w.deps, "cr-skills", "main"))?.kind, "synced");

    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: "skills" }, null);
    assertEquals(await syncOnPush(w.deps, "cr-skills", "main"), null);
    assertEquals((await syncOnPush(w.deps, "cr-skills", "skills"))?.kind, "synced");
    assertEquals(asked.map((a) => a.commitOrRef), ["main", "skills"]);
  } finally {
    await w.handle.close();
  }
});

test("judging a tree: the directory cut, the warning cap, links at the root", async () => {
  const many: TreeFile[] = [];
  for (let i = 0; i <= MAX_ORG_SKILL_DIRS; i++) {
    const name = `s${String(i).padStart(3, "0")}`;
    many.push(file(`${name}/SKILL.md`, skillMd(name)));
  }
  const cut = await judgeSkillsTree(many);
  assertEquals(cut.skills.length, MAX_ORG_SKILL_DIRS);
  assertEquals(cut.warnings.length, 1);
  assertEquals(cut.warnings[0].path, `s${MAX_ORG_SKILL_DIRS}`);

  const broken: TreeFile[] = [];
  for (let i = 0; i < MAX_SYNC_WARNINGS + 5; i++) broken.push(file(`b${i}/SKILL.md`, "nope\n"));
  // The cut's warning and one per broken directory read: two past the cap.
  const capped = await judgeSkillsTree(broken);
  assertEquals(capped.warnings.length, MAX_SYNC_WARNINGS);
  assertEquals(capped.warnings.at(-1)!.message, "and 2 more warnings");

  const links = await judgeSkillsTree([
    { path: "deploy", mode: "120000", content: null },
    { path: "vendor", mode: "160000", content: null },
    file("README.md", "hello\n"),
  ]);
  assertEquals(links.skills, []);
  assertEquals(links.warnings.map((w) => w.path), ["deploy", "vendor"]);
});

test("a push to the skills repo reaches the sync through the forge event route", async () => {
  const w = await world(null);
  try {
    const synced = Promise.withResolvers<void>();
    // The read is held until the delivery has been answered: a route that waited on the sync
    // would never answer, and the test fails.
    const read = Promise.withResolvers<void>();
    const forge = noopForge(silentDiagnostics(), {
      skillsTree: async () => {
        await read.promise;
        return treeOf([file("deploy/SKILL.md", skillMd("deploy"))]);
      },
    });
    await w.skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, null);
    const handler = makeHandler({
      store: w.tasks,
      provisioner: fakeProvisioner().provisioner,
      runnerControl: fakeRunnerControl().control,
      diag: {
        debug: (event) => event === "skills.synced" && synced.resolve(),
        warn: (event) => event === "skills.sync_failed" && synced.resolve(),
      },
      authenticate: (() => Promise.reject(new Error("no users here"))) as unknown as Authenticate,
      forgeToken: "forge-service-token",
      skills: w.skills,
      forgeSkills: forge,
      now: w.clock.now,
      config: {
        publicUrl: "http://orchestrator.test",
        ...imageConfig(),
        gitGateway: null,
        runHistoryUrl: null,
        appUrl: null,
        services: DEFAULT_SERVICE_POLICY,
        egress: {
          policy: { mode: "proxy", bundles: [], hosts: [], proxyUrl: null },
          key: null,
          tokenTtlMs: 0,
        },
        platformMemoryServerId: null,
        platformChatServerId: null,
        platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
      },
    });
    const res = await handler(
      new Request("http://orchestrator.test/v1/forge/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer forge-service-token",
        },
        body: JSON.stringify({
          deliveryId: "gh-push-1",
          kind: "branch.updated",
          repo: {
            provider: "github",
            repoRef: "acme/cr-skills",
            url: "https://github.com/acme/cr-skills.git",
          },
          actorLogin: "someone",
          thread: null,
          body: null,
          sourceCommentId: null,
          branch: { ref: "main", commit: COMMIT_1 },
          receivedAt: T0,
        }),
      }),
    );
    // Answered while the read is still held: the delivery never waits on the sync.
    assertEquals([res.status, (await res.json()).outcome], [200, "branch-updated"]);
    read.resolve();
    await synced.promise;
    const current = await w.skills.currentOrg();
    assertEquals(current?.sync.trigger, "push");
    assertEquals(current?.skills.map((s) => s.name), ["deploy"]);
  } finally {
    await w.handle.close();
  }
});
