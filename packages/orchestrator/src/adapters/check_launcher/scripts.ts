// The platform-authored entrypoints a check suite's containers run, the same on every backend.
// Pure, and exported for the test, which runs them under a real bash against real temp-dir git
// repositories.
//
// The shell is in sh/, one file per entrypoint and one per shared part, each saying what it does.
// An entrypoint is the constants header (`constants`), sh/lib.sh, then its own parts; the header
// is the only shell written here, and holds the constants below and nothing of a suite's.
//
// A check runs in one of two trees, and the launcher picks the scripts by which:
// - BAKED: the suite's image is an environment image holding this repo's warm checkout under
//   BAKED_ROOT (the spec's `bakedCheckout`). Every check container moves that checkout to the head
//   in place and runs the setup steps there (`bakedCheckScript`). There are no setup containers
//   and no per-check volumes: each container's own copy-on-write view of the image is its tree
// - COPIED: the image holds no checkout of this repo (the default image, or an environment it is
//   not a member of). The setup steps run once, in the pristine tree (`setupScript`), and every
//   check copies the result to a volume of its own (`checkScript`)
// Two paths rather than one because each is the cheap one for its case. Setup in every check
// container would make a cold tree pay a cold install N times over; one setup copied N times would
// make a warm tree copy every build output it has, and on a large one (a Rust `target/`) the
// copies alone outgrow the pod's disk. The clone is the same in both, and so is how a check runs
// once its tree is ready (sh/run-check.sh).
//
// What a script may and may not do with what it is handed:
// - every value arrives as an ENV VAR (`CHECK_ENV`), never in the script text or in argv. A
//   `run` string is head-adjacent text — the base authored it, but it may say anything — and the
//   only place it is ever expanded is as the single argument of `sh -c "$RYPH_CHECK_RUN"` (a setup
//   step's likewise), which is exactly the contract `checks.yml` states. Nothing here builds a
//   script out of a value
// - the scripts are bash (one of the three things the harness layer requires of any base, with
//   glibc and git); the commands they hand on run under `sh -c`, as the declaration says. Beyond
//   bash and git they use only the basic tools any such image carries, from coreutils or busybox
//   alike: `env`, `ls`, `mkdir`, `mkfifo`, `cp`, `mv`, `rm`, `chmod`,
//   `sleep`, `head`, `wc`, `tr`, `sed` (and `date`, only where bash is too old for
//   `printf '%(%s)T'`). Nothing needs `mktemp` or `timeout`: what a stage keeps for itself goes to
//   a fixed path beside the tree it works in, and the pool watcher's directory to a name it makes
//   itself
// - `exec 2>&1` first, in every script: one stream, in the order it was written. Docker's CLI
//   hands the two streams back separately, and a log with its stderr moved to the end of it is
//   one nobody can read a failure from
// - 125 is the platform's (`CHECK_PLATFORM_EXIT`: the tree copy or the move of the baked checkout,
//   a service that never answered, a stage started a second time), so a setup step or a check
//   that exits 125 by itself is reported as 1. A check's 124 is the timeout's (sh/run-check.sh), so a
//   check that exits 124 by itself is reported as 1 too, and so is a setup step's 124 when it runs
//   inside a check container. A setup container's step has no timeout of its own, and its 124
//   passes through. A check's 122 (CHECK_POOL_EXIT) is the pool watcher's (sh/pool.sh): stopped
//   because the suite ran short of memory while it was the check furthest over its share. A check
//   or a setup step in a check container that exits 122 by itself is reported as 1 as well
// - every stage makes its mark first and refuses a second start (docker's poll can race; see
//   docker.ts): one stage, one run, one exit code
//
// The tree lives one directory BELOW each volume (`/pristine/repo`, `/work/repo`), never at a
// volume's root. A volume's root belongs to whoever the backend says — root, on an emptyDir — and
// git refuses to work in a repository whose top-level directory another uid owns ("dubious
// ownership"), which would break every check that so much as runs `git diff`. A directory the run
// user creates is the run user's, on every backend. A baked checkout is the run user's already:
// the environment build bakes it as that user.
//
// The suite's memory is ONE POOL, the size class's (or the docker cap's), split into a SHARE per
// check. Under gVisor (GKE) a container's own limit is not enforced: each check's limit is its
// share, their sum is the pod's cap, and only that total is held. A check may borrow above its
// share while the pool has room, and a pod over its total is killed whole, every check OOMKilled at
// once with nothing to say whose fault it was. So ryph polices the pool itself: when the pool runs
// short the check furthest over its share is stopped and fails with 122, its log saying what it
// used. A check within its share is never stopped for the pool. There is no process that sees every
// container (no shared pid namespace, no daemon), so each check's watcher publishes its own use in
// a directory of its own, `<pool>/<name>`, which only its container mounts read-write and every
// other check mounts read-only, and reads everyone else's (sh/pool.sh): the one that finds itself
// the victim stops itself. On docker each check is limited to its share by the kernel, so a check
// over it is killed alone before its watcher could find it furthest over; the watcher runs there
// all the same, harmless, and never fires.
//
// The watcher is cooperative, not a boundary: the head runs as the same user in the same
// container, and can always kill or confuse its own watcher. What it may never do is make a
// SIBLING within its share fail: each watcher judges itself on its own numbers, and no check can
// write anywhere another check's watcher writes. A check can only lie in its own file: claiming
// much makes it the furthest over itself, and claiming its share takes no more than it was
// entitled to; at most it leaves less for the others to borrow. The bound on a suite is the
// backend's: the pod's sum of share limits under gVisor, each container's share on docker. Not
// held by the pool either: the
// services' sidecars, vendor images that cannot run a watcher, which under gVisor may grow past
// their own limits into the checks' room; and a spike faster than the watcher's tick (about a
// second), which can still take a gVisor pod past its total and every check with it.

import { CHECK_PLATFORM_EXIT } from "../../core/checks.ts";
import { CHECK_POOL_EXIT } from "../../core/check_types.ts";
import { CHANGED_PATHS_MARKER } from "../../helpers/checks.ts";
import { shellBody, shellConstants } from "../../helpers/shell.ts";
import LIB_SH from "./sh/lib.sh" with { type: "text" };
import POOL_SH from "./sh/pool.sh" with { type: "text" };
import RUN_CHECK_SH from "./sh/run-check.sh" with { type: "text" };
import CLONE_SH from "./sh/clone.sh" with { type: "text" };
import SETUP_SH from "./sh/setup.sh" with { type: "text" };
import CHECK_SH from "./sh/check.sh" with { type: "text" };
import BAKED_CHECK_SH from "./sh/baked-check.sh" with { type: "text" };

/** Where the clone lands, shared read-write by clone and setup and read-only by the checks. */
export const PRISTINE = "/pristine";
/** Each check's private volume. */
export const WORK = "/work";
/** The tree inside each: see the header on why it is not the volume's root. */
export const PRISTINE_TREE = `${PRISTINE}/repo`;
export const WORK_TREE = `${WORK}/repo`;
/** Where an environment image bakes its checkouts, one directory per member path: the runner's
 * layout, so a check moves the same checkout a run does. */
export const BAKED_ROOT = "/ryph/work";

/** Where the memory pool's directories are mounted, one per check (sh/pool.sh): `<POOL>/<name>`,
 * read-write in that check's own container and read-only in every other check's. */
export const POOL = "/pool";
/** Where a container reads its own memory use: cgroup v2's `memory.current`, or v1's
 * `memory/memory.usage_in_bytes` (gVisor shows the v1 layout). */
export const CGROUP = "/sys/fs/cgroup";

/** Where the pool watcher makes its own directory in each check container: its stop mark, the id
 * of the group it would stop and its reader's FIFO (sh/pool.sh says why there). */
export const POOL_CONTROL = "/tmp";

/** Where a script finds the two volumes, its cgroup and the watcher's own directory. Always the
 * constants in a container; the test moves them under a temp dir, since a machine running the
 * test has no `/pristine`. */
export interface ScriptDirs {
  pristine: string;
  work: string;
  cgroup: string;
  control: string;
}
const VOLUMES: ScriptDirs = {
  pristine: PRISTINE,
  work: WORK,
  cgroup: CGROUP,
  control: POOL_CONTROL,
};

/** The env vars the scripts read. The only way a value reaches a check container. */
export const CHECK_ENV = {
  /** The gateway member URL (clone). */
  url: "RYPH_CHECK_URL",
  /** The head sha the clone must end up on (clone), and a baked check moves to (baked check). */
  head: "RYPH_CHECK_HEAD",
  /** `checksCommit`: the changed-paths list starts at its merge base with the head (clone). */
  base: "RYPH_CHECK_BASE",
  /** One setup step's `run` (setup). */
  step: "RYPH_CHECK_STEP",
  /** One setup step's index, which names its mark in the pristine volume (setup). */
  stepIndex: "RYPH_CHECK_STEP_INDEX",
  /** One check's `run` (check). */
  run: "RYPH_CHECK_RUN",
  /** One check's timeout, whole seconds (check). */
  timeout: "RYPH_CHECK_TIMEOUT",
  /** `name:port` of every service, space-separated; waited on before the check starts (check). */
  services: "RYPH_CHECK_SERVICES",
  /** The baked checkout's absolute path, under BAKED_ROOT (baked check). */
  baked: "RYPH_CHECK_BAKED",
  /** How many setup steps a baked check runs (baked check). */
  setupCount: "RYPH_CHECK_SETUP_COUNT",
  /** Prefix of each setup step's `run`, by index: `RYPH_CHECK_SETUP_0`… (baked check). */
  setupStep: "RYPH_CHECK_SETUP_",
  /** How many keep patterns a baked check's clean spares (baked check). */
  keepCount: "RYPH_CHECK_KEEP_COUNT",
  /** Prefix of each keep pattern, by index: `RYPH_CHECK_KEEP_0`… (baked check). */
  keep: "RYPH_CHECK_KEEP_",
  /** The check's name: its own directory of the pool (check). */
  name: "RYPH_CHECK_NAME",
  /** Where the pool's directories are mounted, POOL in a container (check). */
  pool: "RYPH_CHECK_POOL",
  /** Every check of the suite, space-separated: the only directories of the pool read (check). */
  names: "RYPH_CHECK_NAMES",
  /** The pool's size in bytes: the suite's memory. Unset, nothing is watched (check). */
  poolBytes: "RYPH_CHECK_POOL_BYTES",
  /** This check's share of the pool in bytes: what it may always use (check). */
  shareBytes: "RYPH_CHECK_SHARE_BYTES",
} as const;

/**
 * The lockfiles a baked check names when the head changes one since the image's commit: the image
 * installed and built the old dependencies, so what changed is installed and built in each check,
 * by its setup or its build tool (cargo fetches by itself; npm and uv need setup's install).
 * Said in the log, so a slow check on a dependency bump reads as that rather than as a broken
 * image. Lockfiles rather than manifests, since a manifest changes for much else; pip's
 * requirements files count, as the nearest thing pip has to one.
 */
export const LOCKFILES = [
  "Cargo.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "uv.lock",
  "poetry.lock",
  "pdm.lock",
  "Pipfile.lock",
  "requirements*.txt",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
  "gradle.lockfile",
] as const;

/** LOCKFILES as an extended regex over a repo-relative path, for `sed -E`. */
const LOCKFILE_PATTERN = `(^|/)(${
  LOCKFILES.map((name) => name.replaceAll(".", "\\.").replaceAll("*", "[^/]*")).join("|")
})$`;

/** How many changed paths the clone prints before it says the list was cut. */
export const MAX_CHANGED_PATHS = 5000;

/** How long a check waits for its services to accept a connection before it fails. */
export const SERVICE_WAIT_SECONDS = 180;

/** Between the timeout's TERM and its KILL: long enough for a test runner to print its summary. */
export const KILL_AFTER_SECONDS = 30;

/** How often a check's pool watcher measures, publishes and judges. */
export const POOL_TICK_SECONDS = 1;
/** How old a check's pool file may be and still count: a container that died cannot remove its
 * own, and a watcher alive publishes every tick. */
export const POOL_STALE_SECONDS = 10;
/** How full the pool is, in percent, when it counts as running short: room left for the tick it
 * takes to see it and the seconds a stop takes, before the backend's own kill at 100. */
export const POOL_SHORT_PERCENT = 90;
/** Between the pool's TERM and its KILL: a memory emergency, not the timeout's courtesy. */
export const POOL_KILL_AFTER_SECONDS = 3;

/**
 * The constants header every script starts with (helpers/shell.ts): the volumes' paths, the exit
 * codes and the limits above, as readonly shell variables. Platform constants only, the same for
 * every suite; the test moves the directories under a temp dir.
 */
function constants(dirs: ScriptDirs): string {
  return shellConstants({
    RYPH_PRISTINE: dirs.pristine,
    RYPH_WORK: dirs.work,
    RYPH_CGROUP: dirs.cgroup,
    RYPH_POOL_CONTROL: dirs.control,
    RYPH_PLATFORM_EXIT: CHECK_PLATFORM_EXIT,
    RYPH_POOL_EXIT: CHECK_POOL_EXIT,
    // The clone's changed-paths lines, as `changedPathsFromLog` reads them.
    RYPH_CHANGED: CHANGED_PATHS_MARKER,
    RYPH_MAX_CHANGED_PATHS: MAX_CHANGED_PATHS,
    RYPH_LOCKFILES: LOCKFILE_PATTERN,
    RYPH_SERVICE_WAIT_SECONDS: SERVICE_WAIT_SECONDS,
    RYPH_KILL_AFTER_SECONDS: KILL_AFTER_SECONDS,
    RYPH_POOL_TICK_SECONDS: POOL_TICK_SECONDS,
    RYPH_POOL_STALE_SECONDS: POOL_STALE_SECONDS,
    RYPH_POOL_SHORT_PERCENT: POOL_SHORT_PERCENT,
    RYPH_POOL_KILL_AFTER_SECONDS: POOL_KILL_AFTER_SECONDS,
  });
}

/** One entrypoint: the header, the shared functions, then `parts` (definitions, then the body),
 * each without its comments (helpers/shell.ts `shellBody`). */
function script(dirs: ScriptDirs, ...parts: string[]): string {
  return [constants(dirs), ...[LIB_SH, ...parts].map(shellBody)].join("\n");
}

/** The `clone` init container (sh/clone.sh): the head checked out and proven, the changed paths
 * listed. The only stage that holds the git credential. */
export function cloneScript(dirs: ScriptDirs = VOLUMES): string {
  return script(dirs, CLONE_SH);
}

/** One `setup-<i>` init container (sh/setup.sh): one step, in the pristine tree. */
export function setupScript(dirs: ScriptDirs = VOLUMES): string {
  return script(dirs, SETUP_SH);
}

/** One `check-<name>` container when the image baked no checkout of this repo (sh/check.sh):
 * the pristine tree copied to its own, then the check (sh/run-check.sh). */
export function checkScript(dirs: ScriptDirs = VOLUMES): string {
  return script(dirs, POOL_SH, RUN_CHECK_SH, CHECK_SH);
}

/** One `check-<name>` container when the image baked a checkout of this repo
 * (sh/baked-check.sh): that checkout moved to the head in place, setup run in it, then the
 * check (sh/run-check.sh). */
export function bakedCheckScript(dirs: ScriptDirs = VOLUMES): string {
  return script(dirs, POOL_SH, RUN_CHECK_SH, BAKED_CHECK_SH);
}

/** The pool watcher alone (sh/pool.sh), started: what every check container runs right after its
 * mark. For the test, which drives the watcher's functions around a body of its own. */
export function poolWatch(dirs: ScriptDirs = VOLUMES): string {
  return [constants(dirs), shellBody(POOL_SH), "pool_start"].join("\n");
}
