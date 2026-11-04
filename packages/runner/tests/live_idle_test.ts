// The live feeds outlast Bun's fetch idle timeout. Each is one streamed upload the historian
// answers only when it ends, and Bun's fetch gave up on a response that long in coming (300 s by
// default, firing on a coarse tick, so every six minutes on GKE) whatever bytes went up meanwhile.
// Deno's fetch had no such timeout. The fixture runs both feeds in a process of its own with that
// timeout cut to one second (it fires at about eight), and holds them past it.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { command } from "@ryph/process";

const PACKAGE = new URL("..", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/live_idle.ts", import.meta.url).pathname;

test("live feeds: neither the commands uplink nor the browser relay is cut by fetch's idle timeout", async () => {
  const out = await command(process.execPath, {
    args: ["--no-env-file", FIXTURE],
    cwd: PACKAGE,
    env: { BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", HOLD_MS: "11000" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `stderr:\n${stderr}`);
  const seen: { sessions: Record<string, number>; events: string[] } = JSON.parse(
    new TextDecoder().decode(out.stdout),
  );
  assertEquals(seen.events, [], "a feed dropped");
  assertEquals(seen.sessions, { "/commands": 1, "/browser": 1 });
});
