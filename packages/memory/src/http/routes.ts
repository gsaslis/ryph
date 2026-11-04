// The management surface, as a mountable route list — the same trick as the historian and the
// gateway: the Route shape is structurally the orchestrator router's, so the single-process host
// spreads these into its own table and the standalone main.ts serves them on its own listener.
//
// Invariants:
// - browsing, searching and proposing are open to any verified user; writing canon by hand,
//   editing, pinning, retiring, accepting or rejecting a proposal, and running a consolidation
//   pass are ADMIN-ONLY. Break-glass passes everywhere.
// - every response carries the memory's score broken into its terms, because the proposal's
//   promise is that every term is a column the UI can show
// - a refusal about the TEXT (too long, a credential) is a 400 naming why; a store failure is not

import { relativeAge } from "../core/brief.ts";
import { type ScoreBreakdown, scoreMemory } from "../core/score.ts";
import { type MemoryDetail, MemoryRefusedError, type MemoryService } from "../core/service.ts";
import { parseAudienceKey, parseSubjectKey } from "../core/subject.ts";
import type { Memory, MemoryKind, MemoryStatus, Trust } from "../core/types.ts";
import { MEMORY_KINDS, MEMORY_STATUSES, TRUSTS } from "../core/types.ts";
import {
  AcceptProposalSchema,
  BriefPreviewSchema,
  CreateMemorySchema,
  IngestSourceSchema,
  MoveSourceSchema,
  ProposeMemorySchema,
  RejectProposalSchema,
  ResolveProposalsSchema,
  UpdateMemorySchema,
} from "../schema.ts";
import type { Capability } from "@ryph/auth";
import { actorOf, type Authenticate, refuseUnless } from "@ryph/auth/gates";
import { type Handler, json, parseBody, type Route, route } from "@ryph/shared/http";

/** The most a management request may carry: an ingest's two megabytes of text as JSON, with
 * room for the escaping. Counted as it streams — a chunked body announces no length. */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

export type { Handler, Route };

/** Every route answers JSON, a failure included: a refusal about the text is the caller's 400,
 * anything else is a 500 that names nothing — the diag has the cause. */
function guarded(
  routes: Route[],
  diag: MemoryRoutesDeps["diag"],
): Route[] {
  return routes.map((r) => ({
    ...r,
    handler: async (req, params) => {
      try {
        return await r.handler(req, params);
      } catch (err) {
        if (err instanceof MemoryRefusedError) return json(400, { error: err.message });
        diag?.warn("memory.route_failed", {
          method: r.method,
          path: new URL(req.url).pathname,
          err: String(err),
        });
        return json(500, { error: "internal error" });
      }
    },
  }));
}

/** The paths, shared by the live routes and their disabled stand-ins. */
const PATHS = {
  collection: "/v1/memories",
  item: "/v1/memories/:id",
  pin: "/v1/memories/:id/pin",
  unpin: "/v1/memories/:id/unpin",
  retire: "/v1/memories/:id/retire",
  subjects: "/v1/memory/subjects",
  health: "/v1/memory/health",
  preview: "/v1/memory/brief-preview",
  sources: "/v1/memory/sources",
  source: "/v1/memory/sources/:id",
  withdraw: "/v1/memory/sources/:id/withdraw",
  move: "/v1/memory/sources/:id/move",
  backfill: "/v1/memory/embeddings/backfill",
  consolidate: "/v1/memory/consolidate",
  proposals: "/v1/memory-proposals",
  resolve: "/v1/memory-proposals/resolve",
  accept: "/v1/memory-proposals/:id/accept",
  reject: "/v1/memory-proposals/:id/reject",
} as const;

/**
 * The machine-readable marker on a "memory is off" refusal. The VALUE is the contract, not this
 * name: @ryph/app does not import the server packages and carries its own copy.
 */
export const MEMORY_DISABLED = "memory_disabled";

/** A memory as the API answers it: the row plus its score, broken into terms. */
export type PublicMemory = Memory & { score: ScoreBreakdown; age: string };

export function toPublicMemory(memory: Memory, now: Date, relevance = 1): PublicMemory {
  const score = scoreMemory(memory, now, relevance);
  return {
    ...memory,
    score: { ...score, total: Number.isFinite(score.total) ? score.total : -1 },
    age: relativeAge(memory.lastConfirmedAt ?? memory.createdAt, now),
  };
}

export interface MemoryRoutesDeps {
  service: MemoryService;
  /** The host's user-surface gate: a principal means proceed, a Response is the refusal to send. */
  authenticate: Authenticate;
  now(): Date;
  /** Where an unexpected failure is reported before it is answered as a 500. */
  diag?: { warn(event: string, fields?: Record<string, unknown>): void };
}

const MAX_LIST = 200;

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined {
  if (raw === null || raw === "") return undefined;
  const picked = raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
  return picked.length === 0 ? undefined : picked;
}

export function memoryRoutes(deps: MemoryRoutesDeps): Route[] {
  const { service } = deps;

  const gate = async (req: Request, capability: Capability = "memory:read") => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    return refuseUnless(caller, capability) ?? caller;
  };

  const present = (memory: Memory, relevance = 1) => toPublicMemory(memory, deps.now(), relevance);

  const presentDetail = (detail: MemoryDetail) => ({
    ...detail,
    memory: present(detail.memory),
    supersedes: detail.supersedes === null ? null : present(detail.supersedes),
    supersededBy: detail.supersededBy === null ? null : present(detail.supersededBy),
  });

  /** A text refusal is the caller's to fix; anything else is not. */
  const refused = (err: unknown): Response => {
    if (err instanceof MemoryRefusedError) return json(400, { error: err.message });
    throw err;
  };

  const list = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const url = new URL(req.url);
    const subjectRaw = url.searchParams.get("subject");
    const audienceRaw = url.searchParams.get("audience");
    const subject = subjectRaw === null || subjectRaw === "" ? null : parseSubjectKey(subjectRaw);
    if (subjectRaw && subject === null) {
      return json(400, { error: "subject: not org or repo:<url>" });
    }
    const audience = audienceRaw === null || audienceRaw === ""
      ? null
      : parseAudienceKey(audienceRaw);
    if (audienceRaw && audience === null) {
      return json(400, { error: "audience: not all or agent:<id>" });
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
      return json(400, { error: `limit must be an integer between 1 and ${MAX_LIST}` });
    }
    // Offset paging over the store's stable orderings (each ends on the id). A hybrid search
    // re-ranks the same bounded candidate set for every page, so its deepest reachable row is
    // MAX_HYBRID_CANDIDATES; past that a page comes back empty.
    const rawOffset = url.searchParams.get("offset");
    const offset = rawOffset === null || rawOffset === "" ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return json(400, { error: "offset must be a non-negative integer" });
    }
    const q = url.searchParams.get("q")?.trim() || undefined;
    const found = await service.list({
      subjects: subject === null ? undefined : [subject],
      audiences: audience === null ? undefined : [audience],
      kinds: oneOf<MemoryKind>(url.searchParams.get("kind"), MEMORY_KINDS),
      statuses: oneOf<MemoryStatus>(url.searchParams.get("status"), MEMORY_STATUSES),
      trusts: oneOf<Trust>(url.searchParams.get("trust"), TRUSTS),
      query: q,
      matchOnly: q !== undefined,
      limit,
      offset,
    });
    return json(200, {
      memories: found.map(({ memory, relevance }) => present(memory, relevance)),
    });
  };

  const get = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const detail = await service.get(params.id);
    if (detail === null) return json(404, { error: "no such memory" });
    return json(200, presentDetail(detail));
  };

  const create = async (req: Request): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, CreateMemorySchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    try {
      const memory = await service.create(body.data, actorOf(caller));
      return json(201, present(memory));
    } catch (err) {
      return refused(err);
    }
  };

  const update = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, UpdateMemorySchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    try {
      const memory = await service.edit(params.id, body.data, actorOf(caller));
      if (memory === null) return json(404, { error: "no such memory" });
      return json(200, present(memory));
    } catch (err) {
      return refused(err);
    }
  };

  const setPinned = (pinned: boolean): Handler => async (req, params) => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const memory = await service.setPinned(params.id, pinned, actorOf(caller));
    if (memory === null) return json(404, { error: "no such memory" });
    return json(200, present(memory));
  };

  const retire = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const memory = await service.retire(params.id, actorOf(caller));
    if (memory === null) return json(404, { error: "no such memory" });
    return json(200, present(memory));
  };

  const subjects = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    return json(200, { subjects: await service.subjects() });
  };

  const consolidate = async (req: Request): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    return json(200, await service.consolidate());
  };

  const health = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    return json(200, await service.health());
  };

  // The brief a run WOULD get: composed exactly as composeBrief does, recorded nowhere — no
  // scope row, no briefed counters. Open to any verified user: it reads what browsing reads.
  const preview = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, BriefPreviewSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const result = await service.previewBrief(body.data);
    return json(200, {
      brief: result.brief,
      candidates: result.candidates.map((c) => ({
        memory: present(c.memory, c.relevance),
        included: c.included,
      })),
    });
  };

  // Bulk review: accepts and rejects in one request, each resolved on its own — a proposal
  // that is no longer pending is skipped and named, never a reason to fail the batch.
  const resolve = async (req: Request): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, ResolveProposalsSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const actor = actorOf(caller);
    const accepted: string[] = [];
    const rejected: string[] = [];
    const skipped: string[] = [];
    for (const id of body.data.accept) {
      try {
        const memory = await service.acceptProposal(id, actor);
        if (memory === null) skipped.push(id);
        else accepted.push(memory.id);
      } catch (err) {
        if (err instanceof MemoryRefusedError) skipped.push(id);
        else throw err;
      }
    }
    for (const id of body.data.reject) {
      const proposal = await service.rejectProposal(id, actor, body.data.reason);
      if (proposal === null) skipped.push(id);
      else rejected.push(id);
    }
    return json(200, { accepted, rejected, skipped });
  };

  // Ingest: admin-only, like every other way of writing canon by hand — a document becomes a
  // review batch, and the person who handed it over reviews it. A refusal about the document
  // (empty, a credential, a private URL, already on record) is a 400 naming why.
  const ingest = async (req: Request): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, IngestSourceSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    try {
      // Admitted, and the extraction runs on behind the answer: the record is already there
      // to look at, `ingesting` until the batch is in. The promise never rejects (a failure
      // lands on the source); the catch is the guarantee of that, not a handler.
      const { source, done } = await service.ingest(body.data, actorOf(caller));
      done.catch((err) => deps.diag?.warn("memory.ingest_unsettled", { err: String(err) }));
      return json(202, { source });
    } catch (err) {
      return refused(err);
    }
  };

  // One backfill batch on demand — the timer does the rest; this is for a person who just
  // turned embeddings on and wants to see the health page move.
  const backfill = async (req: Request): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    return json(200, await service.backfillEmbeddings());
  };

  const listSources = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    // The text stays behind the detail route: a listing is titles and provenance.
    const sources = await service.listSources(MAX_LIST);
    return json(200, {
      sources: sources.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
    });
  };

  const getSource = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const detail = await service.getSource(params.id);
    if (detail === null) return json(404, { error: "no such source" });
    return json(200, { ...detail, memories: detail.memories.map((m) => present(m)) });
  };

  const withdraw = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const outcome = await service.withdrawSource(params.id, actorOf(caller));
    if (outcome === null) return json(404, { error: "no such source" });
    return json(200, outcome);
  };

  const move = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, MoveSourceSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const outcome = await service.moveSource(params.id, body.data.subject, actorOf(caller));
    if (outcome === null) return json(404, { error: "no such source" });
    return json(200, outcome);
  };

  const listProposals = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const url = new URL(req.url);
    const statuses = oneOf(
      url.searchParams.get("status"),
      [
        "pending",
        "merged",
        "promoted",
        "rejected",
      ] as const,
    );
    const sourceId = url.searchParams.get("source") || undefined;
    const proposals = await service.listProposals(statuses ?? ["pending"], MAX_LIST, sourceId);
    return json(200, { proposals });
  };

  const propose = async (req: Request): Promise<Response> => {
    const caller = await gate(req);
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, ProposeMemorySchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const outcome = await service.proposeAsHuman(
      {
        text: body.data.text,
        kind: body.data.kind ?? "fact",
        subject: body.data.subject ?? { kind: "org" },
        audience: body.data.audience ?? { kind: "all" },
        evidence: body.data.evidence,
      },
      actorOf(caller),
      { via: caller.kind === "user" ? caller.via : undefined },
    );
    if (!outcome.ok) return json(outcome.tooMany ? 429 : 400, { error: outcome.reason });
    return json(201, outcome.proposal);
  };

  const accept = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, AcceptProposalSchema, {
      maxBytes: MAX_BODY_BYTES,
      emptyIs: {},
    });
    if (!body.ok) return body.res;
    try {
      const memory = await service.acceptProposal(params.id, actorOf(caller), body.data);
      if (memory === null) return json(404, { error: "no such pending proposal" });
      return json(200, present(memory));
    } catch (err) {
      return refused(err);
    }
  };

  const reject = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await gate(req, "memory:manage");
    if (caller instanceof Response) return caller;
    const body = await parseBody(req, RejectProposalSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const proposal = await service.rejectProposal(params.id, actorOf(caller), body.data.reason);
    if (proposal === null) return json(404, { error: "no such pending proposal" });
    return json(200, proposal);
  };

  return guarded([
    route("GET", PATHS.collection, list),
    route("POST", PATHS.collection, create),
    route("GET", PATHS.item, get),
    route("PATCH", PATHS.item, update),
    route("POST", PATHS.pin, setPinned(true)),
    route("POST", PATHS.unpin, setPinned(false)),
    route("POST", PATHS.retire, retire),
    route("GET", PATHS.subjects, subjects),
    route("GET", PATHS.health, health),
    route("POST", PATHS.preview, preview),
    route("GET", PATHS.sources, listSources),
    route("POST", PATHS.sources, ingest),
    route("GET", PATHS.source, getSource),
    route("POST", PATHS.withdraw, withdraw),
    route("POST", PATHS.move, move),
    route("POST", PATHS.backfill, backfill),
    route("POST", PATHS.consolidate, consolidate),
    route("GET", PATHS.proposals, listProposals),
    route("POST", PATHS.proposals, propose),
    route("POST", PATHS.resolve, resolve),
    route("POST", PATHS.accept, accept),
    route("POST", PATHS.reject, reject),
  ], deps.diag);
}

/**
 * The same paths when memory is off in this deployment: every one answers 503 with the marker,
 * behind the user gate, so "memory is off" is always an answer and never a 404.
 */
export function disabledMemoryRoutes(
  deps: { authenticate(req: Request): Promise<Response | null> },
): Route[] {
  const off: Handler = async (req) => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(503, {
      error: "memory is not configured on this deployment",
      code: MEMORY_DISABLED,
    });
  };
  return Object.values(PATHS).flatMap((path) => [
    route("GET", path, off),
    route("POST", path, off),
    route("PATCH", path, off),
  ]);
}
