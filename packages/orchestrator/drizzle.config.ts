import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_DB URLs: it would read `pglite:./data/ryph` as a
// postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded target
// becomes driver "pglite" over a bare data directory, a server target a plain connection URL.
//
// Inlined rather than importing @ryph/db's parseDbUrl: drizzle-kit loads this config through
// Node's CJS require, which cannot resolve a workspace member. Keep the two in step.
const raw = (process.env.RYPH_DB ?? "pglite:./data/ryph").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error("RYPH_DB=pglite:memory:// has nothing to push to — name a data directory");
}

// Both schemas that share the CONTROL PLANE's database: this package's own tables and
// @ryph/auth's, which are mounted in this process (see src/main.ts). The historian's and the
// model-proxy's are deliberately absent — those services own their own databases.
// PGlite creates only the LEAF of its data path and throws a bare ENOENT mkdir if the parent is
// missing — which is exactly `./data/ryph` on a checkout that has never run ryph, i.e. the
// first thing anyone does. @ryph/db does this for the runtime; drizzle-kit loads this config
// through Node's CJS require and cannot import a workspace member, so it is inlined here too.
// The PARENT only: pre-creating the leaf can read to PGlite as an already-initialised cluster.
if (embedded) {
  const cut = dataDir.replace(/\/+$/, "").lastIndexOf("/");
  if (cut > 0) mkdirSync(dataDir.slice(0, cut), { recursive: true });
}

export default {
  schema: [
    "./src/adapters/store/db/schema.ts",
    "../auth/src/adapters/store/db/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  // Its own bookkeeping table, not drizzle's shared default: the binary applies this set into one
  // database beside other owners' sets, and each must be tracked apart. The same name is in
  // packages/ryph/src/embedded.ts; keep the two in step.
  migrations: { schema: "drizzle", table: "__drizzle_migrations_orchestrator" },
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
