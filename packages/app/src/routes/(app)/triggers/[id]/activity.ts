// A trigger's history as a person reads it: one row per run it started (a response, when the run
// is one) and one row per fire that started nothing. The fire log itself is one row per request,
// so a response that twenty fires joined was twenty identical lines.

import type { AutomationFire, ResponseListItem } from "$lib/api/types";

export type ActivityRow =
  | {
    kind: "response";
    key: string;
    /** When the first fire of it arrived, and the last. */
    at: string;
    lastAt: string;
    taskId: string;
    response: ResponseListItem;
  }
  | { kind: "run"; key: string; at: string; lastAt: string; taskId: string; fires: number }
  | {
    kind: "skipped";
    key: string;
    at: string;
    lastAt: string;
    label: string;
    detail: string | null;
  };

/** Why a fire started nothing, in words. */
export const SKIPPED_LABEL: Record<string, string> = {
  resolved: "Resolved, nothing open",
  ignored: "Status update, nothing open",
  refused: "Refused",
  denied: "Denied",
  "no-such-agent": "Agent not found",
  "no-such-repo": "Repository not found",
  "no-such-workspace": "Workspace not found",
  "no-linked-identity": "No linked account",
  "rate-limited": "Rate limited",
  undeliverable: "Couldn't be delivered",
};

/**
 * The rows, most recently active first, so a response still taking fires stays at the top
 * however long ago it opened. `responses` may hold other triggers' responses; only this one's
 * tasks are matched.
 */
export function activityRows(
  fires: AutomationFire[],
  responses: ResponseListItem[],
): ActivityRow[] {
  const byTask = new Map<string, AutomationFire[]>();
  const rows: ActivityRow[] = [];
  for (const fire of fires) {
    if (fire.taskId === null) {
      rows.push({
        kind: "skipped",
        key: fire.id,
        at: fire.firedAt,
        lastAt: fire.firedAt,
        label: SKIPPED_LABEL[fire.outcome] ?? fire.outcome,
        detail: fire.detail,
      });
      continue;
    }
    const group = byTask.get(fire.taskId) ?? [];
    group.push(fire);
    byTask.set(fire.taskId, group);
  }
  const responseByTask = new Map(responses.map((r) => [r.taskId, r]));
  for (const [taskId, group] of byTask) {
    const times = group.map((f) => f.firedAt).sort();
    const at = times[0];
    const lastAt = times[times.length - 1];
    const response = responseByTask.get(taskId);
    rows.push(
      response
        ? { kind: "response", key: taskId, at, lastAt, taskId, response }
        : { kind: "run", key: taskId, at, lastAt, taskId, fires: group.length },
    );
  }
  // One row per run, and one per fire that started nothing: each hook that was received and
  // turned away is its own line, so none of them hides behind another.
  return rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** How long a response lasted, to the minute: "under a minute", "47 min", "2 h 5 min". */
export function lasted(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
