import { describe, expect, it } from "vitest";
import { getRunSizes, getRunSizesOrNull } from "./run-sizes";

// The repo and workspace settings read the classes beside everything else they load; a control
// plane that does not answer this one route must not take the page down with it.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const sizes = [
  {
    name: "standard",
    cpu: "4",
    memory: "8Gi",
    ephemeralStorage: "10Gi",
    workVolume: null,
    default: true,
  },
  {
    name: "large",
    cpu: "8",
    memory: "16Gi",
    ephemeralStorage: "10Gi",
    workVolume: "50Gi",
    default: false,
  },
];

describe("getRunSizes", () => {
  it("reads the classes in configured order", async () => {
    const fetch = respond(200, { sizes }) as unknown as typeof globalThis.fetch;
    expect(await getRunSizes(fetch)).toEqual(sizes);
  });
});

describe("getRunSizesOrNull", () => {
  it("folds a failure into null, so the page still opens", async () => {
    const fetch = respond(502, { error: "bad gateway" }) as unknown as typeof globalThis.fetch;
    expect(await getRunSizesOrNull(fetch)).toBeNull();
  });

  it("refuses a malformed answer rather than offering it", async () => {
    const fetch = respond(200, { sizes: [{ name: "x" }] }) as unknown as typeof globalThis.fetch;
    expect(await getRunSizesOrNull(fetch)).toBeNull();
  });
});
