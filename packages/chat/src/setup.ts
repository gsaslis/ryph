// The package's startup contract for the mounted deployment: one call builds every half — the
// management routes, the internal surface a remote orchestrator dials, the MCP data handler
// the gateway forwards to, and the poll pass the composition root ticks — over the ONE store
// the root provides. No env reads, no sockets, no timers: the root owns those.

import { makeServiceGate, type MasterKey, mintId } from "@ryph/sealed";
import { json, type Route } from "@ryph/shared/http";
import { makeChatSealer } from "./sealing.ts";
import { type ChatDiag, type ChatService, makeChatService } from "./core/service.ts";
import { makeChatDataHandler } from "./http/data.ts";
import { internalChatRoutes } from "./http/internal.ts";
import { chatRoutes } from "./http/routes.ts";
import type { Authenticate } from "@ryph/auth/gates";
import type { Chatroom, ChatroomKind } from "./core/types.ts";
import type { MentionSink } from "./ports/mention_sink.ts";
import type { RunImages } from "./ports/run_images.ts";
import type { ChatStore } from "./ports/store.ts";
import type { ChatTransport } from "./ports/transport.ts";

export interface ChatSetupDeps {
  store: ChatStore;
  /** One transport per platform: `telegramTransport()`, `zulipTransport()`, `slackTransport()`,
   * `discordTransport()`. */
  transports: Record<ChatroomKind, ChatTransport>;
  /** Where every mention goes: the control plane's mention door, in-process or over HTTP. */
  sink: MentionSink;
  /** The images a run's tools returned, at the control plane — in-process or over HTTP. Absent:
   * a post naming one is refused, and nothing else changes. */
  images?: RunImages;
  /** RYPH_CHAT_KEY, this package's own: platform secrets are sealed under a key derived from it. */
  masterKey: MasterKey;
  /** The user-surface gate for the management routes, provided by the mounting host. */
  authenticate: Authenticate;
  /**
   * The credential the MCP gateway presents on the data route (RYPH_CHAT_GATEWAY_TOKEN).
   * Null: the data route refuses everything — no gateway can reach the tool.
   */
  gatewayToken: string | null;
  /**
   * The credential a REMOTE orchestrator presents on the internal surface (RYPH_CHAT_TOKEN).
   * Null: the internal routes are not built — the single process holds the service directly.
   */
  serviceToken?: string | null;
  /**
   * Serialises the poll of one room across replicas; absent under the single process, where
   * nobody else could be polling.
   *
   * A room is taken once and kept, not taken and dropped per pass — a room's Slack connection
   * outlives a pass and only one poller may hold one — so `held` is asked on every pass after
   * the first. A lock lives on a connection, and a connection that goes away releases it without
   * telling anyone: a poller that went by what it once took would keep a socket open against a
   * room another replica had already picked up.
   */
  lock?: {
    /** Takes the room for this poller, answering a release, or null when another replica has it. */
    take(chatroomId: string): Promise<(() => Promise<void>) | null>;
    /** Whether this poller still holds the room, asked of the lock rather than remembered. */
    held(chatroomId: string): Promise<boolean>;
  };
  now(): Date;
  diag: ChatDiag;
  /** Tests shrink the platform's long-poll hold. */
  pollTimeoutS?: number;
  /** Tests make the door's retry pauses instant. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ChatSetup {
  service: ChatService;
  /** The management surface, for the host's route table. */
  routes: Route[];
  /** The service-authed surface a remote orchestrator dials; empty without a service token. */
  internalRoutes: Route[];
  /**
   * The MCP data handler: answers the chat MCP path, null for any other. The gateway's platform
   * entry dials this — in-process under the single binary, over HTTP standalone.
   */
  dataHandler: (req: Request) => Promise<Response | null>;
  /**
   * One poll pass over every live room: each room's long poll, in turn, under the lock when one
   * is provided. The root ticks it; `signal` cuts a hold short on drain. A room whose poll
   * throws is warned and skipped — the next pass asks again from the same cursor. A room another
   * replica holds is not polled here at all, and one that has left the list — archived — gives up
   * both its lock and whatever its transport was holding for it.
   *
   * A room's lock is taken once and kept, not taken and dropped per pass: a Slack connection
   * outlives a pass, so the poller that owns the room must own it for as long as it polls it.
   */
  pollAll(signal: AbortSignal): Promise<void>;
}

/** The advisory-lock key a room's poll takes — this service's own number space. */
export function pollLockKey(chatroomId: string): number {
  let hash = 0;
  for (const ch of chatroomId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return 8_500_000 + (hash % 100_000);
}

/** A failing room's poll is retried after this, doubling per failure, up to the cap. */
const POLL_RETRY_BASE_MS = 2_000;
const POLL_RETRY_MAX_MS = 5 * 60_000;

export function setup(deps: ChatSetupDeps): ChatSetup {
  const service = makeChatService({
    store: deps.store,
    transports: deps.transports,
    sink: deps.sink,
    images: deps.images,
    sealer: makeChatSealer(deps.masterKey),
    now: deps.now,
    diag: deps.diag,
    mintId,
    pollTimeoutS: deps.pollTimeoutS,
    sleep: deps.sleep,
  });
  const gatewayGate = deps.gatewayToken === null
    ? () => Promise.resolve(json(503, { error: "the chat data route has no gateway token" }))
    : makeServiceGate(deps.gatewayToken);
  // The rooms whose poll is still holding: a pass that lands while the previous one is mid-hold
  // must not double a room's long poll — setInterval does not await.
  const holding = new Set<string>();
  /**
   * The lock each room's poll holds, kept for as long as THIS poller answers for that room and
   * not just for one pass. A Slack room's Socket Mode connection outlives a pass, and it
   * acknowledges every envelope the moment it arrives: a second poller opening its own connection
   * for the same app would split Slack's events between the two, and whichever of them lost the
   * next pass would drop the ones it had already acknowledged. Holding the lock means one poller
   * owns a room's connection for the connection's whole life, which is the only arrangement that
   * loses nothing. The lock rides a reserved connection, so a poller that dies releases
   * everything it held.
   */
  const locks = new Map<string, () => Promise<void>>();
  /**
   * Whether this poller answers for the room: the lock is taken the first time and asked after,
   * never assumed. A lock that was ours and is not any more means the connection it lived on went
   * away, and forgetting it is all there is to do — its release would unlock a key this session
   * no longer holds, and the next pass takes the room again if it is free.
   */
  const ours = async (chatroomId: string): Promise<boolean> => {
    const lock = deps.lock;
    if (lock === undefined) return true;
    if (!locks.has(chatroomId)) {
      const release = await lock.take(chatroomId);
      if (release === null) return false;
      locks.set(chatroomId, release);
      return true;
    }
    if (await lock.held(chatroomId)) return true;
    locks.delete(chatroomId);
    return false;
  };
  /**
   * Rooms whose last poll failed: how many times in a row, the failure, and when the next poll
   * is due — for the room as it stood (`roomVersion`). A room that cannot poll (a token that
   * does not open, a platform that keeps refusing) would otherwise warn on every tick; it warns
   * when the failure is new or different, and is polled again on a doubling delay. Any edit to
   * the room starts it afresh.
   */
  const failing = new Map<
    string,
    { version: string; failures: number; err: string; retryAtMs: number }
  >();
  const roomVersion = (room: Chatroom) =>
    `${room.updatedAt}|${room.sealedBotToken}|${room.sealedAppToken ?? ""}`;
  return {
    service,
    routes: chatRoutes({ service, authenticate: deps.authenticate, diag: deps.diag }),
    internalRoutes: deps.serviceToken
      ? internalChatRoutes({
        service,
        authenticate: makeServiceGate(deps.serviceToken),
        diag: deps.diag,
      })
      : [],
    dataHandler: makeChatDataHandler({
      service,
      authenticate: gatewayGate,
      diag: deps.diag,
    }),
    async pollAll(signal) {
      const rooms = await service.listPollable();
      // The rooms this poller answers for, which is every live one until a lock says otherwise.
      // What falls out — a room archived since the last pass, or one another replica now holds —
      // is what the transports are told to let go of.
      const mine = new Set(rooms.map((room) => room.id));
      await Promise.all(rooms.map(async (room) => {
        if (holding.has(room.id) || signal.aborted) return;
        const failed = failing.get(room.id);
        if (failed !== undefined) {
          if (failed.version !== roomVersion(room)) failing.delete(room.id);
          // Still this poller's room while it waits: its lock and connection are kept.
          else if (deps.now().getTime() < failed.retryAtMs) return;
        }
        holding.add(room.id);
        try {
          if (!await ours(room.id)) {
            mine.delete(room.id);
            return;
          }
          await service.pollOnce(room.id, signal);
          failing.delete(room.id);
        } catch (err) {
          if (!signal.aborted) {
            const text = String(err);
            const before = failing.get(room.id);
            const failures = (before?.failures ?? 0) + 1;
            // The first failure is retried on the next tick; from the second, the wait doubles.
            const delayMs = failures === 1
              ? 0
              : Math.min(POLL_RETRY_BASE_MS * 2 ** (failures - 2), POLL_RETRY_MAX_MS);
            failing.set(room.id, {
              version: roomVersion(room),
              failures,
              err: text,
              retryAtMs: deps.now().getTime() + delayMs,
            });
            const fields = { chatroomId: room.id, err: text, failures, retryInMs: delayMs };
            if (before === undefined || before.err !== text) {
              deps.diag.warn("chat.poll_failed", fields);
            } else deps.diag.debug("chat.poll_failed", fields);
          }
        } finally {
          holding.delete(room.id);
        }
      }));
      for (const transport of Object.values(deps.transports)) transport.releaseAllBut(mine);
      // A room that is no longer this poller's — archived, or gone from the list — gives its lock
      // back, so another replica can pick it up as soon as this one has let go of its connection.
      for (const [id, release] of locks) {
        if (mine.has(id)) continue;
        locks.delete(id);
        await release().catch(() => {});
      }
    },
  };
}
