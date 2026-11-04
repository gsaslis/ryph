// A fresh in-memory database per test, schema applied the same way local dev does:
// pushed straight from db/schema.ts (drizzle-kit's programmatic push), no migration files.
//
// `pglite:memory://` rather than a hand-rolled fake: it is the real production driver over
// real PostgreSQL 17, so these tests exercise the same SQL the deployed thing runs. Note that
// `pushSchema` must run on PGlite — against the postgres-js driver it exits the process
// silently, which is why the default reaches for no server.
//
// RYPH_TEST_DB=postgres://… runs the same suites over postgres-js instead: each test gets a
// database of its own on that server, copied from a template the committed migration set was
// applied to once (@ryph/db/testing's `cloneTestDb`), and dropped on close. The database the URL
// names is never written to.

import { fileURLToPath } from "node:url";
import { pushSchema } from "drizzle-kit/api";
import { openClonedTestDb } from "@ryph/db/testing";
import { type HistorianDbHandle, makeHistorianDb } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";

const MIGRATIONS = [{
  folder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  table: "__drizzle_migrations_historian",
}];

export async function makeTestDb(): Promise<HistorianDbHandle> {
  const server = process.env.RYPH_TEST_DB;
  if (server) return await openClonedTestDb(server, MIGRATIONS, makeHistorianDb);
  const handle = await makeHistorianDb("pglite:memory://");
  // The cast is drizzle-kit's own looseness: pushSchema takes a driver-specific handle type,
  // and ours is deliberately driver-erased.
  const { apply } = await pushSchema(schema, handle.db as never);
  await apply();
  return handle;
}
