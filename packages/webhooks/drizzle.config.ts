import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_* database URLs: it would read `pglite:./data/webhooks`
// as a postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded
// target becomes driver "pglite" over a bare data directory, a server target a plain connection
// URL. Inlined rather than importing @ryph/db's parseDbUrl, so drizzle-kit loads this config
// with nothing but itself. Keep the two in step.
//
// This config is for whatever process MOUNTS this module. The forge mounts it, and in the
// networked deployment its table lives in `ryph_forge` (the compose migrate-webhooks job
// runs this).
const raw = (process.env.RYPH_WEBHOOKS_DB ?? "pglite:./data/webhooks").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error(
    "RYPH_WEBHOOKS_DB=pglite:memory:// has nothing to push to — name a data directory",
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
  schema: ["./src/adapters/store/db/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  // Its own bookkeeping table, like every set's. The binary does not mount the webhooks module,
  // but the networked deployment applies all five sets the same way.
  migrations: { schema: "drizzle", table: "__drizzle_migrations_webhooks" },
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
