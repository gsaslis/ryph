// /configure's body and its one-shot latch.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { mergeBypass, OneShot, parseConfigure, parseSandboxMode } from "../src/core/config.ts";

const token = "k".repeat(64);

test("a configure without a proxy parses", () => {
  assertEquals(parseConfigure(JSON.stringify({ token, proxy: null })), {
    ok: true,
    config: { token, proxy: null, vision: true },
  });
});

test("vision: absent means the model sees images, false is kept, anything else is refused", () => {
  const parse = (vision: unknown) => parseConfigure(JSON.stringify({ token, proxy: null, vision }));
  const absent = parseConfigure(JSON.stringify({ token, proxy: null }));
  assert(absent.ok && absent.config.vision === true);
  const on = parse(true);
  assert(on.ok && on.config.vision === true);
  const off = parse(false);
  assert(off.ok && off.config.vision === false);
  // Beside a proxy too: the proxy branch builds its own config.
  const withProxy = parseConfigure(
    JSON.stringify({ token, proxy: { server: "http://egress:3128" }, vision: false }),
  );
  assert(withProxy.ok && withProxy.config.vision === false);
  for (const bad of ["false", 0, null, {}]) {
    const out = parse(bad);
    assert(!out.ok && out.error.startsWith("vision:"), JSON.stringify(bad));
  }
});

test("the proxy's bypass always includes loopback, ahead of the runner's list", () => {
  const out = parseConfigure(JSON.stringify({
    token,
    proxy: {
      server: "http://egress:3128",
      username: "run-1",
      password: "p",
      bypass: "forge, 127.0.0.1,.svc",
    },
  }));
  assert(out.ok);
  assertEquals(out.config.proxy, {
    server: "http://egress:3128",
    username: "run-1",
    password: "p",
    bypass: "localhost,127.0.0.1,::1,forge,.svc",
  });
});

test("mergeBypass with nothing given is the loopback names", () => {
  assertEquals(mergeBypass(undefined), "localhost,127.0.0.1,::1");
  assertEquals(mergeBypass(" , "), "localhost,127.0.0.1,::1");
});

test("bad bodies are refused with the field named", () => {
  const notJson = parseConfigure("{");
  assert(!notJson.ok);
  const short = parseConfigure(JSON.stringify({ token: "short", proxy: null }));
  assert(!short.ok && short.error.startsWith("token:"));
  const missing = parseConfigure(JSON.stringify({ token }));
  assert(!missing.ok && missing.error.startsWith("proxy:"));
  const noServer = parseConfigure(JSON.stringify({ token, proxy: { bypass: "x" } }));
  assert(!noServer.ok && noServer.error.startsWith("proxy.server:"));
});

test("the latch is claimed exactly once", () => {
  const shot = new OneShot<string>();
  assertEquals(shot.value, null);
  assert(shot.claim("first"));
  assert(!shot.claim("second"));
  assertEquals(shot.value, "first");
});

test("the sandbox mode: unset tries then falls back, two words decide, anything else is refused", () => {
  assertEquals(parseSandboxMode(undefined), { ok: true, mode: "auto" });
  assertEquals(parseSandboxMode(""), { ok: true, mode: "auto" });
  assertEquals(parseSandboxMode("required"), { ok: true, mode: "required" });
  assertEquals(parseSandboxMode("off"), { ok: true, mode: "off" });
  const bad = parseSandboxMode("1");
  assert(!bad.ok && bad.error.includes("RYPH_BROWSER_SANDBOX"));
});
