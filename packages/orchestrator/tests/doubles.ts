// Test doubles for the orchestrator's outward-facing ports, plus a controllable clock.

import type { LaunchSpec, Provisioner } from "../src/ports/provisioner.ts";
import type { CancelTarget, RunnerControl } from "../src/ports/runner_control.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";
import type { IdentityDirectory } from "../src/ports/identity_directory.ts";
import type { BuildSpec } from "../src/ports/environment_builder.ts";
import { DEFAULT_RUN_SIZES, type RunSize, type RunSizes } from "../src/core/run_sizes.ts";
import type { DeploymentLimits } from "../src/core/run_limits.ts";
import type { BrowserConfig } from "../src/core/browser.ts";
import { type ConnectedRepo, NO_RUN_LIMITS } from "../src/core/types.ts";
import {
  DEFAULT_ENVIRONMENTS_CONFIG,
  DEFAULT_HARNESS_KINDS,
  type EnvironmentsConfig,
} from "../src/core/environment_config.ts";

/** The git gateway a suite's runs clone through: with none configured, no task starts. */
export const TEST_GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 24 * 60 * 60 * 1000 };

/**
 * A repository on this machine, for suites whose subject is not repos: a task checks out only
 * connected repos, and a `local` one is the one any signed-in caller may write with no forge
 * login to ask about. It checks out at `repo/`.
 */
export const LOCAL_REPO: ConnectedRepo = {
  id: "cr-repo",
  provider: "local",
  installationId: null,
  repoRef: "/srv/repo",
  url: "/srv/repo",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A size class that constrains nothing — what an adapter test launches with when its subject
 * is anything but sizing, so the argv it pins is the one it always was. */
export const UNSIZED: RunSize = {
  name: "unsized",
  cpu: null,
  memory: null,
  ephemeralStorage: null,
  workVolume: null,
};

/** Run limits that cap nothing but credentials, generously — what a suite launches under when
 * limits are not its subject. */
export const UNLIMITED: DeploymentLimits = {
  ceiling: NO_RUN_LIMITS,
  concurrency: null,
  maxCredentials: 100,
  deadlineGraceMs: 0,
  startupGraceMs: 600_000,
};

/** The image, harness, size and limits slice of AppConfig every suite spreads in unless it is
 * the subject: one default image, the default kinds, the default size class, environments off,
 * no limits. */
export function imageConfig(overrides: Partial<{
  agentImage: string | null;
  harnessKinds: string[];
  runSizes: RunSizes;
  environments: EnvironmentsConfig;
  limits: DeploymentLimits;
  browser: BrowserConfig | null;
}> = {}) {
  return {
    agentImage: "ryph-agent:test",
    browser: null as BrowserConfig | null,
    harnessKinds: [...DEFAULT_HARNESS_KINDS],
    runSizes: DEFAULT_RUN_SIZES,
    environments: DEFAULT_ENVIRONMENTS_CONFIG,
    limits: UNLIMITED,
    ...overrides,
  };
}

export function fakeProvisioner(
  opts: { supportsBrowser?: boolean; browserRefusal?: Provisioner["browserRefusal"] } = {},
) {
  const launches: LaunchSpec[] = [];
  const kills: Array<{ handle: string; graceful: boolean }> = [];
  const provisioner: Provisioner = {
    ...(opts.supportsBrowser ? { supportsBrowser: true } : {}),
    ...(opts.browserRefusal ? { browserRefusal: opts.browserRefusal } : {}),
    launch(spec) {
      launches.push(spec);
      return Promise.resolve({ handle: `fake-${spec.runId}` });
    },
    kill(handle, { graceful }) {
      kills.push({ handle, graceful });
      return Promise.resolve();
    },
    inspect() {
      return Promise.resolve("unknown" as const);
    },
  };
  return { provisioner, launches, kills };
}

/**
 * Records every push the core asks for. `reachable` is whether the provisioner could place the
 * run (a docker run on the control plane's network): off by default, as on kubernetes and the
 * manual adapter, so only a test about the push sees one land.
 */
export function fakeRunnerControl(opts: { reachable?: boolean } = {}) {
  const cancels: CancelTarget[] = [];
  const control: RunnerControl = {
    requestCancel(run) {
      cancels.push({ id: run.id, handle: run.handle, controlToken: run.controlToken });
      return Promise.resolve(opts.reachable === true && run.handle !== null);
    },
  };
  return { control, cancels };
}

export function silentDiagnostics(): Diagnostics {
  return { debug() {}, warn() {} };
}

/** A Diagnostics that keeps every event and its fields, for the assertions that are about what
 * was RECORDED — a status capture before a delete has no other observable effect. */
export function recordingDiagnostics(): {
  diag: Diagnostics;
  events: Array<{ event: string; fields?: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return {
    diag: {
      debug: (event, fields) => void events.push({ event, fields }),
      warn: (event, fields) => void events.push({ event, fields }),
    },
    events,
  };
}

/** A clock the test moves by hand. */
export function fakeClock(startIso = "2026-01-01T00:00:00.000Z") {
  let nowMs = Date.parse(startIso);
  return {
    now: () => new Date(nowMs),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/** An `IdentityDirectory` over a map the test fills by hand — the link step, without auth.
 * Every user is active until the test says otherwise with `deactivate` (deleted or deactivated
 * read the same through the port), and may start tasks until `demote` makes them a viewer. */
export function fakeIdentityDirectory() {
  const logins = new Map<string, string>();
  /** `${provider}:${accountId}` → user id. */
  const accounts = new Map<string, string>();
  const inactive = new Set<string>();
  /** Active, but in a role without `tasks:create` (a viewer). */
  const demoted = new Set<string>();
  const names = new Map<string, string>();
  const key = (userId: string, provider: string) => `${provider}:${userId}`;
  const directory: IdentityDirectory = {
    subjectFor(userId, provider) {
      return Promise.resolve(logins.get(key(userId, provider)) ?? null);
    },
    userIdsForLogin(provider, login) {
      const ids = [...logins.entries()]
        .filter(([k, l]) => k.startsWith(`${provider}:`) && l === login)
        .map(([k]) => k.slice(provider.length + 1));
      return Promise.resolve(ids);
    },
    userIdsForAccount(provider, accountId) {
      const userId = accounts.get(`${provider}:${accountId}`);
      return Promise.resolve(userId === undefined ? [] : [userId]);
    },
    isActiveUser(userId) {
      return Promise.resolve(!inactive.has(userId));
    },
    mayStartTasks(userId) {
      return Promise.resolve(!inactive.has(userId) && !demoted.has(userId));
    },
    requesterFor(userId, provider) {
      const login = logins.get(key(userId, provider)) ?? null;
      return Promise.resolve(login === null ? null : { login });
    },
    nameFor(userId) {
      return Promise.resolve(inactive.has(userId) ? null : names.get(userId) ?? null);
    },
  };
  const link = (userId: string, login: string, provider = "github", accountId?: string) => {
    logins.set(key(userId, provider), login);
    if (accountId !== undefined) accounts.set(`${provider}:${accountId}`, userId);
  };
  const unlink = (userId: string, provider = "github") => void logins.delete(key(userId, provider));
  const deactivate = (userId: string) => void inactive.add(userId);
  const demote = (userId: string) => void demoted.add(userId);
  const name = (userId: string, display: string) => void names.set(userId, display);
  return { directory, link, unlink, deactivate, demote, name };
}

/** A commit id for environment builds. */
export const BUILD_COMMIT = "4f8d819622f4f3c79f24f45ae8173a97733987b8";

/** An environment build spec, one repo with a Dockerfile, for the builder suites. */
export function buildSpec(overrides: Partial<BuildSpec> = {}): BuildSpec {
  return {
    environmentId: "env-1",
    subjectKey: "repo-abc",
    dockerfileFrom: "heartwood",
    checkouts: [{ path: "heartwood", connectedRepoId: "cr-1", ref: "main", commit: BUILD_COMMIT }],
    baseImage: "registry.example/ryph-universal@sha256:" + "a".repeat(64),
    harnessImage: "registry.example/ryph-harness@sha256:" + "b".repeat(64),
    defaultBranch: true,
    cacheScope: { read: ["repo-abc-default"], write: "repo-abc-default" },
    relayerFrom: null,
    warmFrom: null,
    proxyEnv: {},
    clone: { urls: { heartwood: "http://forge.test/git/heartwood.git" }, env: {} },
    timeoutMs: 60 * 60 * 1000,
    ...overrides,
  };
}
