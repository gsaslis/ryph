// The patch store's adapters, exported for the one other process that files blobs in the same
// place: the orchestrator writes environment build logs beside the patches, under an
// `environments/` prefix. One object store, one
// set of RYPH_PATCH_STORE / RYPH_S3_* settings, one implementation of SigV4.

export type { PatchStore } from "./ports/patch_store.ts";
export { localFsPatchStore } from "./adapters/patch_store/local_fs.ts";
export { s3PatchStore, type S3PatchStoreConfig } from "./adapters/patch_store/s3.ts";
