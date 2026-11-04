import { describe, expect, it } from "vitest";
import { getLimits, getLimitsOrNull } from "./limits";

// The agent and task forms read the ceiling beside everything else they load; a control plane
// that does not answer this one route must not take the form down with it.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const limits = {
  ceiling: { wallClockMs: 43_200_000, spendUsd: null, callsInFlight: 8 },
  concurrency: null,
};

describe("getLimits", () => {
  it("reads the ceiling and the concurrency cap", async () => {
    const fetch = respond(200, limits) as unknown as typeof globalThis.fetch;
    expect(await getLimits(fetch)).toEqual(limits);
  });
});

describe("getLimitsOrNull", () => {
  it("is null when the route does not answer", async () => {
    const fetch = respond(503, { error: "down" }) as unknown as typeof globalThis.fetch;
    expect(await getLimitsOrNull(fetch)).toBeNull();
  });
});
