// `PatchStore` on S3-compatible object storage — the adapter the port was shaped for.
//
// The local filesystem one is correct and stays the default for the single-process deployment,
// where "durable" and "on this machine" are the same thing. In the networked deployment they are
// not: patches/ is the forge's real output, it lives on a volume attached to one container, and
// that pins the forge at ONE replica. Scale it and half the reads 404 — a patch submitted through
// replica A cannot be delivered by replica B, and the failure is per-patch and silent rather than
// loud at boot.
//
// `get` streams; `put` does not, and cannot with a plain PUT.
//
// S3 requires `Content-Length` on an object PUT, and `Content-Length` is a FORBIDDEN header in
// the Fetch standard — setting it is ignored, and a stream body goes out chunked, which S3
// answers with 411 MissingContentLength. The length has to come from the body itself, so the
// body has to be something whose length is known: bytes. This was found by running against a
// real S3 implementation; a fake that echoes our own request would never have said so.
//
// So a put holds one bundle in memory. That is bounded, not unbounded — the intake capped it at
// RYPH_FORGE_MAX_BUNDLE_BYTES (100 MB by default) before the staging file was ever written, so
// the ceiling is that cap times the submissions in flight. The way out, when bundles or
// concurrency grow past what that allows, is S3's multipart upload: each part is a separate
// PUT with its own length, so only one part need be resident. It is deliberately not here yet —
// it is a second signing path and a resumable-state machine, for a problem nobody has.
//
// The buffer is hashed rather than the file re-read: SigV4 wants sha256 of the body, and having
// already paid to hold it, paying twice to read it would be silly.

import { readFile, rm } from "node:fs/promises";
import type { PatchStore } from "../../ports/patch_store.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { encodeSegment, signRequest, toHex } from "../../helpers/sigv4.ts";

/** Same charset as the local adapter's, and for the same reason — see there. */
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export interface S3PatchStoreConfig {
  /** The service endpoint, e.g. `https://s3.eu-central-1.amazonaws.com` or a MinIO address. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Optional key prefix inside the bucket. No leading or trailing slash. */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For credentials from an assumed role. */
  sessionToken?: string;
  /**
   * `https://<bucket>.<host>/<key>` (virtual-hosted) or `https://<host>/<bucket>/<key>` (path).
   * Path style is what MinIO and most self-hosted stores want; AWS prefers virtual-hosted and
   * requires it for buckets whose name is not DNS-safe.
   */
  forcePathStyle?: boolean;
}

export interface S3PatchStoreDeps {
  config: S3PatchStoreConfig;
  diag: Diagnostics;
  /** Injected so tests do not need a clock, and so a signature can be pinned. */
  now?: () => Date;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  );
}

export function s3PatchStore(deps: S3PatchStoreDeps): PatchStore {
  const { config, diag } = deps;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const endpoint = new URL(config.endpoint);
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");

  const creds = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    region: config.region,
    service: "s3",
  };

  /** The signed path and the host header for one key — the two halves that must agree. */
  const address = (key: string): { url: URL; host: string; path: string } => {
    if (!KEY_RE.test(key) || key.includes("..")) {
      throw new Error(`invalid patch key ${JSON.stringify(key)}`);
    }
    const fullKey = prefix === "" ? key : `${prefix}/${key}`;
    // Each segment separately: a "/" in the key is a path separator, and encoding it would
    // address a different (flat-named) object than the one the bucket listing shows.
    const encoded = fullKey.split("/").map(encodeSegment).join("/");
    const url = new URL(endpoint.href);
    if (config.forcePathStyle) {
      url.pathname = `/${encodeSegment(config.bucket)}/${encoded}`;
    } else {
      url.hostname = `${config.bucket}.${url.hostname}`;
      url.pathname = `/${encoded}`;
    }
    // The signed host must be what the socket sends, port included when it is not the default.
    return { url, host: url.host, path: url.pathname };
  };

  return {
    async put(key: string, sourcePath: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const { url, host, path } = address(key);
      const body = await readFile(sourcePath, { signal });
      signal?.throwIfAborted();
      const payloadHash = await sha256Hex(body);
      signal?.throwIfAborted();

      // `content-length` is deliberately NOT here: it is a forbidden header, so fetch derives it
      // from the body and would drop ours — and a signature covering a header the socket never
      // sends is a 403 with no explanation. S3 does not require it to be signed, only sent.
      const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash };
      const signed = await signRequest(
        { method: "PUT", path, headers, payloadHash },
        creds,
        now(),
      );

      signal?.throwIfAborted();
      const res = await doFetch(url, {
        signal,
        method: "PUT",
        headers: { ...headers, ...signed },
        body: body as BodyInit,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`s3 put ${key} failed: ${res.status} ${detail.slice(0, 200)}`);
      }
      await res.body?.cancel();

      // The port says the source is consumed. The local adapter renames; here the bytes were
      // copied, so the staging file has to be removed — leaving it would fill the disk that the
      // move to object storage was supposed to stop mattering.
      await rm(sourcePath).catch(() => {});
      signal?.throwIfAborted();
      diag.debug("patch_store.put", { key, bytes: body.byteLength });
    },

    async get(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
      signal?.throwIfAborted();
      const { url, host, path } = address(key);
      // A GET has no body, so the payload hash is sha256(""), fixed and well known.
      const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash };
      const signed = await signRequest(
        { method: "GET", path, headers, payloadHash },
        creds,
        now(),
      );

      signal?.throwIfAborted();
      const res = await doFetch(url, { method: "GET", headers: { ...headers, ...signed }, signal });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`s3 get ${key} failed: ${res.status} ${detail.slice(0, 200)}`);
      }
      // Handed on unread: the route pipes it to the caller, so a bundle never lands in memory.
      return res.body;
    },

    async delete(key: string, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const { url, host, path } = address(key);
      // No body, so sha256("") as for a GET. S3 answers 204 whether or not the key existed; a
      // store that says 404 instead means the same thing here.
      const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash };
      const signed = await signRequest(
        { method: "DELETE", path, headers, payloadHash },
        creds,
        now(),
      );
      signal?.throwIfAborted();
      const res = await doFetch(url, {
        method: "DELETE",
        headers: { ...headers, ...signed },
        signal,
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new Error(`s3 delete ${key} failed: ${res.status} ${detail.slice(0, 200)}`);
      }
      await res.body?.cancel();
      signal?.throwIfAborted();
      diag.debug("patch_store.delete", { key });
    },
  };
}
