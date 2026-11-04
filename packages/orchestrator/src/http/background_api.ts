// A run's background commands (core/background.ts), both doors:
//
//   PUT  /v1/runs/:id/runner/background/:jobId        runner: the started record      → {id, created}
//   POST /v1/runs/:id/runner/background/:jobId/exit   runner: the exit record          → {id, ended}
//   PUT  /v1/runs/:id/runner/background/:jobId/log    runner: the log, text/plain, once → {id, stored, bytes?}
//   GET  /v1/runs/:id/background                      user: every job, no log body     → {jobs}
//   GET  /v1/runs/:id/background/:jobId/log           user: the stored log, text/plain
//
// Invariants:
// - the runner door takes the run's own bearer for the run in the path, nothing else; an unknown
//   run and a wrong token answer alike. A concluded run takes no write (410), checked here before
//   a body is read and again under the run's row lock where the write lands. A log is written
//   once, and whether it may be is asked before its body is read
// - the job id is held to JOB_ID before it reaches the store or a storage key (400 otherwise)
// - every body is read under a byte cap while it streams: a record's JSON at MAX_RECORD_BYTES, a
//   log at MAX_BACKGROUND_LOG_BYTES (413 over it) and within BACKGROUND_LOG_DEADLINE_MS (408)
// - a log has one writer: an upload claims it under the run's row lock before reading a byte,
//   at most MAX_BACKGROUND_LOGS_IN_FLIGHT per run at once (429), and a second upload racing
//   for the same job is answered 409 unread; a claim is released when its upload stores nothing
// - the user door is the run's read gate, the one its images and its history take: `tasks:read`
//   and a task the caller may read (`tasks:read-all` reads every one); a run the caller cannot
//   read is a 404, exactly as an unknown one
// - a log is the agent's output: served as `text/plain` with sniffing off and a sandbox CSP,
//   never as HTML; the app renders it escaped

import {
  type BackgroundCommand,
  type BackgroundRefusal,
  claimBackgroundLog,
  JOB_ID,
  MAX_BACKGROUND_LOG_BYTES,
  presentBackgroundCommands,
  readBackgroundLog,
  recordBackgroundEnd,
  recordBackgroundStart,
  releaseBackgroundLog,
  storeBackgroundLog,
} from "../core/background.ts";
import { isTerminal } from "../core/lifecycle.ts";
import type { Run } from "../core/types.ts";
import { RunnerBackgroundEndSchema, RunnerBackgroundStartSchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { unauthorized } from "@ryph/sealed";
import { refuseUnless } from "@ryph/auth/gates";
import { runTokenMatches } from "./auth.ts";
import { describeIssues, json, readCappedBytes, type Route, route } from "@ryph/shared/http";
import { scopeFor } from "./scope.ts";
import type { z } from "@zod/zod";

/** Log uploads one run may have reading or storing at once; the next answers 429. Each holds up
 * to 4 MiB here while it is read, so this bounds a run's share of memory. */
export const MAX_BACKGROUND_LOGS_IN_FLIGHT = 2;
/** How long a log's body may take to arrive before the upload is given up and its claim
 * released: a 4 MiB upload inside the cluster takes well under it, and an upload that holds one
 * of the run's in-flight slots by trickling holds it no longer. */
export const BACKGROUND_LOG_DEADLINE_MS = 15_000;

/** A started or exit record's JSON, at most: its tail is 16 KiB, everything else is small. */
export const MAX_RECORD_BYTES = 128 * 1024;

/** A job as the run page reads it. */
export type BackgroundCommandView =
  & Omit<BackgroundCommand, "runId" | "jobId" | "logClaim" | "logClaimedAt" | "logKey">
  & { id: string };

const toView = (
  {
    runId: _runId,
    jobId,
    logClaim: _claim,
    logClaimedAt: _claimedAt,
    logKey: _key,
    ...rest
  }: BackgroundCommand,
): BackgroundCommandView => ({ id: jobId, ...rest });

const REFUSALS: Record<BackgroundRefusal, () => Response> = {
  concluded: () => json(410, { error: "run concluded" }),
  full: () => json(409, { error: "a run keeps at most 64 background commands" }),
  missing: () => json(404, { error: "no such background command" }),
};

export function backgroundRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;
  const background = deps.backgroundStore ?? null;
  const logs = deps.backgroundLogs ?? null;
  const notHere = () => json(503, { error: "background commands are not recorded here" });

  /** The run the runner speaks for, its job id checked, and the run still live — or the refusal.
   * 404 before 401 would confirm which run ids exist; auth failures answer both the same. */
  const runnerJob = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<{ run: Run; jobId: string } | Response> => {
    const run = await store.getRun(params.id);
    if (!run || !(await runTokenMatches(req, run))) return unauthorized();
    if (!JOB_ID.test(params.jobId)) {
      return json(400, { error: "jobId: a background job's id, bg-<n>" });
    }
    if (background === null) return notHere();
    if (isTerminal(run)) return REFUSALS.concluded();
    return { run, jobId: params.jobId };
  };

  const parseRecord = async <T>(
    req: Request,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; res: Response }> => {
    const read = await readCappedBytes(req, MAX_RECORD_BYTES);
    if (!read.ok) {
      return { ok: false, res: json(413, { error: `at most ${MAX_RECORD_BYTES} bytes` }) };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return { ok: false, res: json(400, { error: "body is not valid JSON" }) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, res: json(400, { error: describeIssues(parsed.error) }) };
    }
    return { ok: true, data: parsed.data };
  };

  const started = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const job = await runnerJob(req, params);
    if (job instanceof Response) {
      await req.body?.cancel().catch(() => {});
      return job;
    }
    const body = await parseRecord(req, RunnerBackgroundStartSchema);
    if (!body.ok) return body.res;
    const { id, ...record } = body.data;
    if (id !== undefined && id !== job.jobId) {
      return json(400, { error: "id: not the job in the path" });
    }
    const outcome = await recordBackgroundStart(background!, {
      runId: job.run.id,
      jobId: job.jobId,
      ...record,
    });
    if (typeof outcome === "string") return REFUSALS[outcome]();
    return json(outcome.created ? 201 : 200, { id: job.jobId, created: outcome.created });
  };

  const exited = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const job = await runnerJob(req, params);
    if (job instanceof Response) {
      await req.body?.cancel().catch(() => {});
      return job;
    }
    const body = await parseRecord(req, RunnerBackgroundEndSchema);
    if (!body.ok) return body.res;
    const outcome = await recordBackgroundEnd(background!, job.run.id, job.jobId, body.data);
    if (typeof outcome === "string") return REFUSALS[outcome]();
    return json(200, { id: job.jobId, ended: outcome.ended });
  };

  /**
   * How many log uploads each run has reading or storing in THIS process, held to
   * MAX_BACKGROUND_LOGS_IN_FLIGHT before a claim is asked for — the attachments door's
   * mechanism (runner_api.ts). In memory: the control plane runs as one replica, and a second
   * would give each run that many per replica, still bounded.
   */
  const logsInFlight = new Map<string, number>();
  const logDeadlineMs = deps.backgroundLogDeadlineMs ?? BACKGROUND_LOG_DEADLINE_MS;

  const putLog = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const job = await runnerJob(req, params);
    const refuse = async (res: Response) => {
      await req.body?.cancel().catch(() => {});
      return res;
    };
    if (job instanceof Response) return await refuse(job);
    if (logs === null) return await refuse(notHere());
    const runId = job.run.id;
    const inFlight = logsInFlight.get(runId) ?? 0;
    if (inFlight >= MAX_BACKGROUND_LOGS_IN_FLIGHT) {
      return await refuse(json(429, { error: "too many log uploads in flight for this run" }));
    }
    logsInFlight.set(runId, inFlight + 1);
    try {
      // Before a byte of the body is read: a log for no job, on a run that is over, a second log
      // for a job that has one, or one another upload is writing costs nothing. Only the
      // claimant reads its body and writes the object.
      const claimed = await claimBackgroundLog(background!, runId, job.jobId, deps.now());
      if (claimed === "stored") return await refuse(json(200, { id: job.jobId, stored: false }));
      if (claimed === "busy") {
        return await refuse(json(409, { error: "this job's log is being uploaded", code: "busy" }));
      }
      if (claimed === "running") {
        return await refuse(
          json(409, { error: "a log is taken once the job's exit is recorded", code: "running" }),
        );
      }
      if (typeof claimed === "string") return await refuse(REFUSALS[claimed]());
      let stored = false;
      try {
        const read = await readCappedBytes(
          req,
          MAX_BACKGROUND_LOG_BYTES,
          AbortSignal.timeout(logDeadlineMs),
        );
        if (!read.ok) {
          return read.reason === "timeout"
            ? json(408, { error: `the log did not arrive within ${logDeadlineMs} ms` })
            : json(413, { error: `a log is at most ${MAX_BACKGROUND_LOG_BYTES} bytes (4 MiB)` });
        }
        // Lossy on purpose: what a command printed need not be UTF-8, and a log that cannot be
        // read whole is still worth reading.
        const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
        const outcome = await storeBackgroundLog(
          { store: background!, logs },
          runId,
          job.jobId,
          claimed.claim,
          text,
        );
        if (outcome === "lost") {
          return json(409, {
            error: "this upload's claim on the log was taken as stale",
            code: "lost",
          });
        }
        stored = true;
        return json(200, { id: job.jobId, stored: true, bytes: outcome.bytes });
      } finally {
        // Whatever stopped this upload short gives the claim back, so the runner's retry can
        // take it.
        if (!stored) {
          await releaseBackgroundLog(background!, runId, job.jobId, claimed.claim)
            .catch(() => {});
        }
      }
    } finally {
      const left = (logsInFlight.get(runId) ?? 1) - 1;
      if (left <= 0) logsInFlight.delete(runId);
      else logsInFlight.set(runId, left);
    }
  };

  /** The run, when the caller may read it; otherwise the refusal, a 404 for a run they may not
   * see. The same gate as a run's images (attachments_api.ts) and its grants (scope.ts). */
  const readableRun = async (req: Request, runId: string): Promise<Run | Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const run = await store.getRun(runId);
    const task = run === null
      ? null
      : await store.getTask(run.taskId, await scopeFor(deps, caller, "tasks:read-all"));
    if (!run || task === null) return json(404, { error: "no such run" });
    return run;
  };

  const list = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await readableRun(req, params.id);
    if (run instanceof Response) return run;
    const rows = background === null ? [] : await background.list(run.id);
    return json(200, { jobs: presentBackgroundCommands(rows, run).map(toView) });
  };

  const getLog = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await readableRun(req, params.id);
    if (run instanceof Response) return run;
    if (!JOB_ID.test(params.jobId)) {
      return json(400, { error: "jobId: a background job's id, bg-<n>" });
    }
    const log = background === null || logs === null
      ? null
      : await readBackgroundLog({ store: background, logs }, run.id, params.jobId);
    if (log === null) return json(404, { error: "no log for that background command" });
    return new Response(log, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // What a command printed is the agent's words: never let a browser read it as anything
        // else.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        // Read under a gate decided per request, so never kept for whoever comes next.
        "cache-control": "private, no-cache",
      },
    });
  };

  return [
    route("PUT", "/v1/runs/:id/runner/background/:jobId", started),
    route("POST", "/v1/runs/:id/runner/background/:jobId/exit", exited),
    route("PUT", "/v1/runs/:id/runner/background/:jobId/log", putLog),
    route("GET", "/v1/runs/:id/background", list),
    route("GET", "/v1/runs/:id/background/:jobId/log", getLog),
  ];
}
