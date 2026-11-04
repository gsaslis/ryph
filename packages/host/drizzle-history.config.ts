import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_DB URLs: it would read `pglite:./data/ryph` as a
// postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded target
// becomes driver "pglite" over a bare data directory, a server target a plain connection URL.
//
// Inlined rather than importing @ryph/db's parseDbUrl: drizzle-kit loads this config through
// its own CommonJS loader, and a config that imports nothing loads under any of them. Keep the two
// in step.
const raw = (process.env.RYPH_HISTORY_DB ?? "pglite:./data/ryph-history").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error(
    "RYPH_HISTORY_DB=pglite:memory:// has nothing to push to — name a data directory",
  );
}

// The historian against a database of ITS OWN — the Mode B split, and only that. In Mode A the
// transcript shares the control plane's instance and ./drizzle.config.ts already covers it, so
// this config is for a deployment that sets RYPH_HISTORY_DB.
// PGlite creates only the LEAF of its data path and throws a bare ENOENT mkdir if the parent is
// missing — which is exactly `./data/ryph` on a checkout that has never run ryph, i.e. the
// first thing anyone does. @ryph/db does this for the runtime; drizzle-kit loads this config
// through its own CommonJS loader, so it is inlined here too, as above.
// The PARENT only: pre-creating the leaf can read to PGlite as an already-initialised cluster.
if (embedded) {
  const cut = dataDir.replace(/\/+$/, "").lastIndexOf("/");
  if (cut > 0) mkdirSync(dataDir.slice(0, cut), { recursive: true });
}

export default {
  schema: ["../historian/src/adapters/store/db/schema.ts"],
  out: "./drizzle-history",
  dialect: "postgresql",
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
