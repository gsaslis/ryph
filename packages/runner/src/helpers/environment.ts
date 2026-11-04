import { lstat, readdir, readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { runtimeCredentials } from "./runtime_credentials.ts";
import { command } from "@ryph/process";

// Repo-configured environment setup.
// A cloned checkout may carry a config dir declaring
// how to stand up the run's working environment: `setup.yml` — a CI-like sequence of shell
// steps, run in order in the checkout root — and `environment.md` — the repo's own
// description of that environment, handed to the harness so the agent knows what was
// prepared for it.
//
// Invariants:
// - the runner never gets a host-control channel of any kind: steps are ordinary child
//   processes in the checkout, nothing more — whatever they start dies with the run's
//   container, so there is no teardown
// - brand-scoped env vars (the runner's own credentials) never reach a step:
//   the child env is the ambient env plus the runner's private configuration, scrubbed of every
//   `${ENV_PREFIX}_*` key — the one
//   brand-scoped name a step does see, `${ENV_PREFIX}_SETUP_PHASE`, is set after the scrub and
//   carries no secret
// - a failing step is a RESULT, not an error: the first non-zero exit stops that repo's
//   sequence (later steps usually depend on earlier ones, as in CI) and `runSetup` returns the
//   failure — the step's label, exit code, output tail and how many steps it skipped. A run and
//   an image build (ryph-bake) both warn and go on: setup is an optimization, and an agent can
//   finish setting up an environment itself
// - a setup.yml that does not parse, or does not match the shape, is a warning too, never an
//   error: `discoverEnvironment` and `discoverSetup` return the validation error beside zero
//   steps. Only setup.yml's: a broken services.yml or environment.md still throws
// - what a failing step printed is cleaned before anyone is handed it (`cleanSetupOutput`): no
//   terminal escapes or control characters, and no credentials in URLs — a step runs with the
//   egress claim in HTTPS_PROXY's userinfo, and a verbose tool can print it
// - an abort kills the in-flight step and skips the rest; `runSetup` then returns
//   normally — cancellation is the caller's outcome to build, never this module's error
// - each step is its own process group, and a step that FAILS has its whole group ended (TERM,
//   then KILL) before its failure is returned: what it started in the background (a watcher, a
//   codegen loop) must not write into the tree after the caller puts it back. A step that
//   succeeds keeps what it started — setup may start a daemon the run uses

import { parse as parseYaml } from "@std/yaml";
import { TextLineStream } from "@std/streams/text-line-stream";
import { ENV_PREFIX, REPO_CONFIG_DIR } from "../core/brand.ts";
import { readBounded } from "./read_bounded.ts";
import { errorMessage } from "./errors.ts";
import { redact } from "./git_exec.ts";

/** Ceiling for one repo's environment.md, in bytes: it is prose the agent reads on every
 * turn, and a description that long is a document, not a description. */
export const MAX_ENVIRONMENT_BYTES = 32_768;
/** Ceiling for environment.md across the checkout. Each repo is bounded on its own above; the
 * sum is bounded here, because the sum is what lands in the prompt. */
export const MAX_ENVIRONMENT_TOTAL_BYTES = 65_536;
/**
 * Ceiling for services.yml, in bytes — the forge's cap on the control-plane read of the same
 * file (`MAX_SERVICES_FILE_BYTES`, @ryph/forge's http/service.ts), repeated here because this
 * read happens whether or not the control plane ever took one: with `RYPH_SERVICES` off the
 * file is never read there, and an unbounded parse of it here is a repo's own runs killed by
 * its own tree.
 */
const MAX_SERVICES_BYTES = 65_536;
/**
 * An anchor or alias in node position. A duplicate of the control plane's screen —
 * `ANCHOR_OR_ALIAS` in @ryph/orchestrator's helpers/services.ts, which is the source of truth
 * and carries the reasoning — because the runner ships in the agent image and imports no
 * service package. One regex, copied on purpose; if that one changes, change this one.
 *
 * Here for the same reason it is there: `*a` referenced ten times, ten times over, is the
 * billion-laughs expansion, and `@std/yaml` will happily build it. This read is deliberately
 * lenient about SHAPE (see readDeclaredServices) — it is not lenient about being made to
 * allocate until the run's container dies.
 */
const ANCHOR_OR_ALIAS =
  /(?:^|[:,[{]|[-?]\s)\s*(?:(?:!<[^>]*>|![^\s,[\]{}]*)\s+)?([&*][^\s,[\]{}]+)/m;
/** Ceilings for setup.yml — generous for any real setup, small enough to bound a hostile one. */
export const MAX_SETUP_BYTES = 1_048_576;
export const MAX_STEPS = 100;
export const MAX_RUN_LEN = 10_000;
export const MAX_NAME_LEN = 200;
/** Bounds the validation error an invalid setup.yml is reported with. */
export const MAX_SETUP_ERROR = 2_000;
/** Bounds a key the validation error quotes. */
const MAX_KEY_QUOTED = 100;
/** Bounds the captured output tail a failing step's result carries. */
const OUTPUT_TAIL_MAX = 2_000;
/** Bounds one streamed output line in the trace. */
const LINE_CLIP = 2_000;
/** Bounds a step's label in narration and error messages. */
const LABEL_CLIP = 80;

/** One setup.yml step. */
export interface SetupStep {
  /** Optional label for narration; the command stands in when absent. */
  name?: string;
  /** The shell command, run via `bash -c` in the checkout root. */
  run: string;
}

/** A service as the checkout declares it: its name, and its port when that is a number. */
export interface DeclaredService {
  name: string;
  port: number | null;
}

/** What the repo's config dir declared for this run. */
export interface RepoEnvironment {
  /** setup.yml's steps in declared order; empty when the repo declares none, or when the file
   * is invalid (then `setupError` says why). */
  setup: SetupStep[];
  /** Why setup.yml could not be used (`setup.yml: not valid YAML: …`), or null. A warning, not
   * a refusal: the run goes on without the repo's setup. */
  setupError: string | null;
  /** environment.md, trimmed; null when absent or blank. */
  environment: string | null;
  /**
   * The services `services.yml` declares, by name and port — not what they resolve to.
   * Resolving is the control plane's job and happens before this container exists (a Pod's
   * containers are fixed at creation); all the runner needs is where the checkout expects
   * them, so it can refuse a run whose checkout asks for services the spec did not bring, or
   * on a port they were not started on. That happens for real reasons: the operator has the
   * feature off, or the declaration lives on another ref. Every one of them ends in a suite
   * that hangs, so every one is worth refusing.
   *
   * Names and not a boolean, because "the file exists" is the wrong question: an empty or
   * comments-only `services.yml` is a placeholder a repo may legitimately commit, and the
   * control plane reads it as declaring nothing. Keying the refusal off the file's existence
   * made that placeholder fail every run, blaming an operator switch that was not the cause.
   */
  declaredServices: DeclaredService[];
}

/**
 * Reads the checkout's environment config, if any.
 * An absent config dir or file is a normal empty result. An invalid setup.yml is a warning
 * (`setupError`, zero steps); an invalid services.yml or environment.md throws, naming it — a
 * repo's broken config fails the run loudly, except the one file that is only an optimization.
 */
export async function discoverEnvironment(wsDir: string): Promise<RepoEnvironment> {
  const dir = `${wsDir}/${REPO_CONFIG_DIR}`;
  // The config dir itself is read only as a real directory of the clone: a committed symlink
  // there would lead every read below out of the checkout, whatever each file's own lstat says.
  if (!await isRealDirectory(dir)) {
    return { setup: [], setupError: null, environment: null, declaredServices: [] };
  }
  const { steps, error } = await readSetupOrError(dir);
  return {
    setup: steps,
    setupError: error,
    environment: await readEnvironment(dir),
    declaredServices: await readDeclaredServices(dir),
  };
}

/** setup.yml as a run or a build reads it: its steps, or why it could not be used. */
export interface SetupDeclaration {
  steps: SetupStep[];
  /** The validation error, naming the file; null when the file is valid or absent. */
  error: string | null;
}

/**
 * The checkout's setup.yml steps alone — what an image build reads (ryph-bake). services.yml and
 * environment.md are left unread: they are not part of a build's key (the forge's `.ryph` tree
 * id leaves them out), so a build must not succeed or fail on them.
 */
export async function discoverSetup(wsDir: string): Promise<SetupDeclaration> {
  const dir = `${wsDir}/${REPO_CONFIG_DIR}`;
  if (!await isRealDirectory(dir)) return { steps: [], error: null };
  return await readSetupOrError(dir);
}

async function readSetupOrError(dir: string): Promise<SetupDeclaration> {
  try {
    return { steps: await readSetup(dir), error: null };
  } catch (err) {
    // The parser quotes the file back: repo-authored, so cleaned like a step's output — and
    // bounded, since a YAML error quotes the offending line, which may be most of the file. The
    // control plane refuses a report whose error is past its own bound, and would then hold no
    // warning for any repo of the run. Cleaned BEFORE it is cut, so a cut cannot split a
    // credential past the redactor.
    const error = cleanSetupOutput(errorMessage(err));
    return {
      steps: [],
      error: error.length > MAX_SETUP_ERROR ? `${error.slice(0, MAX_SETUP_ERROR)}…` : error,
    };
  }
}

/**
 * The names under `services:` and the port each asks for, and nothing more.
 *
 * A second, deliberately lenient read of a file the control plane has already parsed strictly
 * — and the leniency is the point. The runner is not deciding what runs; it is answering "did
 * this repo ask for something it did not get". It cannot reach the catalogue, and duplicating
 * the strict parser here would put two validators on one file, free to disagree.
 *
 * Both spellings, `.yml` winning when both exist — the order the forge reads them in, and the
 * order readSetup uses — so the file checked here is the file the control plane resolved.
 */
async function readDeclaredServices(dir: string): Promise<DeclaredService[]> {
  for (const name of ["services.yml", "services.yaml"]) {
    // Bounded and screened BEFORE the parser sees it, in that order — both are cheap, and both
    // are about the bytes rather than the shape. The control plane does the same, when it reads
    // the file at all; the case that reaches here is the one where it did not.
    const text = await readIfExists(`${dir}/${name}`, MAX_SERVICES_BYTES);
    if (text === null) continue;
    const anchor = text.match(ANCHOR_OR_ALIAS);
    if (anchor !== null) {
      throw new Error(
        `${name}: anchors and aliases are not allowed here (found \`${anchor[1]}\`) — ` +
          `write the values out`,
      );
    }
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (err) {
      // A broken services.yml fails the run loudly (unlike setup.yml, which only warns: a run
      // without its services would hang). The control plane would have refused the task
      // first — unless it never read the file, which is the case that reaches here.
      throw new Error(`${name}: not valid YAML: ${errorMessage(err)}`);
    }
    if (!isMapping(doc)) return [];
    const services = doc.services;
    if (!isMapping(services)) return [];
    // A port that is not a number is the strict parser's to refuse, not this read's to guess at.
    // A `checks_only: true` service is started only for the checks that name it, so a run never
    // gets one and must not count it as missing: on a deployment that runs no service
    // containers, that would fail every run of a repo whose only service is a test database.
    const entries = Object.entries(services);
    for (const [service, body] of entries) {
      // Where the control plane never read the file, this is the only reader: a value the strict
      // parser would refuse must not fall through to a run waiting on a service it never gets.
      if (isMapping(body) && "checks_only" in body && typeof body.checks_only !== "boolean") {
        throw new Error(
          `${name}: services.${service}.checks_only: must be true or false — true starts it only for the checks that name it, never beside a run`,
        );
      }
    }
    return entries
      .filter(([, body]) => !(isMapping(body) && body.checks_only === true))
      .map(([name, body]) => ({
        name,
        port: isMapping(body) && typeof body.port === "number" ? body.port : null,
      }));
  }
  return [];
}

async function readSetup(dir: string): Promise<SetupStep[]> {
  // both spellings are accepted; .yml wins when both exist
  for (const name of ["setup.yml", "setup.yaml"]) {
    const text = await readIfExists(`${dir}/${name}`, MAX_SETUP_BYTES);
    if (text === null) continue;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (err) {
      throw new Error(`${name}: not valid YAML: ${errorMessage(err)}`);
    }
    // an empty or comments-only file parses to nothing — a placeholder, not a broken config
    if (doc === null || doc === undefined) return [];
    try {
      return parseSteps(doc);
    } catch (err) {
      throw new Error(`${name}: ${errorMessage(err)}`);
    }
  }
  return [];
}

// Validates the parsed setup.yml shape: { steps: [{ name?, run }] }.
// Strict on purpose — an unknown key in a CI-like config is a typo, and skipping it
// silently would half-run the author's intent.
function parseSteps(doc: unknown): SetupStep[] {
  if (!isMapping(doc)) throw new Error("top level must be a mapping with a `steps` list");
  for (const key of Object.keys(doc)) {
    if (key !== "steps") throw new Error(`unknown key \`${clipKey(key)}\``);
  }
  const steps = doc.steps;
  if (!Array.isArray(steps)) throw new Error("`steps` must be a list");
  if (steps.length > MAX_STEPS) {
    throw new Error(`steps: ${steps.length} entries exceeds the limit of ${MAX_STEPS}`);
  }
  return steps.map((raw, i) => {
    const at = `steps[${i}]`;
    if (!isMapping(raw)) throw new Error(`${at}: must be a mapping with a \`run\` key`);
    for (const key of Object.keys(raw)) {
      if (key !== "name" && key !== "run") {
        throw new Error(`${at}: unknown key \`${clipKey(key)}\``);
      }
    }
    const { name, run } = raw;
    if (typeof run !== "string" || run.trim() === "") {
      throw new Error(`${at}.run: must be a non-empty string`);
    }
    if (run.length > MAX_RUN_LEN) {
      throw new Error(`${at}.run: exceeds ${MAX_RUN_LEN} chars`);
    }
    if (name === undefined) return { run };
    if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_LEN) {
      throw new Error(`${at}.name: must be a non-empty string of at most ${MAX_NAME_LEN} chars`);
    }
    return { name, run };
  });
}

/** A key as an error quotes it: a YAML key can be as long as the file, and the error travels
 * (the run's history, the build's warnings file, the agent's prompt). */
function clipKey(key: string): string {
  return key.length > MAX_KEY_QUOTED ? `${key.slice(0, MAX_KEY_QUOTED)}…` : key;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readEnvironment(dir: string): Promise<string | null> {
  const text = await readIfExists(`${dir}/environment.md`, MAX_ENVIRONMENT_BYTES);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Refuses a checkout whose environment.md files together exceed the total cap. Called once
 * over every repo's discovery, so the error can name each contributor.
 */
export function assertEnvironmentTotal(
  perRepo: ReadonlyArray<{ path: string; environment: string | null }>,
): void {
  const sized = perRepo
    .filter((r) => r.environment !== null)
    .map((r) => ({ path: r.path, bytes: new TextEncoder().encode(r.environment!).length }));
  const total = sized.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= MAX_ENVIRONMENT_TOTAL_BYTES) return;
  const shares = sized.map((r) => `${r.path}: ${r.bytes}`).join(", ");
  throw new Error(
    `environment.md across the checkout: ${total} bytes exceeds the ` +
      `${MAX_ENVIRONMENT_TOTAL_BYTES}-byte total limit (${shares})`,
  );
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) return false;
    throw err;
  }
}

/** A config file's text, or null when nothing regular is at `path` — a symlink is not
 * followed (helpers/read_bounded.ts). Refuses, naming the file, when it is over `maxBytes`;
 * nothing past the cap is ever read. */
async function readIfExists(path: string, maxBytes: number): Promise<string | null> {
  const bytes = await readBounded(path, maxBytes + 1);
  if (bytes === null) return null;
  if (bytes.length > maxBytes) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    throw new Error(`${name}: exceeds the ${maxBytes}-byte limit`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The slice of the `Diagnostics` port this helper needs,
 * declared locally so helpers stay inside the dependency fence (helpers never reach ports).
 * Structural: any real `Diagnostics` satisfies it.
 */
export interface SetupTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
}

/**
 * When a repo's steps are running: `image` while an environment build bakes them into an image
 * (ryph-bake), `run` when a run executes them in its own container. A repo whose environment has
 * a baked image sees both — the build ran them, and the run runs them again because the lockfile
 * may have moved since — so steps must be cheap when nothing changed, and this is the escape
 * hatch for the rare step that must differ between the two.
 */
export type SetupPhase = "image" | "run";

/** The variable every step reads its phase from. */
export const SETUP_PHASE_ENV = `${ENV_PREFIX}_SETUP_PHASE`;

export interface RunSetupOpts {
  /** The checkout root every step runs in. */
  cwd: string;
  /** Which phase this is — exported to every step as `${ENV_PREFIX}_SETUP_PHASE`. */
  phase: SetupPhase;
  /** Aborting kills the in-flight step and skips the rest; `runSetup` then returns normally. */
  signal: AbortSignal;
  diag: SetupTracer;
  /** Called as each step starts; drives narration. */
  onStep?: (step: SetupStep, index: number) => void;
  /**
   * The service names `.ryph/services.yml` declared for this run, which a setup step reaches by
   * name on the run's own network. They go in `NO_PROXY` — see `runChildEnv`. Every repo's and
   * not this repo's: one repo's setup step may legitimately wait on another's service.
   */
  services?: readonly string[];
}

/** The step that stopped a repo's setup, and what it cost. */
export interface SetupStepFailure {
  kind: "step";
  /** The step's display label (`stepLabel`), cleaned. */
  step: string;
  /** Its 1-based position in the repo's steps. */
  index: number;
  /** How many steps the repo declared. */
  total: number;
  /** The exit code (128 + n for a step killed by signal n). */
  code: number;
  /** The end of what the step printed, both streams, cleaned (`cleanSetupOutput`), trimmed
   * and bounded; "" when it printed nothing. Repo-authored output: whoever renders it must
   * treat it as untrusted text. */
  output: string;
}

/** A setup.yml that could not be used at all, so none of its steps ran. */
export interface SetupInvalid {
  kind: "invalid";
  /** The validation error, naming the file (`setup.yml: unknown key \`step\``). */
  error: string;
}

/**
 * Changes found in a repo whose own setup did not fail, after a step FAILED in another repo
 * (`after`, in checkout order): a failing step may well have written into a sibling checkout
 * (`cd ../web && npm install`), and its writes cannot be told apart from the repo's own setup's.
 * They are discarded rather than refused (which would turn the other repo's warning back into an
 * error) or shipped (as the agent's work), and said as a warning on this repo naming both.
 */
export interface SetupDiscarded {
  kind: "discarded";
  /** The repos whose setup step failed, in checkout order; never empty. */
  after: string[];
}

/**
 * Changes a repo's setup left in its own tree when no step failed anywhere: an `npm install`
 * that rewrote `package-lock.json`, a `cargo build` that updated `Cargo.lock`, codegen into a
 * tracked file, a step that committed. Setup prepares a machine and never authors work, so they
 * are discarded (the checkout put back to its start, ignored files kept) rather than shipped as
 * the agent's work — and rather than failing the run or the build, which would turn an
 * optimization into a gate.
 */
export interface SetupDirty {
  kind: "dirty";
  /** The tracked and untracked files that had changed, as `git status` names them, at most
   * `MAX_DIRTY_FILES`; empty when only HEAD or the branch moved. */
  files: string[];
}

/** How many changed files a `SetupDirty` names; the rest are counted, not listed. */
export const MAX_DIRTY_FILES = 20;

/** Why a repo's setup did not finish (a step failed, or setup.yml was invalid), or why its tree
 * was put back: for another repo's failure, or for what its own successful setup left in it. */
export type SetupFailure = SetupStepFailure | SetupInvalid | SetupDiscarded | SetupDirty;

/** A failure as one line: `setup step "<label>" failed (exit N): <tail>`, or the error. */
export function describeSetupFailure(failure: SetupFailure): string {
  if (failure.kind === "invalid") return `${failure.error}; no setup steps ran`;
  if (failure.kind === "discarded") return discardedNote(failure.after);
  if (failure.kind === "dirty") return dirtyNote(failure.files);
  return `setup step "${failure.step}" failed (exit ${failure.code})` +
    (failure.output ? `: ${failure.output}` : "");
}

/** What a `SetupDiscarded` says, without naming the repo it is about (the platform's voice). */
function discardedNote(after: readonly string[]): string {
  const repos = after.map((p) => `\`${p}/\``).join(", ");
  return `changes left in the tree after setup failed in ${repos} were discarded: they could ` +
    "not be told apart from what the failed step did";
}

/** What a `SetupDirty` says, without naming the repo it is about (the platform's voice). */
export function dirtyNote(files: readonly string[]): string {
  const what = files.length === 0
    ? "changes setup left in the tree (a commit, or another branch)"
    : `changes setup left in the tree (${files.slice(0, 5).join(", ")}${
      files.length > 5 ? ", …" : ""
    })`;
  return `${what} were discarded: setup must leave the tree clean — add build output to ` +
    ".gitignore";
}

/** Controls a printed line may not carry once escapes are gone: C0 but a tab and a line feed,
 * DEL, C1, and the Unicode bidi controls. */
const UNPRINTED =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Repo-authored text (a step's output, its label) made safe to hand on: terminal escapes and
 * control characters gone (a `\r` ends a line), then credentials in URLs redacted — a step runs
 * with the egress claim in HTTPS_PROXY's userinfo, and a verbose tool prints its proxy.
 */
export function cleanSetupOutput(text: string): string {
  return redact(
    stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(UNPRINTED, ""),
  );
}

/**
 * Runs the setup steps in order, each via `bash -c` in `opts.cwd`.
 * Streams every output line to the trace. The first non-zero exit stops the sequence and is
 * returned; null when every step ran (or there were none, or the run was aborted — an abort is
 * never a step's failure). Throws only when a step could not be run at all.
 */
export async function runSetup(
  steps: SetupStep[],
  opts: RunSetupOpts,
): Promise<SetupStepFailure | null> {
  if (steps.length === 0) return null;
  // The phase is set after the scrub on purpose: it is brand-scoped by name, and the scrub
  // would otherwise remove the one variable of ours a step is meant to read.
  const env = { ...runChildEnv(opts.services ?? []), [SETUP_PHASE_ENV]: opts.phase };
  for (const [index, step] of steps.entries()) {
    if (opts.signal.aborted) return null;
    opts.onStep?.(step, index);
    const label = stepLabel(step, index);
    const started = performance.now();
    try {
      const proc = await command("bash", {
        args: ["-c", step.run],
        cwd: opts.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
        env,
        signal: opts.signal,
        // Its own process group (the pid is its id), so a failure can end what it started.
        detached: true,
      }).spawn();
      // both streams drain concurrently — a full pipe would stall the step
      const tail = { text: "" };
      const drained = Promise.all([
        drainToTrace(proc.stdout, opts.diag, label, tail),
        drainToTrace(proc.stderr, opts.diag, label, tail),
      ]);
      const status = await proc.status;
      // Ended before the drain is awaited: a child still holding the pipes would hold it open.
      if (!status.success && !opts.signal.aborted) await endGroup(proc.pid);
      await drained;
      opts.diag.debug("setup.step", {
        step: label,
        code: status.code,
        ms: Math.round(performance.now() - started),
      });
      if (opts.signal.aborted) return null; // the kill was ours, not the step's failure
      if (!status.success) {
        return {
          kind: "step",
          step: label,
          index: index + 1,
          total: steps.length,
          code: status.code,
          // Every line was cleaned before it joined the tail (`drainToTrace`), so no cut — the
          // tail's own, or any later one — can split a credential past the redactor.
          output: tail.text.trim(),
        };
      }
    } catch (err) {
      // an abort can also surface as a throw (e.g. the spawn raced the signal) —
      // still the caller's cancellation, never a step failure
      if (opts.signal.aborted) return null;
      throw err;
    }
  }
  return null;
}

/** How long a failed step's leftovers get between TERM and KILL. */
const GROUP_KILL_GRACE_MS = 2_000;

/**
 * Ends every process left in the group `pgid` (a failed step's): TERM, up to
 * `GROUP_KILL_GRACE_MS` for them to go, then KILL. A group already gone is nothing.
 */
async function endGroup(pgid: number): Promise<void> {
  // `-1` is every process this uid may signal and `-0` the runner's own group: never a step's.
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  // The group, and each member by its pid too (`groupMembers` says why). True while anything in
  // it was reached.
  const signal = async (sig: NodeJS.Signals | 0): Promise<boolean> => {
    let reached = false;
    try {
      process.kill(-pgid, sig);
      reached = true;
    } catch {
      // ESRCH: nothing is left in it — or gVisor lost track of it, which the pids below cover
    }
    for (const pid of await groupMembers(pgid)) {
      try {
        process.kill(pid, sig);
        reached = true;
      } catch {
        // gone since the listing
      }
    }
    return reached;
  };
  if (!await signal("SIGTERM")) return;
  const deadline = performance.now() + GROUP_KILL_GRACE_MS;
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!await signal(0)) return;
  }
  await signal("SIGKILL");
}

/**
 * The pids /proc lists in group `pgid`; empty off Linux, or when /proc cannot be read. A group
 * signal alone is not enough under gVisor, where steps run: measured (runsc release-20261005,
 * plain bash and /bin/kill), `kill(-pgid)` can answer ESRCH for a live group, every time it is
 * asked, while /proc still lists its members — and a failed step's background writer went on
 * writing into the checkout.
 */
async function groupMembers(pgid: number): Promise<number[]> {
  if (process.platform !== "linux") return [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      // `pid (comm) state ppid pgrp ...`: comm may hold spaces and parens, so after its last ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) members.push(Number(entry));
    } catch {
      // gone between the listing and the read
    }
  }
  return members;
}

/**
 * A step's display label: its name, else its command — the first line with anything on it,
 * cleaned and clipped. Never empty: a `run: |` block that opens with a blank line still has a
 * label, and a step with nothing printable is `step N` (`index` is 0-based).
 */
export function stepLabel(step: SetupStep, index: number): string {
  const line = cleanSetupOutput(step.name ?? step.run).split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return `step ${index + 1}`;
  return line.length > LABEL_CLIP ? `${line.slice(0, LABEL_CLIP)}…` : line;
}

// Streams a step's output line-by-line into the trace, keeping a bounded shared tail
// for the result a failing step returns. Each line is cleaned (`cleanSetupOutput`) BEFORE it
// joins the tail: the tail is cut to its end, and a cut through a raw
// `http://user:CLAIM@proxy` would leave `CLAIM@proxy`, which no redactor recognizes. A line
// the cut lands inside is dropped too, when a whole one follows it.
async function drainToTrace(
  stream: ReadableStream<Uint8Array>,
  diag: SetupTracer,
  step: string,
  tail: { text: string },
): Promise<void> {
  const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    // Cleaned before clipped, for the tail's reason: a clip through a credential leaves what no
    // redactor recognizes.
    const clean = cleanSetupOutput(line);
    diag.debug("setup.output", { step, line: clip(clean, LINE_CLIP) });
    const kept = tail.text + clean + "\n";
    if (kept.length <= OUTPUT_TAIL_MAX) {
      tail.text = kept;
      continue;
    }
    const cut = kept.slice(-OUTPUT_TAIL_MAX);
    const start = cut.indexOf("\n");
    tail.text = start >= 0 && start < cut.length - 1 ? cut.slice(start + 1) : cut;
  }
}

// Build a child env from ambient non-secrets and private runtime configuration, then remove
// brand-scoped keys. Nothing fetched is exported into the runner's own environment. A step is
// repo-authored code — and the harness runs agent-driven code — so runner credentials (run token,
// control token, git virtual key) are not their business. Provider keys the harness needs
// stay — the agent's own subprocesses see them anyway, so stripping them here would protect
// nothing. Exported: the harness adapters spawn their children through this same scrub.
export function scrubbedEnv(): Record<string, string> {
  const env = runtimeCredentials.toObject();
  for (const key of Object.keys(env)) {
    if (key.startsWith(`${ENV_PREFIX}_`)) delete env[key];
  }
  return env;
}

/**
 * A RUN CHILD's env: the scrub above, plus the way out to the internet.
 *
 * Every child gets this — the repo's setup steps and the harness alike — and that is a decision
 * with a history worth writing down, because the code here used to say the opposite.
 *
 * THERE WAS A PHASE SPLIT, AND IT IS GONE. The original design reasoned that package managers are
 * needed in `setting-up` and the agent is not, so the credential went to setup steps and the
 * harness spawned without it. That premise is simply false about the work agents are asked to do:
 * upgrading a dependency, adding one, reproducing a build — each of them resolves a registry, and
 * an agent that can edit a manifest but never resolve it cannot run the tests on what it just
 * wrote.
 *
 * The split did not even buy the containment it read like. PID 1 (the image's tini), the runner
 * and the harness all run under the same uid (images/agent/Dockerfile runs them as uid 1994), and
 * tini carries the whole contract env, so `/proc/1/environ` (and the runner's own) serves the
 * original block for the whole life of the claim whatever the heap copy says — the old
 * `forgetEgressCredential` deleted a variable, not an ability. So the split
 * stopped a cooperative agent and not a determined one, which is the worst of the three
 * positions available. Now the allowlist is the whole boundary and it means the same thing in
 * both phases: the hosts the run's claim names, for as long as the run lives.
 *
 * WHAT THAT COSTS, PLAINLY: a registry an agent can fetch from is a registry an agent can push
 * to, so every host on the allowlist is a potential exfiltration channel for the agent phase and
 * not only a source of bytes. `github-releases` is the sharpest one — it opens `github.com`,
 * which is git push over https. That is the operator's trade to make, it is made by choosing
 * bundles, and the threat model names it rather than letting this file imply a
 * boundary the bundles do not draw.
 *
 * `HTTPS_PROXY`/`HTTP_PROXY` in both spellings, because the ecosystem never settled on one:
 * curl and most of Unix read the lowercase, Node and Go read either, and npm reads its own
 * config before either. `NO_PROXY` keeps the platform's own hosts direct — the run's control
 * plane is not the proxy's business, and routing a heartbeat through it would make the boundary
 * a dependency of liveness.
 *
 * `direct` is every OTHER address this child dials that is not on the internet, and it is the
 * caller's to name because this function cannot see them. Two kinds, both measured on a live
 * deployment:
 *
 * - the run's DECLARED SERVICE CONTAINERS: `.ryph/services.yml` puts `minio` or `postgres` on
 *   the run's own network, reachable by name for the whole run, so a step or an agent doing
 *   `curl http://minio:9000/health` would otherwise be sent to the egress proxy
 * - the PLATFORM ADDRESSES A HARNESS IS CONFIGURED WITH: the model proxy behind
 *   `ANTHROPIC_BASE_URL` and the MCP gateway each server in `mcp.json` dials. `platformHosts()`
 *   below cannot see either — they arrive in the run's credentials, not in the brand-scoped
 *   env — and the adapter that writes that config is what knows them (pi: `configuredHosts`).
 *
 * Both fail the same way when they are missed, which is why they are one parameter: the proxy
 * answers a 403 about an in-network address and points the operator at the deployment's
 * allowlist for a hostname no bundle could ever contain.
 */
/**
 * Whether `runChildEnv` will actually route a child through the egress proxy: the same three
 * variables it reads, checked the same way, so nobody else has to know their names. False on a
 * deployment with no proxy (a local run, a CLI run) — where there is no network policy to tell
 * the agent about, and claiming one would be inventing a boundary.
 */
export function egressProxyConfigured(): boolean {
  const proxy = runtimeCredentials.get(`${ENV_PREFIX}_EGRESS_PROXY`);
  if (
    !proxy || !runtimeCredentials.get(`${ENV_PREFIX}_EGRESS_TOKEN`) ||
    !runtimeCredentials.get(`${ENV_PREFIX}_RUN_ID`)
  ) {
    return false;
  }
  return URL.parse(proxy) !== null;
}

export function runChildEnv(direct: readonly string[] = []): Record<string, string> {
  const env = scrubbedEnv();
  const proxy = egressProxy(direct);
  if (proxy === null) return env;
  const url = new URL(proxy.server);
  // The run id is the username and the signed claim the password: Basic is what every one of
  // these clients already understands, and a Bearer would need a config file per tool.
  url.username = encodeURIComponent(proxy.username);
  url.password = encodeURIComponent(proxy.password);
  const withCredentials = url.href.replace(/\/$/, "");
  env.HTTPS_PROXY = withCredentials;
  env.HTTP_PROXY = withCredentials;
  env.https_proxy = withCredentials;
  env.http_proxy = withCredentials;
  // Node's native fetch ignores the proxy variables unless explicitly opted in. Without this,
  // Node CLIs try direct DNS/network access, which confined runs cannot use.
  env.NODE_USE_ENV_PROXY = "1";
  env.NO_PROXY = proxy.bypass.join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

/**
 * The way out `runChildEnv` puts in a child's env, as its parts: the proxy's address with no
 * credentials in it, the Basic pair it takes, and the hosts that stay direct. Null when the run
 * has no route out (no proxy configured, or half of one) — the same three variables, read the
 * same way, so a child and the browser can never be handed different answers about the proxy.
 */
export function egressProxy(
  direct: readonly string[] = [],
): { server: string; username: string; password: string; bypass: string[] } | null {
  const parts = proxyParts();
  if (parts === null) return null;
  return {
    ...parts,
    bypass: [...new Set(["localhost", "127.0.0.1", "::1", "[::1]", ...platformHosts(), ...direct])],
  };
}

/**
 * The browser's way out (adapters/browser/sidecar.ts): the same proxy and Basic pair as
 * `egressProxy`, and a NARROWER bypass — loopback, where the agent's dev server is, and the run's
 * own provisioned services, reached the way `curl` reaches them. Never the platform's hosts: a
 * page's JavaScript is untrusted, and a bypass for the control plane, the historian or the git
 * gateway would let any page the agent opens dial them directly. Through the proxy, which refuses
 * them, they are out of reach. The agent's shell keeps its own `NO_PROXY` (`runChildEnv`).
 */
export function browserEgressProxy(
  services: readonly string[] = [],
): { server: string; username: string; password: string; bypass: string[] } | null {
  const parts = proxyParts();
  if (parts === null) return null;
  return { ...parts, bypass: [...new Set(["localhost", "127.0.0.1", "::1", ...services])] };
}

function proxyParts(): { server: string; username: string; password: string } | null {
  const proxy = runtimeCredentials.get(`${ENV_PREFIX}_EGRESS_PROXY`);
  const token = runtimeCredentials.get(`${ENV_PREFIX}_EGRESS_TOKEN`);
  const runId = runtimeCredentials.get(`${ENV_PREFIX}_RUN_ID`);
  if (!proxy || !token || !runId) return null;
  const url = URL.parse(proxy);
  if (url === null) return null;
  url.username = "";
  url.password = "";
  return { server: url.href.replace(/\/$/, ""), username: runId, password: token };
}

/** The platform addresses a run is handed, as bare hostnames — what `NO_PROXY` must carry so
 * the run's own control channel never depends on the boundary around it. */
function platformHosts(): string[] {
  const hosts: string[] = [];
  for (const name of ["ORCHESTRATOR_URL", "HISTORY_URL", "GIT_ORIGIN"]) {
    const value = runtimeCredentials.get(`${ENV_PREFIX}_${name}`);
    if (!value) continue;
    const url = URL.parse(value);
    if (url !== null && url.hostname !== "") hosts.push(url.hostname);
  }
  return [...new Set(hosts)];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
