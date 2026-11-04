// One metering trail, shared by the store and route suites so both read the same rows.

import type { UsageRecord } from "../src/core/types.ts";

export function usageRow(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: 200,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    estimated: false,
    durationMs: 10,
    at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

/** Seven requests across three days, two agents, the platform, a failure and an old row. */
export const TRAIL: UsageRecord[] = [
  usageRow(),
  usageRow({ cacheReadTokens: 1_000, at: "2026-09-01T11:00:00.000Z" }),
  usageRow({
    runId: "r-2",
    agentId: "a-2",
    taskId: "t-2",
    providerKeyId: "pk-2",
    provider: "openai",
    model: "gpt-5.5",
    inputTokens: 200_000,
    cacheReadTokens: 100_000, // 300k total input: above the 272k tier
    at: "2026-09-02T09:00:00.000Z",
  }),
  usageRow({
    runId: "r-2",
    agentId: "a-2",
    taskId: "t-2",
    providerKeyId: "pk-2",
    provider: "openai",
    model: "gpt-5.5",
    at: "2026-09-02T09:30:00.000Z",
  }),
  usageRow({
    runId: "platform:memory",
    agentId: null,
    taskId: null,
    model: "claude-haiku-4-5",
    cacheWriteTokens: 400,
    cacheWrite1hTokens: 100,
    reasoningTokens: 20,
    at: "2026-09-02T12:00:00.000Z",
  }),
  usageRow({
    status: 429,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    at: "2026-09-03T08:00:00.000Z",
  }),
  usageRow({ at: "2026-08-01T00:00:00.000Z" }),
];
