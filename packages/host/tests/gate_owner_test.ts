// The run gate's owner label: one deployment, one owner, whatever this boot's connection looks
// like — and no pretend identity for a database that does not outlive the process.

import { test } from "bun:test";
import { assertEquals, assertNotEquals } from "@std/assert";
import { EPHEMERAL_GATE_OWNER } from "@ryph/orchestrator";
import { resolve } from "@std/path";
import { dbIdentity, gateOwner } from "../src/gate_owner.ts";

test("an in-memory database is the ephemeral owner, the same every boot", async () => {
  assertEquals(dbIdentity("pglite:memory://"), null);
  assertEquals(await gateOwner("pglite:memory://"), EPHEMERAL_GATE_OWNER);
  assertEquals(await gateOwner("pglite:memory://"), await gateOwner("pglite:memory://"));
});

test("a PGlite directory is one owner however it was named", async () => {
  assertEquals(dbIdentity("pglite:./data/ryph"), `pglite ${resolve("./data/ryph")}`);
  assertEquals(
    await gateOwner("pglite:./data/ryph"),
    await gateOwner(`pglite:${resolve("data/ryph")}`),
  );
  assertNotEquals(await gateOwner("pglite:./data/ryph"), await gateOwner("pglite:./data/other"));
});

test("a Postgres database is scheme, host, port and name — not how this boot connects", async () => {
  const base = await gateOwner("postgres://ryph:pw@db.local:5432/ryph");
  assertEquals(await gateOwner("postgres://ryph:pw@db.local:5432/ryph?max=4"), base);
  assertEquals(await gateOwner("postgresql://other:rotated@DB.local/ryph?sslmode=require"), base);
  assertNotEquals(await gateOwner("postgres://ryph:pw@db.local:5433/ryph"), base);
  assertNotEquals(await gateOwner("postgres://ryph:pw@db.local:5432/other"), base);
  assertNotEquals(await gateOwner("postgres://ryph:pw@db2.local:5432/ryph"), base);
  // A unix socket names its host in the query.
  assertEquals(
    dbIdentity("postgres://ryph@/ryph?host=/run/postgresql&max=2"),
    "postgres /run/postgresql 5432 ryph",
  );
});
