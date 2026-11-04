// `ryph backup` / `ryph restore` over PGlite's own dump and load.
//
// This is the whole reason a single-file database is worth having: the backup is one tarball that
// PGlite itself produced, so restoring it needs no pg_restore, no version matching, and nothing
// installed. Both go straight through the driver rather than through @ryph/db, because neither
// wants a drizzle handle and both are pglite-only by nature. They still take @ryph/db's data
// directory lock, so neither runs against a database a live `ryph up` holds.
//
// Backup takes an EXCLUSIVE turn on the database. PGlite is single-connection, so `dumpDataDir`
// serialises behind every other query and blocks the process while it runs — which is why these
// are offline commands rather than something the running server exposes. On a live instance a
// long dump would delay heartbeats, and heartbeats delayed past their timeout get runs marked
// lost and their containers killed. Stopping the server first is not a limitation to work around.

import { mkdir, readFile, stat } from "node:fs/promises";
import type { PGlite, PGliteOptions } from "@electric-sql/pglite";
import { describeDbTarget, lockDataDir, parseDbUrl } from "@ryph/db";
import { writeSecretFile } from "@ryph/service";

/** Opens the data directory, dumps it to `outPath`, and closes. Refuses a non-pglite URL. */
export async function backup(dbUrl: string, outPath: string): Promise<{ bytes: number }> {
  const dataDir = pgliteDataDir(dbUrl, "back up");
  return await withLockedPglite(dataDir, {}, async (client) => {
    // A no-op query first: PGlite starts Postgres lazily, and dumping before it has booted
    // produces a directory that has never been initialised.
    await client.query("select 1");
    const dump = await client.dumpDataDir("gzip");
    const bytes = new Uint8Array(await dump.arrayBuffer());
    // Owner-only: the dump holds every session, sealed secret and password hash.
    await writeSecretFile(outPath, bytes);
    return { bytes: bytes.byteLength };
  });
}

/**
 * Loads a dump into `dbUrl`'s data directory. REPLACES whatever is there, so the caller confirms
 * first — this function does not prompt, and there is no undo.
 */
export async function restore(dbUrl: string, inPath: string): Promise<void> {
  const dataDir = pgliteDataDir(dbUrl, "restore into");
  const bytes = await readFile(inPath);
  // PGlite creates only the LEAF of its data path. Without this, restoring onto a machine that
  // has never run ryph — which is the main reason anyone restores — died on a bare ENOENT
  // mkdir naming a path the user never typed.
  const parent = dataDir.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  if (parent !== "" && parent !== dataDir) await mkdir(parent, { recursive: true });
  // loadDataDir replaces the directory's contents at construction, before Postgres starts.
  await withLockedPglite(dataDir, { loadDataDir: new Blob([bytes]) }, async (client) => {
    // Proves the restored directory actually boots, rather than reporting success on a corrupt
    // tarball and failing on the next `ryph up`.
    await client.query("select 1");
  });
}

/**
 * How many sealed provider keys a database holds — the rows a backup carries but the key that
 * opens them does not. Zero (and no error) when the table is absent, which is a database from
 * before the model proxy existed or one that was never migrated.
 */
export async function countSealedKeys(dbUrl: string): Promise<number> {
  const dataDir = pgliteDataDir(dbUrl, "inspect");
  return await withLockedPglite(dataDir, {}, async (client) => {
    try {
      const res = await client.query<{ n: number }>(
        "select count(*)::int as n from provider_keys where archived_at is null",
      );
      return Number(res.rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  });
}

/** Whether the data directory already holds a database — used to warn before a restore. */
export async function dataDirExists(dbUrl: string): Promise<boolean> {
  const dataDir = pgliteDataDir(dbUrl, "inspect");
  try {
    return (await stat(`${dataDir}/PG_VERSION`)).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs `use` on a PGlite client over `dataDir`, holding the data directory lock from before the
 * client is constructed until after it is closed. A constructor that throws (a corrupt
 * `loadDataDir` tarball, say) still gives the lock back.
 */
async function withLockedPglite<T>(
  dataDir: string,
  options: Omit<PGliteOptions, "dataDir">,
  use: (client: PGlite) => Promise<T>,
): Promise<T> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lock = await lockDataDir(dataDir);
  try {
    const client = new PGlite({ ...options, dataDir });
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  } finally {
    await lock.release();
  }
}

function pgliteDataDir(dbUrl: string, verb: string): string {
  const target = parseDbUrl(dbUrl);
  if (target.kind !== "pglite" || target.dataDir === null) {
    throw new Error(
      `cannot ${verb} ${describeDbTarget(target)} — backup and restore are for an embedded ` +
        "on-disk database (pglite:<path>). For a Postgres server use pg_dump/pg_restore, " +
        "which know how to do this online.",
    );
  }
  return target.dataDir;
}
