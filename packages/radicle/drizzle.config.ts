import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_* database URLs: it would read `pglite:./data/radicle`
// as a postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded
// target becomes driver "pglite" over a bare data directory, a server target a plain connection
// URL. Inlined rather than importing @ryph/db's parseDbUrl: drizzle-kit loads this config
// through its own CJS require, so it stays self-contained. Keep the two in step.
//
// This config is for the bridge's own database (`ryph_radicle` in the networked deployment).
// The single binary applies the same migrations to its own database, as one more set
// (packages/ryph/src/embedded.ts), for the bridge it runs in user mode.
const raw = (process.env.RYPH_RADICLE_DB ?? "pglite:./data/radicle").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error(
    "RYPH_RADICLE_DB=pglite:memory:// has nothing to push to — name a data directory",
  );
}

// PGlite creates only the LEAF of its data path and throws a bare ENOENT mkdir if the parent is
// missing. @ryph/db does this for the runtime; drizzle-kit loads this config through Node's
// CJS require and cannot import a workspace member, so it is inlined here too. The PARENT only:
// pre-creating the leaf can read to PGlite as an already-initialised cluster.
if (embedded) {
  const cut = dataDir.replace(/\/+$/, "").lastIndexOf("/");
  if (cut > 0) mkdirSync(dataDir.slice(0, cut), { recursive: true });
}

export default {
  schema: ["./src/adapters/cursor_store/db/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  // Its own bookkeeping table, like every set's.
  migrations: { schema: "drizzle", table: "__drizzle_migrations_radicle" },
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
