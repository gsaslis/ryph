// Memory's embeddings, as the binary carries them: what scripts/compile.ts packs for one target.
//
// The memory image installs @huggingface/transformers at its pinned version and fetches the
// weights at build (images/memory/Dockerfile); this is the same for a binary, from the same
// lockfile (images/memory/embeddings/), so the workspace's own install never pays for it:
//
// - The runtime is installed into a temporary directory from that lockfile (bun's cache makes
//   it quick after the first time), then bundled into ONE module with `Bun.build`. Not packed
//   as a node_modules tree: a compiled Bun binary resolves a bare import from a file on disk
//   without the `node`/`import` export conditions, so `@huggingface/transformers` and
//   `onnxruntime-common` (both conditional-exports-only) are "not found" from the unpacked copy
//   (measured on 1.4.2). Two changes on the way: `sharp` is a stub (image decoding, which text
//   embeddings never reach, and a native library of its own: transformers refuses to load with
//   no `sharp` at all, so the stub is a function that throws), and onnxruntime-node's addon is
//   required from beside the bundle rather than from its per-platform directory. Bundled for
//   `node`, so the output uses `createRequire`, never a Bun-only API.
// - Only the TARGET platform's onnxruntime addon and the one shared library it links go in,
//   beside the bundle. The addon finds the library there by itself: `@loader_path` on darwin,
//   `$ORIGIN` on linux, both in its own rpath. (onnxruntime-node ships every platform's, 200 MB.)
// - The weights are fetched from the pinned revision into node_modules/.cache/ryph-embeddings
//   once, and every build checks them against LOCAL_EMBEDDING_FILES, cached or fresh: a mismatch
//   fails the build. The runtime never fetches anything; the binary runs it offline.
//
// Everything lands under packages/memory/embeddings/ in the archive (runtime/, models/), where
// src/embedded.ts's BUNDLED_EMBEDDINGS points; the archive digests every file like the rest.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "@ryph/process";
import {
  LOCAL_EMBEDDING_FILES,
  LOCAL_EMBEDDING_REPO,
  LOCAL_EMBEDDING_REVISION,
  TRANSFORMERS_VERSION,
} from "../../memory/src/adapters/embed/local.ts";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const LOCKED_PROJECT = join(REPO_ROOT, "images", "memory", "embeddings");
const WEIGHTS_CACHE = join(REPO_ROOT, "node_modules", ".cache", "ryph-embeddings");
/** Where in the archive (and so under the unpacked copy) the files go. */
const ARCHIVE_DIR = "packages/memory/embeddings";

interface Platform {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
}

/** The platform a `--target=bun-<os>-<arch>` names, or this machine's without one. */
export function embeddingsPlatform(target?: string): Platform {
  const [os, arch, ...rest] = target === undefined
    ? [process.platform, process.arch]
    : target.replace(/^bun-/, "").split("-");
  if ((os !== "darwin" && os !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    throw new Error(
      `memory's embeddings have no onnxruntime build for ${target ?? `${os}-${arch}`} ` +
        "(darwin and linux, arm64 and x64 only)",
    );
  }
  // glibc only: onnxruntime-node's linux libraries link it. A baseline (pre-AVX2) x64 build of
  // Bun is still glibc, so it is fine.
  if (rest.includes("musl")) throw new Error(`onnxruntime-node has no musl build (${target})`);
  return { os, arch };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The pinned weights, from the cache when it holds the recorded bytes, else fetched into it. */
async function weights(): Promise<{ path: string; bytes: Uint8Array }[]> {
  const dir = join(WEIGHTS_CACHE, ...LOCAL_EMBEDDING_REPO.split("/"), LOCAL_EMBEDDING_REVISION);
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const [rel, want] of Object.entries(LOCAL_EMBEDDING_FILES)) {
    const cached = join(dir, rel);
    let bytes = existsSync(cached) ? new Uint8Array(await readFile(cached)) : null;
    if (bytes === null || sha256(bytes) !== want) {
      const url =
        `https://huggingface.co/${LOCAL_EMBEDDING_REPO}/resolve/${LOCAL_EMBEDDING_REVISION}/${rel}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      const got = sha256(bytes);
      if (got !== want) {
        throw new Error(
          `${url} is ${got}, not the recorded ${want}. Either the pinned revision moved or the ` +
            "CDN served something else; do not record the new digest without knowing which " +
            "(packages/memory/scripts/fetch_model.ts says how to move the pin).",
        );
      }
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(`${cached}.part`, bytes);
      await rename(`${cached}.part`, cached);
    }
    files.push({
      path: `${ARCHIVE_DIR}/models/${LOCAL_EMBEDDING_REPO}/${LOCAL_EMBEDDING_REVISION}/${rel}`,
      bytes,
    });
  }
  return files;
}

/** The runtime bundled into one module, and the target's addon and library beside it. */
async function runtime(platform: Platform): Promise<{ path: string; bytes: Uint8Array }[]> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-embeddings-"));
  try {
    await copyFile(join(LOCKED_PROJECT, "package.json"), join(dir, "package.json"));
    await copyFile(join(LOCKED_PROJECT, "bun.lock"), join(dir, "bun.lock"));
    // No lifecycle scripts: onnxruntime-node's postinstall only downloads GPU providers.
    const install = await command(process.execPath, {
      args: ["install", "--frozen-lockfile", "--production", "--ignore-scripts", "--no-progress"],
      cwd: dir,
      stdin: "null",
    }).output();
    if (!install.success) {
      throw new Error(
        `could not install the embeddings runtime from ${LOCKED_PROJECT}:\n${
          new TextDecoder().decode(install.stderr)
        }`,
      );
    }
    const modules = join(dir, "node_modules");
    const transformers = join(modules, "@huggingface", "transformers");
    const version = JSON.parse(await readFile(join(transformers, "package.json"), "utf8")).version;
    if (version !== TRANSFORMERS_VERSION) {
      throw new Error(
        `${LOCKED_PROJECT} locks @huggingface/transformers@${version}, but @ryph/memory pins ` +
          TRANSFORMERS_VERSION,
      );
    }
    const ort = join(modules, "onnxruntime-node");
    const ortVersion = JSON.parse(await readFile(join(ort, "package.json"), "utf8")).version;

    const bindingRequire =
      /require\(`\.\.\/bin\/napi-v3\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/;
    let rewroteBinding = false;
    const built = await Bun.build({
      entrypoints: [join(transformers, "dist", "transformers.node.mjs")],
      target: "node",
      format: "esm",
      plugins: [{
        name: "ryph-embeddings",
        setup(build) {
          build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "ryph-stub" }));
          build.onLoad({ filter: /.*/, namespace: "ryph-stub" }, () => ({
            loader: "js",
            contents: "export default function sharp() {\n" +
              '  throw new Error("image decoding is not part of ryph\'s embeddings runtime");\n' +
              "}\n",
          }));
          build.onLoad({ filter: /onnxruntime-node\/dist\/binding\.js$/ }, async (args) => {
            const source = await readFile(args.path, "utf8");
            if (!bindingRequire.test(source)) return undefined;
            rewroteBinding = true;
            return {
              loader: "js",
              contents: source.replace(
                bindingRequire,
                'require(require("node:path").join(import.meta.dirname, "onnxruntime_binding.node"))',
              ),
            };
          });
        },
      }],
    });
    if (!built.success || built.outputs.length !== 1) {
      throw new Error(`could not bundle the embeddings runtime:\n${built.logs.join("\n")}`);
    }
    if (!rewroteBinding) {
      throw new Error(
        `onnxruntime-node@${ortVersion} no longer loads its addon the way this build rewrites ` +
          "(dist/binding.js): update scripts/embeddings.ts",
      );
    }

    const native = join(ort, "bin", "napi-v3", platform.os, platform.arch);
    // The library the addon links by name: its install name on darwin, its soname on linux.
    const library = platform.os === "darwin"
      ? `libonnxruntime.${ortVersion}.dylib`
      : "libonnxruntime.so.1";
    const files = [{
      path: `${ARCHIVE_DIR}/runtime/transformers.mjs`,
      bytes: new Uint8Array(await built.outputs[0].arrayBuffer()),
    }, {
      path: `${ARCHIVE_DIR}/runtime/LICENSE.transformers`,
      bytes: new Uint8Array(await readFile(join(transformers, "LICENSE"))),
    }];
    for (const name of ["onnxruntime_binding.node", library]) {
      const abs = join(native, name);
      if (!existsSync(abs)) {
        throw new Error(
          `onnxruntime-node@${ortVersion} has no ${name} for ${platform.os}-${platform.arch}`,
        );
      }
      files.push({
        path: `${ARCHIVE_DIR}/runtime/${name}`,
        bytes: new Uint8Array(await readFile(abs)),
      });
    }
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every file memory's embeddings need in the binary for `target` (this machine's without). */
export async function embeddingResources(
  target?: string,
): Promise<{ path: string; bytes: Uint8Array }[]> {
  const platform = embeddingsPlatform(target);
  return [...await runtime(platform), ...await weights()];
}
