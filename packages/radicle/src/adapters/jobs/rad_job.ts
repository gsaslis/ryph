// `JobCli` over the `rad-job` binary — the `radicle-job` crate's own CLI, built into the bridge
// image at the revision Radicle Desktop and radicle-explorer pin (images/radicle/Dockerfile).
//
// WHY NOT `rad cob`. Measured against rad 1.10.2 with a throwaway profile:
// - `rad cob show --type xyz.radworks.job` and `rad cob update --type xyz.radworks.job` both
//   fail with "failed to spawn program 'rad-cob-job'": a type `rad` does not know is an
//   EXTERNAL COB, and every read or write of one evaluates it through a `rad-cob-<suffix>`
//   helper that nobody ships.
// - And even with such a helper, `rad cob update` would write the WRONG BYTES: an external
//   action is `{parents, ...flattened}` (heartwood `cob/external.rs`), so the op would be
//   stored as `{"parents":[],"Run":{…}}` — which radicle-job's externally tagged `Action`
//   cannot deserialize. Desktop and explorer would then fail on that op, not us.
// - `rad cob create` writes no identity header in 1.10.2 (see `core/service.ts`), which is what
//   `rad issue open` exists to avoid for issues.
// So every job write goes through `rad-job`, which goes through the crate itself.
//
// What `rad-job` 0.6.0 does, read from `src/bin/rad-job.rs` and confirmed against the binary:
// - `-r <rid> --no-sync list` prints `{count, jobs: [{job_id, oid, runs: [{node_id, runs:
//   [{run_id, status, log, timestamp}]}]}]}`. `status` is `"Started"` or `{"Finished":
//   "Succeeded"|"Failed"}` (serde's external tagging); `timestamp` is milliseconds at second
//   precision. Runs are sorted by uuid, NOT by insertion. A job that fails to load is skipped
//   silently.
// - `new <oid>` prints the new job id. It fails on a commit that is not in storage.
// - `run <oid> <url>` mints a RANDOM v4 uuid — there is no way to pass one — adds the run to the
//   FIRST job `find_by_commit` yields, and prints the uuid. No job for the commit is an error.
// - `succeeded|failed <oid> <uuid>` appends `Finished` to that same first job. A uuid the job
//   does not hold still exits 0 (the op is written and ignored on evaluation), and finishing a
//   finished run overwrites its reason (last op wins) — both measured, both why the service
//   reads before and after every finish.
// - `--no-sync` always: without it the CLI announces through the node itself, and the service's
//   own `announce` is the one place gossip is decided.

import type { RadExec } from "../../ports/rad.ts";
import { RadCommandError } from "../../ports/rad.ts";
import type { JobCli, JobRunView, JobView } from "../../ports/jobs.ts";
import { RefusedError } from "../../core/types.ts";
import { fullOidsIn, isFullOid } from "../../helpers/ids.ts";

/** A listing evaluates every job in the repository, and so does every write, which finds the
 * commit's job the same way: each gets the patience a recache does. */
const JOB_TIMEOUT_MS = 120_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `rad-job` says this when the repository is not in storage — a caller's 404, not a fault. */
const NO_REPO = /failed to open Radicle repository/i;

export function radJobCli(exec: RadExec): JobCli {
  const radJob = async (rid: string, args: string[], label: string) => {
    const out = await exec.radJob(["-r", rid, "--no-sync", ...args], { timeoutMs: JOB_TIMEOUT_MS });
    if (out.code !== 0) {
      if (NO_REPO.test(out.stderr)) {
        throw new RefusedError(`${rid} is not in this node's storage — seed it first`, 404);
      }
      throw new RadCommandError(`rad-job ${label}`, out);
    }
    return out.stdout;
  };

  return {
    async list(rid) {
      return parseJobList(await radJob(rid, ["list"], "list"));
    },

    async create(rid, commit) {
      const stdout = await radJob(rid, ["new", commit], "new");
      const id = fullOidsIn(stdout)[0];
      if (id === undefined) throw new Error(`rad-job new printed no job id: ${stdout.trim()}`);
      return id;
    },

    async addRun(rid, commit, log) {
      const stdout = (await radJob(rid, ["run", commit, log], "run")).trim();
      if (!UUID.test(stdout)) throw new Error(`rad-job run printed no run uuid: ${stdout}`);
      return stdout;
    },

    async finish(rid, commit, uuid, reason) {
      await radJob(rid, [reason, commit, uuid], reason);
    },
  };
}

/**
 * `rad-job list`'s JSON as `JobView`s. Anything that does not have the measured shape is left
 * out rather than guessed at: a run whose status this code does not know is not a run it can
 * report on honestly.
 */
export function parseJobList(stdout: string): JobView[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`rad-job list printed unreadable JSON: ${err}`);
  }
  const jobs = (doc as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) throw new Error("rad-job list printed no `jobs` array");
  const out: JobView[] = [];
  for (const job of jobs as Array<Record<string, unknown>>) {
    if (typeof job?.job_id !== "string" || !isFullOid(job.job_id)) continue;
    if (typeof job.oid !== "string" || !isFullOid(job.oid)) continue;
    const runs: JobRunView[] = [];
    for (const byNode of Array.isArray(job.runs) ? job.runs : []) {
      const node = (byNode as { node_id?: unknown })?.node_id;
      if (typeof node !== "string") continue;
      const nodeRuns = (byNode as { runs?: unknown }).runs;
      for (const run of Array.isArray(nodeRuns) ? nodeRuns : []) {
        const status = statusOf(run?.status);
        if (status === null || typeof run?.run_id !== "string") continue;
        runs.push({
          node,
          uuid: run.run_id,
          log: typeof run.log === "string" ? run.log : null,
          status,
          at: typeof run.timestamp === "number" && Number.isFinite(run.timestamp)
            ? new Date(run.timestamp).toISOString()
            : null,
        });
      }
    }
    out.push({ id: job.job_id, commit: job.oid, runs });
  }
  return out;
}

function statusOf(raw: unknown): JobRunView["status"] | null {
  if (raw === "Started") return "started";
  const finished = (raw as { Finished?: unknown } | null)?.Finished;
  if (finished === "Succeeded") return "succeeded";
  if (finished === "Failed") return "failed";
  return null;
}
