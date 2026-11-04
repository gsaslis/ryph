import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { piContext } from "../src/adapters/harness/pi_context.ts";

type Event = Record<string, unknown>;
function setup() {
  const sent: Event[] = [];
  const emitted: Event[] = [];
  const observe = piContext((command) => {
    sent.push(command);
    return Promise.resolve();
  }, (event) => emitted.push(event));
  const respond = (contextUsage: unknown, id = sent.at(-1)?.id) =>
    observe({
      type: "response",
      command: "get_session_stats",
      id,
      success: true,
      data: { contextUsage, tokens: { total: 9_000_000 }, cost: 123 },
    });
  return { sent, emitted, observe, respond };
}

test("pi context: samples boundaries and emits only current context, never billing", () => {
  const { sent, emitted, observe, respond } = setup();
  observe({ type: "agent_start" });
  assertEquals(sent[0].type, "get_session_stats");
  respond({ tokens: 60_000, contextWindow: 200_000, percent: 30 });
  assertEquals(emitted, [{
    type: "context_usage",
    status: "ready",
    tokens: 60_000,
    contextWindow: 200_000,
    percent: 30,
  }]);
  observe({ type: "message_update" });
  assertEquals(sent.length, 1);
  observe({ type: "turn_end" });
  assertEquals(sent.length, 2);
});

test("pi context: compaction invalidates pending stats, then waits for fresh usage", () => {
  const { sent, emitted, observe, respond } = setup();
  observe({ type: "agent_start" });
  const before = sent[0].id;
  observe({ type: "compaction_start" });
  respond({ tokens: 190_000, contextWindow: 200_000, percent: 95 }, before);
  assertEquals(emitted.at(-1)?.status, "compacting");
  observe({ type: "turn_end" });
  assertEquals(sent.length, 1);
  observe({ type: "compaction_end", aborted: false });
  respond({ tokens: null, contextWindow: 200_000, percent: null });
  assertEquals(emitted.at(-1), {
    type: "context_usage",
    status: "recalculating",
    tokens: null,
    contextWindow: 200_000,
    percent: null,
  });
  observe({ type: "turn_end" });
  respond({ tokens: 30_000, contextWindow: 200_000, percent: 15 });
  assertEquals(emitted.at(-1)?.status, "ready");
});

test("pi context: stale responses cannot overwrite newer snapshots", () => {
  const { sent, emitted, observe, respond } = setup();
  observe({ type: "agent_start" });
  observe({ type: "turn_end" });
  respond({ tokens: 0, contextWindow: 200_000, percent: 0 });
  respond({ tokens: 100, contextWindow: 200_000, percent: 1 }, sent[0].id);
  assertEquals(emitted.length, 1);
  assertEquals(emitted[0].tokens, 0);
});

test("pi context: a closed stdin at settle preserves the last ready snapshot", async () => {
  const emitted: Event[] = [];
  let request: Event = {};
  let closed = false;
  const observe = piContext((command) => {
    request = command;
    return closed ? Promise.reject(new Error("closed stdin")) : Promise.resolve();
  }, (event) => emitted.push(event));
  observe({ type: "agent_start" });
  observe({
    type: "response",
    command: "get_session_stats",
    id: request.id,
    success: true,
    data: { contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 } },
  });
  closed = true;
  observe({ type: "turn_end" });
  await Promise.resolve();
  assertEquals(emitted.length, 1);
  assertEquals(emitted[0].status, "ready");
});

test("pi context: missing, malformed and rejected stats are unavailable, not fatal", async () => {
  const { emitted, sent, observe, respond } = setup();
  for (const usage of [undefined, {}, { tokens: -1, percent: 1, contextWindow: 200_000 }]) {
    observe({ type: "turn_end" });
    respond(usage);
    assertEquals(emitted.at(-1)?.status, "unavailable");
  }
  observe({ type: "turn_end" });
  assertEquals(
    observe({
      type: "response",
      command: "get_session_stats",
      id: sent.at(-1)?.id,
      success: false,
    }),
    true,
  );
  assertEquals(emitted.at(-1)?.status, "unavailable");
  const broken = piContext(() => Promise.reject(new Error("closed stdin")), (e) => emitted.push(e));
  broken({ type: "turn_end" });
  await Promise.resolve();
  assertEquals(emitted.at(-1)?.status, "unavailable");
});
