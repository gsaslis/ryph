// The decision as plain objects: the caps' refusals beside the identity and allowlist ones.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { decide, LIMIT_REACHED, UNPRICED } from "../src/core/enforce.ts";
import type { ProviderKey, VirtualKey } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";

const providerKey: ProviderKey = {
  id: "pk-1",
  provider: "anthropic",
  label: "team",
  last4: "cret",
  encryptedSecret: "sealed",
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

function virtualKey(over: Partial<VirtualKey> = {}): VirtualKey {
  return {
    id: "vk-1",
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    tokenHash: "hash",
    allowedModels: "*",
    spendUsd: 1,
    callsInFlight: null,
    expiresAt: "2026-01-02T00:00:00.000Z",
    revokedAt: null,
    createdAt: T0,
    ...over,
  };
}

const purchase = { model: "claude-sonnet-5", spends: true, priced: true };
const OK = { capped: true, verdict: { kind: "ok" } } as const;
const OVER = { capped: true, verdict: { kind: "over", limit: "spend" } } as const;

test("identity comes first: a dead credential is a 401 whatever the spend says", () => {
  const revoked = virtualKey({ revokedAt: T0 });
  assertEquals(decide(revoked, providerKey, purchase, T0, OVER).allow, false);
  assertEquals(decide(revoked, providerKey, purchase, T0, OVER), {
    allow: false,
    status: 401,
    error: "unauthorized",
  });
});

test("a run past its cap is refused 403 with the code and the limit's name", () => {
  assertEquals(decide(virtualKey(), providerKey, purchase, T0, OVER), {
    allow: false,
    status: 403,
    code: LIMIT_REACHED,
    limit: "spend",
    error: "this run has reached its spend cap",
  });
  const ceiling = { capped: true, verdict: { kind: "over", limit: "deployment-spend" } } as const;
  const refused = decide(virtualKey(), providerKey, purchase, T0, ceiling);
  assertEquals(refused.allow === false && refused.limit, "deployment-spend");
});

test("under a cap, a purchase the catalogue cannot price is refused, never waved through", () => {
  const unpriced = { ...purchase, model: "claude-imaginary-9", priced: false };
  assertEquals(decide(virtualKey(), providerKey, unpriced, T0, OK), {
    allow: false,
    status: 403,
    code: UNPRICED,
    error: "this run is under a spend cap and this request's model has no price",
  });
  const unnamed = { model: null, spends: true, priced: null };
  assertEquals(decide(virtualKey(), providerKey, unnamed, T0, OK).allow, false);
  // Uncapped, the same requests pass: the price only matters when a cap counts it.
  const free = { capped: false, verdict: { kind: "ok" } } as const;
  assertEquals(decide(virtualKey(), providerKey, unpriced, T0, free).allow, true);
  assertEquals(decide(virtualKey(), providerKey, unnamed, T0, free).allow, true);
});

test("a request that buys nothing passes every cap: a models list still answers", () => {
  const list = { model: null, spends: false, priced: null };
  assertEquals(decide(virtualKey(), providerKey, list, T0, OVER).allow, true);
  assertEquals(decide(virtualKey(), providerKey, list, T0, OK).allow, true);
});

test("the allowlist is judged before the caps", () => {
  const listed = virtualKey({ allowedModels: ["claude-opus-5"] });
  const refused = decide(listed, providerKey, purchase, T0, OVER);
  assertEquals(refused.allow === false && refused.code, undefined);
  assertEquals(refused.allow === false && refused.error.includes("not allowed"), true);
});

test("a plan's included purchase is refused by no cap, the run's or the deployment's", () => {
  const included = { model: "gpt-6.1-sol", spends: true, priced: true, included: true };
  assertEquals(decide(virtualKey(), providerKey, included, T0, OVER).allow, true);
  const ceiling = { capped: true, verdict: { kind: "over", limit: "deployment-spend" } } as const;
  assertEquals(decide(virtualKey(), providerKey, included, T0, ceiling).allow, true);
  // But the allowlist still holds: included is about money, not about which models.
  const listed = virtualKey({ allowedModels: ["gpt-6.1-mini"] });
  assertEquals(decide(listed, providerKey, included, T0, OK).allow, false);
});
