// Artifacts on the user surface (core/artifacts.ts): the list, one artifact with its versions,
// a version's document as the app frames it, and a delete.
//
//   GET    /v1/artifacts?limit&before                 newest first, `next` to page on
//   GET    /v1/artifacts/:id                          with its versions and who asked for each
//   GET    /v1/artifacts/:id/versions/:n/content      the document, images inlined, sandboxed
//   DELETE /v1/artifacts/:id                          artifacts:manage, or whoever first asked
//
// The runner's publish is its own door (http/runner_api.ts, `POST /v1/runs/:id/artifacts`).
//
// Invariants:
// - visibility is instance-wide: `artifacts:read` sees every live artifact, whatever runs or
//   repos the caller can see. That is the product decision, and the agent editor says so
// - a deleted artifact is gone from every read here: 404, the same as one that never existed
// - the content route answers only with the headers of `ARTIFACT_CONTENT_HEADERS` (and a
//   length and an ETag), and a caller without `artifacts:read` gets the 404 an unknown id gets —
//   never a redirect, never a page that says what exists
// - a served document is made at publish (core/artifacts.ts); serving only fills its image
//   tokens, once per version, at most MAX_CONCURRENT_BUILDS at a time, kept in a bounded cache
//   (`ServedCache`): versions never change, and a delete drops the artifact's entries. Every
//   request still reads the artifact row first, so a delete on another replica takes effect at
//   once there too
// - a 304 answers only an If-None-Match naming this version's ETag exactly

import { can } from "@ryph/auth";
import { createHash } from "node:crypto";
import { ArtifactThumbnails } from "../core/artifact_thumbnails.ts";
import {
  type Artifact,
  ARTIFACT_CONTENT_HEADERS,
  artifactContent,
  artifactEtag,
  artifactUrlOf,
  MAX_ARTIFACT_VERSIONS,
} from "../core/artifacts.ts";
import type { ArtifactCursor, ArtifactStore } from "../ports/artifact_store.ts";
import type { Principal, WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, type Route, route } from "@ryph/shared/http";

/** A page of the list, by default and at most. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** A version number in a path: a positive integer, no sign, no leading zero. */
const VERSION = /^[1-9][0-9]{0,8}$/;

/** The list's cursor as the wire carries it: opaque, but checked when it comes back. */
export function encodeArtifactCursor(c: ArtifactCursor): string {
  return btoa(`${c.updatedAt}\n${c.id}`).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeArtifactCursor(raw: string): ArtifactCursor | null {
  try {
    const text = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const [updatedAt, id, ...rest] = text.split("\n");
    if (rest.length > 0 || !id || Number.isNaN(Date.parse(updatedAt))) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** Whether the caller may read artifacts: break-glass, or the capability. */
export function mayReadArtifacts(caller: Principal): boolean {
  return caller.kind === "break-glass" || can(caller, "artifacts:read");
}

/** Whether the caller may delete `artifact`: an operator (`artifacts:manage`), or the reader who
 * first asked for it while still able to ask for work (`tasks:create`) — a read-only credential,
 * such as a narrowed API token, takes nothing down. */
export function mayDeleteArtifact(caller: Principal, artifact: Artifact): boolean {
  if (caller.kind === "break-glass" || can(caller, "artifacts:manage")) return true;
  return can(caller, "artifacts:read") && can(caller, "tasks:create") &&
    artifact.requestedBy !== null &&
    artifact.requestedBy === caller.userId;
}

/**
 * What a task's page lists of its runs' artifacts: each live artifact any of them created or
 * versioned, oldest first, with only the versions those runs published.
 */
export async function artifactsOfRuns(
  artifacts: ArtifactStore,
  runIds: readonly string[],
): Promise<
  Array<{
    id: string;
    title: string;
    currentVersion: number;
    updatedAt: string;
    versions: Array<{ version: number; runId: string; createdAt: string }>;
  }>
> {
  return (await artifacts.forRuns(runIds)).map(({ artifact, versions }) => ({
    id: artifact.id,
    title: artifact.title,
    currentVersion: artifact.currentVersion,
    updatedAt: artifact.updatedAt,
    versions,
  }));
}

/** How many served documents the cache keeps, and how many bytes, at most. */
const CACHE_ENTRIES = 64;
const CACHE_BYTES = 128 * 1024 * 1024;

/**
 * Served documents by `id@version`, least recently used out first, within CACHE_ENTRIES and
 * CACHE_BYTES. A build already under way is shared, so a burst of frames for one version builds
 * it once.
 */
export class ServedCache {
  #entries = new Map<string, Uint8Array>();
  #bytes = 0;
  #building = new Map<string, Promise<Uint8Array | null>>();

  constructor(readonly maxEntries = CACHE_ENTRIES, readonly maxBytes = CACHE_BYTES) {}

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The cached body, or the one `build` makes (null: nothing to serve, kept uncached). */
  async get(key: string, build: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
    const hit = this.#entries.get(key);
    if (hit !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const pending = this.#building.get(key);
    if (pending !== undefined) return await pending;
    const made = build().finally(() => this.#building.delete(key));
    this.#building.set(key, made);
    const body = await made;
    if (body !== null && body.byteLength <= this.maxBytes) this.#put(key, body);
    return body;
  }

  /** Drops every version of `id`. */
  drop(id: string): void {
    for (const [key, body] of this.#entries) {
      if (key.slice(0, key.lastIndexOf("@")) === id) {
        this.#entries.delete(key);
        this.#bytes -= body.byteLength;
      }
    }
  }

  #put(key: string, body: Uint8Array): void {
    this.#entries.set(key, body);
    this.#bytes += body.byteLength;
    for (const [old, oldBody] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && this.#bytes <= this.maxBytes) break;
      this.#entries.delete(old);
      this.#bytes -= oldBody.byteLength;
    }
  }
}

/** Whether an If-None-Match header names exactly `etag`. Not `*`, and not a weak tag: the 304
 * is for a browser revalidating the very rendering it holds, and nothing else. */
export function noneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((tag) => tag.trim() === etag);
}

/** How many served documents may be built at once, per process. */
const MAX_CONCURRENT_BUILDS = 4;

/** A counting semaphore: at most `max` holders, the rest wait in order. */
export class Semaphore {
  #free: number;
  #waiting: Array<() => void> = [];

  constructor(max: number) {
    this.#free = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      if (next !== undefined) next();
      else this.#free++;
    }
  }
}

export function artifactRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;
  const artifacts = deps.artifacts ?? null;
  const unavailable = () => json(503, { error: "this deployment keeps no artifacts" });
  const served = new ServedCache();
  const thumbnails = artifacts !== null && deps.attachmentStore
    ? new ArtifactThumbnails({
      artifacts,
      store,
      blobs: deps.attachmentStore,
      renderer: deps.artifactThumbnail ?? null,
      warn: (event, detail) => deps.diag.warn(event, detail),
    })
    : null;
  // Building a version reads its images from the object store and holds them, base64'd, in
  // memory: bounded however many frames ask at once.
  const builds = new Semaphore(MAX_CONCURRENT_BUILDS);

  /** Each run's task, for the app's run links (`/tasks/:taskId`); a run gone reads as null. */
  const tasksOf = async (runIds: readonly string[]): Promise<Map<string, string>> =>
    new Map(
      (await store.listRunsByIds([...new Set(runIds)])).map((run) => [run.id, run.taskId]),
    );

  /** The list's and the page's shape of one artifact. */
  const summaries = async (rows: Artifact[]) => {
    const [agents, tasks] = await Promise.all([
      store.listAgentsByIds([...new Set(rows.map((r) => r.agentId))])
        .then((list) => new Map(list.map((a) => [a.id, a]))),
      tasksOf(rows.map((r) => r.originRunId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      currentVersion: row.currentVersion,
      agent: { id: row.agentId, name: agents.get(row.agentId)?.name ?? null },
      originRunId: row.originRunId,
      originTaskId: tasks.get(row.originRunId) ?? null,
      url: artifactUrlOf(deps.config.appUrl, row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  };

  const list = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "artifacts:read");
    if (denied) return denied;
    if (artifacts === null) return unavailable();
    const params = new URL(req.url).searchParams;
    const rawLimit = params.get("limit");
    const limit = rawLimit === null || rawLimit === "" ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return json(400, { error: `limit is a whole number from 1 to ${MAX_LIMIT}` });
    }
    const rawBefore = params.get("before");
    const before = rawBefore === null || rawBefore === "" ? null : decodeArtifactCursor(rawBefore);
    if (rawBefore !== null && rawBefore !== "" && before === null) {
      return json(400, { error: "before is not a cursor this surface issued" });
    }
    // One past the page, to know whether there is another.
    const rows = await artifacts.list({ limit: limit + 1, before });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return json(200, {
      artifacts: await summaries(page),
      next: rows.length > limit && last !== undefined
        ? encodeArtifactCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    });
  };

  const get = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "artifacts:read");
    if (denied) return denied;
    if (artifacts === null) return unavailable();
    const row = await artifacts.get(params.id);
    if (row === null) return json(404, { error: "no such artifact" });
    const [[summary], versions] = await Promise.all([
      summaries([row]),
      artifacts.versions(row.id),
    ]);
    const askers = [
      ...new Set([row.requestedBy, ...versions.map((v) => v.requestedBy)]),
    ].filter((id): id is string => id !== null);
    const names = new Map(
      await Promise.all(
        askers.map(async (id) =>
          [id, deps.identityDirectory ? await deps.identityDirectory.nameFor(id) : null] as const
        ),
      ),
    );
    const person = (id: string | null) => id === null ? null : { id, name: names.get(id) ?? null };
    return json(200, {
      ...summary,
      requestedBy: person(row.requestedBy),
      canDelete: mayDeleteArtifact(caller, row),
      versions: versions.map((v) => ({
        version: v.version,
        title: v.title,
        runId: v.runId,
        taskId: v.taskId,
        requestedBy: person(v.requestedBy),
        bytes: v.bytes,
        createdAt: v.createdAt,
      })),
    });
  };

  const content = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const missing = () =>
      new Response(JSON.stringify({ error: "no such artifact version" }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    // Not a 403: the content route never says what exists to someone who may not read it.
    if (!mayReadArtifacts(caller)) return missing();
    if (artifacts === null) return unavailable();
    if (!VERSION.test(params.n)) return missing();
    const version = Number(params.n);
    // The row first, every time: a delete, here or on another replica, takes effect at once.
    const row = await artifacts.get(params.id);
    if (row === null || version > row.currentVersion) return missing();
    const etag = artifactEtag(row.id, version);
    if (noneMatch(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { ...ARTIFACT_CONTENT_HEADERS, etag } });
    }
    const body = await served.get(`${row.id}@${version}`, () =>
      builds.run(async () => {
        const outcome = await artifactContent(
          { artifacts, store, blobs: deps.attachmentStore ?? null },
          row.id,
          version,
        );
        return outcome.kind === "missing" ? null : new TextEncoder().encode(outcome.html);
      }));
    if (body === null) return missing();
    return new Response(body as BodyInit, {
      status: 200,
      headers: { ...ARTIFACT_CONTENT_HEADERS, etag, "content-length": String(body.byteLength) },
    });
  };

  const thumbnail = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const missing = () =>
      new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
    if (!mayReadArtifacts(caller) || !VERSION.test(params.n)) return missing();
    const notReady = () =>
      new Response(null, {
        status: 503,
        headers: { "cache-control": "private, no-store", "retry-after": "30" },
      });
    if (thumbnails === null) return notReady();
    const result = await thumbnails.get(params.id, Number(params.n));
    if (result.kind === "missing") return missing();
    if (result.kind === "unavailable") return notReady();
    const etag = `"${createHash("sha256").update(result.bytes).digest("hex")}"`;
    const headers = {
      "content-type": "image/png",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      etag,
    };
    if (noneMatch(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(result.bytes as BodyInit, {
      headers: { ...headers, "content-length": String(result.bytes.byteLength) },
    });
  };

  const remove = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    if (artifacts === null) return unavailable();
    const row = mayReadArtifacts(caller) ? await artifacts.get(params.id) : null;
    // Whoever first asked for an artifact may take it down; anyone else needs artifacts:manage.
    if (row === null || !mayDeleteArtifact(caller, row)) {
      const denied = refuseUnless(caller, "artifacts:manage", "deleting an artifact");
      if (denied) return denied;
    }
    const gone = await artifacts.delete(params.id, deps.now().toISOString());
    served.drop(params.id);
    if (!gone) return json(404, { error: "no such artifact" });
    await thumbnails?.drop(params.id, MAX_ARTIFACT_VERSIONS);
    return new Response(null, { status: 204 });
  };

  return [
    route("GET", "/v1/artifacts", list),
    route("GET", "/v1/artifacts/:id", get),
    route("GET", "/v1/artifacts/:id/versions/:n/content", content),
    route("GET", "/v1/artifacts/:id/versions/:n/thumbnail", thumbnail),
    route("DELETE", "/v1/artifacts/:id", remove),
  ];
}
