// The binary's schema step: every migration set it carries, guarded, then applied.
//
// The guard refuses a data directory that a NEWER ryph has already migrated. The failure it
// prevents is quiet and bad. Migrations only ever roll forward, so an older binary pointed at a
// newer data directory finds every migration it knows already applied, has nothing to do, and
// starts happily — against tables whose shape it does not agree with. Columns it never learned
// about are ignored on write, so the newer version's rows quietly lose data, and nothing in the
// log says why. Someone re-running an older binary after an upgrade is exactly the person who
// cannot afford that.
//
// It is decided by counting, not by parsing versions: drizzle records one row per applied
// migration in each set's own table, and the binary carries the journal of every set it knows.
// More rows in a set's table than entries in its journal means the directory came from a newer
// build. Equal is normal; fewer means there is migrating to do, which is the ordinary first-launch
// case.

import { readFile } from "node:fs/promises";
import { type DbCluster, rowsOf } from "@ryph/db";
import { sql } from "drizzle-orm";

/** One schema owner's generated migrations, and the table drizzle tracks them in. */
export interface MigrationSet {
  name: string;
  dir: string;
  /** In the `drizzle` schema. Each set needs its own — see `DbCluster.migrate`. */
  table: string;
  /** Applied to the transcript's own database when RYPH_HISTORY_DB gives it one. */
  history?: boolean;
}

interface Journal {
  entries?: { idx?: number; tag?: string }[];
}

/** How many migrations this binary ships in one set. */
export async function embeddedMigrationCount(migrationsDir: string): Promise<number> {
  const raw = await readFile(`${migrationsDir}/meta/_journal.json`, "utf8");
  const journal = JSON.parse(raw) as Journal;
  return journal.entries?.length ?? 0;
}

/**
 * How many migrations of one set the database has already had applied, or null when its
 * bookkeeping table does not exist yet — a set never migrated here, which is not a downgrade.
 */
export async function appliedMigrationCount(
  cluster: DbCluster,
  table: string,
): Promise<number | null> {
  try {
    const result = await cluster.scope({}).execute(
      sql.raw(`select count(*)::int as n from drizzle."${table}"`),
    );
    return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
  } catch {
    // Undefined table. Any other failure would resurface immediately when the migrator runs.
    return null;
  }
}

export interface DowngradeCheck {
  applied: number;
  embedded: number;
}

/**
 * Throws when the database is ahead of this binary for `set`. Call it BEFORE migrating:
 * afterwards the counts have been made equal and the evidence is gone.
 */
export async function assertNotDowngrade(
  cluster: DbCluster,
  set: MigrationSet,
): Promise<DowngradeCheck> {
  const embedded = await embeddedMigrationCount(set.dir);
  const applied = await appliedMigrationCount(cluster, set.table);
  if (applied !== null && applied > embedded) {
    throw new Error(
      `${cluster.description} was migrated by a NEWER ryph — its ${set.name} tables have ` +
        `${applied} migrations applied and this build only knows ${embedded}. Refusing to start: ` +
        "rolling forward is the only supported direction, and running anyway would silently drop " +
        "the columns this build does not know about. Upgrade ryph, or point RYPH_DB at a " +
        "different directory.",
    );
  }
  return { applied: applied ?? 0, embedded };
}

/**
 * Applies every set to the database it belongs in, and says how many migrations there were and
 * how many had already run. Every set is guarded before any is migrated, so a refusal leaves the
 * database exactly as it was found.
 */
export async function applySchema(
  sets: readonly MigrationSet[],
  cluster: DbCluster,
  historyCluster: DbCluster | null,
): Promise<DowngradeCheck> {
  const targets = sets.map((set) => ({
    set,
    db: set.history ? historyCluster ?? cluster : cluster,
  }));
  const total: DowngradeCheck = { applied: 0, embedded: 0 };
  for (const { set, db } of targets) {
    const check = await assertNotDowngrade(db, set);
    total.applied += check.applied;
    total.embedded += check.embedded;
  }
  for (const { set, db } of targets) await db.migrate(set.dir, set.table);
  return total;
}
