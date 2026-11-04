import { describe, expect, it } from "vitest";
import { getChatroomChannels, getChatroomGroups } from "./chatrooms";
import {
  accessProblem,
  commandRoomProblem,
  commandRoomToFields,
  composeCommandRoom,
  composeTarget,
  DEFAULT_STARTS_PER_HOUR,
  deleteCommandRoom,
  getCommandRoom,
  isPublicChannel,
  saveCommandRoom,
  targetToFields,
} from "./command-rooms";
import type { CommandRoom } from "./types";

// Command rooms at the client: the control plane's own path (never under /v1/chatrooms, which a
// deployment forwards to the chat service), a missing policy read as "none", the form's round
// trip through the saved shape, and the checks the form makes before the control plane does.

const respond = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  ((url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

const saved: CommandRoom = {
  chatroomId: "chr-1",
  ownerUserId: "u-admin",
  agentIds: ["ag-1", "ag-2"],
  defaultAgentId: "ag-1",
  defaultTarget: { kind: "workspace", workspaceId: "ws-1" },
  commanders: { kind: "group", groupId: "33" },
  startsPerHour: 6,
  channels: [{
    channelId: "4",
    channelName: "desktop",
    target: { kind: "repo", connectedRepoId: "cr-1", ref: null },
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
  }],
  createdAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
};

describe("the command-room api", () => {
  it("reads, saves and deletes at /v1/command-rooms/:chatroomId", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const got = await getCommandRoom(respond(200, saved, seen), "chr-1");
    expect(seen.url).toBe("/api/v1/command-rooms/chr-1");
    expect(got?.commanders).toEqual({ kind: "group", groupId: "33" });

    await saveCommandRoom(
      respond(200, saved, seen),
      "chr-1",
      composeCommandRoom(
        commandRoomToFields(saved, "zulip"),
      ),
    );
    expect(seen.url).toBe("/api/v1/command-rooms/chr-1");
    expect(seen.init?.method).toBe("PUT");
    const body = JSON.parse(String(seen.init?.body));
    expect(body).not.toHaveProperty("ownerUserId");
    expect(body.channels).toEqual([{
      channelId: "4",
      channelName: "desktop",
      target: { kind: "repo", connectedRepoId: "cr-1", ref: null },
    }]);

    await deleteCommandRoom(respond(204, null, seen), "chr-1");
    expect(seen.init?.method).toBe("DELETE");
  });

  it("reads a room with no policy as null, and anything else as the error it is", async () => {
    expect(await getCommandRoom(respond(404, { error: "no policy" }), "chr-1")).toBeNull();
    await expect(getCommandRoom(respond(403, { error: "admins only" }), "chr-1")).rejects
      .toThrow("admins only");
  });

  it("lists a room's channels and groups from the chat service", async () => {
    const seen: { url?: string } = {};
    const channels = await getChatroomChannels(
      respond(200, { channels: [{ id: "4", name: "bugs", visibility: "web-public" }] }, seen),
      "chr-1",
    );
    expect(seen.url).toBe("/api/v1/chatrooms/chr-1/channels");
    expect(channels.channels[0].visibility).toBe("web-public");
    // A body from before the platform said either way reads as the whole list.
    expect(channels.truncated).toBe(false);
    const groups = await getChatroomGroups(
      respond(200, { groups: [{ id: "33", name: "core", description: "" }] }, seen),
      "chr-1",
    );
    expect(seen.url).toBe("/api/v1/chatrooms/chr-1/groups");
    expect(groups[0].name).toBe("core");
  });
});

describe("the command-room form", () => {
  it("round-trips a saved policy", () => {
    const fields = commandRoomToFields(saved, "zulip");
    expect(commandRoomProblem(fields)).toBeNull();
    const composed = composeCommandRoom(fields);
    expect(composed).toEqual({
      agentIds: saved.agentIds,
      defaultAgentId: "ag-1",
      defaultTarget: saved.defaultTarget,
      commanders: saved.commanders,
      startsPerHour: 6,
      channels: [{ channelId: "4", channelName: "desktop", target: saved.channels[0].target }],
    });
  });

  it("starts a Zulip room on a group and a Telegram room on the room", () => {
    const zulip = commandRoomToFields(null, "zulip");
    expect(zulip.commanders).toBe("group");
    expect(zulip.startsPerHour).toBe(DEFAULT_STARTS_PER_HOUR);
    expect(commandRoomToFields(null, "telegram").commanders).toBe("room");
  });

  it("says what is missing before the control plane has to", () => {
    const ok = commandRoomToFields(saved, "zulip");
    expect(commandRoomProblem({ ...ok, agentIds: [] })).toMatch(/at least one agent/);
    expect(commandRoomProblem({ ...ok, defaultAgentId: "ag-9" })).toMatch(/default agent/);
    expect(commandRoomProblem({ ...ok, groupId: "" })).toMatch(/user group/);
    expect(accessProblem({ ...ok, groupId: "" }, "role")).toBe("Pick a role.");
    expect(commandRoomProblem({ ...ok, commanders: "room", groupId: "" })).toBeNull();
    for (const startsPerHour of [0, 101, 2.5]) {
      expect(commandRoomProblem({ ...ok, startsPerHour })).toMatch(/Runs per hour/);
    }
    expect(commandRoomProblem({
      ...ok,
      defaultTarget: { ...ok.defaultTarget, kind: "repo", connectedRepoId: "" },
    })).toMatch(/Finish picking/);
    // No default and no channels: the room would serve nothing.
    expect(commandRoomProblem({ ...ok, defaultTarget: targetToFields(null), channels: [] }))
      .toMatch(/give a channel its own/);
    // No default but a channel: an allowlist of channels, which is fine.
    expect(commandRoomProblem({ ...ok, defaultTarget: targetToFields(null) })).toBeNull();
    const row = ok.channels[0];
    expect(commandRoomProblem({ ...ok, channels: [row, row] })).toMatch(/listed twice/);
    expect(commandRoomProblem({ ...ok, channels: [{ ...row, channelId: "" }] }))
      .toMatch(/Pick a channel/);
    expect(commandRoomProblem({ ...ok, channels: [{ ...row, target: targetToFields(null) }] }))
      .toMatch(/#desktop/);
  });

  it("composes a target: a blank ref is the default branch, a half-picked one is none", () => {
    expect(composeTarget({ kind: "repo", connectedRepoId: "cr-1", ref: "  ", workspaceId: "" }))
      .toEqual({ kind: "repo", connectedRepoId: "cr-1", ref: null });
    expect(composeTarget({ kind: "repo", connectedRepoId: "cr-1", ref: "dev", workspaceId: "" }))
      .toEqual({ kind: "repo", connectedRepoId: "cr-1", ref: "dev" });
    expect(composeTarget({ kind: "workspace", connectedRepoId: "", ref: "", workspaceId: "" }))
      .toBeNull();
    expect(composeTarget(targetToFields(null))).toBeNull();
  });

  it("treats every channel but a private one as public", () => {
    expect(isPublicChannel("private")).toBe(false);
    expect(isPublicChannel("public")).toBe(true);
    expect(isPublicChannel("web-public")).toBe(true);
  });
});
