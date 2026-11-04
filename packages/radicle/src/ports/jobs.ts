// The job COB (`xyz.radworks.job`, the `radicle-job` crate) behind one port: how a node records
// that it ran something against a commit, and how it finished.
//
// The model, from radicle-job 0.6.0 (`src/lib.rs`): a JOB per commit, created by a `Request
// {oid}` action whose parent is that commit, and per NODE an ordered set of RUNS — `Run {uuid,
// log}` starts one, `Finished {uuid, reason}` ends it as `Succeeded` or `Failed`. A job carries
// no name and no per-check detail; the `log` URL is where a reader goes for that. Every action
// is signed by its author's key and runs are indexed by that key's node id, which is the whole
// attestation: "node z6Mk… recorded Succeeded for commit abc" is verifiable by anyone holding
// the repository.
//
// Two jobs for one commit are normal, not an error: two nodes that each looked for a job, found
// none and created one. Readers union them (radicle-httpd's `jobs_by_commit` does), and so does
// everything above this port.
//
// The shape of the port follows what the one real writer can do, not what the COB could
// express — see `adapters/jobs/rad_job.ts` for the measurements behind each line.

/** One run of one node on one job, as a reader needs it. */
export interface JobRunView {
  /** The node id (bare `z6Mk…`, no `did:key:`) whose key signed the run. */
  node: string;
  uuid: string;
  /** Where the node says the run's detail lives. Null only if the COB held something unparseable. */
  log: string | null;
  status: "started" | "succeeded" | "failed";
  /** When the last action touching this run was made — second precision, as COB timestamps are. */
  at: string | null;
}

/** One job COB. */
export interface JobView {
  /** The COB's object id. */
  id: string;
  /** The commit the job is about. */
  commit: string;
  runs: JobRunView[];
}

export interface JobCli {
  /**
   * Every job in the repository, whatever commit it is about. `rad-job` has no filtered listing
   * — its `show <commit>` answers only the FIRST job for a commit, which is exactly the answer a
   * reader that unions duplicates must not use.
   */
  list(rid: string): Promise<JobView[]>;
  /** Creates a job for `commit` and answers its id. The commit must be in storage. */
  create(rid: string, commit: string): Promise<string>;
  /**
   * Starts a run on A job for `commit` and answers the run's uuid. Which job, and which uuid, are
   * the CLI's choice: it takes the first job it finds for the commit and mints a random v4 uuid.
   * The caller confirms where the run landed by listing again.
   */
  addRun(rid: string, commit: string, log: string): Promise<string>;
  /**
   * Finishes run `uuid` on the first job the CLI finds for `commit`. Silent — exit 0 — when
   * that job has no such run, so the caller confirms by listing again.
   */
  finish(rid: string, commit: string, uuid: string, reason: "succeeded" | "failed"): Promise<void>;
}
