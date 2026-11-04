// The in-memory spend meter and the deployment gauge, driven with a hand-held clock.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { makeDeploymentGauge, makeSpendMeter } from "../src/core/spend_meter.ts";

const CAP = { spendUsd: 1, callsInFlight: 2 };

test("a run over its cap is ok through the backstop grace, then over", () => {
  const meter = makeSpendMeter({ backstopMs: 30_000 });
  meter.seed("r-1", 0.5, CAP.spendUsd, 0);
  assertEquals(meter.verdict("r-1", CAP, 0), { kind: "ok" });
  meter.add("r-1", 0.5, CAP.spendUsd, 1_000);
  assertEquals(meter.verdict("r-1", CAP, 1_000), { kind: "ok" });
  assertEquals(meter.verdict("r-1", CAP, 30_999), { kind: "ok" });
  assertEquals(meter.verdict("r-1", CAP, 31_000), { kind: "over", limit: "spend" });
  // An uncapped run is never over, whatever it spent.
  assertEquals(meter.verdict("r-1", { ...CAP, spendUsd: null }, 99_000), { kind: "ok" });
});

test("the grace runs from the spend that crossed the cap, not from the next request", () => {
  const meter = makeSpendMeter({ backstopMs: 30_000 });
  meter.seed("r-1", 0, CAP.spendUsd, 0);
  meter.add("r-1", 2, CAP.spendUsd, 1_000); // crosses here, then the run goes quiet
  assertEquals(meter.verdict("r-1", CAP, 30_999), { kind: "ok" });
  assertEquals(meter.verdict("r-1", CAP, 31_000), { kind: "over", limit: "spend" });
});

test("a seed already above the cap starts the grace at the seed, not at the first verdict", () => {
  const meter = makeSpendMeter({ backstopMs: 30_000 });
  meter.seed("r-1", 5, CAP.spendUsd, 0);
  assertEquals(meter.verdict("r-1", CAP, 29_999), { kind: "ok" });
  assertEquals(meter.verdict("r-1", CAP, 30_000), { kind: "over", limit: "spend" });
  assertEquals(meter.has("r-1"), true);
  assertEquals(meter.has("r-2"), false);
});

test("the first seed wins: a later seed does not erase what was added in between", () => {
  const meter = makeSpendMeter({ backstopMs: 0 });
  assertEquals(meter.has("r-1"), false);
  meter.seed("r-1", 0.5, CAP.spendUsd, 0);
  meter.add("r-1", 0.5, CAP.spendUsd, 1);
  meter.seed("r-1", 0.5, CAP.spendUsd, 2); // a parallel first-sight read, landing late
  assertEquals(meter.verdict("r-1", CAP, 2), { kind: "over", limit: "spend" });
  // A slot or a row makes an entry, not a seeded one.
  meter.take("r-2", null, 0)!();
  assertEquals(meter.has("r-2"), false);
});

test("take refuses at the cap, releases once, and a null cap never refuses", () => {
  const meter = makeSpendMeter({ backstopMs: 0 });
  const first = meter.take("r-1", 2, 0);
  const second = meter.take("r-1", 2, 0);
  assertEquals(meter.take("r-1", 2, 0), null);
  first!();
  first!(); // a second release frees nothing
  assertEquals(meter.take("r-1", 2, 0) !== null, true);
  assertEquals(meter.take("r-1", 2, 0), null);
  second!();
  for (let i = 0; i < 10; i++) assertEquals(meter.take("r-1", null, 0) !== null, true);
});

test("an idle run is forgotten on the sweep, unless it still holds a slot", () => {
  const meter = makeSpendMeter({ backstopMs: 0, idleMs: 1_000, sweepMs: 100 });
  meter.seed("r-1", 1, null, 0);
  meter.seed("r-2", 1, null, 0);
  const held = meter.take("r-2", null, 0);
  meter.seed("r-3", 0, null, 2_000); // triggers the sweep
  assertEquals(meter.has("r-1"), false);
  assertEquals(meter.has("r-2"), true);
  held!();
  meter.seed("r-3", 0, null, 4_000);
  assertEquals(meter.has("r-2"), false);
});

test("the deployment gauge is stale until seeded and again after the reseed cadence", () => {
  const gauge = makeDeploymentGauge({ ceilingUsd: 10, windowDays: 30, reseedMs: 60_000 });
  assertEquals(gauge.stale(0), true);
  gauge.seed(9, 0);
  assertEquals(gauge.stale(59_999), false);
  assertEquals(gauge.stale(60_000), true);
  assertEquals(gauge.reached(), false);
  gauge.add(1);
  assertEquals(gauge.reached(), true);
  assertEquals(gauge.snapshot(), { usd: 10, windowDays: 30, spentUsd: 10 });
  gauge.seed(2, 60_000);
  assertEquals(gauge.reached(), false);
  // A seed while fresh is a late parallel read: it does not erase what was added since.
  gauge.add(8);
  gauge.seed(2, 60_001);
  assertEquals(gauge.reached(), true);
});
