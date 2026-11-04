// The job COB (xyz.radworks.job): ryph's check suites, recorded where Radicle looks for CI.
//
// Three layers, as for the other writes:
// - the PARSER against `rad-job list` output captured from the real binary (radicle-job 0.6.0
//   at 77cf8fb4, against rad 1.10.2 storage);
// - the SERVICE over a fake `rad-job` that keeps the real one's hazards — the first job for a
//   commit wins, a finish of an unknown run exits 0, a finished run can be overwritten — so the
//   find-then-create and the confirm-by-reading-back are tested against them;
// - the real binaries end to end, SKIPPED unless both `rad` and `rad-job` are installed.

import { test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { makeRadicleService, type RadicleService } from "../src/core/service.ts";
import { RefusedError } from "../src/core/types.ts";
import { type FakeJobCli, fakeJobCli } from "../src/adapters/jobs/fake.ts";
import { parseJobList, radJobCli } from "../src/adapters/jobs/rad_job.ts";
import { cliRadExec } from "../src/adapters/rad/cli.ts";
import { bridgeRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { makeServiceGate } from "@ryph/sealed";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import type { NodeControl } from "../src/ports/node.ts";
import type { ExecOptions, ExecResult, RadExec } from "../src/ports/rad.ts";
import { initRepo, makePeer, radBinDir } from "./util.ts";

const RID = "rad:z4DoHXJpHyYEuWc2ZdKnv6Zt3ST2q";
const NID = "z6Mkh43TjdiLSWRJ99vbpdrSkLZ9QDZDZx3kovn91QHQ8Dgk";
const OTHER = "z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
const COMMIT = "057ab368c82d0aa8ebf33e3e1d6981942ebb1cc3";
const ABSENT = "1234567890123456789012345678901234567890";
const LOG = "https://ryph.test/checks/cs-0123456789?generation=1";

// ── the parser, against captured output ──────────────────────────────────────────────────

/** `rad-job -r <rid> --no-sync list`, verbatim — two jobs for one commit, runs sorted by uuid. */
const CAPTURED_LIST = `{
  "count": 2,
  "jobs": [
    {
      "job_id": "2b1d66cbeee1b1a364d60d73d278c282cbc00136",
      "oid": "057ab368c82d0aa8ebf33e3e1d6981942ebb1cc3",
      "runs": [
        {
          "node_id": "z6Mkh43TjdiLSWRJ99vbpdrSkLZ9QDZDZx3kovn91QHQ8Dgk",
          "runs": [
            {
              "run_id": "215e3fbd-0ecf-46b0-ad67-8853b230316b",
              "status": {
                "Finished": "Failed"
              },
              "log": "https://app.test/checks/cs-1?generation=1",
              "timestamp": 1790762827000
            },
            {
              "run_id": "9c7e2592-5e22-4518-a195-03b4aa34dace",
              "status": "Started",
              "log": "urn:ryph:check-suite:cs-1:2",
              "timestamp": 1790762827000
            }
          ]
        }
      ]
    },
    {
      "job_id": "66ff3444c272a60c878aa653b311cc62ef1fca75",
      "oid": "057ab368c82d0aa8ebf33e3e1d6981942ebb1cc3",
      "runs": []
    }
  ]
}`;

test("rad-job's listing reads as jobs, runs per node, and externally tagged statuses", () => {
  const jobs = parseJobList(CAPTURED_LIST);
  assertEquals(jobs.map((j) => j.id), [
    "2b1d66cbeee1b1a364d60d73d278c282cbc00136",
    "66ff3444c272a60c878aa653b311cc62ef1fca75",
  ]);
  assertEquals(jobs[0].commit, COMMIT);
  assertEquals(jobs[0].runs, [
    {
      node: NID,
      uuid: "215e3fbd-0ecf-46b0-ad67-8853b230316b",
      log: "https://app.test/checks/cs-1?generation=1",
      status: "failed",
      at: "2026-09-30T10:07:07.000Z",
    },
    {
      node: NID,
      uuid: "9c7e2592-5e22-4518-a195-03b4aa34dace",
      log: "urn:ryph:check-suite:cs-1:2",
      status: "started",
      at: "2026-09-30T10:07:07.000Z",
    },
  ]);
  assertEquals(jobs[1].runs, []);
});

test("a run whose status this code does not know is left out, never guessed", () => {
  const jobs = parseJobList(JSON.stringify({
    count: 1,
    jobs: [{
      job_id: "a".repeat(40),
      oid: COMMIT,
      runs: [{
        node_id: NID,
        runs: [
          { run_id: "x", status: { Finished: "Cancelled" }, log: "https://x.test", timestamp: 1 },
          { run_id: "y", status: { Finished: "Succeeded" }, log: "https://y.test", timestamp: 1 },
        ],
      }],
    }, { job_id: "not-an-oid", oid: COMMIT, runs: [] }],
  }));
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].runs.map((r) => [r.uuid, r.status]), [["y", "succeeded"]]);
  assertThrows(() => parseJobList("not json"), Error, "unreadable JSON");
});

// ── the CLI adapter's argv ───────────────────────────────────────────────────────────────

function scripted(answers: Record<string, ExecResult>): RadExec & { calls: string[][] } {
  const calls: string[][] = [];
  const out = (code: number, stdout = "", stderr = ""): ExecResult => ({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
  return {
    calls,
    home: "/nowhere",
    socket: "/dev/null",
    storageDir: (rid) => `/nowhere/storage/${rid}`,
    rad: (args) => {
      calls.push(["rad", ...args]);
      if (args[0] === "self" && args[1] === "--did") {
        return Promise.resolve(out(0, `did:key:${NID}\n`));
      }
      return Promise.resolve(out(1, "", "unexpected"));
    },
    git: (_cwd, args) => {
      calls.push(["git", ...args]);
      // `cat-file -e <commit>^{commit}`: present unless it is the one commit the test says isn't.
      return Promise.resolve(out(args.join(" ").includes(ABSENT) ? 128 : 0));
    },
    radJob: (args: string[], _opts?: ExecOptions) => {
      calls.push(["rad-job", ...args]);
      return Promise.resolve(answers[args[3]] ?? out(1, "", "unscripted"));
    },
  };
}

test("every rad-job call names the repo, never syncs on its own, and reads what it prints", async () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const exec = scripted({
    list: ok(CAPTURED_LIST),
    new: ok("2b1d66cbeee1b1a364d60d73d278c282cbc00136\n"),
    run: ok("215e3fbd-0ecf-46b0-ad67-8853b230316b\n"),
    succeeded: ok(""),
  });
  const cli = radJobCli(exec);
  assertEquals((await cli.list(RID)).length, 2);
  assertEquals(await cli.create(RID, COMMIT), "2b1d66cbeee1b1a364d60d73d278c282cbc00136");
  assertEquals(await cli.addRun(RID, COMMIT, LOG), "215e3fbd-0ecf-46b0-ad67-8853b230316b");
  await cli.finish(RID, COMMIT, "215e3fbd-0ecf-46b0-ad67-8853b230316b", "succeeded");
  assertEquals(exec.calls, [
    ["rad-job", "-r", RID, "--no-sync", "list"],
    ["rad-job", "-r", RID, "--no-sync", "new", COMMIT],
    ["rad-job", "-r", RID, "--no-sync", "run", COMMIT, LOG],
    [
      "rad-job",
      "-r",
      RID,
      "--no-sync",
      "succeeded",
      COMMIT,
      "215e3fbd-0ecf-46b0-ad67-8853b230316b",
    ],
  ]);
});

test("a repository rad-job cannot open is the caller's 404, anything else a real failure", async () => {
  const exec = scripted({
    list: {
      code: 1,
      stdout: "",
      stderr: `ERROR: failed to open Radicle repository ${RID}\n`,
      timedOut: false,
    },
    run: { code: 0, stdout: "not a uuid\n", stderr: "", timedOut: false },
  });
  const cli = radJobCli(exec);
  const refused = await assertRejects(() => cli.list(RID), RefusedError);
  assertEquals(refused.status, 404);
  await assertRejects(() => cli.addRun(RID, COMMIT, LOG), Error, "printed no run uuid");
});

// ── the service, over a fake rad-job ─────────────────────────────────────────────────────

function bench(commits = [COMMIT]): {
  service: RadicleService;
  jobs: FakeJobCli;
  exec: RadExec & { calls: string[][] };
  announced: string[];
  lists: { n: number };
} {
  const jobs = fakeJobCli({ node: NID, commits });
  // `rad-job list` reads every job in the repository: how many a write costs is counted.
  const lists = { n: 0 };
  const list = jobs.list.bind(jobs);
  jobs.list = (rid) => {
    lists.n++;
    return list(rid);
  };
  const exec = scripted({});
  const announced: string[] = [];
  const node = {
    announceRefsFor: (rid: string) => {
      announced.push(rid);
      return Promise.resolve({});
    },
  } as unknown as NodeControl;
  const service = makeRadicleService({
    exec,
    node,
    diag: SILENT_DIAGNOSTICS,
    scratchDir: "/nowhere",
    jobs,
  });
  return { service, jobs, exec, announced, lists };
}

test("the first report for a commit creates the job, starts the run, and announces", async () => {
  const { service, jobs, announced } = bench();
  const recorded = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  assertEquals(recorded.created, true);
  assertEquals(recorded.jobCreated, true);
  assertEquals(recorded.status, "started");
  assertEquals(jobs.writes.map((w) => w.op), ["create", "run"]);
  const { node, jobs: listed } = await service.listJobs(RID, COMMIT);
  assertEquals(node, NID);
  assertEquals(listed.length, 1);
  assertEquals(listed[0].id, recorded.jobId);
  assertEquals(listed[0].runs.map((r) => [r.node, r.uuid, r.status, r.log]), [
    [NID, recorded.uuid, "started", LOG],
  ]);
  assertEquals(announced, [RID]);
});

test("a retry with the same log URL is the same run — the log is the idempotency key", async () => {
  const { service, jobs } = bench();
  const first = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  const again = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  assertEquals(again, {
    jobId: first.jobId,
    uuid: first.uuid,
    status: "started",
    created: false,
    jobCreated: false,
  });
  assertEquals(jobs.writes.length, 2, "nothing was written the second time");

  // A new generation is a new log, and a new run on the SAME job.
  const next = await service.recordRun(RID, {
    commit: COMMIT,
    log: LOG.replace("generation=1", "generation=2"),
  });
  assertEquals(next.created, true);
  assertEquals(next.jobCreated, false);
  assertEquals(next.jobId, first.jobId);
  assert(next.uuid !== first.uuid);
});

test("another node's job for the commit is joined, never duplicated", async () => {
  const { service, jobs } = bench();
  const theirs = "e".repeat(40);
  jobs.inject({
    id: theirs,
    commit: COMMIT,
    runs: [{ node: OTHER, uuid: crypto.randomUUID(), log: LOG, status: "succeeded", at: null }],
  });
  // Their run has OUR log URL, and it is still not ours: the key is (our node, log).
  const recorded = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  assertEquals(recorded.jobId, theirs);
  assertEquals(recorded.created, true);
  assertEquals(recorded.jobCreated, false);
  assertEquals(jobs.writes.map((w) => w.op), ["run"]);
});

test("a commit that is not in storage is a 404 and writes nothing", async () => {
  const { service, jobs, announced } = bench([COMMIT]);
  const err = await assertRejects(
    () => service.recordRun(RID, { commit: ABSENT, log: LOG }),
    RefusedError,
  );
  assertEquals(err.status, 404);
  assertEquals(jobs.writes, []);
  assertEquals(announced, []);
});

test("a finish lands once; the same verdict again is a no-op, a different one a 409", async () => {
  const { service, jobs, lists } = bench();
  const run = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  lists.n = 0;
  const finished = await service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "succeeded" });
  assertEquals(finished, { ...run, status: "succeeded", created: false, jobCreated: false });
  assertEquals(lists.n, 2, "one listing to find the run, one to confirm the finish");
  const [job] = (await service.listJobs(RID, COMMIT)).jobs;
  assertEquals(job.runs[0].status, "succeeded");

  const writes = jobs.writes.length;
  lists.n = 0;
  await service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "succeeded" });
  assertEquals(jobs.writes.length, writes, "a repeated finish writes nothing");
  assertEquals(lists.n, 1);

  // rad-job itself would overwrite the verdict (last op wins); the bridge refuses instead.
  const flipped = await assertRejects(
    () => service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "failed" }),
    RefusedError,
  );
  assertEquals(flipped.status, 409);
  assertEquals(jobs.writes.length, writes);
});

test("a suite that settles before its first report is recorded and finished in one call, two listings", async () => {
  const { service, jobs, lists, announced } = bench();
  const done = await service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "failed" });
  assertEquals(done.created, true);
  assertEquals(done.jobCreated, true);
  assertEquals(done.status, "failed");
  assertEquals(jobs.writes.map((w) => w.op), ["create", "run", "finish"]);
  assertEquals(lists.n, 2);
  assertEquals(announced, [RID]);
});

test("a finish rad-job sent to a duplicate job is a 409, not a success and not a retryable 500", async () => {
  const { service, jobs } = bench();
  const run = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  // A duplicate that `find_by_commit` now yields FIRST: `rad-job failed` writes there and exits 0.
  jobs.inject({ id: "0".repeat(40), commit: COMMIT, runs: [] }, { ahead: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const err = await assertRejects(
      () => service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "failed" }),
      RefusedError,
    );
    assertEquals(err.status, 409);
    assertStringIncludes(err.message, "first job");
  }
  const ours = (await service.listJobs(RID, COMMIT)).jobs.find((j) => j.id === run.jobId);
  assertEquals(ours?.runs[0].status, "started");
});

test("a run written and then refused is still announced", async () => {
  const { service, jobs, announced } = bench();
  // A duplicate job gossips in between the run and its finish: the run is created on our job,
  // and the finish lands on the duplicate, which does not hold it.
  const finish = jobs.finish.bind(jobs);
  jobs.finish = (...args) => {
    jobs.inject({ id: "0".repeat(40), commit: COMMIT, runs: [] }, { ahead: true });
    return finish(...args);
  };
  const before = jobs.writes.length;
  const err = await assertRejects(
    () => service.recordRun(RID, { commit: COMMIT, log: LOG, finish: "failed" }),
    RefusedError,
  );
  assertEquals(err.status, 409);
  assert(jobs.writes.length > before, "the run was written");
  assertEquals(announced, [RID]);
});

test("jobs about other commits are not this commit's", async () => {
  const other = "9".repeat(40);
  const { service, jobs } = bench([COMMIT, other]);
  await service.recordRun(RID, { commit: other, log: LOG });
  assertEquals((await service.listJobs(RID, COMMIT)).jobs, []);
  const recorded = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  assertEquals(recorded.jobCreated, true);
  assertEquals(jobs.writes.filter((w) => w.op === "create").length, 2);
});

const LOG_2 = LOG.replace("generation=1", "generation=2");
const LOG_3 = LOG.replace("generation=1", "generation=3");

test("a newer generation finishes the runs it supersedes as failed, in the same call", async () => {
  const { service, jobs, announced } = bench();
  const first = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  const second = await service.recordRun(RID, { commit: COMMIT, log: LOG_2, finish: "succeeded" });
  const writes = jobs.writes.length;
  announced.length = 0;

  const third = await service.recordRun(RID, {
    commit: COMMIT,
    log: LOG_3,
    // The settled one is left as it is; its own log in the list is ignored too.
    supersedes: [LOG, LOG_2, LOG_3],
  });
  assertEquals(third.status, "started");
  assertEquals(jobs.writes.slice(writes).map((w) => [w.op, ...w.args.slice(1)]), [
    ["finish", first.uuid, "failed"],
    ["run", LOG_3],
  ]);
  const runs = (await service.listJobs(RID, COMMIT)).jobs[0].runs;
  assertEquals(runs.map((r) => [r.uuid, r.status]), [
    [first.uuid, "failed"],
    [second.uuid, "succeeded"],
    [third.uuid, "started"],
  ]);
  assertEquals(announced, [RID]);
});

test("existingOnly answers the run that is there and records none that is not", async () => {
  const { service, jobs, announced } = bench();
  assertEquals(
    await service.recordRun(RID, { commit: COMMIT, log: LOG, existingOnly: true }),
    null,
  );
  assertEquals(jobs.writes, []);
  assertEquals(announced, []);

  const run = await service.recordRun(RID, { commit: COMMIT, log: LOG });
  const found = await service.recordRun(RID, { commit: COMMIT, log: LOG, existingOnly: true });
  assertEquals(found, { ...run, created: false, jobCreated: false });
  assertEquals(jobs.writes.length, 2);
});

// ── the routes ───────────────────────────────────────────────────────────────────────────

const TOKEN = "t";

function router(service: RadicleService) {
  const handler = makeRouter(bridgeRoutes({
    service,
    node: {} as NodeControl,
    exec: scripted({}),
    authenticate: makeServiceGate(TOKEN),
    diag: SILENT_DIAGNOSTICS,
    config: {
      exportDir: "/nowhere",
      scratchDir: "/nowhere",
      maxBundleBytes: 1,
      maxUploadPackBytes: 1,
      fetchBeforeAdvertise: false,
      gitFetchTimeoutMs: 1,
      gitFetchFreshMs: 0,
    },
  }));
  return async (method: string, path: string, body?: unknown) => {
    const res = await handler(
      new Request(`http://bridge${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
}

test("the job routes: list by commit, record and finish — and every input checked at the door", async () => {
  const { service } = bench();
  const call = router(service);
  const rid = encodeURIComponent(RID);

  const recorded = await call("POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: LOG });
  assertEquals(recorded.status, 200);
  assertEquals(recorded.body.created, true);

  const listed = await call("GET", `/v1/repos/${rid}/jobs?commit=${COMMIT}`);
  assertEquals(listed.status, 200);
  assertEquals(listed.body.node, NID);
  assertEquals(listed.body.jobs[0].runs[0].uuid, recorded.body.uuid);

  const finished = await call("POST", `/v1/repos/${rid}/jobs/runs`, {
    commit: COMMIT,
    log: LOG,
    finish: "failed",
  });
  assertEquals(finished.status, 200);
  assertEquals(finished.body.uuid, recorded.body.uuid);
  assertEquals(finished.body.status, "failed");

  const none = await call("POST", `/v1/repos/${rid}/jobs/runs`, {
    commit: COMMIT,
    log: LOG_2,
    existingOnly: true,
    supersedes: [LOG],
  });
  assertEquals(none.status, 200);
  assertEquals(none.body, { recorded: false });

  const conflict = await call("POST", `/v1/repos/${rid}/jobs/runs`, {
    commit: COMMIT,
    log: LOG,
    finish: "succeeded",
  });
  assertEquals(conflict.status, 409);

  for (
    const [method, path, body] of [
      ["GET", `/v1/repos/${rid}/jobs`, undefined],
      ["GET", `/v1/repos/${rid}/jobs?commit=abc`, undefined],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: "-o evil" }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: "file:///etc/passwd" }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: "HEAD", log: LOG }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: LOG, finish: "cancelled" }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: LOG, uuid: "chosen" }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: LOG, supersedes: ["-o x"] }],
      ["POST", `/v1/repos/${rid}/jobs/runs`, { commit: COMMIT, log: LOG, existingOnly: "yes" }],
      ["POST", `/v1/repos/not-a-rid/jobs/runs`, { commit: COMMIT, log: LOG }],
    ] as const
  ) {
    const res = await call(method, path, body);
    assertEquals(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
  }
});

// ── the real binaries ────────────────────────────────────────────────────────────────────

/** Where `rad-job` is: beside `rad` (as in the image), or anywhere on PATH. */
function radJobDir(): string | null {
  const candidates = [radBinDir(), ...(process.env.PATH ?? "").split(":")];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      statSync(`${dir}/rad-job`);
      return dir;
    } catch {
      // not here
    }
  }
  return null;
}

const RAD_DIR = radBinDir();
const RAD_JOB_DIR = radJobDir();

test.skipIf(RAD_DIR === null || RAD_JOB_DIR === null)(
  "end to end against rad and rad-job: create, run, finish, and a duplicate job unioned",
  async () => {
    const peer = await makePeer("jobs");
    // One bin dir holding both, the way the image lays them out.
    const bin = await mkdtemp(join(tmpdir(), "ryph-bin-"));
    try {
      await symlink(`${RAD_DIR}/rad`, `${bin}/rad`);
      await symlink(`${RAD_JOB_DIR}/rad-job`, `${bin}/rad-job`);
      const repo = await initRepo(peer);
      const exec = cliRadExec({
        home: peer.home,
        passphrase: "",
        binDir: bin,
        socket: "/dev/null",
      });
      const node = { announceRefsFor: () => Promise.resolve({}) } as unknown as NodeControl;
      const service = makeRadicleService({
        exec,
        node,
        diag: SILENT_DIAGNOSTICS,
        scratchDir: bin,
        jobs: radJobCli(exec),
      });

      const run = await service.recordRun(repo.rid, { commit: repo.head, log: LOG });
      assertEquals(run.jobCreated, true);
      assertEquals(
        (await service.recordRun(repo.rid, { commit: repo.head, log: LOG })).created,
        false,
      );
      await service.recordRun(repo.rid, { commit: repo.head, log: LOG, finish: "succeeded" });

      // A second job for the same commit — what a racing node would have created. A second
      // apart, because COB timestamps have second precision: the same node's identical
      // `Request` within one second IS the same commit, and so the same job (measured).
      await new Promise((r) => setTimeout(r, 1_100));
      const dup = await exec.radJob(["-r", repo.rid, "--no-sync", "new", repo.head]);
      assertEquals(dup.code, 0, dup.stderr);
      const { node: nid, jobs } = await service.listJobs(repo.rid, repo.head);
      assertEquals(nid, peer.nid);
      assertEquals(jobs.length, 2);
      const ours = jobs.find((j) => j.id === run.jobId);
      assertEquals(ours?.runs.map((r) => [r.node, r.uuid, r.status, r.log]), [
        [peer.nid, run.uuid, "succeeded", LOG],
      ]);

      const missing = await assertRejects(
        () => service.recordRun(repo.rid, { commit: ABSENT, log: LOG }),
        RefusedError,
      );
      assertEquals(missing.status, 404);
    } finally {
      await rm(bin, { recursive: true }).catch(() => {});
      await peer.dispose();
    }
  },
);

test("every rad-job call gets the listing's patience, writes included", async () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const exec = scripted({
    list: ok(CAPTURED_LIST),
    new: ok("2b1d66cbeee1b1a364d60d73d278c282cbc00136\n"),
    run: ok("215e3fbd-0ecf-46b0-ad67-8853b230316b\n"),
    failed: ok(""),
  });
  const timeouts: Array<number | undefined> = [];
  const radJob = exec.radJob;
  exec.radJob = (args, opts) => {
    timeouts.push(opts?.timeoutMs);
    return radJob(args, opts);
  };
  const cli = radJobCli(exec);
  await cli.list(RID);
  await cli.create(RID, COMMIT);
  await cli.addRun(RID, COMMIT, LOG);
  await cli.finish(RID, COMMIT, "215e3fbd-0ecf-46b0-ad67-8853b230316b", "failed");
  assertEquals(timeouts.length, 4);
  assertEquals(new Set(timeouts).size, 1);
  assert((timeouts[0] ?? 0) >= 120_000);
});
