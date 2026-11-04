// Doubles for checks: an in-memory `CheckStore` (the fast double beside memory_store.ts, held to
// the same contract as the drizzle store by tests/check_store_test.ts), and a launcher the test
// scripts — what `poll` answers per record, and what each container logged.

import {
  type CheckApproval,
  type CheckForgeReport,
  type CheckGitKey,
  type CheckLocalUpload,
  type CheckRequest,
  type CheckResult,
  type CheckSuite,
  SETTLED_RESULT_STATES,
  TERMINAL_SUITE_STATES,
} from "../src/core/check_types.ts";
import { assertLaunchable } from "../src/adapters/check_launcher/shared.ts";
import type { CheckStore } from "../src/ports/check_store.ts";
import { decodeListCursor, encodeListCursor, type TaskStore } from "../src/ports/task_store.ts";
import type {
  CheckContainerState,
  CheckInspection,
  CheckLauncher,
  CheckSpec,
  ImagesAnswer,
} from "../src/ports/check_launcher.ts";

/** `tasks` is what a scoped `listSuites` reads its tasks through; a scoped list without it
 * throws, so a test that leans on scoping says so. */
export function memoryCheckStore(
  tasks?: Pick<TaskStore, "getRun" | "getPatch" | "getTask">,
): CheckStore & {
  suites: Map<string, CheckSuite>;
  requests: Map<string, CheckRequest>;
  reports: Map<string, CheckForgeReport>;
  keys: Map<string, CheckGitKey>;
  results: Map<string, CheckResult>;
  approvals: Map<string, CheckApproval>;
} {
  const suites = new Map<string, CheckSuite>();
  const results = new Map<string, CheckResult>();
  const requests = new Map<string, CheckRequest>();
  const reports = new Map<string, CheckForgeReport>();
  const keys = new Map<string, CheckGitKey>();
  const uploads = new Map<string, CheckLocalUpload>();
  const approvals = new Map<string, CheckApproval>();
  const clone = <T>(v: T): T => structuredClone(v);
  const resultKey = (r: Pick<CheckResult, "suiteId" | "generation" | "name">) =>
    `${r.suiteId}\u0000${r.generation}\u0000${r.name}`;
  const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const identityOf = (
    s: Pick<
      CheckSuite,
      "connectedRepoId" | "commit" | "checksBlob" | "environmentKey" | "inputsKey"
    >,
  ) => [s.connectedRepoId, s.commit, s.checksBlob, s.environmentKey, s.inputsKey].join("\u0000");
  return {
    suites,
    requests,
    reports,
    keys,
    results,
    approvals,
    claimSuite(suite) {
      const standing = [...suites.values()].find((s) => identityOf(s) === identityOf(suite));
      if (standing !== undefined) {
        return Promise.resolve({ suite: clone(standing), created: false });
      }
      suites.set(suite.id, clone(suite));
      return Promise.resolve({ suite: clone(suite), created: true });
    },
    getSuite(id) {
      const s = suites.get(id);
      return Promise.resolve(s ? clone(s) : null);
    },
    findSuiteByIdentity(identity) {
      const s = [...suites.values()].find((s) => identityOf(s) === identityOf(identity));
      return Promise.resolve(s ? clone(s) : null);
    },
    setSuiteRyphChanged(id, ryphChanged) {
      const s = suites.get(id);
      if (s !== undefined && s.ryphChanged === null) s.ryphChanged = ryphChanged;
      return Promise.resolve();
    },
    saveSuiteIf(suite, expected) {
      const stored = suites.get(suite.id);
      if (
        stored === undefined || !expected.states.includes(stored.state) ||
        stored.generation !== expected.generation ||
        (expected.leaseUntil !== undefined && stored.leaseUntil !== expected.leaseUntil) ||
        (expected.version !== undefined && stored.version !== expected.version)
      ) return Promise.resolve(false);
      suites.set(suite.id, {
        ...clone(suite),
        ryphChanged: stored.ryphChanged ?? suite.ryphChanged,
        version: stored.version + 1,
      });
      return Promise.resolve(true);
    },
    listSuitesByState(states, limit = 200, afterId) {
      const matching = [...suites.values()].filter((s) => states.includes(s.state));
      return Promise.resolve(clone(
        afterId === undefined
          ? matching
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
            .slice(0, limit)
          : matching.filter((s) => s.id > afterId).sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit),
      ));
    },
    countSuitesByState(states) {
      return Promise.resolve([...suites.values()].filter((s) => states.includes(s.state)).length);
    },
    listSuitesForCommit(connectedRepoId, commit) {
      return Promise.resolve(clone(
        [...suites.values()].filter((s) =>
          s.connectedRepoId === connectedRepoId && s.commit === commit
        )
          .sort((a, b) => byCreated(b, a)),
      ));
    },
    listSuitesWaitingOn(environmentId) {
      return Promise.resolve(clone(
        [...suites.values()].filter((s) =>
          s.environmentId === environmentId && s.state === "waiting"
        )
          .sort(byCreated),
      ));
    },
    hasUnsettledSuiteOn(environmentId) {
      return Promise.resolve(
        [...suites.values()].some((s) =>
          s.environmentId === environmentId && !TERMINAL_SUITE_STATES.has(s.state)
        ),
      );
    },
    listSuitesByIds(ids) {
      return Promise.resolve(
        clone([...suites.values()].filter((s) => ids.includes(s.id)).sort(byCreated)),
      );
    },
    async listSuites(query) {
      const after = decodeListCursor(query.cursor);
      const asked = (suiteId: string) =>
        [...requests.values()].filter((r) => r.suiteId === suiteId);
      /** Whether a request leads to a task inside the query's scope. */
      const requestVisible = async (r: CheckRequest): Promise<boolean> => {
        if (query.scope === undefined || query.scope.kind === "all") return true;
        if (
          r.kind === "local" && r.userId === query.scope.userId &&
          (r.state === "active" || r.state === "superseded")
        ) return true;
        if (
          (r.kind === "push" || r.kind === "local") &&
          query.scope.writableRepoIds.includes(r.connectedRepoId)
        ) return true;
        if (tasks === undefined) throw new Error("a scoped listSuites needs the task store");
        const taskIds = [];
        for (const runId of [r.runId, r.source.runId]) {
          const run = runId === null ? null : await tasks.getRun(runId);
          if (run !== null) taskIds.push(run.taskId);
        }
        const patch = r.patchId === null ? null : await tasks.getPatch(r.patchId);
        if (patch !== null) taskIds.push(patch.taskId);
        for (const id of taskIds) {
          if (await tasks.getTask(id, query.scope) !== null) return true;
        }
        return false;
      };
      const visible = async (suiteId: string): Promise<boolean> => {
        if (query.scope === undefined || query.scope.kind === "all") return true;
        for (const r of asked(suiteId)) {
          if (await requestVisible(r)) return true;
        }
        return false;
      };
      /** Asked by a request of one of the query's kinds the reader may see. */
      const askedAs = async (suiteId: string, kinds: readonly CheckRequest["kind"][]) => {
        for (const r of asked(suiteId)) {
          if (!kinds.includes(r.kind) || (r.state !== "active" && r.state !== "superseded")) {
            continue;
          }
          if (await requestVisible(r)) return true;
        }
        return false;
      };
      const matching: CheckSuite[] = [];
      for (const s of [...suites.values()].sort((a, b) => byCreated(b, a))) {
        if (
          after !== null &&
          (s.createdAt.localeCompare(after.createdAt) || s.id.localeCompare(after.id)) >= 0
        ) continue;
        if (query.connectedRepoId !== undefined && s.connectedRepoId !== query.connectedRepoId) {
          continue;
        }
        if (query.checksRef !== undefined && s.checksRef !== query.checksRef) continue;
        if (query.states !== undefined && !query.states.includes(s.state)) continue;
        if (query.full && s.definition.partial === true) continue;
        if (query.askedBy !== undefined && !await askedAs(s.id, query.askedBy)) continue;
        if (!await visible(s.id)) continue;
        matching.push(s);
      }
      const page = matching.slice(0, query.limit);
      const last = page.at(-1);
      return {
        suites: clone(page),
        nextCursor: matching.length > query.limit && last !== undefined
          ? encodeListCursor(last)
          : null,
      };
    },
    upsertResults(rows) {
      for (const row of rows) {
        const stored = results.get(resultKey(row));
        if (stored !== undefined && SETTLED_RESULT_STATES.has(stored.state)) continue;
        results.set(resultKey(row), {
          ...clone(row),
          forgeRef: row.forgeRef ?? stored?.forgeRef ?? null,
        });
      }
      return Promise.resolve();
    },
    listResults(suiteId, generation) {
      return Promise.resolve(clone(
        [...results.values()].filter((r) =>
          r.suiteId === suiteId && (generation === undefined || r.generation === generation)
        ).sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name)),
      ));
    },
    listResultsForGenerations(wanted) {
      const keys = new Set(wanted.map((k) => `${k.suiteId}\u0000${k.generation}`));
      return Promise.resolve(clone(
        [...results.values()].filter((r) => keys.has(`${r.suiteId}\u0000${r.generation}`))
          .sort((a, b) => a.suiteId.localeCompare(b.suiteId) || a.name.localeCompare(b.name)),
      ));
    },
    setResultForgeRef(suiteId, generation, name, forgeRef) {
      const stored = results.get(resultKey({ suiteId, generation, name }));
      if (stored !== undefined) stored.forgeRef = forgeRef;
      return Promise.resolve();
    },
    createRequest(request) {
      if (requests.has(request.id)) throw new Error(`duplicate request ${request.id}`);
      requests.set(request.id, clone(request));
      return Promise.resolve();
    },
    getRequest(id) {
      const r = requests.get(id);
      return Promise.resolve(r ? clone(r) : null);
    },
    listPushRequests(connectedRepoId, changeRequest) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) =>
          r.connectedRepoId === connectedRepoId && r.kind === "push" &&
          r.changeRequest === changeRequest
        ).sort(byCreated),
      ));
    },
    saveRequestIf(request, states, expected) {
      const stored = requests.get(request.id);
      if (stored === undefined || !states.includes(stored.state)) return Promise.resolve(false);
      if (expected?.note !== undefined && stored.note !== expected.note) {
        return Promise.resolve(false);
      }
      if (expected?.noteNot !== undefined && stored.note === expected.noteNot) {
        return Promise.resolve(false);
      }
      // Never the end: a renewal that landed since the read stands.
      requests.set(request.id, { ...clone(request), expiresAt: stored.expiresAt });
      return Promise.resolve(true);
    },
    withdrawRequest(id) {
      const stored = requests.get(id);
      if (stored === undefined || (stored.state !== "active" && stored.state !== "pending")) {
        return Promise.resolve(null);
      }
      stored.state = "superseded";
      stored.nextAttemptAt = null;
      return Promise.resolve(clone(stored));
    },
    listPendingRequests(now, limit) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) =>
          r.state === "pending" && (r.nextAttemptAt === null || r.nextAttemptAt <= now)
        ).sort(byCreated).slice(0, limit),
      ));
    },
    listRequestsForSuite(suiteId) {
      return Promise.resolve(
        clone([...requests.values()].filter((r) => r.suiteId === suiteId).sort(byCreated)),
      );
    },
    listRequestsForSuites(suiteIds) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) => r.suiteId !== null && suiteIds.includes(r.suiteId))
          .sort(byCreated),
      ));
    },
    listRequestsForRun(runId) {
      return Promise.resolve(
        clone([...requests.values()].filter((r) => r.runId === runId).sort(byCreated)),
      );
    },
    listRequestsForPatches(patchIds) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) => r.patchId !== null && patchIds.includes(r.patchId))
          .sort(byCreated),
      ));
    },
    listLiveLocalRequests(userId) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) =>
          r.kind === "local" && r.userId === userId &&
          (r.state === "pending" || r.state === "active")
        ).sort(byCreated),
      ));
    },
    listExpiredLocalRequests(now, limit) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) =>
          r.kind === "local" && (r.state === "pending" || r.state === "active") &&
          r.expiresAt !== null && r.expiresAt <= now
        ).sort(byCreated).slice(0, limit),
      ));
    },
    withdrawExpired(id, now) {
      const stored = requests.get(id);
      if (
        stored === undefined || (stored.state !== "active" && stored.state !== "pending") ||
        stored.expiresAt === null || stored.expiresAt > now
      ) return Promise.resolve(null);
      stored.state = "superseded";
      stored.nextAttemptAt = null;
      return Promise.resolve(clone(stored));
    },
    extendRequest(id, expiresAt) {
      const stored = requests.get(id);
      if (stored === undefined || (stored.state !== "active" && stored.state !== "pending")) {
        return Promise.resolve(null);
      }
      stored.expiresAt = expiresAt;
      return Promise.resolve(clone(stored));
    },
    claimApproval(approval) {
      const standing = [...approvals.values()].find((a) =>
        a.connectedRepoId === approval.connectedRepoId &&
        a.changeRequest === approval.changeRequest && a.headSha === approval.headSha
      );
      if (standing) return Promise.resolve({ approval: clone(standing), created: false });
      approvals.set(approval.id, clone(approval));
      return Promise.resolve({ approval: clone(approval), created: true });
    },
    getApproval(id) {
      const row = approvals.get(id);
      return Promise.resolve(row ? clone(row) : null);
    },
    listApprovals(connectedRepoId, changeRequest) {
      return Promise.resolve(
        [...approvals.values()]
          .filter((a) => a.connectedRepoId === connectedRepoId && a.changeRequest === changeRequest)
          .sort((a, b) => byCreated(b, a))
          .map(clone),
      );
    },
    saveApprovalIf(approval, states) {
      const stored = approvals.get(approval.id);
      if (!stored || !states.includes(stored.state)) return Promise.resolve(false);
      approvals.set(approval.id, clone(approval));
      return Promise.resolve(true);
    },
    claimApprovalComment(id, { at, staleBefore, seen }) {
      const stored = approvals.get(id);
      if (
        !stored || stored.state !== "pending" || stored.commentId !== seen ||
        (stored.commentClaimedAt !== null && stored.commentClaimedAt >= staleBefore)
      ) return Promise.resolve(false);
      approvals.set(id, { ...stored, commentClaimedAt: at, updatedAt: at });
      return Promise.resolve(true);
    },
    releaseApprovalComment(id, at) {
      const stored = approvals.get(id);
      if (stored && stored.commentClaimedAt === at) {
        approvals.set(id, { ...stored, commentClaimedAt: null });
      }
      return Promise.resolve();
    },
    recordLocalUpload(upload) {
      if (uploads.has(upload.id)) throw new Error(`duplicate upload ${upload.id}`);
      uploads.set(upload.id, clone(upload));
      return Promise.resolve();
    },
    deleteLocalUpload(id) {
      uploads.delete(id);
      return Promise.resolve();
    },
    countLocalUploadsSince(userId, since) {
      return Promise.resolve(
        [...uploads.values()].filter((u) => u.userId === userId && u.at >= since).length,
      );
    },
    pruneLocalUploads(before) {
      for (const [id, u] of uploads) if (u.at < before) uploads.delete(id);
      return Promise.resolve();
    },
    listRequestsForCommit(connectedRepoId, commit) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) =>
          r.connectedRepoId === connectedRepoId && r.commit === commit
        ).sort(byCreated),
      ));
    },
    countToolRequestsForRun(runId) {
      return Promise.resolve(
        [...requests.values()].filter((r) => r.runId === runId && r.kind === "tool").length,
      );
    },
    listRequestsToTell(limit) {
      return Promise.resolve(clone(
        [...requests.values()].filter((r) => {
          if (r.state !== "active" || r.runId === null || r.suiteId === null) return false;
          const suite = suites.get(r.suiteId);
          return suite !== undefined && TERMINAL_SUITE_STATES.has(suite.state) &&
            (r.reportedGeneration === null || r.reportedGeneration < suite.generation);
        }).sort(byCreated).slice(0, limit),
      ));
    },
    markRequestReported(id, generation) {
      const stored = requests.get(id);
      if (
        stored === undefined ||
        (stored.reportedGeneration !== null && stored.reportedGeneration >= generation)
      ) return Promise.resolve(false);
      stored.reportedGeneration = generation;
      return Promise.resolve(true);
    },
    upsertForgeReport(row) {
      // As the table's check constraint: one asker, never both, never neither.
      if ((row.patchId === null) === (row.requestId === null)) {
        return Promise.reject(new Error(`report ${row.id} must name exactly one asker`));
      }
      const stored = [...reports.values()].find((r) =>
        row.patchId !== null ? r.patchId === row.patchId : r.requestId === row.requestId
      );
      if (stored === undefined) {
        if (reports.has(row.id)) return Promise.reject(new Error(`duplicate report ${row.id}`));
        reports.set(row.id, clone(row));
      } else {
        stored.nextAttemptAt = row.nextAttemptAt;
        stored.updatedAt = row.updatedAt;
        stored.revision++;
      }
      return Promise.resolve();
    },
    getForgeReport(id) {
      const r = reports.get(id);
      return Promise.resolve(r ? clone(r) : null);
    },
    findForgeReport(asker) {
      const r = [...reports.values()].find((r) =>
        "patchId" in asker ? r.patchId === asker.patchId : r.requestId === asker.requestId
      );
      return Promise.resolve(r ? clone(r) : null);
    },
    listForgeReportsForCommit(connectedRepoId, headSha) {
      return Promise.resolve(clone(
        [...reports.values()].filter((r) =>
          r.connectedRepoId === connectedRepoId && r.headSha === headSha
        ).sort(byCreated),
      ));
    },
    listDueForgeReports(now, limit) {
      return Promise.resolve(clone(
        [...reports.values()].filter((r) => r.nextAttemptAt !== null && r.nextAttemptAt <= now)
          .sort((a, b) =>
            a.nextAttemptAt!.localeCompare(b.nextAttemptAt!) || a.id.localeCompare(b.id)
          ).slice(0, limit),
      ));
    },
    touchForgeReports(suite, at) {
      for (const r of reports.values()) {
        const mine = r.suiteId === suite.id ||
          (r.suiteId === null && r.connectedRepoId === suite.connectedRepoId &&
            r.headSha === suite.commit);
        if (!mine) continue;
        r.nextAttemptAt = at;
        r.updatedAt = at;
        r.revision++;
      }
      return Promise.resolve();
    },
    repointForgeReports(fromSuiteId, to, at) {
      for (const r of reports.values()) {
        if (r.suiteId !== fromSuiteId) continue;
        r.suiteId = to.id;
        r.nextAttemptAt = at;
        r.updatedAt = at;
        r.revision++;
      }
      return Promise.resolve();
    },
    settleForgeReport(id, fields, next) {
      const stored = reports.get(id);
      if (stored === undefined) return Promise.resolve();
      const { suiteId, ...rest } = clone(fields);
      Object.assign(stored, rest);
      if (stored.revision === next.readRevision) stored.nextAttemptAt = next.nextAttemptAt;
      if (suiteId !== undefined && stored.suiteId === next.readSuiteId) stored.suiteId = suiteId;
      return Promise.resolve();
    },
    createCheckGitKey(key) {
      keys.set(key.id, clone(key));
      return Promise.resolve();
    },
    getCheckGitKeyByTokenHash(tokenHash) {
      const k = [...keys.values()].find((k) => k.tokenHash === tokenHash);
      return Promise.resolve(k ? clone(k) : null);
    },
    revokeCheckGitKeys(suiteId, generation, at) {
      for (const k of keys.values()) {
        if (k.suiteId === suiteId && k.generation === generation && k.revokedAt === null) {
          k.revokedAt = at;
        }
      }
      return Promise.resolve();
    },
    revokeCheckGitKey(id, at) {
      const k = keys.get(id);
      if (k !== undefined && k.revokedAt === null) k.revokedAt = at;
      return Promise.resolve();
    },
  };
}

/**
 * A launcher the test drives: `launch` records the spec and creates the record; `poll` answers
 * whatever the test scripted for that record (`pending` until it says otherwise); `logs`
 * answers what the test put under `<name>/<container>`.
 */
export function fakeCheckLauncher(opts: {
  kind?: CheckLauncher["kind"];
  /** Throws from `launch` while set; `once`, for the next launch only. */
  failLaunch?: { error: string; once?: boolean } | null;
} = {}) {
  const specs: CheckSpec[] = [];
  const records = new Set<string>();
  const inspections = new Map<string, CheckInspection>();
  const logs = new Map<string, string>();
  const discarded: string[] = [];
  const state = {
    failLaunch: opts.failLaunch ?? null,
    unreachable: false,
    /** What `prepare` answers, or how, per call; every set of images it was asked about is in
     * `prepared`. */
    images: { kind: "ready" } as ImagesAnswer | ((call: number) => ImagesAnswer),
  };
  const prepared: string[][] = [];
  const preparedSince: string[] = [];
  const launcher: CheckLauncher = {
    kind: opts.kind ?? "kubernetes",
    prepare(images, since) {
      prepared.push([...images]);
      preparedSince.push(since);
      const answer = typeof state.images === "function"
        ? state.images(prepared.length)
        : state.images;
      return Promise.resolve(structuredClone(answer));
    },
    launch(spec) {
      // What both real launchers refuse, refused here too: a record name they cannot make.
      try {
        assertLaunchable(spec);
      } catch (err) {
        return Promise.reject(err);
      }
      if (state.failLaunch !== null) {
        const { error, once } = state.failLaunch;
        if (once) state.failLaunch = null;
        return Promise.reject(new Error(error));
      }
      specs.push(structuredClone(spec));
      records.add(spec.name);
      return Promise.resolve();
    },
    poll(name) {
      if (state.unreachable) return Promise.resolve({ kind: "unknown", why: "unreachable" });
      if (!records.has(name)) return Promise.resolve({ kind: "gone" });
      return Promise.resolve(
        structuredClone(inspections.get(name) ?? { kind: "pending", cloneDone: false, why: null }),
      );
    },
    logs(name, container, maxBytes) {
      const text = logs.get(`${name}/${container}`);
      return Promise.resolve(text === undefined ? null : text.slice(-maxBytes));
    },
    discard(name) {
      discarded.push(name);
      records.delete(name);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...records]);
    },
  };
  /** Scripts every check of a record as exited with the given codes (and optional reasons). */
  const finish = (
    name: string,
    exits: Record<string, number | { exitCode: number; reason: string }>,
    at = "2026-01-01T00:05:00.000Z",
  ) => {
    const checks: Record<string, CheckContainerState> = {};
    for (const [check, exit] of Object.entries(exits)) {
      const { exitCode, reason } = typeof exit === "number"
        ? { exitCode: exit, reason: null }
        : exit;
      checks[check] = {
        state: "exited",
        exitCode,
        startedAt: "2026-01-01T00:01:00.000Z",
        finishedAt: at,
        reason,
      };
    }
    inspections.set(name, { kind: "checks", checks, done: true });
  };
  return {
    launcher,
    specs,
    records,
    inspections,
    logs,
    discarded,
    state,
    finish,
    prepared,
    preparedSince,
  };
}
