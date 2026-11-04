import { mkdirSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit does not speak our RYPH_DB URLs: it would read `pglite:./data/ryph` as a
// postgres:// URL and open a TCP connection to nowhere. So this translates — an embedded target
// becomes driver "pglite" over a bare data directory, a server target a plain connection URL.
//
// Inlined rather than importing @ryph/db's parseDbUrl: drizzle-kit loads this config through
// its own CommonJS loader, and a config that imports nothing loads under any of them. Keep the two
// in step.
const raw = (process.env.RYPH_DB ?? "pglite:./data/ryph").trim();
const embedded = raw.startsWith("pglite:");
const dataDir = raw.slice("pglite:".length);
if (embedded && (dataDir === "memory://" || dataDir === "memory:" || dataDir === "")) {
  // Pushing into a database that dies with the command would silently do nothing.
  throw new Error("RYPH_DB=pglite:memory:// has nothing to push to — name a data directory");
}

// Every schema sharing the single-process deployment's database: the orchestrator's own
// tables, @ryph/auth's, @ryph/model-proxy's, @ryph/mcp-gateway's, @ryph/memory's, @ryph/chat's,
// @ryph/radicle's, and — unlike under SQLite — the historian's, which now shares this instance in
// Mode A. One push covers the whole host.
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
  schema: [
    "../orchestrator/src/adapters/store/db/schema.ts",
    "../auth/src/adapters/store/db/schema.ts",
    "../model-proxy/src/adapters/store/db/schema.ts",
    "../mcp-gateway/src/adapters/store/db/schema.ts",
    "../historian/src/adapters/store/db/schema.ts",
    "../automations/src/adapters/store/db/schema.ts",
    "../webhooks/src/adapters/store/db/schema.ts",
    "../memory/src/adapters/store/db/schema.ts",
    "../chat/src/adapters/store/db/schema.ts",
    // The Radicle bridge's cursors and tracked repositories, for RYPH_RADICLE_URL=embedded.
    "../radicle/src/adapters/cursor_store/db/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  ...(embedded
    ? { driver: "pglite" as const, dbCredentials: { url: dataDir } }
    : { dbCredentials: { url: raw } }),
} satisfies Config;
