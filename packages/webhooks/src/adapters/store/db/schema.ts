// The webhook shelf: one row per ingested hook, full body included. Columns mirror
// core/types.ts field-for-field so rows need no mapping.
//
// `body` is text, NOT jsonb, on purpose: the row holds the raw bytes the signature was
// verified over. Parsing is the consumer's job, and normalizing through jsonb would silently
// rewrite what "raw" means the day a payload isn't canonical JSON.
//
// `seq` is the FIFO key: bigserial, assigned on insert, monotonic per table (and therefore
// per queue). A queue is one (registration_id, scope): `scope` is the scope a
// `derived-secret-header` door verified, null for every other row, and NULLs are one queue.
// The head lookup is `webhooks_live_by_queue`: live rows only, in seq order per queue, so the
// head is the index's first entry — no sort, and no walk over a queue's delivered past.
// `webhooks_terminal_by_age` is the retention prune's (`retainTerminalMs`), and
// `webhooks_delivered_by_key` the dedupe's (`WebhookRegistration.dedupeKey`): only a delivered row
// carries a key, so the index holds those and nothing else.

import { sql } from "drizzle-orm";
import { bigserial, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { HookState } from "../../../core/types.ts";

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  registrationId: text("registration_id").notNull(),
  scope: text("scope"),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  headers: jsonb("headers").$type<Record<string, string>>().notNull(),
  body: text("body").notNull(),
  state: text("state").$type<HookState>().notNull(),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: text("next_attempt_at"),
  leaseExpiresAt: text("lease_expires_at"),
  lastError: text("last_error"),
  receivedAt: text("received_at").notNull(),
  deliveredAt: text("delivered_at"),
  updatedAt: text("updated_at").notNull(),
  dedupeKey: text("dedupe_key"),
}, (t) => [
  uniqueIndex("webhooks_by_registration_seq").on(t.registrationId, t.seq),
  // The head lookup: lowest live seq for one (registration, scope) queue, and every queue's at once
  // (`getDueQueues`' loose index scan walks it queue by queue).
  index("webhooks_live_by_queue").on(t.registrationId, t.scope, t.seq)
    .where(sql`${t.state} in ('pending', 'delivering')`),
  index("webhooks_terminal_by_age").on(t.registrationId, t.updatedAt)
    .where(sql`${t.state} in ('delivered', 'exhausted')`),
  index("webhooks_delivered_by_key").on(t.registrationId, t.scope, t.dedupeKey)
    .where(sql`${t.dedupeKey} is not null`),
]);
