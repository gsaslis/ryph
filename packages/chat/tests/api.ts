// The whole service in-process: the real store over in-memory PGlite, a scripted transport per
// platform, a recording door in place of the control plane, and the three HTTP surfaces as pure
// handlers.

import { type CapabilityClaim, capsClaimOf } from "@ryph/auth";
import { importMasterKey } from "@ryph/sealed";
import { makeRouter } from "@ryph/shared/http";
import { drizzleChatStore } from "../src/adapters/store/drizzle.ts";
import type { ChatService, OpenBindingConversation } from "../src/core/service.ts";
import type { ChatMention, ChatMentionVerdict } from "../src/core/types.ts";
import type { Principal } from "@ryph/auth/gates";
import type { ChatStore } from "../src/ports/store.ts";
import type { MentionDelivery, MentionSink } from "../src/ports/mention_sink.ts";
import type { RunImages } from "../src/ports/run_images.ts";
import { type ChatSetup, type ChatSetupDeps, setup } from "../src/setup.ts";
import { makeTestDb } from "./db.ts";
import {
  BOT_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD,
  type FakeTransport,
  fakeTransport,
  mention,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  ZULIP_EMAIL,
  ZULIP_KEY,
  ZULIP_REALM,
} from "./fake_transport.ts";

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
export const OTHER = "other-secret";
export const SERVICE = "service-secret";
export const GATEWAY = "gateway-secret";

export const T0 = "2026-09-01T00:00:00.000Z";

export const silent = { debug() {}, warn() {} };

/** The test's master key: any 32 bytes, hex. */
const MASTER_KEY_HEX = "00".repeat(31) + "01";

export const NO_BINDING_VERDICT: ChatMentionVerdict = {
  outcome: "no-binding",
  reply: "No response is running right now.",
  react: false,
};

export function fakeClock(startIso = T0) {
  let nowMs = Date.parse(startIso);
  return {
    now: () => new Date(nowMs),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

export interface RecordingSink extends MentionSink {
  readonly delivered: ChatMention[];
  /**
   * What the door answers. By default a room with no policy: a bound mention joins its run,
   * anything else is "no response is running".
   */
  answer: (mention: ChatMention) => MentionDelivery;
}

export function recordingSink(): RecordingSink {
  const delivered: ChatMention[] = [];
  const sink: RecordingSink = {
    delivered,
    answer: (m) => ({
      kind: "verdict",
      verdict: m.boundRunId !== null
        ? { outcome: "joined", reply: null, react: true, runId: m.boundRunId }
        : NO_BINDING_VERDICT,
    }),
    deliver(mention) {
      delivered.push(mention);
      return Promise.resolve(sink.answer(mention));
    },
  };
  return sink;
}

/**
 * The control plane's run images, scripted: what each run's refs name, and the bytes behind
 * each attachment. Every question is recorded; `down` makes both calls throw.
 */
export interface FakeRunImages extends RunImages {
  /** Adds an image a tool returned in `runId`; its attachment id is `att-<ref>`. */
  add(runId: string, ref: string, opts?: { mime?: string; url?: string | null }): void;
  readonly resolves: Array<{ runId: string; refs: string[] }>;
  readonly fetches: Array<{ runId: string; attachmentId: string }>;
  down: boolean;
}

export function fakeRunImages(): FakeRunImages {
  const runs = new Map<string, Map<string, { mime: string; url: string | null }>>();
  const images: FakeRunImages = {
    resolves: [],
    fetches: [],
    down: false,
    add(runId, ref, opts = {}) {
      const run = runs.get(runId) ?? new Map();
      run.set(ref, {
        mime: opts.mime ?? "image/png",
        url: opts.url === undefined ? `http://app.test/images/${runId}/att-${ref}` : opts.url,
      });
      runs.set(runId, run);
    },
    resolve(runId, refs) {
      images.resolves.push({ runId, refs });
      if (images.down) return Promise.reject(new Error("the control plane is down"));
      const run = runs.get(runId) ?? new Map();
      return Promise.resolve({
        images: refs.filter((ref) => run.has(ref)).map((ref) => ({
          ref,
          attachmentId: `att-${ref}`,
          ...run.get(ref)!,
        })),
        unknown: refs.filter((ref) => !run.has(ref)),
      });
    },
    fetch(runId, attachmentId) {
      images.fetches.push({ runId, attachmentId });
      if (images.down) return Promise.reject(new Error("the control plane is down"));
      return Promise.resolve(new TextEncoder().encode(`bytes of ${attachmentId}`));
    },
  };
  return images;
}

export interface Api {
  store: ChatStore;
  service: ChatService;
  chat: ChatSetup;
  /** The Telegram transport. */
  transport: FakeTransport;
  zulip: FakeTransport;
  slack: FakeTransport;
  discord: FakeTransport;
  sink: RecordingSink;
  images: FakeRunImages;
  clock: ReturnType<typeof fakeClock>;
  warnings: string[];
  /** Every pause the door's retries asked for. */
  sleeps: number[];
  handle: (req: Request) => Promise<Response>;
  data: (req: Request) => Promise<Response | null>;
  close(): Promise<void>;
}

export async function makeApi(
  /** `images: false` builds the service with no way to reach run images. */
  opts: { lock?: ChatSetupDeps["lock"]; images?: false } = {},
): Promise<Api> {
  const handle = await makeTestDb();
  const store = drizzleChatStore(handle);
  const transport = fakeTransport("telegram");
  const zulip = fakeTransport("zulip");
  const slack = fakeTransport("slack");
  const discord = fakeTransport("discord");
  const sink = recordingSink();
  const images = fakeRunImages();
  const clock = fakeClock();
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const authenticate = (req: Request): Promise<Principal | Response> => {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (token === ADMIN) return Promise.resolve(user("u-admin", ["*"]));
    if (token === PLAIN) {
      return Promise.resolve(user("u-plain", capsClaimOf("member")));
    }
    if (token === OTHER) {
      return Promise.resolve(user("u-other", capsClaimOf("member")));
    }
    return Promise.resolve(new Response("nope", { status: 401 }));
  };
  const chat = setup({
    store,
    transports: { telegram: transport, zulip, slack, discord },
    sink,
    images: opts.images === false ? undefined : images,
    masterKey: await importMasterKey(MASTER_KEY_HEX),
    authenticate,
    gatewayToken: GATEWAY,
    serviceToken: SERVICE,
    lock: opts.lock,
    now: clock.now,
    diag: { debug() {}, warn: (event) => void warnings.push(event) },
    pollTimeoutS: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return {
    store,
    service: chat.service,
    chat,
    transport,
    zulip,
    slack,
    discord,
    sink,
    images,
    clock,
    warnings,
    sleeps,
    handle: makeRouter([...chat.routes, ...chat.internalRoutes]),
    data: chat.dataHandler,
    close: () => handle.close(),
  };
}

export function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ADMIN,
): Promise<Response> {
  return handler(
    new Request(`http://chat.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** A Telegram room, created as the API creates one, with the fake bot's token. */
export async function makeRoom(api: Api, name = "acme incidents") {
  return await api.service.createChatroom({
    kind: "telegram",
    name,
    botToken: BOT_TOKEN,
    ownerUserId: "u-plain",
  });
}

/** A Zulip room: the organization is the room, so it is linked from birth. */
export async function makeZulipRoom(api: Api, name = "radicle") {
  return await api.service.createChatroom({
    kind: "zulip",
    name,
    realmUrl: ZULIP_REALM,
    botEmail: ZULIP_EMAIL,
    apiKey: ZULIP_KEY,
    ownerUserId: "u-plain",
  });
}

/** A Slack room: the workspace the app is installed in is the room, linked from birth, and the
 * one room created with two secrets. */
export async function makeSlackRoom(api: Api, name = "acme") {
  return await api.service.createChatroom({
    kind: "slack",
    name,
    botToken: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    ownerUserId: "u-plain",
  });
}

/** A Discord room: the server it names is the room, linked from birth. */
export async function makeDiscordRoom(api: Api, name = "acme") {
  return await api.service.createChatroom({
    kind: "discord",
    name,
    botToken: DISCORD_BOT_TOKEN,
    guildId: DISCORD_GUILD,
    ownerUserId: "u-plain",
  });
}

/**
 * Links a Telegram room the way an operator does: mention the bot in the group QUOTING the
 * room's one-time code. A bare mention links nothing — that was the capture the code closes.
 */
export async function linkRoom(
  api: Api,
  room: { id: string; linkCode: string | null },
  updateId = 1,
): Promise<void> {
  api.transport.deliver(
    BOT_TOKEN,
    mention({ updateId, text: `@ryph_bot ${room.linkCode}` }),
  );
  await api.service.pollOnce(room.id, new AbortController().signal);
}

/** A run bound to a room's conversation, ready to post and be spoken to. A string is an existing
 * conversation's key; a `new` conversation is one the platform opens — a Zulip topic, a Slack
 * thread. */
export async function bindRun(
  api: Api,
  chatroomId: string,
  runId = "r-1",
  conversation: string | OpenBindingConversation = "",
) {
  const outcome = await api.service.openBinding({
    runId,
    chatroomId,
    agentName: "Ada",
    taskTitle: "automation: api latency",
    runUrl: "http://app.test/tasks/t-1",
    conversation: typeof conversation === "string"
      ? { kind: "thread", threadKey: conversation }
      : conversation,
  });
  if (outcome.kind === "refused") throw new Error(outcome.error);
  return outcome.binding;
}
