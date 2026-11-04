// ryph-bake — runs a checkout's setup.yml at image build time, and records what the image carries.
//
// An environment image contains the checkout itself, with its
// setup already run: the builder clones each repo to /ryph/work/<path>, then runs this binary in
// a `RUN` step. It is the runner's step executor compiled on its own — the same strict setup.yml
// parser, the same `bash -c`, the same clean-tree check — and deliberately a separate binary, so
// that a runner release does not change the build stage's cache key.
//
//   ryph-bake --phase image /ryph/work [--toolchains-out /opt/ryph-env/toolchains.json]
//             [--setup-warnings-out /opt/ryph-env/setup-warnings.json]
//
// Invariants:
// - the steps are the run's steps: parsed by helpers/environment.ts and run by its `runSetup`,
//   never by a second implementation that could accept what a run would refuse
// - every step sees `${ENV_PREFIX}_SETUP_PHASE` set to the phase given here
// - a repo's steps leave its tree clean, checked once after EVERY repo's steps have run, as a
//   run checks it — anything setup leaves in a tree would otherwise be committed as the agent's.
//   What it does leave is put back and warned about (`dirty`), never the build's failure; only
//   a tree that cannot be put back fails it
// - a failing step, or an invalid setup.yml, is a WARNING, as it is at run time, never the
//   build's failure: setup is an optimization, the run reruns it and warns again, and a repo
//   with its own Dockerfile would otherwise have every run refused over a step. That repo's
//   remaining steps are skipped, its checkout is put back to where it started (so the clean-tree
//   check holds for the repos whose setup succeeded — and when a step failed, a sibling found
//   changed is put back too, with a warning naming both, as a run does), the image is
//   finished as usual, and the warnings are written beside the toolchain record
//   (`SETUP_WARNINGS_OUT`), where the builder reads them onto the build's row and the build's
//   feedback
// - it bakes as the uid that owns the checkouts, or not at all: what setup builds (target/,
//   node_modules/) must be writable by the run that adopts it, and a bake as root would leave it
//   root-owned — a run that cannot rebuild its own warm tree is worse off than a cold one
// - any other failure exits non-zero with one readable line naming the repo; bad usage exits 2
// - the toolchain record never lands under /opt/ryph: the harness layer is copied over that
//   path after this step, so anything written there would vanish
// - in the image phase only, every file git tracks is pinned to whole seconds before any step
//   runs (`pinTrackedMtimes`): image layers keep whole-second mtimes, so a build tool that
//   fingerprinted the nanoseconds it saw here (cargo does) would rebuild at every run. Never in
//   the run phase: there the fractions mark what the run's own checkout rewrote
// - after pinning, every cargo package has one newest file, never a tie (`package.include`/
//   `exclude` aside, and a workspace root with no lock and no tied target source), so cargo's
//   newest-file fingerprint names the same file in the image and at run time

import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";
import { command, type CommandOutput } from "@ryph/process";
import { LogLevel, setupLoggerFromEnv } from "@ryph/logger";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import { changedPaths, checkoutStart, putBack } from "./helpers/checkout.ts";
import {
  dirtyNote,
  discoverSetup,
  MAX_DIRTY_FILES,
  runSetup,
  scrubbedEnv,
  type SetupFailure,
  type SetupPhase,
  type SetupStepFailure,
  stepLabel,
} from "./helpers/environment.ts";
import { type Git, type GitBounded, makeGit, makeGitBounded } from "./helpers/git_exec.ts";
import { isCheckout } from "./helpers/adopt.ts";
import { errorMessage } from "./helpers/errors.ts";
import { hostileEnvironment } from "@ryph/shared/env";

/** Where the toolchain record goes unless `--toolchains-out` says otherwise. The runner does not
 * read this file: a run that is on a baked image carries the same record in its spec, validated
 * by the control plane, while this path is chowned to the run user and a setup step could rewrite
 * it. The builder reads it out of the image's `toolchains` stage
 * (@ryph/orchestrator's environment_builder/dockerfile.ts). */
export const TOOLCHAINS_OUT = "/opt/ryph-env/toolchains.json";

/** Where the setup warnings go unless `--setup-warnings-out` says otherwise: beside the
 * toolchain record, written on every bake — `[]` when there are none, so a warm build's bake
 * replaces the earlier image's. The builder carries it out with the toolchain record
 * (@ryph/orchestrator's environment_builder/dockerfile.ts, `SETUP_WARNINGS_FILE` there). */
export const SETUP_WARNINGS_OUT = "/opt/ryph-env/setup-warnings.json";

/**
 * The longest the warnings file may be, in bytes. A builder reads it back through a channel
 * that keeps only so much (Cloud Build stores 4 KiB of a step's output, and the result lines
 * share it), so output tails are dropped before an entry is, and entries past the cap last.
 */
export const MAX_SETUP_WARNINGS_BYTES = 2_500;
/** How much of a failed step's output tail one warning keeps; the build log has all of it. */
const WARNING_OUTPUT_MAX = 600;
/** How long an error or a label is once the warnings have to be shortened to fit. */
const SHORT_TEXT_MAX = 100;

/** The builder's record of member order; one repo path per line. */
const ORDER_FILE = ".order";

/**
 * The toolchains recorded, and how each reports its version. Whichever exist: a Dockerfile
 * `FROM rust:1.97` has no node, and that is an answer, not an error.
 */
const TOOLCHAINS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: "rustc", args: ["--version"] },
  { name: "cargo", args: ["--version"] },
  { name: "node", args: ["--version"] },
  { name: "deno", args: ["--version"] },
  { name: "bun", args: ["--version"] },
  { name: "python3", args: ["--version"] },
  { name: "go", args: ["version"] },
  { name: "uv", args: ["--version"] },
];

/**
 * The longest one recorded version may be. The result block a build prints has 4 KiB in all
 * (Cloud Build): ~450 bytes of digest, baked, machine and warm lines, the toolchains line —
 * at most `TOOLCHAINS.length` × (this + ~20 bytes of JSON) plus its marker, ~700 — and the
 * setup warnings, at most `MAX_SETUP_WARNINGS_BYTES` + its marker. ~3.7 KiB, so the warnings
 * line, printed last, is never the one cut.
 */
export const MAX_VERSION_LEN = 64;

export interface BakeOpts {
  /** The directory whose immediate children are the checkouts (`/ryph/work`). */
  root: string;
  phase: SetupPhase;
  /** Where the toolchain versions are written, as JSON. */
  toolchainsOut: string;
  /** Where the setup warnings are written, as JSON (`serializeWarnings`); absent, nowhere — the
   * binary always names one, a test need not. */
  warningsOut?: string;
  diag: Diagnostics;
  /** Aborting kills the in-flight step; `bake` then throws, since nothing was baked. */
  signal?: AbortSignal;
  /** The uid the steps run as — this process's; a test names another. Null skips the check
   * (a platform with no uids). */
  uid?: number | null;
}

/**
 * A repo whose setup did not finish at bake time, as the warnings file records it — the same
 * shape a run reports its own with (@ryph/orchestrator's `SetupWarning`).
 */
export type SetupWarning =
  | (Omit<SetupStepFailure, "kind"> & { kind: "step"; path: string; discarded: boolean })
  | { kind: "invalid"; path: string; error: string }
  /** Changes in a repo whose own setup did not fail, discarded because a step failed in
   * `after` (helpers/environment.ts `SetupDiscarded`). */
  | { kind: "discarded"; path: string; after: string[] }
  /** Changes this repo's own setup left when no step failed anywhere, discarded
   * (helpers/environment.ts `SetupDirty`). */
  | { kind: "dirty"; path: string; files: string[] };

/** What one bake did: the repos in the order they ran, the toolchains it found, in the image
 * phase what `pinTrackedMtimes` did to each repo (empty in the run phase), and the repos whose
 * setup did not finish. */
export interface BakeResult {
  repos: string[];
  toolchains: Record<string, string>;
  pinned: Record<string, PinnedMtimes>;
  warnings: SetupWarning[];
}

/** The longest the bake waits for the clock to pass a time it raised a file to. */
const MAX_RAISE_WAIT_MS = 2000;

/** Resolves after `ms`, or rejects with the abort's reason. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bounds the tracked-file listing: 64 MiB of NUL-separated paths is far past any real repo. */
const MAX_LS_FILES_BYTES = 64 * 1024 * 1024;

/**
 * Runs every checkout's setup.yml under `opts.root`, in member order, then records the
 * toolchain versions and the setup warnings. A failing step or an invalid setup.yml is a
 * warning; anything else throws with a message naming the repo.
 */
export async function bake(opts: BakeOpts): Promise<BakeResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const git = makeGit(opts.diag);
  const repos = await memberOrder(opts.root);
  const dirs = repos.map((path) => ({ path, dir: `${opts.root}/${path}` }));
  const uid = opts.uid === undefined ? (process.getuid?.() ?? null) : opts.uid;
  for (const { path, dir } of dirs) {
    const owner = (await stat(dir)).uid;
    if (uid !== null && owner !== null && owner !== uid) {
      throw new Error(
        `${path}: the checkout is owned by uid ${owner}, but ryph-bake runs as uid ${uid}; ` +
          `bake as the checkout's owner (USER ${owner}), so what setup builds stays writable by ` +
          "the run",
      );
    }
  }

  // Every tree, before any step: a repo's setup may build another repo's sources.
  const pinned: Record<string, PinnedMtimes> = {};
  if (opts.phase === "image") {
    const gitBounded = makeGitBounded(opts.diag);
    for (const { path, dir } of dirs) {
      try {
        pinned[path] = await pinTrackedMtimes(git, gitBounded, dir, signal);
      } catch (err) {
        throw new Error(`${path}: pinning tracked files to whole seconds: ${errorMessage(err)}`);
      }
      opts.diag.debug("bake.mtimes", { path, ...pinned[path] });
    }
  }

  // Where each checkout stood before any setup ran — what a tree goes back to when a setup
  // fails, never wherever a step moved HEAD to (a commit, a branch, a rebase stopped half-way).
  const starts = new Map<string, Awaited<ReturnType<typeof checkoutStart>>>();
  for (const { path, dir } of dirs) starts.set(path, await checkoutStart(git, dir));
  const startOf = (path: string) => starts.get(path)!;

  // Like a run: per repo, in order, each step in its own clone — and like a run, a repo whose
  // setup did not finish is a warning, its checkout put back to its start at once.
  const warnings: SetupWarning[] = [];
  /** The checkouts a put-back rewrote files in, whose times are pinned again after. */
  const restored = new Set<string>();
  for (const { path, dir } of dirs) {
    const declared = await discoverSetup(dir);
    if (declared.error !== null) {
      warn(opts.diag, path, { kind: "invalid", error: declared.error });
      warnings.push({ kind: "invalid", path, error: declared.error });
      continue;
    }
    const steps = declared.steps;
    opts.diag.debug("bake.repo", { path, steps: steps.length });
    let failed: SetupStepFailure | null;
    try {
      failed = await runSetup(steps, {
        cwd: dir,
        phase: opts.phase,
        signal,
        diag: opts.diag,
        onStep: (step, index) =>
          opts.diag.debug("bake.step", {
            path,
            step: `${index + 1}/${steps.length}`,
            label: stepLabel(step, index),
          }),
      });
    } catch (err) {
      throw new Error(`${path}: ${errorMessage(err)}`);
    }
    if (signal.aborted) throw new Error("cancelled: the bake was stopped before it finished");
    if (failed !== null) {
      let discarded: boolean;
      try {
        discarded = await putBack(git, dir, startOf(path), { failed: true });
      } catch (err) {
        throw new Error(
          `${path}: setup step "${failed.step}" failed (exit ${failed.code}), and ` +
            errorMessage(err),
        );
      }
      if (discarded) restored.add(path);
      warn(opts.diag, path, failed, discarded);
      warnings.push({ ...failed, path, discarded });
    }
  }

  // Once, after every repo — a later repo's setup can reach into an earlier clone. As in a run
  // (core/run.ts, where the reasoning is): when a step failed in ANOTHER repo, what is left in
  // this one cannot be told apart from the failed step's writes, so it is put back too and
  // warned about, naming both; otherwise it is this repo's own setup's, put back and warned
  // about too.
  const stepFailed = warnings.filter((w) => w.kind === "step").map((w) => w.path);
  // A repo whose own setup did not finish is never told it did: changes there are a later
  // repo's, put back without a `dirty` warning.
  const unfinished = new Set(
    warnings.filter((w) => w.kind === "step" || w.kind === "invalid").map((w) => w.path),
  );
  // Once any step failed, every repo goes back with the filter drivers it started with, as
  // above — a failed step may have written another repo's config too; with no failure, the
  // config setup left stays (`PutBackOptions` in helpers/checkout.ts).
  for (const { path, dir } of dirs) {
    const after = stepFailed.filter((p) => p !== path);
    if (after.length > 0) {
      let discarded: boolean;
      try {
        discarded = await putBack(git, dir, startOf(path), { failed: true });
      } catch (err) {
        throw new Error(`${path}: after setup failed in ${after.join(", ")}, ${errorMessage(err)}`);
      }
      if (discarded) restored.add(path);
      // A repo whose own step failed already has its warning (and its tree put back).
      if (!discarded || stepFailed.includes(path)) continue;
      const failure = { kind: "discarded" as const, after };
      warn(opts.diag, path, failure);
      warnings.push({ ...failure, path });
      continue;
    }
    // No step failed elsewhere: what is left is this checkout's own setup's (a rewritten
    // lockfile, codegen into a tracked file), put back and warned about as a run does — only a
    // tree that cannot be put back fails the build.
    const files = (await changedPaths(git, dir)).slice(0, MAX_DIRTY_FILES);
    let discarded: boolean;
    try {
      discarded = await putBack(git, dir, startOf(path), { failed: stepFailed.includes(path) });
    } catch (err) {
      throw new Error(`${path}: ${errorMessage(err)}`);
    }
    if (discarded) restored.add(path);
    if (!discarded || unfinished.has(path)) continue;
    const failure = { kind: "dirty" as const, files };
    warn(opts.diag, path, failure);
    warnings.push({ ...failure, path });
  }
  const order = repos;
  warnings.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));

  // A put-back rewrote files git tracks, at fractional times: pinned again, as before any step
  // ran, so the image's tracked files are whole seconds and git's index agrees with them.
  if (opts.phase === "image" && restored.size > 0) {
    const gitBounded = makeGitBounded(opts.diag);
    for (const { path, dir } of dirs) {
      if (!restored.has(path)) continue;
      try {
        const again = await pinTrackedMtimes(git, gitBounded, dir, signal);
        opts.diag.debug("bake.mtimes_repinned", { path, ...again });
      } catch (err) {
        throw new Error(`${path}: pinning restored files to whole seconds: ${errorMessage(err)}`);
      }
    }
  }

  // From the first checkout, so a version a repo pins (rust-toolchain.toml, .nvmrc) is the one
  // recorded — it is the one the run will get there.
  const toolchains = await recordToolchains(dirs[0]?.dir ?? opts.root, opts.diag);
  await mkdir(dirname(opts.toolchainsOut), { recursive: true });
  await writeFile(opts.toolchainsOut, JSON.stringify(toolchains, null, 2) + "\n");
  if (opts.warningsOut !== undefined) {
    await mkdir(dirname(opts.warningsOut), { recursive: true });
    await writeFile(opts.warningsOut, serializeWarnings(warnings) + "\n");
  }
  return { repos, toolchains, pinned, warnings };
}

/**
 * Says a setup warning in the build log, as one line naming the repo. Not a `ryph-bake:` line:
 * the builder reads the last of those as the reason a build FAILED (dockerfile.ts
 * `failureLine`), and this build has not.
 */
function warn(diag: Diagnostics, path: string, failure: SetupFailure, discarded = false): void {
  diag.warn("bake.setup_failed", { path, kind: failure.kind });
  if (failure.kind === "dirty") {
    console.error(`== setup warning: ${path}: ${dirtyNote(failure.files)}`);
    return;
  }
  if (failure.kind === "discarded") {
    console.error(
      `== setup warning: ${path}: changes left after setup failed in ${failure.after.join(", ")} ` +
        "were discarded; they could not be told apart from what the failed step did",
    );
    return;
  }
  const what = failure.kind === "invalid"
    ? `${failure.error.split("\n")[0]}; none of its steps ran`
    : `step ${failure.index} of ${failure.total} (${failure.step}) exited with code ` +
      `${failure.code}` + (discarded ? ", and its changes to the tree were discarded" : "");
  console.error(
    `== setup warning: ${path}: ${what}; the image was built without the rest of its setup`,
  );
}

/**
 * The warnings as the file carries them: one JSON line, at most `MAX_SETUP_WARNINGS_BYTES`, in
 * the shape the control plane reads. Every repo is named for as long as anything can be:
 * each output tail (cleaned line by line before `runSetup` kept it, so a cut here cannot split
 * a credential past the redactor) is cut to its end, then the tails share what is left of the budget evenly and
 * shrink together, then the errors and labels shorten to a first line, and only then do the last entries go — a warning without its output still says
 * which repo and which step, and the build log has the rest.
 */
export function serializeWarnings(warnings: readonly SetupWarning[]): string {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const keepEnd = (text: string, max: number) =>
    text.length <= max ? text : max === 0 ? "" : `…${text.slice(-max)}`;
  const firstLine = (text: string, max: number) => {
    const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    return line.length > max ? `${line.slice(0, max)}…` : line;
  };
  const render = (outMax: number, short: boolean, keep: number) => {
    const shaped = warnings.slice(0, keep).map((w): SetupWarning => {
      if (w.kind === "step") {
        return {
          ...w,
          step: short ? firstLine(w.step, SHORT_TEXT_MAX) || `step ${w.index}` : w.step,
          output: keepEnd(w.output, outMax),
        };
      }
      if (w.kind === "invalid") {
        return {
          ...w,
          error: short
            ? firstLine(w.error, SHORT_TEXT_MAX) || "setup.yml is invalid"
            : w.error.length > WARNING_OUTPUT_MAX
            ? `${w.error.slice(0, WARNING_OUTPUT_MAX)}…`
            : w.error,
        };
      }
      if (w.kind === "dirty") {
        // Squeezed, a file list names its first few: enough to say what to .gitignore.
        const files = short ? w.files.slice(0, 3) : w.files;
        return {
          ...w,
          files: files.map((f) => f.length > SHORT_TEXT_MAX ? `${f.slice(0, SHORT_TEXT_MAX)}…` : f),
        };
      }
      return w;
    });
    return JSON.stringify(shaped);
  };
  const fits = (text: string) => bytes(text) <= MAX_SETUP_WARNINGS_BYTES;
  const n = warnings.length;
  let text = render(WARNING_OUTPUT_MAX, false, n);
  if (fits(text)) return text;
  // The tails share what the entries without them leave, and shrink together until they fit
  // (a tail's JSON escaping can make it longer than its characters).
  const bare = bytes(render(0, false, n));
  const tails = warnings.filter((w) => w.kind === "step" && w.output !== "").length;
  if (tails > 0 && bare < MAX_SETUP_WARNINGS_BYTES) {
    let per = Math.min(WARNING_OUTPUT_MAX, Math.floor((MAX_SETUP_WARNINGS_BYTES - bare) / tails));
    while (per > 0) {
      text = render(per, false, n);
      if (fits(text)) return text;
      per = Math.floor(per * 0.75);
    }
  }
  text = render(0, false, n);
  if (fits(text)) return text;
  for (let keep = n; keep >= 0; keep--) {
    text = render(0, true, keep);
    if (fits(text)) return text;
  }
  return "[]";
}

/** What `pinTrackedMtimes` did to one checkout. */
export interface PinnedMtimes {
  /** Tracked regular files it looked at. */
  files: number;
  /** Of those, the ones whose time it set: those with a fraction of a second, or every one when
   * there is no GNU `stat` to tell. */
  moved: number;
  /** Files moved a second later to be their package's one newest file (`raiseCargoManifests`). */
  manifests: number;
}

/**
 * Drops the fraction of a second from the mtime (and atime) of every regular file git tracks in
 * `dir`, so what a build tool fingerprints at image build time is what it reads back from the
 * image at run time.
 *
 * Image layers keep whole-second mtimes, and cargo fingerprints a package by its newest file's
 * mtime to the nanosecond (`1791193785.912001772s (build.rs)`). Baked unpinned, every crate
 * with a build script rebuilt on every run, because the run read `1791193785.000000000s`.
 *
 * Rounded down, never set to the commit time. A cold tree would be fine either way, but on a
 * warm one (a warm build moves the baked checkout to a newer commit in place) the files that
 * commit changed were just written, after every output already in the tree. Setting them to
 * their commit time can put them behind those outputs, and a committer date older than the last
 * build is ordinary (a fast-forward of commits made earlier): cargo then sees nothing changed
 * and keeps the stale build. Rounding down moves each file back by under a second, so it stays
 * ahead of anything built before it was written. A file that is already whole seconds (one an
 * earlier image layer carried) keeps its value, and is not touched at all: the bake runs in its own
 * image layer, and setting a time on a file from a lower layer copies the whole file up into it.
 * `lstat`'s Date holds milliseconds only, so the nanoseconds come from GNU `stat`. Git's index
 * is no source: a git built without USE_NSEC never updates the nanoseconds it stored at checkout.
 * Without GNU `stat` (busybox, BSD), every file is set, as before.
 *
 * Listed by `git ls-files -z`, without `--recurse-submodules`: a submodule is a gitlink entry,
 * a directory here, and the builder does not check submodules out. Only regular files are set.
 * Symlinks are skipped, never followed (`utimes` would follow one, and the target is either a tracked
 * file pinned on its own or outside the tree). Directories are not set: cargo, make and ninja
 * compare file mtimes, and nothing in the bake reads a directory's. A tracked file missing from
 * the tree is skipped; the clean-tree check names it.
 *
 * Whole seconds make ties, and cargo breaks them by directory order. A build script that prints
 * no `rerun-if-changed` is rerun when its package's newest file changes, and cargo records that
 * file as its mtime AND its name (`1791207676.000000000s (build.rs)`). With every file of a small
 * package in one second, the name is whichever tied file cargo's walk met first, and that order
 * differs between the build's filesystem and the run's: the run read `(Cargo.toml)`, reran the
 * script and rebuilt the crate (rustdoc fingerprints the same way). So after rounding, a package
 * whose newest second is tied gets one file cargo always lists moved a second past the rest: its
 * `Cargo.toml`, or for a workspace's root its `Cargo.lock` (or a tied build script or
 * `src/lib.rs`/`src/main.rs`)
 * (`raiseCargoManifests`). A package nothing changed in is not touched again, and a warm build
 * reruns nothing for it.
 *
 * The index is refreshed after, so git's stat data matches the new times and nothing has to
 * re-hash the tree later. Contents are untouched, so the tree stays clean.
 */
export async function pinTrackedMtimes(
  git: Git,
  gitBounded: GitBounded,
  dir: string,
  signal?: AbortSignal,
): Promise<PinnedMtimes> {
  const listing = await gitBounded(dir, MAX_LS_FILES_BYTES, "ls-files", "-z");
  if (listing === null) throw new Error("git ls-files printed more than its bound");
  const names = listing.split("\0").filter((name) => name !== "");
  const whole = await wholeSecondFiles(dir, names, signal);
  let files = 0;
  let moved = 0;
  /** Each pinned file's whole-second mtime, by its path in the checkout. */
  const seconds = new Map<string, number>();
  for (const name of names) {
    // A repo of a million files takes a while: an aborted build stops here, not after the last.
    signal?.throwIfAborted();
    const path = `${dir}/${name}`;
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (err) {
      if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) continue;
      throw err;
    }
    if (!info.isFile()) continue;
    const ms = info.mtime.getTime();
    const at = Math.floor(ms / 1000);
    // A Date stops at the millisecond: whole only if `stat` saw no fraction either.
    if (ms % 1000 !== 0 || whole?.has(name) !== true) {
      await utimes(path, at, at);
      moved++;
    }
    seconds.set(name, at);
    files++;
  }
  const { raised: manifests, latest } = await raiseCargoManifests(dir, seconds, signal);
  // A raised file can be up to a second ahead of the clock. Anything built before the clock passes
  // it would look older than it, to a build script that names it in rerun-if-changed. Capped at
  // two seconds: a tree whose times are already far ahead (an earlier builder's skewed clock) is
  // not waited out.
  const ahead = Math.min(latest * 1000 - Date.now(), MAX_RAISE_WAIT_MS);
  if (ahead >= 0) await abortableDelay(ahead + 1, signal);
  try {
    await git(dir, "update-index", "-q", "--refresh");
  } catch {
    // Non-zero means a file really differs from the index; the clean-tree check owns that.
  }
  return { files, moved, manifests };
}

/**
 * The files among `names` whose mtime GNU `stat` shows with no fraction of a second, or null when
 * there is no GNU `stat` to ask (the caller then sets every file). `stat` does not follow symlinks.
 * The names reach it on stdin through `xargs -0`, never through a shell.
 */
export async function wholeSecondFiles(
  dir: string,
  names: string[],
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  if (names.length === 0) return new Set();
  let out: CommandOutput;
  try {
    const child = await command("xargs", {
      args: ["-0", "stat", "--printf=%n\\0%y\\0", "--"],
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
      signal,
    }).spawn();
    // Read while writing: `stat` blocks once its output fills the pipe, then xargs stops reading
    // its input, and a write of every name first would never return on a large repo.
    const output = child.output();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(names.join("\0") + "\0"));
    await writer.close();
    out = await output;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  // 123: some `stat` failed (a tracked file missing from the tree). What the others printed still
  // holds; a file not in it is set, or skipped by the caller when it is missing. A `stat` that is
  // not GNU's fails every call the same way and prints nothing at all.
  const fields = new TextDecoder().decode(out.stdout).split("\0");
  if (!out.success && (out.code !== 123 || fields.length < 3)) return null;
  const whole = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // `2026-10-06 12:34:56.000000000 +0000`: whole when every digit after the point is a zero.
    const fraction = /:\d\d\.(\d+)/.exec(fields[i + 1])?.[1];
    if (fraction === undefined) return null;
    if (/^0+$/.test(fraction)) whole.add(fields[i]);
  }
  return whole;
}

/**
 * Where a package's newest second is shared by more than one of its files, moves one file a
 * second past the rest, so the newest file is one file: a build script's fingerprint and rustdoc's
 * both name the package's newest file, by path. The file moved is one cargo always lists: the
 * package's `Cargo.toml`, unless that is also the workspace's manifest, which clippy names in
 * every crate's dep-info (moving it would rebuild them all); then its tracked `Cargo.lock`, else
 * whichever of its build script, `src/lib.rs` or `src/main.rs` is tied already, else nothing. A package with one newest file
 * already (the usual warm build: only what the commit changed is new) is left as it is. Returns
 * how many files it moved, and the latest time it set (or 0).
 *
 * A package's files are those under its directory and not under a deeper `Cargo.toml`'s, which is
 * what cargo lists for it: it does not walk into a nested package. `package.include`/`exclude` and
 * untracked files are not counted. A virtual manifest (a `[workspace]` with no `[package]`)
 * belongs to no package's listing and nothing is moved for it.
 */
async function raiseCargoManifests(
  dir: string,
  seconds: Map<string, number>,
  signal?: AbortSignal,
): Promise<{ raised: number; latest: number }> {
  const MANIFEST = "Cargo.toml";
  /** Each package's directory (`""`, `"crates/a/"`), by its manifest's path. */
  const packages = new Map<string, string>();
  for (const name of seconds.keys()) {
    if (name === MANIFEST || name.endsWith(`/${MANIFEST}`)) {
      packages.set(name.slice(0, -MANIFEST.length), name);
    }
  }
  /** Each package's newest second, and its files (its manifest too) that have it. */
  const newest = new Map<string, { at: number; names: string[] }>();
  for (const [name, at] of seconds) {
    // The deepest directory holding a manifest owns the file; a manifest owns itself.
    for (let end = name.lastIndexOf("/");; end = name.lastIndexOf("/", end - 1)) {
      const prefix = end === -1 ? "" : name.slice(0, end + 1);
      if (packages.has(prefix)) {
        const seen = newest.get(prefix);
        if (seen === undefined || at > seen.at) newest.set(prefix, { at, names: [name] });
        else if (at === seen.at) seen.names.push(name);
        break;
      }
      if (end === -1) break;
    }
  }
  let raised = 0;
  let latest = 0;
  for (const [prefix, manifest] of packages) {
    signal?.throwIfAborted();
    const top = newest.get(prefix)!;
    if (top.names.length === 1) continue;
    const shape = manifestShape(await readFile(`${dir}/${manifest}`, "utf8"));
    if (!shape.isPackage) continue;
    let moving: string | undefined = manifest;
    if (shape.isWorkspace) {
      const script = shape.build === false ? undefined : `${prefix}${shape.build ?? "build.rs"}`;
      // The lock is in no crate's dep-info, so moving it costs nothing. A source moved forward
      // would recompile the root and its dependents in this very bake, so one is taken only when
      // it is tied already, and moving it changes nothing a build reads.
      moving = seconds.has(`${prefix}Cargo.lock`)
        ? `${prefix}Cargo.lock`
        : [script, `${prefix}src/lib.rs`, `${prefix}src/main.rs`]
          .find((name) => name !== undefined && top.names.includes(name));
      if (moving === undefined) continue;
    }
    const at = top.at + 1;
    await utimes(`${dir}/${moving}`, at, at);
    seconds.set(moving, at);
    raised++;
    latest = Math.max(latest, at);
  }
  return { raised, latest };
}

/**
 * What a `Cargo.toml` declares, read table by table rather than parsed in full: whether it is a
 * package, whether it is a workspace's root, and its `package.build` (a path, `false`, or absent).
 * Keys count only in their own table, so a `build = "…"` under `[package.metadata.x]` is not
 * the build script.
 */
export function manifestShape(
  text: string,
): { isPackage: boolean; isWorkspace: boolean; build: string | false | undefined } {
  let table = "";
  let isPackage = false;
  let isWorkspace = false;
  let build: string | false | undefined;
  const name = (raw: string) =>
    raw.split(".").map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2")).join(".");
  for (const line of text.split("\n")) {
    const header = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = name(header[1]);
      if (table === "package" || table.startsWith("package.")) isPackage = true;
      if (table === "workspace" || table.startsWith("workspace.")) isWorkspace = true;
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_.\-"' ]+?)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!pair) continue;
    const key = [table, name(pair[1])].filter((part) => part !== "").join(".");
    if (key === "package" || key.startsWith("package.")) isPackage = true;
    if (key === "workspace" || key.startsWith("workspace.")) isWorkspace = true;
    if (key === "package.build") {
      const value = /^(?:"([^"]*)"|'([^']*)'|(true|false))$/.exec(pair[2]);
      if (value?.[3] === "false") build = false;
      else if (value?.[1] !== undefined || value?.[2] !== undefined) {
        build = (value[1] ?? value[2]).replace(/^\.\//, "");
      }
    }
  }
  return { isPackage, isWorkspace, build };
}

/**
 * The checkouts under `root`, in the order the builder wrote to `.order` — else sorted by name.
 * Every one must be an immediate child directory holding a `.git`: a listed path that is not a
 * checkout is the builder's bug, and refusing it beats baking half a workspace.
 */
export async function memberOrder(root: string): Promise<string[]> {
  let listed: string[] | null = null;
  try {
    listed = (await readFile(`${root}/${ORDER_FILE}`, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch (err) {
    if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
  }
  if (listed !== null) {
    for (const path of listed) {
      if (path.includes("/") || path === "." || path === "..") {
        throw new Error(`${ORDER_FILE}: "${path}" is not a directory name under ${root}`);
      }
      if (!await isCheckout(`${root}/${path}`)) {
        throw new Error(`${ORDER_FILE}: "${path}" is not a checkout under ${root}`);
      }
    }
    if (new Set(listed).size !== listed.length) {
      throw new Error(`${ORDER_FILE}: a repo is listed twice`);
    }
    return listed;
  }
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && await isCheckout(`${root}/${entry.name}`)) found.push(entry.name);
  }
  return found.sort();
}

/** Each toolchain's version, keyed by name; absent from the record when it is absent from PATH. */
export async function recordToolchains(
  cwd: string,
  diag: Diagnostics,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const { name, args } of TOOLCHAINS) {
    try {
      const { success, stdout } = await command(name, {
        args,
        cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        clearEnv: true,
        env: scrubbedEnv(),
      }).output();
      if (!success) continue;
      const line = new TextDecoder().decode(stdout).split("\n")[0].trim();
      if (line === "") continue;
      found[name] = versionOf(line);
    } catch (err) {
      if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) continue;
      diag.warn("bake.toolchain.failed", { name, err });
    }
  }
  return found;
}

/**
 * `go version go1.27.1 linux/amd64` → `1.27.1`; a line with no version-shaped token is kept,
 * as printable ASCII without quotes or backslashes. Either way at most `MAX_VERSION_LEN`: the
 * record is printed whole as a result line, which shares Cloud Build's 4 KiB of step output with
 * the digests and the setup warnings (`MAX_SETUP_WARNINGS_BYTES`), and a tool printing anything
 * at all as its version must not crowd those out.
 */
export function versionOf(line: string): string {
  const version = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ??
    line.replace(/[^\x20-\x7e]|["\\]/g, "").trim();
  return version.slice(0, MAX_VERSION_LEN);
}

const USAGE = `usage: ryph-bake --phase image <root> [--toolchains-out <path>]
                 [--setup-warnings-out <path>]
  <root>                      the directory holding one checkout per repo (/ryph/work)
  --phase image|run           exported to every step as the setup phase
  --toolchains-out <path>     where the toolchain versions are written
                              (default ${TOOLCHAINS_OUT})
  --setup-warnings-out <path> where the setup warnings are written
                              (default ${SETUP_WARNINGS_OUT})`;

export async function main(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: ["phase", "toolchains-out", "setup-warnings-out"],
    unknown: (arg) => arg.startsWith("-") ? usage(`unexpected flag: ${arg}`) : true,
  });
  const phase = flags.phase;
  if (phase !== "image" && phase !== "run") usage("--phase must be `image` or `run`");
  if (flags._.length !== 1) usage("exactly one root directory is required");
  const root = String(flags._[0]).replace(/\/+$/, "") || "/";

  // Every step's output rides the debug stream, so the build log is the step log.
  setupLoggerFromEnv({ level: LogLevel.DEBUG, stderr: true });
  const diag = loggerDiagnostics("bake");
  const cancel = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => cancel.abort());
  }
  try {
    const result = await bake({
      root,
      phase,
      toolchainsOut: flags["toolchains-out"] ?? TOOLCHAINS_OUT,
      warningsOut: flags["setup-warnings-out"] ?? SETUP_WARNINGS_OUT,
      diag,
      signal: cancel.signal,
    });
    for (const [path, { files, moved, manifests }] of Object.entries(result.pinned)) {
      console.error(
        `ryph-bake: ${path}: pinned ${files} tracked file(s) to whole-second mtimes ` +
          `(${moved} set; ${manifests} moved a second later to break a cargo package's tie)`,
      );
    }
    console.error(
      `ryph-bake: baked ${result.repos.length} repo(s) (${result.repos.join(", ") || "none"})` +
        (result.warnings.length > 0
          ? `, ${result.warnings.length} with a setup warning (see above)`
          : "") +
        "; " +
        `toolchains: ${
          Object.entries(result.toolchains).map(([k, v]) => `${k} ${v}`).join(", ") || "none"
        }`,
    );
  } catch (err) {
    console.error(`ryph-bake: ${errorMessage(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

function usage(message: string): never {
  console.error(`ryph-bake: ${message}\n${USAGE}`);
  process.exit(2);
}

if (import.meta.main) {
  const hostile = hostileEnvironment(process.env, { fromImage: true });
  if (hostile !== null) {
    console.error(`ryph-bake: refusing to start: ${hostile.message}`);
    process.exit(2);
  }
  await main(process.argv.slice(2));
}
