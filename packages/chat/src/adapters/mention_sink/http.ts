// `MentionSink` over the control plane's mention door: POST the mention to
// `/v1/chat/mentions` with the shared RYPH_CHAT_TOKEN. A 200 is a verdict, validated at this
// boundary like any other payload; a 4xx is the door calling the request malformed; a 5xx, a
// dead socket or a verdict that does not parse is "the door could not decide", which the poller
// retries.
//
// A mention's images ride the same body, base64-encoded (`images: [{data}]`), rather than going
// up first on a call of their own: a mention that STARTS a run has no run to upload to until the
// door has decided, and the door decides on the whole mention at once — the claim, the start
// and the images' storage are one step there. The body is bounded by the service's own caps
// (MAX_MENTION_IMAGE_TOTAL_BYTES), and the control plane reads it under a cap of its own.

import type { MentionSink } from "../../ports/mention_sink.ts";
import { describeIssues } from "@ryph/shared/http";
import { MentionVerdictSchema } from "../../schema.ts";
import { redactSecrets } from "../../helpers/download.ts";

export interface HttpMentionSinkOptions {
  /** The control plane, as this process dials it; a trailing slash is tolerated. */
  orchestratorUrl: string;
  /** The shared service credential this process presents. */
  chatToken: string;
  requestTimeoutMs?: number;
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** A mention with images carries up to tens of MiB, and the door stores each one before it
 * answers: it is given longer. */
const IMAGES_REQUEST_TIMEOUT_MS = 60_000;

export function httpMentionSink(opts: HttpMentionSinkOptions): MentionSink {
  const base = opts.orchestratorUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const dial = opts.fetch ?? fetch;
  return {
    async deliver(mention) {
      let res: Response;
      try {
        res = await dial(`${base}/v1/chat/mentions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.chatToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...mention,
            images: mention.images.map((image) => ({ data: image.bytes.toBase64() })),
          }),
          signal: AbortSignal.timeout(
            mention.images.length > 0 ? Math.max(timeoutMs, IMAGES_REQUEST_TIMEOUT_MS) : timeoutMs,
          ),
        });
      } catch (err) {
        // A header fetch refuses is quoted in its message, the token in it: never passed on.
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "failed", error: redactSecrets(message, [opts.chatToken]) };
      }
      const body = await res.json().catch(() => null) as unknown;
      if (res.ok) {
        const parsed = MentionVerdictSchema.safeParse(body);
        if (!parsed.success) {
          return {
            kind: "failed",
            error: `the door answered an unreadable verdict: ${describeIssues(parsed.error)}`,
          };
        }
        return { kind: "verdict", verdict: parsed.data };
      }
      const said = (body as { error?: unknown } | null)?.error;
      const error = typeof said === "string" ? said : `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        return { kind: "malformed", status: res.status, error };
      }
      return { kind: "failed", error: `the control plane answered ${res.status}: ${error}` };
    },
  };
}
