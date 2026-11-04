// A lease as a Kubernetes Lease: the manifest, including the one time format the API server
// accepts, where each call goes, and a conflict read as "someone else got there first" rather than
// as an error, whichever client threw it.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { kubernetesLeaseStore, leaseManifest, microTime } from "../src/kubernetes_lease.ts";

const AT = { namespace: "ryph-tools", name: "mcp-hosting" };
const LEASES = "/apis/coordination.k8s.io/v1/namespaces/ryph-tools/leases";
const RECORD = {
  holder: "mcp-gateway-7cfc8c9f74-gsbn7-1a2b3c4d",
  durationMs: 15_000,
  renewedAt: "2026-09-12T20:10:15.123Z",
  transitions: 2,
};

interface Call {
  method: string;
  path: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  body: any;
}

/** A client's own error: what the store branches on is the status it carries, nothing else. */
class ClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function fakeApi(answer: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const api = {
    call(method: string, path: string, body?: unknown) {
      const call: Call = { method, path, body: structuredClone(body) };
      calls.push(call);
      const { status = 200, body: answered = {} } = answer(call);
      if (status >= 300) {
        const message = (answered as { message?: string }).message ?? "";
        return Promise.reject(new ClientError(status, `${method} ${path} → ${status}: ${message}`));
      }
      return Promise.resolve(answered);
    },
  };
  return { calls, store: kubernetesLeaseStore(api, AT) };
}

test("a Lease's times carry six fractional digits — the API server refuses toISOString's three", () => {
  assertEquals(microTime("2026-09-12T20:10:15.123Z"), "2026-09-12T20:10:15.123000Z");
  assertEquals(microTime("2026-09-12T20:10:15Z"), "2026-09-12T20:10:15.000000Z");
});

test("the manifest names the holder, the duration in seconds and the version; released is an empty holder", () => {
  assertEquals(leaseManifest(RECORD, AT, "42"), {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: { name: "mcp-hosting", namespace: "ryph-tools", resourceVersion: "42" },
    spec: {
      holderIdentity: RECORD.holder,
      leaseDurationSeconds: 15,
      renewTime: "2026-09-12T20:10:15.123000Z",
      leaseTransitions: 2,
    },
  });
  assertEquals(leaseManifest({ ...RECORD, holder: null }, AT).spec.holderIdentity, "");
  assertEquals(leaseManifest(RECORD, AT).metadata.resourceVersion, undefined);
});

test("read: no Lease is null, and one comes back as its record and version", async () => {
  const none = fakeApi(() => ({
    status: 404,
    body: { message: 'leases "mcp-hosting" not found' },
  }));
  assertEquals(await none.store.read(), null);
  assertEquals(none.calls.map((c) => `${c.method} ${c.path}`), [`GET ${LEASES}/mcp-hosting`]);

  const some = fakeApi(() => ({ body: leaseManifest(RECORD, AT, "42") }));
  assertEquals(await some.store.read(), {
    version: "42",
    record: { ...RECORD, renewedAt: "2026-09-12T20:10:15.123000Z" },
  });

  const released = fakeApi(() => ({
    body: leaseManifest({ ...RECORD, holder: null }, AT, "43"),
  }));
  assertEquals((await released.store.read())?.record.holder, null);
});

test("create and replace go to the right place, and a conflict is somebody else's win", async () => {
  const echo = (call: Call) => ({
    status: call.method === "POST" ? 201 : 200,
    body: { ...call.body, metadata: { ...call.body.metadata, resourceVersion: "43" } },
  });
  const ok = fakeApi(echo);
  assertEquals((await ok.store.create(RECORD))?.version, "43");
  assertEquals((await ok.store.replace(RECORD, "43"))?.version, "43");
  assertEquals(ok.calls.map((c) => `${c.method} ${c.path}`), [
    `POST ${LEASES}`,
    `PUT ${LEASES}/mcp-hosting`,
  ]);
  // The version rides the body of a replace, and that is the whole of the optimistic lock.
  assertEquals(ok.calls[0].body.metadata.resourceVersion, undefined);
  assertEquals(ok.calls[1].body.metadata.resourceVersion, "43");

  const taken = fakeApi(() => ({
    status: 409,
    body: { message: "Operation cannot be fulfilled" },
  }));
  assertEquals(await taken.store.create(RECORD), null);
  assertEquals(await taken.store.replace(RECORD, "41"), null);
});

test("anything else is an error that carries the API server's reason", async () => {
  const forbidden = fakeApi(() => ({
    status: 403,
    body: { message: 'leases.coordination.k8s.io "mcp-hosting" is forbidden' },
  }));
  await assertRejects(() => forbidden.store.read(), Error, "403");
  await assertRejects(() => forbidden.store.replace(RECORD, "1"), Error, "forbidden");
  // A 404 on a create is not "nobody has it": only a read's 404 means that.
  const missing = fakeApi(() => ({ status: 404, body: { message: "namespace not found" } }));
  await assertRejects(() => missing.store.create(RECORD), Error, "404");
});
