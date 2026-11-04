// `AttachmentStore` over the forge's patch store: the same object store, the same settings
// (`RYPH_PATCH_STORE`, `RYPH_S3_*`), the same SigV4 — attachments sit beside the patches and the
// build logs under an `attachments/` prefix, inside whatever per-cell `RYPH_S3_PREFIX` the
// deployment sets, so a deployment that made patches durable made images durable too, and every
// replica serves an image another one took in.
//
// The patch store files a blob from a staging FILE, so the bytes are written to a temp file
// first; the store consumes it either way. An image is at most MAX_ATTACHMENT_BYTES, so this is
// one small write, never a stream to manage.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFsPatchStore, type PatchStore, s3PatchStore } from "@ryph/forge/patch-store";
import type { AttachmentStore } from "../../ports/attachment_store.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function patchStoreAttachments(store: PatchStore): AttachmentStore {
  return {
    async put(key, bytes, signal) {
      signal?.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), "ryph-attachment-"));
      const staging = join(dir, "staging");
      try {
        signal?.throwIfAborted();
        await writeFile(staging, bytes, { signal });
        signal?.throwIfAborted();
        await store.put(key, staging, signal);
        signal?.throwIfAborted();
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    get: (key, signal) => store.get(key, signal),
    delete: (key, signal) => store.delete(key, signal),
  };
}

/**
 * The attachment store as this process reads the patch store's settings. Local: files under
 * `RYPH_ATTACHMENT_DIR` (default `./data`). S3: the forge's bucket and credentials, verbatim —
 * a half-configured object store is refused by name, as the forge refuses it.
 */
export function attachmentStoreFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  diag: Diagnostics,
): AttachmentStore {
  const kind = env("RYPH_PATCH_STORE") ?? "local";
  if (kind === "local") {
    return patchStoreAttachments(
      localFsPatchStore(env("RYPH_ATTACHMENT_DIR") ?? "./data", diag),
    );
  }
  if (kind !== "s3") {
    fail(`unknown RYPH_PATCH_STORE ${JSON.stringify(kind)} — use "local" or "s3"`);
  }
  const need = (name: string) =>
    env(name) ?? fail(`RYPH_PATCH_STORE=s3 needs ${name} (attachments live beside the patches)`);
  const endpoint = need("RYPH_S3_ENDPOINT");
  if (!URL.canParse(endpoint)) {
    fail(`RYPH_S3_ENDPOINT must be an absolute URL, got ${JSON.stringify(endpoint)}`);
  }
  return patchStoreAttachments(s3PatchStore({
    config: {
      endpoint,
      region: env("RYPH_S3_REGION") ?? "us-east-1",
      bucket: need("RYPH_S3_BUCKET"),
      prefix: env("RYPH_S3_PREFIX"),
      accessKeyId: need("RYPH_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("RYPH_S3_SECRET_ACCESS_KEY"),
      sessionToken: env("RYPH_S3_SESSION_TOKEN"),
      forcePathStyle: env("RYPH_S3_FORCE_PATH_STYLE") !== "false",
    },
    diag,
  }));
}
