// The automations shelves: one row per recipe, one row per fire. The mounted mailroom's
// `webhooks` table lives in the same database — drizzle.config.ts names both schema files, so
// one push migrates all three tables.
//
// The trigger's config rides as jsonb, but the scheduler's clock does not: `next_due_at` is
// its own indexed column, so the tick is one cheap query instead of a jsonb scan.

import { boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type {
  AutomationTarget,
  FireOutcome,
  ResponsePolicy,
  TriggerRateLimit,
  TriggerVerification,
} from "../../../core/types.ts";
import type { WebhookFormat } from "../../../core/formats.ts";

/** The trigger minus the scheduler's clock, which lives in its own columns. A webhook's
 * `format` and its verification's `secretSource` were backfilled by 0005 for rows older than
 * them, so every webhook row carries both. */
export interface StoredTrigger {
  kind: "webhook" | "schedule";
  format?: WebhookFormat;
  verification?: TriggerVerification;
  rateLimit?: TriggerRateLimit;
  cron?: string;
  timezone?: string;
}

export const automations = pgTable("automations", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull(),
  trigger: jsonb("trigger").$type<StoredTrigger>().notNull(),
  nextDueAt: text("next_due_at"),
  lastFiredAt: text("last_fired_at"),
  agentId: text("agent_id").notNull(),
  // A repo (with a ref) or a workspace — a small union, carried but never queried into.
  target: jsonb("target").$type<AutomationTarget>().notNull(),
  instructions: text("instructions").notNull(),
  // The response policy — a chatroom, two idle clocks, a correlation — carried, never queried
  // into. Null
  // is the ordinary automation: a run per fire.
  response: jsonb("response").$type<ResponsePolicy>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("automations_by_owner").on(t.ownerUserId),
  // The scheduler tick's one query: enabled schedules whose clock has run out.
  index("automations_by_due").on(t.enabled, t.nextDueAt),
]);

export const automationFires = pgTable("automation_fires", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  outcome: text("outcome").$type<FireOutcome>().notNull(),
  taskId: text("task_id"),
  runId: text("run_id"),
  detail: text("detail"),
  firedAt: text("fired_at").notNull(),
}, (t) => [
  index("automation_fires_by_automation").on(t.automationId, t.firedAt),
]);
