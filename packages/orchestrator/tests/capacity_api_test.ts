// Reserved capacity over HTTP: who may read and move it, what a save may name, what a deployment
// that cannot reserve answers, and what the page is told when the cluster cannot be asked.

import { test } from "bun:test";
import { capsClaimOf, type Role } from "@ryph/auth";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import type { CapacityReconciler } from "../src/core/reserved_capacity.ts";
import type { ReservationStatus } from "../src/ports/provisioner.ts";
import { parseRunSizes, type RunSizes } from "../src/core/run_sizes.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

function sizesOf(spec: string, defaultName?: string): RunSizes {
  const parsed = parseRunSizes(spec, defaultName);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
}

const SIZES = sizesOf(
  "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;" +
    "large:cpu=7,memory=16Gi,ephemeral-storage=10Gi,work-volume=50Gi;" +
    "bare:ephemeral-storage=1Gi",
);

/** A reconciler whose status the test sets. */
function fakeCapacity() {
  const state = {
    status: (): Promise<ReservationStatus[]> => Promise.resolve([]),
  };
  const capacity: CapacityReconciler = {
    tick: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: () => state.status(),
    servicesHeld: (size) => (size.name === "standard" ? 3 : 2),
  };
  return { capacity, state };
}

function buildApp(opts: { capacity?: CapacityReconciler | null } = {}) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  let caller: "break-glass" | Role = "operator";
  const authenticate = (() =>
    Promise.resolve(
      caller === "break-glass" ? { kind: "break-glass" } : {
        kind: "user",
        userId: "u-1",
        email: "ada@example.com",
        name: "Ada",
        caps: capsClaimOf(caller),
        emailVerified: true,
        sid: "s-1",
        via: "session",
      },
    )) as unknown as Authenticate;
  const handler = makeHandler({
    store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate,
    capacity: opts.capacity === undefined ? fakeCapacity().capacity : opts.capacity,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig({ runSizes: SIZES }),
      gitGateway: null,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  return { handler, store, clock, as: (who: "break-glass" | Role) => (caller = who) };
}

type Handler = (req: Request) => Promise<Response>;
const get = (handler: Handler) =>
  handler(new Request("http://orchestrator.test/v1/reserved-capacity"));
const put = (handler: Handler, body: unknown) =>
  handler(
    new Request("http://orchestrator.test/v1/reserved-capacity", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("reading and moving reserved capacity takes resources:manage", async () => {
  const app = buildApp();
  // A member may connect and manage repos, and still not spend the operator's money on nodes.
  app.as("member");
  const read = await get(app.handler);
  assertEquals(read.status, 403);
  const readBody = await read.json();
  assertEquals(readBody.code, "forbidden");
  assertStringIncludes(readBody.error, "resources:manage");
  const write = await put(app.handler, { slots: { standard: 1 } });
  assertEquals(write.status, 403);
  assertStringIncludes((await write.json()).error, "resources:manage");
  assertEquals(await app.store.getReservedCapacity(), null);

  app.as("operator");
  assertEquals((await get(app.handler)).status, 200);
  app.as("owner");
  assertEquals((await get(app.handler)).status, 200);
});

test("with nothing saved, every configured class reads as zero slots", async () => {
  const { capacity, state } = fakeCapacity();
  state.status = () => Promise.resolve([{ sizeClass: "standard", ready: 0 }]);
  const app = buildApp({ capacity });
  const body = await (await get(app.handler)).json();
  assertEquals(body, {
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
        slots: 0,
        ready: 0,
      },
      {
        name: "large",
        cpu: "7",
        memory: "16Gi",
        ephemeralStorage: "10Gi",
        workVolume: "50Gi",
        default: false,
        reservable: true,
        services: 2,
        slots: 0,
        ready: 0,
      },
      {
        name: "bare",
        cpu: null,
        memory: null,
        ephemeralStorage: "1Gi",
        workVolume: null,
        default: false,
        reservable: false,
        // Nothing is held for it, services included.
        services: 0,
        slots: 0,
        ready: 0,
      },
    ],
    updatedAt: null,
    updatedBy: null,
  });
});

test("a save stores only configured classes above zero and answers the new state", async () => {
  const { capacity } = fakeCapacity();
  const app = buildApp({ capacity });
  const res = await put(app.handler, { slots: { standard: 2, large: 0 } });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.classes.map((c: { name: string; slots: number }) => [c.name, c.slots]), [
    ["standard", 2],
    ["large", 0],
    ["bare", 0],
  ]);
  assertEquals(body.updatedAt, "2026-01-01T00:00:00.000Z");
  assertEquals(body.updatedBy, "u-1");
  assertEquals(await app.store.getReservedCapacity(), {
    slots: { standard: 2 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "u-1",
  });

  // A full replace: a class left out of the next save is no longer reserved.
  await put(app.handler, { slots: { large: 1 } });
  assertEquals((await app.store.getReservedCapacity())?.slots, { large: 1 });

  // Break-glass has no identity to record.
  app.as("break-glass");
  await put(app.handler, { slots: {} });
  assertEquals(await app.store.getReservedCapacity(), {
    slots: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: null,
  });
});

test("a save is refused for an unknown class, an unreservable one, and a number out of range", async () => {
  const { capacity } = fakeCapacity();
  const app = buildApp({ capacity });
  const refused = async (body: unknown, says: string) => {
    const res = await put(app.handler, body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertStringIncludes((await res.json()).error, says);
  };
  await refused({ slots: { huge: 1 } }, 'RYPH_RUN_SIZES defines no class "huge"');
  await refused({ slots: { bare: 1 } }, "leaves cpu, memory or ephemeral-storage unset");
  await refused({ slots: { standard: 21 } }, "slots");
  await refused({ slots: { standard: -1 } }, "slots");
  await refused({ slots: { standard: 1.5 } }, "slots");
  await refused({ slots: { "Not A Class": 1 } }, "slots");
  await refused({}, "slots");
  // Nothing reached the store or the reconciler.
  assertEquals(await app.store.getReservedCapacity(), null);

  // The bound itself, and zero for an unreservable class, are fine.
  assertEquals((await put(app.handler, { slots: { standard: 20, bare: 0 } })).status, 200);
});

test("a class that can no longer be reserved reads as zero slots, whatever an older row says", async () => {
  const app = buildApp();
  // Saved when `bare` still set cpu, say; the configuration has since dropped it.
  await app.store.saveReservedCapacity({
    slots: { standard: 1, bare: 3 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "u-1",
  });
  const body = await (await get(app.handler)).json();
  assertEquals(
    body.classes.map((c: { name: string; slots: number; reservable: boolean }) => [
      c.name,
      c.slots,
      c.reservable,
    ]),
    // What the reconciler holds: nothing for `bare`.
    [["standard", 1, true], ["large", 0, true], ["bare", 0, false]],
  );
  // The page saves what it shows, and the stale count falls out of the row.
  assertEquals((await put(app.handler, { slots: { standard: 1 } })).status, 200);
  assertEquals((await app.store.getReservedCapacity())?.slots, { standard: 1 });
});

test("a provisioner that cannot reserve says so, and a save stores nothing", async () => {
  const app = buildApp({ capacity: null });
  const body = await (await get(app.handler)).json();
  assertEquals(body.supported, false);
  assertEquals(body.classes.map((c: { ready: number | null }) => c.ready), [null, null, null]);
  assertEquals(body.classes.map((c: { services: number }) => c.services), [0, 0, 0]);

  const res = await put(app.handler, { slots: { standard: 1 } });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    error: "this deployment's provisioner cannot reserve capacity",
    code: "capacity_unsupported",
  });
  assertEquals(await app.store.getReservedCapacity(), null);
});

test("a cluster that cannot be asked reads as unknown on every class, and the setting still saves", async () => {
  const { capacity, state } = fakeCapacity();
  state.status = () => Promise.reject(new Error("kubernetes GET … → 403: forbidden"));
  const app = buildApp({ capacity });
  const saved = await put(app.handler, { slots: { large: 3 } });
  assertEquals(saved.status, 200);
  const body = await saved.json();
  assertEquals(body.supported, true);
  assertEquals(
    body.classes.map((c: { name: string; slots: number; ready: number | null }) => [
      c.name,
      c.slots,
      c.ready,
    ]),
    [["standard", 0, null], ["large", 3, null], ["bare", 0, null]],
  );
});

test("ready is per class, and zero for a class the cluster holds nothing for", async () => {
  const { capacity, state } = fakeCapacity();
  state.status = () =>
    Promise.resolve([{ sizeClass: "large", ready: 1 }, { sizeClass: "gone", ready: 4 }]);
  const app = buildApp({ capacity });
  const body = await (await get(app.handler)).json();
  assertEquals(
    body.classes.map((c: { name: string; ready: number | null }) => [c.name, c.ready]),
    [["standard", 0], ["large", 1], ["bare", 0]],
  );
});
