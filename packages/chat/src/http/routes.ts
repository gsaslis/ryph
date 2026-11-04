// The management surface, as a mountable route list — the same trick as the memory service:
// the Route shape is structurally the orchestrator router's, so the single-process host spreads
// these into its own table and the standalone main.ts serves them on its own listener.
//
// Invariants:
// - listing rooms takes `chat:read` and creating one `chat:write`: a Telegram, Slack or Discord
//   room reaches its platform at one fixed address. A Zulip room takes `chat:manage` on top,
// because   the server then dials the realm URL it names. Editing a room's settings (its name,
// whether it   is quiet) and archiving it, and reading its channels and groups, are the creator's,
// or a   holder of `chat:manage`'s — the channel list names the private channels the bot is in, and
//   the group list is the workspace's. Break-glass passes everywhere.
// - a Zulip realm is dialled over https, or plain http only at a loopback-named dev host
// - the platform secrets (a Telegram bot token, a Zulip API key, Slack's token pair, a Discord
//   bot token) cross this
//   surface exactly once, inward, on create — and never outward
// - a refusal about the input (a credential the platform rejects) is a 400 naming why; a
//   platform that does not answer a read is a 502; a store failure is a 500

import { ChatRefusedError, type ChatService } from "../core/service.ts";
import { CreateChatroomSchema, UpdateChatroomSchema } from "../schema.ts";
import { actorOf, type Authenticate, type Principal, refuseUnless } from "@ryph/auth/gates";
import { type Handler, json, parseBody, type Route, route } from "@ryph/shared/http";

const MAX_BODY_BYTES = 64 * 1024;

export type { Handler, Route };

/**
 * The machine-readable marker on a "chat is off" refusal. The VALUE is the contract, not this
 * name: @ryph/app builds on its own and carries its own copy.
 */
export const CHAT_DISABLED = "chat_disabled";

export interface ChatRoutesDeps {
  service: ChatService;
  /** The host's user-surface gate: a principal means proceed, a Response is the refusal to send. */
  authenticate: Authenticate;
  /** Where an unexpected failure is reported before it is answered as a 500. */
  diag?: { warn(event: string, fields?: Record<string, unknown>): void };
}

const PATHS = {
  collection: "/v1/chatrooms",
  item: "/v1/chatrooms/:id",
  archive: "/v1/chatrooms/:id/archive",
  channels: "/v1/chatrooms/:id/channels",
  groups: "/v1/chatrooms/:id/groups",
} as const;

/** Every route answers JSON, a failure included: a refusal about the input is the caller's 400,
 * anything else is a 500 that names nothing — the diag has the cause. */
function guarded(routes: Route[], diag: ChatRoutesDeps["diag"]): Route[] {
  return routes.map((r) => ({
    ...r,
    handler: async (req, params) => {
      try {
        return await r.handler(req, params);
      } catch (err) {
        if (err instanceof ChatRefusedError) return json(400, { error: err.message });
        diag?.warn("chat.route_failed", {
          method: r.method,
          path: new URL(req.url).pathname,
          err: String(err),
        });
        return json(500, { error: "internal error" });
      }
    },
  }));
}

export function chatRoutes(deps: ChatRoutesDeps): Route[] {
  const { service } = deps;

  /** The creator, or a holder of `chat:manage`: a room is shared configuration, but it is
   * somebody's bot. */
  const mayManage = async (caller: Principal, id: string): Promise<Response | null> => {
    const denied = refuseUnless(caller, "chat:write");
    if (denied) return denied;
    const manage = refuseUnless(caller, "chat:manage");
    if (manage === null) return null;
    const owner = await service.ownerOf(id);
    if (owner === null) return json(404, { error: "no such chatroom" });
    return owner === actorOf(caller) ? null : manage;
  };

  const list = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:read");
    if (denied) return denied;
    return json(200, { chatrooms: await service.listChatrooms() });
  };

  const create = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:write");
    if (denied) return denied;
    const body = await parseBody(req, CreateChatroomSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    // A Zulip room makes this server dial a URL the caller supplied — with a credential, on every
    // poll, forever — so creating one takes `chat:manage`. A Telegram room only ever dials
    // api.telegram.org, a Slack room only slack.com and a Discord room only discord.com, so all
    // three stay any writer's.
    if (body.data.kind === "zulip") {
      const refused = refuseUnless(caller, "chat:manage");
      if (refused) return refused;
    }
    const chatroom = await service.createChatroom({ ...body.data, ownerUserId: actorOf(caller) });
    return json(201, { chatroom });
  };

  const get = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:read");
    if (denied) return denied;
    const chatroom = await service.getChatroom(params.id);
    return chatroom === null ? json(404, { error: "no such chatroom" }) : json(200, { chatroom });
  };

  const update = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const refused = await mayManage(caller, params.id);
    if (refused) return refused;
    const body = await parseBody(req, UpdateChatroomSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    const chatroom = await service.updateChatroom(params.id, body.data);
    return chatroom === null ? json(404, { error: "no such chatroom" }) : json(200, { chatroom });
  };

  const archive = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const refused = await mayManage(caller, params.id);
    if (refused) return refused;
    const chatroom = await service.archiveChatroom(params.id);
    return chatroom === null ? json(404, { error: "no such chatroom" }) : json(200, { chatroom });
  };

  /** A read the platform answers — the room's channels or groups, for the command-room form —
   * behind the room's own gate. Null from `read` is a room this service does not know. */
  const platformRead = (
    key: "channels" | "groups",
    read: (id: string) => Promise<Record<string, unknown> | null>,
  ) =>
  async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const refused = await mayManage(caller, params.id);
    if (refused) return refused;
    let items: Record<string, unknown> | null;
    try {
      items = await read(params.id);
    } catch (err) {
      deps.diag?.warn("chat.platform_read_failed", {
        chatroomId: params.id,
        key,
        err: String(err),
      });
      return json(502, { error: "the chat platform did not answer" });
    }
    return items === null ? json(404, { error: "no such chatroom" }) : json(200, items);
  };

  return guarded([
    route("GET", PATHS.collection, list),
    route("POST", PATHS.collection, create),
    route("GET", PATHS.item, get),
    route("PATCH", PATHS.item, update),
    route("POST", PATHS.archive, archive),
    route(
      "GET",
      PATHS.channels,
      platformRead("channels", async (id) => {
        const list = await service.listChannels(id);
        return list === null ? null : { channels: list.channels, truncated: list.truncated };
      }),
    ),
    route(
      "GET",
      PATHS.groups,
      platformRead("groups", async (id) => {
        const groups = await service.listGroups(id);
        return groups === null ? null : { groups };
      }),
    ),
  ], deps.diag);
}

/**
 * The stand-in for a deployment with no chat service: every route answers a stable refusal, so
 * the app can show "chat is off" instead of a 404 it cannot tell from a typo.
 */
export function disabledChatRoutes(
  deps: { authenticate(req: Request): Promise<Response | null> },
): Route[] {
  const off = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(503, { error: "chat is not configured on this deployment", code: CHAT_DISABLED });
  };
  return [
    route("GET", PATHS.collection, off),
    route("POST", PATHS.collection, off),
    route("GET", PATHS.item, off),
    route("PATCH", PATHS.item, off),
    route("POST", PATHS.archive, off),
    route("GET", PATHS.channels, off),
    route("GET", PATHS.groups, off),
  ];
}
