// An in-memory `BackgroundStore`, the fast double beside memory_store.ts — held to the same
// contract as the drizzle store by tests/background_store_test.ts — and an in-memory log store.

import type { BackgroundCommand } from "../src/core/background.ts";
import { isTerminal } from "../src/core/lifecycle.ts";
import type { BackgroundStore } from "../src/ports/background_store.ts";
import type { BuildLogStore } from "../src/ports/build_log_store.ts";
import type { TaskStore } from "../src/ports/task_store.ts";

/** `tasks` is where the run's state is read, as the drizzle store reads it under its lock. */
export function memoryBackgroundStore(
  tasks: Pick<TaskStore, "getRun">,
): BackgroundStore & { rows: Map<string, BackgroundCommand> } {
  const rows = new Map<string, BackgroundCommand>();
  const key = (runId: string, jobId: string) => `${runId}\u0000${jobId}`;
  const live = async (runId: string) => {
    const run = await tasks.getRun(runId);
    return run !== null && !isTerminal(run);
  };
  return {
    rows,
    async start(record, max) {
      if (!(await live(record.runId))) return "concluded";
      if (rows.has(key(record.runId, record.jobId))) return "exists";
      const held = [...rows.values()].filter((r) => r.runId === record.runId).length;
      if (held >= max) return "full";
      rows.set(key(record.runId, record.jobId), {
        ...record,
        endedAt: null,
        reason: null,
        exitCode: null,
        signal: null,
        logBytes: 0,
        logTruncated: false,
        logTail: null,
        hasLog: false,
        logClaim: null,
        logClaimedAt: null,
        logKey: null,
      });
      return "created";
    },
    async end(runId, jobId, record) {
      if (!(await live(runId))) return "concluded";
      const row = rows.get(key(runId, jobId));
      if (row === undefined) return "missing";
      if (row.endedAt !== null) return "already";
      rows.set(key(runId, jobId), { ...row, ...record });
      return "ended";
    },
    async claimLog(runId, jobId, { claim, at, staleBefore }) {
      if (!(await live(runId))) return "concluded";
      const row = rows.get(key(runId, jobId));
      if (row === undefined) return "missing";
      if (row.hasLog) return "stored";
      if (row.endedAt === null) return "running";
      if (row.logClaimedAt !== null && row.logClaimedAt >= staleBefore) return "busy";
      rows.set(key(runId, jobId), { ...row, logClaim: claim, logClaimedAt: at });
      return "claimed";
    },
    releaseLog(runId, jobId, claim) {
      const row = rows.get(key(runId, jobId));
      if (row?.logClaim === claim) {
        rows.set(key(runId, jobId), { ...row, logClaim: null, logClaimedAt: null });
      }
      return Promise.resolve();
    },
    markLog(runId, jobId, claim, { key: logKey, bytes }) {
      const row = rows.get(key(runId, jobId));
      if (row === undefined || row.logClaim !== claim) return Promise.resolve("lost" as const);
      rows.set(key(runId, jobId), {
        ...row,
        hasLog: true,
        logKey,
        logBytes: bytes,
        logClaim: null,
        logClaimedAt: null,
      });
      return Promise.resolve("ok" as const);
    },
    get(runId, jobId) {
      const row = rows.get(key(runId, jobId));
      return Promise.resolve(row === undefined ? null : structuredClone(row));
    },
    list(runId) {
      return Promise.resolve(
        [...rows.values()].filter((r) => r.runId === runId).map((r) => structuredClone(r)),
      );
    },
  };
}

export function memoryLogStore(): BuildLogStore & { logs: Map<string, string>; puts: number } {
  const logs = new Map<string, string>();
  return {
    logs,
    puts: 0,
    put(key, text) {
      this.puts++;
      logs.set(key, text);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(logs.get(key) ?? null);
    },
  };
}
