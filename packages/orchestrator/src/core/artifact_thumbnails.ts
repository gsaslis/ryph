// Best-effort, lazy screenshots of immutable artifact versions. No work is coupled to publish:
// a restart loses only an in-flight render, and the next view tries again. The shared blob store
// survives restarts. Replicas may duplicate a render; each has bounded admission, never a queue.
// Every read checks liveness, including cache hits. Delete also removes completed blobs; a render
// racing it checks again after upload and removes its own late result.
import type { ArtifactThumbnailRenderer } from "../ports/artifact_thumbnail.ts";
import type { ArtifactStore } from "../ports/artifact_store.ts";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import type { TaskStore } from "../ports/task_store.ts";
import { readCappedBytes } from "@ryph/shared/http";
import { mapWithConcurrency } from "../helpers/concurrency.ts";
import { artifactContent } from "./artifacts.ts";

export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;
/** Bump when rendering semantics change. Old revisions must remain in deletion's list. */
const REVISIONS = ["offline-v1"] as const;
const REVISION = REVISIONS[REVISIONS.length - 1];
const FAILURE_BACKOFF_MS = 30_000;
const MAX_FAILURES = 256;

export function thumbnailKey(id: string, version: number, revision: string = REVISION): string {
  return `artifact-thumbnails/${encodeURIComponent(id)}/${version}/${revision}.png`;
}

/** Sniff, don't decode untrusted raster bytes in the credential-bearing process. */
export function isThumbnail(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33 || bytes.byteLength > THUMBNAIL_MAX_BYTES) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (!signature.every((byte, i) => bytes[i] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === 1200 && view.getUint32(20) === 750;
}

export type ThumbnailOutcome =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "unavailable" };

type Deps = {
  artifacts: ArtifactStore;
  store: Pick<TaskStore, "listAttachmentsByIds">;
  blobs: AttachmentStore;
  renderer: ArtifactThumbnailRenderer | null;
  now?: () => number;
  /** Tests can shorten the I/O budgets. */
  budgetMs?: number;
  cleanupBudgetMs?: number;
  warn?: (event: string, detail: { artifactId: string; version?: number }) => void;
};

export class ArtifactThumbnails {
  #pending = new Map<string, Promise<ThumbnailOutcome>>();
  #failed = new Map<string, number>();
  #rendering = false;

  constructor(private readonly deps: Deps, private readonly maxConcurrent = 8) {}

  async get(id: string, version: number): Promise<ThumbnailOutcome> {
    const row = await this.deps.artifacts.get(id);
    if (row === null || version > row.currentVersion) return { kind: "missing" };
    const key = thumbnailKey(id, version);
    const existing = this.#pending.get(key);
    if (existing !== undefined) return await existing;
    const now = this.deps.now?.() ?? Date.now();
    if ((this.#failed.get(key) ?? 0) > now || this.#pending.size >= this.maxConcurrent) {
      return { kind: "unavailable" };
    }
    const work = this.#make(id, version, key).catch((): ThumbnailOutcome => {
      this.deps.warn?.("artifact.thumbnail_failed", { artifactId: id, version });
      this.#failed.delete(key);
      this.#failed.set(key, (this.deps.now?.() ?? Date.now()) + FAILURE_BACKOFF_MS);
      if (this.#failed.size > MAX_FAILURES) this.#failed.delete(this.#failed.keys().next().value!);
      return { kind: "unavailable" };
    }).finally(() => this.#pending.delete(key));
    this.#pending.set(key, work);
    return await work;
  }

  async #make(id: string, version: number, key: string): Promise<ThumbnailOutcome> {
    const { artifacts, blobs, renderer } = this.deps;
    // Cancel the actual I/O, never abandon work behind a Promise.race.
    const signal = AbortSignal.timeout(this.deps.budgetMs ?? 25_000);
    const cached = await blobs.get(key, signal);
    if (cached !== null) {
      const read = await readCappedBytes(
        cached,
        THUMBNAIL_MAX_BYTES,
        AbortSignal.timeout(5_000),
      );
      if (read.ok && isThumbnail(read.bytes)) {
        return await artifacts.get(id) === null
          ? { kind: "missing" }
          : { kind: "ok", bytes: read.bytes };
      }
      // A malformed or partial cache entry is replaceable, not a permanent broken preview.
      await blobs.delete(key, signal);
    }
    // Cache reads need not wait for Chromium. Only one miss renders at a time; busy is not
    // a failed render and does not enter the failure backoff. The UI retries a few times.
    if (renderer === null || this.#rendering) return { kind: "unavailable" };
    this.#rendering = true;
    try {
      const content = await artifactContent(this.deps, id, version, signal);
      if (content.kind === "missing") return content;
      const bytes = await renderer.render(content.html, signal);
      if (!isThumbnail(bytes)) throw new Error("invalid thumbnail");
      if (await artifacts.get(id) === null) return { kind: "missing" };
      await blobs.put(key, bytes, signal);
      if (await artifacts.get(id) === null) {
        await blobs.delete(key, AbortSignal.timeout(5_000));
        return { kind: "missing" };
      }
      return { kind: "ok", bytes };
    } finally {
      this.#rendering = false;
    }
  }

  /** Call after tombstoning. Deletes all possible versions: a publish may have won the lock
   * since the delete route read the row. In-flight work, on any replica, cleans its late put. */
  async drop(id: string, maxVersions: number): Promise<void> {
    const signal = AbortSignal.timeout(this.deps.cleanupBudgetMs ?? 10_000);
    await mapWithConcurrency(
      Array.from({ length: maxVersions }, (_, i) => i + 1),
      4,
      async (version) => {
        for (const revision of REVISIONS) {
          const key = thumbnailKey(id, version, revision);
          this.#failed.delete(key);
          try {
            signal.throwIfAborted();
            await this.deps.blobs.delete(key, signal);
          } catch {
            this.deps.warn?.("artifact.thumbnail_cleanup_failed", { artifactId: id, version });
          }
        }
      },
    );
  }
}
