// Tool inputs: the contract's fields, refs in the snapshot's shape, addresses normalised, and
// the JSON Schema tools/list carries derived from the same schemas.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { ClickArgs, EvaluateArgs, normaliseUrl, WaitForArgs } from "../src/core/schema.ts";
import { TOOLS } from "../src/mcp/tools.ts";

test("the contract's tools are listed, by their contract names", () => {
  assertEquals(TOOLS.map((t) => t.name), [
    "navigate",
    "back",
    "forward",
    "reload",
    "snapshot",
    "click",
    "type",
    "press_key",
    "hover",
    "select_option",
    "scroll",
    "wait_for",
    "screenshot",
    "evaluate",
    "add_init_script",
    "console_messages",
    "network_requests",
    "tabs",
    "resize",
  ]);
  const click = TOOLS.find((t) => t.name === "click")!.inputSchema as { required: string[] };
  assertEquals(click.required, ["ref", "element"]);
});

test("refs look like the snapshot's", () => {
  assert(ClickArgs.safeParse({ ref: "e12", element: "Save" }).success);
  assert(ClickArgs.safeParse({ ref: "f1e3", element: "Inner" }).success);
  assert(!ClickArgs.safeParse({ ref: "#save", element: "Save" }).success);
  assert(!ClickArgs.safeParse({ ref: "e1", element: "" }).success);
});

test("evaluate's timeout is bounded at 30 s", () => {
  assert(EvaluateArgs.safeParse({ function: "() => 1", timeoutMs: 30_000 }).success);
  assert(!EvaluateArgs.safeParse({ function: "() => 1", timeoutMs: 30_001 }).success);
});

test("wait_for takes exactly one thing to wait for", () => {
  assert(WaitForArgs.safeParse({ text: "Done" }).success);
  assert(WaitForArgs.safeParse({ seconds: 2 }).success);
  assert(!WaitForArgs.safeParse({}).success);
  assert(!WaitForArgs.safeParse({ text: "a", seconds: 1 }).success);
  assert(!WaitForArgs.safeParse({ seconds: 31 }).success);
});

test("addresses: a bare host gets http, only http(s) and about:blank open", () => {
  assertEquals(normaliseUrl("localhost:5173/x"), { ok: true, url: "http://localhost:5173/x" });
  assertEquals(normaliseUrl("https://example.com"), { ok: true, url: "https://example.com/" });
  assertEquals(normaliseUrl("about:blank"), { ok: true, url: "about:blank" });
  assert(!normaliseUrl("file:///etc/passwd").ok);
  assert(!normaliseUrl("chrome://settings").ok);
  assert(!normaliseUrl("javascript:alert(1)").ok);
});
