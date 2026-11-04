import { apiCall, ApiError } from "./call";
import {
  type AutomationTarget,
  type ChannelVisibility,
  type ChatroomKind,
  type CommandRoom,
  type CommandRoomCommanders,
  commandRoomSchema,
  isOneConversation,
} from "./types";

/**
 * A command room is the control plane's, not the chat service's: it lives at
 * /v1/command-rooms/:chatroomId so that nothing forwarding /v1/chatrooms/* to the chat service
 * can swallow it. Every verb is an admin's.
 */
const path = (chatroomId: string) => `/v1/command-rooms/${encodeURIComponent(chatroomId)}`;

/** What PUT takes: the whole policy, channel rows included. The owner is never sent — the
 * control plane records the admin who saves it. */
export type CommandRoomInput = {
  agentIds: string[];
  defaultAgentId: string;
  defaultTarget: AutomationTarget | null;
  commanders: CommandRoomCommanders;
  startsPerHour: number;
  channels: Array<{ channelId: string; channelName: string; target: AutomationTarget }>;
};

/** The room's policy, or null when it has none (a room responses report into). */
export async function getCommandRoom(f = fetch, chatroomId: string): Promise<CommandRoom | null> {
  try {
    return commandRoomSchema.parse(await apiCall(f, path(chatroomId)));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function saveCommandRoom(
  f = fetch,
  chatroomId: string,
  input: CommandRoomInput,
): Promise<CommandRoom> {
  return commandRoomSchema.parse(
    await apiCall(f, path(chatroomId), { method: "PUT", body: JSON.stringify(input) }),
  );
}

/** Stops new work and steering from the room; runs already started keep going. */
export async function deleteCommandRoom(f = fetch, chatroomId: string): Promise<void> {
  await apiCall(f, path(chatroomId), { method: "DELETE" });
}

// ---- the form ------------------------------------------------------------------------------

/** A target as the form holds it: "none" only where no target is a meaningful answer (the
 * room-wide default). */
export type TargetFields = {
  kind: "none" | "repo" | "workspace";
  connectedRepoId: string;
  /** "" = the repo's default branch. */
  ref: string;
  workspaceId: string;
};

export type ChannelRowFields = {
  channelId: string;
  /** Kept from the saved row, or the channel list's name — display only; the id is the key. */
  channelName: string;
  target: TargetFields;
};

export type CommandRoomFields = {
  agentIds: string[];
  defaultAgentId: string;
  defaultTarget: TargetFields;
  commanders: "group" | "room";
  groupId: string;
  startsPerHour: number;
  channels: ChannelRowFields[];
};

/** A new room's rate: enough for a team's day, low enough to notice a runaway. */
export const DEFAULT_STARTS_PER_HOUR = 10;
export const MAX_STARTS_PER_HOUR = 100;

export function targetToFields(target: AutomationTarget | null): TargetFields {
  if (target === null) return { kind: "none", connectedRepoId: "", ref: "", workspaceId: "" };
  if (target.kind === "workspace") {
    return { kind: "workspace", connectedRepoId: "", ref: "", workspaceId: target.workspaceId };
  }
  return {
    kind: "repo",
    connectedRepoId: target.connectedRepoId,
    ref: target.ref ?? "",
    workspaceId: "",
  };
}

/** The target the fields describe; null for "none" or a half-picked one (see the problem). */
export function composeTarget(fields: TargetFields): AutomationTarget | null {
  if (fields.kind === "repo") {
    if (fields.connectedRepoId === "") return null;
    const ref = fields.ref.trim();
    return { kind: "repo", connectedRepoId: fields.connectedRepoId, ref: ref === "" ? null : ref };
  }
  if (fields.kind === "workspace") {
    return fields.workspaceId === ""
      ? null
      : { kind: "workspace", workspaceId: fields.workspaceId };
  }
  return null;
}

/**
 * The form's starting point: the saved policy, or a new room's defaults. On a platform with
 * channels the commanders default to a group — a public channel is the whole workspace, and on an
 * open server "everyone in the room" is everyone on the internet — while a Telegram room has no
 * groups to name, so it can only be "the room".
 */
export function commandRoomToFields(
  room: CommandRoom | null,
  kind: ChatroomKind,
): CommandRoomFields {
  if (room === null) {
    return {
      agentIds: [],
      defaultAgentId: "",
      // A repository to start from: the one choice every room needs, and the only one a
      // Telegram group can have.
      defaultTarget: { ...targetToFields(null), kind: "repo" },
      commanders: isOneConversation(kind) ? "room" : "group",
      groupId: "",
      startsPerHour: DEFAULT_STARTS_PER_HOUR,
      channels: [],
    };
  }
  return {
    agentIds: [...room.agentIds],
    defaultAgentId: room.defaultAgentId,
    defaultTarget: targetToFields(room.defaultTarget),
    commanders: room.commanders.kind,
    groupId: room.commanders.kind === "group" ? room.commanders.groupId : "",
    startsPerHour: room.startsPerHour,
    channels: room.channels.map((c) => ({
      channelId: c.channelId,
      channelName: c.channelName,
      target: targetToFields(c.target),
    })),
  };
}

/**
 * Why each part of the fields cannot be saved as it stands, or null — one check per step of the
 * form, so a step can say what is wrong with it alone. The control plane checks all of this
 * again, and more (the agents are live, the targets resolve); this is the form's early word.
 */
export function agentsProblem(fields: CommandRoomFields): string | null {
  if (fields.agentIds.length === 0) return "Pick at least one agent.";
  if (!fields.agentIds.includes(fields.defaultAgentId)) {
    return "Pick a default agent.";
  }
  return null;
}

/** `groupNoun` is what the platform calls its groups ("user group", Discord's "role"). */
export function accessProblem(
  fields: CommandRoomFields,
  groupNoun = "user group",
): string | null {
  if (fields.commanders === "group" && fields.groupId === "") {
    return `Pick a ${groupNoun}.`;
  }
  const rate = fields.startsPerHour;
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_STARTS_PER_HOUR) {
    return `Runs per hour must be a whole number from 1 to ${MAX_STARTS_PER_HOUR}.`;
  }
  return null;
}

export function checkoutProblem(fields: CommandRoomFields): string | null {
  if (fields.defaultTarget.kind !== "none" && composeTarget(fields.defaultTarget) === null) {
    return "Finish picking a repository or workspace.";
  }
  const seen = new Set<string>();
  for (const row of fields.channels) {
    if (row.channelId === "") return "Pick a channel in every row, or remove the row.";
    if (seen.has(row.channelId)) return `#${row.channelName} is listed twice.`;
    seen.add(row.channelId);
    if (composeTarget(row.target) === null) {
      return `Pick a repository or workspace for #${row.channelName}.`;
    }
  }
  if (fields.defaultTarget.kind === "none" && fields.channels.length === 0) {
    return "Pick a repository or workspace, or give a channel its own.";
  }
  return null;
}

/** Why the fields cannot be saved at all, or null: the steps' checks, first one to object. */
export function commandRoomProblem(fields: CommandRoomFields): string | null {
  return agentsProblem(fields) ?? accessProblem(fields) ?? checkoutProblem(fields);
}

/** The PUT body. Only meaningful once `commandRoomProblem` says nothing. */
export function composeCommandRoom(fields: CommandRoomFields): CommandRoomInput {
  return {
    agentIds: fields.agentIds,
    defaultAgentId: fields.defaultAgentId,
    defaultTarget: composeTarget(fields.defaultTarget),
    commanders: fields.commanders === "group"
      ? { kind: "group", groupId: fields.groupId }
      : { kind: "room" },
    startsPerHour: fields.startsPerHour,
    channels: fields.channels.flatMap((row) => {
      const target = composeTarget(row.target);
      return target === null
        ? []
        : [{ channelId: row.channelId, channelName: row.channelName, target }];
    }),
  };
}

/** Whether what the agent posts into this channel is readable beyond its members — and so why
 * the door lets it command only targets whose repos are all public. */
export function isPublicChannel(visibility: ChannelVisibility): boolean {
  return visibility !== "private";
}

export const VISIBILITY_LABEL: Record<ChannelVisibility, string> = {
  private: "Private",
  public: "Public",
  "web-public": "Web-public",
};
