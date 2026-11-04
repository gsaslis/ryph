// A run's tool images as the services that write agent text read them: the forge (a comment, a
// review, a pull request body, the status comment) and chat (a post, the closing line). Two
// routes per surface, mounted by forge_api.ts and chat_api.ts behind each one's own service
// token:
//
//   POST /v1/<surface>/runs/:runId/images/resolve   { refs }  → { images, unknown }
//   GET  /v1/<surface>/runs/:runId/attachments/:attachmentId  → the bytes
//
// The resolve waits on a live run's missing refs (core/image_refs.ts `resolveImageRefs`): a
// forge write can arrive before the runner has uploaded the screenshot it shows. The bytes are
// for a surface that uploads them itself (a Radicle embed, a chat file); every other surface
// links the app, which serves the image behind a login.
//
// Invariants:
// - only a run's own tool images (`source: "agent"`) are served or resolved here; an image a
//   person uploaded, or another run's, is the same 404 as one that does not exist
// - a concluded run's images still resolve: the status comment and the pull request body are
//   written after the run ends

import type { WiredDeps } from "./app.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { ImageRefsResolveSchema } from "../schema.ts";
import { type ResolvedImage, resolveImageRefs } from "../core/image_refs.ts";
import type { Attachment } from "../core/types.ts";
import { serveAttachment } from "./attachments_api.ts";

/** What resolving a run's refs answers; null when there is no such run. */
export async function resolveRunImages(
  deps: Pick<WiredDeps, "store" | "config">,
  runId: string,
  refs: readonly string[],
): Promise<{ images: ResolvedImage[]; unknown: string[] } | null> {
  const run = await deps.store.getRun(runId);
  if (run === null) return null;
  return await resolveImageRefs({ store: deps.store, appUrl: deps.config.appUrl }, run, refs);
}

/** One of a run's own tool images, or null: another run's, a person's upload, or none at all. */
export async function runImage(
  deps: Pick<WiredDeps, "store" | "attachmentStore">,
  runId: string,
  attachmentId: string,
): Promise<Attachment | null> {
  const found = await deps.store.getAttachment(attachmentId);
  return found === null || found.runId !== runId || found.source !== "agent" ||
      !deps.attachmentStore
    ? null
    : found;
}

/**
 * The same two reads for a service mounted in this process (the single binary's chat): no
 * route, no token, the same answers. What the HTTP adapters turn a 404 into, these throw.
 */
export function inProcessRunImages(deps: Pick<WiredDeps, "store" | "config" | "attachmentStore">): {
  resolve(runId: string, refs: string[]): Promise<{ images: ResolvedImage[]; unknown: string[] }>;
  fetch(runId: string, attachmentId: string): Promise<Uint8Array<ArrayBuffer>>;
} {
  return {
    async resolve(runId, refs) {
      const answer = await resolveRunImages(deps, runId, refs);
      if (answer === null) throw new Error("no such run");
      return answer;
    },
    async fetch(runId, attachmentId) {
      const found = await runImage(deps, runId, attachmentId);
      const stream = found === null ? null : await deps.attachmentStore!.get(found.storageKey);
      if (stream === null) throw new Error(`no such attachment ${attachmentId}`);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}

export function serviceImageRoutes(
  deps: WiredDeps,
  surface: "forge" | "chat",
  authenticated: (req: Request) => Promise<Response | null>,
): Route[] {
  const resolve = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, ImageRefsResolveSchema);
    if (!body.ok) return body.res;
    const answer = await resolveRunImages(deps, params.runId, body.data.refs);
    return answer === null ? json(404, { error: "no such run" }) : json(200, answer);
  };

  const bytes = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const found = await runImage(deps, params.runId, params.attachmentId);
    if (found === null) return json(404, { error: "no such attachment" });
    return await serveAttachment(deps.attachmentStore!, found);
  };

  return [
    route("POST", `/v1/${surface}/runs/:runId/images/resolve`, resolve),
    route("GET", `/v1/${surface}/runs/:runId/attachments/:attachmentId`, bytes),
  ];
}
