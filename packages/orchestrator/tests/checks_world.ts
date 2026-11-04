// One deployment with checks ON, in memory: the environments world (tests/environment_world.ts —
// two connected repos, environments on, a builder the test settles) plus a check store, a
// launcher the test scripts, and a forge whose `.ryph/checks.yml` answers the test sets per ref.
// A run is started on acme/api's `main`, so every suite has a live asker.

import { assert } from "@std/assert";
import { type CheckPolicy, DEFAULT_CHECK_POLICY } from "../src/core/check_policy.ts";
import type { CheckSuite } from "../src/core/check_types.ts";
import type { RunSizes } from "../src/core/run_sizes.ts";
import { checkRecordName, type ChecksService } from "../src/core/checks.ts";
import { DEFAULT_SERVICE_POLICY, type ServicePolicy } from "../src/core/services.ts";
import { wireChecks } from "../src/checks.ts";
import type { ChecksFile, ReportChecksOutcome } from "../src/ports/forge.ts";
import type { CheckReport } from "../src/ports/forge.ts";
import type { ServiceCatalogueEntry } from "../src/core/services.ts";
import type { Patch, Run } from "../src/core/types.ts";
import { AGENT_IMAGE, sha, T0, world, type WorldOptions } from "./environment_world.ts";
import { fakeCheckLauncher, memoryCheckStore } from "./check_doubles.ts";

export { AGENT_IMAGE, sha, T0 };

export const HEAD = sha("d");
export const BLOB = sha("c");
export const BASE = sha("a");
export const APP_URL = "https://app.test";

export const CHECKS_YML = `setup:
  - run: npm ci
checks:
  - name: lint
    run: deno lint
  - name: test
    run: deno task test
    timeout: 20m
    watch: [deno.json]
`;

/** A checks file as the forge answers one, at the base's commit. */
export function checksFile(over: Partial<Extract<ChecksFile, { kind: "file" }>> = {}): ChecksFile {
  return {
    kind: "file",
    text: CHECKS_YML,
    path: ".ryph/checks.yml",
    commit: BASE,
    blob: BLOB,
    ryphTree: null,
    dockerfile: false,
    services: { kind: "absent" },
    ...over,
  };
}

export const POSTGRES: ServiceCatalogueEntry = {
  id: "postgres",
  name: "PostgreSQL",
  description: "",
  docs: "https://example.test",
  versions: { "18": `postgres:18@sha256:${"a".repeat(64)}` },
  defaultPort: 5432,
  capabilities: ["CHOWN", "SETGID", "SETUID"],
  memory: "512m",
  env: ["POSTGRES_PASSWORD"],
};

export interface ChecksWorldOptions {
  remote?: import("../src/ports/remote_checks.ts").RemoteChecks;
  world?: WorldOptions;
  canOpenPatches?: boolean;
  policy?: Partial<CheckPolicy>;
  services?: ServicePolicy;
  appUrl?: string | null;
  /** No launcher: a provisioner with no check pods. */
  noLauncher?: boolean;
  /** Environments are wired but this suite wants them absent from checks. */
  noEnvironments?: boolean;
  /** How long the tool waits for its request to resolve. */
  answerWithinMs?: number;
  /** The deployment's size classes; the world's own (one class) by default. */
  runSizes?: RunSizes;
}

export async function checksWorld(opts: ChecksWorldOptions = {}) {
  const w = await world(opts.world);
  w.setHead("acme/api", "main", { commit: BASE, tree: null });
  const store = memoryCheckStore(w.store);
  const launched = fakeCheckLauncher();
  // What `.ryph/checks.yml` reads as, per ref; "*" for any ref not named.
  const files = new Map<string, ChecksFile>([["*", checksFile()]]);
  const reads: string[] = [];
  w.forge.readChecksFile = (_repo, _url, ref) => {
    reads.push(ref);
    return Promise.resolve(structuredClone(files.get(ref) ?? files.get("*")!));
  };
  const reportAnswer: { fn: ((report: CheckReport) => ReportChecksOutcome) | null } = { fn: null };
  const reports: CheckReport[] = [];
  let refCounter = 0;
  w.forge.reportChecks = (_repo, report) => {
    reports.push(structuredClone(report));
    if (reportAnswer.fn !== null) return Promise.resolve(reportAnswer.fn(report));
    const refs = Object.fromEntries(
      report.checks.map((c) => [c.name, c.forgeRef ?? `cr-${++refCounter}`]),
    );
    return Promise.resolve({ kind: "reported" as const, refs });
  };
  const policy: CheckPolicy = { ...DEFAULT_CHECK_POLICY, enabled: true, ...opts.policy };
  const wired = wireChecks({
    remote: opts.remote,
    store,
    tasks: w.store,
    launcher: opts.noLauncher ? null : launched.launcher,
    forge: w.forge,
    environments: opts.noEnvironments ? null : w.service,
    logs: w.logs,
    serviceCatalogue: { list: () => Promise.resolve([POSTGRES]) },
    diag: w.diag,
    now: w.clock.now,
    config: {
      policy,
      agentImage: w.config.agentImage,
      runSizes: opts.runSizes ?? w.config.runSizes,
      gitGateway: w.config.gitGateway,
      services: opts.services ?? DEFAULT_SERVICE_POLICY,
      egress: w.config.egress,
      appUrl: opts.appUrl === undefined ? APP_URL : opts.appUrl,
    },
    nonce: () => "NONCE",
    answerWithinMs: opts.answerWithinMs,
  });
  const service: ChecksService = wired.service;

  const createTask = w.store.createTask;
  if (opts.canOpenPatches !== undefined) {
    w.store.createTask = (task, run) => {
      run.workItem = { ...run.workItem, canOpenPatches: opts.canOpenPatches! };
      return createTask(task, run);
    };
  }
  const outcome = await w.startRepo(w.api, "main");
  w.store.createTask = createTask;
  assert(outcome.kind === "started", JSON.stringify(outcome));
  const run: Run = (await w.store.getRun(outcome.runId))!;

  const request = (
    over: Partial<{ headSha: string; branch: string; path: string; checks: string[] }> = {},
  ) =>
    service.requestForRun(run, {
      path: "api",
      headSha: HEAD,
      branch: `${run.branchNamespace}/work`,
      baseSha: BASE,
      ...over,
    });
  const suites = () => [...store.suites.values()];
  const onlySuite = (): CheckSuite => {
    const all = suites();
    assert(all.length === 1, `expected one suite, have ${all.length}`);
    return all[0];
  };
  const nameOf = (suite: CheckSuite) => checkRecordName(suite);
  const told = async (runId = run.id) =>
    (await w.store.listRunMessages(runId)).filter((m) =>
      m.sender.kind === "platform" && m.text.includes("checks")
    );
  const patchOf = (over: Partial<Patch> = {}): Patch => ({
    id: "p-1",
    connectedRepoId: w.api.id,
    runId: run.id,
    taskId: run.taskId,
    setId: "ps-1",
    path: "api",
    line: "work",
    branchName: `${run.branchNamespace}/work`,
    headSha: HEAD,
    bundleKey: `${run.id}/work/${w.api.id}/${HEAD}.bundle`,
    baseSha: BASE,
    generation: 1,
    title: null,
    description: null,
    commits: [],
    carries: [],
    state: "pending_approval",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    approvedBy: null,
    approvedAt: null,
    forgeRef: null,
    forgeUrl: null,
    forgeBranch: null,
    diffRef: null,
    landed: null,
    supersededByPatchId: null,
    hookCheck: null,
    approvedHookPaths: [],
    memoryFateReportedAt: null,
    mergedCuedAt: null,
    heldReason: null,
    mergedCueClaimedAt: null,
    landingAskedAt: null,
    version: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  return {
    ...w,
    checkStore: store,
    launched,
    files,
    reads,
    reports,
    reportAnswer,
    /** The CHECKS service. `environmentService` is the build queue's. */
    service,
    checksService: service,
    /** How many verdicts the world's run is still owed. */
    awaiting: async (runId = run.id) => (await wired.awaiting(runId)).length,
    /** Which verdicts the world's run is still owed. */
    owed: (runId = run.id) => wired.awaiting(runId),
    checksAwaiting: wired.awaiting,
    environmentService: w.service,
    policy,
    run,
    request,
    suites,
    onlySuite,
    nameOf,
    told,
    patchOf,
  };
}
