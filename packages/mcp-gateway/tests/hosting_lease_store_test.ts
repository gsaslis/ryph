// The hosting lease's store over this package's API client: the rules and the manifest are
// @ryph/service's (its kubernetes_lease_test.ts); what is the gateway's is where the Lease is and
// that a request the API server never answers is abandoned.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { HOSTING_LEASE_NAME, hostingLeaseStore } from "../src/adapters/lease/kubernetes.ts";

const OPTS = {
  apiUrl: "https://api.test",
  namespace: "ryph-tools",
  name: HOSTING_LEASE_NAME,
  tokenFile: null,
  caFile: null,
};
const RECORD = {
  holder: "mcp-gateway-7cfc8c9f74-gsbn7-1a2b3c4d",
  durationMs: 15_000,
  renewedAt: "2026-09-12T20:10:15.123Z",
  transitions: 2,
};

test("the hosting Lease is mcp-hosting in the tools namespace, and a 404 reads as none", async () => {
  const seen: string[] = [];
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return Promise.resolve(Response.json({ message: "not found" }, { status: 404 }));
  }) as typeof globalThis.fetch;
  assertEquals(await hostingLeaseStore(OPTS, { fetch }).read(), null);
  assertEquals(seen, ["GET /apis/coordination.k8s.io/v1/namespaces/ryph-tools/leases/mcp-hosting"]);
});

test("a request the API server never answers is abandoned rather than awaited for good", async () => {
  let aborted = 0;
  const fetch =
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted++;
          reject(init.signal?.reason);
        });
      })) as typeof globalThis.fetch;
  const store = hostingLeaseStore({ ...OPTS, requestTimeoutMs: 20 }, { fetch });
  await assertRejects(() => store.replace(RECORD, "42"), Error, "no answer in 20 ms");
  await assertRejects(() => store.read(), Error, "no answer in 20 ms");
  assertEquals(aborted, 2);
});
