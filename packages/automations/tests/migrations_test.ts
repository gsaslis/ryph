// The committed migration files, applied in order over rows that already exist, then compared
// with the schema: what the files build must be what the code expects, or the migrate job
// wedges the deploy — and a data migration must leave every row in the shape the code reads.

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";
import * as webhooksSchema from "@ryph/webhooks/schema";
import { makeAutomationsDb } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";

const DIR = new URL("../drizzle/", import.meta.url);

async function migrations(): Promise<Array<{ tag: string; statements: string[] }>> {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", DIR), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return Promise.all(journal.entries.map(async ({ tag }) => ({
    tag,
    statements: (await readFile(new URL(`${tag}.sql`, DIR), "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  })));
}

/** An automation in the columns the FIRST migration made. */
const SEED = `INSERT INTO "automations"
  ("id","owner_user_id","name","enabled","trigger","agent_id","connected_repo_id","instructions","created_at","updated_at")
  VALUES ('atm-1','u-1','checkout latency',true,'{"kind":"webhook"}','agt-1','cr-1','look','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`;

/** A response policy as saved before `channelId` existed — Telegram's, or no room at all. */
const LEGACY_RESPONSE =
  `UPDATE "automations" SET "response" = '{"chatroomId":"chr-1","idleMs":300000,"attendedIdleMs":1800000}'`;

/** Rows as saved after 0004 and before 0005: a hmac webhook, a secret-header webhook with a
 * policy, and a schedule — none with a format, a secret source, a header prefix or a
 * correlation. */
const PRE_FORMAT_ROWS = `INSERT INTO "automations"
  ("id","owner_user_id","name","enabled","trigger","agent_id","target","instructions","response","created_at","updated_at")
  VALUES
  ('atm-hmac','u-1','hmac',true,'{"kind":"webhook","verification":{"kind":"hmac-sha256","header":"x-ryph-signature","prefix":"sha256=","secret":"s1"},"rateLimit":{"maxPerWindow":1,"windowMs":60000}}','agt-1','{"kind":"workspace","workspaceId":"ws-1"}','look',NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
  ('atm-header','u-1','header',true,'{"kind":"webhook","verification":{"kind":"secret-header","header":"authorization","secret":"s2"},"rateLimit":{"maxPerWindow":1,"windowMs":60000}}','agt-1','{"kind":"workspace","workspaceId":"ws-1"}','look','{"chatroomId":null,"channelId":null,"idleMs":300000,"attendedIdleMs":1800000}','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
  ('atm-cron','u-1','cron',true,'{"kind":"schedule","cron":"0 9 * * *","timezone":"UTC"}','agt-1','{"kind":"workspace","workspaceId":"ws-1"}','look','{"chatroomId":null,"channelId":null,"idleMs":300000,"attendedIdleMs":1800000}','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`;

test("every migration applies over rows that already exist, and they build the schema", async () => {
  const handle = await makeAutomationsDb("pglite:memory://");
  try {
    const all = await migrations();
    assertEquals(all.length >= 6, true);
    for (const migration of all) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      if (migration.tag.startsWith("0000_")) await handle.db.execute(sql.raw(SEED));
      // The column arrives in 0003; a policy written before 0004 has no `channelId`.
      if (migration.tag.startsWith("0003_")) await handle.db.execute(sql.raw(LEGACY_RESPONSE));
      if (migration.tag.startsWith("0004_")) await handle.db.execute(sql.raw(PRE_FORMAT_ROWS));
    }
    const everyRow = await handle.db.execute(
      sql`select "id", "trigger", "response" from "automations" order by "id"`,
    ) as unknown as {
      rows: Array<
        { id: string; trigger: Record<string, unknown>; response: Record<string, unknown> | null }
      >;
    };
    const byId = new Map(everyRow.rows.map((r) => [r.id, r]));
    const rows = { rows: everyRow.rows.filter((r) => r.id === "atm-1") };
    assertEquals(rows.rows.length, 1);
    // A policy from before channels existed names no channel, and says so: the app and the
    // orchestrator read the field as required, never defaulted.
    assertEquals(rows.rows[0].response, {
      chatroomId: "chr-1",
      idleMs: 300000,
      attendedIdleMs: 1800000,
      channelId: null,
      correlation: "automation",
      conversation: "per-response",
    });

    // 0005: every webhook reads its fires as Alertmanager did implicitly, every secret was
    // minted, a secret header had no prefix, and every policy joined per automation — so
    // nothing behaves differently after it.
    assertEquals(byId.get("atm-hmac")!.trigger, {
      kind: "webhook",
      format: { kind: "alertmanager" },
      verification: {
        kind: "hmac-sha256",
        header: "x-ryph-signature",
        prefix: "sha256=",
        secret: "s1",
        secretSource: "minted",
      },
      rateLimit: { maxPerWindow: 1, windowMs: 60000 },
    });
    assertEquals(byId.get("atm-hmac")!.response, null);
    assertEquals(byId.get("atm-header")!.trigger, {
      kind: "webhook",
      format: { kind: "alertmanager" },
      verification: {
        kind: "secret-header",
        header: "authorization",
        prefix: "",
        secret: "s2",
        secretSource: "minted",
      },
      rateLimit: { maxPerWindow: 1, windowMs: 60000 },
    });
    assertEquals(byId.get("atm-header")!.response?.correlation, "automation");
    // A schedule gains no format, and its policy keeps today's behaviour too.
    assertEquals(byId.get("atm-cron")!.trigger, {
      kind: "schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    assertEquals(byId.get("atm-cron")!.response?.correlation, "automation");
    // 0007: every policy opened a conversation per response, and still does.
    assertEquals(byId.get("atm-header")!.response?.conversation, "per-response");
    assertEquals(byId.get("atm-cron")!.response?.conversation, "per-response");
    assertEquals(byId.get("atm-hmac")!.response, null, "no policy gains one");
    // The first seed's trigger predates verification entirely; 0005 must not trip over it.
    assertEquals(byId.get("atm-1")!.trigger.format, { kind: "alertmanager" });
    // The first migration made the mailroom's table too (the two share a database, as
    // tests/db.ts explains), so the comparison is against both schemas.
    const { statementsToExecute } = await pushSchema(
      { ...schema, ...webhooksSchema },
      handle.db as never,
    );
    assertEquals(statementsToExecute, []);
  } finally {
    await handle.close();
  }
});
