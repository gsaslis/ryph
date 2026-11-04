// The HTTP surfaces driven as pure handlers with fakes — no sockets.

import { type CapabilityClaim, capsClaimOf } from "@ryph/auth";
import { makeRouter } from "@ryph/shared/http";
import { makeMemoryService, type MemoryService } from "../src/core/service.ts";
import { makeMemoryDataHandler } from "../src/http/data.ts";
import { internalMemoryRoutes } from "../src/http/internal.ts";
import { memoryRoutes } from "../src/http/routes.ts";
import type { Principal } from "@ryph/auth/gates";
import { countingMinter, fakeClock, fakeHash } from "./fixtures.ts";
import { type InMemoryStore, memoryStore } from "./memory_store.ts";

/** A verified user principal; the routes read only the id, caps and `via`. */
const user = (
  userId: string,
  caps: readonly CapabilityClaim[],
  via: "session" | "token" = "session",
): Principal => ({
  kind: "user",
  userId,
  email: `${userId}@example.com`,
  name: userId,
  caps,
  emailVerified: true,
  sid: `s-${userId}`,
  via,
});

export const ADMIN = "admin-secret";
export const PLAIN = "user-secret";
/** The same plain member, presenting an API token rather than a session. */
export const PLAIN_TOKEN = "user-api-token";
export const SERVICE = "service-secret";
export const GATEWAY = "gateway-secret";

const silent = { debug() {}, warn() {} };

export function makeApi(): {
  store: InMemoryStore;
  service: MemoryService;
  clock: ReturnType<typeof fakeClock>;
  handle: (req: Request) => Promise<Response>;
  data: (req: Request) => Promise<Response | null>;
} {
  const store = memoryStore();
  const clock = fakeClock();
  const service = makeMemoryService({
    store,
    now: clock.now,
    diag: silent,
    mintId: countingMinter(),
    hash: fakeHash,
  });
  const authenticate = (req: Request): Promise<Principal | Response> => {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (token === ADMIN) return Promise.resolve(user("u-admin", ["*"]));
    if (token === PLAIN) {
      return Promise.resolve(user("u-plain", capsClaimOf("member")));
    }
    if (token === PLAIN_TOKEN) {
      return Promise.resolve(user("u-plain", capsClaimOf("member"), "token"));
    }
    return Promise.resolve(new Response("nope", { status: 401 }));
  };
  const serviceGate = (expected: string) => (req: Request) =>
    Promise.resolve(
      req.headers.get("authorization") === `Bearer ${expected}`
        ? null
        : new Response("nope", { status: 401 }),
    );
  const handle = makeRouter([
    ...memoryRoutes({ service, authenticate, now: clock.now }),
    ...internalMemoryRoutes({ service, authenticate: serviceGate(SERVICE), diag: silent }),
  ]);
  const data = makeMemoryDataHandler({
    service,
    authenticate: serviceGate(GATEWAY),
    now: clock.now,
    diag: silent,
  });
  return { store, service, clock, handle, data };
}

export function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ADMIN,
): Promise<Response> {
  return handler(
    new Request(`http://memory.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
