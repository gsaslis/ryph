// The endpoint-row locks between a guarded key write and an endpoint move, against a REAL
// Postgres: PGlite runs every query on one session, so two transactions never meet there and the
// tests in sealing_test.ts pass with the locks deleted. Skipped unless RYPH_TEST_POSTGRES_URL
// names a server this test may create and drop databases on, e.g.
// `postgres://postgres:pw@127.0.0.1:5432/postgres`.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import postgres from "postgres";
import { freshPostgresDb } from "@ryph/db/testing";
import { makeModelProxyDb } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { drizzleKeyStore } from "../src/adapters/store/drizzle.ts";
import { customProviderSpec, endpointShape } from "../src/core/registry.ts";

const url = process.env.RYPH_TEST_POSTGRES_URL;
const T0 = "2026-01-01T00:00:00.000Z";
const WAIT_MS = 300;

test.skipIf(!url)(
  "a guarded key write waits for an endpoint move in flight, and is refused once it lands",
  async () => {
    const ddl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    const db = await freshPostgresDb(url!, ddl);
    const handle = await makeModelProxyDb(db.url);
    const other = postgres(db.url, { max: 1, onnotice: () => {} });
    /** The other connection's open transaction, until it commits: rolled back if the test fails
     * first, so the connection is released and the database can be dropped. */
    let open: postgres.ReservedSql | null = null;
    try {
      const store = drizzleKeyStore(handle);
      await store.createCustomProvider({
        id: "groq",
        label: "Groq",
        baseUrl: "https://api.groq.example.com/v1",
        models: [{ id: "llama-4" }],
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: {},
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await store.createProviderKey({
        id: "pk-1",
        provider: "groq",
        label: "k",
        last4: "abcd",
        encryptedSecret: "",
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const shape = endpointShape(customProviderSpec((await store.getCustomProvider("groq"))!));

      // Another connection is moving the endpoint: its row is locked, the new address not yet
      // committed.
      const move = await other.reserve();
      open = move;
      await move`BEGIN`;
      await move`UPDATE custom_providers SET base_url = 'https://moved.example.com/v1'
        WHERE id = 'groq'`;
      let settled = false;
      const write = store.writeProviderKeySealedFor(
        { providerId: "groq", shape },
        { id: "pk-1", patch: { encryptedSecret: "v2.sealed-for-the-old-shape", updatedAt: T0 } },
      ).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, WAIT_MS));
      assertEquals(settled, false, "the write waits on the endpoint row (FOR SHARE)");
      await move`COMMIT`;
      open = null;
      move.release();
      assertEquals(await write, { moved: true });
      assertEquals((await store.getProviderKey("pk-1"))!.encryptedSecret, "");
    } finally {
      if (open !== null) {
        await open`ROLLBACK`.catch(() => {});
        open.release();
      }
      await other.end();
      await handle.close();
      await db.drop();
    }
  },
);
