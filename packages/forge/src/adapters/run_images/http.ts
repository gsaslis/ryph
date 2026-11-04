// `RunImages` against the orchestrator: a run's image refs resolved
// (POST /v1/forge/runs/:runId/images/resolve, body `{refs}`), and one attachment's bytes
// (GET /v1/forge/runs/:runId/attachments/:attachmentId) — service-authed with the shared
// RYPH_FORGE_TOKEN, exactly as the tool grants' adapter is.
//
// Invariants:
// - "could not ask" THROWS and is never read as "unknown": an unknown ref fails the agent's write
//   with a sentence saying the image is not theirs, which is untrue of an outage
// - the resolve deadline covers the control plane's own wait: a ref the model saw a moment ago
//   may still be uploading, and the orchestrator holds the answer up to 10 s for it
// - bytes are read under the attachment cap while they stream, and their format is the bytes'
//   own magic numbers — never the content type the response claims

import type { ImageResolution, RunImages } from "../../ports/run_images.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { ControlPlaneRefusal, refusalReason } from "../../ports/tool_grants.ts";
import { describeIssues, readCappedBytes } from "@ryph/shared/http";
import { ImageResolutionSchema } from "../../schema.ts";
import { MAX_THREAD_IMAGE_BYTES, sniffImage } from "../../helpers/image_download.ts";

export interface HttpRunImagesOptions {
  orchestratorUrl: string;
  forgeToken: string;
  diag: Diagnostics;
  /** The resolve's deadline. Default 20s: the orchestrator may wait 10s for an upload. */
  resolveTimeoutMs?: number;
  /** One attachment's deadline. Default 30s. */
  bytesTimeoutMs?: number;
}

export function httpRunImages(opts: HttpRunImagesOptions): RunImages {
  const { diag } = opts;
  const base = `${opts.orchestratorUrl.replace(/\/+$/, "")}/v1/forge/runs`;
  const authorization = `Bearer ${opts.forgeToken}`;

  return {
    async resolve(runId, refs): Promise<ImageResolution> {
      const res = await fetch(`${base}/${encodeURIComponent(runId)}/images/resolve`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ refs }),
        signal: AbortSignal.timeout(opts.resolveTimeoutMs ?? 20_000),
      });
      if (!res.ok) {
        diag.warn("run_images.resolve_failed", { status: res.status });
        if (res.status >= 400 && res.status < 500) {
          const body = await res.json().catch(() => null);
          throw new ControlPlaneRefusal(res.status, refusalReason(res.status, body));
        }
        await res.body?.cancel();
        throw new Error(`image resolve answered ${res.status}`);
      }
      const parsed = ImageResolutionSchema.safeParse(await res.json());
      if (!parsed.success) {
        diag.warn("run_images.resolve_malformed", { issues: describeIssues(parsed.error) });
        throw new Error("image resolve answered a malformed resolution");
      }
      return parsed.data;
    },

    async bytes(runId, attachmentId) {
      const res = await fetch(
        `${base}/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
        {
          headers: { authorization },
          signal: AbortSignal.timeout(opts.bytesTimeoutMs ?? 30_000),
        },
      );
      if (!res.ok) {
        await res.body?.cancel();
        diag.warn("run_images.bytes_failed", { status: res.status, attachmentId });
        throw new Error(`attachment ${attachmentId} answered ${res.status}`);
      }
      const read = await readCappedBytes(res, MAX_THREAD_IMAGE_BYTES);
      if (!read.ok) throw new Error(`attachment ${attachmentId} is over the attachment cap`);
      const mime = sniffImage(read.bytes);
      if (mime === null) throw new Error(`attachment ${attachmentId} is not an image`);
      return { bytes: read.bytes, mime };
    },
  };
}
