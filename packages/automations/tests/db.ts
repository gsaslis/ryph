// A fresh in-memory database per test, schema applied the same way local dev does: both
// schema files — this package's tables and the mailroom's — pushed programmatically, exactly
// as one `db:push` does against the real database. One PGlite instance, two scoped handles,
// mirroring how main.ts opens the cluster once and scopes it twice.
//
// RYPH_TEST_DB=postgres://… runs the same suite over postgres-js instead: each test gets a database
// of its own on that server, copied from a template the committed migration set (which carries
// the mailroom's table too) was applied to once (@ryph/db/testing's `cloneTestDb`), and dropped on
// close. The database the URL names is never written to.

import { fileURLToPath } from "node:url";
import { pushSchema } from "drizzle-kit/api";
import { type DbCluster, openDbCluster } from "@ryph/db";
import { openClonedTestDb } from "@ryph/db/testing";
import * as webhooksSchema from "@ryph/webhooks/schema";
import { type AutomationsDbHandle, scopeAutomationsDb } from "../src/adapters/store/db/db.ts";
import * as automationsSchema from "../src/adapters/store/db/schema.ts";

export interface TestDb {
  cluster: DbCluster;
  handle: AutomationsDbHandle;
  close(): Promise<void>;
}

const MIGRATIONS = [{
  folder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  table: "__drizzle_migrations_automations",
}];

export async function makeTestDb(): Promise<TestDb> {
  const server = process.env.RYPH_TEST_DB;
  if (server) {
    return await openClonedTestDb(server, MIGRATIONS, async (url) => {
      const cluster = await openDbCluster(url);
      return { cluster, handle: scopeAutomationsDb(cluster), close: () => cluster.close() };
    });
  }
  const cluster = await openDbCluster("pglite:memory://");
  const handle = scopeAutomationsDb(cluster);
  // The cast is drizzle-kit's own looseness: pushSchema takes a driver-specific handle type,
  // and ours is deliberately driver-erased.
  const { apply } = await pushSchema(
    { ...automationsSchema, ...webhooksSchema },
    handle.db as never,
  );
  await apply();
  return { cluster, handle, close: () => cluster.close() };
}
