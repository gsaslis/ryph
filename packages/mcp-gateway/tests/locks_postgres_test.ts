// The row lock behind a compare-and-set edit of a server, against a REAL Postgres: PGlite runs
// every query on one session, so two transactions never meet there and the race tests in
// sealing_test.ts pass with the lock deleted. Skipped unless RYPH_TEST_POSTGRES_URL names a
// server this test may create and drop databases on, e.g.
// `postgres://postgres:pw@127.0.0.1:5432/postgres`.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import postgres from "postgres";
import { freshPostgresDb } from "@ryph/db/testing";
import { makeMcpGatewayDb } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { drizzleGatewayStore } from "../src/adapters/store/drizzle.ts";
import { server, T0 } from "./fixtures.ts";

const url = process.env.RYPH_TEST_POSTGRES_URL;
const WAIT_MS = 300;

test.skipIf(!url)(
  "a compare-and-set edit waits for a write in flight, and judges what it committed",
  async () => {
    const ddl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    const db = await freshPostgresDb(url!, ddl);
    const handle = await makeMcpGatewayDb(db.url);
    const other = postgres(db.url, { max: 1, onnotice: () => {} });
    /** The other connection's open transaction, until it commits: rolled back if the test fails
     * first, so the connection is released and the database can be dropped. */
    let open: postgres.ReservedSql | null = null;
    try {
      const store = drizzleGatewayStore(handle);
      await store.createServer(server({ url: "https://old.example.com/mcp" }));

      // Another connection is repointing the row: locked, the new url not yet committed.
      const edit = await other.reserve();
      open = edit;
      await edit`BEGIN`;
      await edit`UPDATE mcp_servers SET url = 'https://new.example.com/mcp' WHERE id = 'ms-1'`;
      let settled = false;
      const guarded = store.updateServerIf(
        "ms-1",
        { encryptedAuth: "v2.sealed-for-the-old-url", updatedAt: T0 },
        (current) => Promise.resolve(current.url === "https://old.example.com/mcp"),
      ).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, WAIT_MS));
      assertEquals(
        settled,
        false,
        "the guarded edit finished while another connection held the row uncommitted — its read " +
          "must lock the row (SELECT … FOR UPDATE) and wait",
      );
      await edit`COMMIT`;
      open = null;
      edit.release();
      assertEquals(await guarded, "changed");
      assertEquals((await store.getServer("ms-1"))!.encryptedAuth, server().encryptedAuth);
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
