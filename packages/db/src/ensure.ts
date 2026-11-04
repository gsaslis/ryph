// Creates a service's database if the server does not have it — each module's migrate job runs
// this (scripts/ensure_database.ts, one per database) before drizzle-kit. It exists for
// PRE-EXISTING stacks: compose's init-databases.sql hook only fires on an EMPTY data directory, so
// a deployment that predates a module would otherwise need a `compose:reset` (deleting its data)
// before that module could boot. Idempotent and race-safe: "already exists" is success.

import postgres from "postgres";

/**
 * Creates the database `process.env[envName]` names, then exits the process when there is nothing
 * to do or the target is unusable: 2 when the variable is unset or the name is refused, 0 for an
 * embedded (`pglite:`) target, which creates itself.
 */
export async function ensureDatabase(envName: string): Promise<void> {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    console.error(`${envName} is not set`);
    process.exit(2);
  }
  if (raw.startsWith("pglite:")) process.exit(0); // embedded targets create themselves

  const target = new URL(raw);
  const dbName = target.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
    console.error(`refusing to create a database named ${JSON.stringify(dbName)}`);
    process.exit(2);
  }

  // The server's maintenance database — always present on the postgres image.
  const admin = new URL(raw);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1 });
  try {
    const [{ present }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS present`;
    if (present) {
      console.log(`database ${dbName} already exists`);
    } else {
      try {
        await sql.unsafe(`CREATE DATABASE "${dbName}"`);
        console.log(`created database ${dbName}`);
      } catch (err) {
        // 42P04 duplicate_database: another job won the race — exactly as good as winning it.
        if ((err as { code?: string }).code !== "42P04") throw err;
        console.log(`database ${dbName} already exists (created concurrently)`);
      }
    }
  } finally {
    await sql.end();
  }
}
