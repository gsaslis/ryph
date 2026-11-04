// The automations → orchestrator events door over a real socket: what a fire's outcome is when
// the door answers with no body at all.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { createServer } from "node:http";
import { httpEventSink } from "../src/adapters/event_sink/http.ts";
import type { AutomationEvent } from "../src/core/types.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";

const silent: Diagnostics = { debug() {}, warn() {} };

// Served, not stubbed: only a FETCHED empty body `.json()`s to `null` under Bun, and a refusal
// read as a crash would be retried forever instead of dropped.
test("an empty 400 or 422 is a terminal refusal, an empty 200 a start", async () => {
  let status = 400;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(status).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const { port } = server.address() as { port: number };
    const sink = httpEventSink({
      orchestratorUrl: `http://127.0.0.1:${port}`,
      automationsToken: "t",
      diag: silent,
    });
    // The door's answer is what is under test; the event itself is never looked at.
    const event = {} as AutomationEvent;
    for (const refused of [400, 422]) {
      status = refused;
      assertEquals(await sink.deliver(event), {
        kind: "failed",
        message: `status ${refused}`,
        terminal: true,
      });
    }
    status = 200;
    assertEquals(await sink.deliver(event), {
      kind: "ok",
      outcome: "started",
      taskId: null,
      runId: null,
      detail: null,
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
