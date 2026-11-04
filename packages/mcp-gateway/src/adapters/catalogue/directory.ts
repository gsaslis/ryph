// The catalogue as a directory of JSON files — one entry per file, the file named for its id —
// read and validated ONCE, at construction. An invalid entry fails the load loudly, naming the
// file and every issue: this is the list of images the platform will run, so "we skipped the
// one that did not parse" is not a mode worth having.
//
// The directory ships inside the package (packages/mcp-gateway/catalogue/). Resolved through
// import.meta.url rather than the cwd, so the same path works from source, from the gateway
// image, and from inside the `ryph` binary's embedded filesystem (its compile step
// `--include`s the directory).

import { readdir, readFile } from "node:fs/promises";
import { fromFileUrl, join } from "@std/path";
import { type CatalogueEntry, CatalogueEntrySchema } from "../../core/catalogue.ts";
import type { Catalogue } from "../../ports/catalogue.ts";

/** Where the entries this package ships live. */
export const CATALOGUE_DIR: string = fromFileUrl(new URL("../../../catalogue", import.meta.url));

export async function directoryCatalogue(dir: string = CATALOGUE_DIR): Promise<Catalogue> {
  const entries = new Map<string, CatalogueEntry>();
  const problems: string[] = [];
  const files: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith(".json")) files.push(item.name);
  }
  for (const file of files.sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: not JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }
    const parsed = CatalogueEntrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${file}: ${issue.path.join(".") || "(entry)"}: ${issue.message}`);
      }
      continue;
    }
    if (`${parsed.data.id}.json` !== file) {
      problems.push(`${file}: id "${parsed.data.id}" does not match the file name`);
      continue;
    }
    entries.set(parsed.data.id, parsed.data);
  }
  if (problems.length > 0) {
    throw new Error(`the MCP catalogue at ${dir} is invalid:\n  ${problems.join("\n  ")}`);
  }
  const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    list: () => Promise.resolve(structuredClone(sorted)),
    get: (id) => Promise.resolve(entries.has(id) ? structuredClone(entries.get(id)!) : null),
  };
}
