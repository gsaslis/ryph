// `RunImages` over the control plane's chat routes, with the shared RYPH_CHAT_TOKEN — the same
// link and the same token the mention door takes (adapters/mention_sink/http.ts):
//
//   POST {orchestrator}/v1/chat/runs/:runId/images/resolve   { refs } → { images, unknown }
//   GET  {orchestrator}/v1/chat/runs/:runId/attachments/:attachmentId → the bytes
//
// The answer is validated at this boundary like any other payload. The resolve is given longer
// than a plain call: while a run is live the control plane waits up to 10 s on a ref whose upload
// is still in flight. The bytes are read under a cap as they stream: an image a run may keep is
// 5 MiB at most, and nothing larger is read whole into this process.

import { downloadCapped, redactSecrets } from "../../helpers/download.ts";
import type { RunImages } from "../../ports/run_images.ts";
import { describeIssues } from "@ryph/shared/http";
import { ImageResolutionSchema } from "../../schema.ts";

export interface HttpRunImagesOptions {
  /** The control plane, as this process dials it; a trailing slash is tolerated. */
  orchestratorUrl: string;
  /** The shared service credential this process presents. */
  chatToken: string;
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
  resolveTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

const DEFAULT_RESOLVE_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Twice the control plane's 5 MiB attachment cap: generous for what it stores, and a bound. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function httpRunImages(opts: HttpRunImagesOptions): RunImages {
  const base = opts.orchestratorUrl.replace(/\/+$/, "");
  const dial = opts.fetch ?? fetch;
  const authorization = `Bearer ${opts.chatToken}`;
  const runPath = (runId: string) => `${base}/v1/chat/runs/${encodeURIComponent(runId)}`;
  return {
    async resolve(runId, refs) {
      let res: Response;
      try {
        res = await dial(`${runPath(runId)}/images/resolve`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ refs }),
          signal: AbortSignal.timeout(opts.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(
          `the control plane could not resolve images: ${
            redactSecrets(err instanceof Error ? err.message : String(err), [opts.chatToken])
          }`,
        );
      }
      const body = await res.json().catch(() => null) as unknown;
      if (!res.ok) {
        const said = (body as { error?: unknown } | null)?.error;
        throw new Error(
          `the control plane answered ${res.status} resolving images${
            typeof said === "string" ? `: ${said}` : ""
          }`,
        );
      }
      const parsed = ImageResolutionSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          `the control plane answered an unreadable resolution: ${describeIssues(parsed.error)}`,
        );
      }
      return parsed.data;
    },

    async fetch(runId, attachmentId) {
      const got = await downloadCapped(
        dial,
        `${runPath(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { method: "GET", headers: { authorization } },
        {
          label: "control plane attachment",
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
          signal: new AbortController().signal,
        },
      );
      if (got.kind === "too_large") throw new Error("control plane attachment: too large");
      if (got.kind === "failed") throw new Error(got.error);
      // A view of its own buffer, as a request body takes it.
      return new Uint8Array(got.bytes);
    },
  };
}
