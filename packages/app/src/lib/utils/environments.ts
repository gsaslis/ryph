import type { EnvironmentDefinitionRead } from "$lib/api/environments";
import type {
  EnvironmentStatus,
  EnvironmentView,
  PatchBuild,
  RunEnvironment,
  SubjectEnvironment,
  SystemPayload,
} from "$lib/api/types";

// The environment card and the run page speak the user's vocabulary — Dockerfile, setup,
// environment — and nothing else: no layer, no digest, no build context. Everything that turns a
// wire field into words lives here, so the two pages cannot drift apart and the wording is tested.

/** A build's status in words. */
export function environmentStatusLabel(status: EnvironmentStatus): string {
  switch (status) {
    case "queued":
      return "Waiting to build";
    case "building":
      return "Building";
    case "ready":
      return "Ready";
    case "failed":
      return "Build failed";
    case "superseded":
      return "Replaced by a newer build";
  }
}

/** What kind of build it is, in words. */
export function buildKindLabel(kind: EnvironmentView["kind"]): string {
  switch (kind) {
    case "full":
      return "Full build";
    case "incremental":
      return "Incremental build";
    case "relayer":
      return "Platform update";
  }
}

/** Minutes, as people say them: "under a minute", "1 min", "25 min". */
export function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

/**
 * How far along a build is, against how long builds like it usually take here. Null for a build
 * that is not going. An estimate, said as one: a build past it is "taking longer than usual",
 * never late.
 */
export function buildProgress(
  build: Pick<EnvironmentView, "status" | "startedAt" | "estimateMs">,
  now: number,
): string | null {
  if (build.status === "queued") return "Waiting for a free builder";
  if (build.status !== "building" || build.startedAt === null) return null;
  const elapsed = Math.max(0, now - Date.parse(build.startedAt));
  const so = `${formatMinutes(elapsed)} so far`;
  if (build.estimateMs === null) return so;
  if (elapsed <= build.estimateMs) {
    return `${so}, usually takes about ${formatMinutes(build.estimateMs)}`;
  }
  return `${so}, longer than the usual ${formatMinutes(build.estimateMs)}`;
}

/** The last `lines` lines of a log, which is where a running build is. */
export function logTailLines(log: string, lines = 40): string {
  return log.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Whether a build is still going, so a page showing it keeps asking. */
export function isBuildActive(status: EnvironmentStatus): boolean {
  return status === "queued" || status === "building";
}

/**
 * What the card leads with — one answer to "what do runs here start on, and is anything
 * happening to it?". Checked in the order the answers override one another: a deployment with
 * environments off, or a backend that cannot build, makes everything else moot.
 */
export type EnvironmentHeadline =
  | { kind: "off" }
  | { kind: "refused"; reason: string }
  /** Nothing was ever built: runs start on the default image. */
  | { kind: "none" }
  | { kind: "ready"; current: EnvironmentView }
  /** A newer build is queued or running; `current` (if any) is what runs use meanwhile. */
  | { kind: "building"; build: EnvironmentView; current: EnvironmentView | null }
  /** The newest build failed; `current` (if any) is the older one runs still start on. */
  | { kind: "failed"; build: EnvironmentView; current: EnvironmentView | null };

export function environmentHeadline(env: SubjectEnvironment): EnvironmentHeadline {
  if (!env.enabled) return { kind: "off" };
  if (env.refusedReason !== null) return { kind: "refused", reason: env.refusedReason };
  const { current, latest } = env;
  const pending = latest !== null && latest.id !== current?.id ? latest : null;
  if (pending !== null && isBuildActive(pending.status)) {
    return { kind: "building", build: pending, current };
  }
  if (pending !== null && pending.status === "failed") {
    return { kind: "failed", build: pending, current };
  }
  if (current !== null) return { kind: "ready", current };
  return { kind: "none" };
}

/**
 * The newest build worth showing a log for: the pending one when there is one, else the one in
 * use. Null when nothing was ever built.
 */
export function latestBuild(env: SubjectEnvironment): EnvironmentView | null {
  return env.latest ?? env.current;
}

/** A commit id at the length people read one. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Which commit(s) an environment was built from. A repo has one checkout and gets the bare
 * commit; a workspace names each member's directory beside its commit.
 */
export function builtFromLabel(commits: Record<string, string>): string {
  const entries = Object.entries(commits);
  if (entries.length === 0) return "—";
  if (entries.length === 1) return shortCommit(entries[0][1]);
  return entries.map(([path, sha]) => `${path}@${shortCommit(sha)}`).join(", ");
}

/**
 * An image reference short enough for a line of text: the name without its registry, and the
 * pin cut to twelve characters — `ryph-envs/repo-1@sha256:0123456789ab…` reads as
 * `repo-1@0123456789ab`. The full reference stays available as a tooltip.
 */
export function shortImage(ref: string): string {
  const at = ref.indexOf("@");
  const name = at === -1 ? ref : ref.slice(0, at);
  const pin = at === -1 ? null : ref.slice(at + 1).replace(/^sha256:/, "").slice(0, 12);
  // Only the last path segment names the image; a tag stays attached to it.
  const last = name.slice(name.lastIndexOf("/") + 1);
  if (last === "" && pin !== null) return pin;
  return pin === null ? last : `${last}@${pin}`;
}

/**
 * What the machine is described by: the `.ryph/` of the repo or the workspace's members, or the
 * universal image when none has one, which every repo starts on until it says otherwise.
 */
export function machineLabel(
  view: Pick<EnvironmentView, "definition">,
  kind: "repo" | "workspace" = "repo",
): string {
  if (view.definition === null) return "Universal image (no .ryph/)";
  return kind === "repo" ? "The repository's .ryph/" : "The members' .ryph/";
}

const bytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** An image's size in the unit it is thought of in: 850 MB, 3.4 GB. */
export function formatBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${bytes.format(value)} ${units[unit]}`;
}

/** Toolchain versions in a stable order: the names sorted, so two builds compare line by line. */
export function toolchainEntries(toolchains: Record<string, string>): [string, string][] {
  return Object.entries(toolchains).sort(([a], [b]) => a.localeCompare(b));
}

/** The orchestrator's build triggers (`EnvironmentTrigger`), in words. */
const TRIGGERS: Record<string, string> = {
  manual: "rebuilt by hand",
  push: "after a push",
  reconcile: "scheduled check",
  harness: "platform upgrade",
  base: "universal image upgrade",
  run: "for a waiting run",
  patch: "for a patch",
  check: "for checks",
};

/** Why a build ran, in words; a trigger this page does not know is shown as it is. */
export function triggerLabel(trigger: string): string {
  return TRIGGERS[trigger] ?? trigger;
}

/** When a build finished, or — for one that has not — when it was asked for. */
export function builtAt(view: EnvironmentView): string {
  return view.finishedAt ?? view.startedAt ?? view.createdAt;
}

/** The environment id the orchestrator gives a run that started on the default image. */
export const DEFAULT_ENVIRONMENT_ID = "default";

/**
 * What a run started on, in one phrase for the run page's masthead — where it sits after the word
 * "Environment", so it says which one and not what it is.
 */
export function runEnvironmentLabel(env: RunEnvironment): string {
  if (env.id === DEFAULT_ENVIRONMENT_ID) return "Default image";
  const commits = Object.keys(env.commits).length === 0 ? null : builtFromLabel(env.commits);
  return commits === null ? "Custom image" : `Built from ${commits}`;
}

/**
 * The last `lines` lines of a log, for reading inline: a build log runs to thousands of lines,
 * and the failure is at the end.
 */
export function logTail(log: string, lines = 40): string {
  const all = log.replace(/\n+$/, "").split("\n");
  return all.slice(-lines).join("\n");
}

/**
 * The badge beside a platform message: what became of a patch, what the build a patch asked
 * for came to, that a change request merged with nothing of the run on it, or that a person
 * finished the run.
 */
export function systemPayloadLabel(payload: SystemPayload): string {
  if (payload.kind === "finish") return "finished the run";
  if (payload.kind === "checks") {
    return `${payload.partial ? "Selected checks" : "Checks"} ${
      payload.state === "error" ? "could not complete" : payload.state
    }`;
  }
  if (payload.kind === "patch") {
    if (payload.state === "held") return "patch needs approval";
    // As the patch's own badge says it.
    if (payload.state === "missed") return "patch not in merge";
    return `patch ${payload.state}`;
  }
  if (payload.kind === "released") return "change request merged";
  switch (payload.status) {
    case "ready":
      return "environment built";
    case "failed":
      return "environment build failed";
    case "superseded":
      return "environment build replaced";
    case "skipped":
      return "no environment build";
  }
}

/**
 * The card's call to set a repo up, which depends on what the default branch describes — the
 * slow half, read off the forge and streamed in after the page. So it is three states, not one:
 * still reading, could not be read, and the offer itself. `prominent` when the default branch
 * describes no machine at all — the moment the action is for; quiet ("Revise") once it does.
 * Null where it cannot be offered at all: environments off, a backend that cannot build, or a
 * card that could not be read.
 */
export type SetupAction =
  /** The forge has not answered yet. The card says so where the offer will go. */
  | { state: "reading"; note: string }
  /** It was asked and could not answer. Nothing is offered, and the card says why, quietly. */
  | { state: "unreadable"; note: string }
  | { state: "offer"; label: string; prominent: boolean };

function subjectNoun(kind: "repo" | "workspace"): string {
  return kind === "repo" ? "repository" : "workspace's environment repository";
}

export function setupAction(
  env: SubjectEnvironment | null,
  definition: EnvironmentDefinitionRead,
  kind: "repo" | "workspace" = "repo",
): SetupAction | null {
  if (env === null || !env.enabled || env.refusedReason !== null) return null;
  if (definition === null) {
    return {
      state: "reading",
      note: kind === "repo"
        ? "Reading what the repository describes…"
        : "Reading what the workspace's repositories describe…",
    };
  }
  if ("error" in definition) {
    return {
      state: "unreadable",
      note: `We couldn't read the ${subjectNoun(kind)} just now, so there is nothing to offer ` +
        "here. Reloading tries again.",
    };
  }
  if (definition.definition?.ryph) {
    return { state: "offer", label: "Revise environment", prominent: false };
  }
  return {
    state: "offer",
    label: `Set up this ${kind === "repo" ? "repo" : "workspace"}'s environment`,
    prominent: definition.definition !== null,
  };
}

/**
 * The workspace members whose Dockerfile the machine passes over. Null while the forge has not
 * answered or could not: the card says nothing rather than "no other member carries a
 * Dockerfile", which it does not yet know.
 */
export function ignoredDockerfiles(definition: EnvironmentDefinitionRead): string[] | null {
  return definition === null || "error" in definition ? null : definition.ignoredDockerfiles;
}

/** One patch's build as the run page lists it: what it came to, in words. */
export function patchBuildLabel(build: PatchBuild): string {
  if (build.environment === null) {
    // Neither a build nor a note: the check is still reading the forge, or retrying.
    return build.note ?? "Not checked yet — the platform retries on its own";
  }
  return environmentStatusLabel(build.environment.status);
}

/** Whether a build is ready but some repo's setup.yml did not finish in it: still usable, so
 * said as a warning rather than a failure. Missing warnings count as none, and so does a
 * `dirty` one: that setup finished, and only what it left in the tree was discarded. */
export function isReadyWithSetupWarnings(
  build: { status: EnvironmentStatus; setupWarnings?: readonly { kind?: string }[] | null },
): boolean {
  return build.status === "ready" &&
    (build.setupWarnings ?? []).some((warning) => warning.kind !== "dirty");
}

/** Whether some repo's setup.yml did not finish: any warning but `dirty` (that setup finished)
 * and `unreadable` (the build's record could not be read, so nobody knows). */
export function setupUnfinished(
  warnings: readonly { kind?: string }[] | null | undefined,
): boolean {
  return (warnings ?? []).some((w) => w.kind !== "dirty" && w.kind !== "unreadable");
}

/** The badge words for a ready build with setup warnings: that setup didn't finish, or — when
 * the only doubt is a record that could not be read — that nobody knows whether it did. */
export function setupWarningLabel(
  warnings: readonly { kind?: string }[] | null | undefined,
): string {
  if (setupUnfinished(warnings)) return "Setup didn't finish";
  if ((warnings ?? []).some((w) => w.kind === "unreadable")) return "Setup unknown";
  return "Setup changes discarded";
}

/** How long a build took, from its start to its end. Null for one that has not ended, or that
 * ended without starting (a queued build a newer one replaced). */
export function buildDurationMs(
  build: Pick<EnvironmentView, "startedAt" | "finishedAt">,
): number | null {
  if (build.startedAt === null || build.finishedAt === null) return null;
  return Math.max(0, Date.parse(build.finishedAt) - Date.parse(build.startedAt));
}

/** A build's status in one or two words, for a badge in a list. */
export function buildStatusShortLabel(status: EnvironmentStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "building":
      return "Building";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "superseded":
      return "Replaced";
  }
}
