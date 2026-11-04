// `PatchStore` on the local filesystem: one file per bundle under a root directory.
// The port exists because a bundle is ONE FILE: that is what lets an alternate store (e.g. S3)
// slot in behind the same calls as a free swap.
//
// Invariants:
// - a put is atomic: the bundle is moved (renamed) into place, never written in place —
//   a reader can never observe a half-filed bundle
// - keys are paths only by coincidence of this adapter: they are validated against a tight
//   charset here (belt and braces — the gateway composes them from ids it validated), so a
//   key can never traverse out of the root

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PatchStore } from "../../ports/patch_store.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function localFsPatchStore(root: string, diag: Diagnostics): PatchStore {
  const pathFor = (key: string): string => {
    if (!KEY_RE.test(key) || key.includes("..")) {
      throw new Error(`invalid patch key ${JSON.stringify(key)}`);
    }
    return `${root}/${key}`;
  };

  return {
    async put(key: string, sourcePath: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const dest = pathFor(key);
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      // Metadata operations do not accept a signal: await them and check at each boundary.
      await mkdir(dir, { recursive: true });
      signal?.throwIfAborted();
      try {
        await rename(sourcePath, dest);
      } catch (err) {
        signal?.throwIfAborted();
        if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
        // Cross-device staging: abort the copy streams, always removing the partial sibling.
        const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
        try {
          await pipeline(createReadStream(sourcePath), createWriteStream(tmp), { signal });
          signal?.throwIfAborted();
          await rename(tmp, dest);
          await rm(sourcePath).catch(() => {});
        } finally {
          await rm(tmp, { force: true }).catch(() => {});
        }
      }
      signal?.throwIfAborted();
      diag.debug("patch_store.put", { key });
    },

    async get(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
      signal?.throwIfAborted();
      try {
        const file = await open(pathFor(key), "r");
        try {
          signal?.throwIfAborted();
          return Readable.toWeb(file.createReadStream({ signal })) as ReadableStream<Uint8Array>;
        } catch (err) {
          await file.close();
          throw err;
        }
      } catch (err) {
        signal?.throwIfAborted();
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    },

    async delete(key: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      try {
        await rm(pathFor(key));
      } catch (err) {
        signal?.throwIfAborted();
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw err;
      }
      signal?.throwIfAborted();
      diag.debug("patch_store.delete", { key });
    },
  };
}
