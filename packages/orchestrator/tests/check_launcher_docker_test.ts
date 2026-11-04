// The docker check launcher: every argv a launch runs (the contract with a suite's containers on
// this backend, as the Job manifest is on kubernetes), how `poll` drives the stages from what
// `docker inspect` says — from any replica, twice over — and teardown and the orphan sweep, all
// against a scripted `exec`.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ImageGone } from "../src/ports/image_gone.ts";
import {
  CHECK_LABEL,
  checkCapsFromEnv,
  dockerCheckLauncher,
  LAUNCH_GRACE_MS,
  launchPlan,
  parseStages,
  planPoll,
  POOL_LABEL,
  PULL_FAILURE_ANSWER_MS,
  reclaimCheckOrphans,
  resolveCheckCaps,
  serviceArgs,
  STAGE_LABEL,
  type StageState,
} from "../src/adapters/check_launcher/docker.ts";
import type { CheckSpec } from "../src/ports/check_launcher.ts";
import { CHECK_PLATFORM_EXIT } from "../src/core/checks.ts";
import { CHECK_POOL_EXIT } from "../src/core/check_types.ts";
import type { ServiceSpec } from "../src/core/types.ts";
import { silentDiagnostics, UNSIZED } from "./doubles.ts";
import { localImagePrefix, notOwnImage } from "../src/adapters/environment_builder/local_images.ts";
import { type FakeImage, imageId, inspectAnswer, storeExec } from "./image_store.ts";
import { createHash } from "node:crypto";

const SPEC: CheckSpec = {
  suiteId: "cs-0123456789",
  generation: 1,
  name: "ryph-check-cs-0123456789-g1",
  image: "registry.test/envs/repo:e-1",
  clone: {
    url: "http://forge:7412/v1/git/cs-0123456789/cr-1/repo.git",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.http://forge:7412/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic Z2l0LWtleQ==",
    },
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
  },
  bakedCheckout: null,
  keep: ["node_modules"],
  setup: [{ run: "npm ci" }],
  checks: [
    { name: "lint", run: "npm run lint", timeoutSeconds: 300 },
    { name: "test", run: "npm test; echo '$(rm -rf /)'", timeoutSeconds: 900 },
  ],
  services: [],
  size: { ...UNSIZED, name: "standard", cpu: "4", memory: "8Gi" },
  proxyEnv: { HTTPS_PROXY: "http://cs:claim@egress-proxy:7460", NO_PROXY: "localhost" },
  deadlineSeconds: 1500,
};

const DB: ServiceSpec = {
  name: "postgres",
  image: "postgres@sha256:" + "e".repeat(64),
  env: { POSTGRES_PASSWORD: "postgres" },
  port: 5432,
  security: { capabilities: ["SETUID", "SETGID"], allowPrivilegeEscalation: false },
  resources: { cpus: "1", memory: "1g" },
  command: ["-c", "fsync=off"],
};

const OPTS = { network: "ryph_default", runtime: "runsc" };
/** The repository path of the deployment the tests run as: its environment images' tags. */
const LOCAL = localImagePrefix(OPTS.network);
/** `volume inspect`'s answer for a volume this launch made: its record's and deployment's labels. */
const OWN_VOLUME = "ryph-check-cs-0123456789-g1|ryph_default";

/** An image in the store under `name` alone, its id derived from the name. */
const stored = (name: string): FakeImage => ({
  id: `sha256:${createHash("sha256").update(name).digest("hex")}`,
  names: [name],
});
/** The store most launches find: the suite's image and the service's, both pulled. */
const PRESENT = [stored(SPEC.image), { id: imageId("e"), names: ["postgres:16"] }];

function flag(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (args[i - 1] === name ? [a] : []));
}

test("every stage runs as the run user, with nothing added, under our labels only", () => {
  const plan = launchPlan(SPEC, OPTS);
  for (const args of [plan.clone, ...plan.setup, ...plan.checks.map((c) => c.create)]) {
    assertEquals(args[0], "create");
    assertEquals(flag(args, "--user"), ["1994:1994"]);
    assertEquals(flag(args, "--cap-drop"), ["ALL"]);
    assertEquals(flag(args, "--cap-add"), []);
    assertEquals(flag(args, "--security-opt"), ["no-new-privileges"]);
    assertEquals(flag(args, "--runtime"), ["runsc"]);
    assertEquals(flag(args, "--network"), ["ryph_default"]);
    // Never the harness's tini, which a baked image lacks: docker's own init reaps instead.
    assertEquals(flag(args, "--entrypoint"), ["/bin/bash"]);
    assert(args.includes("--init"));
    const labels = flag(args, "--label");
    assert(labels.includes(`${CHECK_LABEL}=${SPEC.name}`));
    assert(labels.includes("ryph.deployment=ryph_default"));
    // The run provisioner's reclaim would reap these, and a suite id is never an active run.
    assert(!labels.some((l) => l.startsWith("ryph.run=") || l.startsWith("ryph.role=")));
  }
  assertEquals(flag(plan.clone, "--label").includes(`${STAGE_LABEL}=clone`), true);
});

test("only the clone holds the git credential; commands are env values, never script", () => {
  const plan = launchPlan(SPEC, OPTS);
  assert(flag(plan.clone, "-e").includes("GIT_CONFIG_VALUE_0=Authorization: Basic Z2l0LWtleQ=="));
  assert(!flag(plan.clone, "-e").some((e) => e.startsWith("HTTPS_PROXY=")));
  for (const args of [...plan.setup, ...plan.checks.map((c) => c.create)]) {
    assert(!args.join("\n").includes("Z2l0LWtleQ=="), "a credential outside the clone");
    assert(flag(args, "-e").includes("HTTPS_PROXY=http://cs:claim@egress-proxy:7460"));
  }
  const testCheck = plan.checks[1].create;
  assert(flag(testCheck, "-e").includes("RYPH_CHECK_RUN=npm test; echo '$(rm -rf /)'"));
  // The script (the argv after `-c`) is the platform's, the same for every check.
  assertEquals(testCheck.at(-2), "-c");
  assert(!testCheck.at(-1)!.includes("npm test"));
  assertEquals(testCheck.at(-1), plan.checks[0].create.at(-1));
});

test(
  "pristine is read-write for clone and setup, read-only for checks, beside a private work volume",
  () => {
    const plan = launchPlan(SPEC, OPTS);
    const pristine = `type=volume,source=${SPEC.name}-pristine,target=/pristine,volume-nocopy`;
    assertEquals(flag(plan.clone, "--mount"), [pristine]);
    assertEquals(flag(plan.setup[0], "--mount"), [pristine]);
    // Its own pool directory read-write, every other check's read-only: no check writes where
    // another's watcher does.
    assertEquals(flag(plan.checks[0].create, "--mount"), [
      `${pristine},readonly`,
      `type=volume,source=${SPEC.name}-pool-lint,target=/pool/lint,volume-nocopy`,
      `type=volume,source=${SPEC.name}-pool-test,target=/pool/test,volume-nocopy,readonly`,
      `type=volume,source=${SPEC.name}-work-lint,target=/work,volume-nocopy`,
    ]);
    assertEquals(flag(plan.checks[1].create, "--mount"), [
      `${pristine},readonly`,
      `type=volume,source=${SPEC.name}-pool-lint,target=/pool/lint,volume-nocopy,readonly`,
      `type=volume,source=${SPEC.name}-pool-test,target=/pool/test,volume-nocopy`,
      `type=volume,source=${SPEC.name}-work-test,target=/work,volume-nocopy`,
    ]);
    // The pool's volumes are the checks' alone.
    assert(!plan.setup[0].join("\n").includes(`${SPEC.name}-pool`));
    assert(!plan.clone.join("\n").includes(`${SPEC.name}-pool`));
    assertEquals(plan.volumes.map((v) => v.at(-1)), [
      `${SPEC.name}-pristine`,
      `${SPEC.name}-pool-lint`,
      `${SPEC.name}-pool-test`,
      `${SPEC.name}-work-lint`,
      `${SPEC.name}-work-test`,
    ]);
  },
);

test(
  "the volumes are handed to the run user by a root chown with CHOWN alone and no network",
  () => {
    const { chown } = launchPlan(SPEC, OPTS);
    assertEquals(chown.slice(0, 4), ["run", "--pull", "never", "--rm"]);
    assertEquals(flag(chown, "--user"), ["0:0"]);
    assertEquals(flag(chown, "--cap-drop"), ["ALL"]);
    assertEquals(flag(chown, "--cap-add"), ["CHOWN"]);
    assertEquals(flag(chown, "--network"), ["none"]);
    assertEquals(flag(chown, "--entrypoint"), ["/bin/chown"]);
    assertEquals(chown.slice(-6), [
      "1994:1994",
      `/v/${SPEC.name}-pristine`,
      `/v/${SPEC.name}-pool-lint`,
      `/v/${SPEC.name}-pool-test`,
      `/v/${SPEC.name}-work-lint`,
      `/v/${SPEC.name}-work-test`,
    ]);
  },
);

test("unsized checks and setup omit CPU and memory caps, and nothing watches a pool", () => {
  const plan = launchPlan({ ...SPEC, size: UNSIZED }, OPTS);
  for (const args of [...plan.setup, ...plan.checks.map((check) => check.create)]) {
    assertEquals(flag(args, "--cpus"), []);
    assertEquals(flag(args, "--memory"), []);
    assertEquals(flag(args, "--memory-swap"), []);
  }
  const env = flag(plan.checks[0].create, "-e");
  assert(env.includes("RYPH_CHECK_NAME=lint"));
  assert(!env.some((e) => e.startsWith("RYPH_CHECK_POOL")), env.join(" "));
  assert(!flag(plan.checks[0].create, "--label").some((l) => l.startsWith(`${POOL_LABEL}=`)));
  // And no pool volumes to make, mount or remove.
  assert(!plan.volumes.some((v) => v.at(-1)!.includes("-pool-")));
  assert(!plan.checks[0].create.join("\n").includes("/pool"));
});

test("every check may use the class's cpus but only its share of memory; setup gets the class", () => {
  const plan = launchPlan(SPEC, OPTS);
  // Cpu contention only shares; memory over the share is the kernel's kill, the check's alone.
  assertEquals(flag(plan.checks[0].create, "--cpus"), ["4"]);
  assertEquals(flag(plan.checks[0].create, "--memory"), ["4096m"]);
  // No swap past it either: the watcher reads memory, never swap.
  assertEquals(flag(plan.checks[0].create, "--memory-swap"), ["4096m"]);
  assertEquals(flag(plan.setup[0], "--cpus"), ["4"]);
  assertEquals(flag(plan.setup[0], "--memory"), ["8192m"]);
  assertEquals(flag(plan.setup[0], "--memory-swap"), ["8192m"]);
  const env = flag(plan.checks[1].create, "-e");
  for (
    const e of [
      "RYPH_CHECK_NAME=test",
      "RYPH_CHECK_POOL=/pool",
      "RYPH_CHECK_NAMES=lint test",
      `RYPH_CHECK_POOL_BYTES=${8 * 2 ** 30}`,
      `RYPH_CHECK_SHARE_BYTES=${4 * 2 ** 30}`,
    ]
  ) assert(env.includes(e), `${e} missing from ${env.join(" ")}`);
  assert(
    flag(plan.checks[1].create, "--label").includes(`${POOL_LABEL}=${4 * 2 ** 30}/${8 * 2 ** 30}`),
  );
  // Logs are capped by the daemon, since a check's output is unbounded.
  assertEquals(flag(plan.checks[0].create, "--log-opt"), ["max-size=10m", "max-file=1"]);
});

test(
  "services get a network of the suite's own, and the checks join it before they start",
  () => {
    const plan = launchPlan({ ...SPEC, services: [DB] }, OPTS);
    assertEquals(plan.network, [
      "network",
      "create",
      "--label",
      `${CHECK_LABEL}=${SPEC.name}`,
      "--label",
      "ryph.deployment=ryph_default",
      SPEC.name,
    ]);
    assertEquals(plan.checks[0].connect, [
      "network",
      "connect",
      SPEC.name,
      `${SPEC.name}-check-lint`,
    ]);
    const env = flag(plan.checks[0].create, "-e");
    assert(env.includes("RYPH_CHECK_SERVICES=postgres:5432"));
    assert(env.includes("NO_PROXY=localhost,postgres"));
    assertEquals(launchPlan(SPEC, OPTS).network, null);
  },
);

test("a service container mirrors the run's, created not run, under the suite's labels", () => {
  const args = serviceArgs({ ...SPEC, services: [DB] }, DB, OPTS);
  assertEquals(args[0], "create");
  assertEquals(flag(args, "--network"), [SPEC.name]);
  assertEquals(flag(args, "--network-alias"), ["postgres"]);
  assertEquals(flag(args, "--cap-drop"), ["ALL"]);
  assertEquals(flag(args, "--cap-add"), ["SETUID", "SETGID"]);
  assertEquals(flag(args, "--runtime"), ["runsc"]);
  assertEquals(args.slice(-3), [DB.image, "-c", "fsync=off"]);
  assert(
    !flag(args, "--label").some((l) => l.startsWith("ryph.run=") || l === "ryph.role=service"),
  );
});

// ── driving the stages ──────────────────────────────────────────────────────────────────────────

const st = (stage: string, status: string, exitCode = 0, oomKilled = false): StageState => ({
  stage,
  status,
  exitCode,
  oomKilled,
  startedAt: status === "created" ? null : "2026-09-30T12:00:00Z",
  finishedAt: status === "exited" ? "2026-09-30T12:01:00Z" : null,
  pool: null,
});
const stages = (...list: StageState[]) => new Map(list.map((s) => [s.stage, s]));

test("inspect output parses, and docker's zero time is null", () => {
  const parsed = parseStages(
    "clone\texited\t0\tfalse\t2026-09-30T12:00:00Z\t2026-09-30T12:00:05Z\n" +
      "check-lint\tcreated\t0\tfalse\t0001-01-01T00:00:00Z\t0001-01-01T00:00:00Z\n",
  );
  assertEquals(parsed.get("clone")?.finishedAt, "2026-09-30T12:00:05Z");
  assertEquals(parsed.get("check-lint")?.startedAt, null);
  // Docker's nanoseconds are cut to the second a forge takes.
  const nanos = parseStages(
    "clone\texited\t0\tfalse\t2026-09-30T12:00:00.123456789Z\t2026-09-30T12:00:05.999999999Z",
  );
  assertEquals(nanos.get("clone")?.startedAt, "2026-09-30T12:00:00Z");
  assertEquals(nanos.get("clone")?.finishedAt, "2026-09-30T12:00:05Z");
  // A check container's pool label, read back; a stage without one has none.
  const pooled = parseStages(
    "check-lint\texited\t122\tfalse\t2026-09-30T12:00:00Z\t2026-09-30T12:00:05Z\t" +
      `${2 ** 30}/${4 * 2 ** 30}\n` +
      "clone\texited\t0\tfalse\t2026-09-30T12:00:00Z\t2026-09-30T12:00:05Z\t\n",
  );
  assertEquals(pooled.get("check-lint")?.pool, { bytes: 4 * 2 ** 30, shareBytes: 2 ** 30 });
  assertEquals(pooled.get("clone")?.pool, null);
});

test("a check the pool watcher stopped fails on its own account, naming its share and the pool", () => {
  const plan = planPoll(stages(
    st("clone", "exited"),
    {
      ...st("check-lint", "exited", CHECK_POOL_EXIT),
      pool: { bytes: 8 * 2 ** 30, shareBytes: 4 * 2 ** 30 },
    },
    st("check-test", "exited", CHECK_POOL_EXIT),
  ));
  assert(plan.inspection.kind === "checks");
  const lint = plan.inspection.checks.lint;
  assert(lint.state === "exited");
  assertEquals(lint.exitCode, CHECK_POOL_EXIT);
  assertEquals(
    lint.reason,
    "was stopped when the suite ran short of memory, as the check furthest over its share " +
      "(4Gi of the suite's 8Gi); its log says what it used",
  );
  // Without the label, the same words without the numbers.
  const test = plan.inspection.checks.test;
  assert(test.state === "exited");
  assertStringIncludes(test.reason!, "ran short of memory");
});

test(
  "a service that stopped fails every check not yet done as the platform's, and starts none",
  () => {
    const plan = planPoll(stages(
      st("clone", "exited"),
      st("svc-postgres", "exited", 1),
      st("check-lint", "exited", 2),
      st("check-test", "running"),
      st("check-late", "created"),
    ));
    assertEquals(plan.start, []);
    assert(plan.inspection.kind === "checks");
    assertEquals(plan.inspection.done, true);
    // Exited before the service stopped: its own verdict.
    assertEquals((plan.inspection.checks.lint as { exitCode: number }).exitCode, 2);
    for (const name of ["test", "late"]) {
      const check = plan.inspection.checks[name] as { exitCode: number; reason: string };
      assertEquals(check.exitCode, CHECK_PLATFORM_EXIT);
      assertStringIncludes(check.reason, "service postgres stopped (exit 1)");
    }
  },
);

test(
  "the stages run in order: clone, each setup step, then services and checks together",
  () => {
    const created = [
      st("setup-0", "created"),
      st("svc-postgres", "created"),
      st("check-lint", "created"),
      st("check-test", "created"),
    ];
    assertEquals(planPoll(stages(st("clone", "created"), ...created)), {
      start: ["clone"],
      inspection: { kind: "pending", cloneDone: false, why: "clone" },
    });
    // Running now: pending, naming the stage, so a setup step past the deadline is the head's hang.
    assertEquals(planPoll(stages(st("clone", "running"), ...created)), {
      start: [],
      inspection: { kind: "pending", cloneDone: false, why: "clone", running: "clone" },
    });
    assertEquals(
      planPoll(stages(st("clone", "exited"), st("setup-0", "running"), ...created.slice(1))),
      { start: [], inspection: { kind: "pending", cloneDone: true, why: "setup-0", running: 0 } },
    );
    assertEquals(planPoll(stages(st("clone", "exited"), ...created)), {
      start: ["setup-0"],
      inspection: { kind: "pending", cloneDone: true, why: "setup-0" },
    });
    const ready = planPoll(stages(
      st("clone", "exited"),
      st("setup-0", "exited"),
      st("svc-postgres", "created"),
      st("check-lint", "created"),
      st("check-test", "created"),
    ));
    assertEquals(ready.start, ["svc-postgres", "check-lint", "check-test"]);
    assert(ready.inspection.kind === "checks" && !ready.inspection.done);
  },
);

test(
  "a baked checkout: no setup containers and no work volumes; each check sets up its own tree",
  () => {
    const baked = { ...SPEC, bakedCheckout: "repo", setup: [{ run: "npm ci" }, { run: "make" }] };
    const plan = launchPlan(baked, OPTS);
    assertEquals(plan.setup, []);
    assertEquals(plan.volumes.map((v) => v.at(-1)), [
      `${SPEC.name}-pristine`,
      `${SPEC.name}-pool-lint`,
      `${SPEC.name}-pool-test`,
    ]);
    assertEquals(plan.chown.slice(-4), [
      "1994:1994",
      `/v/${SPEC.name}-pristine`,
      `/v/${SPEC.name}-pool-lint`,
      `/v/${SPEC.name}-pool-test`,
    ]);
    const pristine = `type=volume,source=${SPEC.name}-pristine,target=/pristine,volume-nocopy`;
    const lint = plan.checks[0].create;
    // The clone's tree, read-only, to fetch the head from; the tree is the container's own.
    assertEquals(flag(lint, "--mount"), [
      `${pristine},readonly`,
      `type=volume,source=${SPEC.name}-pool-lint,target=/pool/lint,volume-nocopy`,
      `type=volume,source=${SPEC.name}-pool-test,target=/pool/test,volume-nocopy,readonly`,
    ]);
    const env = flag(lint, "-e");
    for (
      const e of [
        "RYPH_CHECK_BAKED=/ryph/work/repo",
        `RYPH_CHECK_HEAD=${SPEC.clone.commit}`,
        "RYPH_CHECK_SETUP_COUNT=2",
        "RYPH_CHECK_SETUP_0=npm ci",
        "RYPH_CHECK_SETUP_1=make",
        "RYPH_CHECK_KEEP_COUNT=1",
        "RYPH_CHECK_KEEP_0=node_modules",
      ]
    ) assert(env.includes(e), `${e} missing from ${env.join(" ")}`);
    // Still no credential: the head is fetched from the clone's tree, not the gateway.
    assert(!lint.join("\n").includes("Z2l0LWtleQ=="));
    assert(!env.some((e) => e.startsWith("RYPH_CHECK_URL=")));
    assertStringIncludes(lint.at(-1)!, 'tree="$RYPH_CHECK_BAKED"');
    // The clone is the same in both shapes.
    assertEquals(plan.clone, launchPlan(SPEC, OPTS).clone);
    // With no setup stage, the checks start as soon as the clone is done.
    const ready = planPoll(stages(st("clone", "exited"), st("check-lint", "created")));
    assertEquals(ready.start, ["check-lint"]);
  },
);

test("an unsafe baked checkout path is refused before anything is created", () => {
  for (const path of ["../etc", "a/b", "", ".hidden", "x y"]) {
    let error = "";
    try {
      launchPlan({ ...SPEC, bakedCheckout: path }, OPTS);
    } catch (err) {
      error = String(err);
    }
    assertStringIncludes(error, "not a baked checkout's path");
  }
  for (const pattern of ["", "a\nb"]) {
    let error = "";
    try {
      launchPlan({ ...SPEC, keep: [pattern] }, OPTS);
    } catch (err) {
      error = String(err);
    }
    assertStringIncludes(error, "not a keep pattern");
  }
});

test("a failed clone or setup step is setup_failed and starts nothing after it", () => {
  assertEquals(planPoll(stages(st("clone", "exited", 128), st("setup-0", "created"))), {
    start: [],
    inspection: {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: 128,
      why: "the clone exited 128",
    },
  });
  const setup = planPoll(stages(
    st("clone", "exited"),
    st("setup-0", "exited", 1),
    st("check-lint", "created"),
  ));
  assertEquals(setup.start, []);
  assertEquals(setup.inspection, {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 1,
    why: "setup step 1 exited 1",
  });
});

test("the verdict is each check container's exit code; OOM is its reason", () => {
  const read = planPoll(stages(
    st("clone", "exited"),
    st("setup-0", "exited"),
    st("check-lint", "exited", 0),
    st("check-test", "exited", 137, true),
  ));
  assertEquals(read.start, []);
  assertEquals(read.inspection, {
    kind: "checks",
    done: true,
    checks: {
      lint: {
        state: "exited",
        exitCode: 0,
        startedAt: "2026-09-30T12:00:00Z",
        finishedAt: "2026-09-30T12:01:00Z",
        reason: null,
      },
      test: {
        state: "exited",
        exitCode: 137,
        startedAt: "2026-09-30T12:00:00Z",
        finishedAt: "2026-09-30T12:01:00Z",
        reason: "OOMKilled",
      },
    },
  });
});

test("no clone container means the launch never finished: gone", () => {
  assertEquals(planPoll(stages(st("setup-0", "created"))), {
    start: [],
    inspection: { kind: "gone" },
  });
});

/** A daemon: containers by stage, `start` moves one to running; every argv recorded. */
function fakeDaemon(initial: Record<string, StageState>) {
  const state = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const exec = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "ps" && args[1] === "-aq") {
      return Promise.resolve([...state.keys()].map((s) => `id-${s}`).join("\n"));
    }
    if (args[0] === "inspect" && args[1] === "--format") {
      return Promise.resolve(
        [...state.values()].map((s) =>
          [
            s.stage,
            s.status,
            s.exitCode,
            s.oomKilled,
            s.startedAt ?? "0001-01-01",
            s.finishedAt ??
              "0001-01-01",
          ].join("\t")
        ).join("\n"),
      );
    }
    if (args[0] === "start") {
      const stage = args[1].slice(`${SPEC.name}-`.length);
      const s = state.get(stage);
      if (s && s.status === "created") state.set(stage, { ...s, status: "running" });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { exec, state, calls };
}

test(
  "two independent launchers drive one suite: a restart loses nothing and repeats nothing",
  async () => {
    const daemon = fakeDaemon({
      clone: st("clone", "exited"),
      "setup-0": st("setup-0", "created"),
      "check-lint": st("check-lint", "created"),
    });
    const first = dockerCheckLauncher(OPTS, silentDiagnostics(), daemon.exec);
    assertEquals(await first.poll(SPEC.name), { kind: "pending", cloneDone: true, why: "setup-0" });
    // A second process, knowing nothing, reads the same record and does not start setup again.
    const second = dockerCheckLauncher(OPTS, silentDiagnostics(), daemon.exec);
    assertEquals(await second.poll(SPEC.name), {
      kind: "pending",
      cloneDone: true,
      why: "setup-0",
      running: 0,
    });
    assertEquals(daemon.calls.filter((c) => c[0] === "start").length, 1);
    daemon.state.set("setup-0", st("setup-0", "exited"));
    const running = await second.poll(SPEC.name);
    assertEquals(running, {
      kind: "checks",
      done: false,
      checks: { lint: { state: "running", startedAt: null } },
    });
    assertEquals(
      daemon.calls.filter((c) => c[0] === "start").map((c) => c[1]),
      [`${SPEC.name}-setup-0`, `${SPEC.name}-check-lint`],
    );
  },
);

test(
  "a record with no clone yet is a launch still pulling until the grace, then gone",
  async () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const daemon = (volumeCreated: string | null) => (args: string[]) => {
      if (args[0] === "ps") return Promise.resolve("");
      if (args[0] === "volume" && args[1] === "inspect") {
        assertEquals(args.at(-1), `${SPEC.name}-pristine`);
        return volumeCreated === null
          ? Promise.reject(new Error("no such volume"))
          : Promise.resolve(`${volumeCreated}|${SPEC.name}|ryph_default`);
      }
      return Promise.resolve("");
    };
    const young = dockerCheckLauncher(
      OPTS,
      silentDiagnostics(),
      daemon(new Date(now - 60_000).toISOString()),
      () => now,
    );
    assertEquals((await young.poll(SPEC.name)).kind, "pending");
    const old = dockerCheckLauncher(
      OPTS,
      silentDiagnostics(),
      daemon(new Date(now - LAUNCH_GRACE_MS - 1).toISOString()),
      () => now,
    );
    assertEquals(await old.poll(SPEC.name), { kind: "gone" });
    const none = dockerCheckLauncher(OPTS, silentDiagnostics(), daemon(null), () => now);
    assertEquals(await none.poll(SPEC.name), { kind: "gone" });
  },
);

test("the deployment's caps hold every stage, whatever its share", () => {
  const caps = { checkCaps: { cpus: 1.5, memoryMi: 6144 } };
  const sized = launchPlan(SPEC, { ...OPTS, ...caps });
  // The class is 4 cores and 8192m, a share 4096m: the cpu cap is lower than the class, the memory
  // cap is not lower than the share. The pool is the class under the cap.
  assertEquals(flag(sized.checks[0].create, "--cpus"), ["1.5"]);
  assertEquals(flag(sized.checks[0].create, "--memory"), ["4096m"]);
  const env = flag(sized.checks[0].create, "-e");
  assert(env.includes(`RYPH_CHECK_POOL_BYTES=${6144 * 2 ** 20}`), env.join(" "));
  assert(env.includes(`RYPH_CHECK_SHARE_BYTES=${4096 * 2 ** 20}`), env.join(" "));
  // A cap below the share holds the check, and is what the watcher is told it may use.
  const tight = launchPlan(SPEC, { ...OPTS, checkCaps: { cpus: 1.5, memoryMi: 3000 } });
  assertEquals(flag(tight.checks[0].create, "--memory"), ["3000m"]);
  assertEquals(flag(tight.checks[0].create, "--memory-swap"), ["3000m"]);
  assert(flag(tight.checks[0].create, "-e").includes(`RYPH_CHECK_SHARE_BYTES=${3000 * 2 ** 20}`));
  // Setup and the clone get the class, held under the cap too.
  assertEquals(flag(sized.setup[0], "--cpus"), ["1.5"]);
  assertEquals(flag(sized.setup[0], "--memory"), ["6144m"]);
  assertEquals(flag(sized.clone, "--cpus"), ["1.5"]);
  // Unsized, the cap is all there is, on every stage.
  const unsized = launchPlan({ ...SPEC, size: UNSIZED }, { ...OPTS, ...caps });
  assertEquals(flag(unsized.checks[1].create, "--cpus"), ["1.5"]);
  assertEquals(flag(unsized.checks[1].create, "--memory"), ["6144m"]);
  assertEquals(flag(unsized.setup[0], "--cpus"), ["1.5"]);
  assertEquals(flag(unsized.clone, "--memory"), ["6144m"]);
  assertEquals(flag(unsized.clone, "--memory-swap"), ["6144m"]);
  // An `auto` nobody resolved caps nothing.
  const auto = launchPlan({ ...SPEC, size: UNSIZED }, {
    ...OPTS,
    checkCaps: { cpus: "auto", memoryMi: "auto" },
  });
  assertEquals(flag(auto.checks[0].create, "--cpus"), []);
});

test("RYPH_CHECKS_CPUS / RYPH_CHECKS_MEMORY: auto unset, off, a quantity, or refused", () => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const of = (vars: Record<string, string>) => checkCapsFromEnv((n) => vars[n], fail);
  assertEquals(of({}), { cpus: "auto", memoryMi: "auto" });
  assertEquals(of({ RYPH_CHECKS_CPUS: "OFF", RYPH_CHECKS_MEMORY: "off" }), {
    cpus: null,
    memoryMi: null,
  });
  assertEquals(of({ RYPH_CHECKS_CPUS: "500m", RYPH_CHECKS_MEMORY: "6Gi" }), {
    cpus: 0.5,
    memoryMi: 6144,
  });
  for (
    const [name, value] of [
      ["RYPH_CHECKS_CPUS", "0"],
      // Under docker's smallest --cpus.
      ["RYPH_CHECKS_CPUS", "5m"],
      ["RYPH_CHECKS_MEMORY", "lots"],
    ]
  ) {
    assertStringIncludes(
      (() => {
        try {
          of({ [name]: value });
        } catch (err) {
          return (err as Error).message;
        }
        return "";
      })(),
      name,
    );
  }
  // The refusal quotes what was typed, case and all: quantities are case-sensitive.
  assertStringIncludes(
    (() => {
      try {
        of({ RYPH_CHECKS_MEMORY: "6GB" });
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    })(),
    '"6GB"',
  );
});

test("auto is half of what the daemon has, never under one core or 512Mi", () => {
  const auto = { cpus: "auto", memoryMi: "auto" } as const;
  assertEquals(resolveCheckCaps(auto, { cpus: 16, memoryBytes: 16 * 2 ** 30 }), {
    cpus: 8,
    memoryMi: 8192,
  });
  assertEquals(resolveCheckCaps(auto, { cpus: 1, memoryBytes: 2 ** 29 }), {
    cpus: 1,
    memoryMi: 512,
  });
  // A daemon that would not say caps nothing; a number set outright is kept.
  assertEquals(resolveCheckCaps({ cpus: 3, memoryMi: "auto" }, { cpus: NaN, memoryBytes: NaN }), {
    cpus: 3,
    memoryMi: null,
  });
  // A cpu cap set outright is held to the daemon's cpus: docker refuses --cpus above them.
  assertEquals(resolveCheckCaps({ cpus: 8, memoryMi: 4096 }, { cpus: 4, memoryBytes: 2 ** 33 }), {
    cpus: 4,
    memoryMi: 4096,
  });
});

test("launch reads the daemon once for auto, and caps every check with it", async () => {
  const calls: string[][] = [];
  const exec = storeExec(PRESENT, (args) => {
    calls.push(args);
    if (args[0] === "info") return Promise.resolve("10|21474836480");
    if (args[0] === "container") return Promise.reject(new Error("No such object"));
    if (args[0] === "volume" && args[1] === "inspect") {
      return Promise.resolve(
        `${args.at(-1)!.replace(/-(pristine|pool-.*|work-.*)$/, "")}|ryph_default`,
      );
    }
    return Promise.resolve("");
  });
  const launcher = dockerCheckLauncher(
    { ...OPTS, checkCaps: { cpus: "auto", memoryMi: "auto" } },
    silentDiagnostics(),
    exec,
  );
  await launcher.launch({ ...SPEC, size: UNSIZED });
  await launcher.launch({ ...SPEC, size: UNSIZED, name: `${SPEC.name}x` });
  assertEquals(calls.filter((c) => c[0] === "info").length, 1);
  const checks = calls.filter((c) => c[0] === "create" && c.some((a) => /-g1x?-check-/.test(a)));
  assertEquals(checks.length, 4);
  for (const args of checks) {
    assertEquals(flag(args, "--cpus"), ["5"]);
    assertEquals(flag(args, "--memory"), ["10240m"]);
  }
});

test(
  "launch pulls an image the daemon does not have before creating anything from it",
  async () => {
    const calls: string[][] = [];
    const images: FakeImage[] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      if (args[0] === "container") return Promise.reject(new Error("No such object"));
      if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
      if (args[0] === "pull") images.push(stored(args.at(-1)!));
      const answer = inspectAnswer(images, args);
      if (answer !== undefined) {
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }
      return Promise.resolve("");
    };
    await dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch(SPEC);
    const pull = calls.findIndex((c) => c[0] === "pull");
    assertEquals(calls[pull], ["pull", "--quiet", SPEC.image]);
    assert(pull < calls.findIndex((c) => c[0] === "run" || c[0] === "create"));
    assertEquals(calls.filter((c) => c[0] === "pull").length, 1);
    // Every stage on the id the pulled image resolved to, never the name a retag could move.
    const id = stored(SPEC.image).id;
    const stages = calls.filter((c) => c[0] === "create" || c[0] === "run");
    assert(stages.length > 0 && stages.every((c) => c.includes(id)), stages.join("\n"));
    assert(!stages.some((c) => c.includes(SPEC.image)));
  },
);

/** A daemon holding `held` images, whose pulls wait for the test to settle them. */
function pullingDaemon(held: string[] = []) {
  const images = new Set(held);
  const pulls: Array<{ image: string; signal?: AbortSignal; done(err?: Error): void }> = [];
  const exec = (args: string[], opts: { signal?: AbortSignal } = {}) => {
    const answer = inspectAnswer([...images].map(stored), args);
    if (answer !== undefined) {
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    if (args[0] === "pull") {
      const image = args.at(-1)!;
      return new Promise<string>((resolve, reject) =>
        pulls.push({
          image,
          signal: opts.signal,
          done: (err) => {
            if (err !== undefined) return reject(err);
            images.add(image);
            resolve("");
          },
        })
      );
    }
    return Promise.resolve("");
  };
  return { exec, pulls, images };
}

test("prepare: images the daemon holds are ready, and nothing is pulled", async () => {
  const d = pullingDaemon([SPEC.image]);
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec);
  assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "ready" });
  assertEquals(d.pulls, []);
});

test(
  "prepare: a missing image is pulled once in the background, under a time limit",
  async () => {
    const d = pullingDaemon();
    const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec);
    assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "pulling" });
    // Asked again, and for another suite on the same image: still the one pull.
    assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "pulling" });
    assertEquals(d.pulls.map((p) => p.image), [SPEC.image]);
    assert(d.pulls[0].signal !== undefined, "a pull that hangs is killed");
    d.pulls[0].done();
    await settle();
    assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "ready" });
  },
);

test(
  "prepare: a failed pull answers every suite unchanged since it started, and a charged one pulls again",
  async () => {
    const d = pullingDaemon();
    let now = Date.parse("2026-10-01T12:00:00Z");
    const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec, () => now);
    await launcher.prepare!([SPEC.image], QUEUED);
    now += 60_000;
    d.pulls[0].done(new Error("docker pull failed: manifest unknown"));
    await settle();
    const failed = { kind: "failed" as const, why: "docker pull failed: manifest unknown" };
    // Every suite that has not changed since the pull started, not only the first to ask.
    assertEquals(await launcher.prepare!([SPEC.image], QUEUED), failed);
    assertEquals(await launcher.prepare!([SPEC.image], QUEUED), failed);
    // A suite whose attempt it already cost changed after: its next attempt pulls again.
    now += 10_000;
    assertEquals(await launcher.prepare!([SPEC.image], new Date(now).toISOString()), {
      kind: "pulling",
    });
    assertEquals(d.pulls.length, 2);
    // A `since` that does not parse is charged, never left pulling for ever.
    now += 10_000;
    d.pulls[1].done(new Error("docker pull failed: manifest unknown"));
    await settle();
    assertEquals((await launcher.prepare!([SPEC.image], "not a time")).kind, "failed");
  },
);

test(
  "prepare: replicas sharing a daemon charge one outage once, however their pulls end",
  async () => {
    const d = pullingDaemon();
    let now = Date.parse("2026-10-01T12:00:00Z");
    const one = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec, () => now);
    const two = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec, () => now);
    // Each replica, on its own tick, finds the image missing and pulls.
    await one.prepare!([SPEC.image], QUEUED);
    now += 10_000;
    await two.prepare!([SPEC.image], QUEUED);
    // The first pull fails and is charged; the second fails only after that charge.
    now += 60_000;
    d.pulls[0].done(new Error("docker pull failed: timed out"));
    await settle();
    assertEquals((await one.prepare!([SPEC.image], QUEUED)).kind, "failed");
    const charged = new Date(now).toISOString();
    now += 10_000;
    d.pulls[1].done(new Error("docker pull failed: timed out"));
    await settle();
    // Its pull was already under way when the suite was charged: no second charge, a fresh pull.
    assertEquals(await two.prepare!([SPEC.image], charged), { kind: "pulling" });
  },
);

test("prepare: a failure nobody asked about within the minute is forgotten", async () => {
  const d = pullingDaemon();
  let now = Date.parse("2026-10-01T12:00:00Z");
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec, () => now);
  await launcher.prepare!([SPEC.image], QUEUED);
  d.pulls[0].done(new Error("docker pull failed: manifest unknown"));
  await settle();
  now += PULL_FAILURE_ANSWER_MS;
  assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "pulling" });
  assertEquals(d.pulls.length, 2);
});

test("prepare: a failure is no answer once the image is in after all", async () => {
  const d = pullingDaemon();
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec);
  await launcher.prepare!([SPEC.image], QUEUED);
  d.pulls[0].done(new Error("docker pull failed: timeout"));
  await settle();
  // Another replica sharing the daemon pulled it meanwhile.
  d.images.add(SPEC.image);
  assertEquals(await launcher.prepare!([SPEC.image], QUEUED), { kind: "ready" });
  assertEquals(d.pulls.length, 1);
});

test(
  "a locally built environment image that is gone is never asked of a registry",
  async () => {
    const local = `${LOCAL}repo-abc:baked-env-1`;
    const d = pullingDaemon();
    const now = Date.parse("2026-10-01T12:00:00Z");
    const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec, () => now);
    // Gone, not failed: no attempt spent on what no pull brings back.
    const answer = await launcher.prepare!([local], "2026-10-01T11:00:00Z");
    assertEquals(answer.kind, "gone");
    assertEquals(d.pulls, []);

    // Nor inline, by a launch that finds it missing.
    const calls: string[][] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      if (args[0] === "container") return Promise.reject(new Error("No such object"));
      if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
      if (args[0] === "image") return Promise.reject(new Error("No such image"));
      return Promise.resolve("");
    };
    let thrown: unknown = null;
    await dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch({ ...SPEC, image: local })
      .catch((err) => thrown = err);
    assert(thrown instanceof ImageGone, String(thrown));
    assertStringIncludes(String(thrown), notOwnImage(local));
    assertEquals(calls.filter((c) => c[0] === "pull"), []);
  },
);

test("a locally built image is gone only when the daemon says so", async () => {
  const local = `${LOCAL}repo-abc:baked-env-1`;
  const down = (args: string[]) =>
    args[0] === "image"
      ? Promise.reject(new Error("docker image failed: Cannot connect to the Docker daemon"))
      : Promise.resolve("");
  const answer = await dockerCheckLauncher(OPTS, silentDiagnostics(), down).prepare!(
    [local],
    QUEUED,
  );
  assertEquals(answer.kind, "ready");
});

test(
  "a locally built image removed after the check is refused by create, never pulled",
  async () => {
    const local = `${LOCAL}repo-abc:baked-env-1`;
    const { id } = stored(local);
    const calls: string[][] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      if (args[0] === "container") return Promise.reject(new Error("No such object"));
      if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
      if (args[0] === "create" || args[0] === "run") {
        // `--pull never` on every container: docker refuses rather than ask a registry. Asked
        // for the id judged, which is what it says it lacks.
        assert(args.includes("never"), args.join(" "));
        return Promise.reject(new Error(`docker create failed: No such image: ${id}`));
      }
      return Promise.resolve("");
    };
    let thrown: unknown = null;
    await dockerCheckLauncher(OPTS, silentDiagnostics(), storeExec([stored(local)], exec))
      .launch({ ...SPEC, image: local })
      .catch((err) => thrown = err);
    assert(thrown instanceof ImageGone, String(thrown));
    assertEquals(calls.filter((c) => c[0] === "pull"), []);
  },
);

test("prepare: a pull past its time limit is answered as too slow", async () => {
  const d = pullingDaemon();
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), d.exec);
  await launcher.prepare!([SPEC.image], QUEUED);
  // What the timeout does: it aborts the signal, and docker's process dies with it.
  Object.defineProperty(d.pulls[0].signal!, "aborted", { value: true });
  d.pulls[0].done(new Error("killed"));
  await settle();
  const answer = await launcher.prepare!([SPEC.image], QUEUED);
  assertEquals(answer.kind, "failed");
  assertStringIncludes((answer as { why: string }).why, "took longer than 30 minutes");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** When the asking suite was queued: before any pull in these tests. */
const QUEUED = "2026-01-01T00:00:00.000Z";

test(
  "poll answers gone for no containers and unknown when docker cannot be asked",
  async () => {
    const empty = dockerCheckLauncher(OPTS, silentDiagnostics(), () => Promise.resolve(""));
    assertEquals(await empty.poll(SPEC.name), { kind: "gone" });
    const broken = dockerCheckLauncher(
      OPTS,
      silentDiagnostics(),
      () => Promise.reject(new Error("Cannot connect to the Docker daemon")),
    );
    assertEquals((await broken.poll(SPEC.name)).kind, "unknown");
  },
);

test(
  "a check docker will not start is reported as the container that could not run",
  async () => {
    const daemon = fakeDaemon({
      clone: st("clone", "exited"),
      "check-lint": st("check-lint", "created"),
    });
    const exec = (args: string[]) =>
      args[0] === "start"
        ? Promise.reject(new Error("docker start failed: oci"))
        : daemon.exec(args);
    const read = await dockerCheckLauncher(OPTS, silentDiagnostics(), exec).poll(SPEC.name);
    assert(read.kind === "checks");
    assertEquals(read.done, true);
    assertEquals((read.checks.lint as { exitCode: number }).exitCode, 125);
  },
);

test("launch creates everything, the clone last, then starts the clone", async () => {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    // No record yet.
    if (args[0] === "container") return Promise.reject(new Error("No such object"));
    if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
    return Promise.resolve("");
  };
  const db = { ...DB, image: "postgres:16" };
  await dockerCheckLauncher(OPTS, silentDiagnostics(), storeExec(PRESENT, exec))
    .launch({ ...SPEC, services: [db] });
  // Both on the ids their images resolved to (judged apart from these calls, `storeExec`).
  for (const create of calls.filter((c) => c[0] === "create" || c[0] === "run")) {
    assert(!create.includes(SPEC.image) && !create.includes(db.image), create.join(" "));
  }
  assert(calls.some((c) => c.includes(PRESENT[1]!.id)));
  const verbs = calls.map((c) =>
    c[0] === "create" || c[0] === "run" ? `${c[0]} ${c[c.indexOf("--name") + 1]}` : c.slice(0, 2)
      .join(" ")
  );
  assertEquals(verbs, [
    "container inspect",
    // Whatever an earlier launch left half-made goes first.
    "ps -aq",
    "volume ls",
    "network ls",
    // The pristine volume first: it dates the record while the images pull.
    // Each checked for this record's and deployment's labels as it is made.
    "volume create",
    "volume inspect",
    "volume create",
    "volume inspect",
    "volume create",
    "volume inspect",
    "volume create",
    "volume inspect",
    "volume create",
    "volume inspect",
    "network create",
    // Both images are present, so nothing is pulled.
    `run ${SPEC.name}-chown`,
    `create ${SPEC.name}-svc-postgres`,
    `create ${SPEC.name}-setup-0`,
    `create ${SPEC.name}-check-lint`,
    "network connect",
    `create ${SPEC.name}-check-test`,
    "network connect",
    `create ${SPEC.name}-clone`,
    "start ryph-check-cs-0123456789-g1-clone",
  ]);
});

test(
  "launching an existing record is success; a failed launch tears down what it made",
  async () => {
    const calls: string[][] = [];
    await dockerCheckLauncher(OPTS, silentDiagnostics(), (args) => {
      calls.push(args);
      return Promise.resolve(`${SPEC.name}|ryph_default`);
    }).launch(SPEC);
    assertEquals(calls.map((c) => c[0]), ["container"]);

    const made: string[][] = [];
    const failing = (args: string[]) => {
      made.push(args);
      if (args[0] === "container") return Promise.reject(new Error("No such object"));
      if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
      if (args[0] === "run") return Promise.reject(new Error("docker run failed: no chown"));
      if (args[0] === "ps") return Promise.resolve("");
      if (args[0] === "volume" && args[1] === "ls") {
        return Promise.resolve(made.some((c) => c[1] === "create") ? "v1\nv2\nv3" : "");
      }
      return Promise.resolve("");
    };
    await assertRejects(
      () =>
        dockerCheckLauncher(OPTS, silentDiagnostics(), storeExec(PRESENT, failing)).launch(SPEC),
      Error,
      "no chown",
    );
    assertEquals(
      made.filter((c) => c[0] === "volume" && c[1] === "rm").map((c) => c.at(-1)),
      ["v1", "v2", "v3"],
    );
  },
);

test("a launch never takes another deployment's volume or clone container by its name", async () => {
  // `volume create` answers an existing volume as made, labels ignored: the launch reads them.
  for (const foreign of [`${SPEC.name}|another-deployment`, `other-record|ryph_default`, "|"]) {
    const calls: string[][] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      if (args[0] === "container") return Promise.reject(new Error("No such object"));
      if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(foreign);
      return Promise.resolve("");
    };
    await assertRejects(
      () => dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch(SPEC),
      Error,
      "not this deployment's check record",
    );
    // Nothing mounted it, and only this record's own objects (by label) were torn down.
    assertEquals(calls.filter((c) => c[0] === "run" || c[0] === "create"), []);
    for (const listing of calls.filter((c) => c.includes("-q"))) {
      assertStringIncludes(listing.join(" "), "label=ryph.deployment=ryph_default");
    }
  }

  // A clone container by the name that is not ours: refused, not taken for a finished launch.
  const calls: string[][] = [];
  await assertRejects(
    () =>
      dockerCheckLauncher(OPTS, silentDiagnostics(), (args) => {
        calls.push(args);
        return Promise.resolve(args[0] === "container" ? `${SPEC.name}|another-deployment` : "");
      }).launch(SPEC),
    Error,
    "not this deployment's check record",
  );
  assertEquals(calls.map((c) => c[0]), ["container"]);
});

test("a volume by the pristine name that is not ours does not date a launch", async () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const young = new Date(now - 60_000).toISOString();
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), (args) => {
    if (args[0] === "ps") return Promise.resolve("");
    if (args[0] === "volume") return Promise.resolve(`${young}|${SPEC.name}|another-deployment`);
    return Promise.resolve("");
  }, () => now);
  assertEquals(await launcher.poll(SPEC.name), { kind: "gone" });
});

test(
  "logs are the stage container's, cut to the last bytes; a missing one is null",
  async () => {
    const calls: string[][] = [];
    const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), (args) => {
      calls.push(args);
      // Whose it is, by its labels: this suite's, of this deployment.
      if (args[0] === "inspect" && args.at(-1) === `${SPEC.name}-check-lint`) {
        return Promise.resolve(`cid-lint|${SPEC.name}|ryph_default`);
      }
      if (args[0] === "inspect" && args.at(-1) === `${SPEC.name}-check-test`) {
        return Promise.resolve(`cid-test|${SPEC.name}|another-deployment`);
      }
      if (args[0] === "logs" && args.at(-1) === "cid-lint") {
        return Promise.resolve("one\ntwo\nthree");
      }
      return Promise.reject(new Error("Error: No such container: x"));
    });
    assertEquals(await launcher.logs(SPEC.name, "check-lint", 9), "three");
    assertEquals(calls[0].slice(0, 3), ["inspect", "--type", "container"]);
    assertEquals(calls[1].slice(0, 2), ["logs", "--tail"]);
    assertEquals(await launcher.logs(SPEC.name, "clone", 100), null);
    // A container by the name that is another deployment's: never read.
    assertEquals(await launcher.logs(SPEC.name, "check-test", 100), null);
    assert(!calls.some((c) => c[0] === "logs" && c.at(-1) !== "cid-lint"));
  },
);

test("discard removes containers, then volumes, then the network — ours only", async () => {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return Promise.resolve("c1\nc2");
    if (args[0] === "volume" && args[1] === "ls") return Promise.resolve("v1");
    if (args[0] === "network" && args[1] === "ls") return Promise.resolve("n1");
    return Promise.resolve("");
  };
  await dockerCheckLauncher(OPTS, silentDiagnostics(), exec).discard(SPEC.name);
  assertEquals(calls.filter((c) => c.includes("rm")).map((c) => c.join(" ")), [
    "rm -fv c1",
    "rm -fv c2",
    "volume rm -f v1",
    "network rm n1",
  ]);
  for (const listing of calls.filter((c) => c.includes("-q"))) {
    assertStringIncludes(listing.join(" "), `label=${CHECK_LABEL}=${SPEC.name}`);
    assertStringIncludes(listing.join(" "), "label=ryph.deployment=ryph_default");
  }
});

test("list answers each record once, from its containers, volumes and networks", async () => {
  const launcher = dockerCheckLauncher(
    OPTS,
    silentDiagnostics(),
    (args) =>
      Promise.resolve(
        args[0] === "ps"
          ? "ryph-check-a-g1\nryph-check-a-g1\nryph-check-b-g1\n"
          : args[0] === "volume"
          // A launch that died before its first container: volumes only.
          ? "ryph-check-a-g1\nryph-check-c-g1\n"
          : "ryph-check-d-g1\n",
      ),
  );
  assertEquals(await launcher.list(), [
    "ryph-check-a-g1",
    "ryph-check-b-g1",
    "ryph-check-c-g1",
    "ryph-check-d-g1",
  ]);
});

test(
  "reclaim lists docker before reading the live names, and spares what they name",
  async () => {
    const calls: string[] = [];
    const exec = (args: string[]) => {
      calls.push(args.slice(0, 2).join(" "));
      if (args[0] === "ps") {
        return Promise.resolve("c-old\tryph-check-old-g1\nc-new\tryph-check-new-g1");
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return Promise.resolve("ryph-check-old-g1-pristine\tryph-check-old-g1");
      }
      if (args[0] === "network" && args[1] === "ls") {
        return Promise.resolve("n-old\tryph-check-old-g1\nn-new\tryph-check-new-g1");
      }
      return Promise.resolve("");
    };
    const reclaimed = await reclaimCheckOrphans(
      OPTS,
      () => {
        calls.push("live");
        return Promise.resolve(["ryph-check-new-g1"]);
      },
      silentDiagnostics(),
      exec,
    );
    assertEquals(calls, [
      "ps -a",
      "volume ls",
      "network ls",
      "live",
      "rm -fv",
      "volume rm",
      "network rm",
    ]);
    assertEquals(reclaimed, { containers: 1, volumes: 1, networks: 1 });
  },
);

test("one orphan docker will not remove does not starve the rest", async () => {
  const exec = (args: string[]) => {
    if (args[0] === "ps") return Promise.resolve("c-stuck\told\nc-ok\told");
    if (args[0] === "volume" || args[0] === "network") return Promise.resolve("");
    if (args.includes("c-stuck")) return Promise.reject(new Error("device busy"));
    return Promise.resolve("");
  };
  const reclaimed = await reclaimCheckOrphans(
    OPTS,
    () => Promise.resolve([]),
    silentDiagnostics(),
    exec,
  );
  assertEquals(reclaimed, { containers: 1, volumes: 0, networks: 0 });
});

test(
  "on a confined deployment every stage joins the internal network alone, and services' is internal",
  () => {
    const confined = {
      ...OPTS,
      runNetwork: "ryph-runs",
      gate: {
        image: "ryph-run-gate:dev",
        routes: [7411, 7460].map((port) => ({
          listen: port,
          target: "host.docker.internal",
          port,
        })),
      },
    };
    const plan = launchPlan({ ...SPEC, services: [DB] }, confined);
    for (const args of [plan.clone, ...plan.setup, ...plan.checks.map((c) => c.create)]) {
      assertEquals(flag(args, "--network"), ["ryph-runs"]);
      assertEquals(args.includes("--add-host"), false);
    }
    assert(plan.network!.includes("--internal"));
    // With the engine's isolated gateway, the suite's services network has no host address either.
    const isolated = launchPlan({ ...SPEC, services: [DB] }, { ...confined, isolateGateway: true });
    assert(isolated.network!.includes("com.docker.network.bridge.gateway_mode_ipv4=isolated"));
    assert(isolated.network!.includes("com.docker.network.bridge.gateway_mode_ipv6=isolated"));
    // And unconfined, exactly as before.
    const open = launchPlan({ ...SPEC, services: [DB] }, OPTS);
    assertEquals(flag(open.clone, "--network"), ["ryph_default"]);
    assert(open.clone.includes("--add-host"));
    assertEquals(open.network!.includes("--internal"), false);
  },
);

test(
  "a confined launch makes the gate first, and the suite's network as the engine isolates",
  async () => {
    const calls: string[] = [];
    const exec = (args: string[]): Promise<string> => {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("container inspect")) return Promise.reject(new Error("No such"));
      if (line.startsWith("volume inspect")) return Promise.resolve(OWN_VOLUME);
      if (line.startsWith("info")) return Promise.resolve("29.8.0|linux|Ubuntu 24.04.1 LTS");
      if (line.startsWith("network inspect")) return Promise.resolve("true|isolated|isolated");
      if (line.startsWith("inspect --type container")) return Promise.reject(new Error("No such"));
      return Promise.resolve("");
    };
    const confined = {
      ...OPTS,
      runNetwork: "ryph-runs",
      gate: {
        image: "ryph-run-gate:dev",
        routes: [7411, 7460].map((port) => ({
          listen: port,
          target: "host.docker.internal",
          port,
        })),
      },
    };
    await dockerCheckLauncher(confined, silentDiagnostics(), storeExec(PRESENT, exec)).launch({
      ...SPEC,
      services: [{ ...DB, image: "postgres:16" }],
    });
    const gateStarted = calls.indexOf("start ryph-gate-ryph_default");
    const suiteNetwork = calls.findIndex((c) =>
      c.startsWith("network create") && c.endsWith(SPEC.name)
    );
    assert(gateStarted !== -1 && suiteNetwork > gateStarted, "the gate comes first");
    assert(calls[suiteNetwork].includes("--internal"));
    assert(calls[suiteNetwork].includes("com.docker.network.bridge.gateway_mode_ipv6=isolated"));
  },
);

test("a suite launches on no image of another deployment's, whatever spelling resolves to it", async () => {
  const theirs = `${localImagePrefix("someone-else")}repo-abc:baked-env-1`;
  const mine = `${LOCAL}repo-abc:baked-env-1`;
  const foreign: FakeImage = { id: imageId("f"), names: [theirs, "ryph-env/repo-abc:baked-env-0"] };
  const untagged: FakeImage = { id: imageId("9"), names: [] };
  const own: FakeImage = { id: imageId("7"), names: [mine] };
  const store = [foreign, untagged, own];
  const hex = foreign.id.slice("sha256:".length);
  /** Spellings refused before docker is asked: docker would resolve each to a local image. */
  const refused = [
    hex.slice(0, 4),
    hex,
    `sha256:${hex.slice(0, 6)}`,
    `docker.io/${theirs}`,
    `index.docker.io/${theirs}`,
  ];
  /** Spellings docker resolves to another deployment's image, or to an untagged one. */
  const resolved = [
    theirs,
    "ryph-env/repo-abc:baked-env-0",
    foreign.id,
    `${theirs.split(":")[0]}@${foreign.id}`,
    untagged.id,
  ];

  const d = pullingDaemon();
  const prepareExec = storeExec(store, d.exec);
  const launcher = dockerCheckLauncher(OPTS, silentDiagnostics(), prepareExec);
  for (const image of refused) {
    const answer = await launcher.prepare!([image], QUEUED);
    assertEquals(answer.kind, "failed", image);
  }
  // Gone, worded exactly as an absent image of the same spelling is: prepare is no oracle.
  for (const image of resolved) {
    assertEquals(await launcher.prepare!([image], QUEUED), {
      kind: "gone",
      why: notOwnImage(image),
    });
  }
  assertEquals(await launcher.prepare!([`${LOCAL}absent:env-1`], QUEUED), {
    kind: "gone",
    why: notOwnImage(`${LOCAL}absent:env-1`),
  });
  // A registry's name another deployment tagged onto its image is met as absent: pulled.
  const shadowed = "quay.io/ryph/ryph-universal:1";
  const shadowStore = [...store, {
    id: imageId("5"),
    names: [shadowed, `${localImagePrefix("x")}a:b`],
  }];
  const shadow = dockerCheckLauncher(OPTS, silentDiagnostics(), storeExec(shadowStore, d.exec));
  assertEquals(await shadow.prepare!([shadowed], QUEUED), { kind: "pulling" });
  assertEquals(d.pulls.map((p) => p.image), [shadowed]);
  // This deployment's own, by its tag or its id: ready.
  for (const image of [mine, own.id]) {
    assertEquals(await launcher.prepare!([image], QUEUED), { kind: "ready" }, image);
  }

  const calls: string[][] = [];
  const exec = storeExec(shadowStore, (args: string[]) => {
    calls.push(args);
    if (args[0] === "container") return Promise.reject(new Error("No such object"));
    if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve(OWN_VOLUME);
    return Promise.resolve("");
  });
  const made = () => calls.filter((c) => c[0] === "create" || c[0] === "run");
  for (const image of [...resolved, shadowed]) {
    const suite = await assertRejects(() =>
      dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch({ ...SPEC, image })
    );
    assert(suite instanceof ImageGone, `${image}: ${String(suite)}`);
    // A service on one is refused outright, worded the same.
    const service = await assertRejects(() =>
      dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch({
        ...SPEC,
        image: mine,
        services: [{ ...DB, image }],
      })
    );
    assert(!(service instanceof ImageGone), String(service));
    assertStringIncludes(String(service), notOwnImage(image));
  }
  for (const image of refused) {
    const err = await assertRejects(() =>
      dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch({ ...SPEC, image })
    );
    assert(!(err instanceof ImageGone), String(err));
  }
  assertEquals(made(), []);
  // Its own goes ahead, every stage on the id judged.
  await dockerCheckLauncher(OPTS, silentDiagnostics(), exec).launch({ ...SPEC, image: mine });
  assert(made().length > 0 && made().every((c) => !c.includes(mine)));
  assert(made().some((c) => c.includes(own.id)));
});
