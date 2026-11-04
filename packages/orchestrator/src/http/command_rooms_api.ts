// Command rooms, as an admin keeps them: GET/PUT/DELETE /v1/command-rooms/:chatroomId on the
// user surface. Deliberately NOT under /v1/chatrooms/*: that prefix is the chat service's, and a
// deployment that forwards it there (the app's proxy, an ingress) would swallow these. A command room is the policy that lets a mention of the bot START work in a
// chatroom (core/types.ts `CommandRoom`); the mention door (chat_api.ts) is where it is read.
//
// Invariants:
// - admin-only, every verb: the policy decides who on a chat server may spend the owner's budget
//   and steer an agent holding a checkout, and whose repo access the runs borrow
// - the owner is the admin who SAVED it, never a field of the body: runs act for the owner, and
//   naming somebody else would borrow their access without their say
// - the PUT carries the whole policy, channel rows included, and replaces it as one unit
// - what can be checked here is checked here — the agents exist and are live, every target
//   resolves to a live repo or workspace — and what cannot is enforced at the mention: whether a
//   channel is public is the chat platform's to say, so the visibility rule and the "room"
//   commanders' private-channel rule are the door's, on every start
// - the chatroom itself lives in the chat service; this surface cannot see it, so a policy may
//   name a room id the chat service does not know — it then simply never hears a mention

import type { AutomationTarget, CommandRoom } from "../core/types.ts";
import { resolveWorkspace } from "../core/workspaces.ts";
import { CommandRoomSchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

/** A chat service room id, as the mention door's schema takes one. */
const CHATROOM_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function commandRoomRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;

  /** Why a target does not resolve, or null when it does. */
  const targetRefusal = async (target: AutomationTarget, where: string): Promise<string | null> => {
    if (target.kind === "repo") {
      const repo = await store.getConnectedRepo(target.connectedRepoId);
      if (repo === null || repo.archivedAt !== null) {
        return `${where}: no connected repo ${target.connectedRepoId}`;
      }
      return null;
    }
    const checkout = await resolveWorkspace(store, target.workspaceId);
    return checkout.kind === "refused" ? `${where}: ${checkout.error}` : null;
  };

  const getRoom = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:manage", "managing a command room");
    if (denied) return denied;
    const room = await store.getCommandRoom(params.chatroomId);
    if (room === null) return json(404, { error: "this chatroom has no command policy" });
    return json(200, room);
  };

  const putRoom = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:manage", "managing a command room");
    if (denied) return denied;
    // A saved room starts tasks as its owner on every mention, so saving one is a standing
    // delegation of `tasks:create`: a credential that cannot start a task itself must not be
    // able to leave behind a room that does.
    const cannotStart = refuseUnless(caller, "tasks:create", "saving a command room");
    if (cannotStart) return cannotStart;
    if (!CHATROOM_ID.test(params.chatroomId)) return json(400, { error: "not a chatroom id" });
    // Runs act for the owner, and break-glass is nobody: there is no user whose repo access a
    // run could borrow, and inventing one would be the audit trail's one lie.
    if (caller.kind !== "user") {
      return json(403, {
        error: "a command room runs as the admin who saves it — sign in as one",
        code: "owner_required",
      });
    }
    const body = await parseBody(req, CommandRoomSchema);
    if (!body.ok) return body.res;
    const policy = body.data;

    for (const id of policy.agentIds) {
      const agent = await store.getAgent(id);
      if (agent === null || agent.archivedAt !== null) {
        return json(400, { error: `agentIds: no live agent ${id}` });
      }
    }
    const targets: Array<[AutomationTarget, string]> = [
      ...(policy.defaultTarget === null
        ? []
        : [[policy.defaultTarget, "defaultTarget"] as [AutomationTarget, string]]),
      ...policy.channels.map((c): [AutomationTarget, string] => [
        c.target,
        `channels.${c.channelId}`,
      ]),
    ];
    for (const [target, where] of targets) {
      const refusal = await targetRefusal(target, where);
      if (refusal !== null) return json(400, { error: refusal });
    }

    const at = deps.now().toISOString();
    const existing = await store.getCommandRoom(params.chatroomId);
    const born = (channelId: string) =>
      existing?.channels.find((c) => c.channelId === channelId)?.createdAt ?? at;
    const room: CommandRoom = {
      chatroomId: params.chatroomId,
      ownerUserId: caller.userId,
      agentIds: policy.agentIds,
      defaultAgentId: policy.defaultAgentId,
      defaultTarget: policy.defaultTarget,
      commanders: policy.commanders,
      startsPerHour: policy.startsPerHour,
      channels: policy.channels.map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName,
        target: c.target,
        createdAt: born(c.channelId),
        updatedAt: at,
      })),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    await store.saveCommandRoom(room);
    // Provenance: which credential left this delegation behind — a session or an API token.
    deps.diag.debug("command_room.saved", {
      chatroomId: room.chatroomId,
      ownerUserId: room.ownerUserId,
      via: caller.via,
      sid: caller.sid,
    });
    return json(200, await store.getCommandRoom(params.chatroomId));
  };

  const deleteRoom = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "chat:manage", "managing a command room");
    if (denied) return denied;
    // Runs already started keep going on their own clocks. What stops is new work AND steering:
    // a mention here is a response room's again, and a run started from a thread has no
    // response for a response room's mention to reach it through.
    if (!await store.deleteCommandRoom(params.chatroomId)) {
      return json(404, { error: "this chatroom has no command policy" });
    }
    return new Response(null, { status: 204 });
  };

  return [
    route("GET", "/v1/command-rooms/:chatroomId", getRoom),
    route("PUT", "/v1/command-rooms/:chatroomId", putRoom),
    route("DELETE", "/v1/command-rooms/:chatroomId", deleteRoom),
  ];
}
