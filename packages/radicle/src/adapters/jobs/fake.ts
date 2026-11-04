// An in-memory `JobCli` that behaves like `rad-job` 0.6.0 where the behaviour is surprising —
// so the service's confirm-by-reading-back is tested against the real hazards, not against a
// kinder CLI:
// - `addRun` and `finish` act on the FIRST job for a commit, never a caller's choice
// - `addRun` mints a random uuid
// - `finish` on a uuid the job does not hold succeeds and changes nothing
// - finishing a finished run overwrites its reason
// - `create` refuses a commit the repository does not hold
//
// `node` is the NID every write is signed as; `commits` the commits "in storage".

import type { JobCli, JobRunView, JobView } from "../../ports/jobs.ts";

export interface FakeJobCli extends JobCli {
  /**
   * Adds a job as if another node had created it (a duplicate, arriving by gossip). `ahead`
   * puts it before every existing job — where `rad-job`'s "first job for the commit" finds it.
   */
  inject(job: JobView, opts?: { ahead?: boolean }): void;
  /** Every write, in order, for assertions. */
  readonly writes: Array<{ op: "create" | "run" | "finish"; args: string[] }>;
}

export function fakeJobCli(opts: { node: string; commits: string[] }): FakeJobCli {
  const jobs: JobView[] = [];
  const writes: FakeJobCli["writes"] = [];
  let seq = 0;
  const first = (commit: string) => jobs.find((j) => j.commit === commit);
  const now = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const clone = (job: JobView): JobView => ({ ...job, runs: job.runs.map((r) => ({ ...r })) });

  return {
    writes,
    inject: (job, how) => {
      if (how?.ahead) jobs.unshift(clone(job));
      else jobs.push(clone(job));
    },

    list: () => Promise.resolve(jobs.map(clone)),

    create(_rid, commit) {
      writes.push({ op: "create", args: [commit] });
      if (!opts.commits.includes(commit)) {
        return Promise.reject(new Error(`failed to create a new job for the commit ${commit}`));
      }
      const id = (++seq).toString(16).padStart(40, "c");
      jobs.push({ id, commit, runs: [] });
      return Promise.resolve(id);
    },

    addRun(_rid, commit, log) {
      writes.push({ op: "run", args: [commit, log] });
      const job = first(commit);
      if (job === undefined) {
        return Promise.reject(new Error(`no job was found for the commit ${commit}`));
      }
      const uuid = crypto.randomUUID();
      job.runs.push({ node: opts.node, uuid, log, status: "started", at: now() });
      return Promise.resolve(uuid);
    },

    finish(_rid, commit, uuid, reason) {
      writes.push({ op: "finish", args: [commit, uuid, reason] });
      const job = first(commit);
      if (job === undefined) {
        return Promise.reject(new Error(`no job was found for the commit ${commit}`));
      }
      const run: JobRunView | undefined = job.runs.find((r) =>
        r.node === opts.node && r.uuid === uuid
      );
      if (run !== undefined) {
        run.status = reason;
        run.at = now();
      }
      return Promise.resolve();
    },
  };
}
