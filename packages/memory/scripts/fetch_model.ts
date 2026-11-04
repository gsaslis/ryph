// Downloads the embedding model into a directory, so the memory image ships its weights and the
// service never reaches out for them at runtime. Run at image build:
//
//   bun --no-env-file scripts/fetch_model.ts /app/models
//
// The runtime package must already be installed at its pinned version (it is loaded dynamically,
// see src/adapters/embed/local.ts); this run loads it once, so a broken install fails here too.
//
// WHAT THE BUILD IS TRUSTING. The weights are a third party's bytes fetched over the network at
// build time. The revision pin in local.ts settles WHICH commit is asked for; it does not settle
// what comes back, because a commit's large files are served from a CDN by URL and nothing in the
// fetch verifies them against the commit. So this asserts the sha256 of every file that lands,
// against the digests below. A mismatch fails the image build, which is the only place it can
// still be caught cheaply — after that the bytes are the model, and a model that has quietly
// changed looks exactly like one that has not.
//
// To move the pin: change LOCAL_EMBEDDING_REVISION, run this script (it prints every digest it
// computed), read the new bytes' provenance for yourself, and paste the block it prints into
// LOCAL_EMBEDDING_FILES (src/adapters/embed/local.ts), which the binary's build checks too.

// A streamed digest, so the ONNX file is hashed without being held in memory.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "@std/path";
import {
  LOCAL_EMBEDDING_FILES,
  LOCAL_EMBEDDING_REPO,
  LOCAL_EMBEDDING_REVISION,
  localEmbedder,
} from "../src/adapters/embed/local.ts";

const DIGESTS = LOCAL_EMBEDDING_FILES;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Every file under `root`, as paths relative to it, in a stable order. */
async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await filesUnder(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

const dir = process.argv.slice(2)[0] ?? "./models";
const embedder = localEmbedder({ modelDir: dir, offline: false });
const started = performance.now();
await embedder.load();
const [vector] = await embedder.embed(["warm-up"]);
console.log(
  `fetched ${embedder.model} into ${dir}: ${vector.length} dimensions, ${
    Math.round(performance.now() - started)
  } ms`,
);

// ── the bytes, checked ───────────────────────────────────────────────────────────────────────────
// A pinned revision gets its own directory under the repo's: <dir>/Xenova/<model>/<sha>/…
const root = join(dir, ...LOCAL_EMBEDDING_REPO.split("/"), LOCAL_EMBEDDING_REVISION);
const found = await filesUnder(root);
const computed = Object.fromEntries(
  await Promise.all(found.map(async (rel) => [rel, await sha256(join(root, rel))] as const)),
);

console.log(`\n${LOCAL_EMBEDDING_REPO}@${LOCAL_EMBEDDING_REVISION}, as it landed:`);
for (const rel of found) console.log(`  "${rel}": "${computed[rel]}",`);

const problems: string[] = [];
for (const [rel, want] of Object.entries(DIGESTS)) {
  if (!(rel in computed)) problems.push(`${rel} was expected and is not there`);
  else if (computed[rel] !== want) {
    problems.push(`${rel} is ${computed[rel]}, not the recorded ${want}`);
  }
}
for (const rel of found) {
  if (!(rel in DIGESTS)) problems.push(`${rel} landed and no digest was recorded for it`);
}
if (problems.length > 0) {
  console.error(
    `\nthe weights are not the bytes this build expects:\n${
      problems.map((p) => `  - ${p}`).join("\n")
    }\n\n` +
      "Either the pinned revision was moved, the CDN served something else, or the runtime's " +
      "file set changed with its version. Do not paste the printed digests in to make this pass " +
      "without knowing which.",
  );
  process.exit(1);
}
console.log(`\n${found.length} files verified against their recorded digests`);
