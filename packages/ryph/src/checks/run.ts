// The flow `ryph checks run` and the MCP server's `run_checks` share: read the repository, ask
// for the suite the pushed way or with a bundle, then follow it to its verdict. Prose, JSON and
// MCP results are each a rendering of what this returns; nothing here prints.
//
// Invariants:
// - one ask per call: the orchestrator answers a repeat of the same commit, base and checks with
//   the request it already has, so a retry after a dropped connection costs nothing
// - the bundle is a temp file, removed whatever the answer
// - a wait never gives up on its own: the server bounds a suite (check timeouts, the request's
//   expiry), and a caller who wants less stops it

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "@std/path";
import { ApiError, UsageError } from "../api/client.ts";
import {
  type AskAnswer,
  type ChecksClient,
  type RequestView,
  type SuiteView,
  TERMINAL_SUITE_STATES,
} from "./api.ts";
import {
  chooseSource,
  createBundle,
  defaultBase,
  normaliseBase,
  readLocalState,
  type SourceChoice,
} from "./git.ts";

/** The refusal code for a pushed ask whose commit is not, or cannot be shown to be, the head of
 * the branch on the forge: the one refusal a bundle answers. */
export const NOT_BRANCH_HEAD = "not-branch-head";

export interface AskOptions {
  cwd: string;
  checks?: string[];
  base?: string;
  repo?: string;
  force?: SourceChoice | null;
}

export interface Asked {
  source: SourceChoice;
  repo: string;
  branch: string;
  commit: string;
  answer: AskAnswer;
  /** Things worth saying that are not errors: a dirty tree. */
  warnings: string[];
}

/** Reads the repository in `cwd` and files the ask. */
export async function askForChecks(client: ChecksClient, opts: AskOptions): Promise<Asked> {
  // A GitLab served under a path prefix has it in https remotes: the deployment's instance says
  // which prefix is not part of the project's path.
  const state = await readLocalState(opts.cwd, { gitlabUrl: await client.gitlabUrl() });
  const repo = opts.repo ?? state.repo;
  if (!repo) {
    throw new UsageError(
      `cannot tell which repo ${state.remote} is from its URL: pass --repo <owner/name|group/sub/project|rad:z…>`,
    );
  }
  const warnings = state.dirty
    ? ["the working tree has uncommitted changes: checks run on the commit, not on them"]
    : [];
  const base = opts.base ? await normaliseBase(opts.cwd, opts.base, state.remotes) : undefined;
  if (base === "") throw new UsageError("--base: a branch name");
  // A --repo other than the one origin names: what origin has says nothing about that repo.
  const otherRepo = opts.repo !== undefined &&
    (state.repo === null || state.repo.toLowerCase() !== opts.repo.toLowerCase());
  let source = await chooseSource(opts.cwd, state, {
    force: opts.force ?? null,
    remoteProvesNothing: repo.startsWith("rad:") || otherRepo,
  });
  const common = {
    repo,
    // The host is the remote's, so it says nothing about a --repo the remote does not name.
    ...(state.host !== null && !otherRepo ? { host: state.host } : {}),
    branch: state.branch,
    ...(base ? { base } : {}),
    ...(opts.checks && opts.checks.length > 0 ? { checks: opts.checks } : {}),
  };
  const asked = (answer: AskAnswer): Asked => ({
    source,
    repo,
    branch: state.branch,
    commit: state.head,
    answer,
    warnings,
  });
  if (source === "pushed") {
    try {
      return asked(await client.askPushed({ ...common, commit: state.head }));
    } catch (err) {
      // The forge's branch is not this commit, or the forge cannot show that it is: it moved
      // since the remote was read, or a forced --push named a commit never pushed. The server
      // refuses rather than check something else, and says so with a code; any other refusal
      // (an archived repo, say) is the answer, and a bundle would only be refused the same way.
      if (!(err instanceof ApiError) || err.code !== NOT_BRANCH_HEAD) throw err;
      if (opts.force === "pushed") {
        throw new ApiError(err.status, `${err.message} (--bundle)`, err.code);
      }
      // Chosen, not asked for: the bundle is the other way to the same suite.
      warnings.push(
        `the forge's ${state.branch} is not ${
          state.head.slice(0, 12)
        }, so it was sent as a bundle instead`,
      );
      source = "bundle";
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "ryph-checks-"));
  try {
    const path = join(dir, "head.bundle");
    await createBundle(opts.cwd, {
      remote: state.remote,
      // The merge-base is taken against the base the person named, else the remote's default as
      // this clone knows it. Only a named base is sent: the server's default is the repo's own.
      base: base ?? await defaultBase(opts.cwd, state.remote),
      branch: state.branch,
      path,
    });
    return asked(await client.askBundle({ ...common, path }));
  } finally {
    await rm(dir, { recursive: true }).catch(() => {});
  }
}

/** Where a wait ended: a suite in its final state, or a request that never got one. */
export type Outcome =
  | { kind: "suite"; suite: SuiteView }
  | { kind: "no-suite"; request: RequestView };

export interface WaitOptions {
  /** Between reads; 3 s by default. */
  intervalMs?: number;
  /** Called on every read that changed something, including the first. */
  onChange?: (now: SuiteView, before: SuiteView | null) => void;
  /** Ends the wait, each read in it included, so it is a hard limit. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Whether an id names a local ask rather than a suite (`mintId("cq")`). */
export const isRequestId = (id: string): boolean => id.startsWith("cq-");

/**
 * Follows a suite or a request until the suite settles. A request is read until it resolves to
 * a suite, or ends without one (refused: no checks file, say; superseded by a newer ask).
 */
export async function waitFor(
  client: ChecksClient,
  id: string,
  opts: WaitOptions = {},
): Promise<Outcome> {
  const interval = opts.intervalMs ?? 3000;
  const sleep = opts.sleep ?? abortableSleep;
  let suiteId = isRequestId(id) ? null : id;
  while (suiteId === null) {
    const { request, suite } = await client.getRequest(id, opts.signal);
    if (suite !== null) {
      suiteId = suite.id;
      break;
    }
    if (request.suiteId !== null) {
      suiteId = request.suiteId;
      break;
    }
    if (request.state !== "pending" && request.state !== "active") {
      return { kind: "no-suite", request };
    }
    await sleep(interval, opts.signal);
  }
  let before: SuiteView | null = null;
  for (;;) {
    const suite = await client.getSuite(suiteId, opts.signal);
    if (before === null || changed(before, suite)) opts.onChange?.(suite, before);
    if (TERMINAL_SUITE_STATES.has(suite.state)) return { kind: "suite", suite };
    before = suite;
    await sleep(interval, opts.signal);
  }
}

function changed(a: SuiteView, b: SuiteView): boolean {
  if (a.state !== b.state || a.generation !== b.generation) return true;
  const states = new Map(a.checks.map((c) => [c.name, c.state]));
  return b.checks.some((c) => states.get(c.name) !== c.state);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The exit code a verdict maps to: 0 passed, 1 failed or error (the code did something wrong),
 * 2 for everything else — cancelled, no suite at all, or still going when the caller stopped
 * waiting. 3 is a usage or configuration error and never comes from a verdict.
 */
export function exitCodeFor(outcome: Outcome | { kind: "pending" }): number {
  if (outcome.kind !== "suite") return 2;
  switch (outcome.suite.state) {
    case "passed":
      return 0;
    case "failed":
    case "error":
      return 1;
    default:
      return 2;
  }
}

/** The suite as a JSON object: what `--json` prints and what an MCP result carries. */
export function summarize(client: ChecksClient, suite: SuiteView) {
  return {
    suiteId: suite.id,
    url: client.suiteUrl(suite.id),
    state: suite.state,
    reason: suite.reason,
    commit: suite.commit,
    base: suite.checksRef,
    generation: suite.generation,
    checks: suite.checks.map((c) => ({ name: c.name, state: c.state, exitCode: c.exitCode })),
  };
}

/** The checks that did not pass, in a settled suite. */
export function failedChecks(suite: SuiteView): SuiteView["checks"] {
  return suite.checks.filter((c) =>
    c.state !== "passed" && c.state !== "queued" && c.state !== "running"
  );
}

/** The last `lines` lines of a text. */
export function tail(text: string, lines: number): string {
  const all = text.replace(/\n+$/, "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}
