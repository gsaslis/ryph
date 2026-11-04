import { z } from "zod";
import { refreshSession } from "$lib/utils/auth/auth";
import { apiCall, apiError } from "./call";
import { type AttachmentMime, attachmentMimeSchema } from "./types";

// A run's images, as the run page handles them: uploaded one at a time as they are added to the
// message box (`POST /v1/runs/:id/attachments`, the raw bytes), sent by id with the message, and
// read back through the same proxy to draw a thumbnail.
//
// The checks here are the composer's courtesy, so a 12 MB photo is refused before it crosses
// the wire rather than after. The control plane is the authority: it sniffs the format from the
// bytes (what the browser says the type is never counts there) and caps the size while it reads,
// and its refusal's own words are what the person sees when it disagrees with these.

/** The formats the control plane takes, which is also what the file picker offers. */
export const ATTACHMENT_MIMES: readonly AttachmentMime[] = attachmentMimeSchema.options;

/**
 * Per image, as the control plane caps it. Restated (the app cannot import the orchestrator at
 * runtime) and pinned equal to `MAX_ATTACHMENT_BYTES` there by attachments.test.ts.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Per message, as the control plane caps it. Restated and pinned the same way. */
export const MAX_ATTACHMENTS = 10;

/** Where an attachment's bytes are read from, same-origin through the app's proxy. */
export function attachmentUrl(runId: string, attachmentId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/attachments/${
    encodeURIComponent(attachmentId)
  }`;
}

/**
 * Why a file will not be taken, or null when it may be uploaded. Only what can be read without
 * the bytes: the type the browser guessed (from the extension, mostly) and the size.
 */
export function attachmentProblem(
  file: { name: string; type: string; size: number },
): string | null {
  const name = file.name || "The image";
  if (!(ATTACHMENT_MIMES as readonly string[]).includes(file.type)) {
    return `${name} is not a PNG, JPEG, GIF or WebP image`;
  }
  if (file.size === 0) return `${name} is empty`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${name} is larger than 5 MiB`;
  return null;
}

export const uploadedAttachmentSchema = z.object({
  id: z.string(),
  mime: attachmentMimeSchema,
  bytes: z.number(),
});
export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;

/** One upload's trip: the status and the parsed JSON body (null when it was not JSON). */
export type UploadTransport = (
  path: string,
  body: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
) => Promise<{ status: number; body: unknown }>;

/**
 * The browser's transport: an XMLHttpRequest, because `fetch` reports no upload progress and a
 * 5 MiB screenshot on a slow link is long enough to want a bar. The body goes as the raw bytes
 * with the file's own type, which the proxy streams on untouched.
 */
export const xhrTransport: UploadTransport = (path, body, { onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("content-type", body.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: a proxy's own error page. The status still says what happened.
      }
      resolve({ status: xhr.status, body: parsed });
    };
    xhr.onerror = () => reject(new Error("The upload did not go through"));
    xhr.onabort = () => reject(new DOMException("The upload was cancelled", "AbortError"));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });

/**
 * Uploads one image to a run, unclaimed until a message carries its id. A 401 gets the same
 * single refresh-and-retry every other call does (`apiCall`); any other refusal throws an
 * `ApiError` carrying the control plane's own message — "an image is at most 5242880 bytes
 * (5 MiB); …", "not a supported image: PNG, JPEG, GIF and WebP are accepted", "run is terminal
 * (succeeded)".
 */
export async function uploadAttachment(
  runId: string,
  file: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  transport: UploadTransport = xhrTransport,
): Promise<UploadedAttachment> {
  const path = `/api/v1/runs/${encodeURIComponent(runId)}/attachments`;
  let res = await transport(path, file, options);
  if (res.status === 401 && (await refreshSession()) !== null) {
    res = await transport(path, file, options);
  }
  if (res.status < 200 || res.status >= 300) throw apiError(res.status, res.body);
  return uploadedAttachmentSchema.parse(res.body);
}

/**
 * Takes back an upload no message carried: a chip removed from the message box. Its bytes are
 * deleted on the control plane, and the slot it held under the per-run limit is free again.
 */
export async function deleteAttachment(f = fetch, runId: string, attachmentId: string) {
  await apiCall(
    f,
    `/v1/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
}
