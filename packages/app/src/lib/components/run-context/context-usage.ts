import { z } from "zod";
import type { HistoryEvent } from "$lib/api/types";

const count = z.number().finite().nonnegative();
const schema = z.object({
  status: z.enum(["ready", "compacting", "recalculating", "unavailable"]),
  tokens: count.nullable(),
  contextWindow: z.number().finite().positive().nullable(),
  percent: count.nullable(),
}).refine((value) =>
  value.status !== "ready" ||
  (value.tokens !== null && value.contextWindow !== null && value.percent !== null)
);

export type ContextUsage = z.infer<typeof schema>;

/** A small, allowlisted snapshot, not Pi's cumulative billing statistics. */
export function contextUsageOf(event: HistoryEvent): ContextUsage | null {
  if (event.voice !== "transcript" || event.kind !== "system" || event.text !== "context_usage") {
    return null;
  }
  const parsed = schema.safeParse(event.payload);
  return parsed.success ? parsed.data : null;
}
