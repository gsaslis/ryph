// `stop` waits for a reconcile the timers started. The host closes its database right after it,
// and a pass still writing cursors then fails halfway through — so stopping means the pass is
// over, not merely that no new one will begin.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { makeEventConsumer } from "../src/core/events.ts";
import { memoryCursorStore } from "../src/adapters/cursor_store/memory.ts";
import { recordingEventSink } from "../src/adapters/event_sink/recording.ts";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import type { RadicleService } from "../src/core/service.ts";
import type { NodeControl, NodeStreamItem } from "../src/ports/node.ts";
import type { RadExec } from "../src/ports/rad.ts";

test("stop waits for a reconcile its timer started", async () => {
  let calls = 0;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let timerPassStarted = () => {};
  const started = new Promise<void>((r) => (timerPassStarted = r));
  const service = {
    retryPendingUnseeds: () => Promise.resolve(),
    // The first pass (the loop's own, at start) is instant; the timer's hangs until released.
    seededRepos: async () => {
      if (++calls === 1) return [];
      timerPassStarted();
      await held;
      return [];
    },
  } as unknown as RadicleService;
  const node = {
    // A stream that stays open until the consumer aborts it.
    async *subscribe(signal?: AbortSignal): AsyncIterable<NodeStreamItem> {
      await new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
      yield { kind: "eof", reason: "aborted" };
    },
  } as unknown as NodeControl;
  const consumer = makeEventConsumer({
    service,
    exec: {} as RadExec,
    node,
    cursors: memoryCursorStore(),
    sink: recordingEventSink(),
    diag: SILENT_DIAGNOSTICS,
    reconcileIntervalMs: 10,
    pullIntervalMs: 3_600_000,
  });
  consumer.start();
  await started;

  let stopped = false;
  const stopping = consumer.stop().then(() => (stopped = true));
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(stopped, false, "stop returned while a reconcile was still running");
  release();
  await stopping;
  assertEquals(stopped, true);
});
