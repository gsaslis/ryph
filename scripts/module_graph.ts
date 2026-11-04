// The import graph of a TypeScript entry point, for the architecture guards: what `deno info
// --json` gave them, resolved by the TypeScript compiler's own module resolution instead.
//
// The shape is `deno info`'s, which the guards were written against, so they kept their rules:
// `modules[].specifier` is a file:// URL, and each `dependencies[]` entry carries the resolved
// target in `code.specifier`. A workspace package (`@ryph/db`) resolves through its node_modules
// symlink to its real file under packages/, so it is a local edge as it was under Deno. A
// registry package or a `node:`/`bun:` built-in keeps the specifier as written and is never
// walked. An import that resolves to nothing carries only that text, so a guard reports it
// rather than passing it over.
//
// Every static import, `export … from`, `import type` and string-literal dynamic `import()` is
// an edge, as it was for `deno info`.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export interface DepEdge {
  specifier: string;
  code?: { specifier?: string };
}

export interface Module {
  specifier?: string;
  dependencies?: DepEdge[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const options: ts.CompilerOptions = (() => {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.base.json"), ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
})();

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/;

/** Where `specifier`, imported from `file`, leads: a local file, or null for anything else. */
function resolve(specifier: string, file: string): { local: string | null; resolved: boolean } {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return { local: null, resolved: true };
  }
  const { resolvedModule } = ts.resolveModuleName(specifier, file, options, ts.sys);
  if (!resolvedModule) return { local: null, resolved: false };
  const real = realpathSync(resolvedModule.resolvedFileName);
  // By where the file really is: a workspace package is reached through a node_modules symlink,
  // which the compiler counts as external, but its source lives under packages/.
  const external = real.includes("/node_modules/") || real.endsWith(".d.ts") || !SOURCE.test(real);
  return { local: external ? null : real, resolved: true };
}

/**
 * Every module reachable from `entry` (a path) through local files, each with its direct
 * dependencies. Registry packages and built-ins appear as edges, never as modules.
 */
export function moduleGraph(entry: string): Module[] {
  const seen = new Map<string, Module>();
  const queue = [realpathSync(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const module: Module = { specifier: pathToFileURL(file).href, dependencies: [] };
    seen.set(file, module);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName: specifier } of importedFiles) {
      const { local, resolved } = resolve(specifier, file);
      if (local !== null) {
        module.dependencies!.push({ specifier, code: { specifier: pathToFileURL(local).href } });
        queue.push(local);
      } else if (resolved) {
        module.dependencies!.push({ specifier, code: { specifier } });
      } else {
        module.dependencies!.push({ specifier });
      }
    }
  }
  return [...seen.values()];
}
