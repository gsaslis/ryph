// The world landing_test.ts and patch_lines_test.ts share: a clone on a change request against a
// throwaway origin, the shipper over the real git transport, and the merges the cases build on.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "@std/assert";
import {
  cloneState,
  defaultLine,
  type LineState,
  makeShipper,
  type ShipperDeps,
} from "../../src/core/patches.ts";
import type { PatchPayload, RepoEntry } from "../../src/core/types.ts";
import type { PatchReport, PatchReporter } from "../../src/ports/patch_reporter.ts";
import type { GitTransport } from "../../src/ports/git_transport.ts";
import { cliGitTransport } from "../../src/adapters/git/cli.ts";
import { noopDiagnostics } from "../../src/adapters/diagnostics/noop.ts";
import { git } from "../../src/helpers/git_exec.ts";
import { createBranch, headSha } from "../../src/helpers/checkout.ts";
import { makeThrowawayOrigin, type ThrowawayOrigin } from "./origin.ts";
import { removeTree } from "./remove_tree.ts";
import { repoEntry } from "../util.ts";

export const CR = "feature/x";
export const IDENTITY = ["-c", "user.name=ada", "-c", "user.email=ada@runner.local"];

/** Runs `step` in a scratch clone of the origin, as somebody else working upstream would. */
export async function upstream(originUrl: string, step: (work: string) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "runner-upstream-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await git(work, "config", "user.name", "m");
    await git(work, "config", "user.email", "m@test.local");
    await step(work);
  } finally {
    await removeTree(work);
  }
}

export async function commitFile(dir: string, file: string, content: string, subject: string) {
  await writeFile(`${dir}/${file}`, content);
  await git(dir, "add", "-A");
  await git(dir, ...IDENTITY, "commit", "--quiet", "-m", subject);
}

/** The forge merging the change request: what the run pushed onto it lands on main squashed
 * (or, with `style: "merge"`, under a merge commit; with `style: "rebase"`, replayed as new
 * commits), and the head branch is deleted, as GitHub's auto-delete does. */
export async function mergeAndDelete(
  originUrl: string,
  runBranch: string,
  style: "squash" | "merge" | "rebase" = "squash",
) {
  await upstream(originUrl, async (work) => {
    await git(work, "checkout", "--quiet", "main");
    if (style === "squash") {
      await git(work, "merge", "--squash", `origin/${runBranch}`);
      await git(work, "commit", "--quiet", "-m", "Merge #7 (squashed)");
    } else if (style === "merge") {
      await git(work, "merge", "--quiet", "--no-ff", "-m", "Merge #7", `origin/${runBranch}`);
    } else {
      await git(work, "checkout", "--quiet", "-b", "replay", `origin/${runBranch}`);
      await git(work, "rebase", "--quiet", "--force-rebase", "main");
      await git(work, "checkout", "--quiet", "main");
      await git(work, "merge", "--quiet", "--ff-only", "replay");
    }
    await git(work, "push", "--quiet", "origin", "main", `:${CR}`);
  });
}

function recordingReporter() {
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({
        patchId: `p-${reports.length}`,
        state: report.requiresApproval === true ? "pending_approval" : "queued",
        url: null,
      });
    },
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  return { reporter, reports };
}

/** The plain transport, with every `fetchBase` recorded by the ref it was asked for — the one
 * argument a landing's fetch turns on — and failable on demand: as a gateway still serving the
 * old grant does (a 502 another try may clear), and, with `push`, at the bundle's upload. */
function recordingTransport() {
  const real = cliGitTransport(noopDiagnostics());
  const asked: Array<string | undefined> = [];
  let failNext = 0;
  let failPushes = 0;
  let held: Promise<void> | null = null;
  const transport: GitTransport = {
    ...real,
    async fetchBase(from, repo, ref) {
      asked.push(ref);
      if (held !== null) {
        const wait = held;
        held = null;
        await wait;
      }
      if (failNext > 0) {
        failNext--;
        throw new Error(`the gateway answered 502 for ${ref ?? repo.ref}`);
      }
      return await real.fetchBase(from, repo, ref);
    },
    async push(from, repo, opts) {
      if (failPushes > 0) {
        failPushes--;
        throw new Error("the gateway answered 503");
      }
      return await real.push(from, repo, opts);
    },
  };
  return {
    transport,
    asked,
    failNext: (n: number) => (failNext = n),
    failPushes: (n: number) => (failPushes = n),
    /** Holds the next fetch until the answer is called. */
    holdNextFetch: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
  };
}

export interface World {
  origin: ThrowawayOrigin;
  clone: LineState;
  dir: string;
  reports: PatchReport[];
  asked: Array<string | undefined>;
  failNext(n: number): void;
  failPushes(n: number): void;
  holdNextFetch(): () => void;
  shipper: ReturnType<typeof makeShipper>;
  sleeps: number[];
  clock: { now: number };
  cleanup(): Promise<void>;
}

/**
 * A clone checked out on a change request's head (`feature/x`, merging into main) — or, with
 * `onChangeRequest: false`, on main as a run's own work is — with the agent's first commit
 * submitted as generation 1.
 */
export async function world(
  opts: { onChangeRequest?: boolean; files?: Record<string, string> } = {},
) {
  const onChangeRequest = opts.onChangeRequest ?? true;
  const origin = await makeThrowawayOrigin({ files: opts.files });
  const root = await mkdtemp(join(tmpdir(), "runner-landing-"));
  if (onChangeRequest) {
    await upstream(origin.url, async (work) => {
      await git(work, "checkout", "--quiet", "-b", CR);
      await commitFile(work, "cr.txt", "the change request\n", "cr work");
      await git(work, "push", "--quiet", "origin", CR);
    });
  }
  const { transport, asked, failNext, failPushes, holdNextFetch } = recordingTransport();
  const repo: RepoEntry = repoEntry({
    url: origin.url,
    connectedRepoId: "cr-1",
    ...(onChangeRequest ? { ref: CR, targetRef: "main" } : { ref: "main" }),
  });
  const checkout = await transport.clone(repo, `${root}/repo`);
  const dir = checkout.dir;
  await git(dir, "config", "user.name", "ada");
  await git(dir, "config", "user.email", "ada@runner.local");
  await createBranch(git, dir, `${repo.branchNamespace}/work`);
  const clone = defaultLine(cloneState(repo, checkout, await headSha(git, dir)));
  const { reporter, reports } = recordingReporter();
  const sleeps: number[] = [];
  const clock = { now: 1_000_000 };
  const deps: ShipperDeps = {
    git: transport,
    gitExec: git,
    diag: noopDiagnostics(),
    patchReporter: reporter,
    runId: "wi-test",
    subject: () => "leftovers",
    now: () => clock.now,
    sleep: (ms, _signal) => {
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const shipper = makeShipper(deps);
  return {
    origin,
    clone,
    dir,
    reports,
    asked,
    failNext,
    failPushes,
    holdNextFetch,
    shipper,
    sleeps,
    clock,
    async cleanup() {
      await origin.cleanup();
      await removeTree(root);
    },
  } satisfies World;
}

/** Submits the agent's first commit as generation 1 and answers its head. */
export async function shipFirst(w: World): Promise<string> {
  await commitFile(w.dir, "a.txt", "a\n", "add a");
  const first = await w.shipper.submit(w.clone);
  assert(first.kind === "submitted", JSON.stringify(first));
  return first.headSha;
}

/** The merged cue, as the control plane posts it once the merge has landed. */
export function merged(headSha: string, onto: PatchPayload["onto"]): PatchPayload {
  return {
    kind: "patch",
    line: "work",
    patchId: "p-1",
    path: "repo",
    headSha,
    generation: 1,
    state: "merged",
    forgeUrl: "https://github.com/acme/app/pull/7",
    reason: null,
    ...(onto === undefined ? {} : { onto }),
    landedHead: headSha,
  };
}
