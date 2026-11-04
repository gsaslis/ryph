import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type Memory,
  type MemoryAudience,
  type MemoryDetail,
  memoryDetailSchema,
  type MemoryHealth,
  memoryHealthSchema,
  type MemoryIngestStarted,
  memoryIngestStartedSchema,
  type MemoryKind,
  type MemoryProposal,
  memoryProposalSchema,
  memorySchema,
  type MemorySource,
  type MemorySourceDetail,
  memorySourceDetailSchema,
  type MemorySourceKind,
  type MemorySourceMove,
  memorySourceMoveSchema,
  memorySourceSchema,
  type MemorySourceWithdrawal,
  memorySourceWithdrawalSchema,
  type MemoryStatus,
  type MemorySubject,
  type MemorySubjectCount,
  memorySubjectCountSchema,
  type MemoryTrust,
} from "./types";

/** The filters the browse page and the list route agree on; every one optional. */
export type MemoryFilters = {
  /** `org` or `repo:<url>`, the service's spelling. */
  subject?: string;
  /** `all` or `agent:<id>`. */
  audience?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  trust?: MemoryTrust;
  /** Free text — the same full-text search the agent's `memory__search` tool uses. */
  q?: string;
  limit?: number;
  /** How many rows of the same ordering to skip — the service pages by offset. */
  offset?: number;
};

export type CreateMemoryInput = {
  text: string;
  kind: MemoryKind;
  subject: MemorySubject;
  audience?: MemoryAudience;
  pinned?: boolean;
};

export type UpdateMemoryInput = {
  text?: string;
  kind?: MemoryKind;
  subject?: MemorySubject;
  audience?: MemoryAudience;
};

function memoryQuery(filters: MemoryFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "" || value === null) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

export async function getMemories(f = fetch, filters: MemoryFilters = {}): Promise<Memory[]> {
  const res = await apiCall(f, `/v1/memories${memoryQuery(filters)}`);
  return z.object({ memories: z.array(memorySchema) }).parse(res).memories;
}

export async function getMemory(f = fetch, id: string): Promise<MemoryDetail> {
  return memoryDetailSchema.parse(await apiCall(f, `/v1/memories/${encodeURIComponent(id)}`));
}

export async function createMemory(f = fetch, input: CreateMemoryInput): Promise<Memory> {
  return memorySchema.parse(
    await apiCall(f, "/v1/memories", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateMemory(
  f = fetch,
  id: string,
  input: UpdateMemoryInput,
): Promise<Memory> {
  return memorySchema.parse(
    await apiCall(f, `/v1/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

async function memoryAction(f: typeof fetch, id: string, action: string): Promise<Memory> {
  return memorySchema.parse(
    await apiCall(f, `/v1/memories/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
  );
}

export const pinMemory = (f = fetch, id: string) => memoryAction(f, id, "pin");
export const unpinMemory = (f = fetch, id: string) => memoryAction(f, id, "unpin");
export const retireMemory = (f = fetch, id: string) => memoryAction(f, id, "retire");

export async function getMemorySubjects(f = fetch): Promise<MemorySubjectCount[]> {
  const res = await apiCall(f, "/v1/memory/subjects");
  return z.object({ subjects: z.array(memorySubjectCountSchema) }).parse(res).subjects;
}

export async function getMemoryProposals(
  f = fetch,
  status: MemoryProposal["status"] = "pending",
  sourceId?: string,
): Promise<MemoryProposal[]> {
  const params = new URLSearchParams({ status });
  if (sourceId) params.set("source", sourceId);
  const res = await apiCall(f, `/v1/memory-proposals?${params}`);
  return z.object({ proposals: z.array(memoryProposalSchema) }).parse(res).proposals;
}

// ── sources ─────────────────────────────────────────────────────────────────────────────────

export type IngestSourceInput = {
  kind: MemorySourceKind;
  title?: string;
  text?: string;
  locator?: string;
  subject: MemorySubject;
};

export async function getMemorySources(f = fetch): Promise<MemorySource[]> {
  const res = await apiCall(f, "/v1/memory/sources");
  return z.object({ sources: z.array(memorySourceSchema) }).parse(res).sources;
}

export async function getMemorySource(f = fetch, id: string): Promise<MemorySourceDetail> {
  return memorySourceDetailSchema.parse(
    await apiCall(f, `/v1/memory/sources/${encodeURIComponent(id)}`),
  );
}

/** Hands a document to memory: it is admitted at once, and the review batch lands behind the
 * answer while the source shows as ingesting. */
export async function ingestMemorySource(
  f = fetch,
  input: IngestSourceInput,
): Promise<MemoryIngestStarted> {
  return memoryIngestStartedSchema.parse(
    await apiCall(f, "/v1/memory/sources", { method: "POST", body: JSON.stringify(input) }),
  );
}

/** Puts a document's batch and memories under the subject it is really about. */
export async function moveMemorySource(
  f = fetch,
  id: string,
  subject: MemorySubject,
): Promise<MemorySourceMove> {
  return memorySourceMoveSchema.parse(
    await apiCall(f, `/v1/memory/sources/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ subject }),
    }),
  );
}

/** Takes a document back: its batch is rejected, its memories retired, the record removed. */
export async function withdrawMemorySource(
  f = fetch,
  id: string,
): Promise<MemorySourceWithdrawal> {
  return memorySourceWithdrawalSchema.parse(
    await apiCall(f, `/v1/memory/sources/${encodeURIComponent(id)}/withdraw`, { method: "POST" }),
  );
}

export async function acceptMemoryProposal(
  f = fetch,
  id: string,
  edit: UpdateMemoryInput = {},
): Promise<Memory> {
  return memorySchema.parse(
    await apiCall(f, `/v1/memory-proposals/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify(edit),
    }),
  );
}

export async function rejectMemoryProposal(
  f = fetch,
  id: string,
  reason: string,
): Promise<MemoryProposal> {
  return memoryProposalSchema.parse(
    await apiCall(f, `/v1/memory-proposals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  );
}

export const consolidateStatsSchema = z.object({
  screened: z.number(),
  promoted: z.number(),
  merged: z.number(),
  rejected: z.number(),
  held: z.number(),
  /** `introduced` claims left waiting for the run's change to land. */
  awaiting: z.number(),
  judged: z.number(),
  modelFailures: z.number(),
  swept: z.number(),
});
export type ConsolidateStats = z.infer<typeof consolidateStatsSchema>;

export async function consolidateMemory(f = fetch): Promise<ConsolidateStats> {
  return consolidateStatsSchema.parse(
    await apiCall(f, "/v1/memory/consolidate", { method: "POST" }),
  );
}

/** Bulk review: accepts and rejects in one request; what was not pending comes back as skipped. */
export async function resolveMemoryProposals(
  f = fetch,
  input: { accept?: string[]; reject?: string[]; reason?: string },
): Promise<{ accepted: string[]; rejected: string[]; skipped: string[] }> {
  return z
    .object({
      accepted: z.array(z.string()),
      rejected: z.array(z.string()),
      skipped: z.array(z.string()),
    })
    .parse(
      await apiCall(f, "/v1/memory-proposals/resolve", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
}

export async function getMemoryHealth(f = fetch): Promise<MemoryHealth> {
  return memoryHealthSchema.parse(await apiCall(f, "/v1/memory/health"));
}

/**
 * Why the memory surface is not answering, when it is not — the tool surface's four states,
 * one service over, and for the same reason: none of them should replace the page with a 500.
 */
export type MemoryAccessState = "on" | "off" | "forbidden" | "unavailable";

export type MemoryAccess = {
  memoryAccessEnabled: boolean;
  memoryAccessState: MemoryAccessState;
  memories: Memory[];
};

/**
 * A wire contract, not a local name: the memory service sends this code on its disabled surface,
 * as `MEMORY_DISABLED` in @ryph/memory. Duplicated for the reason MCP_DISABLED is.
 */
const MEMORY_DISABLED = "memory_disabled";

export function isMemoryDisabled(e: ApiError): boolean {
  return e.status === 503 && typeof e.body === "object" && e.body !== null &&
    (e.body as { code?: unknown }).code === MEMORY_DISABLED;
}

function foldMemoryFailure(e: unknown): Exclude<MemoryAccessState, "on"> | null {
  if (e instanceof ApiError) {
    if (isMemoryDisabled(e)) return "off";
    if (e.status === 403) return "forbidden";
    if (e.status === 404 || e.status >= 500) return "unavailable";
    return null;
  }
  if (e instanceof TypeError) return "unavailable";
  return null;
}

/** Reads memories for a page `load`, folding "nothing to show, and not this page's fault". */
export async function getMemoryAccess(
  f = fetch,
  filters: MemoryFilters = {},
): Promise<MemoryAccess> {
  try {
    return {
      memoryAccessEnabled: true,
      memoryAccessState: "on",
      memories: await getMemories(f, filters),
    };
  } catch (e) {
    const state = foldMemoryFailure(e);
    if (state === null) throw e;
    return { memoryAccessEnabled: false, memoryAccessState: state, memories: [] };
  }
}
