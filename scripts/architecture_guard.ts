// The one implementation behind every package's `bun run guard`. Each package keeps its own
// scripts/check_architecture.ts — the rules table and why it is shaped that way — and hands it
// here; the walk itself used to be copied fifteen times, and the copies drifted (five could never
// match a sibling-package allowance, and dropped an import that resolved to nothing).
//
// Two kinds of guard:
// - `checkArchitecture`: fenced scopes (src/core/, src/helpers/, …) may import only what their
//   rule allows. Only local (file://) edges are fenced, a workspace package's included: it
//   resolves to its real file under packages/ and is named "../<member>/". Registry imports and
//   node:/bun: built-ins live outside the graph and are always allowed, unless a rule names one
//   as forbidden. Type-only edges count.
// - `checkSelfContained`: the kits' stricter rule. src/ imports src/ and nothing else — no
//   registry package, no built-in, no sibling member.
//
// Both report an import that resolves to nothing as written, never skip it: an unresolvable
// dependency is still a dependency, and silently passing it is how a guard starts lying.

import { readdir, stat } from "node:fs/promises";
import { fileURLToPath as fromFileUrl } from "node:url";
import { type Module, moduleGraph } from "./module_graph.ts";

export interface FenceRule {
  /** A directory under the package root, with a trailing slash: "src/core/". */
  scope: string;
  /** Prefixes a dependency's package-relative path may start with: "src/ports/", "../sealed/". */
  allowed: string[];
  /** Registry or built-in specifiers the scope may not name, matched as substrings. */
  forbidden?: string[];
}

export interface ArchitectureGuard {
  /** The calling script's `import.meta.url`; the package root is the directory above it. */
  root: string;
  /** The composition root, relative to the package root: "src/main.ts" or "src/mod.ts". */
  entry: string;
  rules: FenceRule[];
  /** Where the reader is pointed when the guard fails: "docs/architecture.md". */
  docs?: string;
}

export interface SelfContainedGuard {
  /** The calling script's `import.meta.url`; the package root is the directory above it. */
  root: string;
  /** The closing line of a failure: what the package is, and why that rules the edge out. */
  failure: string;
}

/** A module's direct edges: the resolved target when there is one, else the text as written. */
interface Edge {
  target: string;
  resolved: boolean;
}

function directDeps(module: Module): Edge[] {
  return (module.dependencies ?? []).map((dep) => ({
    target: dep.code?.specifier ?? dep.specifier,
    resolved: dep.code?.specifier !== undefined,
  }));
}

const isLocal = (spec: string): boolean => spec.startsWith("file://");
const toPath = (spec: string): string => isLocal(spec) ? fromFileUrl(spec) : spec;

function paths(root: string) {
  // fromFileUrl, not .pathname: a checkout path with a space (or on Windows) would otherwise keep
  // its percent-encoding and every stat/readdir would miss.
  const packageRoot = fromFileUrl(new URL("../", root));
  const workspacePackages = fromFileUrl(new URL("../../", root));
  const toRel = (spec: string): string => {
    const path = toPath(spec);
    if (path.startsWith(packageRoot)) return path.slice(packageRoot.length);
    if (path.startsWith(workspacePackages)) return `../${path.slice(workspacePackages.length)}`;
    return path;
  };
  return { packageRoot, toRel };
}

async function listTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listTsFiles(`${path}/`)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A path → direct-edges map for everything `entries` reach. The composition root reaches the
 * fenced files in one pass; any file it does not (dead code) is resolved on its own, so nothing
 * escapes the fence unchecked.
 */
function buildGraph(entries: string[], files: string[]): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const add = (modules: Module[]) => {
    for (const module of modules) {
      if (module.specifier) graph.set(toPath(module.specifier), directDeps(module));
    }
  };
  for (const entry of entries) add(moduleGraph(entry));
  for (const file of files) {
    if (!graph.has(file)) add(moduleGraph(file));
  }
  return graph;
}

function fail(header: string, violations: string[], closing: string): never {
  violations.sort();
  console.error(`${header} — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`✗ ${v}\n`);
  console.error(closing);
  process.exit(1);
}

/** Fails the process if a fenced scope imports outside its allowance; prints "clean" if none do. */
export async function checkArchitecture(guard: ArchitectureGuard): Promise<void> {
  const { packageRoot, toRel } = paths(guard.root);
  const see = guard.docs ? ` See ${guard.docs}.` : "";

  const scopeFiles = new Map<string, string[]>();
  for (const rule of guard.rules) {
    const dir = `${packageRoot}${rule.scope}`;
    // A moved scope must fail loud, not pass empty.
    if (!(await isDir(dir))) {
      console.error(`ARCHITECTURE GUARD FAILED — fenced scope ${rule.scope} does not exist.`);
      console.error(`A scope moved without updating this guard.${see}`);
      process.exit(1);
    }
    scopeFiles.set(rule.scope, await listTsFiles(dir));
  }

  const graph = buildGraph([`${packageRoot}${guard.entry}`], [...scopeFiles.values()].flat());

  const violations: string[] = [];
  for (const rule of guard.rules) {
    for (const file of scopeFiles.get(rule.scope)!) {
      const from = toRel(`file://${file}`);
      for (const { target, resolved } of graph.get(file) ?? []) {
        if (!resolved) {
          violations.push(`${from}\n  → imports ${target} (unresolved, in ${rule.scope})`);
          continue;
        }
        if (!isLocal(target)) {
          if (rule.forbidden?.some((name) => target.includes(name))) {
            violations.push(`${from}\n  → imports ${target} (forbidden in ${rule.scope})`);
          }
          continue; // other registry + node: built-ins are outside the fence
        }
        const rel = toRel(target);
        if (!rule.allowed.some((allowed) => rel.startsWith(allowed))) {
          violations.push(`${from}\n  → imports ${rel} (outside ${rule.scope})`);
        }
      }
    }
  }

  if (violations.length > 0) {
    fail(
      "ARCHITECTURE GUARD FAILED",
      violations,
      `The core reaches nothing it does not own.${see}`,
    );
  }
  console.log("architecture guard: clean (import graph)");
}

/**
 * Fails the process if any file in src/ imports anything but another file in src/. Not "outside src/" but "anything at all": a registry or node: specifier is
 * as much a dependency as a sibling package.
 */
export async function checkSelfContained(guard: SelfContainedGuard): Promise<void> {
  const { packageRoot, toRel } = paths(guard.root);
  const src = `${packageRoot}src/`;

  const srcFiles = await listTsFiles(src);
  // Every file is its own root: a kit has no composition root, only modules its users import.
  const graph = buildGraph([], srcFiles);

  const violations: string[] = [];
  for (const file of srcFiles) {
    for (const { target } of graph.get(file) ?? []) {
      if (isLocal(target) && toPath(target).startsWith(src)) continue;
      violations.push(`${toRel(`file://${file}`)}\n  → imports ${toRel(target)}`);
    }
  }

  if (violations.length > 0) fail("DEPENDENCY GUARD FAILED", violations, guard.failure);
  console.log("dependency guard: clean (src/ imports nothing)");
}
