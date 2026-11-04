// Advisory, not a gate: large source files deserve a look, not an automatic split. Keep the
// architecture guard independent — line count says nothing about allowed dependencies.
import { readdir, readFile } from "node:fs/promises";
import { fromFileUrl, relative } from "@std/path";

export interface LongFile {
  path: string;
  lines: number;
}

export async function longSourceFiles(root: string, limit = 800): Promise<LongFile[]> {
  const found: LongFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|svelte)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        if (lines > limit) found.push({ path: relative(root, path), lines });
      }
    }
  }
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

if (import.meta.main) {
  const root = fromFileUrl(new URL("../src", import.meta.url));
  for (const file of await longSourceFiles(root)) {
    console.warn(`file-length warning: src/${file.path} has ${file.lines} lines (over 800)`);
  }
}
