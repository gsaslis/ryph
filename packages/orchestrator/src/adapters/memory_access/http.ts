// `MemoryAccess` over a standalone memory service's internal surface — the adapter that replaces
// `memoryAccess: null` in the networked deployment. The port is the orchestrator's and does not
// change: the single-process host builds the same two methods over @ryph/memory's service
// in-process, and the core cannot tell which it got.
//
// Service-authed with the shared RYPH_MEMORY_TOKEN. Both calls are best-effort at their call
// sites, so both throw on anything but a clean answer and let the caller degrade: a brief that
// could not be composed is a memoryless run, never a failed one.

import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { ComposedBrief, MemoryAccess } from "../../ports/memory_access.ts";

export interface HttpMemoryAccessOptions {
  /** The memory service, as this process dials it; a trailing slash is tolerated. */
  memoryUrl: string;
  /** The shared service credential this process presents. */
  memoryToken: string;
  diag: Diagnostics;
  /** Per-request deadline for the REPORTING calls (outcome, change, stale). Default 10s. */
  requestTimeoutMs?: number;
  /**
   * The brief's own, shorter deadline. Default 3s: composing a brief sits on the task-creation
   * path, where the caller is a person waiting on a 201, and the brief is best-effort by
   * contract — a slow memory service must cost the run a brief, not ten seconds of its start.
   */
  briefTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BRIEF_TIMEOUT_MS = 3_000;

async function reason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** The evidence limits, as the RUNNER's MemoryBriefSchema enforces them — the same numbers, on
 * purpose: this is the last place an entry can be dropped cheaply, and the runner's is the place
 * where one costs a boot. Keep the two in step (packages/runner/src/schema.ts). */
const MAX_EVIDENCE = 1000;
const MAX_PATHS = 50;
const MAX_PATH_LEN = 1024;
const SHA = /^[0-9a-f]{7,64}$/;

/** Is this one evidence entry something the runner will accept? A path is handed to git as a
 * pathspec, so nothing that could read as an option (`-`) or as pathspec magic (`:`, where
 * `:/` alone means the whole repository). */
function evidenceProblem(sha: string, paths: string[]): string | null {
  if (!SHA.test(sha)) return "not a commit sha";
  if (paths.length === 0 || paths.length > MAX_PATHS) return `paths must be 1..${MAX_PATHS}`;
  for (const p of paths) {
    if (p.length === 0 || p.length > MAX_PATH_LEN) return "a path is empty or too long";
    if (p.startsWith("-") || p.startsWith(":")) return `not a path: ${p.slice(0, 64)}`;
  }
  return null;
}

/**
 * The brief body, checked field by field: a malformed answer is refused, never patched.
 *
 * Evidence is the exception, and deliberately: the runner validates the WHOLE spec with one
 * schema, so a single unusable evidence entry frozen onto a run is a run that cannot boot —
 * and, since the offending memory keeps being briefed, every run on that repo after it. So the
 * entries are checked HERE, where a bad one can be dropped and named, and the brief still
 * reaches the run. A dropped entry costs one memory its staleness check; a refused brief would
 * cost the repo its agent.
 */
function parseBrief(
  body: unknown,
  onDropped: (memoryId: string, why: string) => void,
): ComposedBrief | null | undefined {
  if (typeof body !== "object" || body === null || !("brief" in body)) return undefined;
  const brief = (body as { brief: unknown }).brief;
  if (brief === null) return null;
  if (typeof brief !== "object" || brief === null) return undefined;
  const { text, memoryIds, evidence } = brief as {
    text?: unknown;
    memoryIds?: unknown;
    evidence?: unknown;
  };
  if (typeof text !== "string" || !isStrings(memoryIds) || !Array.isArray(evidence)) {
    return undefined;
  }
  const checked: ComposedBrief["evidence"] = [];
  for (const e of evidence) {
    const { memoryId, sha, paths, repo } = (e ?? {}) as Record<string, unknown>;
    if (
      typeof memoryId !== "string" || typeof sha !== "string" || !isStrings(paths) ||
      typeof repo !== "string"
    ) {
      return undefined;
    }
    if (checked.length === MAX_EVIDENCE) {
      onDropped(memoryId, `more than ${MAX_EVIDENCE} evidence entries`);
      continue;
    }
    const problem = evidenceProblem(sha, paths);
    if (problem !== null) {
      onDropped(memoryId, problem);
      continue;
    }
    checked.push({ memoryId, sha, paths, repo });
  }
  return { text, memoryIds, evidence: checked };
}

export function httpMemoryAccess(opts: HttpMemoryAccessOptions): MemoryAccess {
  const base = opts.memoryUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const briefTimeoutMs = opts.briefTimeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${opts.memoryToken}`,
    "content-type": "application/json",
  };

  const call = async (path: string, body: unknown, deadlineMs = timeoutMs): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deadlineMs),
      });
    } catch (err) {
      throw new Error(`memory service unreachable: ${err instanceof Error ? err.message : err}`);
    }
  };

  return {
    async composeBrief({ runId, ...req }) {
      const res = await call(
        `/internal/v1/runs/${encodeURIComponent(runId)}/brief`,
        req,
        briefTimeoutMs,
      );
      if (!res.ok) {
        const why = await reason(res);
        opts.diag.warn("memory_access.brief_failed", { runId, status: res.status, reason: why });
        throw new Error(`memory service refused to compose a brief: ${why}`);
      }
      const brief = parseBrief(
        await res.json().catch(() => null),
        (memoryId, why) =>
          opts.diag.warn("memory_access.evidence_dropped", { runId, memoryId, reason: why }),
      );
      if (brief === undefined) throw new Error("memory service answered a malformed brief");
      return brief;
    },

    async reportOutcome(runId, status) {
      const res = await call(`/internal/v1/runs/${encodeURIComponent(runId)}/outcome`, {
        status,
      });
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("memory_access.outcome_failed", { runId, status: res.status });
        throw new Error(`memory service refused the outcome (HTTP ${res.status})`);
      }
    },

    async reportPatch(runId, patch) {
      const res = await call(`/internal/v1/runs/${encodeURIComponent(runId)}/patches`, patch);
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("memory_access.patch_failed", { runId, status: res.status });
        throw new Error(`memory service refused the patch report (HTTP ${res.status})`);
      }
    },

    async reportChange(runId, patchId, fate, carries) {
      const res = await call(`/internal/v1/runs/${encodeURIComponent(runId)}/change`, {
        patchId,
        fate,
        carries,
      });
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("memory_access.change_failed", { runId, status: res.status });
        throw new Error(`memory service refused the change report (HTTP ${res.status})`);
      }
    },

    async reportStale(runId, stale) {
      const res = await call(`/internal/v1/runs/${encodeURIComponent(runId)}/stale`, { stale });
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("memory_access.stale_failed", { runId, status: res.status });
        throw new Error(`memory service refused the staleness report (HTTP ${res.status})`);
      }
    },
  };
}
