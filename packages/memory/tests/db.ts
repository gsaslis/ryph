// A fresh in-memory database per test, schema applied the same way local dev does: pushed
// straight from db/schema.ts (drizzle-kit's programmatic push), no migration files.
//
// `pglite:memory://` rather than a hand-rolled fake: it is the real production driver over real
// PostgreSQL 17, so these tests exercise the same SQL — full-text search included — the deployed
// thing runs. `pushSchema` must run on PGlite; against the postgres-js driver it exits the
// process silently, which is why the default reaches for no server.
//
// RYPH_TEST_DB=postgres://… runs the same suite over postgres-js instead: each test gets a database
// of its own on that server, copied from a template the committed migration set was applied to
// once (@ryph/db/testing's `cloneTestDb`), and dropped on close. The database the URL names is
// never written to.

import { fileURLToPath } from "node:url";
import { pushSchema } from "drizzle-kit/api";
import { openClonedTestDb } from "@ryph/db/testing";
import { makeMemoryDb, type MemoryDbHandle } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";

const MIGRATIONS = [{
  folder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  table: "__drizzle_migrations_memory",
}];

export async function makeTestDb(): Promise<MemoryDbHandle> {
  const server = process.env.RYPH_TEST_DB;
  if (server) return await openClonedTestDb(server, MIGRATIONS, makeMemoryDb);
  const handle = await makeMemoryDb("pglite:memory://");
  const { apply } = await pushSchema(schema, handle.db as never);
  await apply();
  return handle;
}
