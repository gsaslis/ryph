// The skills settings, the org repo's version history and the agent's skill policy: the store's
// writes and what they answer (one version per tree, failures counted rather than repeated, a
// sync that lost a race or outlived its repo moving nothing), the skills routes and who may call
// them, and the policy's handler rules.

import { test } from "bun:test";
import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { drizzleSkillStore } from "../src/adapters/store/drizzle_skills.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { eq } from "drizzle-orm";
import { directorySkillCatalogue } from "../src/adapters/skill_catalogue/directory.ts";
import {
  judgeSkill,
  SKILL_RULES_VERSION,
  type SkillSyncResult,
  type SkillSyncStart,
  type SkillTreeEntry,
  type ValidSkill,
} from "../src/core/skills.ts";
import { syncOnPush } from "../src/core/skills_sync.ts";
import { type ConnectedRepo, DEFAULT_SKILL_SETTINGS } from "../src/core/types.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import type { SkillCatalogue } from "../src/ports/skill_catalogue.ts";
import type { ForgeSkills, SkillsTree } from "../src/ports/forge.ts";
import { makeTestDb } from "./db.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const text = (s: string) => new TextEncoder().encode(s);
const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const COMMIT_1 = "1".repeat(40);
const COMMIT_2 = "2".repeat(40);

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

async function skill(
  name: string,
  description = `Use when ${name} comes up.`,
  extra: SkillTreeEntry[] = [],
): Promise<ValidSkill> {
  const judged = await judgeSkill({
    dir: name,
    allowReserved: false,
    entries: [{
      path: "SKILL.md",
      type: "file",
      executable: false,
      bytes: text(
        `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n# ${name}\n`,
      ),
    }, ...extra],
  });
  assert(judged.kind === "valid");
  return judged.skill;
}

let ids = 0;
function start(
  connectedRepoId = "cr-skills",
  opts: Partial<SkillSyncStart> = {},
): SkillSyncStart {
  return {
    id: `ss-${++ids}`,
    connectedRepoId,
    settingsBranch: null,
    branch: "main",
    trigger: "push",
    requestedBy: null,
    startedAt: T0,
    ...opts,
  };
}

function tree(
  minutes: number,
  skills: ValidSkill[],
  opts: Partial<Extract<SkillSyncResult, { kind: "tree" }>> = {},
): SkillSyncResult {
  return {
    kind: "tree",
    commit: COMMIT_1,
    treeId: TREE_A,
    rulesVersion: SKILL_RULES_VERSION,
    skills,
    warnings: [],
    finishedAt: at(minutes),
    ...opts,
  };
}

/** The branch still holds `treeId`, the tree the read named to the forge. */
function unchanged(minutes: number, commit: string, treeId = TREE_A): SkillSyncResult {
  return {
    kind: "unchanged",
    commit,
    treeId,
    rulesVersion: SKILL_RULES_VERSION,
    finishedAt: at(minutes),
  };
}

function failed(
  minutes: number,
  failure: "unavailable" | "missing-ref" = "unavailable",
  error = "the forge did not answer",
): SkillSyncResult {
  return {
    kind: "failed",
    failure,
    error,
    commit: null,
    rulesVersion: SKILL_RULES_VERSION,
    finishedAt: at(minutes),
  };
}

async function stores() {
  const handle = await makeTestDb();
  const tasks = drizzleTaskStore(handle);
  const skills = drizzleSkillStore(handle, () => new Date(T0));
  for (const r of [repo("cr-skills"), repo("cr-other"), repo("cr-gone", T0)]) {
    await tasks.createConnectedRepo(r);
  }
  return { handle, tasks, skills };
}

test("no row reads as the defaults, and the switches are written apart from the org repo", async () => {
  const { handle, skills } = await stores();
  try {
    assertEquals(await skills.settings(), DEFAULT_SKILL_SETTINGS);
    assertEquals(await skills.orgState(), null);
    assertEquals(await skills.currentOrg(), null);

    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    await skills.recordSync(start(), tree(1, [await skill("deploy")]));
    const synced = (await skills.settings()).org!;
    assertExists(synced.currentSyncId);

    // An admin flipping a switch never writes back the version pointer a sync moved.
    await skills.putToggles(
      { disabledCatalogue: ["ryph-checks"], workingRepoSkills: false },
      "u-admin",
    );
    const after = await skills.settings();
    assertEquals(after.disabledCatalogue, ["ryph-checks"]);
    assertEquals(after.workingRepoSkills, false);
    assertEquals(after.org, synced);
    assertEquals(after.updatedBy, "u-admin");

    // The same repo and branch again keeps where its syncs got to; another branch starts over.
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    assertEquals((await skills.settings()).org, synced);
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: "skills" }, "u-admin");
    assertEquals((await skills.settings()).org, {
      connectedRepoId: "cr-skills",
      branch: "skills",
      currentSyncId: null,
      checkedAt: null,
      checkedCommit: null,
    });
  } finally {
    await handle.close();
  }
});

test("a tree becomes the version runs get, and the same tree again is one version", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const deploy = await skill("deploy");
    const release = await skill("release");
    const first = await skills.recordSync(
      start(),
      tree(1, [deploy, release], { warnings: [{ path: "broken/SKILL.md", message: "no name" }] }),
    );
    assert(first.kind === "synced");
    const org = await skills.currentOrg();
    assertEquals(org?.repoRef, "acme/cr-skills");
    assertEquals(org?.sync.id, first.sync.id);
    assertEquals(org?.lastFailure, null);
    assertEquals(org?.skills.map((s) => [s.name, s.digest]), [
      ["deploy", deploy.digest],
      ["release", release.digest],
    ]);
    assertEquals(org?.skills[0].frontmatter, { license: "MIT" });
    // The bundle is stored with the version, so a run frozen on it can fetch it.
    assertEquals((await skills.bundle(deploy.digest))?.digest, deploy.digest);

    // A push and a Sync now racing over the same tree: the second records nothing new.
    const second = await skills.recordSync(
      start("cr-skills", { trigger: "manual" }),
      tree(2, [deploy, release], { commit: COMMIT_2 }),
    );
    assertEquals(second, { kind: "up-to-date" });
    assertEquals((await skills.syncs({ limit: 10 })).syncs.length, 1);
    const settings = (await skills.settings()).org!;
    assertEquals([settings.checkedAt, settings.checkedCommit], [at(2), COMMIT_2]);

    // An unchanged answer moves only the last answer.
    assertEquals(
      await skills.recordSync(start(), unchanged(3, COMMIT_1)),
      { kind: "up-to-date" },
    );
    assertEquals((await skills.settings()).org!.checkedAt, at(3));
    assertEquals((await skills.settings()).org!.currentSyncId, first.sync.id);
  } finally {
    await handle.close();
  }
});

test("a skill's presentation is stored with its version and read back", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const deploy = await skill("deploy", "Use when shipping.", [
      {
        path: "agents/openai.yaml",
        type: "file",
        executable: false,
        bytes: text(
          "interface:\n  display_name: Deploy\n  brand_color: '#3B82F6'\n" +
            "  icon_small: ./assets/icon.svg\n",
        ),
      },
      { path: "assets/icon.svg", type: "file", executable: false, bytes: text("<svg></svg>") },
    ]);
    assertExists(deploy.presentation);
    const release = await skill("release");
    assertEquals(release.presentation, null);
    await skills.recordSync(start(), tree(1, [deploy, release]));
    const org = await skills.currentOrg();
    assertEquals(org?.skills.map((s) => s.presentation), [deploy.presentation, null]);
    assertEquals((await skills.orgState())?.current?.skills[0].presentation, deploy.presentation);
    // What a run start reads carries no icon: they live with the bundle, read apart.
    assert(!JSON.stringify(org).includes(text("<svg></svg>").toBase64()));
    const icon = { mime: "image/svg+xml" as const, data: text("<svg></svg>").toBase64() };
    assertEquals(
      await skills.iconsOf([deploy.digest, release.digest, deploy.digest]),
      new Map([[deploy.digest, { small: icon, large: null }]]),
    );
    assertEquals(await skills.iconsOf([]), new Map());

    // A second version holding the same skill writes no icon again: one bundle row, one copy.
    await skills.recordSync(
      start(),
      tree(2, [deploy], { treeId: TREE_B, commit: COMMIT_2 }),
    );
    const rows = await handle.db.select().from(schema.skillBundles)
      .where(eq(schema.skillBundles.digest, deploy.digest));
    assertEquals(rows.map((r) => r.icons), [{ small: icon, large: null }]);
    const entries = await handle.db.select().from(schema.skillSyncEntries)
      .where(eq(schema.skillSyncEntries.digest, deploy.digest));
    assertEquals(entries.length, 2);
    assert(entries.every((e) => !JSON.stringify(e.presentation).includes(icon.data)));
  } finally {
    await handle.close();
  }
});

test("a stored bundle takes the icons a later sync judged, and keeps matching ones as they are", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const deploy = await skill("deploy", "Use when shipping.", [
      {
        path: "agents/openai.yaml",
        type: "file",
        executable: false,
        bytes: text("interface:\n  icon_small: ./assets/icon.svg\n"),
      },
      { path: "assets/icon.svg", type: "file", executable: false, bytes: text("<svg></svg>") },
    ]);
    // Stored before icons were judged, or under rules that refused this one.
    await skills.recordSync(start(), tree(1, [{ ...deploy, icons: null }]));
    const icon = { mime: "image/svg+xml" as const, data: text("<svg></svg>").toBase64() };
    assertEquals(await skills.iconsOf([deploy.digest]), new Map());

    await skills.recordSync(start(), tree(2, [deploy], { treeId: TREE_B, commit: COMMIT_2 }));
    assertEquals(
      await skills.iconsOf([deploy.digest]),
      new Map([[deploy.digest, { small: icon, large: null }]]),
    );
  } finally {
    await handle.close();
  }
});

test("an openai.yaml with escapes jsonb refuses still lands, warnings and all", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const judged = await judgeSkill({
      dir: "deploy",
      allowReserved: false,
      entries: [
        {
          path: "SKILL.md",
          type: "file",
          executable: false,
          bytes: text("---\nname: deploy\ndescription: Use when shipping.\n---\n"),
        },
        {
          path: "agents/openai.yaml",
          type: "file",
          executable: false,
          bytes: text(
            'interface:\n  icon_small: "assets/\\uD800.svg"\n  icon_large: "\\u0000"\n',
          ),
        },
      ],
    });
    assert(judged.kind === "valid");
    assertEquals(judged.warnings.length, 2);
    const landed = await skills.recordSync(
      start(),
      tree(1, [judged.skill], { warnings: judged.warnings }),
    );
    assertEquals(landed.kind, "synced");
    assertEquals((await skills.currentOrg())?.sync.warnings, judged.warnings);
  } finally {
    await handle.close();
  }
});

test("a tree judged by older rules is a new version under the running ones", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const deploy = await skill("deploy");
    await skills.recordSync(start(), tree(1, [deploy], { rulesVersion: SKILL_RULES_VERSION - 1 }));
    const rejudged = await skills.recordSync(start(), tree(2, [deploy]));
    assert(rejudged.kind === "synced");
    assertEquals((await skills.currentOrg())?.sync.rulesVersion, SKILL_RULES_VERSION);
  } finally {
    await handle.close();
  }
});

test("an identical failure counts as a repeat, and runs stay on the last good version, stale", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const good = await skills.recordSync(start(), tree(1, [await skill("deploy")]));
    assert(good.kind === "synced");

    const one = await skills.recordSync(start(), failed(2));
    const two = await skills.recordSync(start("cr-skills", { trigger: "reconcile" }), failed(3));
    assert(one.kind === "failed" && two.kind === "failed");
    assertEquals(two.sync.id, one.sync.id);
    assertEquals([two.sync.repeats, two.sync.finishedAt], [2, at(3)]);

    // The branch going away is its own kind, and so its own row.
    const gone = await skills.recordSync(
      start(),
      failed(4, "missing-ref", "branch no longer exists"),
    );
    assert(gone.kind === "failed");
    assertEquals(gone.sync.failure, "missing-ref");
    assert(gone.sync.id !== one.sync.id);

    const org = await skills.currentOrg();
    assertEquals(org?.sync.id, good.sync.id);
    assertExists(org?.lastFailure);
    assertEquals(org?.lastFailure?.id, gone.sync.id);

    // An answer after the failure ends it, even one that changes nothing.
    await skills.recordSync(start(), unchanged(5, COMMIT_1));
    assertEquals((await skills.currentOrg())?.lastFailure, null);
    assertEquals((await skills.orgState())?.lastFailure, null);
  } finally {
    await handle.close();
  }
});

test("a failure of the branch the settings named before is not the one standing", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    await skills.recordSync(start(), failed(1, "missing-ref", "branch no longer exists"));
    assertEquals((await skills.orgState())?.lastFailure?.failure, "missing-ref");
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: "skills" }, "u-admin");
    assertEquals((await skills.orgState())?.lastFailure, null);
  } finally {
    await handle.close();
  }
});

test("a sync that outlives its repo or branch is history and moves nothing", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const slow = start("cr-skills");
    // An admin connects another repo while the read of the first is still out.
    await skills.setOrgRepo({ connectedRepoId: "cr-other", branch: null }, "u-admin");
    const late = await skills.recordSync(slow, tree(1, [await skill("deploy")]));
    assert(late.kind === "superseded" && late.sync !== null);
    // Kept as history, but never as a version.
    assertEquals(late.sync.outcome, "superseded");
    assertEquals(
      (await skills.syncs({ limit: 10 })).syncs.map((s) => s.outcome),
      ["superseded"],
    );
    assertEquals(await skills.versionsOf("cr-skills", "main", "deploy"), []);
    assertEquals((await skills.settings()).org?.currentSyncId, null);
    assertEquals(await skills.currentOrg(), null);

    // And after a disconnect, an unchanged answer records nothing at all.
    await skills.setOrgRepo(null, "u-admin");
    assertEquals(
      await skills.recordSync(start("cr-other"), unchanged(2, COMMIT_1)),
      { kind: "superseded", sync: null },
    );
    assertEquals((await skills.settings()).org, null);
  } finally {
    await handle.close();
  }
});

test("a read a later one overtook moves neither the version nor the last answer", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    // Read A starts first and is slow; read B starts after it, sees the newer push and lands.
    const a = start("cr-skills", { startedAt: at(1) });
    const b = start("cr-skills", { startedAt: at(2) });
    const newer = await skills.recordSync(
      b,
      tree(3, [await skill("deploy", "Use when shipping.")], { treeId: TREE_B, commit: COMMIT_2 }),
    );
    assert(newer.kind === "synced");

    // A lands after it, with the older tree: history, not the version runs get.
    const older = await skills.recordSync(a, tree(4, [await skill("deploy")]));
    assert(older.kind === "superseded" && older.sync !== null);
    assertEquals(older.sync.outcome, "superseded");
    const org = (await skills.settings()).org!;
    assertEquals(
      [org.currentSyncId, org.checkedAt, org.checkedCommit],
      [newer.sync.id, at(3), COMMIT_2],
    );
    assertEquals(
      (await skills.versionsOf("cr-skills", "main", "deploy")).map((v) => v.firstSync.id),
      [newer.sync.id],
    );

    // A late unchanged answer, or a late read of the tree runs already get, moves nothing either.
    assertEquals(
      await skills.recordSync(a, unchanged(5, COMMIT_1)),
      { kind: "superseded", sync: null },
    );
    assertEquals(
      await skills.recordSync(
        a,
        tree(6, [await skill("deploy", "Use when shipping.")], { treeId: TREE_B }),
      ),
      { kind: "up-to-date" },
    );
    const still = (await skills.settings()).org!;
    assertEquals([still.checkedAt, still.checkedCommit], [at(3), COMMIT_2]);

    // Nor does a late failure: A timing out on a cold forge after B succeeded is history, so the
    // version is not called stale and the page shows no failure.
    const late = await skills.recordSync(start("cr-skills", { startedAt: at(1) }), failed(7));
    assert(late.kind === "superseded" && late.sync !== null);
    assertEquals([late.sync.outcome, late.sync.failure], ["superseded", "unavailable"]);
    assertEquals((await skills.currentOrg())?.lastFailure, null);
    assertEquals((await skills.orgState())?.lastFailure, null);
  } finally {
    await handle.close();
  }
});

test("a failure that started later stands over a slow tree that started before it", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const good = await skills.recordSync(start("cr-skills", { startedAt: at(0) }), tree(0, []));
    assert(good.kind === "synced");
    // A slow read starts first; a Sync now after the branch was deleted starts later and fails
    // fast. The slow read then finishes with a tree.
    const slow = start("cr-skills", { startedAt: at(1) });
    const gone = await skills.recordSync(
      start("cr-skills", { startedAt: at(2) }),
      failed(3, "missing-ref", "branch main no longer exists"),
    );
    assert(gone.kind === "failed");
    const late = await skills.recordSync(
      slow,
      tree(4, [await skill("deploy")], { treeId: TREE_B }),
    );
    assert(late.kind === "superseded" && late.sync !== null);
    assertEquals(late.sync.outcome, "superseded");

    // The newest read found the branch gone: runs stay on the version they had, marked stale.
    const org = await skills.currentOrg();
    assertEquals(org?.sync.id, good.sync.id);
    assertEquals(org?.lastFailure?.id, gone.sync.id);
    assertEquals((await skills.orgState())?.lastFailure?.id, gone.sync.id);

    // A read that started after the failure ends it.
    const back = await skills.recordSync(
      start("cr-skills", { startedAt: at(5) }),
      tree(6, [await skill("deploy")], { treeId: TREE_B }),
    );
    assert(back.kind === "synced");
    assertEquals((await skills.currentOrg())?.lastFailure, null);
  } finally {
    await handle.close();
  }
});

test("a repeated failure stands over a slow tree that started between it and the first", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const good = await skills.recordSync(start("cr-skills", { startedAt: at(0) }), tree(0, []));
    assert(good.kind === "synced");
    // The branch is deleted and a read finds it gone. A slow read starts after that one; then a
    // Sync now starts and fails the same way, which counts as a repeat of the first failure.
    const gone = await skills.recordSync(
      start("cr-skills", { startedAt: at(1) }),
      failed(2, "missing-ref", "branch main no longer exists"),
    );
    assert(gone.kind === "failed");
    const slow = start("cr-skills", { startedAt: at(3) });
    const again = await skills.recordSync(
      start("cr-skills", { startedAt: at(4) }),
      failed(5, "missing-ref", "branch main no longer exists"),
    );
    assert(again.kind === "failed");
    assertEquals([again.sync.id, again.sync.repeats], [gone.sync.id, 2]);

    // The repeat started after the slow read, so the slow read's tree is history and the
    // branch still reads as gone.
    const late = await skills.recordSync(
      slow,
      tree(6, [await skill("deploy")], { treeId: TREE_B }),
    );
    assert(late.kind === "superseded" && late.sync !== null);
    const org = await skills.currentOrg();
    assertEquals(org?.sync.id, good.sync.id);
    assertEquals(org?.lastFailure?.id, gone.sync.id);
  } finally {
    await handle.close();
  }
});

test("an unchanged answer stands only while runs get the tree it was compared with", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const old = await skills.recordSync(start("cr-skills", { startedAt: at(0) }), tree(0, []));
    assert(old.kind === "synced");
    // P1 moves the tree from A to B and P2 reverts it. Both reads start while runs get A, so
    // P2's is answered unchanged against A.
    const p1 = start("cr-skills", { startedAt: at(1) });
    const p2 = start("cr-skills", { startedAt: at(2) });

    // P2 answers first: A is still what runs get, so it stands, and P1's slower read of B,
    // which started earlier, is history.
    assertEquals(await skills.recordSync(p2, unchanged(3, COMMIT_1)), { kind: "up-to-date" });
    const reverted = await skills.recordSync(
      p1,
      tree(4, [await skill("deploy")], { treeId: TREE_B, commit: COMMIT_2 }),
    );
    assert(reverted.kind === "superseded" && reverted.sync !== null);
    const org = (await skills.settings()).org!;
    assertEquals([org.currentSyncId, org.checkedCommit], [old.sync.id, COMMIT_1]);

    // The other order: P1's read of B lands first, so P2's unchanged answer is about a tree runs
    // no longer get. It records nothing and is read again.
    const p3 = start("cr-skills", { startedAt: at(5) });
    const p4 = start("cr-skills", { startedAt: at(6) });
    const landed = await skills.recordSync(
      p3,
      tree(7, [await skill("deploy")], { treeId: TREE_B, commit: COMMIT_2 }),
    );
    assert(landed.kind === "synced");
    assertEquals(await skills.recordSync(p4, unchanged(8, COMMIT_1)), { kind: "behind" });
    const after = (await skills.settings()).org!;
    assertEquals([after.currentSyncId, after.checkedAt], [landed.sync.id, at(7)]);
  } finally {
    await handle.close();
  }
});

test("a skill's versions are its branch's, and leave out superseded reads", async () => {
  const { handle, skills } = await stores();
  try {
    const v1 = await skill("deploy");
    const v2 = await skill("deploy", "Use when shipping.");
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const main = await skills.recordSync(start(), tree(1, [v1]));
    assert(main.kind === "synced");
    // A read of `main` is still out when an admin switches to `release`.
    const slow = start("cr-skills", { startedAt: at(2) });
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: "release" }, "u-admin");
    const release = await skills.recordSync(
      start("cr-skills", { settingsBranch: "release", branch: "release", startedAt: at(3) }),
      tree(4, [v2], { treeId: TREE_B, commit: COMMIT_2 }),
    );
    assert(release.kind === "synced");
    const late = await skills.recordSync(
      slow,
      tree(5, [v1], { treeId: "c".repeat(40), commit: "3".repeat(40) }),
    );
    assert(late.kind === "superseded");

    assertEquals(
      (await skills.versionsOf("cr-skills", "release", "deploy")).map((v) => [
        v.digest,
        v.firstSync.id,
      ]),
      [[v2.digest, release.sync.id]],
    );
    assertEquals(
      (await skills.versionsOf("cr-skills", "main", "deploy")).map((v) => v.firstSync.id),
      [main.sync.id],
    );
  } finally {
    await handle.close();
  }
});

test("history pages from where the last page stopped, though a repeat moved that row since", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const good = await skills.recordSync(start(), tree(1, [await skill("deploy")]));
    const fail = await skills.recordSync(start(), failed(2));
    // A slow read of another repo, kept as history, finishes between the failure and its repeat.
    const other = await skills.recordSync(start("cr-other"), tree(3, []));
    assert(good.kind === "synced" && fail.kind === "failed" && other.kind === "superseded");

    const page1 = await skills.syncs({ limit: 2 });
    assertEquals(page1.syncs.map((s) => s.id), [other.sync!.id, fail.sync.id]);
    assertExists(page1.nextCursor);

    // The failure again: its row now finishes after every other.
    const again = await skills.recordSync(start(), failed(4));
    assert(again.kind === "failed");
    assertEquals([again.sync.id, again.sync.repeats], [fail.sync.id, 2]);

    // The next page holds exactly what was older than where the first stopped: neither the
    // moved failure nor the row it now finishes after comes back.
    const page2 = await skills.syncs({ cursor: page1.nextCursor, limit: 10 });
    assertEquals(page2.syncs.map((s) => s.id), [good.sync.id]);
    assertEquals(page2.nextCursor, null);
  } finally {
    await handle.close();
  }
});

test("an archived skills repo gives runs no org skills, and the page says so", async () => {
  const { handle, tasks, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    await skills.recordSync(start(), tree(1, [await skill("deploy")]));
    await tasks.saveConnectedRepo({ ...repo("cr-skills"), archivedAt: at(2) });
    assertEquals(await skills.currentOrg(), null);
    const state = await skills.orgState();
    assertEquals(state?.repo.archivedAt, at(2));
    assertEquals(state?.current?.skills.map((s) => s.name), ["deploy"]);
  } finally {
    await handle.close();
  }
});

test("a skill's versions collapse where its files did not change, and a gap splits them", async () => {
  const { handle, skills } = await stores();
  try {
    await skills.setOrgRepo({ connectedRepoId: "cr-skills", branch: null }, "u-admin");
    const v1 = await skill("deploy");
    const v2 = await skill("deploy", "Use when shipping.");
    const other = await skill("release");
    const record = (minutes: number, list: ValidSkill[], treeId: string) =>
      skills.recordSync(start(), tree(minutes, list, { treeId, commit: `${minutes}`.repeat(40) }));
    await record(1, [v1], TREE_A);
    await record(2, [v1, other], TREE_B);
    await record(3, [v2, other], "c".repeat(40));
    await record(4, [other], "d".repeat(40));
    await record(5, [v2, other], "e".repeat(40));

    const versions = await skills.versionsOf("cr-skills", "main", "deploy");
    assertEquals(
      versions.map((v) => [v.digest, v.firstSync.at, v.lastSync.at]),
      [[v2.digest, at(5), at(5)], [v2.digest, at(3), at(3)], [v1.digest, at(1), at(2)]],
    );
    assertEquals(versions[2].firstSync.commit, "1".repeat(40));
    assertEquals(await skills.versionsOf("cr-other", "main", "deploy"), []);

    // History pages newest first, from where the last page stopped.
    const page1 = await skills.syncs({ limit: 2 });
    assertExists(page1.nextCursor);
    const page2 = await skills.syncs({ cursor: page1.nextCursor, limit: 10 });
    assertEquals(
      [...page1.syncs, ...page2.syncs].map((s) => s.finishedAt),
      [5, 4, 3, 2, 1].map(at),
    );
    assertEquals(page2.nextCursor, null);
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The routes.

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;

async function app(catalogue?: SkillCatalogue, forgeSkills: ForgeSkills | null = null) {
  const { handle, tasks, skills } = await stores();
  const skillCatalogue = catalogue ?? await directorySkillCatalogue();
  const clock = fakeClock(T0);
  let role: Role = "owner";
  const handler = makeHandler({
    store: tasks,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() =>
      Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    skillCatalogue,
    skills,
    forgeSkills,
    now: clock.now,
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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    handle,
    tasks,
    skills,
    skillCatalogue,
    clock,
    call,
    setRole: (r: Role) => (role = r),
  };
}

test("the overview: the catalogue with its switches, no org repo, the caps", async () => {
  const a = await app();
  try {
    const res = await a.call("GET", "/v1/skills");
    assertEquals(res.status, 200);
    assertEquals(
      res.body.catalogue.map((s: { name: string; enabled: boolean }) => [s.name, s.enabled]),
      a.skillCatalogue.list().map((s) => [s.name, true]),
    );
    assertEquals(res.body.org, null);
    assertEquals(res.body.workingRepoSkills, true);
    assertEquals(Object.keys(res.body.limits), ["skills", "listingBytes"]);
  } finally {
    await a.handle.close();
  }
});

test("a member reads skills and an operator manages them", async () => {
  const a = await app();
  try {
    a.setRole("viewer");
    assertEquals((await a.call("GET", "/v1/skills")).status, 403);
    a.setRole("member");
    assertEquals((await a.call("GET", "/v1/skills")).status, 200);
    assertEquals((await a.call("GET", "/v1/skills/syncs")).status, 200);
    const refused = await a.call("PUT", "/v1/skills/settings", {
      disabledCatalogue: [],
      workingRepoSkills: false,
    });
    assertEquals([refused.status, refused.body.capability], [403, "skills:manage"]);
    assertEquals(
      (await a.call("PUT", "/v1/skills/org-repo", { connectedRepoId: "cr-skills", branch: null }))
        .status,
      403,
    );
    assertEquals((await a.call("DELETE", "/v1/skills/org-repo")).status, 403);

    a.setRole("operator");
    const name = a.skillCatalogue.list()[0].name;
    const saved = await a.call("PUT", "/v1/skills/settings", {
      disabledCatalogue: [name],
      workingRepoSkills: false,
    });
    assertEquals(saved.status, 200);
    assertEquals(
      saved.body.catalogue.find((s: { name: string }) => s.name === name).enabled,
      false,
    );
    assertEquals(saved.body.workingRepoSkills, false);
    assertEquals(saved.body.updatedBy, "u-1");
  } finally {
    await a.handle.close();
  }
});

test("an admin's switch names a skill the catalogue ships", async () => {
  const a = await app();
  try {
    const typo = await a.call("PUT", "/v1/skills/settings", {
      disabledCatalogue: ["ryph-chekcs"],
      workingRepoSkills: true,
    });
    assertEquals([typo.status, typo.body.error], [400, 'no catalogue skill "ryph-chekcs"']);
    const notOurs = await a.call("PUT", "/v1/skills/settings", {
      disabledCatalogue: ["deploy"],
      workingRepoSkills: true,
    });
    assertEquals(notOurs.status, 400);
  } finally {
    await a.handle.close();
  }
});

/** A forge whose `.agents/skills/` read answers whatever the test last set. */
function skillsForge(first: SkillsTree) {
  let answer = first;
  const forge: ForgeSkills = { readSkillsTree: () => Promise.resolve(structuredClone(answer)) };
  return { forge, set: (next: SkillsTree) => (answer = next) };
}

const DEPLOY_TREE: SkillsTree = {
  kind: "tree",
  commit: COMMIT_1,
  tree: TREE_A,
  files: [{
    path: "deploy/SKILL.md",
    mode: "100644",
    content: text("---\nname: deploy\ndescription: Use when shipping.\n---\n# Deploy\n")
      .toBase64(),
  }],
};

test("the org skills repo is a live connected repo, read on connect, and disconnecting keeps history", async () => {
  const a = await app(undefined, skillsForge(DEPLOY_TREE).forge);
  try {
    const unknown = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-nope",
      branch: null,
    });
    assertEquals(unknown.status, 400);
    const archived = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-gone",
      branch: null,
    });
    assertEquals(archived.status, 400);
    const badBranch = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-skills",
      branch: "-rf",
    });
    assertEquals(badBranch.status, 400);

    const connected = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-skills",
      branch: "skills",
    });
    assertEquals(connected.status, 200);
    assertEquals(connected.body.org.repo.repoRef, "acme/cr-skills");
    assertEquals([connected.body.org.branch, connected.body.org.effectiveBranch], [
      "skills",
      "skills",
    ]);
    assertEquals(connected.body.org.archived, false);
    // Read at once: the answer carries what the sync did and the version it made.
    assertEquals(connected.body.sync.outcome, "synced");
    assertEquals(connected.body.sync.sync.trigger, "connect");
    assertEquals(connected.body.sync.sync.requestedBy, "u-1");
    assertEquals(connected.body.org.current.commit, COMMIT_1);
    assertEquals(
      connected.body.org.current.skills.map((s: { name: string }) => s.name),
      ["deploy"],
    );

    const disconnected = await a.call("DELETE", "/v1/skills/org-repo");
    assertEquals([disconnected.status, disconnected.body.org], [200, null]);
    assertEquals((await a.call("GET", "/v1/skills/syncs")).body.syncs.length, 1);
  } finally {
    await a.handle.close();
  }
});

test("the org repo's branch is held by its bare name, whichever way it was spelled", async () => {
  const forge = skillsForge(DEPLOY_TREE).forge;
  const a = await app(undefined, forge);
  try {
    const long = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-skills",
      branch: "refs/heads/skills",
    });
    assertEquals([long.status, long.body.org.branch], [200, "skills"]);
    assertEquals(long.body.sync.sync.branch, "skills");
    const version = (await a.skills.settings()).org?.currentSyncId;
    assertExists(version);

    // The same branch spelled the other way is no change: the version runs get stays.
    const short = await a.call("PUT", "/v1/skills/org-repo", {
      connectedRepoId: "cr-skills",
      branch: "skills",
    });
    assertEquals([short.status, short.body.sync.outcome], [200, "up-to-date"]);
    assertEquals((await a.skills.settings()).org?.currentSyncId, version);

    // So a push to the branch, which a forge event names bare, is the skills repo's.
    const pushed = await syncOnPush(
      { skills: a.skills, forge, diag: silentDiagnostics(), now: a.clock.now },
      "cr-skills",
      "skills",
    );
    assertEquals(pushed, { kind: "up-to-date" });
  } finally {
    await a.handle.close();
  }
});

test("Sync now: an operator's, with a connected repo, answering what the read did", async () => {
  const forge = skillsForge(DEPLOY_TREE);
  const a = await app(undefined, forge.forge);
  try {
    const none = await a.call("POST", "/v1/skills/org-repo/sync");
    assertEquals([none.status, none.body.error], [409, "no org skills repo is connected"]);

    await a.call("PUT", "/v1/skills/org-repo", { connectedRepoId: "cr-skills", branch: null });
    a.setRole("member");
    const refused = await a.call("POST", "/v1/skills/org-repo/sync");
    assertEquals([refused.status, refused.body.capability], [403, "skills:manage"]);

    a.setRole("operator");
    const same = await a.call("POST", "/v1/skills/org-repo/sync");
    assertEquals([same.status, same.body.sync], [200, { outcome: "up-to-date", sync: null }]);

    forge.set({ kind: "missing-ref" });
    a.clock.advance(60_000);
    const gone = await a.call("POST", "/v1/skills/org-repo/sync");
    assertEquals([gone.status, gone.body.sync.outcome], [200, "failed"]);
    assertEquals(gone.body.sync.sync.trigger, "manual");
    // The page names the failure, and runs stay on the version they had.
    assertEquals(gone.body.org.lastFailure.kind, "missing-ref");
    assertEquals(gone.body.org.lastFailure.error, "branch main no longer exists");
    assertEquals(gone.body.org.stale, true);
    assertEquals(gone.body.org.current.commit, COMMIT_1);

    // The connected repo archived under the setting: an admin has to pick again.
    await a.tasks.saveConnectedRepo({ ...repo("cr-skills"), archivedAt: T0 });
    const archived = await a.call("POST", "/v1/skills/org-repo/sync");
    assertEquals(archived.status, 409);
  } finally {
    await a.handle.close();
  }
});

test("an org skill's page: its files, its warnings, its versions; and history pages", async () => {
  const a = await app();
  try {
    await a.call("PUT", "/v1/skills/org-repo", { connectedRepoId: "cr-skills", branch: null });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const deploy = await skill("deploy", "Use when shipping.", [
      { path: "assets/logo.png", type: "file", executable: false, bytes: png },
      { path: "scripts/ship.sh", type: "file", executable: true, bytes: text("echo ship\n") },
    ]);
    await a.skills.recordSync(
      start(),
      tree(1, [deploy], {
        warnings: [
          { path: "deploy/link", message: "a symlink is never read; the file is skipped" },
          { path: "broken/SKILL.md", message: "no SKILL.md as a regular file" },
        ],
      }),
    );
    await a.skills.recordSync(start(), failed(2));

    const overview = (await a.call("GET", "/v1/skills")).body;
    assertEquals(overview.org.current.commit, COMMIT_1);
    assertEquals(overview.org.current.skills.map((s: { name: string }) => s.name), ["deploy"]);
    assertEquals(overview.org.stale, true);
    assertEquals(overview.org.lastFailure, {
      kind: "unavailable",
      error: "the forge did not answer",
      repeats: 1,
      at: at(2),
    });

    const page = await a.call("GET", "/v1/skills/org/deploy");
    assertEquals(page.status, 200);
    assertEquals(page.body.skill.warnings.map((w: { path: string }) => w.path), ["deploy/link"]);
    assertEquals(
      page.body.files.map((f: { path: string; text: string | null; bytes: number }) => [
        f.path,
        f.text === null ? null : f.text.length > 0,
        f.bytes,
      ]),
      [["SKILL.md", true, deploy.files[0].bytes.length], ["assets/logo.png", null, 6], [
        "scripts/ship.sh",
        true,
        10,
      ]],
    );
    assertEquals(page.body.files[2].executable, true);
    assertEquals(page.body.versions.length, 1);
    assertEquals((await a.call("GET", "/v1/skills/org/release")).status, 404);

    const bundle = await a.call("GET", `/v1/skills/bundles/${deploy.digest}`);
    assertEquals([bundle.status, bundle.body.files.length], [200, 3]);
    assertEquals((await a.call("GET", `/v1/skills/bundles/sha256:${"0".repeat(64)}`)).status, 404);
    assertEquals((await a.call("GET", "/v1/skills/bundles/nope")).status, 400);

    const first = await a.call("GET", "/v1/skills/syncs?limit=1");
    assertEquals(first.body.syncs.map((s: { outcome: string }) => s.outcome), ["failed"]);
    assertEquals(first.body.syncs[0].repoRef, "acme/cr-skills");
    const cursor = encodeURIComponent(first.body.nextCursor);
    const rest = await a.call("GET", `/v1/skills/syncs?limit=1&cursor=${cursor}`);
    assertEquals(rest.body.syncs.map((s: { outcome: string }) => s.outcome), ["synced"]);
    assertEquals((await a.call("GET", "/v1/skills/syncs?limit=0")).status, 400);
    assertEquals((await a.call("GET", "/v1/skills/syncs?cursor=ss-1")).status, 400);
  } finally {
    await a.handle.close();
  }
});

test("every skill in the overview and on its page carries its presentation", async () => {
  const a = await app();
  try {
    await a.call("PUT", "/v1/skills/org-repo", { connectedRepoId: "cr-skills", branch: null });
    const svg = (n: number) => text(`<svg>${" ".repeat(n)}</svg>`);
    const file = (path: string, bytes: Uint8Array): SkillTreeEntry => ({
      path,
      type: "file",
      executable: false,
      bytes,
    });
    const deploy = await skill("deploy", "Use when shipping.", [
      file(
        "agents/openai.yaml",
        text(
          "interface:\n  display_name: Deploy\n  icon_small: ./assets/s.svg\n" +
            "  icon_large: ./assets/l.svg\n",
        ),
      ),
      file("assets/s.svg", svg(1)),
      file("assets/l.svg", svg(2)),
    ]);
    // A large icon alone, too big to stand in for a small one in the overview.
    const ship = await skill("ship", "Use when shipping big.", [
      file("agents/openai.yaml", text("interface:\n  icon_large: ./assets/l.svg\n")),
      file("assets/l.svg", svg(20_000)),
    ]);
    await a.skills.recordSync(start(), tree(1, [deploy, await skill("release"), ship]));
    const small = { mime: "image/svg+xml", data: svg(1).toBase64() };
    const large = { mime: "image/svg+xml", data: svg(2).toBase64() };
    const huge = { mime: "image/svg+xml", data: svg(20_000).toBase64() };

    const overview = (await a.call("GET", "/v1/skills")).body;
    const checks = overview.catalogue.find((s: { name: string }) => s.name === "ryph-checks");
    assertEquals(checks.presentation.displayName, "Checks");
    assertEquals(checks.presentation.iconSmall.mime, "image/svg+xml");
    assertEquals(checks.presentation.iconLarge, null);
    const listed = overview.org.current.skills.map((
      s: { presentation: { displayName: string | null; iconSmall: unknown; iconLarge: unknown } },
    ) => s.presentation);
    assertEquals(listed.map((p: { displayName: string } | null) => p?.displayName ?? null), [
      "Deploy",
      null,
      null,
    ]);
    // The overview carries small icons only.
    assertEquals([listed[0].iconSmall, listed[0].iconLarge], [small, null]);
    assertEquals(listed[1], null);
    assertEquals([listed[2].iconSmall, listed[2].iconLarge], [null, null]);

    // A skill's page carries both, each standing in for the other.
    const org = await a.call("GET", "/v1/skills/org/deploy");
    assertEquals(org.body.skill.presentation, {
      ...deploy.presentation,
      iconSmall: small,
      iconLarge: large,
    });
    const shipPage = (await a.call("GET", "/v1/skills/org/ship")).body.skill.presentation;
    assertEquals([shipPage.iconSmall, shipPage.iconLarge], [huge, huge]);
    const catalogue = await a.call("GET", "/v1/skills/catalogue/ryph-environment");
    assertEquals(catalogue.body.skill.presentation.displayName, "Environment");
    assertEquals(catalogue.body.skill.presentation.iconLarge.mime, "image/svg+xml");
    assertEquals(catalogue.body.skill.icons, undefined);
    assertEquals(checks.icons, undefined);
  } finally {
    await a.handle.close();
  }
});

test("a catalogue skill's page serves its files from memory", async () => {
  const a = await app();
  try {
    const [first] = a.skillCatalogue.list();
    const page = await a.call("GET", `/v1/skills/catalogue/${first.name}`);
    assertEquals(page.status, 200);
    assertEquals([page.body.skill.name, page.body.skill.enabled], [first.name, true]);
    const md = page.body.files.find((f: { path: string }) => f.path === "SKILL.md");
    assert(md.text.startsWith("---\n"));
    assertEquals((await a.call("GET", "/v1/skills/catalogue/ryph-nope")).status, 404);
    const bundle = await a.call("GET", `/v1/skills/bundles/${first.digest}`);
    assertEquals(bundle.status, 200);
  } finally {
    await a.handle.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The agent's skill policy.

const POLICY_OFF_ORG = {
  catalogue: { disabled: [] },
  org: { enabled: false, disabled: ["deploy"] },
  workingRepos: { enabled: true },
};

test("a skill policy equal to the defaults is stored as null, and a member may set one", async () => {
  const a = await app();
  try {
    a.setRole("member");
    const defaults = await a.call("POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "pi",
      skillPolicy: {
        catalogue: { disabled: [] },
        org: { enabled: true, disabled: [] },
        workingRepos: { enabled: true },
      },
    });
    assertEquals([defaults.status, defaults.body.skillPolicy], [201, null]);

    const set = await a.call("PATCH", `/v1/agents/${defaults.body.id}`, {
      skillPolicy: POLICY_OFF_ORG,
    });
    assertEquals([set.status, set.body.skillPolicy], [200, POLICY_OFF_ORG]);
    const cleared = await a.call("PATCH", `/v1/agents/${defaults.body.id}`, { skillPolicy: null });
    assertEquals([cleared.status, cleared.body.skillPolicy], [200, null]);
  } finally {
    await a.handle.close();
  }
});

test("a skill policy names shipped catalogue skills and needs a harness that reads skills", async () => {
  const a = await app();
  try {
    const typo = await a.call("POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "pi",
      skillPolicy: { ...POLICY_OFF_ORG, catalogue: { disabled: ["ryph-chekcs"] } },
    });
    assertEquals([typo.status, typo.body.error], [400, 'no catalogue skill "ryph-chekcs"']);
    const reserved = await a.call("POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "pi",
      skillPolicy: { ...POLICY_OFF_ORG, org: { enabled: true, disabled: ["ryph-checks"] } },
    });
    assertEquals([reserved.status, reserved.body.error], [
      400,
      "skillPolicy.org.disabled: ryph-* names belong to the catalogue",
    ]);
    // The schema's own rules: a name once, a catalogue name in the reserved prefix, and every
    // name in the skill-name grammar.
    const malformed: Array<[Record<string, unknown>, string]> = [
      [
        { ...POLICY_OFF_ORG, catalogue: { disabled: ["ryph-checks", "ryph-checks"] } },
        "skillPolicy.catalogue.disabled: a skill may appear in the list only once",
      ],
      [
        { ...POLICY_OFF_ORG, catalogue: { disabled: ["deploy"] } },
        "skillPolicy.catalogue.disabled: catalogue skills are named ryph-*",
      ],
      [
        { ...POLICY_OFF_ORG, org: { enabled: true, disabled: ["Not A Name"] } },
        "a skill name is lowercase letters, digits and single hyphens",
      ],
    ];
    for (const [skillPolicy, message] of malformed) {
      const bad = await a.call("POST", "/v1/agents", {
        name: "Ada",
        email: "ada@example.com",
        harnessKind: "pi",
        skillPolicy,
      });
      assertEquals(bad.status, 400, JSON.stringify(skillPolicy));
      assertStringIncludes(bad.body.error, message);
    }
    const echo = await a.call("POST", "/v1/agents", {
      name: "Echo",
      email: "echo@example.com",
      harnessKind: "echo",
      skillPolicy: POLICY_OFF_ORG,
    });
    assertEquals([echo.status, echo.body.error], [400, 'harness kind "echo" cannot use skills']);

    // Swapping to a harness that reads no skills is refused while a policy is set.
    const pi = await a.call("POST", "/v1/agents", {
      name: "Pi",
      email: "pi@example.com",
      harnessKind: "pi",
      skillPolicy: POLICY_OFF_ORG,
    });
    assertEquals(pi.status, 201);
    const swap = await a.call("PATCH", `/v1/agents/${pi.body.id}`, { harnessKind: "echo" });
    assertEquals([swap.status, swap.body.error], [400, 'harness kind "echo" cannot use skills']);
    // The skill policy is what refused it: the same swap with no policy goes through.
    const plain = await a.call("POST", "/v1/agents", {
      name: "Plain",
      email: "plain@example.com",
      harnessKind: "pi",
      skillPolicy: null,
    });
    assertEquals([plain.status, plain.body.skillPolicy], [201, null]);
    const moved = await a.call("PATCH", `/v1/agents/${plain.body.id}`, { harnessKind: "echo" });
    assertEquals([moved.status, moved.body.harnessKind], [200, "echo"]);
  } finally {
    await a.handle.close();
  }
});

test("a catalogue skill a later release removed drops out of a policy instead of failing its edits", async () => {
  const shipped = await directorySkillCatalogue();
  const [kept, removed] = shipped.list();
  const a = await app(shipped);
  try {
    const created = await a.call("POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "pi",
      skillPolicy: { ...POLICY_OFF_ORG, catalogue: { disabled: [kept.name, removed.name] } },
    });
    assertEquals(created.status, 201);
    // The next release ships without `removed`.
    const narrower: SkillCatalogue = {
      list: () => shipped.list().filter((s) => s.name !== removed.name),
      bundle: (digest) => shipped.bundle(digest),
    };
    const b = await app(narrower);
    try {
      await b.tasks.createAgent(created.body);
      const edited = await b.call("PATCH", `/v1/agents/${created.body.id}`, {
        skillPolicy: created.body.skillPolicy,
      });
      assertEquals(edited.status, 200);
      assertEquals(edited.body.skillPolicy.catalogue.disabled, [kept.name]);
    } finally {
      await b.handle.close();
    }
  } finally {
    await a.handle.close();
  }
});
