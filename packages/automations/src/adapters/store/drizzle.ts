// `AutomationStore` over drizzle. The only mapping worth a comment happens at the trigger:
// the union's config rides the jsonb column, while the scheduler's clock (`nextDueAt`,
// `lastFiredAt`) rides its own indexed columns — split on write, rejoined on read.

import { and, desc, eq, lte } from "drizzle-orm";
import type { Automation, AutomationTrigger } from "../../core/types.ts";
import type { AutomationStore } from "../../ports/automation_store.ts";
import type { AutomationsDb } from "./db/db.ts";
import * as schema from "./db/schema.ts";

type AutomationRow = typeof schema.automations.$inferSelect;

function toRow(a: Automation): AutomationRow {
  const { trigger } = a;
  return {
    id: a.id,
    ownerUserId: a.ownerUserId,
    name: a.name,
    enabled: a.enabled,
    trigger: trigger.kind === "webhook"
      ? {
        kind: "webhook",
        format: trigger.format,
        verification: trigger.verification,
        rateLimit: trigger.rateLimit,
      }
      : { kind: "schedule", cron: trigger.cron, timezone: trigger.timezone },
    nextDueAt: trigger.kind === "schedule" ? trigger.nextDueAt : null,
    lastFiredAt: trigger.kind === "schedule" ? trigger.lastFiredAt : null,
    agentId: a.agentId,
    target: a.target,
    instructions: a.instructions,
    response: a.response,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function toAutomation(row: AutomationRow): Automation {
  const trigger: AutomationTrigger = row.trigger.kind === "webhook"
    ? {
      kind: "webhook",
      format: row.trigger.format!,
      verification: row.trigger.verification!,
      rateLimit: row.trigger.rateLimit!,
    }
    : {
      kind: "schedule",
      cron: row.trigger.cron!,
      timezone: row.trigger.timezone!,
      nextDueAt: row.nextDueAt,
      lastFiredAt: row.lastFiredAt,
    };
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    enabled: row.enabled,
    trigger,
    agentId: row.agentId,
    target: row.target,
    instructions: row.instructions,
    // A policy stored before `postAlert` existed reads as off, and one stored before
    // `conversation` as a conversation per response — the data migration that fills both is
    // never run on a database built with db:push.
    response: row.response === null ? null : {
      ...row.response,
      postAlert: row.response.postAlert ?? false,
      conversation: row.response.conversation ?? "per-response",
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function drizzleAutomationStore(db: AutomationsDb): AutomationStore {
  return {
    async createAutomation(automation) {
      await db.insert(schema.automations).values(toRow(automation));
    },
    async getAutomation(id) {
      const row = await db.query.automations.findFirst({
        where: (a, { eq }) => eq(a.id, id),
      });
      return row === undefined ? null : toAutomation(row);
    },
    async listAutomationsByOwner(ownerUserId) {
      const rows = await db.query.automations.findMany({
        where: (a, { eq }) => eq(a.ownerUserId, ownerUserId),
        orderBy: (a, { desc }) => desc(a.createdAt),
      });
      return rows.map(toAutomation);
    },
    async listAutomations() {
      const rows = await db.query.automations.findMany({
        orderBy: (a, { desc }) => desc(a.createdAt),
      });
      return rows.map(toAutomation);
    },
    async listEnabledAutomations() {
      const rows = await db.select().from(schema.automations)
        .where(eq(schema.automations.enabled, true));
      return rows.map(toAutomation);
    },
    async listDueSchedules(nowIso) {
      const rows = await db.select().from(schema.automations)
        .where(and(
          eq(schema.automations.enabled, true),
          lte(schema.automations.nextDueAt, nowIso),
        ));
      return rows.map(toAutomation).filter((a) => a.trigger.kind === "schedule");
    },
    async saveAutomation(automation) {
      const { id: _key, createdAt: _born, ...revisable } = toRow(automation);
      await db.update(schema.automations).set(revisable)
        .where(eq(schema.automations.id, automation.id));
    },
    async advanceScheduleClock(id, clock) {
      await db.update(schema.automations).set({
        nextDueAt: clock.nextDueAt,
        lastFiredAt: clock.lastFiredAt,
        updatedAt: clock.updatedAt,
      }).where(eq(schema.automations.id, id));
    },
    async deleteAutomation(id) {
      await db.delete(schema.automationFires)
        .where(eq(schema.automationFires.automationId, id));
      await db.delete(schema.automations).where(eq(schema.automations.id, id));
    },
    async recordFire(fire) {
      await db.insert(schema.automationFires).values(fire).onConflictDoNothing();
    },
    async listFires(automationId, limit) {
      return await db.select().from(schema.automationFires)
        .where(eq(schema.automationFires.automationId, automationId))
        .orderBy(desc(schema.automationFires.firedAt))
        .limit(limit);
    },
  };
}
