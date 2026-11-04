// The two probes answer different questions, and the tests below are mostly about keeping them
// different: liveness never consults a dependency, readiness always does, and neither says
// anything to an unauthenticated prober that it should not.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeHealth } from "../src/health.ts";

const call = (health: ReturnType<typeof makeHealth>, path: string): Promise<Response> => {
  const route = health.routes.find((r) => r.pattern.exec(`http://svc.test${path}`));
  assert(route, `no route for ${path}`);
  return route.handler(new Request(`http://svc.test${path}`), {});
};

test("liveness is 200 whatever the dependency is doing", async () => {
  // A 503 on /healthz means RESTART ME. If a down database produced one, every replica would
  // crash-loop through an outage it could otherwise ride out.
  const health = makeHealth({ ready: () => Promise.reject(new Error("database is gone")) });
  const res = await call(health, "/healthz");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

test("liveness stays 200 while draining", async () => {
  // A process finishing its in-flight work is exactly the one that should not be killed.
  const health = makeHealth();
  health.beginDrain();
  assertEquals((await call(health, "/healthz")).status, 200);
});

test("readiness reflects the dependency", async () => {
  let up = true;
  const health = makeHealth({
    ready: () => up ? Promise.resolve() : Promise.reject(new Error("connection refused")),
  });
  assertEquals((await call(health, "/readyz")).status, 200);
  up = false;
  assertEquals((await call(health, "/readyz")).status, 503);
  up = true;
  assertEquals((await call(health, "/readyz")).status, 200);
});

test("a failed check logs the reason and does not answer it", async () => {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const health = makeHealth({
    ready: () => Promise.reject(new Error("password authentication failed for user 'ryph'")),
    log: { warn: (_event, fields) => warnings.push(fields) },
  });
  const res = await call(health, "/readyz");
  assertEquals(res.status, 503);
  // The probe is unauthenticated. The reason belongs in the log, which is already guarded.
  assertEquals(await res.json(), { status: "unready" });
  assertEquals(warnings[0]?.reason, "password authentication failed for user 'ryph'");
});

test("a hung dependency is unready, not a held-open prober", async () => {
  const health = makeHealth({
    ready: () => new Promise(() => {}), // never settles
    timeoutMs: 20,
  });
  const res = await call(health, "/readyz");
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { status: "unready" });
});

test("readiness drops the instant a drain begins, before anything closes", async () => {
  const health = makeHealth({ ready: () => Promise.resolve() });
  assertEquals((await call(health, "/readyz")).status, 200);
  health.beginDrain();
  const res = await call(health, "/readyz");
  assertEquals(res.status, 503);
  // Distinguishable from a broken dependency: this replica is fine, it is just leaving.
  assertEquals(await res.json(), { status: "draining" });
});

test("a service with no dependency is ready by being alive", async () => {
  const health = makeHealth();
  assertEquals((await call(health, "/readyz")).status, 200);
});

test("probes are never cached", async () => {
  const health = makeHealth();
  for (const path of ["/healthz", "/readyz"]) {
    assertEquals((await call(health, path)).headers.get("cache-control"), "no-store");
  }
});
