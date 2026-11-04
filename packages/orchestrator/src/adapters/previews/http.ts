// `PreviewsService` over a standalone previews service's API listener (`:7493`, `/internal/*`),
// service-authed with the shared RYPH_PREVIEWS_TOKEN.
//
// Invariants:
// - nothing throws: an unreachable service, a timeout, a status nobody expects and a malformed
//   answer are all `failed`, which the routes answer 502. Only the service's own 400/429 on a
//   registration is passed through, and a 404 on a viewer is `missing`
// - every answer is read under a byte cap and validated before a field of it is used: a
//   malformed answer is refused, never patched
// - the runner's tunnel URL is the base the registration answer names (`tunnelBase`: the owning
//   replica's own address, when the service runs several), else RYPH_RUN_PREVIEWS_URL, the
//   service's TUNNEL listener (`:7491`) as a run reaches it (the shared Service, or a run gate).
//   Its scheme swapped (http → ws, https → wss), then `/tunnel/<ticket>`. Either way the tunnel
//   listener, the only one run pods may reach: never the API one this process calls. A named base
//   must be exactly one of the replicas' own (RYPH_PREVIEWS_PEER_HOST with an ordinal 0–63, the
//   scheme and port of RYPH_RUN_PREVIEWS_URL); anything else fails the registration rather than
//   being patched. Several replicas behind a run gate, which relays one address, are unsupported
// - the ticket and the token are never logged

import { readCappedBytes } from "@ryph/shared/http";
import { z } from "@zod/zod";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  HOSTED_PREVIEW_ID,
  type PreviewList,
  type PreviewOwner,
  type PreviewRegistration,
  type PreviewsService,
  type PreviewViewer,
} from "../../ports/previews.ts";

export interface HttpPreviewsOptions {
  /** The service's API listener, as this process dials it (RYPH_PREVIEWS_URL); a trailing slash
   * is tolerated. */
  previewsUrl: string;
  /**
   * The service's TUNNEL listener as a RUN dials it, the base of the tunnel URL a runner is handed
   * with its scheme swapped (RYPH_RUN_PREVIEWS_URL): a listener of its own, which run pods reach
   * and the API listener is not.
   */
  tunnelUrl: string;
  /**
   * Every replica's own host, `{ordinal}` in it once (RYPH_PREVIEWS_PEER_HOST, as the service
   * has it): the only tunnel bases the service may name, with `tunnelUrl`'s scheme and port.
   * Unset, it may name none.
   */
  replicaHost?: string;
  /** The shared service credential this process presents. */
  previewsToken: string;
  diag: Diagnostics;
  /** Deadlines; the tests shorten them. */
  timeouts?: Partial<
    { registerMs: number; listMs: number; viewerMs: number; lookupMs: number; closeMs: number }
  >;
}

/** Each longer than the previews service's own wait on another replica (its FORWARD_MS, 2.5 s), so
 * a replica that does not answer comes back as the service's 503, not as a call given up on. */
const TIMEOUTS = {
  registerMs: 5_000,
  listMs: 3_000,
  viewerMs: 5_000,
  lookupMs: 3_000,
  closeMs: 5_000,
};
/** No answer of the service's is anywhere near this; a bigger one is not the service's. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** The service's preview ids are 32 hex; held to a safe charset rather than to that exact shape. */
const PREVIEW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PreviewId = z.string().regex(PREVIEW_ID);
/** A run id as far as the service's answer goes: a safe charset, never patched. */
const RunId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const HttpUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "not an http(s) URL");

const RegisteredSchema = z.object({
  id: PreviewId,
  url: HttpUrl,
  ticket: z.string().min(1).max(512),
  tunnelBase: z.string().max(512).optional(),
});
const ListSchema = z.object({
  previews: z.array(z.object({
    id: PreviewId,
    port: z.number().int().min(1).max(65535),
    label: z.string().max(80),
    url: HttpUrl,
  })).max(256),
});
const ViewerSchema = z.object({ url: HttpUrl });
const LookupSchema = z.object({ runId: RunId });

/** A tunnel base the service named, as a bare `ws(s)://host[:port]`, or null when it is anything
 * else: another scheme, credentials, a path, a query or a fragment. */
export function ownerTunnelBase(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname !== "/" || !/^wss?:\/\/[^/?#\\@]+\/?$/i.test(value)) return null;
  return `${url.protocol}//${url.host}`;
}

/** Ordinals a deployment runs at most (the previews service's RYPH_PREVIEWS_REPLICAS ceiling). */
const MAX_REPLICAS = 64;

/**
 * Every tunnel base the service may name: each replica's own host from `template`, with the
 * scheme (swapped) and port of `tunnelUrl`, the tunnel listener every replica shares. Empty
 * without a template that names `{ordinal}` exactly once.
 */
export function replicaTunnelBases(tunnelUrl: string, template: string | undefined): Set<string> {
  if (template === undefined || template.split("{ordinal}").length !== 2) return new Set();
  const url = new URL(tunnelBase(tunnelUrl));
  const port = url.port === "" ? "" : `:${url.port}`;
  const bases = new Set<string>();
  for (let k = 0; k < MAX_REPLICAS; k++) {
    const named = ownerTunnelBase(
      `${url.protocol}//${template.replace("{ordinal}", `${k}`)}${port}`,
    );
    if (named !== null) bases.add(named);
  }
  return bases;
}

/** The scheme swap: the tunnel listener's base as a WebSocket URL. */
export function tunnelBase(tunnelUrl: string): string {
  const base = tunnelUrl.replace(/\/+$/, "");
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  throw new Error("the previews service's URL must be an http:// or https:// URL");
}

export function httpPreviews(opts: HttpPreviewsOptions): PreviewsService {
  const base = opts.previewsUrl.replace(/\/+$/, "");
  const ws = tunnelBase(opts.tunnelUrl);
  const replicas = replicaTunnelBases(opts.tunnelUrl, opts.replicaHost);
  const timeouts = { ...TIMEOUTS, ...opts.timeouts };
  const headers = { authorization: `Bearer ${opts.previewsToken}` };

  /** The answer, or why there is none. Never throws. */
  const call = async (
    method: string,
    path: string,
    timeoutMs: number,
    body?: unknown,
  ): Promise<{ res: Response; json: unknown } | { error: string }> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const read = await readCappedBytes(res, MAX_ANSWER_BYTES);
      if (!read.ok) return { error: "previews service answered too much" };
      let json: unknown = null;
      try {
        json = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        // Not JSON: the status alone still says something to the caller.
      }
      return { res, json };
    } catch (err) {
      return {
        error: `previews service unreachable: ${err instanceof Error ? err.message : err}`,
      };
    }
  };

  const failed = (event: string, fields: Record<string, unknown>, error: string) => {
    opts.diag.warn(event, { ...fields, error });
    return { kind: "failed" as const, error };
  };

  return {
    async register(input): Promise<PreviewRegistration> {
      const answer = await call("POST", "/internal/previews", timeouts.registerMs, input);
      const fields = { runId: input.runId, port: input.port };
      if ("error" in answer) return failed("previews.register_failed", fields, answer.error);
      const { res, json } = answer;
      if (res.status === 400 || res.status === 429) {
        const body = typeof json === "object" && json !== null
          ? json
          : { error: res.status === 429 ? "preview limit reached" : "preview refused" };
        return { kind: "refused", status: res.status, body };
      }
      if (!res.ok) {
        return failed("previews.register_failed", fields, `previews service: HTTP ${res.status}`);
      }
      const parsed = RegisteredSchema.safeParse(json);
      if (!parsed.success) {
        return failed("previews.register_failed", fields, "previews service: malformed answer");
      }
      const { id, url, ticket } = parsed.data;
      // The owning replica's own address when the service names one, and only one of theirs;
      // the ticket is in neither the error nor the log.
      let tunnel = ws;
      if (parsed.data.tunnelBase !== undefined) {
        const named = ownerTunnelBase(parsed.data.tunnelBase);
        if (named === null || !replicas.has(named)) {
          return failed("previews.register_failed", fields, "previews service: bad tunnel base");
        }
        tunnel = named;
      }
      return {
        kind: "registered",
        id,
        url,
        tunnel: `${tunnel}/tunnel/${encodeURIComponent(ticket)}`,
      };
    },

    async list(runId): Promise<PreviewList> {
      const answer = await call(
        "GET",
        `/internal/runs/${encodeURIComponent(runId)}/previews`,
        timeouts.listMs,
      );
      if ("error" in answer) return failed("previews.list_failed", { runId }, answer.error);
      if (!answer.res.ok) {
        const error = `previews service: HTTP ${answer.res.status}`;
        return failed("previews.list_failed", { runId }, error);
      }
      const parsed = ListSchema.safeParse(answer.json);
      if (!parsed.success) {
        return failed("previews.list_failed", { runId }, "previews service: malformed answer");
      }
      return { kind: "previews", previews: parsed.data.previews };
    },

    async openViewer(runId, previewId, path): Promise<PreviewViewer> {
      if (!PREVIEW_ID.test(previewId)) return { kind: "missing" };
      const answer = await call(
        "POST",
        `/internal/previews/${encodeURIComponent(previewId)}/viewer`,
        timeouts.viewerMs,
        { runId, path },
      );
      const fields = { runId, previewId };
      if ("error" in answer) return failed("previews.viewer_failed", fields, answer.error);
      if (answer.res.status === 404) return { kind: "missing" };
      if (!answer.res.ok) {
        const error = `previews service: HTTP ${answer.res.status}`;
        return failed("previews.viewer_failed", fields, error);
      }
      const parsed = ViewerSchema.safeParse(answer.json);
      if (!parsed.success) {
        return failed("previews.viewer_failed", fields, "previews service: malformed answer");
      }
      return { kind: "url", url: parsed.data.url };
    },

    async findRun(previewId): Promise<PreviewOwner> {
      if (!HOSTED_PREVIEW_ID.test(previewId)) return { kind: "missing" };
      const answer = await call("GET", `/internal/previews/${previewId}`, timeouts.lookupMs);
      const fields = { previewId };
      if ("error" in answer) return failed("previews.lookup_failed", fields, answer.error);
      if (answer.res.status === 404) return { kind: "missing" };
      if (!answer.res.ok) {
        const error = `previews service: HTTP ${answer.res.status}`;
        return failed("previews.lookup_failed", fields, error);
      }
      const parsed = LookupSchema.safeParse(answer.json);
      if (!parsed.success) {
        return failed("previews.lookup_failed", fields, "previews service: malformed answer");
      }
      return { kind: "run", runId: parsed.data.runId };
    },

    closeRun(runId) {
      // Best effort and once: a run's pod dying closes its tunnels anyway, so a lost DELETE only
      // keeps a dead preview listed until its tunnel's ping lapses.
      void call("DELETE", `/internal/runs/${encodeURIComponent(runId)}`, timeouts.closeMs)
        .then((answer) => {
          if ("error" in answer) {
            opts.diag.warn("previews.close_failed", { runId, error: answer.error });
          } else if (!answer.res.ok) {
            opts.diag.warn("previews.close_failed", { runId, status: answer.res.status });
          }
        })
        .catch(() => {});
    },
  };
}
