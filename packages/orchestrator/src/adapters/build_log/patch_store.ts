// `BuildLogStore` over the forge's patch store: the same object store, the same settings
// (`RYPH_PATCH_STORE`, `RYPH_S3_*`), the same SigV4 — build logs sit beside the patches under
// an `environments/` prefix, so a deployment that made patches durable made logs durable too.
//
// The patch store files a blob from a staging FILE (a bundle is streamed to disk before it is
// put), so a log is written to a temp file first; the store consumes it either way.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFsPatchStore, type PatchStore, s3PatchStore } from "@ryph/forge/patch-store";
import type { BuildLogStore } from "../../ports/build_log_store.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function patchStoreBuildLogs(store: PatchStore): BuildLogStore {
  return {
    async put(key, text) {
      const dir = await mkdtemp(join(tmpdir(), "ryph-build-log-"));
      const staging = join(dir, "staging");
      try {
        await writeFile(staging, text);
        await store.put(key, staging);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    async get(key) {
      const stream = await store.get(key);
      return stream === null ? null : await new Response(stream).text();
    },
  };
}

/**
 * The log store as this process reads the patch store's settings. Local: files under
 * `RYPH_ENV_LOG_DIR` (default `./data`). S3: the forge's bucket and credentials, verbatim — a
 * half-configured object store is refused by name, as the forge refuses it.
 */
export function buildLogStoreFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  diag: Diagnostics,
): BuildLogStore {
  const kind = env("RYPH_PATCH_STORE") ?? "local";
  if (kind === "local") {
    return patchStoreBuildLogs(localFsPatchStore(env("RYPH_ENV_LOG_DIR") ?? "./data", diag));
  }
  if (kind !== "s3") {
    fail(`unknown RYPH_PATCH_STORE ${JSON.stringify(kind)} — use "local" or "s3"`);
  }
  const need = (name: string) =>
    env(name) ?? fail(`RYPH_PATCH_STORE=s3 needs ${name} (build logs live beside the patches)`);
  const endpoint = need("RYPH_S3_ENDPOINT");
  if (!URL.canParse(endpoint)) {
    fail(`RYPH_S3_ENDPOINT must be an absolute URL, got ${JSON.stringify(endpoint)}`);
  }
  return patchStoreBuildLogs(s3PatchStore({
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
