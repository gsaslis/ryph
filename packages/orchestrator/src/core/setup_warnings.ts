// A repo whose setup.yml did not finish, as the control plane holds it: reported by a run
// (POST /v1/runs/:id/setup/failed, one `setup.failed` event per repo) and by an environment
// build (ryph-bake's warnings file, read by the builder onto `Environment.setupWarnings`). Setup
// is an optimization: neither a run nor a build fails over it, so this is the warning
// a person and the agent read instead.
//
// Invariants:
// - one shape for both: a step that failed (`kind: "step"`) or a setup.yml that could not be used
//   (`kind: "invalid"`, no step ran); changes discarded from a repo whose own setup finished,
//   after another repo's step failed (`discarded`) or because its setup left them (`dirty`); a
//   build's record that could not be read (`unreadable`)
// - every string in it came out of a container that ran repo-authored code, so it is cleaned
//   (`cleanOutput`: no escapes, no controls, no credentials — a step runs with the egress claim
//   in HTTPS_PROXY's userinfo) and bounded before it is stored, whoever sent it
// - pure: nothing here reads a store or a clock

import { cleanOutput } from "./background.ts";

/** A repo whose setup did not finish. */
export type SetupWarning =
  | {
    kind: "step";
    /** The repo's directory in the checkout. */
    path: string;
    /** The step's label: its name, else the first line of its command. */
    step: string;
    /** The step's 1-based position, of `total`. */
    index: number;
    total: number;
    /** Its exit code. */
    code: number;
    /** The end of what it printed, cleaned; "" when nothing. */
    output: string;
    /** Whether the repo's tracked and untracked changes were discarded, back to the commit it
     * started setup at (ignored build output may remain). */
    discarded: boolean;
  }
  | {
    kind: "invalid";
    path: string;
    /** Why setup.yml was refused, naming the file. */
    error: string;
  }
  | {
    /**
     * Changes left in this repo, whose own setup did not fail, after a step FAILED in `after`:
     * that step may have written here (`cd ../web && npm install`), and what it wrote cannot be
     * told apart from this repo's own setup's, so the tree was put back to its start too.
     */
    kind: "discarded";
    path: string;
    /** The repos whose step failed, in checkout order. */
    after: string[];
  }
  | {
    /**
     * Changes this repo's own setup left in its tree when no step failed anywhere (a rewritten
     * lockfile, codegen into a tracked file, a commit): setup must not author work, so the tree
     * was put back to its start, ignored files kept. Its setup DID finish (`setupUnfinished`
     * leaves this kind out): the warning is that what it changed is gone.
     */
    kind: "dirty";
    path: string;
    /** The changed files, as git names them; empty when only HEAD or the branch moved. */
    files: string[];
  }
  | {
    /**
     * A build's record of its setup warnings was there but could not be read (cut short, or not
     * JSON): which repos' setup.yml finished is unknown, so the build is not reported as setup.yml
     * working. Never sent by a run; a builder writes it with `path` "" and the core names the
     * build's first checkout (`setupWarningsForBuild`).
     */
    kind: "unreadable";
    path: string;
  };

/** The bounds a stored warning is held to. */
export const MAX_SETUP_WARNING_LABEL = 200;
export const MAX_SETUP_WARNING_OUTPUT = 4_096;
export const MAX_SETUP_WARNINGS = 64;
/** How many changed files a `dirty` warning keeps. */
export const MAX_SETUP_WARNING_FILES = 20;
const PATH = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The end of `text`, at most `max` characters. */
function keepEnd(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** The start of `text`, at most `max` characters. */
function keepStart(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One line: control characters and line breaks gone, clipped. */
function oneLine(text: string, max: number): string {
  const flat = cleanOutput(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A warning as it is stored: every string cleaned and bounded. */
export function cleanSetupWarning(warning: SetupWarning): SetupWarning {
  if (warning.kind === "unreadable") return { kind: "unreadable", path: warning.path };
  if (warning.kind === "discarded") {
    const after = [...new Set(warning.after.filter((p) => PATH.test(p) && p !== warning.path))]
      .slice(0, MAX_SETUP_WARNINGS);
    return { kind: "discarded", path: warning.path, after };
  }
  if (warning.kind === "dirty") {
    const files = warning.files.map((f) => oneLine(f, MAX_SETUP_WARNING_LABEL))
      .filter((f) => f !== "").slice(0, MAX_SETUP_WARNING_FILES);
    return { kind: "dirty", path: warning.path, files };
  }
  if (warning.kind === "invalid") {
    return {
      kind: "invalid",
      path: warning.path,
      // The start: a parser's error names the problem first.
      error: keepStart(cleanOutput(warning.error).trim(), MAX_SETUP_WARNING_OUTPUT),
    };
  }
  return {
    kind: "step",
    path: warning.path,
    step: oneLine(warning.step, MAX_SETUP_WARNING_LABEL) || `step ${warning.index}`,
    index: warning.index,
    total: warning.total,
    code: warning.code,
    // The runner cleaned each line before it kept the tail, so what arrives was not cut inside a
    // credential. Untrusted, it is cleaned again BEFORE this cut, so this cut cannot split one
    // past the redactor either.
    output: keepEnd(cleanOutput(warning.output).trim(), MAX_SETUP_WARNING_OUTPUT),
    discarded: warning.discarded,
  };
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The warnings in an untrusted value (a build's warnings file, parsed), cleaned: anything that is
 * not one is dropped, and at most `MAX_SETUP_WARNINGS` are kept. Never throws.
 */
export function setupWarningsFrom(raw: unknown): SetupWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: SetupWarning[] = [];
  for (const item of raw.slice(0, MAX_SETUP_WARNINGS)) {
    if (typeof item !== "object" || item === null) continue;
    const w = item as Record<string, unknown>;
    if (typeof w.path !== "string" || !PATH.test(w.path)) continue;
    if (
      w.kind === "discarded" && Array.isArray(w.after) &&
      w.after.every((p) => typeof p === "string")
    ) {
      const warning = cleanSetupWarning({ kind: "discarded", path: w.path, after: w.after });
      if (warning.kind === "discarded" && warning.after.length > 0) out.push(warning);
    } else if (
      w.kind === "dirty" && Array.isArray(w.files) && w.files.every((f) => typeof f === "string")
    ) {
      out.push(cleanSetupWarning({ kind: "dirty", path: w.path, files: w.files }));
    } else if (w.kind === "invalid" && typeof w.error === "string") {
      out.push(cleanSetupWarning({ kind: "invalid", path: w.path, error: w.error }));
    } else if (
      w.kind === "step" && typeof w.step === "string" && isInt(w.index, 1, 1000) &&
      isInt(w.total, 1, 1000) && isInt(w.code, 0, 1_000_000) && typeof w.output === "string"
    ) {
      out.push(cleanSetupWarning({
        kind: "step",
        path: w.path,
        step: w.step,
        index: w.index,
        total: w.total,
        code: w.code,
        output: w.output,
        discarded: w.discarded === true,
      }));
    }
  }
  return out;
}

/** The warning a builder records when a build's warnings record was there but unreadable. */
export function unreadableSetupWarning(): SetupWarning {
  return { kind: "unreadable", path: "" };
}

/**
 * Warnings held to the repos of one run or build (`paths`): a warning about any other repo is
 * dropped — the report came out of a container a repo's step could write to — and so is a
 * `discarded` one's mention of another repo, and then the warning itself when no repo it names
 * is left. At most one per repo and kind, so an invalid setup.yml and a discard in the same repo
 * both stand.
 */
export function ownSetupWarnings(
  warnings: readonly SetupWarning[],
  paths: readonly string[],
): SetupWarning[] {
  const own = new Set(paths);
  const seen = new Set<string>();
  const out: SetupWarning[] = [];
  for (const warning of warnings) {
    if (!own.has(warning.path)) continue;
    const held = warning.kind === "discarded"
      ? { ...warning, after: warning.after.filter((p) => own.has(p) && p !== warning.path) }
      : warning;
    if (held.kind === "discarded" && held.after.length === 0) continue;
    const key = `${held.path}\u0000${held.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(held);
  }
  return out;
}

/**
 * A build's warnings, as its row holds them: `ownSetupWarnings` of the build's checkout paths,
 * an unreadable record's warning named on the first of them.
 */
export function setupWarningsForBuild(
  warnings: readonly SetupWarning[],
  paths: readonly string[],
): SetupWarning[] {
  return ownSetupWarnings(
    warnings.map((warning) =>
      warning.kind === "unreadable" && warning.path === ""
        ? { ...warning, path: paths[0] ?? "" }
        : warning
    ),
    paths,
  );
}

/**
 * Whether these warnings say some repo's setup.yml did not finish: any but `dirty`, whose setup
 * finished and only had what it left in the tree discarded. (`discarded` rides beside the
 * failed step that caused it; `unreadable` cannot say setup finished.)
 */
export function setupUnfinishedIn(warnings: readonly SetupWarning[] | null | undefined): boolean {
  return (warnings ?? []).some((w) => w.kind !== "dirty");
}

/** Whether a warning says the repo's own setup.yml broke: a step failed, or the file was
 * invalid — what a fix in the repo answers, unlike a discard, a dirty tree or a lost record. */
export function setupBroke(warning: SetupWarning): boolean {
  return warning.kind === "step" || warning.kind === "invalid";
}

/**
 * One warning's summary line, in plain words, for the run's history and a build's feedback:
 * which repo, which step and its exit code (or that setup.yml was invalid), what was skipped,
 * and whether the tree was put back. `after` ends it: what went on without the steps
 * ("the run went on", "the build went on").
 */
export function summarizeSetupWarning(warning: SetupWarning, after: string): string {
  const repo = `\`${warning.path}/\``;
  if (warning.kind === "discarded") {
    const failed = warning.after.map((p) => `\`${p}/\``).join(", ");
    return `${repo}: changes left in it after setup failed in ${failed} were discarded, since ` +
      `they could not be told apart from what the failed step did, and ${after}.`;
  }
  if (warning.kind === "dirty") {
    const files = warning.files.length === 0
      ? "a commit or a branch switch"
      : warning.files.slice(0, 5).map((f) => `\`${f}\``).join(", ") +
        (warning.files.length > 5 ? ", …" : "");
    return `${repo}: setup.yml finished but left changes in the tree (${files}), which were ` +
      `discarded so they do not ship as work — add build output to .gitignore — and ${after}.`;
  }
  if (warning.kind === "unreadable") {
    return `${repo}: the build's record of which setup.yml steps finished could not be read, ` +
      `so setup.yml may not have finished, and ${after}. This is the platform's problem, not ` +
      "the repo's: no change to .ryph/ fixes it.";
  }
  if (warning.kind === "invalid") {
    return `${repo}: \`.ryph/setup.yml\` is invalid, so none of its steps ran, and ${after}.`;
  }
  const skipped = Math.max(0, warning.total - warning.index);
  const rest = skipped === 0
    ? ""
    : `, so the ${skipped === 1 ? "step after it was" : `${skipped} steps after it were`} skipped`;
  const discarded = warning.discarded
    ? " Its tracked and untracked changes were discarded and its checkout put back on its " +
      "base commit; ignored build output may remain."
    : "";
  return `${repo}: step ${warning.index} of ${warning.total} (${oneLine(warning.step, 200)}) ` +
    `exited with code ${warning.code}${rest}, and ${after}.${discarded}`;
}

/** What the warning quotes after its summary: the step's output tail or the parser's error. */
export function setupWarningText(warning: SetupWarning): string {
  if (warning.kind !== "invalid" && warning.kind !== "step") return "";
  return (warning.kind === "invalid" ? warning.error : warning.output).trim();
}

/**
 * A `setup.failed` event's detail: the summary line, opened by the warning's kind in brackets
 * (`[dirty] \`api/\`: …`) so a reader tells the kinds apart without matching the summary's
 * words, then the output tail or the error.
 */
export function describeSetupWarning(warning: SetupWarning): string {
  const summary = `[${warning.kind}] ${summarizeSetupWarning(warning, "the run went on")}`;
  const text = setupWarningText(warning);
  return text === "" ? summary : `${summary}\n${text}`;
}
