// The `.ryph/checks.yml` parser, and the two pure readings a settled suite needs of the paths a
// change touched. Strict in the idiom of helpers/services.ts: unknown keys are refused rather
// than skipped, anchors and aliases are refused outright, every list and string is bounded, and
// every message is written for the repo's author — it is their file, and the refusal is shown to
// them (the agent through its tool, a person through the suite page).
//
// This is the first repo-authored text whose content becomes a COMMAND. The parser does not
// interpret it: `run` is one opaque string, carried to a check container's platform-authored
// entrypoint as an env value and executed there as `sh -c`. Nothing here runs it, splits it or
// looks inside it.
//
// Pure: no I/O, no clock, no port. The table test in tests/checks_parse_test.ts is the whole
// specification.

import { parse as parseYaml } from "@std/yaml";
import {
  CHECK_NAME,
  type CheckDeclaration,
  type ChecksDeclaration,
  MAX_CHECKS,
  MAX_KEEP,
  MAX_OWN_PODS,
  MAX_RUN_CHARS,
  MAX_SETUP_STEPS,
  MAX_WATCH,
} from "../core/check_types.ts";
import { SIZE_CLASS_NAME } from "../core/run_sizes.ts";
import { isMapping, refuseAnchors, SERVICE_NAME } from "./services.ts";

// Exported, like the limits in core/check_types.ts, so the ryph-checks skill that states them is
// tested against them.
export const MAX_SERVICES_PER_CHECK = 20;
export const MAX_GLOB_CHARS = 200;
/** `*` and `?` in one glob. The matcher is linear either way; this keeps a glob legible. */
export const MAX_WILDCARDS = 16;
/** A changed path longer than this, or with more segments, is not matched at all, and makes a
 * "no" unknown. */
const MAX_MATCHED_PATH_CHARS = 1024;
const MAX_MATCHED_PATH_SEGMENTS = 64;
/** The table cells one settle's matching may fill (tens of milliseconds) before what is still
 * undecided is unknown. */
const MATCH_BUDGET_CELLS = 20_000_000;
/** The longest a declared `timeout` may be before the operator's ceiling even applies. */
export const MAX_DECLARED_TIMEOUT_S = 24 * 60 * 60;

/**
 * Parses the declaration, or throws with a message for the repo's author.
 *
 * An empty or comments-only file is no checks, not an error — the same as an absent file, and
 * the same as `checks: []`.
 */
export function parseChecksYaml(text: string): ChecksDeclaration {
  refuseAnchors(text);
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`not valid YAML: ${err instanceof Error ? err.message : err}`);
  }
  if (doc === null || doc === undefined) return { setup: [], checks: [] };
  if (!isMapping(doc)) throw new Error("top level must be a mapping with `setup` and `checks`");
  for (const key of Object.keys(doc)) {
    if (key !== "setup" && key !== "checks" && key !== "keep") {
      throw new Error(
        `unknown key \`${key}\` — a checks file has \`setup\` (steps run once), \`checks\` ` +
          "and `keep` (ignored files a check keeps from the image)",
      );
    }
  }
  const keep = parseKeep(doc.keep);
  return {
    setup: parseSetup(doc.setup),
    checks: parseChecks(doc.checks),
    ...(keep === null ? {} : { keep }),
  };
}

/** `keep`: gitignore-style patterns, each one `git clean -x -e <pattern>` in a baked check. Null
 * when absent, which is the default list (`keepOf`); `[]` keeps nothing. */
function parseKeep(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new Error("`keep` must be a list of gitignore-style patterns, e.g. [node_modules]");
  }
  if (raw.length > MAX_KEEP) throw new Error(`keep: ${raw.length} patterns exceeds ${MAX_KEEP}`);
  return raw.map((pattern, i) => {
    // oxlint-disable-next-line no-control-regex
    const control = /[\u0000-\u001f]/;
    if (
      typeof pattern !== "string" || pattern.trim() === "" || pattern.length > MAX_GLOB_CHARS ||
      pattern.startsWith("!") || pattern.startsWith("#") ||
      pattern.split("/").includes("..") || control.test(pattern)
    ) {
      throw new Error(
        `keep[${i}]: a gitignore-style pattern inside the repo, like \`node_modules\` or ` +
          `\`/target\`, at most ${MAX_GLOB_CHARS} characters, not negated and without \`..\``,
      );
    }
    return pattern;
  });
}

function parseSetup(raw: unknown): Array<{ run: string }> {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("`setup` must be a list of `- run: <command>` steps");
  if (raw.length > MAX_SETUP_STEPS) {
    throw new Error(`setup: ${raw.length} steps exceeds the limit of ${MAX_SETUP_STEPS}`);
  }
  return raw.map((step, i) => {
    const at = `setup[${i}]`;
    if (!isMapping(step)) throw new Error(`${at}: must be a mapping with \`run\``);
    for (const key of Object.keys(step)) {
      if (key !== "run") throw new Error(`${at}: unknown key \`${key}\` — a step has only \`run\``);
    }
    return { run: parseRun(step.run, at) };
  });
}

function parseChecks(raw: unknown): CheckDeclaration[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("`checks` must be a list of checks, each with a `name` and a `run`");
  }
  if (raw.length > MAX_CHECKS) {
    throw new Error(`checks: ${raw.length} checks exceeds the limit of ${MAX_CHECKS}`);
  }
  const names = new Set<string>();
  const checks = raw.map((check, i) => {
    const parsed = parseCheck(check, `checks[${i}]`);
    if (names.has(parsed.name)) {
      throw new Error(
        `checks.${parsed.name}: declared twice — a name is what a ruleset requires, so it must ` +
          "be unique",
      );
    }
    names.add(parsed.name);
    return parsed;
  });
  const own = checks.filter((c) => c.pod === "own");
  if (own.length > MAX_OWN_PODS) {
    throw new Error(
      `checks: ${own.length} checks declare \`pod: own\`, and at most ${MAX_OWN_PODS} may — each ` +
        "is a pod and a setup run of its own, and each own pod and the shared pod take a slot " +
        "of RYPH_CHECKS_CONCURRENCY. Keep `pod: own` for the heaviest",
    );
  }
  return checks;
}

function parseCheck(raw: unknown, at: string): CheckDeclaration {
  if (!isMapping(raw)) throw new Error(`${at}: must be a mapping with \`name\` and \`run\``);
  const known = ["name", "run", "timeout", "services", "watch", "pod", "size"];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new Error(`${at}: unknown key \`${key}\``);
  }
  const { name } = raw;
  if (typeof name !== "string" || !CHECK_NAME.test(name)) {
    throw new Error(
      `${at}.name: lowercase letters, digits and dashes, starting and ending with a letter or ` +
        "digit, at most 40 characters — it becomes the check's name on the forge (`ryph / <name>`)",
    );
  }
  const named = `checks.${name}`;
  const pod = parsePod(raw.pod, `${named}.pod`);
  const size = parseSize(raw.size, `${named}.size`);
  if (size !== null && pod === null) {
    throw new Error(
      `${named}.size: only with \`pod: own\` — a check in the shared pod gets the shared pod's ` +
        "size",
    );
  }
  return {
    name,
    run: parseRun(raw.run, named),
    timeoutSeconds: raw.timeout === undefined || raw.timeout === null
      ? null
      : parseTimeout(raw.timeout, `${named}.timeout`),
    services: parseServiceNames(raw.services, `${named}.services`),
    watch: parseWatch(raw.watch, `${named}.watch`),
    ...(pod === null ? {} : { pod }),
    ...(size === null ? {} : { size }),
  };
}

/** `pod`: `own`, or absent for the shared pod. */
function parsePod(raw: unknown, at: string): "own" | null {
  if (raw === null || raw === undefined) return null;
  if (raw !== "own") {
    throw new Error(`${at}: \`own\` (the check runs in a pod of its own), or leave it out`);
  }
  return raw;
}

/** `size`: a size class name. Whether the deployment defines it is known only at launch. */
function parseSize(raw: unknown, at: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || !SIZE_CLASS_NAME.test(raw)) {
    throw new Error(
      `${at}: the name of one of the deployment's size classes, like \`large\` (lowercase ` +
        "letters, digits and dashes, at most 32 characters)",
    );
  }
  return raw;
}

function parseRun(raw: unknown, at: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${at}.run: required — one shell command line, run as \`sh -c\``);
  }
  if (raw.length > MAX_RUN_CHARS) {
    throw new Error(`${at}.run: ${raw.length} characters exceeds ${MAX_RUN_CHARS}`);
  }
  if (raw.includes("\u0000")) throw new Error(`${at}.run: must not contain a NUL byte`);
  return raw;
}

function parseTimeout(raw: unknown, at: string): number {
  const seconds = typeof raw === "number"
    ? (Number.isInteger(raw) && raw > 0 ? raw : null)
    : typeof raw === "string"
    ? parseDuration(raw)
    : null;
  if (seconds === null) {
    throw new Error(`${at}: a duration like "90s", "20m" or "1h", or a whole number of seconds`);
  }
  if (seconds > MAX_DECLARED_TIMEOUT_S) throw new Error(`${at}: at most 24h`);
  return seconds;
}

/** `"90s"` / `"20m"` / `"1h"` → seconds; null for anything else. */
export function parseDuration(text: string): number | null {
  const match = /^([1-9][0-9]{0,5})(s|m|h)$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
}

function parseServiceNames(raw: unknown, at: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${at}: a list of names from .ryph/services.yml`);
  if (raw.length > MAX_SERVICES_PER_CHECK) {
    throw new Error(`${at}: ${raw.length} services exceeds ${MAX_SERVICES_PER_CHECK}`);
  }
  const out: string[] = [];
  for (const [i, name] of raw.entries()) {
    if (typeof name !== "string" || !SERVICE_NAME.test(name)) {
      throw new Error(`${at}[${i}]: a service name from .ryph/services.yml`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function parseWatch(raw: unknown, at: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${at}: a list of path globs, e.g. ["package.json"]`);
  if (raw.length > MAX_WATCH) throw new Error(`${at}: ${raw.length} globs exceeds ${MAX_WATCH}`);
  return raw.map((glob, i) => {
    // oxlint-disable-next-line no-control-regex
    const control = /[\u0000-\u001f]/;
    if (
      typeof glob !== "string" || glob === "" || glob.length > MAX_GLOB_CHARS ||
      glob.startsWith("/") || glob.split("/").includes("..") || control.test(glob)
    ) {
      throw new Error(
        `${at}[${i}]: a path glob relative to the repo root (\`*\`, \`**\` and \`?\`), at most ` +
          `${MAX_GLOB_CHARS} characters`,
      );
    }
    if (glob.split("/").some((segment) => segment.includes("**") && segment !== "**")) {
      throw new Error(
        `${at}[${i}]: \`**\` must be a whole path segment, as in \`**/x\` or \`x/**\``,
      );
    }
    if ((glob.match(/[*?]/g) ?? []).length > MAX_WILDCARDS) {
      throw new Error(`${at}[${i}]: at most ${MAX_WILDCARDS} wildcards`);
    }
    return glob;
  });
}

/**
 * One matcher for a list of globs, matched against the WHOLE repo-relative path — `deno.json`
 * is the root one only, and `**\/deno.json` is any of them. A `**` segment is any number of
 * directories (at least one when it ends the glob: `tests/**` is what is under `tests/`); `*`
 * and `?` stay within one segment.
 *
 * Not a RegExp: the paths are the HEAD's, and a backtracking regex over a glob like
 * `**\/*.*.*.*.ts` takes minutes on a path of a few hundred dots — in the control plane. This is
 * a table over segments, and inside a segment over characters: time is the product of the two
 * lengths, whatever they contain.
 */
export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  const compiled = globs.map(compileGlob);
  const scratch = newScratch();
  return (path) => {
    const segments = path.split("/");
    return compiled.some((glob) => globMatches(glob, path, segments, scratch));
  };
}

/** A glob split once: its segments, and whether it has a wildcard at all. */
interface CompiledGlob {
  text: string;
  segments: string[];
  literal: boolean;
}

const compileGlob = (text: string): CompiledGlob => ({
  text,
  segments: text.split("/"),
  literal: !/[*?]/.test(text),
});

/** The two rows each table runs in, reused for every match, and the cells filled so far. */
interface Scratch {
  seg: [Uint8Array, Uint8Array];
  chr: [Uint8Array, Uint8Array];
  cells: number;
}

const newScratch = (): Scratch => ({
  seg: [
    new Uint8Array(MAX_MATCHED_PATH_SEGMENTS + 1),
    new Uint8Array(MAX_MATCHED_PATH_SEGMENTS + 1),
  ],
  chr: [new Uint8Array(MAX_MATCHED_PATH_CHARS + 1), new Uint8Array(MAX_MATCHED_PATH_CHARS + 1)],
  cells: 0,
});

/** Rows of at least `n` cells: grown only for a caller past the caps (`globMatcher` alone). */
function rows(pair: [Uint8Array, Uint8Array], n: number): [Uint8Array, Uint8Array] {
  if (pair[0].length < n) {
    pair[0] = new Uint8Array(n);
    pair[1] = new Uint8Array(n);
  }
  return pair;
}

function globMatches(
  glob: CompiledGlob,
  path: string,
  segments: readonly string[],
  s: Scratch,
): boolean {
  if (glob.literal) {
    s.cells++;
    return glob.text === path;
  }
  return segmentsMatch(glob.segments, segments, s);
}

function segmentsMatch(glob: readonly string[], path: readonly string[], s: Scratch): boolean {
  const n = path.length;
  // row[j]: the glob's segments so far match the path's first j segments.
  let [row, next] = rows(s.seg, n + 1);
  row.fill(0, 0, n + 1);
  row[0] = 1;
  for (let i = 0; i < glob.length; i++) {
    let any = 0;
    if (glob[i] === "**") {
      const last = i === glob.length - 1;
      next[0] = last ? 0 : row[0];
      any = next[0];
      for (let j = 1; j <= n; j++) {
        next[j] = row[j - 1] | next[j - 1] | (last ? 0 : row[j]);
        any |= next[j];
      }
    } else {
      next[0] = 0;
      for (let j = 1; j <= n; j++) {
        next[j] = row[j - 1] && segmentMatches(glob[i], path[j - 1], s) ? 1 : 0;
        any |= next[j];
      }
    }
    s.cells += n + 1;
    [row, next] = [next, row];
    // Nothing matches this far: nothing further can.
    if (any === 0) return false;
  }
  return row[n] === 1;
}

/** `*` (any run) and `?` (one character) against one path segment, everything else literal. */
function segmentMatches(pattern: string, name: string, s: Scratch): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    s.cells++;
    return pattern === name;
  }
  const n = name.length;
  let [row, next] = rows(s.chr, n + 1);
  row.fill(0, 0, n + 1);
  row[0] = 1;
  for (const c of pattern) {
    let any = 0;
    if (c === "*") {
      next[0] = row[0];
      any = next[0];
      for (let j = 1; j <= n; j++) {
        next[j] = row[j] | next[j - 1];
        any |= next[j];
      }
    } else {
      next[0] = 0;
      for (let j = 1; j <= n; j++) {
        next[j] = row[j - 1] && (c === "?" || name[j - 1] === c) ? 1 : 0;
        any |= next[j];
      }
    }
    s.cells += n + 1;
    [row, next] = [next, row];
    if (any === 0) return false;
  }
  return row[n] === 1;
}

/** Everything under `.ryph/`: the judge's own directory, watched by every check. */
export const RYPH_WATCH = ".ryph/**";

/** The prefix of every line of the clone step's changed-paths list (the check launchers' clone
 * script prints it, `changedPathsFromLog` reads it). */
export const CHANGED_PATHS_MARKER = "@@ryph-changed";

/** The paths a change touched, as the clone step listed them: `complete` false when the list
 * was cut short (the step lists at most 5000). */
export interface ChangedPaths {
  paths: string[];
  complete: boolean;
}

/** What a changed-paths list says for each check, and for `.ryph/` itself. */
export interface WatchedAnswers {
  /** One per check, in the order given. */
  checks: Array<boolean | null>;
  /** Whether `.ryph/**` changed. */
  ryph: boolean | null;
}

/**
 * Whether a change touched anything each check depends on beyond the code under test: its
 * `watch` globs, and `.ryph/**` always. Null when that is not known — the paths are unknown, or
 * a list that is cut short, holds a path too long or too deep to match, or ran out the budget
 * matched nothing (what was not looked at might have).
 *
 * The paths are the head's and the globs the base's: up to 5000 of one and 32 × 32 of the other,
 * matched inside a settle. So every glob is compiled once, each path is split once and matched
 * against the union of every check's globs (a glob that already matched is not tried again), and
 * the whole is held to a budget of table cells: past it, what is still undecided is unknown.
 */
export function watchedChangedByCheck(
  changed: ChangedPaths | null,
  watches: ReadonlyArray<readonly string[]>,
): WatchedAnswers {
  if (changed === null) return { checks: watches.map(() => null), ryph: null };
  const index = new Map<string, number>([[RYPH_WATCH, 0]]);
  for (const watch of watches) {
    for (const glob of watch) if (!index.has(glob)) index.set(glob, index.size);
  }
  const globs = [...index.keys()].map(compileGlob);
  const matched = new Uint8Array(globs.length);
  let left = globs.length;
  let skipped = false;
  const scratch = newScratch();
  outer: for (const path of changed.paths) {
    if (left === 0) break;
    if (path.length > MAX_MATCHED_PATH_CHARS) {
      skipped = true;
      continue;
    }
    const segments = path.split("/");
    if (segments.length > MAX_MATCHED_PATH_SEGMENTS) {
      skipped = true;
      continue;
    }
    for (let g = 0; g < globs.length; g++) {
      if (matched[g] === 1) continue;
      if (scratch.cells > MATCH_BUDGET_CELLS) {
        skipped = true;
        break outer;
      }
      if (globMatches(globs[g], path, segments, scratch)) {
        matched[g] = 1;
        left--;
      }
    }
  }
  const unknown = !changed.complete || skipped;
  const answer = (watch: readonly string[]) =>
    matched[0] === 1 || watch.some((glob) => matched[index.get(glob)!] === 1)
      ? true
      : unknown
      ? null
      : false;
  return { checks: watches.map(answer), ryph: answer([]) };
}

/** `watchedChangedByCheck` for one check. */
export function watchedChanged(
  changed: ChangedPaths | null,
  watch: readonly string[],
): boolean | null {
  return watchedChangedByCheck(changed, [watch]).checks[0];
}

/**
 * The changed-paths list the clone step prints into its own log (the check launchers' clone
 * script): one `@@ryph-changed <path>` line per path the change touched (base → head), then
 * `@@ryph-changed-end <n>` with n the number of paths the change touched — preceded by
 * `@@ryph-changed-truncated <n>` when the list was cut.
 *
 * The count is what makes the list trustworthy: the log is read from its END, and the paths are
 * the head's, so a head with enough long paths could push the front of the list — `.ryph/` sorts
 * first — out of what is read, and leave an end line that reads as complete. A list is complete
 * only when it holds exactly n paths. A path git quoted (C-style, in double quotes) is unquoted,
 * and one that does not unquote makes the whole list unknown. `@@ryph-changed-unknown <why>`, no end line, a count that
 * does not add up, or no clone log at all is "not known": null, never an empty list — an empty
 * list claims the change touched nothing.
 */
export function changedPathsFromLog(log: string | null): ChangedPaths | null {
  if (log === null) return null;
  const M = CHANGED_PATHS_MARKER;
  const paths: string[] = [];
  let truncated = false;
  let end: number | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === `${M}-unknown` || line.startsWith(`${M}-unknown `)) return null;
    if (line.startsWith(`${M} `)) {
      if (end !== null) return null;
      const path = line.slice(M.length + 1);
      if (!path.startsWith('"')) {
        paths.push(path);
        continue;
      }
      // git quotes a name holding `"`, `\` or a control character, whatever `core.quotePath`
      // says. One it quoted that does not unquote is not a path this could match.
      const unquoted = unquoteC(path);
      if (unquoted === null) return null;
      paths.push(unquoted);
    } else if (line.startsWith(`${M}-truncated `)) {
      if (end !== null) return null;
      truncated = true;
    } else if (line.startsWith(`${M}-end`)) {
      const n = line.slice(`${M}-end`.length).trim();
      if (end !== null || !/^[0-9]{1,9}$/.test(n)) return null;
      end = Number(n);
    }
  }
  if (end === null) return null;
  if (truncated) return paths.length < end ? { paths, complete: false } : null;
  return paths.length === end ? { paths, complete: true } : null;
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A name as git C-quotes it (`quote_c_style`): in double quotes, with `\"`, `\\`, `\t`, `\n` and
 * the other single-letter escapes, and any other byte as three octal digits — the bytes then
 * read as UTF-8. Null for anything git would not have written.
 */
export function unquoteC(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length;) {
    const c = body[i];
    if (c === '"') return null;
    if (c !== "\\") {
      const char = String.fromCodePoint(body.codePointAt(i)!);
      for (const b of encoder.encode(char)) bytes.push(b);
      i += char.length;
      continue;
    }
    const e = body[i + 1];
    if (e === undefined) return null;
    if (Object.hasOwn(C_ESCAPES, e)) {
      bytes.push(C_ESCAPES[e]);
      i += 2;
      continue;
    }
    const octal = /^[0-3][0-7]{2}$/.exec(body.slice(i + 1, i + 4));
    if (octal === null) return null;
    bytes.push(parseInt(octal[0], 8));
    i += 4;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
