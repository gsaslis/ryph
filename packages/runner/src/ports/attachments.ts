// The images the control plane holds for this run, as the runner READS them. A run's container
// has no route to the internet's copy of an image — a GitHub attachment, a Telegram file — and
// must not: egress is locked, and the platform already fetched, sniffed and capped the bytes. So
// the one place the runner gets them is the control plane, by id, scoped to its own run, over
// the same run-token channel the inbox uses.
//
// And the one way the runner WRITES one: an image the agent's own tool returned (a browser
// screenshot, an image file its read tool opened) is uploaded before the tool's result is
// narrated, so the transcript names it by id instead of carrying its bytes. Best-effort: the
// answer is a ref or null, never a throw, and a null costs the transcript a picture, nothing else.
// Each goes up under its image ref (`img-` and 12 hex of its SHA-256), the name the agent writes
// it by in `![alt](img-…)`; `resolveImageRefs` asks which of those the run keeps.

import type { AttachmentRef } from "../core/types.ts";

export interface Attachments {
  /**
   * The bytes of one of this run's images. Throws when it cannot be had — the control plane
   * refused, the blob is gone, the body was over the cap — and the core then tells the agent that
   * image could not be fetched instead of failing the message it came with.
   */
  fetch(ref: AttachmentRef): Promise<Uint8Array>;
  /**
   * Keeps one image a tool returned as this run's attachment, already claimed (the control
   * plane's `POST /v1/runs/:id/runner/attachments`), and answers its ref — the type the control
   * plane sniffed. Null when it was not kept: refused (a 4xx — not an image, the run's cap, the
   * run over), retries exhausted, or `signal` aborted. Never throws.
   */
  upload(bytes: Uint8Array, imageRef: string, signal?: AbortSignal): Promise<AttachmentRef | null>;
  /**
   * Which of `refs` name images this run keeps (`POST /v1/runs/:id/runner/images/resolve`): the
   * ones it does, and the ones it does not. Throws when it could not be asked.
   */
  resolveImageRefs(refs: readonly string[]): Promise<{ known: string[]; unknown: string[] }>;
}
