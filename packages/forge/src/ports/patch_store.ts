// Durable storage for patch bundles. A bundle is one opaque blob, not a git working tree, so
// it does not need the POSIX filesystem git relies on. That is why this is a port: the same
// put/get/delete set works over a local filesystem today or object storage later, so the
// backend can be swapped without touching the core.

/** Signals cancel byte transfer where supported; filesystem metadata calls finish before
 * cancellation is observed. An aborted write may already have filed the blob. */
export interface PatchStore {
  /**
   * Stores the bundle at `sourcePath` under `key`, durably. The source is an already-validated
   * temp file (intake streams, caps, and verifies it before anything is put). The store may
   * move rather than copy it, so the caller must not touch `sourcePath` afterwards.
   */
  put(key: string, sourcePath: string, signal?: AbortSignal): Promise<void>;
  /** Opens the bundle stored under `key` as a byte stream, or null if the key is unknown. */
  get(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Removes what is stored under `key`; a key that is already gone is not an error. The forge
   * itself never deletes a bundle — this is for the other blobs filed beside the patches (a
   * run's images, which the control plane takes back when no row names them any more).
   */
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
