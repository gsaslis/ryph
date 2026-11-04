import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_* database URLs: it would read `pglite:./data/automations`
// as a postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded
// target becomes driver "pglite" over a bare data directory, a server target a plain connection
// URL. Inlined rather than importing @ryph/db's parseDbUrl, so drizzle-kit loads this config
// with nothing but itself. Keep the two in step.
//
// Two schema files, one push: the automations tables plus the webhooks table the mounted
// mailroom brings — both live in this package's database, so both are named here by relative
// path (a workspace-name import would not survive drizzle-kit's loader).
const raw = (process.env.RYPH_AUTOMATIONS_DB ?? "pglite:./data/automations").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error(
    "RYPH_AUTOMATIONS_DB=pglite:memory:// has nothing to push to — name a data directory",
  );
}

// PGlite creates only the LEAF of its data path and throws a bare ENOENT mkdir if the parent is
// missing. @ryph/db does this for the runtime; it is inlined here too, so this config loads
// with nothing but drizzle-kit. The PARENT only:
// pre-creating the leaf can read to PGlite as an already-initialised cluster.
if (embedded) {
  const cut = dataDir.replace(/\/+$/, "").lastIndexOf("/");
  if (cut > 0) mkdirSync(dataDir.slice(0, cut), { recursive: true });
}

export default {
  schema: [
    "./src/adapters/store/db/schema.ts",
    "../webhooks/src/adapters/store/db/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  // Its own bookkeeping table, not drizzle's shared default: the binary applies this set into
  // one database beside its siblings' sets, and sharing the default table would make the
  // migrator skip whichever set ran second. Also named in the binary's MIGRATION_SETS.
  migrations: { schema: "drizzle", table: "__drizzle_migrations_automations" },
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
