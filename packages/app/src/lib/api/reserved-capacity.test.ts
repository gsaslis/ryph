import { describe, expect, it } from "vitest";
import {
  getReservedCapacity,
  getReservedCapacityOrNull,
  putReservedCapacity,
} from "./reserved-capacity";

// The Platform page reads this beside everything else it loads; a control plane that does not
// answer this one route must not take the page down with it.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const capacity = {
  supported: true,
  maxSlots: 20,
  classes: [
    {
      name: "standard",
      cpu: "4",
      memory: "8Gi",
      ephemeralStorage: "10Gi",
      workVolume: null,
      default: true,
      reservable: true,
      services: 3,
      slots: 2,
      ready: 1,
    },
    {
      name: "tiny",
      cpu: null,
      memory: null,
      ephemeralStorage: null,
      workVolume: null,
      default: false,
      reservable: false,
      services: 0,
      slots: 0,
      ready: 0,
    },
  ],
  updatedAt: "2026-10-03T10:00:00.000Z",
  updatedBy: "user-1",
};

describe("getReservedCapacity", () => {
  it("reads the classes with their slots and ready counts", async () => {
    const fetch = respond(200, capacity) as unknown as typeof globalThis.fetch;
    expect(await getReservedCapacity(fetch)).toEqual(capacity);
  });
});

describe("getReservedCapacityOrNull", () => {
  it("is null when the route does not answer", async () => {
    const fetch = respond(503, { error: "down" }) as unknown as typeof globalThis.fetch;
    expect(await getReservedCapacityOrNull(fetch)).toBeNull();
  });

  it("refuses a malformed answer rather than offering it", async () => {
    const fetch = respond(200, { supported: true }) as unknown as typeof globalThis.fetch;
    expect(await getReservedCapacityOrNull(fetch)).toBeNull();
  });
});

describe("putReservedCapacity", () => {
  it("sends the whole setting as a PUT and reads the answer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(200, capacity)();
    }) as unknown as typeof globalThis.fetch;
    expect(await putReservedCapacity({ standard: 2 }, fetch)).toEqual(capacity);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/reserved-capacity");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ slots: { standard: 2 } });
  });
});
