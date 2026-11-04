// The launcher's tool host client waits out a launcher that is away, the way every launcher client
// does: only while a request provably never left, so nothing is sent twice.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  connectLauncherToolHost,
  LAUNCHER_WIRE_REVISION,
  launcherToolHost,
  WireMismatch,
} from "../src/adapters/tool_host/launcher.ts";
import type { ToolLaunchSpec } from "../src/ports/tool_host.ts";

const INFO = {
  wire: LAUNCHER_WIRE_REVISION,
  reachesGuard: true,
  guardName: "ryph-tool-guard",
  guardImage: "ryph-tool-guard:dev",
  network: "ryph-tools",
  egressProxy: "http://ryph-egress-relay-ryph-tools:7460",
};
const SPEC: ToolLaunchSpec = {
  name: "ryph-tool-fetch-1",
  image: "mcp/fetch:1",
  command: [],
  env: {},
  port: 8000,
  memory: "128m",
  lifetime: "shared",
};

const refused = () => Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
const answer = (path: string) =>
  path.endsWith("/launch")
    ? Response.json({ handle: SPEC.name, address: `${SPEC.name}:8000` })
    : path.endsWith("/list")
    ? Response.json({ names: [] })
    : new Response(null, { status: 204 });

test("network, launch, stop and list wait out a launcher that cannot be connected to", async () => {
  for (
    const call of [
      (h: ReturnType<typeof launcherToolHost>) => h.ensureNetwork(),
      (h: ReturnType<typeof launcherToolHost>) => h.launch(SPEC),
      (h: ReturnType<typeof launcherToolHost>) => h.stop(SPEC.name),
      (h: ReturnType<typeof launcherToolHost>) => h.list(),
    ]
  ) {
    let tries = 0;
    const host = launcherToolHost({
      url: "http://launcher:7470",
      token: "t",
      reachMs: 5_000,
      fetch: ((url: string) => {
        tries++;
        return tries < 3 ? Promise.reject(refused()) : Promise.resolve(answer(url));
      }) as unknown as typeof fetch,
    }, INFO);
    await call(host);
    assertEquals(tries, 3);
  }
});

test("a failure that may have reached the launcher is never sent again", async () => {
  let tries = 0;
  const host = launcherToolHost({
    url: "http://launcher:7470",
    token: "t",
    reachMs: 5_000,
    fetch: (() => {
      tries++;
      return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    }) as unknown as typeof fetch,
  }, INFO);
  await assertRejects(() => host.launch(SPEC));
  assertEquals(tries, 1);
});

test("a launcher away past the budget is said so", async () => {
  let tries = 0;
  const host = launcherToolHost({
    url: "http://launcher:7470",
    token: "t",
    reachMs: 300,
    fetch: (() => {
      tries++;
      return Promise.reject(refused());
    }) as unknown as typeof fetch,
  }, INFO);
  const err = await assertRejects(() => host.launch(SPEC));
  assertStringIncludes(String(err), "still unreachable");
  assert(tries >= 2);
});

test("a launcher of another wire revision is refused at once, naming both", async () => {
  for (const wire of [LAUNCHER_WIRE_REVISION + 1, undefined]) {
    let tries = 0;
    const err = await assertRejects(() =>
      connectLauncherToolHost({
        url: "http://launcher:7470",
        token: "t",
        fetch: (() => {
          tries++;
          return Promise.resolve(Response.json({ ...INFO, wire }));
        }) as unknown as typeof fetch,
      }, { waitMs: 10_000 })
    );
    assert(err instanceof WireMismatch, String(err));
    assertStringIncludes(err.message, `wire revision ${LAUNCHER_WIRE_REVISION}`);
    assertStringIncludes(err.message, wire === undefined ? "no wire revision" : `${wire}`);
    assertStringIncludes(err.message, "same version");
    assertEquals(tries, 1);
  }
});

test("what the launcher says of the guard's image and the way out is what the host says", async () => {
  const host = await connectLauncherToolHost({
    url: "http://launcher:7470",
    token: "t",
    fetch: (() => Promise.resolve(Response.json(INFO))) as unknown as typeof fetch,
  });
  assertEquals(host.guardImage, "ryph-tool-guard:dev");
  assertEquals(host.egressProxy, "http://ryph-egress-relay-ryph-tools:7460");
  const off = launcherToolHost({ url: "http://launcher:7470", token: "t" }, {
    ...INFO,
    egressProxy: null,
  });
  assertEquals(off.egressProxy, null);
});
