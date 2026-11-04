// A run's images on the user surface (core/attachments.ts): the run page uploads one before it
// sends the message that carries it, and reads one back to draw a thumbnail.
//
//   POST /v1/runs/:id/attachments                  raw image bytes in → {id, mime, bytes}
//   GET  /v1/runs/:id/attachments/:attachmentId    bytes by attachment id or agent img-… ref
//   DELETE /v1/runs/:id/attachments/:attachmentId  takes back an upload no message carried
//
// The runner reads the same bytes through its own door (http/runner_api.ts), run-token
// authenticated, at a path of its own: a URLPattern router takes the first match, so two GETs on
// one path would hand the runner's request to this handler's user check.
//
// Invariants:
// - the upload is held to the same permission as posting the message it is for (`tasks:steer`,
//   on a task the caller may steer), and the read to the one reading the run takes
//   (`tasks:read`, on a task the caller may read); taking an upload back is the upload's
//   permission, and only ever reaches an unclaimed one — a sent image is the conversation's
// - the body is read under the 5 MiB cap WHILE it streams; what the client says the type is,
//   and any filename it sends, are ignored — the bytes are sniffed
// - an attachment is served only on the path of the run that owns it; another run's id reads as
//   no attachment at all
// - what is served is inert: the sniffed type, `nosniff`, a `sandbox` CSP and an `inline`
//   disposition with a filename minted here, so no browser renders it as anything but the image
//   it was checked to be

import {
  attachmentExtension,
  MAX_ATTACHMENT_BYTES,
  storeAttachment,
  takeBackAttachment,
} from "../core/attachments.ts";
import type { Attachment, Run } from "../core/types.ts";
import { IMAGE_REF } from "../core/image_refs.ts";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import type { WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, readCappedBytes, type Route, route } from "@ryph/shared/http";
import { scopeFor } from "./scope.ts";

/**
 * An attachment's bytes as a response: the stored type, and the headers that keep a browser
 * from reading them as anything else. Shared by the user door and the runner's, so the two can
 * never disagree about what an image is served as. 404 when the store has lost the blob.
 */
export async function serveAttachment(
  blobs: AttachmentStore,
  attachment: Attachment,
): Promise<Response> {
  const body = await blobs.get(attachment.storageKey);
  if (body === null) return json(404, { error: "no such attachment" });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": attachment.mime,
      "content-length": String(attachment.bytes),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `inline; filename="${attachment.id}.${
        attachmentExtension(attachment.mime)
      }"`,
      // Served to one signed-in person, so private; and asked again on every use rather than
      // kept for a day, so an image is never shown from cache to whoever opens the browser after
      // a sign-out. The patch diff's answer (user_api.ts `getPatchDiff`), for the same reason:
      // what the caller may read is decided per request, never by a copy that outlived it.
      "cache-control": "private, no-cache",
    },
  });
}

export function attachmentRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;

  /** The run the caller may steer, or the refusal: what uploading and taking back both ask. */
  const steerableRun = async (req: Request, runId: string): Promise<Run | Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const run = await store.getRun(runId);
    const owner = run === null
      ? null
      : await store.getTask(run.taskId, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!run || owner === null) return json(404, { error: "no such run" });
    return run;
  };

  const upload = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await steerableRun(req, params.id);
    if (run instanceof Response) {
      await req.body?.cancel().catch(() => {});
      return run;
    }
    const read = await readCappedBytes(req, MAX_ATTACHMENT_BYTES);
    if (!read.ok) {
      return json(413, { error: `an image is at most ${MAX_ATTACHMENT_BYTES} bytes (5 MiB)` });
    }
    const outcome = await storeAttachment(deps, run, read.bytes, "user");
    if (outcome.kind === "refused") {
      // The reason travels, as it does for a message: the page words a run that ended itself.
      return json(outcome.status, {
        error: outcome.error,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      });
    }
    const { id, mime, bytes } = outcome.attachment;
    return json(201, { id, mime, bytes });
  };

  const download = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const run = await store.getRun(params.id);
    const task = run === null
      ? null
      : await store.getTask(run.taskId, await scopeFor(deps, caller, "tasks:read-all"));
    if (!run || task === null) return json(404, { error: "no such run" });
    // Transcript messages name images by ref, including when the tool event that produced
    // them is outside the loaded history page. Resolve only within the authorized run.
    const attachment = IMAGE_REF.test(params.attachmentId)
      ? (await store.agentAttachmentsByRefs(run.id, [params.attachmentId]))[0] ?? null
      : await store.getAttachment(params.attachmentId);
    if (attachment === null || attachment.runId !== run.id || !deps.attachmentStore) {
      return json(404, { error: "no such attachment" });
    }
    return await serveAttachment(deps.attachmentStore, attachment);
  };

  // Taking back an upload the person removed from the message box before sending. 404 for
  // anything that is not this run's unclaimed upload, a sent one included: a sent image belongs
  // to the conversation, and saying 204 for it would claim a removal that did not happen.
  const takeBack = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await steerableRun(req, params.id);
    if (run instanceof Response) return run;
    if (!await takeBackAttachment(deps, run.id, params.attachmentId)) {
      return json(404, { error: "no unsent image with that id on this run" });
    }
    return new Response(null, { status: 204 });
  };

  return [
    route("POST", "/v1/runs/:id/attachments", upload),
    route("GET", "/v1/runs/:id/attachments/:attachmentId", download),
    route("DELETE", "/v1/runs/:id/attachments/:attachmentId", takeBack),
  ];
}
