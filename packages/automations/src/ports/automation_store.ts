import type { Automation, Fire } from "../core/types.ts";

/** Persistence for the recipes and the fire history. The mailroom's hooks live beside these
 * tables in the same database, behind @ryph/webhooks' own store. */
export interface AutomationStore {
  createAutomation(automation: Automation): Promise<void>;
  getAutomation(id: string): Promise<Automation | null>;
  /** Newest first: one owner's automations, which is all a plain member may list. */
  listAutomationsByOwner(ownerUserId: string): Promise<Automation[]>;
  /** Newest first, everyone's: what `automations:manage-all` lists. */
  listAutomations(): Promise<Automation[]>;
  /** Every enabled automation — the boot-time registry sync's worklist. */
  listEnabledAutomations(): Promise<Automation[]>;
  /** Enabled schedule-triggered automations whose `nextDueAt` is at or before `nowIso`. */
  listDueSchedules(nowIso: string): Promise<Automation[]>;
  saveAutomation(automation: Automation): Promise<void>;
  /** Advances only the scheduler's clock columns — one targeted UPDATE, so a recipe revision
   * landing while a fire is in flight is never overwritten by the tick's stale copy. */
  advanceScheduleClock(
    id: string,
    clock: { nextDueAt: string | null; lastFiredAt: string; updatedAt: string },
  ): Promise<void>;
  deleteAutomation(id: string): Promise<void>;

  recordFire(fire: Fire): Promise<void>;
  /** Newest first, capped by `limit`. */
  listFires(automationId: string, limit: number): Promise<Fire[]>;
}
