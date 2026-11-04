// Formats the top-level <script> and <style> blocks of every .svelte file. `deno fmt` did this;
// dprint's lax-markup plugin formats only the markup around them. Each block goes through dprint
// with the repo's dprint.json, as its own file, at column 0 (how deno fmt printed them).
//
// `bun scripts/fmt-svelte-blocks.ts` lists the files that would change and exits 1;
// `--write` rewrites them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const write = process.argv.includes("--write");

const EXTENSIONS: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  js: "js",
  javascript: "js",
  css: "css",
  json: "json",
  "application/json": "json",
  "application/ld+json": "json",
};
const BLOCK = /^(<(script|style)\b([^>]*)>\n)([\s\S]*?)^(<\/\2>)/gm;

function extensionOf(tag: string, attributes: string): string | undefined {
  const lang = /\b(?:lang|type)=["']?([\w/+-]+)/.exec(attributes)?.[1]?.toLowerCase();
  if (lang === undefined) return tag === "style" ? "css" : "js";
  return EXTENSIONS[lang];
}

const listed = Bun.spawnSync(
  ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.svelte"],
  { cwd: root },
);
const files = new TextDecoder().decode(listed.stdout).split("\0").filter((f) => f !== "");

type Block = { file: string; start: number; end: number; body: string; name: string };
const blocks: Block[] = [];
let exitCode = 0;
const work = mkdtempSync(join(tmpdir(), "svelte-blocks-"));
try {
  mkdirSync(join(work, "blocks"));
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(BLOCK)) {
      const [, open, tag, attributes, body] = match;
      const extension = extensionOf(tag, attributes);
      if (extension === undefined || body.trim() === "") continue;
      const name = `blocks/${blocks.length}.${extension}`;
      const start = match.index + open.length;
      blocks.push({ file, start, end: start + body.length, body, name });
      writeFileSync(join(work, name), body);
    }
  }
  writeFileSync(
    join(work, "dprint.json"),
    JSON.stringify({ extends: join(root, "dprint.json"), excludes: [] }),
  );
  const dprint = Bun.spawnSync(
    [join(root, "node_modules/.bin/dprint"), "fmt", "--config", join(work, "dprint.json")],
    { cwd: work, stdout: "ignore", stderr: "inherit" },
  );
  if (dprint.exitCode !== 0) throw new Error(`dprint fmt exited with ${dprint.exitCode}`);

  const changed = new Map<string, Block[]>();
  for (const block of blocks) {
    const formatted = readFileSync(join(work, block.name), "utf8");
    if (formatted === block.body) continue;
    changed.set(block.file, [...(changed.get(block.file) ?? []), { ...block, body: formatted }]);
  }
  for (const [file, edits] of changed) {
    if (!write) {
      console.log(file);
      continue;
    }
    let text = readFileSync(join(root, file), "utf8");
    // Last block first, so earlier offsets stay valid.
    for (const edit of edits.toReversed()) {
      text = text.slice(0, edit.start) + edit.body + text.slice(edit.end);
    }
    writeFileSync(join(root, file), text);
  }
  if (!write && changed.size > 0) {
    console.error(`${changed.size} .svelte file(s) have unformatted <script>/<style> blocks.`);
    exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
