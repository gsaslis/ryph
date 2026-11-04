// In-process embeddings — bge-small-en-v1.5, int8, through @huggingface/transformers over the
// native ONNX runtime. The GKE image's shape, as measured:
// weights baked into the image at build, no provider, no sidecar, ~34 MB on disk and ~270 MB of
// resident memory, a millisecond per text once loaded.
//
// The runtime is loaded LAZILY through a specifier no bundler or type checker follows, on
// purpose: the package and its native binaries weigh hundreds of megabytes, and listing it in a
// package.json would make every `bun install`, every CI run and every developer pay for a
// dependency only the standalone memory image uses. So it is in no package.json and no lockfile:
// the image installs it at TRANSFORMERS_VERSION (images/memory/Dockerfile), and a developer who
// sets RYPH_MEMORY_EMBEDDINGS=local installs it beside this package without saving it:
//
//   cd packages/memory && bun add --no-save --exact @huggingface/transformers@3.8.1
//
// A runtime of any other version is refused at load. The single binary carries its own: the
// build (packages/ryph/scripts/embeddings.ts) bundles this same pinned version into one module,
// with the target platform's onnxruntime addon and library and the weights beside it, and the
// binary passes that module's file URL as `runtime` instead of the bare specifier.

import type { Embedder } from "../../ports/embedder.ts";

export const LOCAL_EMBEDDING_MODEL = "bge-small-en-v1.5";
/** The Hugging Face repository the weights come from — Xenova's ONNX export of BAAI's model. */
export const LOCAL_EMBEDDING_REPO = "Xenova/bge-small-en-v1.5";
/**
 * The commit the weights are taken at. Without it the runtime fetches `main`, so the bytes the
 * image bakes are whatever the repository holds on the day it is built — a third party's branch
 * deciding what runs here. Pinned, the fetch is reproducible and a moved branch is a build that
 * fails rather than a model that quietly changed. scripts/fetch_model.ts then checks the bytes
 * themselves, because a revision names a commit and a commit's LFS objects are fetched by URL.
 *
 * To move it: read the `sha` of https://huggingface.co/api/models/Xenova/bge-small-en-v1.5,
 * put it here, and re-run `bun scripts/fetch_model.ts` to print the digests that go with it.
 */
export const LOCAL_EMBEDDING_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
/**
 * sha256 of every file `Xenova/bge-small-en-v1.5` at LOCAL_EMBEDDING_REVISION puts on disk,
 * relative to <modelDir>/<repo>/<revision>. Only what `dtype: "q8"` actually pulls is here: the
 * runtime fetches one ONNX export, not all nine, and no file the tokenizer does not ask for.
 * Computed by scripts/fetch_model.ts against the pinned revision on 2026-09-15; checked by it at
 * the image's build and by the binary's build (packages/ryph/scripts/embeddings.ts), which packs
 * exactly these files.
 */
export const LOCAL_EMBEDDING_FILES: Readonly<Record<string, string>> = {
  "config.json": "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
  "onnx/model_quantized.onnx": "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
  "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
};
/** Pinned: the runtime's API and the model's export format both move between majors. */
export const TRANSFORMERS_VERSION = "3.8.1";
export const TRANSFORMERS_SPECIFIER = "@huggingface/transformers";

interface Tensor {
  tolist(): number[][];
}
interface Extractor {
  (texts: string[], opts: { pooling: "cls"; normalize: boolean }): Promise<Tensor>;
}
interface TransformersModule {
  env: {
    version?: string;
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
  };
  pipeline(
    task: "feature-extraction",
    model: string,
    opts: { dtype: "q8"; revision: string },
  ): Promise<Extractor>;
}

export interface LocalEmbedderOptions {
  /** Where the weights live (or are downloaded to): the image bakes them at /app/models. */
  modelDir: string;
  /** Refuse to download: the image has the weights, and a service must not reach out for them
   * at runtime. Off for a developer's first run. */
  offline?: boolean;
  /** Texts per runtime call; the model's context is short and batches keep the RSS bounded. */
  batchSize?: number;
  /** The runtime as a file URL, imported instead of the bare specifier: the binary's bundled
   * copy. Absent: `@huggingface/transformers`, wherever the resolver finds it. */
  runtime?: string;
}

/** Loads the runtime (`runtime`, else the bare specifier). Throws with the reason when it is
 * missing or not the pinned version. */
export async function loadTransformers(runtimeUrl?: string): Promise<TransformersModule> {
  const specifier = runtimeUrl ?? TRANSFORMERS_SPECIFIER;
  let runtime: TransformersModule;
  try {
    runtime = await import(specifier) as TransformersModule;
  } catch (err) {
    throw new Error(
      `the embeddings runtime (${TRANSFORMERS_SPECIFIER}@${TRANSFORMERS_VERSION}${
        runtimeUrl === undefined ? "" : ` at ${runtimeUrl}`
      }) is not available: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (runtime.env.version !== TRANSFORMERS_VERSION) {
    throw new Error(
      `the embeddings runtime is ${TRANSFORMERS_SPECIFIER}@${runtime.env.version}, not the pinned ` +
        TRANSFORMERS_VERSION,
    );
  }
  return runtime;
}

/**
 * The embedder, loading on first use. `load()` up front makes a boot fail loudly when the
 * weights are missing rather than the first search.
 */
export function localEmbedder(opts: LocalEmbedderOptions): Embedder & { load(): Promise<void> } {
  const batchSize = opts.batchSize ?? 16;
  let extractor: Promise<Extractor> | null = null;
  const load = (): Promise<Extractor> => {
    extractor ??= (async () => {
      const t = await loadTransformers(opts.runtime);
      t.env.cacheDir = opts.modelDir;
      t.env.allowLocalModels = true;
      if (opts.offline) t.env.allowRemoteModels = false;
      return await t.pipeline("feature-extraction", LOCAL_EMBEDDING_REPO, {
        dtype: "q8",
        revision: LOCAL_EMBEDDING_REVISION,
      });
    })().catch((err) => {
      extractor = null;
      throw err;
    });
    return extractor;
  };
  return {
    model: LOCAL_EMBEDDING_MODEL,
    async load() {
      await load();
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const run = await load();
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, 2_000));
        const tensor = await run(batch, { pooling: "cls", normalize: true });
        out.push(...tensor.tolist());
      }
      return out;
    },
  };
}
