// The schema step. The downgrade guard is worth real tests because the bug it prevents is silent:
// an older binary finds every migration it knows already applied, has nothing to do, and starts
// happily against tables it does not agree with. The real sets are worth one because several
// share a database here, and a mistake in how they are tracked skips migrations without a word.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type DbCluster, openDbCluster } from "@ryph/db";
import { sql } from "drizzle-orm";
import { MIGRATION_SETS } from "../src/embedded.ts";
import {
  appliedMigrationCount,
  applySchema,
  assertNotDowngrade,
  embeddedMigrationCount,
  type MigrationSet,
} from "../src/schema_guard.ts";

const FIXTURE: MigrationSet = {
  name: "fixture",
  dir: new URL("./fixture_migrations", import.meta.url).pathname,
  table: "__drizzle_migrations_fixture",
};

test("counts the migrations this build ships", async () => {
  assertEquals(await embeddedMigrationCount(FIXTURE.dir), 2);
});

test("a database never migrated reports null, not zero", async () => {
  // The distinction matters: null means "no bookkeeping table", which is a first launch and
  // must not be mistaken for a downgrade.
  const cluster = await openDbCluster("pglite:memory://");
  try {
    assertEquals(await appliedMigrationCount(cluster, FIXTURE.table), null);
  } finally {
    await cluster.close();
  }
});

test("a fresh database passes the guard and reports what is pending", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  try {
    assertEquals(await assertNotDowngrade(cluster, FIXTURE), { applied: 0, embedded: 2 });
  } finally {
    await cluster.close();
  }
});

test("a fully migrated database passes with equal counts", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  try {
    await cluster.migrate(FIXTURE.dir, FIXTURE.table);
    assertEquals(await appliedMigrationCount(cluster, FIXTURE.table), 2);
    assertEquals(await assertNotDowngrade(cluster, FIXTURE), { applied: 2, embedded: 2 });
  } finally {
    await cluster.close();
  }
});

test("a database from a NEWER build is refused, and the error says what to do", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  try {
    await cluster.migrate(FIXTURE.dir, FIXTURE.table);
    // What a newer ryph would have left behind: one more applied migration than we know.
    await cluster.scope({}).execute(
      sql.raw(
        `insert into drizzle."${FIXTURE.table}" (hash, created_at) values ('future', 1790000000000)`,
      ),
    );
    const err = await assertRejects(() => assertNotDowngrade(cluster, FIXTURE), Error);
    assertStringIncludes(err.message, "NEWER ryph");
    assertStringIncludes(err.message, "fixture tables have 3 migrations applied");
    assertStringIncludes(err.message, "this build only knows 2");
    // The actionable half — without this the message is just a refusal.
    assertStringIncludes(err.message, "Upgrade ryph");
  } finally {
    await cluster.close();
  }
});

async function tableExists(cluster: DbCluster, table: string): Promise<boolean> {
  const result = await cluster.scope({}).execute(
    sql.raw(`select to_regclass('public.${table}') is not null as present`),
  );
  return (result as unknown as { rows: { present: boolean }[] }).rows[0].present;
}

test("every set this build carries applies into one database, each tracked apart", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  try {
    const first = await applySchema(MIGRATION_SETS, cluster, null);
    assertEquals(first.applied, 0);
    assert(first.embedded >= MIGRATION_SETS.length);

    // Each set's own table holds exactly its own journal. One shared table would have let the
    // newest set's timestamp stand in for the others', and skipped them.
    for (const set of MIGRATION_SETS) {
      assertEquals(
        await appliedMigrationCount(cluster, set.table),
        await embeddedMigrationCount(set.dir),
        set.name,
      );
    }
    for (const table of ["runs", "users", "provider_keys", "mcp_servers", "history_events"]) {
      assert(await tableExists(cluster, table), table);
    }

    // The next boot: nothing to do, and nothing refused.
    assertEquals(await applySchema(MIGRATION_SETS, cluster, null), {
      applied: first.embedded,
      embedded: first.embedded,
    });
  } finally {
    await cluster.close();
  }
});

test("the historian's set goes to the transcript's own database when it has one", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  const history = await openDbCluster("pglite:memory://");
  try {
    await applySchema(MIGRATION_SETS, cluster, history);
    assert(await tableExists(history, "history_events"));
    assert(!(await tableExists(cluster, "history_events")));
    assert(await tableExists(cluster, "runs"));
    assert(!(await tableExists(history, "runs")));
  } finally {
    await cluster.close();
    await history.close();
  }
});
