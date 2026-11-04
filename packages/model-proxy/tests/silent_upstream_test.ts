// A model call outlasts Bun's fetch idle timeout. A reasoning model can stay silent for minutes
// before its first byte (and a non-streamed answer comes only whole), and Bun's fetch gave up on
// a response that long silent (300 s by default, firing on a coarse tick) where Deno's had no such
// timeout. The fixture runs the proxy in a process of its own with that timeout cut to one second
// (it fires at about eight) and holds both kinds of call past it.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PACKAGE = new URL("..", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/silent_upstream.ts", import.meta.url).pathname;

test("a model call silent past fetch's idle timeout is relayed whole, streamed or not", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-env-file", FIXTURE], {
    cwd: PACKAGE,
    env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", HOLD_MS: "11000" },
  });
  assertEquals(JSON.parse(stdout), {
    whole: '200 {"answer":"after a long think"}',
    streamed: "200 event: message_start\n\nevent: message_stop\n\n",
  });
});
