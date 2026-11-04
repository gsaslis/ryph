import { rm, stat } from "node:fs/promises";
import type { StackBackend } from "../backend.ts";
import { listRuns, removeContainers } from "../docker.ts";
import { hostDatabases } from "../hostdb.ts";
import { repoRoot } from "../stack.ts";
import { confirm, dim, green, red } from "../ui.ts";
import { down } from "./down.ts";

/** Data domains `reset` can wipe; selecting none selects all of them. */
export const scopes = ["db", "forge", "runs"] as const;
export type Scope = (typeof scopes)[number];

/**
 * The one destructive verb: wipes the selected data domains — `db` (control-plane and history
 * databases), `forge` (the forge data root), `runs` (agent run containers). Lists everything and
 * confirms before touching anything; the stack is stopped first when file-backed state is in
 * scope. .env files, node_modules, and images are never touched.
 */
export async function reset(
  backend: StackBackend,
  names: string[],
  yes: boolean,
): Promise<number> {
  const selected = new Set<Scope>(
    names.length > 0 ? (names as Scope[]) : scopes,
  );

  // Whole DIRECTORIES now, not a file plus sqlite's -wal/-shm sidecars: a `pglite:` store is a
  // PostgreSQL cluster on disk. A store with no local directory — in memory, or a postgres://
  // server — is not this command's to drop, and is skipped rather than half-handled.
  const dbDirs: string[] = [];
  if (selected.has("db")) {
    for (const db of await hostDatabases()) {
      if (db.dir !== null && await exists(db.dir)) dbDirs.push(db.dir);
    }
  }
  const forgeData = `${repoRoot}/packages/forge/forge-data`;
  const hasForgeData = selected.has("forge") && (await exists(forgeData));
  const runs = selected.has("runs") ? (await listRuns()) ?? [] : [];

  if (dbDirs.length === 0 && !hasForgeData && runs.length === 0) {
    console.log(dim("nothing to reset"));
    return 0;
  }

  console.log("will delete:");
  for (const d of dbDirs) console.log(`  ${rel(d)}/ ${dim("(the whole cluster)")}`);
  if (hasForgeData) {
    console.log(`  ${rel(forgeData)}/ ${dim("(cache, staging, patches)")}`);
  }
  for (const r of runs) {
    console.log(`  container ryph-run-${r.runId} ${dim(`(${r.state})`)}`);
  }

  if (!yes && !confirm(red(`reset ${[...selected].join(", ")}?`))) {
    console.log(dim("aborted"));
    return 1;
  }

  if (dbDirs.length > 0 || hasForgeData) await down(backend, []);
  // recursive: a PGlite data directory is a populated cluster, not one file.
  for (const d of dbDirs) await rm(d, { recursive: true });
  if (hasForgeData) await rm(forgeData, { recursive: true });
  await removeContainers(runs.map((r) => r.id));
  console.log(
    green("reset complete") +
      (selected.has("db") ? dim(" · ./dev init to re-init") : ""),
  );
  return 0;
}

const rel = (path: string) => path.replace(`${repoRoot}/`, "");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
