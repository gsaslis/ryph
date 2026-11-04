// One deployment with environments ON, in memory: two connected repos (acme/api, acme/web), a
// workspace holding both, an echo agent, a forge whose `.ryph/` answers the test sets per
// (repo, ref), a builder the test settles by hand, and the service wired to its waiters exactly
// as main.ts wires it. The suites for resolution, scheduling and triggers all start here.

import type { Agent, ConnectedRepo, Workspace } from "../src/core/types.ts";
import {
  DEFAULT_ENVIRONMENTS_CONFIG,
  type EnvironmentsConfig,
} from "../src/core/environment_config.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { DEFAULT_RUN_SIZES } from "../src/core/run_sizes.ts";
import { startTask, type StartTaskArgs, type StartTaskDeps } from "../src/core/start_task.ts";
import { singleRepoStart, workspaceStartRepos } from "../src/core/workspaces.ts";
import { wireEnvironments } from "../src/environments.ts";
import { directorySkillCatalogue } from "../src/adapters/skill_catalogue/directory.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import type { EgressPolicy } from "../src/core/egress.ts";
import type { ForgeBranchKind, GithubModeSource, RyphBase, RyphTree } from "../src/ports/forge.ts";
import type {
  AdoptResult,
  AdoptSpec,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
  RemoveImagesSpec,
} from "../src/ports/environment_builder.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { fakeBuilder, memoryBuildLogs, memoryEnvironmentStore } from "./environment_doubles.ts";
import { fakeClock, fakeProvisioner, recordingDiagnostics, UNLIMITED } from "./doubles.ts";

export const HARNESS = `quay.io/ryph/ryph-harness@sha256:${"1".repeat(64)}`;
export const BASE = `quay.io/ryph/ryph-universal@sha256:${"2".repeat(64)}`;
export const AGENT_IMAGE = `quay.io/ryph/ryph-agent@sha256:${"3".repeat(64)}`;
export const T0 = "2026-01-01T00:00:00.000Z";

export const sha = (c: string) => c.repeat(40).slice(0, 40);
export const tree = (c: string) => `7${c}`.repeat(20).slice(0, 40);

function repo(id: string, repoRef: string): ConnectedRepo {
  return {
    id,
    provider: "github",
    installationId: "42",
    repoRef,
    url: `https://github.com/${repoRef}.git`,
    defaultBranch: "main",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

export const AGENT: Agent = {
  id: "a-1",
  name: "Ada",
  handle: "ada",
  email: "ada@example.com",
  systemPrompt: null,
  harnessKind: "echo",
  modelPolicy: null,
  toolPolicy: null,
  memoryPolicy: null,
  forgePolicy: null,
  skillPolicy: null,
  networkPolicy: null,
  limitPolicy: null,
  canOpenPatches: true,
  canPublishArtifacts: false,
  browserEnabled: false,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

/** The same agent on a harness that loads skills: a setup task needs one, for its pinned skill. */
export const SETUP_AGENT: Agent = {
  ...AGENT,
  id: "a-setup",
  handle: "ada-setup",
  harnessKind: "pi",
};

export interface WorldOptions {
  environments?: Partial<EnvironmentsConfig>;
  builderKind?: EnvironmentBuilder["kind"];
  auto?: (spec: BuildSpec) => BuildResult;
  /** What the builder says about a build this replica did not start; the default is `gone`. */
  adopt?: (spec: AdoptSpec) => AdoptResult | Promise<AdoptResult>;
  /** Called as the builder's record of a build is dropped: what the row says by then. */
  discard?: (environmentId: string) => void | Promise<void>;
  agentImage?: string | null;
  egress?: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
  gitGateway?: { url: string; keyTtlMs: number } | null;
  /** No service at all — the composition root built none. */
  noService?: boolean;
  abandonGraceMs?: number;
  /** What a running build has logged so far, per environment id (EnvironmentBuilder.liveLog). */
  liveLogs?: Map<string, string>;
  /** How the forge acts on GitHub; unknown (every row fits) by default. */
  githubMode?: GithubModeSource | null;
  /** Whether removing a build's images worked (EnvironmentBuilder.removeImages); true by default. */
  removeImages?: (spec: RemoveImagesSpec) => boolean | Promise<boolean>;
  /** What the builder's prune and reconcile answer, and its deletions per removal. */
  summaries?: NonNullable<Parameters<typeof fakeBuilder>[0]>["summaries"];
}

export async function world(opts: WorldOptions = {}) {
  const store = memoryTaskStore();
  const environmentStore = memoryEnvironmentStore({
    patches: async () => (await store.listPatches()).patches,
  });
  const logs = memoryBuildLogs();
  const clock = fakeClock(T0);
  const { diag, events: diagEvents } = recordingDiagnostics();
  const { provisioner, launches, kills } = fakeProvisioner();
  const built = fakeBuilder({
    kind: opts.builderKind,
    auto: opts.auto,
    adopt: opts.adopt,
    discard: opts.discard,
    liveLogs: opts.liveLogs,
    removeImages: opts.removeImages,
    summaries: opts.summaries,
  });

  // The forge's answers, per (repoRef, ref): the test moves a branch by setting its entry.
  const heads = new Map<string, RyphTree>();
  const kinds = new Map<string, ForgeBranchKind>();
  const unreachable = { value: false };
  // Where each head commit's `.ryph/` came from (`Forge.ryphBase`); unset is no shared history.
  const bases = new Map<string, RyphBase>();
  const key = (repoRef: string, ref: string) => `${repoRef}@${ref.replace(/^refs\/heads\//, "")}`;
  // A Dockerfile's blob id defaults to the tree's: any change under `.ryph/` is a new machine
  // unless the test says the Dockerfile stayed (by naming its blob).
  const setHead = (repoRef: string, ref: string, head: Partial<RyphTree> & { commit: string }) =>
    heads.set(key(repoRef, ref), {
      tree: null,
      dockerfile: false,
      ...head,
      fullTree: head.fullTree ?? head.tree ?? null,
      dockerfileBlob: head.dockerfile ? head.dockerfileBlob ?? head.tree ?? null : null,
    });
  const forge = noopForge(diag, {
    ryphTree(r, commitOrRef) {
      if (unreachable.value) throw new Error("forge unreachable");
      if (/^[0-9a-f]{40}$/.test(commitOrRef)) {
        const found = [...heads.values()].find((h) => h.commit === commitOrRef);
        return found ??
          {
            commit: commitOrRef,
            tree: null,
            fullTree: null,
            dockerfile: false,
            dockerfileBlob: null,
          };
      }
      return heads.get(key(r.repoRef, commitOrRef)) ??
        { commit: sha("0"), tree: null, fullTree: null, dockerfile: false, dockerfileBlob: null };
    },
    defaultBranchHead(r) {
      if (unreachable.value) throw new Error("forge unreachable");
      const current = defaultBranches.get(r.repoRef) ?? "main";
      return { ref: current, commit: heads.get(key(r.repoRef, current))?.commit ?? sha("0") };
    },
    ryphBase(_r, head) {
      if (unreachable.value) throw new Error("forge unreachable");
      return bases.get(head) ?? { base: sha("0"), mergeBase: null, tree: null, changed: [] };
    },
    branchKind(r, ref) {
      if (unreachable.value) throw new Error("forge unreachable");
      const bare = ref.replace(/^refs\/heads\//, "");
      return kinds.get(key(r.repoRef, bare)) ??
        (bare === (defaultBranches.get(r.repoRef) ?? "main") ? "default" : "branch");
    },
  });
  // The forge's own idea of each repo's default branch — what reconcile reads back.
  const defaultBranches = new Map<string, string>();

  const api = repo("cr-api", "acme/api");
  const web = repo("cr-web", "acme/web");
  await store.createConnectedRepo(api);
  await store.createConnectedRepo(web);
  await store.createAgent(AGENT);
  await store.createAgent(SETUP_AGENT);
  const workspace: Workspace = {
    id: "ws-1",
    name: "Shop",
    description: null,
    sizeClass: null,
    environmentRepoId: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  };
  await store.createWorkspace(workspace);
  for (const [i, member] of [api, web].entries()) {
    await store.addWorkspaceRepo({
      workspaceId: workspace.id,
      connectedRepoId: member.id,
      ref: null,
      path: member.repoRef.split("/")[1],
      description: null,
      createdAt: new Date(Date.parse(T0) + i).toISOString(),
      updatedAt: T0,
    }, 20);
  }

  const environments: EnvironmentsConfig = {
    ...DEFAULT_ENVIRONMENTS_CONFIG,
    enabled: true,
    builder: "docker",
    harnessImage: HARNESS,
    baseImage: BASE,
    ...opts.environments,
  };
  const config = {
    publicUrl: "http://orchestrator.test",
    browser: null,
    agentImage: opts.agentImage === undefined ? AGENT_IMAGE : opts.agentImage,
    runSizes: DEFAULT_RUN_SIZES,
    gitGateway: opts.gitGateway === undefined
      ? { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 }
      : opts.gitGateway,
    runHistoryUrl: null,
    services: DEFAULT_SERVICE_POLICY,
    egress: opts.egress ?? {
      policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
      key: null,
      tokenTtlMs: 0,
    },
    platformMemoryServerId: null,
    platformChatServerId: null,
    platformTools: {
      webServerId: "ms-platform-web",
      web: false,
      forge: null,
      pending: false,
    },
    appUrl: null,
    environments,
    limits: UNLIMITED,
  };
  const start: Omit<StartTaskDeps, "environments"> = {
    store,
    provisioner,
    diag,
    forge,
    now: clock.now,
    config,
    serviceCatalogue: null,
    skillCatalogue: await directorySkillCatalogue(),
    skills: null,
    memoryAccess: null,
    attachmentStore: null,
    identityDirectory: null,
    modelAccess: null,
    chatAccess: null,
    platformModel: null,
  };
  const wired = opts.noService ? null : wireEnvironments({
    environmentStore,
    builder: built.builder,
    logs,
    start,
    config,
    abandonGraceMs: opts.abandonGraceMs,
    githubMode: opts.githubMode ?? null,
  });
  const deps: StartTaskDeps = { ...start, environments: wired?.service ?? null };

  const base = { agent: AGENT, spec: { title: "T", instructions: "I" }, origin: "user" } as const;
  /** Starts a task on one repo at `ref` (default: its default branch). */
  const startRepo = (
    which: ConnectedRepo = api,
    ref = which.defaultBranch,
    extra: Partial<StartTaskArgs> = {},
  ) =>
    startTask(deps, {
      ...base,
      requestedByUserId: "u-1",
      repos: singleRepoStart(which, ref),
      ...extra,
    });
  /** Starts a task on the workspace; `refs` overrides members' refs by repo id. */
  const startWorkspace = async (
    refs: Record<string, string> = {},
    extra: Partial<StartTaskArgs> = {},
  ) => {
    const current = (await store.getWorkspace(workspace.id))!;
    const members = await store.listWorkspaceRepos(workspace.id);
    const resolved = await Promise.all(members.map(async (membership) => ({
      membership,
      repo: (await store.getConnectedRepo(membership.connectedRepoId))!,
    })));
    return startTask(deps, {
      ...base,
      requestedByUserId: "u-1",
      repos: workspaceStartRepos(resolved).map((r) =>
        r.connectedRepo !== null && refs[r.connectedRepo.id] !== undefined
          ? { ...r, ref: refs[r.connectedRepo.id] }
          : r
      ),
      workspace: current,
      ...extra,
    });
  };

  return {
    store,
    environmentStore,
    logs,
    clock,
    diag,
    diagEvents,
    provisioner,
    launches,
    kills,
    builder: built,
    forge,
    setHead,
    kinds,
    bases,
    key,
    defaultBranches,
    unreachable,
    api,
    web,
    workspace,
    config,
    deps,
    service: wired?.service ?? null,
    wired,
    startRepo,
    startWorkspace,
  };
}
