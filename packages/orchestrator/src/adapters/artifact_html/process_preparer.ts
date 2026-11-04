// The served document of a publish, made in a child process that can really be stopped: one
// process per document (sanitizer.ts), killed at its deadline, with a ceiling on how many run at
// once. The boundary is the process, so no input can make one document cost more than:
//
// - TIME: the budget plus a grace for the process to start, then SIGKILL. The parse also stops
//   itself at the budget wherever it reads the clock (helpers/artifact_html.ts) and answers
//   `too_complex` in an orderly way, but nothing relies on that: a path that never reads the
//   clock is killed all the same. The kill is the reason for a process. A worker thread cannot be
//   stopped reliably: terminating it releases its caller but can leave a thread busy in a
//   synchronous loop running to the end, and four review rounds in a row
//   found another path that ran past the budget that way.
// - MEMORY: the parse's V8 heap is capped at `heapMb` (`--max-old-space-size` for a confined
//   process; node:worker_threads `resourceLimits` and the process's own watch on its size for an
//   unconfined one, sanitizer.ts). Past the cap the publish is refused `too_complex`. The control
//   plane only ever holds the HTML going in and the JSON coming back.
// - PERMISSIONS: CONFINED where a Node 25 or later is there to run it: `node --permission`,
//   granted reading its own modules and nothing else (no write, network, child process, worker,
//   addon, WASI or inspector), which the process proves before it reads the document
//   (sanitizer_permissions.ts). The node is RYPH_ARTIFACT_SANITIZER_NODE when that is set (then
//   nothing else will do: one that cannot confine it, or an empty value, refuses every publish as
//   `unavailable`), or the first `node` on PATH; either is checked once, at construction, for its
//   version and for a permission model that is on and denies all of that (`sanitizerRuntime`).
//   The compiled `ryph` binary does the same: it carries the sanitizer's modules and parse5 in
//   the archive it unpacks (packages/ryph/scripts/compile.ts), and node reads them there. Where
//   there is no such node, the process is UNCONFINED: this runtime again (or the binary itself),
//   holding every right of this uid. That is said once, at construction (`onUnconfined`), unless
//   RYPH_ARTIFACT_SANITIZER_CONFINED=required, which makes it `unavailable` instead. Either way it
//   starts with an empty environment, so with no credential this process holds, in an empty
//   directory of its own.
// - WHAT COMES BACK: checked (`validatePrepared`) before the core sees it. A process SIGKILLed by
//   anyone but the deadline (the kernel's OOM killer) is `too_complex`, as the heap cap is.
//
// A slot is held until the process has exited, which a SIGKILL guarantees within moments: what
// the ceiling counts is processes alive, and none can outlive its deadline by more than that.
// One at once per process by default, so one per run too; past it a publish is refused at once
// (the runner hands the agent the words), never queued. Publishes are rare (a run may try 30 an
// hour), and a run looping crafted documents holds one process for at most budget + grace each.
//
// Unconfined, the process is `<runtime> sanitizer.ts`; inside a compiled binary (built with
// `--define RYPH_STANDALONE=true`) it is the binary itself with ARTIFACT_SANITIZER_SUBCOMMAND and
// the binary's runtime directory, which the binary's entry must hand to `runArtifactSanitizer`
// before importing anything else (packages/ryph/src/entry.ts).

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Child, command, type CommandOutput } from "@ryph/process";
import type {
  ArtifactHtmlOutcome,
  ArtifactHtmlPreparer,
  ArtifactHtmlSlot,
} from "../../ports/artifact_html.ts";
import {
  ARTIFACT_PREAMBLE,
  MAX_SERIALIZED_LENGTH,
  MAX_TAG_ATTRIBUTES,
  MAX_TREE_NODES,
  type PreparedHtml,
} from "../../helpers/artifact_html.ts";
import { ARTIFACT_SANITIZER_SUBCOMMAND, CONFINED_FLAG } from "./sanitizer.ts";
import {
  DENIED_SCOPES,
  MIN_CONFINED_NODE_MAJOR,
  SANITIZER_PACKAGES,
  sanitizerModules,
} from "./sanitizer_permissions.ts";

/** Defined `true` by a compiled binary's build (`bun build --compile --define`). */
declare const RYPH_STANDALONE: boolean | undefined;
const STANDALONE = typeof RYPH_STANDALONE !== "undefined" && RYPH_STANDALONE === true;

/** How long one document may take, counted inside the process once it has started. */
export const DEFAULT_ARTIFACT_HTML_BUDGET_MS = 3_000;
/** What the deadline allows past the budget: starting the process (and, unconfined, its worker),
 * which the document's own clock does not count (docs/artifacts.md); the rest is room for a
 * loaded machine. */
export const STARTUP_GRACE_MS = 2_000;
/** The sanitizer's V8 heap cap, in MiB. Every document of the reviews' corpus and every
 * legitimate page measured fits in 128 (2 MiB of table rows does not fit in 96); a process at
 * the cap was measured at about 300 MB RSS (docs/artifacts.md). */
export const DEFAULT_ARTIFACT_HTML_HEAP_MB = 192;
/** How many documents may be made at once, per control-plane process. */
export const DEFAULT_ARTIFACT_HTML_IN_FLIGHT = 1;

/** Names the node that runs the sanitizer confined; nothing else will do once it is set. */
export const SANITIZER_NODE_ENV = "RYPH_ARTIFACT_SANITIZER_NODE";
/** `required`: no node that confines the sanitizer makes it unavailable, never unconfined. */
export const SANITIZER_CONFINED_ENV = "RYPH_ARTIFACT_SANITIZER_CONFINED";

/** The sanitizer's module, and the other two the confined process loads (`sanitizerModules`).
 * They are what it may read, with the npm packages they import (`sanitizerReads`). */
const SANITIZER_PATH = fileURLToPath(new URL("./sanitizer.ts", import.meta.url));
const OWN_MODULES = sanitizerModules();
/** The npm packages those import, each with its own dependencies followed. */
const OWN_PACKAGES = [{ name: "parse5", from: OWN_MODULES[2] }];

/** How the sanitizer process runs here, decided once (`sanitizerRuntime`). */
export type SanitizerRuntime =
  /** Under `node --permission`, reading only `reads`. */
  | { kind: "confined"; node: string; version: string; reads: string[] }
  /** As this runtime, with every right of this uid: `why` says why. */
  | { kind: "unconfined"; why: string }
  /** Not at all: RYPH_ARTIFACT_SANITIZER_NODE names a node that cannot confine it. */
  | { kind: "unavailable"; why: string };

/**
 * What the confined process reads to load: its own modules, and every npm package they import,
 * both by the path node resolves it through (a `node_modules/<name>` that may be a symlink, whose
 * package.json node reads to resolve it) and by its real path (where it loads the files).
 */
export function sanitizerReads(): string[] {
  const reads = new Set(OWN_MODULES);
  for (const { found, real } of sanitizerPackages()) {
    reads.add(found);
    reads.add(real);
  }
  return [...reads];
}

/** Every npm package the sanitizer's modules import, followed through their dependencies: its
 * name, the `node_modules/<name>` node resolves it through, and its real directory. Each must be
 * one of `SANITIZER_PACKAGES`, which is all the confined process accepts being granted. */
export function sanitizerPackages(): { name: string; found: string; real: string }[] {
  const packages: { name: string; found: string; real: string }[] = [];
  const seen = new Set<string>();
  const follow = (name: string, from: string) => {
    if (!SANITIZER_PACKAGES.includes(name)) {
      throw new Error(`the sanitizer imports ${name}, which SANITIZER_PACKAGES does not list`);
    }
    for (let dir = dirname(from);; dir = dirname(dir)) {
      const found = join(dir, "node_modules", name);
      if (existsSync(join(found, "package.json"))) {
        const real = realpathSync(found);
        packages.push({ name, found, real });
        if (seen.has(real)) return;
        seen.add(real);
        const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        for (const dep of Object.keys(manifest.dependencies ?? {})) {
          follow(dep, join(real, "package.json"));
        }
        return;
      }
      if (dirname(dir) === dir) throw new Error(`the sanitizer's ${name} is not installed`);
    }
  };
  for (const { name, from } of OWN_PACKAGES) follow(name, from);
  return packages;
}

/** The first `name` on PATH that this process may execute, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Run under `node --permission` with nothing granted: its version, and what it still holds. */
const PROBE = `const p = process.permission;
process.stdout.write(JSON.stringify({
  version: process.versions.node,
  held: p && typeof p.has === "function"
    ? ${JSON.stringify([...DENIED_SCOPES, "fs.read"])}.filter((s) => p.has(s))
    : null,
}));`;

/** Whether `node` confines the sanitizer: why not, or its version. */
function probeNode(node: string): { version: string } | { why: string } {
  const probe = spawnSync(node, ["--permission", "-e", PROBE], {
    env: {},
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.error !== undefined) return { why: `${node} did not start: ${probe.error.message}` };
  let said: { version?: unknown; held?: unknown };
  try {
    said = JSON.parse(probe.stdout);
  } catch {
    return { why: `${node} --permission failed: ${probe.stderr.trim().slice(-500)}` };
  }
  const version = String(said.version);
  if (!(Number(version.split(".")[0]) >= MIN_CONFINED_NODE_MAJOR)) {
    return {
      why: `${node} is Node ${version}, whose permission model does not cover the network ` +
        `(${MIN_CONFINED_NODE_MAJOR} and later do)`,
    };
  }
  if (!Array.isArray(said.held)) return { why: `${node} has no permission model (--permission)` };
  if (said.held.length > 0) {
    return { why: `${node} --permission still grants ${said.held.join(", ")}` };
  }
  return { version };
}

const runtimes = new Map<string, SanitizerRuntime>();

/** How the sanitizer process runs here: confined under the node RYPH_ARTIFACT_SANITIZER_NODE
 * names, else under the first node on PATH that confines it, else unconfined (or unavailable,
 * when RYPH_ARTIFACT_SANITIZER_CONFINED=required). Decided once per setting and PATH, since it
 * starts a node to find out. */
export function sanitizerRuntime(): SanitizerRuntime {
  const named = process.env[SANITIZER_NODE_ENV];
  const confined = process.env[SANITIZER_CONFINED_ENV];
  const key = JSON.stringify([named ?? null, confined ?? null, process.env.PATH ?? ""]);
  let runtime = runtimes.get(key);
  if (runtime === undefined) {
    runtime = decideRuntime(named, confined);
    runtimes.set(key, runtime);
  }
  return runtime;
}

function decideRuntime(
  named: string | undefined,
  confined: string | undefined,
): SanitizerRuntime {
  if (confined !== undefined && confined !== "required") {
    return {
      kind: "unavailable",
      why: `${SANITIZER_CONFINED_ENV}=${confined} is not a setting: it is \`required\` or unset`,
    };
  }
  // Set to nothing is a mistake, never "find one on PATH": that could be anything called node.
  if (named !== undefined && named.trim() === "") {
    return {
      kind: "unavailable",
      why: `${SANITIZER_NODE_ENV} is set but empty: name a Node ${MIN_CONFINED_NODE_MAJOR} or ` +
        "later, or unset it",
    };
  }
  const unconfined = (why: string): SanitizerRuntime =>
    confined === "required"
      ? {
        kind: "unavailable",
        why: `${SANITIZER_CONFINED_ENV}=required, and nothing can confine it: ${why}`,
      }
      : {
        kind: "unconfined",
        why: `the artifact sanitizer runs WITHOUT a permission layer: ${why}. It parses ` +
          "untrusted HTML with every right of this process's user (no environment, an empty " +
          `directory, its time and heap budgets still hold). Install Node ${MIN_CONFINED_NODE_MAJOR} ` +
          `or later on PATH, or name one in ${SANITIZER_NODE_ENV}, to run it under node ` +
          "--permission.",
      };
  let reads: string[];
  try {
    reads = sanitizerReads();
  } catch (err) {
    return { kind: "unavailable", why: `the sanitizer's modules: ${String(err)}` };
  }
  const node = named?.trim() ?? onPath("node");
  if (node === null) return unconfined("no node on PATH");
  const probed = probeNode(node);
  if ("why" in probed) {
    if (named === undefined) return unconfined(probed.why);
    return {
      kind: "unavailable",
      why: `${SANITIZER_NODE_ENV}=${named} cannot confine the sanitizer: ${probed.why}`,
    };
  }
  return { kind: "confined", node, version: probed.version, reads };
}

/** The runtime directory a compiled binary unpacked its files in, as its build recorded it. */
function standaloneRuntimeRoot(): string {
  const root = (globalThis as Record<symbol, unknown>)[Symbol.for("ryph.runtimeRoot")];
  if (typeof root !== "string" || root === "") {
    throw new Error("this binary did not record its runtime directory");
  }
  return root;
}

/** The program and arguments that start the sanitizer process, as `runtime` says. */
export function sanitizerCommand(
  budgetMs: number,
  heapMb: number,
  runtime: SanitizerRuntime = sanitizerRuntime(),
): { cmd: string; args: string[] } {
  const tail = [String(budgetMs), String(heapMb)];
  if (runtime.kind === "unavailable") throw new Error(runtime.why);
  if (runtime.kind === "confined") {
    return {
      cmd: runtime.node,
      args: [
        "--permission",
        ...runtime.reads.map((path) => `--allow-fs-read=${path}`),
        `--max-old-space-size=${heapMb}`,
        SANITIZER_PATH,
        ...tail,
        CONFINED_FLAG,
      ],
    };
  }
  // The binary itself: its entry hands the subcommand's arguments to the sanitizer. With an empty
  // environment it cannot find the runtime directory this process unpacked, and must not look
  // for one of its own (that would be the account's, whatever RYPH_HOME or HOME this process
  // runs under), so it is named first (packages/ryph/src/resources.ts, `resourcesRootOrExit`).
  if (STANDALONE) {
    return {
      cmd: process.execPath,
      args: [ARTIFACT_SANITIZER_SUBCOMMAND, standaloneRuntimeRoot(), ...tail],
    };
  }
  // This runtime on the module. Bun would otherwise load a .env from the working directory (an
  // empty one, but nothing is left to chance).
  const flags = process.versions.bun === undefined ? [] : ["--no-env-file"];
  return { cmd: process.execPath, args: [...flags, SANITIZER_PATH, ...tail] };
}

/** One sanitizer process, started on `html`: what it answered, and a way to stop it early. */
export interface SanitizerRun {
  /** Settles once the process has exited. `killed` says the deadline stopped it; a document the
   * deadline or the heap stopped is `too_complex`. Rejects when the platform failed. */
  done: Promise<{ prepared: PreparedHtml; killed: boolean }>;
  /** SIGKILLs it now, whatever it is doing. */
  kill(): void;
}

/** Starts the sanitizer process on `html`, killed at `budgetMs + graceMs`, with an empty
 * environment in an empty directory of its own. Rejects if it cannot be started. */
export async function startSanitizer(
  html: string,
  options: {
    budgetMs: number;
    graceMs: number;
    heapMb: number;
    command: (budgetMs: number, heapMb: number) => { cmd: string; args: string[] };
  },
): Promise<SanitizerRun> {
  const { budgetMs, graceMs, heapMb } = options;
  const { cmd, args } = options.command(budgetMs, heapMb);
  const cwd = await mkdtemp(join(tmpdir(), "ryph-sanitizer-"));
  const cleanUp = () => rm(cwd, { recursive: true, force: true }).catch(() => {});
  let child: Child;
  try {
    child = await command(cmd, {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {},
    }).spawn();
  } catch (err) {
    await cleanUp();
    throw err;
  }
  let deadlineHit = false;
  const sigkill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // It has exited already.
    }
  };
  const deadline = setTimeout(() => {
    deadlineHit = true;
    sigkill();
  }, budgetMs + graceMs);
  // A process that died early refuses the rest of its input: that is its answer's to say.
  const writer = child.stdin.getWriter();
  writer.write(new TextEncoder().encode(html)).then(() => writer.close()).catch(() => {});
  const done = child.output().finally(async () => {
    clearTimeout(deadline);
    await cleanUp();
  }).then((output) => {
    if (deadlineHit) return { prepared: { kind: "too_complex" } as PreparedHtml, killed: true };
    return { prepared: answerOf(output), killed: false };
  });
  return { done, kill: sigkill };
}

export function processArtifactHtml(
  options: {
    budgetMs?: number;
    /** Past the budget, how long the process gets to start; tests shorten it. */
    graceMs?: number;
    heapMb?: number;
    maxInFlight?: number;
    /** The program and its arguments; tests pass one that misbehaves. */
    command?: (budgetMs: number, heapMb: number) => { cmd: string; args: string[] };
    /** Told when a process is killed at its deadline (a page too heavy, or crafted). */
    onKilled?: (owner: string) => void;
    /** Told, once at construction, when this process cannot start the sanitizer: every
     * publish is then refused as `unavailable`. */
    onUnavailable?: (why: string) => void;
    /** Told, once at construction, when the sanitizer will run without a permission layer
     * (`sanitizerRuntime`). Not asked when `command` is given. */
    onUnconfined?: (why: string) => void;
  } = {},
): ArtifactHtmlPreparer & {
  /** How many slots are taken, and by whom: for tests and diagnostics. */
  inFlight(): string[];
} {
  const budgetMs = options.budgetMs ?? DEFAULT_ARTIFACT_HTML_BUDGET_MS;
  const graceMs = options.graceMs ?? STARTUP_GRACE_MS;
  const heapMb = options.heapMb ?? DEFAULT_ARTIFACT_HTML_HEAP_MB;
  const maxInFlight = options.maxInFlight ?? DEFAULT_ARTIFACT_HTML_IN_FLIGHT;
  // The boot check: how the sanitizer would run here, and whether it can.
  let unavailable = false;
  let command = options.command;
  if (command === undefined) {
    const runtime = sanitizerRuntime();
    if (runtime.kind === "unavailable") {
      unavailable = true;
      options.onUnavailable?.(
        `the artifact sanitizer cannot start: ${runtime.why}. Every publish_artifact is ` +
          "refused as unavailable until it can.",
      );
    } else if (runtime.kind === "unconfined") {
      options.onUnconfined?.(runtime.why);
    }
    command = (budget, heap) => sanitizerCommand(budget, heap, runtime);
  }
  const program = command;
  let closed = false;
  /** Every slot taken: reserved, or with a process alive. Keyed by owner. */
  const slots = new Map<string, { stop: () => void }>();

  return {
    inFlight: () => [...slots.keys()],
    reserve(owner) {
      if (closed) return { kind: "busy" };
      if (slots.has(owner)) return { kind: "owner_busy" };
      if (slots.size >= maxInFlight) return { kind: "busy" };
      let started = false;
      let stopped = false;
      // Set once the process runs: SIGKILLs it.
      let kill = () => {};
      const free = () => slots.delete(owner);
      slots.set(owner, {
        stop: () => {
          stopped = true;
          if (started) kill();
          else free();
        },
      });
      const slot: ArtifactHtmlSlot = {
        kind: "slot",
        release() {
          if (!started) free();
        },
        async prepare(html) {
          if (started) throw new Error("a slot prepares one document");
          started = true;
          if (stopped) return { kind: "busy" };
          if (unavailable) {
            free();
            return { kind: "unavailable" };
          }
          let run: SanitizerRun;
          try {
            run = await startSanitizer(html, { budgetMs, graceMs, heapMb, command: program });
          } catch (err) {
            free();
            throw err;
          }
          kill = run.kill;
          // Closed while it was starting.
          if (stopped) kill();
          let result: { prepared: PreparedHtml; killed: boolean };
          try {
            // Resolves once the process has exited: only then is the slot free.
            result = await run.done;
          } finally {
            free();
          }
          if (stopped) return { kind: "busy" };
          if (result.killed) options.onKilled?.(owner);
          return outcomeOf(result.prepared, budgetMs);
        },
      };
      return slot;
    },
    close() {
      closed = true;
      for (const entry of [...slots.values()]) entry.stop();
    },
  };
}

/** What the process answered, or the failure it was. */
function answerOf(output: CommandOutput): PreparedHtml {
  const fullStderr = () => new TextDecoder().decode(output.stderr);
  const stderr = () => fullStderr().trim().slice(-2_000);
  let answer: unknown = null;
  try {
    answer = JSON.parse(new TextDecoder().decode(output.stdout));
  } catch {
    // Read below, with the exit status.
  }
  const kind = isRecord(answer) ? answer.kind : undefined;
  // Past its heap cap V8 stops the worker, or aborts a confined process (whose stderr says so
  // first, before a native stack trace); a process that ran out of memory some other way is the
  // same refusal. So is a process SIGKILLed by anyone but our deadline
  // (that is answered before this): the kernel's OOM killer, when the pod or the machine runs
  // short, is the one that does, on the process that grew.
  if (
    kind === "out_of_memory" ||
    (answer === null &&
      (output.signal === "SIGKILL" || output.code === 137 || /out of memory/i.test(fullStderr())))
  ) {
    return { kind: "too_complex" };
  }
  if (answer === null || kind === "error") {
    // The sanitizer catches everything a document can make it throw, so this is the platform
    // failing (the program did not load, say): never answered as the document's fault.
    const why = isRecord(answer) && kind === "error"
      ? String(answer.error)
      : `exit ${output.code}${output.signal ? ` (${output.signal})` : ""}: ${stderr()}`;
    throw new Error(`the artifact sanitizer failed: ${why}`);
  }
  return validatePrepared(answer);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The refusals a sanitizer may answer, each carrying nothing but its kind. */
const REFUSALS: ReadonlySet<string> = new Set([
  "unsettled",
  "too_deep",
  "too_complex",
  "too_many_attributes",
  "too_many_nodes",
  "too_large",
]);

/** A document's opening up to where <head>'s first child goes, as the serializer writes it: the
 * doctype and comments, then <html> and <head> with their attributes (always double-quoted, a
 * quote in a value escaped), with only comments between them. A name is anything but HTML
 * whitespace (not JS `\s`: a browser keeps U+00A0 or \v in one), `/` and `>` (a browser keeps `a"b`
 * as one), matched lazily up to its `="`.
 *
 * A comment is matched as a browser ends one, not just up to the next `-->`: never `<!-->` or
 * `<!--->` (which a browser ends at once), and never across a `--!>` (which ends it too). A parsed
 * comment's text can hold neither, so the serializer never writes one; one that does would put
 * what follows somewhere this pattern does not see. Anchored at the start only: the preamble is
 * looked for right where it ends. */
const HEAD_OPENING =
  /^(?:<!DOCTYPE [^>]*>|<!--(?!-?>)(?:(?!--!?>)[\s\S])*-->)*<html(?: [^\t\n\f\r />]+?="[^"]*")*>(?:<!--(?!-?>)(?:(?!--!?>)[\s\S])*-->)*<head(?: [^\t\n\f\r />]+?="[^"]*")*>/;

/**
 * What a sanitizer process answered, checked before the core sees it: a known refusal, or a
 * served document whose first child of <head> is the preamble, with string refs. The process is
 * this platform's own code, but it reads hostile input: whatever else it says is a fault, thrown,
 * never stored.
 */
export function validatePrepared(answer: unknown): PreparedHtml {
  if (!isRecord(answer) || typeof answer.kind !== "string") {
    throw new Error("the artifact sanitizer answered something that is not an answer");
  }
  if (REFUSALS.has(answer.kind)) return { kind: answer.kind } as PreparedHtml;
  if (answer.kind !== "ok") {
    throw new Error(`the artifact sanitizer answered an unknown kind: ${answer.kind.slice(0, 40)}`);
  }
  const { served, refs } = answer;
  if (
    typeof served !== "string" || !Array.isArray(refs) ||
    !refs.every((ref) => typeof ref === "string")
  ) {
    throw new Error("the artifact sanitizer answered a document of the wrong shape");
  }
  const opening = HEAD_OPENING.exec(served);
  if (opening === null || !served.startsWith(ARTIFACT_PREAMBLE, opening[0].length)) {
    throw new Error(
      "the artifact sanitizer answered a document without the preamble first in <head>",
    );
  }
  return { kind: "ok", served, refs: refs as string[] };
}

/** The port's answer for a prepared document: the limits it was held to, filled in. */
export function outcomeOf(prepared: PreparedHtml, budgetMs: number): ArtifactHtmlOutcome {
  switch (prepared.kind) {
    case "too_complex":
      return { kind: "too_complex", budgetMs };
    case "too_many_attributes":
      return { kind: "too_many_attributes", max: MAX_TAG_ATTRIBUTES };
    case "too_many_nodes":
      return { kind: "too_many_nodes", max: MAX_TREE_NODES };
    case "too_large":
      return { kind: "too_large", max: MAX_SERIALIZED_LENGTH };
    default:
      return prepared;
  }
}
