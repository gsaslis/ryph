// Where an attachment's bytes go: the object store patches and build logs live in, under an
// `attachments/` prefix. The row in `run_attachments` is the
// record — which run owns the image, what it is, who used it — and this holds only the blob.
//
// Invariants:
// - keys are composed by the core from ids it minted (`attachments/<runId>/<attachmentId>`),
//   never from anything a client sent
// - a blob is written once, whole, after its bytes were sniffed and capped — no appends, and
//   nothing here ever sees bytes that are not an allowed image under the cap

export interface AttachmentStore {
  put(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** The blob as a byte stream, or null when the key is unknown. */
  get(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  /** Removes the blob; a key already gone is not an error. For a blob no row names any more (a
   * refused start's, an unclaimed upload taken back or swept) — a claimed image is never
   * deleted. */
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
