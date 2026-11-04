import { z } from "zod";
import { apiCall } from "./call";
import { type Patch, patchSchema, type PatchState, patchWithContextSchema } from "./types";

const patchPageSchema = z.object({
  patches: z.array(patchWithContextSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PatchPage = z.infer<typeof patchPageSchema>;

/** How many patches a page asks for. The server caps this at 100 and defaults to 50. */
export const PATCH_PAGE_SIZE = 50;

/**
 * One page of the approval queue, newest first. A patch per push per run is a table that only
 * grows, and this is the page people leave open — it used to read all of it.
 */
export async function getPatches(
  f = fetch,
  state?: PatchState,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<PatchPage> {
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  params.set("limit", String(opts.limit ?? PATCH_PAGE_SIZE));
  if (opts.cursor) params.set("cursor", opts.cursor);
  return patchPageSchema.parse(await apiCall(f, `/v1/patches?${params}`));
}

/** What a patch's diff is measured against beyond the patch itself; it can move. */
const basisSchema = z.object({
  /** `live` while the patch can still be published, `record` once it is settled. */
  mode: z.enum(["live", "record"]),
  /** The branch the patch lands on. */
  targetRef: z.string(),
  /** The earlier patch whose change request this one is pushed onto. */
  sincePatchId: z.string().nullable(),
});
/** A basis that is there: what `DiffBasis` is when its patch's repo is still in its task. */
export type Basis = z.infer<typeof basisSchema>;

/** What an approval names of the diff it was made looking at: its basis, and the commit the diff
 * was measured from (`PatchDiff.baseSha`), which moves when the branch it lands on does. */
export type ApprovalBasis = (Basis & { baseSha: string }) | null;

const patchDetailSchema = z.object({
  patch: patchWithContextSchema,
  /** Null when the patch's repo has left its task. */
  diffBasis: basisSchema.nullable(),
});
export type PatchDetail = z.infer<typeof patchDetailSchema>;
export type DiffBasis = PatchDetail["diffBasis"];

/** One patch, as a row of the queue carries it, and what its diff is measured from. */
export async function getPatch(f = fetch, id: string): Promise<PatchDetail> {
  return patchDetailSchema.parse(await apiCall(f, `/v1/patches/${encodeURIComponent(id)}`));
}

const patchDiffSchema = basisSchema.extend({
  /** `git diff` of the patch's base against its head, every file in one unified text. */
  diff: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  /** The diff was cut short at a size cap; files past it are missing. */
  truncated: z.boolean(),
  /** When `truncated`, the files the diff leaves out. */
  omitted: z.array(z.string()),
  /** More files are left out than `omitted` names. */
  moreOmitted: z.boolean(),
});
export type PatchDiff = z.infer<typeof patchDiffSchema>;

/** What the patch changes, read out of its bundle. */
export async function getPatchDiff(f = fetch, id: string): Promise<PatchDiff> {
  return patchDiffSchema.parse(await apiCall(f, `/v1/patches/${encodeURIComponent(id)}/diff`));
}

async function patchTransition(
  f: typeof fetch,
  id: string,
  action: string,
  diffBasis?: ApprovalBasis,
  // The hook files the person was shown; the server approves no others.
  hookPaths?: string[],
): Promise<Patch> {
  const res = await apiCall(f, `/v1/patches/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    ...(diffBasis === undefined && hookPaths === undefined
      ? {}
      : { body: JSON.stringify({ diffBasis, hookPaths }) }),
  });
  return z.object({ patch: patchSchema }).parse(res).patch;
}

/**
 * Approves a patch. Given the basis its diff was read against, the approval is refused (409,
 * `diff_basis_moved`) if that has moved since, as approving would publish something else.
 */
export function approvePatch(
  f = fetch,
  id: string,
  diffBasis?: ApprovalBasis,
  hookPaths?: string[],
): Promise<Patch> {
  return patchTransition(f, id, "approve", diffBasis, hookPaths);
}

export function rejectPatch(f = fetch, id: string): Promise<Patch> {
  return patchTransition(f, id, "reject");
}

/** Queues a failed patch again; given a basis, refused as an approval is if it has moved. */
export function retryPatch(f = fetch, id: string, diffBasis?: ApprovalBasis): Promise<Patch> {
  return patchTransition(f, id, "retry", diffBasis);
}
