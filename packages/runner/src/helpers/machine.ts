// Your machine, described for the agent: the platform's own block, ahead of everything the repos
// say about their environment. A repo can
// describe its environment; it cannot hide from the agent that the environment is three days old,
// or that its warm checkout could not be used and the build ahead is a cold one.
//
// It also carries what the agent would otherwise spend turns discovering, or worse, assume: which
// everyday tools are on `PATH`, which toolchains the image's build recorded, that there is no
// container runtime anywhere near it, and whether anyone is going to answer a question.
//
// Invariants:
// - the block is the PLATFORM's: composed unconditionally, from the frozen spec, from what the
//   runner itself did, and from what it measured on this box — before any repo prose, and nothing
//   in any clone can suppress or rewrite it
// - it states only what the runner can establish here and now. Which image a run landed on is
//   never guessed from a tool being present; a fact that could not be established is left unsaid,
//   and the environment paragraph appears only when the control plane resolved one
// - the toolchain versions come from the run's SPEC — the record the control plane validated when
//   the environment was built — and never from the image's own copy at /opt/ryph-env: that path
//   is chowned to the run user, so a setup step could rewrite it between the build and this
//   sentence. A run on a baked image carries the same data in its spec already
// - a recorded version is still something a build produced by running repo-authored toolchains,
//   so it is rendered as inline code with its backticks and control characters stripped, each
//   entry clipped and the record capped: it can neither close the span nor outgrow the prompt.
//   Every other value is printed the same way, so a branch name cannot write prose of its own
// - the tool probe is a PATH LOOKUP and nothing else: a stat over the PATH entries, read for
//   the uid the run is, never a program run per tool
// - a repo whose setup did not finish is said here, in the platform's voice and ahead of the
//   repo's own prose (which may well say "everything is installed"): the step, its exit code, the
//   steps skipped and whether its changes to the tree were discarded — or why setup.yml was
//   refused, or that a repo's changes were discarded because another repo's step failed. The
//   step's output and the parser's error are repo-authored (and cleaned of escapes upstream),
//   so they are fenced with a fence nothing inside can close (@ryph/shared/markdown
//   `fence`) and capped, as a context file is
// - the whole block is bounded by construction — fixed prose, a fixed tool list, a capped
//   toolchain record, one table row per repo, one capped setup failure per repo — because it
//   rides the system prompt of every turn

import { stat } from "node:fs/promises";
import type { RunEnvironment } from "../core/types.ts";
import { egressProxyConfigured, type SetupFailure } from "./environment.ts";
import { fence } from "@ryph/shared/markdown";

export const MACHINE_HEADING = "## Your machine";

/**
 * The everyday tools the probe looks for, in the order the block lists them. A FIXED list, not a
 * survey of the image: the answer then has the same shape on every machine, and "absent" is as
 * much of an answer as "present". `docker` and `podman` earn their places by being what agents
 * keep reaching for — nothing on a ryph machine runs a container. The list is spelled out in
 * docs/harnesses.md and pinned there by a test.
 */
export const PROBED_TOOLS = [
  "rg",
  "fd",
  "jq",
  "just",
  "shellcheck",
  "mise",
  "rustup",
  "cargo",
  "node",
  "pnpm",
  "yarn",
  "deno",
  "bun",
  "python3",
  "uv",
  "go",
  "gh",
  "docker",
  "podman",
] as const;

/** The container runtimes the block speaks about by name. */
const CONTAINER_TOOLS = ["docker", "podman"];

/** How much of the toolchain record may reach the prompt: entries, and one entry's length. */
const MAX_TOOLCHAINS = 32;
const MAX_TOOLCHAIN_LEN = 80;
/** Ceiling for one inline value (an image reference is the longest real one). */
const MAX_INLINE = 200;
/** How much of a failed setup step's output tail the block quotes, per repo. runSetup bounds it
 * already; this holds the block's own bound whatever it is handed. */
const MAX_SETUP_OUTPUT = 2_000;

/** A repo whose setup did not finish: a step failed, or setup.yml was invalid. */
export interface RepoSetupFailure {
  /** The repo's directory in the checkout. */
  path: string;
  failure: SetupFailure;
  /** Whether what the failed step left in the tree was discarded (the checkout put back to its
   * base commit and branch, tracked and untracked changes gone — `checkout.ts`
   * `restoreCheckout`), so the run could start on a clean tree. */
  discarded?: boolean;
}

/** How one repo of the checkout came to be: adopted from the image, or cloned. */
export interface CheckoutOrigin {
  path: string;
  /** The commit the run starts from in this repo (its base). */
  head: string;
  /** `adopted`: the image's checkout, moved to `head`. `fallback`: the image had one, and it
   * could not be used. `cloned`: the image had none for this repo. */
  how: "adopted" | "fallback" | "cloned";
}

/** One probed tool, and whether `PATH` has it. */
export interface ToolPresence {
  name: string;
  present: boolean;
}

/** What the runner measured on this box, once, before the harness spawns. */
export interface MachineProbe {
  /** Every name of `PROBED_TOOLS`, in that order. */
  tools: readonly ToolPresence[];
  /**
   * Whether this run's children are routed through the deployment's egress proxy — all three of
   * `runChildEnv`'s variables set (helpers/environment.ts). Only then is there a network policy
   * to warn the agent about; a run without one is told nothing about the network, because
   * nothing here establishes what it can reach.
   */
  egress: boolean;
}

/** Everything the block is rendered from. */
export interface MachineFacts {
  /** The environment the control plane resolved; null when it resolved none (a CLI run, or
   * environments off) — then nothing is said about the image at all. */
  environment: RunEnvironment | null;
  /** How each repo of the checkout came to be, in checkout order. */
  checkouts: readonly CheckoutOrigin[];
  probe: MachineProbe;
  /** The repos whose setup did not finish (or whose changes were discarded for another repo's
   * failure), in checkout order; absent or empty when every repo's setup finished. */
  setupFailures?: readonly RepoSetupFailure[];
  /** The clock the image's age is measured against. */
  now?: Date;
  /**
   * Who reads it. The run's own agent (the default) is told the run's standing facts: that it
   * can be spoken to, and to verify before it finishes or submits a patch. A subagent
   * (core/subagents.ts) is spoken to by no one but the agent that started it, and finishes and
   * ships nothing, so it gets the machine's facts and none of the run's.
   */
  reader?: "run" | "subagent";
}

/**
 * The block. Pure over its inputs, so the rendering is testable without a machine to measure.
 */
export function describeMachine(facts: MachineFacts): string {
  const { environment, checkouts, probe } = facts;
  const now = facts.now ?? new Date();
  const lines = [MACHINE_HEADING, ""];
  if (environment !== null) lines.push(...environmentLines(environment, checkouts, now), "");
  for (const failed of facts.setupFailures ?? []) lines.push(...setupFailureLines(failed), "");
  lines.push(...toolLines(environment, probe), "");
  const run = (facts.reader ?? "run") === "run";
  lines.push(
    [
      // Must agree with the harness's finish instruction, which tells the same run that people
      // and the platform speak to it: "nobody answers" here would be a contradiction the model
      // has to resolve on its own.
      run && SPOKEN_TO,
      WORKING_AREA,
      probe.egress && EGRESS,
      run ? VERIFY_RUN : VERIFY_SUBAGENT,
    ].filter((part): part is string => typeof part === "string").join(" "),
  );
  return lines.join("\n").trimEnd();
}

/** The run's standing facts, a sentence or two each: who speaks to it, where its work goes, what
 * the network is, and when to verify. */
const SPOKEN_TO = "This run can be spoken to: messages from people and the platform arrive " +
  "while you work. Nobody is standing by, though — ask only when an answer is what you are " +
  "blocked on, and otherwise decide, proceed, and say what you assumed.";
const WORKING_AREA = "The checkout root and the clones under it are your working area: what " +
  "you commit there is the only thing that leaves this machine. Installs and caches land " +
  "wherever their tools put them — outside the checkout, by design — and that is fine.";
const EGRESS = "Outbound network access goes through the deployment's policy, so a download " +
  "that is refused is a boundary and not a fault to retry around.";
const VERIFY_RUN = "Before you finish, and before you submit a patch, verify your work the way " +
  "the repository does: run its tests, its linter, its typecheck.";
const VERIFY_SUBAGENT = "If you change anything, verify it the way the repository does: its " +
  "tests, its linter, its typecheck.";

/** The image the platform resolved for this run, and what each checkout under it cost. */
function environmentLines(
  env: RunEnvironment,
  checkouts: readonly CheckoutOrigin[],
  now: Date,
): string[] {
  if (!env.baked) {
    return [
      `This run is on the platform's default image, ${code(env.image)}. Nothing was prepared ` +
      "for these repositories ahead of time: each was cloned fresh and its setup steps run in " +
      "this run, so the first build is a cold one.",
    ];
  }
  const from = env.ref === null ? "" : `, from ${code(env.ref)}`;
  const lines = [
    `This run is on an environment image the platform built ahead of time: ${
      code(env.image)
    }, built ${age(env.builtAt, now)}${from}. Each repository it prepared was checked out in ` +
    "the image and its setup steps were run there, so what they built and installed — build " +
    "outputs, dependencies, caches — is already on disk. The run then moved each prepared " +
    "checkout to its own commit and ran the setup steps again: only what changed since the " +
    "build should need rebuilding.",
    "",
    "| Repository | Built from | This run starts at | Checkout |",
    "| ---------- | ---------- | ------------------ | -------- |",
    ...checkouts.map((c) => {
      const built = env.commits[c.path];
      return `| ${code(`${c.path}/`)} | ${built === undefined ? "—" : code(short(built))} | ${
        code(short(c.head))
      } | ${STATE[c.how]} |`;
    }),
  ];
  if (checkouts.some((c) => c.how !== "adopted")) {
    lines.push(
      "",
      "A repository that was cloned fresh starts cold: its first build compiles and installs " +
        "everything. That is expected, not a fault in the repository.",
    );
  }
  return lines;
}

/**
 * One repo whose setup did not finish: which step stopped it (or why setup.yml was unusable),
 * what was skipped, what that means for the agent, and the end of the step's output — quoted,
 * never in the platform's voice.
 */
function setupFailureLines({ path, failure, discarded }: RepoSetupFailure): string[] {
  if (failure.kind === "discarded") {
    const after = failure.after.map((p) => code(`${p}/`)).join(", ");
    return [
      `**Changes in ${code(`${path}/`)} were discarded.** Setup failed in ${after}, and ` +
      `${code(`${path}/`)} had changes afterwards (to tracked or untracked files, or to its ` +
      "HEAD) that could not be told apart from what the failed step did, so they were discarded " +
      "and the checkout put back to its base commit; ignored build output may remain. If this " +
      "repository's own setup generated tracked or untracked files, they are gone: check before " +
      "relying on them, and regenerate what your task needs.",
    ];
  }
  if (failure.kind === "dirty") {
    const files = failure.files.length === 0
      ? "a commit or a branch switch"
      : failure.files.slice(0, 10).map((f) => code(f)).join(", ") +
        (failure.files.length > 10 ? ", …" : "");
    return [
      `**Setup changes in ${code(`${path}/`)} were discarded.** Its setup finished, but left ` +
      `changes in the tree (${files}), and setup must not author work: they were discarded and ` +
      "the checkout put back to its base commit, so they are not taken for yours. Ignored build " +
      "output remains. If your task needs a file setup generated, regenerate it.",
    ];
  }
  const finish = "this repository's environment may be incomplete: what its setup steps would " +
    "have installed, built or generated may be missing. Before relying on it, check, and " +
    "finish setting it up yourself where your task needs it (its `.ryph/setup.yml` lists the " +
    "steps).";
  if (failure.kind === "invalid") {
    const error = failure.error.length > MAX_SETUP_OUTPUT
      ? `${failure.error.slice(0, MAX_SETUP_OUTPUT)}…`
      : failure.error;
    return [
      `**Setup did not run in ${code(`${path}/`)}: its \`.ryph/setup.yml\` is invalid.** ` +
      `None of its steps ran, and the run went on without them, so ${finish}`,
      "",
      `Why the file was refused:\n\n${fence(error)}`,
    ];
  }
  const skipped = failure.total - failure.index;
  const rest = skipped === 0
    ? "It was the last step."
    : `The ${plural(skipped, "step")} after it ${skipped === 1 ? "was" : "were"} skipped.`;
  const output = failure.output.length > MAX_SETUP_OUTPUT
    ? `…${failure.output.slice(-MAX_SETUP_OUTPUT)}`
    : failure.output;
  return [
    `**Setup failed in ${code(`${path}/`)}.** Step ${failure.index} of ${failure.total}, ` +
    `${code(failure.step)}, exited with code ${failure.code}. ${rest}` +
    (discarded
      ? " The step's tracked and untracked changes were discarded, and the checkout is back on " +
        "its base commit; ignored build output may remain."
      : "") +
    ` The run went on without it, so ${finish}`,
    "",
    output === ""
      ? "The step printed nothing."
      : `The end of the step's output, as the step printed it:\n\n${fence(output)}`,
  ];
}

/** What is on this machine: the build's toolchain record, the probe, and what follows from it. */
function toolLines(environment: RunEnvironment | null, probe: MachineProbe): string[] {
  const lines: string[] = [];
  const recorded = Object.entries(environment?.toolchains ?? {})
    .sort(([a], [b]) => a.localeCompare(b));
  if (recorded.length > 0) {
    const shown = recorded.slice(0, MAX_TOOLCHAINS)
      .map(([name, version]) => code(`${name} ${version}`, MAX_TOOLCHAIN_LEN));
    const rest = recorded.length > shown.length
      ? ` (the first ${shown.length} of ${recorded.length})`
      : "";
    lines.push(
      `Toolchains the image's build recorded, each as it reported its own version: ${
        shown.join(", ")
      }${rest}.`,
    );
  }

  const has = (name: string) => probe.tools.some((t) => t.name === name && t.present);
  const present = probe.tools.filter((t) => t.present).map((t) => t.name);
  const absent = probe.tools.filter((t) => !t.present).map((t) => t.name);
  const noContainer = !CONTAINER_TOOLS.some(has);
  const services = "A repository that needs a database or another service declares it in " +
    "`.ryph/services.yml`, and the platform runs it beside the run.";
  if (present.length === 0) {
    // A bare machine: one sentence, not two saying the same thing.
    lines.push(
      `None of ${
        list(probe.tools.map((t) => t.name))
      } is on \`PATH\` here, so no container runtime is on it either. ${services}`,
    );
    return lines;
  }
  lines.push(
    `Everyday tools on \`PATH\`, looked up on this machine before you started: ${list(present)}.` +
      (absent.length === 0 ? "" : ` Not installed: ${list(absent)}.`),
  );
  if (noContainer) {
    lines.push(
      `No container runtime is on \`PATH\`: ${
        list(CONTAINER_TOOLS)
      } are not installed, so do not plan on building or running a container. ${services}`,
    );
  }
  // What the probe establishes, and no more: that the version managers are there and which files
  // their shims key on. Whether a missing version installs itself on first use is the image's
  // configuration, which this cannot see.
  const pins = has("mise")
    ? "`mise` is on `PATH`, so its shims run the version a repository pins (`.nvmrc`, " +
      "`.tool-versions`, `.python-version`, `.go-version`, `mise.toml`)"
    : null;
  const rust = has("rustup")
    ? "`rustup` is on `PATH`, so `rust-toolchain.toml` is honoured on the first `cargo` call"
    : null;
  const both = [pins, rust].filter((part): part is string => part !== null);
  if (both.length > 0) {
    lines.push(
      `${both.join(", and ")}. Run the repository's own commands rather than installing a ` +
        "toolchain yourself.",
    );
  }
  return lines;
}

/**
 * What the runner measures on this box, once per run, before the harness spawns. Nothing here can
 * fail the run — a machine nobody can describe is still a machine an agent can work on.
 */
export async function probeMachine(
  opts: { names?: readonly string[]; path?: string; egress?: boolean } = {},
): Promise<MachineProbe> {
  const tools = await probeTools(opts.names ?? PROBED_TOOLS, opts.path ?? process.env.PATH);
  // Whether there IS a policy is `runChildEnv`'s knowledge, asked rather than re-derived here:
  // the three variables it wants are named in one place, and this cannot drift from what the
  // agent's own environment will actually carry.
  return { tools, egress: opts.egress ?? egressProxyConfigured() };
}

/**
 * Which of `names` resolve to an executable on `PATH`, in the order given. A lookup and nothing
 * more — one stat per candidate, no subprocess — so it costs milliseconds, answers the same way
 * twice, and runs nothing.
 */
export async function probeTools(
  names: readonly string[],
  path: string | undefined,
  user: RunUser | null = runUser(),
): Promise<ToolPresence[]> {
  const dirs = (path ?? "").split(":").filter((dir) => dir !== "");
  const found: ToolPresence[] = [];
  for (const name of names) {
    let present = false;
    for (const dir of dirs) {
      if (await isExecutable(`${dir}/${name}`, user)) {
        present = true;
        break;
      }
    }
    found.push({ name, present });
  }
  return found;
}

/** The identity a lookup is answered for — whose execute bit counts. */
export interface RunUser {
  uid: number;
  gid: number;
}

/**
 * Who this process is, when it may ask. On a platform with no uids the answer is null and
 * `isExecutable` falls back to the `other` bit alone. That errs toward saying a tool is absent —
 * a root-owned `0750` binary the run user could run through its group reads as missing — which
 * costs the agent one `bash` call and never sends it at a binary it cannot execute.
 */
function runUser(): RunUser | null {
  try {
    const uid = process.getuid?.() ?? null;
    const gid = process.getgid?.() ?? null;
    return uid === null || gid === null ? null : { uid, gid };
  } catch {
    return null;
  }
}

/**
 * A regular file THIS USER may execute, symlinks followed (`/usr/local/bin/fd` is one). The bit
 * that counts is POSIX's: owner, else group, else other — a root-owned `0700` binary is not an
 * executable for uid 1994, and reporting it as one would send the agent at a permission error.
 * Only the primary group is counted here, so a binary the
 * run user may execute through a supplementary group reads as absent: the probe under-reports
 * rather than promising a tool the run cannot use.
 */
async function isExecutable(path: string, user: RunUser | null): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    // No execute bits on this platform (Windows): being a file is the whole answer.
    if (process.platform === "win32") return true;
    const bit = user === null
      ? 0o001
      : info.uid === user.uid
      ? 0o100
      : info.gid === user.gid
      ? 0o010
      : 0o001;
    return (info.mode & bit) !== 0;
  } catch {
    // absent, unreadable, a dangling link, a directory in the way — all "not on PATH" from here
    return false;
  }
}

const STATE: Record<CheckoutOrigin["how"], string> = {
  adopted: "prepared in the image (warm)",
  fallback: "cloned fresh — the prepared checkout could not be used (cold)",
  cloned: "cloned fresh — the image has none for it (cold)",
};

/** `3 days ago (2026-09-15T08:00:00Z)`, or a plain admission that nobody recorded when. */
export function age(builtAt: string | null, now: Date): string {
  if (builtAt === null) return "at a time nobody recorded";
  const at = new Date(builtAt);
  if (Number.isNaN(at.getTime())) return "at a time nobody recorded";
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  const ago = minutes < 60
    ? plural(minutes, "minute")
    : minutes < 48 * 60
    ? plural(Math.round(minutes / 60), "hour")
    : plural(Math.round(minutes / (24 * 60)), "day");
  return `${ago} ago (${at.toISOString()})`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** An inline-code list, in the order given: `a`, `b` and `c`. */
function list(names: readonly string[]): string {
  const spans = names.map((name) => code(name));
  if (spans.length <= 1) return spans.join("");
  return `${spans.slice(0, -1).join(", ")} and ${spans.at(-1)}`;
}

/** Inline code nothing inside can close: backticks gone, control and format characters gone (a
 * newline would end both the span and the line), and the whole thing clipped. */
function code(text: string, max = MAX_INLINE): string {
  const flat = text.replace(/`/g, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  // A value that was nothing but backticks and control characters would leave an empty span,
  // which renders as two literal backticks; name the gap instead.
  if (flat.length === 0) return "`(unprintable)`";
  return `\`${flat.length > max ? `${flat.slice(0, max)}…` : flat}\``;
}
