// The whole service in-process: real stores over in-memory PGlite, the real mailroom, a
// recording sink instead of an orchestrator, plain Requests instead of a socket.

import { capsClaimOf } from "@ryph/auth";
import type { Claims } from "@ryph/auth";
import { drizzleHookStore, scopeWebhooksDb, setup as setupWebhooks } from "@ryph/webhooks";
import type { AutomationEvent } from "../src/core/types.ts";
import type { AccessProbe, DeliverResult } from "../src/ports/event_sink.ts";
import type {
  ChatroomChannel,
  ChatroomChannels,
  ChatroomPlatform,
} from "../src/ports/chatroom_directory.ts";
import { drizzleAutomationStore } from "../src/adapters/store/drizzle.ts";
import { setupAutomations } from "../src/setup.ts";
import { automationRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { makeTestDb, type TestDb } from "./db.ts";

export const silent = { debug: () => {}, warn: () => {} };

export const CALLER: Claims = {
  sub: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
};

/** A different user holding `automations:manage-all` — an operator reaching CALLER's rows. */
export const OPERATOR: Claims = {
  sub: "u-2",
  email: "opal@example.com",
  name: "Opal",
  caps: capsClaimOf("operator"),
  emailVerified: true,
  sid: "s-2",
  via: "session",
};

export function fakeClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => now += ms,
    set: (ms: number) => now = ms,
  };
}

/** A sink that answers what it is told and remembers what it saw. */
export function recordingSink(
  answer: () => DeliverResult = () => ({
    kind: "ok",
    outcome: "started",
    taskId: "t-1",
    runId: "r-1",
  }),
) {
  const delivered: AutomationEvent[] = [];
  const probes: AccessProbe[] = [];
  return {
    delivered,
    probes,
    sink: {
      deliver(event: AutomationEvent) {
        delivered.push(event);
        return Promise.resolve(answer());
      },
      refreshAccess(probe: AccessProbe) {
        probes.push(probe);
        return Promise.resolve();
      },
    },
  };
}

export type FakeChatroom =
  | ChatroomPlatform
  | "down"
  | { platform: "zulip" | "slack" | "discord"; channels: ChatroomChannel[] | "forbidden" | "down" };

export async function makeService(opts: {
  clock?: ReturnType<typeof fakeClock>;
  answer?: () => DeliverResult;
  caller?: Claims;
  /** The chat service's rooms by id; `chr-1` is a Telegram room unless told otherwise. Null: no
   * chat on this deployment. A room is its platform, `down` (the chat service does not answer
   * about it), or a room with channels and its channel list — or `forbidden`, the chat service's
   * creator-or-admin gate on that list, or `down` for a list it cannot read. */
  chatrooms?: Record<string, FakeChatroom> | null;
} = {}) {
  const clock = opts.clock ?? fakeClock();
  const db: TestDb = await makeTestDb();
  const store = drizzleAutomationStore(db.handle.db);
  const hookStore = drizzleHookStore(scopeWebhooksDb(db.cluster).db);
  const { sink, delivered, probes } = recordingSink(opts.answer);
  const rateLimited: string[] = [];
  const chatrooms = opts.chatrooms === undefined
    ? { "chr-1": "telegram" as const }
    : opts.chatrooms;
  const lookups: Array<{ id: string; authorization: string | null; channels?: true }> = [];
  const webhooks = setupWebhooks({
    store: hookStore,
    diag: silent,
    now: clock.now,
    onRateLimited: (id) => {
      rateLimited.push(id);
      automations.recordRateLimited(id);
    },
  });
  const automations = setupAutomations({
    store,
    webhooks,
    sink,
    diag: silent,
    now: clock.now,
  });
  /** Builds a handler for a given caller, over the SAME store and setup — what `handler`
   * itself is, for the default one, and what `handlerAs` lets a test reach a second identity
   * with (e.g. an operator holding `automations:manage-all` acting on another user's row). */
  const buildHandler = (caller: Claims) =>
    makeRouter([
      ...webhooks.routes,
      ...automationRoutes({
        store,
        setup: automations,
        authenticate: () => Promise.resolve(caller),
        chatrooms: chatrooms === null ? null : {
          platformOf(id, authorization) {
            lookups.push({ id, authorization });
            const room = chatrooms[id];
            if (room === "down") return Promise.reject(new Error("chat is down"));
            if (room === undefined) return Promise.resolve(null);
            return Promise.resolve(typeof room === "string" ? room : room.platform);
          },
          channelsOf(id, authorization): Promise<ChatroomChannels> {
            lookups.push({ id, authorization, channels: true });
            const room = chatrooms[id];
            if (room === undefined) return Promise.resolve({ kind: "none" });
            if (room === "down") return Promise.reject(new Error("chat is down"));
            if (typeof room === "string") {
              return Promise.resolve({ kind: "channels", channels: [], truncated: false });
            }
            const channels = room.channels;
            if (channels === "down") return Promise.reject(new Error("chat is down"));
            if (channels === "forbidden") return Promise.resolve({ kind: "forbidden" });
            return Promise.resolve({ kind: "channels", channels, truncated: false });
          },
        },
        diag: silent,
        now: clock.now,
      }),
    ]);
  const handler = buildHandler(opts.caller ?? CALLER);
  return {
    db,
    store,
    hookStore,
    webhooks,
    automations,
    handler,
    handlerAs: buildHandler,
    delivered,
    probes,
    rateLimited,
    clock,
    lookups,
  };
}

type Service = Awaited<ReturnType<typeof makeService>>;

export const api = (svc: Service, method: string, path: string, body?: unknown) =>
  svc.handler(
    new Request(`http://automations.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** As `api`, but through a handler built for a specific caller — `svc.handlerAs(OPERATOR)`,
 * say, to reach CALLER's rows as an operator holding `automations:manage-all`. */
export const apiAs = (
  handler: Service["handler"],
  method: string,
  path: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://automations.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function webhookCreateBody(over: Record<string, unknown> = {}) {
  return {
    name: "grafana alerts",
    trigger: { kind: "webhook", verification: { kind: "hmac-sha256" } },
    agentId: "agent-1",
    target: { kind: "repo", connectedRepoId: "repo-1", ref: null },
    instructions: "triage the alert",
    ...over,
  };
}
