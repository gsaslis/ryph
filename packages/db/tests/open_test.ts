// Exercises the driver factory against a real embedded Postgres. No postgres:// coverage here
// on purpose — that needs a server, and the compose stack is where that gets exercised.

import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { MAX_LOCK_KEY, openDb, openDbCluster, rowsOf } from "../src/open.ts";
import { DbUrlError } from "../src/url.ts";

const kv = pgTable("kv", {
  k: text("k").primaryKey(),
  v: jsonb("v").$type<{ n: number }>(),
});
const schema = { kv };

/** One turn of the event loop, twice over — long enough for the driver to deliver a NOTIFY it
 * has already received, without pinning the suite to a wall-clock delay. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The DDL, applied directly: this suite tests the handle, not the migration tooling. */
async function createSchema(db: Awaited<ReturnType<typeof openDb<typeof schema>>>["db"]) {
  await db.execute(sql`create table if not exists kv (k text primary key, v jsonb)`);
}

test("pglite:memory:// opens a real PostgreSQL and round-trips jsonb", async () => {
  const handle = await openDb("pglite:memory://", schema);
  try {
    const version = await handle.db.execute(sql`select version() as v`);
    const text = String((version as unknown as { rows?: { v: string }[] }).rows?.[0]?.v ?? "");
    assertEquals(text.startsWith("PostgreSQL 17"), true, text);

    await createSchema(handle.db);
    await handle.db.insert(kv).values({ k: "a", v: { n: 1 } });
    const rows = await handle.db.select().from(kv).where(eq(kv.k, "a"));
    // jsonb arrives as a live object, which is why the store adapters need no mapping layer.
    assertEquals(rows[0].v, { n: 1 });
    assertEquals(handle.description, "pglite (in memory)");
  } finally {
    await handle.close();
  }
});

test("close() is idempotent", async () => {
  const handle = await openDb("pglite:memory://", schema);
  await handle.close();
  await handle.close();
});

test("a bad URL fails before anything is opened", async () => {
  await assertRejects(() => openDb("ryph.db", schema), DbUrlError);
  await assertRejects(() => openDb("memory", schema), DbUrlError);
});

test("a pglite path persists across handles, and creates its missing parent", async () => {
  // The parent-directory rule: PGlite makes only the LEAF directory and throws a bare ENOENT if
  // the parent is absent — which is exactly `pglite:./data/ryph` on a fresh machine. If this
  // test regresses, a downloaded binary fails on first launch in an empty directory.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const dataDir = `${root}/nested/deeper/ryph`;
  try {
    const first = await openDb(`pglite:${dataDir}`, schema);
    await createSchema(first.db);
    await first.db.insert(kv).values({ k: "kept", v: { n: 7 } });
    assertEquals(first.description, `pglite ${dataDir}`);
    await first.close();

    const second = await openDb(`pglite:${dataDir}`, schema);
    try {
      const rows = await second.db.select().from(kv).where(eq(kv.k, "kept"));
      assertEquals(rows.length, 1, "the row written by the previous handle should survive");
      assertEquals(rows[0].v, { n: 7 });
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the W6 concurrency primitives are available on pglite", async () => {
  // Advisory locks, SKIP LOCKED and LISTEN/NOTIFY are what the N>1 fixes are built from. They
  // work here so those adapters can be developed and tested in Mode A, with no cluster.
  const handle = await openDb("pglite:memory://", schema);
  try {
    await createSchema(handle.db);
    const lock = await handle.db.execute(sql`select pg_try_advisory_lock(4242) as got`);
    assertEquals((lock as unknown as { rows: { got: boolean }[] }).rows[0].got, true);
    await handle.db.execute(sql`select k from kv for update skip locked`);
    await handle.db.execute(sql`listen ryph_history`);
    await handle.db.execute(sql`notify ryph_history, 'run-1:42'`);
  } finally {
    await handle.close();
  }
});

test("a cluster scopes one connection to several schemas", async () => {
  // The single-process shape: three modules' tables in one database, opened ONCE. Two PGlite
  // instances on one data directory silently diverge instead of erroring, so this is the only
  // safe way for host to mount the control plane, auth and model keys against one URL.
  const other = pgTable("other", { id: text("id").primaryKey() });
  const cluster = await openDbCluster("pglite:memory://");
  try {
    const a = cluster.scope({ kv });
    const b = cluster.scope({ other });
    await a.execute(sql`create table kv (k text primary key, v jsonb)`);
    await b.execute(sql`create table other (id text primary key)`);

    await a.insert(kv).values({ k: "shared", v: { n: 1 } });
    await b.insert(other).values({ id: "x" });

    // The proof it is one database: each scope sees the other's table.
    assertEquals(
      (await a.execute(sql`select count(*)::int as n from other`) as never as {
        rows: { n: number }[];
      }).rows[0].n,
      1,
    );
    assertEquals(
      (await b.execute(sql`select count(*)::int as n from kv`) as never as {
        rows: { n: number }[];
      }).rows[0].n,
      1,
    );
  } finally {
    await cluster.close();
  }
});

test("closing a cluster is idempotent and kills every scope", async () => {
  const cluster = await openDbCluster("pglite:memory://");
  const scoped = cluster.scope({ kv });
  await scoped.execute(sql`create table kv (k text primary key, v jsonb)`);
  await cluster.close();
  await cluster.close();
  await assertRejects(() => scoped.execute(sql`select 1`));
});

test("migrate() applies generated SQL and is idempotent across handles", async () => {
  // The binary's whole schema story: the binary carries the migrations folder (unpacked from its
  // archive, packages/ryph/src/resources.ts) and this runs at boot, every boot. drizzle-kit cannot be involved — it is a CLI that carries
  // esbuild — so a regression here means a downloaded binary cannot provision its own database.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const dataDir = `${root}/ryph`;
  const folder = new URL("./fixture_migrations", import.meta.url).pathname;
  try {
    const first = await openDb(`pglite:${dataDir}`, schema);
    await first.migrate(folder);
    await first.db.insert(kv).values({ k: "a", v: { n: 1 } });
    await first.close();

    // Second boot: the migration is recorded, so it no-ops rather than failing on CREATE TABLE.
    const second = await openDb(`pglite:${dataDir}`, schema);
    try {
      await second.migrate(folder);
      const rows = await second.db.select().from(kv).where(eq(kv.k, "a"));
      assertEquals(rows.length, 1, "re-migrating must not wipe or fail");
      assertEquals(rows[0].v, { n: 1 });
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("notify reaches a listener on the same database", async () => {
  const handle = await openDb("pglite:memory://", schema);
  try {
    const seen: string[] = [];
    const unlisten = await handle.listen("ryph_test", (payload) => seen.push(payload));
    await handle.notify("ryph_test", "r-123:7");
    // The driver delivers on its own turn of the loop, not inside notify().
    await settle();
    assertEquals(seen, ["r-123:7"]);

    await unlisten();
    await handle.notify("ryph_test", "after");
    await settle();
    assertEquals(seen, ["r-123:7"], "an unsubscribed listener kept receiving");
    // Idempotent: a stream that stops twice must not tear down whoever subscribed after it.
    await unlisten();
  } finally {
    await handle.close();
  }
});

test("a throwing listener does not take the subscription down with it", async () => {
  const handle = await openDb("pglite:memory://", schema);
  try {
    const seen: string[] = [];
    await handle.listen("ryph_test", (payload) => {
      seen.push(payload);
      throw new Error("a consumer with a bug");
    });
    await handle.notify("ryph_test", "one");
    await settle();
    await handle.notify("ryph_test", "two");
    await settle();
    assertEquals(seen, ["one", "two"]);
  } finally {
    await handle.close();
  }
});

test("a lock session grants and releases", async () => {
  // On PGlite there is one session, so this asserts the calls work and release cleanly rather
  // than that they exclude anyone — exclusion needs two connections, which needs a server. The
  // compose stack is where the cross-replica half is exercised.
  const handle = await openDb("pglite:memory://", schema);
  const lock = await handle.lockSession();
  try {
    assertEquals(await lock.tryLock(4711), true);
    await lock.unlock(4711);
    assertEquals(await lock.tryLock(4711), true);
    // A caller that keeps a lock between ticks asks whether it still has it rather than going by
    // what it once took. There is one session here, so the answer is the one `tryLock` gives.
    assertEquals(await lock.held(4711), true);
    assertEquals(await lock.held(9999), true);
    await lock.unlock(4711);
    // Releasing a key this session never took is not an error.
    await lock.unlock(9999);
    // A key past the low half of a 64-bit advisory key is refused at the door, because `held`
    // could not ask about it exactly — `pg_locks` reports the two halves apart.
    await assertRejects(() => lock.tryLock(MAX_LOCK_KEY + 1), RangeError, "lock key must be");
    await assertRejects(() => lock.held(-1), RangeError, "lock key must be");
  } finally {
    await lock.close();
    await lock.close();
    await handle.close();
  }
});

test("rowsOf reads a raw execute the same way under either driver's shape", async () => {
  const handle = await openDb("pglite:memory://", schema);
  try {
    // PGlite: `{ rows, … }`
    const result = await handle.db.execute(sql`select 1::int as n`);
    assertEquals(rowsOf<{ n: number }>(result), [{ n: 1 }]);
  } finally {
    await handle.close();
  }
  // postgres-js: the row array itself, with extra fields hung on it
  const list = Object.assign([{ n: 2 }], { count: 1, command: "SELECT" });
  assertEquals([...rowsOf<{ n: number }>(list)], [{ n: 2 }]);
  assertThrows(() => rowsOf({ count: 0 }));
});
