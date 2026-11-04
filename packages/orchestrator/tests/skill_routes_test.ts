import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// A run's skills through the pure HTTP handler: frozen at task start for a harness that reads
// them, served in the spec without the org provenance, fetched by digest only when the run was
// given that digest, and reported back into the run's trail only for what the run holds.

import { ARTIFACT_SKILL } from "../src/core/artifacts.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeHandler } from "../src/http/app.ts";
import { directorySkillCatalogue } from "../src/adapters/skill_catalogue/directory.ts";
import {
  type CatalogueSkill,
  describeDrops,
  describeStale,
  MAX_LISTED_SKILLS,
  MAX_LISTING_BYTES,
  type OrgVersion,
  type SkillBundle,
} from "../src/core/skills.ts";
import type { SkillCatalogue } from "../src/ports/skill_catalogue.ts";
import type { SkillStore } from "../src/ports/skill_store.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import {
  DEFAULT_SKILL_POLICY,
  DEFAULT_SKILL_SETTINGS,
  type SkillPolicy,
  type SkillSettings,
} from "../src/core/types.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  LOCAL_REPO,
  silentDiagnostics,
  TEST_GATEWAY,
} from "./doubles.ts";

const OLD_DIGEST = `sha256:${"9".repeat(64)}`;
const OLD_BUNDLE: SkillBundle = {
  digest: OLD_DIGEST,
  bytes: 3,
  files: [{ path: "SKILL.md", executable: false, content: "YWJj" }],
};

/** The store as a run frozen before a deploy meets it: it holds a catalogue version this
 * process no longer ships. */
function fakeSkillStore(
  opts: { settings?: SkillSettings; org?: OrgVersion; bundles?: SkillBundle[] } = {},
): SkillStore {
  const bundles = new Map([[OLD_DIGEST, OLD_BUNDLE]]);
  for (const b of opts.bundles ?? []) bundles.set(b.digest, b);
  return {
    upsertBundles: (list) => {
      for (const b of list) bundles.set(b.digest, b);
      return Promise.resolve();
    },
    bundle: (digest) => Promise.resolve(bundles.get(digest) ?? null),
    iconsOf: () => Promise.resolve(new Map()),
    // The deployment's defaults and no org repo, unless a test says otherwise: what these runs
    // are frozen against.
    settings: () => Promise.resolve(opts.settings ?? DEFAULT_SKILL_SETTINGS),
    orgState: () => Promise.resolve(null),
    currentOrg: () => Promise.resolve(opts.org ?? null),
    syncs: () => Promise.resolve({ syncs: [], nextCursor: null }),
    versionsOf: () => Promise.resolve([]),
    putToggles: () => Promise.reject(new Error("no settings writes here")),
    setOrgRepo: () => Promise.reject(new Error("no settings writes here")),
    recordSync: () => Promise.reject(new Error("no syncs here")),
  };
}

async function buildApp(catalogue?: SkillCatalogue, skills: SkillStore = fakeSkillStore()) {
  const store = memoryTaskStore();
  await store.createConnectedRepo(LOCAL_REPO);
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const skillCatalogue = catalogue ?? await directorySkillCatalogue();
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve({ kind: "break-glass" }),
    skillCatalogue,
    skills,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: TEST_GATEWAY,
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
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  /** Starts one task for a new agent on `harnessKind`; answers the run and its runner token. */
  const start = async (
    harnessKind: string,
    skillPolicy?: SkillPolicy,
    freeze?: (
      run: Parameters<typeof store.createTask>[1],
    ) => Parameters<typeof store.createTask>[1],
  ) => {
    const createTask = store.createTask;
    if (freeze) store.createTask = (task, run) => createTask(task, Object.assign(run, freeze(run)));
    const agent = await (await call("POST", "/v1/agents", {
      name: `Ada ${harnessKind}`,
      email: `ada-${harnessKind}@example.com`,
      harnessKind,
      ...(skillPolicy === undefined ? {} : { skillPolicy }),
    })).json();
    const created = await call("POST", "/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Fix the flaky test", instructions: "Find it and fix it." },
      connectedRepoId: LOCAL_REPO.id,
    });
    store.createTask = createTask;
    assertEquals(created.status, 201);
    const { runId } = await created.json();
    return { runId, token: (await bootstrapEnv(handler, launches.at(-1)!.env)).RYPH_RUN_TOKEN };
  };
  return { call, start, store, skillCatalogue };
}

test("a pi run is frozen with the catalogue, and its spec serves the list without provenance", async () => {
  const { call, start, store, skillCatalogue } = await buildApp();
  const { runId, token } = await start("pi");
  const run = (await store.getRun(runId))!;
  assertEquals(
    run.skills?.skills.map((s) => [s.name, s.source, s.digest]),
    // All but the artifact skill, which only an agent that may publish artifacts is given.
    skillCatalogue.list().filter((s) => s.name !== ARTIFACT_SKILL)
      .map((s) => [s.name, "catalogue", s.digest]),
  );
  assertEquals(run.skills?.org, null);
  // Nothing was dropped, so the trail says nothing about skills.
  assert(!(await store.listEvents(runId)).some((e) => e.kind.startsWith("skills.")));

  const spec = await (await call("GET", `/v1/runs/${runId}/spec`, undefined, token)).json();
  assertEquals(spec.skills, {
    skills: run.skills!.skills,
    workingRepos: run.skills!.workingRepos,
    budget: run.skills!.budget,
  });
  assertEquals("org" in spec.skills, false);
});

test("a run fetches exactly the bundles it was frozen with, and nothing else", async () => {
  const { call, start, skillCatalogue } = await buildApp();
  const { runId, token } = await start("pi");
  const [first] = skillCatalogue.list().filter((s) => s.name !== ARTIFACT_SKILL);

  const res = await call("GET", `/v1/runs/${runId}/skills/${first.digest}`, undefined, token);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { files: skillCatalogue.bundle(first.digest)!.files });

  // Another run's token, or none, reads nothing.
  assertEquals(
    (await call("GET", `/v1/runs/${runId}/skills/${first.digest}`, undefined, "nope")).status,
    401,
  );
  // A digest the store holds but this run was never given answers as if nothing held it.
  const unfrozen = await call("GET", `/v1/runs/${runId}/skills/${OLD_DIGEST}`, undefined, token);
  assertEquals(unfrozen.status, 404);

  // A run frozen on a catalogue version this process no longer ships finds it in the store.
  const historical = await start("pi", undefined, (run) => ({
    ...run,
    skills: {
      ...run.skills!,
      skills: [{ ...run.skills!.skills[0], digest: OLD_DIGEST }],
    },
  }));
  const old = await call(
    "GET",
    `/v1/runs/${historical.runId}/skills/${OLD_DIGEST}`,
    undefined,
    historical.token,
  );
  assertEquals(old.status, 200);
  assertEquals(await old.json(), { files: OLD_BUNDLE.files });

  // Once the run is over, nothing more is served.
  await call(
    "POST",
    `/v1/runs/${runId}/result`,
    { status: "success", branches: [], summary: "done" },
    token,
  );
  assertEquals(
    (await call("GET", `/v1/runs/${runId}/skills/${OLD_DIGEST}`, undefined, token)).status,
    409,
  );
});

test("a harness without skills support is frozen with none, and fetches none", async () => {
  const { call, start, store, skillCatalogue } = await buildApp();
  const { runId, token } = await start("echo");
  assertEquals((await store.getRun(runId))!.skills, null);
  const spec = await (await call("GET", `/v1/runs/${runId}/spec`, undefined, token)).json();
  assertEquals(spec.skills, null);
  const digest = skillCatalogue.list()[0].digest;
  assertEquals(
    (await call("GET", `/v1/runs/${runId}/skills/${digest}`, undefined, token)).status,
    404,
  );
});

test("the runner's skills report lands in the trail, held to what the run holds", async () => {
  const { call, start, store } = await buildApp();
  const { runId, token } = await start("pi");
  const report = {
    root: "/tmp/ryph-skills-3f9a",
    loaded: [
      { path: "repo", name: "release" },
      { path: "elsewhere", name: "planted" },
    ],
    dropped: [
      { source: "catalogue", name: "ryph-checks", reason: "unavailable", detail: "HTTP 503" },
      { source: "org", name: "ryph-checks", reason: "invalid" },
      { source: "catalogue", name: "ryph-made-up", reason: "invalid" },
      { source: "repo", path: "repo", name: "deploy", reason: "collision", winner: "catalogue" },
      { source: "repo", path: "elsewhere", name: "deploy", reason: "cap" },
    ],
  };
  const res = await call("POST", `/v1/runs/${runId}/skills/report`, report, token);
  assertEquals(res.status, 204);
  const events = (await store.listEvents(runId)).filter((e) => e.kind.startsWith("skills."));
  assertEquals(events.map((e) => e.kind), ["skills.root", "skills.repo", "skills.dropped"]);
  assertEquals(events[0].detail, "/tmp/ryph-skills-3f9a");
  assertEquals(events[1].detail, "release (`repo/`)");
  assertEquals(
    events[2].detail,
    "ryph-checks (catalogue): its files could not be loaded; HTTP 503\n" +
      "deploy (`repo/`): the name is already taken by a skill from ryph's catalogue",
  );

  // A drop the trail could not word is refused whole: a bad name, a repo skill with no repo, a
  // frozen skill with one, and a collision that does not say what it lost to.
  const refusals: Array<[Record<string, unknown>, string]> = [
    [{ source: "repo", path: "repo", name: "Not A Name", reason: "cap" }, "skill name"],
    [{ source: "repo", name: "deploy", reason: "cap" }, "names its repo's path"],
    [{ source: "catalogue", path: "repo", name: "ryph-checks", reason: "cap" }, "repo's path"],
    [{ source: "repo", path: "repo", name: "deploy", reason: "collision" }, "a collision names"],
    [{ source: "org", name: "release", reason: "cap", winner: "catalogue" }, "a collision names"],
  ];
  for (const [drop, message] of refusals) {
    const bad = await call("POST", `/v1/runs/${runId}/skills/report`, {
      root: null,
      loaded: [],
      dropped: [drop],
    }, token);
    assertEquals(bad.status, 400, JSON.stringify(drop));
    assertStringIncludes((await bad.json()).error, message);
  }

  // The run page trusts the root, so it must be the runner's own skills directory: absolute,
  // plain, one line, and ending in the directory the runner made.
  for (
    const root of [
      "tmp/ryph-skills-3f9a",
      "/tmp/ryph-skills-3f9a/",
      "/work/repo/.agents",
      "/tmp/../work/ryph-skills-x",
      "/tmp/ryph-skills-x\n/etc",
      "",
    ]
  ) {
    const bad = await call("POST", `/v1/runs/${runId}/skills/report`, {
      root,
      loaded: [],
      dropped: [],
    }, token);
    assertEquals(bad.status, 400, root);
    assertStringIncludes((await bad.json()).error, "not a skills directory");
  }

  // One report per run: the valid one above took the run's slot.
  const again = await call("POST", `/v1/runs/${runId}/skills/report`, report, token);
  assertEquals(again.status, 409);
  assertStringIncludes((await again.json()).error, "already reported its skills");

  // A run that is over takes no report, even one that never reported.
  const ended = await start("pi");
  await call(
    "POST",
    `/v1/runs/${ended.runId}/result`,
    { status: "success", branches: [], summary: "done" },
    ended.token,
  );
  const late = await call("POST", `/v1/runs/${ended.runId}/skills/report`, report, ended.token);
  assertEquals(late.status, 409);
  assertStringIncludes((await late.json()).error, "run is terminal");
  assertEquals(
    (await store.listEvents(ended.runId)).filter((e) => e.kind.startsWith("skills.repo")),
    [],
  );
});

test("a report claims no repo skill the run was not allowed: none on, reserved, frozen, repeated, over budget, or twice", async () => {
  const { call, start, store } = await buildApp();
  const repoEvents = async (runId: string) =>
    (await store.listEvents(runId)).filter((e) => e.kind.startsWith("skills."));
  const claim = {
    root: null,
    loaded: [
      { path: "repo", name: "ryph-checks" },
      { path: "repo", name: "release" },
      { path: "repo", name: "deploy" },
    ],
    dropped: [{ source: "repo", path: "repo", name: "lint", reason: "cap" }],
  };

  // A reserved name never lands as a loaded repo skill, and loaded skills stop at the budget the
  // run was frozen with.
  const pi = await start("pi", undefined, (run) => ({
    ...run,
    skills: { ...run.skills!, budget: { skills: 1, listingBytes: 100 } },
  }));
  assertEquals(
    (await call("POST", `/v1/runs/${pi.runId}/skills/report`, claim, pi.token)).status,
    204,
  );
  assertEquals(
    (await repoEvents(pi.runId)).map((e) => [e.kind, e.detail]),
    [["skills.repo", "release (`repo/`)"], [
      "skills.dropped",
      `lint (\`repo/\`): over the ${MAX_LISTED_SKILLS}-skill or ${MAX_LISTING_BYTES}-byte listing cap`,
    ]],
  );

  // The report is taken once, loaded and dropped together: a second one is refused whole and
  // adds nothing to the trail.
  const second = await call("POST", `/v1/runs/${pi.runId}/skills/report`, {
    root: null,
    loaded: [{ path: "repo", name: "deploy" }],
    dropped: [{ source: "repo", path: "repo", name: "lint", reason: "cap" }],
  }, pi.token);
  assertEquals(second.status, 409);
  assertStringIncludes((await second.json()).error, "already reported");
  assertEquals(
    (await repoEvents(pi.runId)).map((e) => e.kind),
    ["skills.repo", "skills.dropped"],
  );

  // A name the run was frozen with outranks any repo skill, and one name loads once.
  const held = await start("pi", undefined, (heldRun) => ({
    ...heldRun,
    skills: {
      ...heldRun.skills!,
      skills: [...heldRun.skills!.skills, {
        name: "deploy",
        description: "Use when shipping.",
        source: "org",
        digest: `sha256:${"d".repeat(64)}`,
      }],
    },
  }));
  assertEquals(
    (await call("POST", `/v1/runs/${held.runId}/skills/report`, {
      root: null,
      loaded: [
        { path: "repo", name: "deploy" },
        { path: "repo", name: "release" },
        { path: "repo", name: "release" },
      ],
      dropped: [],
    }, held.token)).status,
    204,
  );
  assertEquals(
    (await repoEvents(held.runId)).map((e) => [e.kind, e.detail]),
    [["skills.repo", "release (`repo/`)"]],
  );

  // A run whose working-repo skills are off claims no repo skill, loaded or dropped.
  const off = await start("pi", undefined, (run) => ({
    ...run,
    skills: { ...run.skills!, workingRepos: false },
  }));
  assertEquals(
    (await call("POST", `/v1/runs/${off.runId}/skills/report`, claim, off.token)).status,
    204,
  );
  assertEquals(await repoEvents(off.runId), []);

  // Nor does a run on a harness that reads no skills.
  const echo = await start("echo");
  assertEquals(
    (await call("POST", `/v1/runs/${echo.runId}/skills/report`, claim, echo.token)).status,
    204,
  );
  assertEquals(await repoEvents(echo.runId), []);

  // A first report that filters down to nothing still closes the door.
  assertEquals(
    (await call("POST", `/v1/runs/${off.runId}/skills/report`, claim, off.token)).status,
    409,
  );
});

test("two skills reports racing for one run land once", async () => {
  const { call, start, store } = await buildApp();
  const { runId, token } = await start("pi");
  const report = {
    root: null,
    loaded: [{ path: "repo", name: "release" }],
    dropped: [{ source: "repo", path: "repo", name: "lint", reason: "cap" }],
  };
  const statuses = (await Promise.all([
    call("POST", `/v1/runs/${runId}/skills/report`, report, token),
    call("POST", `/v1/runs/${runId}/skills/report`, report, token),
  ])).map((r) => r.status).sort();
  assertEquals(statuses, [204, 409]);
  assertEquals(
    (await store.listEvents(runId)).filter((e) => e.kind.startsWith("skills.")).map((e) => e.kind),
    ["skills.repo", "skills.dropped"],
  );
});

test("a skill dropped at task start is written to the run's trail, once, in the shared words", async () => {
  // One more catalogue skill than a run may list: the last by name does not fit.
  const skills: CatalogueSkill[] = Array.from({ length: MAX_LISTED_SKILLS + 1 }, (_, i) => ({
    name: `ryph-s${String(i).padStart(2, "0")}`,
    description: `Skill ${i}.`,
    digest: `sha256:${i.toString(16).padStart(64, "0")}`,
    bytes: 3,
    files: [{ path: "SKILL.md", bytes: 3 }],
    frontmatter: {},
    presentation: null,
    icons: null,
  }));
  const { start, store } = await buildApp({ list: () => skills, bundle: () => null });
  const { runId } = await start("pi");
  const run = (await store.getRun(runId))!;
  assertEquals(run.skills?.skills.length, MAX_LISTED_SKILLS);
  const events = (await store.listEvents(runId)).filter((e) => e.kind.startsWith("skills."));
  const last = skills.at(-1)!.name;
  assertEquals(events.map((e) => [e.kind, e.detail]), [[
    "skills.dropped",
    describeDrops([{ name: last, source: "catalogue", reason: "cap" }]),
  ]]);
  // The run row exists before its trail does: the drop follows the run's creation.
  const kinds = (await store.listEvents(runId)).map((e) => e.kind);
  assert(kinds.indexOf("created") < kinds.indexOf("skills.dropped"), kinds.join(", "));
});

const ORG_BUNDLE: SkillBundle = {
  digest: `sha256:${"7".repeat(64)}`,
  bytes: 3,
  files: [{ path: "SKILL.md", executable: false, content: "eHl6" }],
};

/** The org repo's current version, holding `release` and `deploy`; stale when asked. */
function orgVersion(stale: boolean): OrgVersion {
  const sync = {
    id: "ss_1",
    connectedRepoId: "cr_skills",
    branch: "main",
    trigger: "push" as const,
    outcome: "synced" as const,
    failure: null,
    rulesVersion: 1,
    commit: "a".repeat(40),
    treeId: "b".repeat(40),
    skillCount: 2,
    warnings: [],
    error: null,
    repeats: 1,
    requestedBy: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:00:01.000Z",
  };
  return {
    connectedRepoId: "cr_skills",
    repoRef: "acme/skills",
    sync,
    skills: ["deploy", "release"].map((name) => ({
      name,
      description: `How we ${name}.`,
      digest: name === "release" ? ORG_BUNDLE.digest : `sha256:${"6".repeat(64)}`,
      frontmatter: {},
      presentation: null,
    })),
    lastFailure: stale
      ? {
        ...sync,
        id: "ss_2",
        outcome: "failed",
        failure: "missing-ref",
        commit: null,
        treeId: null,
        error: "branch main no longer exists",
        finishedAt: "2026-10-02T00:00:00.000Z",
      }
      : null,
  };
}

test("a run is frozen against the admin's settings, the org repo's current version and the agent's policy", async () => {
  const org = orgVersion(true);
  const { call, start, store } = await buildApp(
    undefined,
    fakeSkillStore({
      settings: {
        ...DEFAULT_SKILL_SETTINGS,
        disabledCatalogue: ["ryph-checks"],
        workingRepoSkills: true,
      },
      org,
      bundles: [ORG_BUNDLE],
    }),
  );
  const { runId, token } = await start("pi", {
    ...DEFAULT_SKILL_POLICY,
    org: { enabled: true, disabled: ["deploy"] },
    workingRepos: { enabled: false },
  });
  const run = (await store.getRun(runId))!;
  assertEquals(run.skills?.skills.map((s) => [s.name, s.source]), [
    ["ryph-environment", "catalogue"],
    ["release", "org"],
  ]);
  assertEquals(run.skills?.org, {
    connectedRepoId: "cr_skills",
    repoRef: "acme/skills",
    commit: "a".repeat(40),
    syncId: "ss_1",
    syncedAt: "2026-10-01T00:00:01.000Z",
    stale: true,
  });
  assertEquals(run.skills?.workingRepos, false);
  // The last good version, said out loud on the trail.
  const events = (await store.listEvents(runId)).filter((e) => e.kind.startsWith("skills."));
  assertEquals(events.map((e) => [e.kind, e.detail]), [[
    "skills.stale",
    describeStale(org, org.lastFailure!),
  ]]);

  // The org skill's files come from the store, by the digest the run was frozen with.
  const bundle = await call(
    "GET",
    `/v1/runs/${runId}/skills/${ORG_BUNDLE.digest}`,
    undefined,
    token,
  );
  assertEquals(bundle.status, 200);
  assertEquals((await bundle.json()).files, ORG_BUNDLE.files);
  // A skill the agent turned off was never given, so its digest is not this run's to read.
  const off = await call(
    "GET",
    `/v1/runs/${runId}/skills/sha256:${"6".repeat(64)}`,
    undefined,
    token,
  );
  assertEquals(off.status, 404);
  await off.body?.cancel();
});

test("a fresh org version writes no stale line, and a harness without skills reads no settings", async () => {
  let reads = 0;
  const counting = fakeSkillStore({ org: orgVersion(false) });
  const { start, store } = await buildApp(undefined, {
    ...counting,
    settings: () => {
      reads++;
      return counting.settings();
    },
  });
  const pi = await start("pi");
  assertEquals((await store.getRun(pi.runId))!.skills?.org?.stale, false);
  assert(!(await store.listEvents(pi.runId)).some((e) => e.kind === "skills.stale"));
  assertEquals(reads, 1);
  const echo = await start("echo");
  assertEquals((await store.getRun(echo.runId))!.skills, null);
  assertEquals(reads, 1);
});
