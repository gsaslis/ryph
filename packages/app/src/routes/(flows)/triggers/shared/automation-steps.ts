// The steps an automation is made and edited in, the fields each step holds, the checks that say
// why a step cannot be saved as it stands, and the bridges between the fields and the API's
// shapes. The checks mirror the automations service's schema so a refusal is seen here first,
// in the operator's words; what only the service can judge — a schedule's real cadence — is
// left to it.

import { isGitRefName } from "@ryph/shared/refs";
import {
  composeResponsePolicy,
  type CreateAutomationInput,
  type ResponsePolicyInput,
  type UpdateAutomationInput,
} from "$lib/api/automations";
import {
  type Agent,
  type Automation,
  type AutomationTarget,
  type Chatroom,
  CHATROOM_KIND_LABEL,
  CONVERSATION_NOUN,
  isOneConversation,
  type ResponseConversation,
  type WebhookFormat,
} from "$lib/api/types";
import {
  blankMapping,
  composeMapping,
  formatYieldsKeys,
  type MappingFields,
  mappingProblem,
  mappingToFields,
  presetById,
  type PresetId,
  presetOfFormat,
  type ResponseChoice,
} from "$lib/automations/presets";

export type { ResponseChoice };

export type AutomationStepId = "trigger" | "agent" | "instructions" | "response" | "review";

export interface AutomationStep {
  id: AutomationStepId;
  label: string;
  heading: string;
  description: string;
}

/** The steps in the order they are listed; the review is the create flow's alone. */
export const AUTOMATION_STEPS: readonly AutomationStep[] = [
  {
    id: "trigger",
    label: "Trigger",
    heading: "Trigger",
    description: "What starts a run: a request from another service, or a schedule.",
  },
  {
    id: "response",
    label: "Response",
    heading: "Response",
    description: "What happens each time it starts: a run, or a conversation you can talk to.",
  },
  {
    id: "agent",
    label: "Agent and code",
    heading: "Agent and code",
    description: "Which agent runs, and which repository or workspace the run checks out.",
  },
  {
    id: "instructions",
    label: "Instructions",
    heading: "Instructions",
    description: "What the agent does each time this starts.",
  },
  {
    id: "review",
    label: "Review",
    heading: "Review",
    description:
      "Everything the automation will be created with. Any step can be changed from here.",
  },
];

// ── trigger ────────────────────────────────────────────────────────────────────────────────────

export type TriggerKind = "webhook" | "schedule";
export type VerificationKind = "hmac-sha256" | "secret-header" | "standard-webhooks";

/** The trigger step as the form holds it: both kinds' fields, whichever is picked. */
export interface TriggerFields {
  kind: TriggerKind;
  /** What sends the requests; null until it is picked. A preset fills the verification. */
  preset: PresetId | null;
  verification: VerificationKind;
  /** The header the sender puts the signature or secret in; "" for the kind's default. */
  header: string;
  /** Text before the hex digest, or before the secret in a header; "" for none. */
  prefix: string;
  /** "Something else" only: the body passed on as is, or read with the mapping. */
  formatKind: "raw" | "custom";
  mapping: MappingFields;
  /** Accepted fires a minute; the rest answer 429 and are recorded as dropped. */
  firesPerMinute: number;
  cron: string;
  timezone: string;
}

/** The header each verification kind reads when none is typed — the service's own defaults. */
export const DEFAULT_HEADER: Record<VerificationKind, string> = {
  "hmac-sha256": "x-ryph-signature",
  "secret-header": "authorization",
  "standard-webhooks": "webhook-signature",
};

/** The signature prefix a sender most often puts before the digest — the service's default. */
export const DEFAULT_PREFIX = "sha256=";

/** The service's own rate limit for a webhook with none set: one fire a minute. */
export const DEFAULT_FIRES_PER_MINUTE = 1;

/** Where a known alerting sender starts. */
export const PRESET_FIRES_PER_MINUTE = 10;

/** Schedules most automations want, by name; a cron expression none of them match is "custom". */
export const CRON_PRESETS: readonly { label: string; cron: string }[] = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
];

/** The preset a cron expression is, by its label, or null for one typed by hand. */
export function presetOf(cron: string): string | null {
  const normalised = cron.trim().split(/\s+/).join(" ");
  return CRON_PRESETS.find((p) => p.cron === normalised)?.label ?? null;
}

/** The zone this browser keeps time in — "9am" here means 9am here — or UTC where unknown. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA zone this runtime knows, for a picker; empty where it cannot say. */
export function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Whether the runtime accepts the name as a timezone — the same test the service makes. */
export function isTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A new automation's trigger: a webhook whose sender is still to be picked, signed at the
 * service's defaults, or every five minutes in this browser's zone once switched to a schedule. */
export function blankTrigger(): TriggerFields {
  return {
    kind: "webhook",
    preset: null,
    verification: "hmac-sha256",
    header: "",
    prefix: DEFAULT_PREFIX,
    formatKind: "raw",
    mapping: blankMapping(),
    firesPerMinute: DEFAULT_FIRES_PER_MINUTE,
    cron: CRON_PRESETS[0].cron,
    timezone: browserTimezone(),
  };
}

/** A saved automation's trigger as the form holds it; the other kind's fields sit at their
 * defaults, unshown since the kind cannot change. */
export function triggerToFields(trigger: Automation["trigger"]): TriggerFields {
  const blank = blankTrigger();
  if (trigger.kind === "webhook") {
    const v = trigger.verification;
    return {
      ...blank,
      kind: "webhook",
      preset: presetOfFormat(trigger.format).id,
      verification: v.kind,
      header: v.kind === "standard-webhooks" ? "" : v.header,
      prefix: v.kind === "standard-webhooks" ? "" : v.prefix,
      formatKind: trigger.format.kind === "custom" ? "custom" : "raw",
      mapping: trigger.format.kind === "custom"
        ? mappingToFields(trigger.format.mapping)
        : blankMapping(),
      firesPerMinute: firesPerMinuteOf(trigger.rateLimit),
    };
  }
  return { ...blank, kind: "schedule", cron: trigger.cron, timezone: trigger.timezone };
}

/** A rate limit as fires a minute, whatever window it was saved with. */
export function firesPerMinuteOf(limit: { maxPerWindow: number; windowMs: number }): number {
  return Math.max(1, Math.round(limit.maxPerWindow * 60_000 / limit.windowMs));
}

/**
 * Picks a sender: its verification and format, filled in. Returns the fields with the preset
 * applied; the name and the response step are the caller's to default.
 */
export function applyPreset(fields: TriggerFields, id: PresetId): TriggerFields {
  const preset = presetById(id);
  const v = preset.verification;
  // Alerting senders send in bursts (a firing, then an acknowledgement a few seconds on), so a
  // known sender starts at ten a minute; a limit already changed by hand stays.
  if (id !== "other" && fields.firesPerMinute === DEFAULT_FIRES_PER_MINUTE) {
    fields = { ...fields, firesPerMinute: PRESET_FIRES_PER_MINUTE };
  }
  if (id === "other") {
    return {
      ...fields,
      preset: id,
      verification: "hmac-sha256",
      header: "",
      prefix: DEFAULT_PREFIX,
    };
  }
  return {
    ...fields,
    preset: id,
    verification: v.kind,
    header: v.kind === "standard-webhooks" ? "" : v.header,
    prefix: v.kind === "standard-webhooks" ? "" : v.prefix,
  };
}

/** The format the fields describe: the preset's own, or raw or a custom mapping. */
export function composeFormat(fields: TriggerFields): WebhookFormat {
  if (fields.preset !== null && fields.preset !== "other") {
    return { kind: presetById(fields.preset).format } as WebhookFormat;
  }
  return fields.formatKind === "custom"
    ? { kind: "custom", mapping: composeMapping(fields.mapping) }
    : { kind: "raw" };
}

/** Whether fires from this trigger carry a key a response can be matched on. */
export function triggerYieldsKeys(fields: TriggerFields): boolean {
  return fields.kind === "webhook" && formatYieldsKeys(composeFormat(fields));
}

/** Whether the secret comes from the sender and is pasted after the automation is created. */
export function secretToPaste(fields: TriggerFields): boolean {
  if (fields.kind !== "webhook") return false;
  if (fields.verification === "standard-webhooks") return true;
  if (fields.preset === null) return false;
  const preset = presetById(fields.preset);
  return preset.secretSource === "pasted" && preset.verification.kind === fields.verification;
}

/** When and how the secret comes, said where the sender is picked: it never exists before the
 * automation does. Null until a sender is picked. */
export function secretHint(fields: TriggerFields): string | null {
  if (fields.kind !== "webhook" || fields.preset === null) return null;
  const vendor = fields.preset === "other" ? null : presetById(fields.preset).name;
  if (secretToPaste(fields)) {
    return `After creating, you'll paste the signing secret ${vendor ?? "the sender"} gives you.`;
  }
  return `You get the URL and secret after creating the automation, with steps for ${
    vendor ?? "connecting the sender"
  }.`;
}

/** Why the trigger step cannot be saved as it stands, in the operator's words — or null. */
export function triggerProblem(name: string, fields: TriggerFields): string | null {
  if (fields.kind === "webhook" && fields.preset === null) {
    return "Choose what sends the requests.";
  }
  if (name.trim() === "") return "Give the automation a name.";
  if (name.trim().length > 200 || /[\r\n]/.test(name)) {
    return "A name is one line, up to 200 characters.";
  }
  if (fields.kind === "webhook") {
    const header = fields.header.trim();
    if (header.length > 100 || /[\r\n]/.test(header)) {
      return "A header name is one line, up to 100 characters.";
    }
    if (fields.verification !== "standard-webhooks" && fields.prefix.length > 20) {
      return "A prefix is up to 20 characters.";
    }
    if (fields.preset === "other" && fields.formatKind === "custom") {
      const problem = mappingProblem(fields.mapping);
      if (problem !== null) return problem;
    }
    const fires = fields.firesPerMinute;
    if (!Number.isInteger(fires) || fires < 1 || fires > 600) {
      return "The rate limit is a whole number of fires a minute, from 1 to 600.";
    }
    return null;
  }
  const cron = fields.cron.trim();
  if (cron === "") return "Give the schedule a cron expression.";
  if (cron.split(/\s+/).length !== 5) {
    return "A cron expression has five fields: minute, hour, day, month and weekday.";
  }
  if (cron.length > 100) return "A cron expression is up to 100 characters.";
  const timezone = fields.timezone.trim();
  if (timezone === "") return "Pick the timezone the schedule keeps.";
  if (timezone.length > 100 || !isTimezone(timezone)) {
    return `"${timezone}" is not a timezone name. Use an IANA name like Europe/Athens.`;
  }
  return null;
}

/** The trigger a create sends: the picked kind's fields, an empty header left to the service
 * to default, and the rate limit in the form's one-minute window. */
export function composeTrigger(fields: TriggerFields): CreateAutomationInput["trigger"] {
  if (fields.kind === "schedule") {
    return { kind: "schedule", cron: fields.cron.trim(), timezone: fields.timezone.trim() };
  }
  const header = fields.header.trim();
  const verification: Extract<CreateAutomationInput["trigger"], { kind: "webhook" }>[
    "verification"
  ] = fields.verification === "standard-webhooks"
    ? { kind: "standard-webhooks" }
    : fields.verification === "hmac-sha256"
    ? { kind: "hmac-sha256", ...(header ? { header } : {}), prefix: fields.prefix }
    : {
      kind: "secret-header",
      ...(header ? { header } : {}),
      ...(fields.prefix ? { prefix: fields.prefix } : {}),
    };
  return {
    kind: "webhook",
    verification,
    format: composeFormat(fields),
    rateLimit: { maxPerWindow: fields.firesPerMinute, windowMs: 60_000 },
  };
}

/** The trigger's revisable half for a PATCH: a webhook's format and rate limit, a schedule's
 * cron and zone. How a webhook is verified is fixed at creation, and so is the kind. */
export function triggerPatch(
  fields: TriggerFields,
): Pick<UpdateAutomationInput, "rateLimit" | "format" | "cron" | "timezone"> {
  return fields.kind === "webhook"
    ? {
      format: composeFormat(fields),
      rateLimit: { maxPerWindow: fields.firesPerMinute, windowMs: 60_000 },
    }
    : { cron: fields.cron.trim(), timezone: fields.timezone.trim() };
}

// ── agent and code ─────────────────────────────────────────────────────────────────────────────

/** The agent step as the form holds it: who runs, and what the run checks out. */
export interface TargetFields {
  agentId: string;
  kind: AutomationTarget["kind"];
  connectedRepoId: string;
  /** The ref a repo is checked out at; "" for its default branch. */
  ref: string;
  workspaceId: string;
}

export function blankTarget(): TargetFields {
  return { agentId: "", kind: "repo", connectedRepoId: "", ref: "", workspaceId: "" };
}

export function targetToFields(automation: Automation): TargetFields {
  const target = automation.target;
  return {
    ...blankTarget(),
    agentId: automation.agentId,
    kind: target.kind,
    ...(target.kind === "repo"
      ? { connectedRepoId: target.connectedRepoId, ref: target.ref ?? "" }
      : { workspaceId: target.workspaceId }),
  };
}

/** Why the agent step cannot be saved as it stands — or null. Which repositories and workspaces
 * exist is the page's to know; this only checks that something is picked and the ref is sane. */
export function targetProblem(
  fields: TargetFields,
  agents: readonly Pick<Agent, "id" | "archivedAt">[],
): string | null {
  const agent = agents.find((a) => a.id === fields.agentId);
  if (agent === undefined) return "Pick the agent that runs.";
  if (agent.archivedAt !== null) return "That agent is archived. Pick a live one.";
  if (fields.kind === "workspace") {
    return fields.workspaceId === "" ? "Pick a workspace." : null;
  }
  if (fields.connectedRepoId === "") return "Pick a repository.";
  const ref = fields.ref.trim();
  if (ref === "") return null;
  // 200: the automations service's own cap on a ref (`gitName` in packages/automations/src/schema.ts).
  return ref.length <= 200 && isGitRefName(ref) ? null : "That is not a valid branch or ref name.";
}

export function composeTarget(fields: TargetFields): AutomationTarget {
  if (fields.kind === "workspace") return { kind: "workspace", workspaceId: fields.workspaceId };
  const ref = fields.ref.trim();
  return { kind: "repo", connectedRepoId: fields.connectedRepoId, ref: ref === "" ? null : ref };
}

// ── instructions ───────────────────────────────────────────────────────────────────────────────

/** Why the instructions step cannot be saved as it stands — or null. */
export function instructionsProblem(instructions: string): string | null {
  return instructions.trim() === "" ? "Say what the agent should do each time this starts." : null;
}

// ── response ───────────────────────────────────────────────────────────────────────────────────

/** The response step as the form holds it. The room fields' own verdict (an archived room, one
 * with channels but no private channel) comes in beside them. */
export interface ResponseFields {
  /** What each start does. Null until the step is first seen: the trigger's default stands in,
   * and follows the trigger as it changes. Once set it is the person's, and nothing else
   * changes it; a trigger or room that no longer fits it is reported, never corrected. */
  choice: ResponseChoice | null;
  chatroomId: string;
  channelId: string;
  idleMinutes: number;
  attendedIdleMinutes: number;
  /** The first message in the room carries what was sent. */
  postAlert: boolean;
  /** "shared": every conversation continues in one topic or thread. Holds only with a channel. */
  conversation: ResponseConversation;
}

/** The idle clocks a new automation starts with: thirty minutes of quiet while no person has
 * written in the conversation, sixty once one has. */
export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_ATTENDED_IDLE_MINUTES = 60;

export function blankResponse(): ResponseFields {
  return {
    choice: null,
    chatroomId: "",
    channelId: "",
    idleMinutes: DEFAULT_IDLE_MINUTES,
    attendedIdleMinutes: DEFAULT_ATTENDED_IDLE_MINUTES,
    postAlert: false,
    conversation: "per-response",
  };
}

export function responseToFields(policy: Automation["response"]): ResponseFields {
  if (policy === null) return { ...blankResponse(), choice: "run" };
  return {
    choice: policy.correlation,
    chatroomId: policy.chatroomId ?? "",
    channelId: policy.channelId ?? "",
    idleMinutes: Math.round(policy.idleMs / 60_000),
    attendedIdleMinutes: Math.round(policy.attendedIdleMs / 60_000),
    postAlert: policy.postAlert,
    conversation: policy.conversation,
  };
}

/** What a trigger suggests before anything is picked: a sender that reads keys gets one
 * conversation per key, a schedule one per run, anything else a plain run. */
export function defaultResponseChoice(trigger: TriggerFields): ResponseChoice {
  if (trigger.kind === "schedule") return "fire";
  return triggerYieldsKeys(trigger) ? "key" : "run";
}

/** The choice in force: the person's, or the trigger's default while they have made none. */
export function responseChoiceOf(fields: ResponseFields, trigger: TriggerFields): ResponseChoice {
  return fields.choice ?? defaultResponseChoice(trigger);
}

/** The fields with the default made the person's: done once the step has been seen, so what was
 * on screen is never changed by a later edit elsewhere. */
export function settleResponseChoice(
  fields: ResponseFields,
  trigger: TriggerFields,
): ResponseFields {
  return fields.choice === null ? { ...fields, choice: defaultResponseChoice(trigger) } : fields;
}

/** The reason a conversation choice can't keep several open at once in this room, or null. */
export function oneConversationRoom(
  fields: Pick<ResponseFields, "chatroomId">,
  rooms: readonly Pick<Chatroom, "id" | "kind">[],
): string | null {
  const room = rooms.find((r) => r.id === fields.chatroomId);
  if (room === undefined || !isOneConversation(room.kind)) return null;
  return `A ${CHATROOM_KIND_LABEL[room.kind]} group holds one conversation at a time.`;
}

/** What the one shared conversation is called (a topic, a thread) when every response goes in
 * it, or null when each opens its own: shared holds only in a live room with channels, with one
 * picked. An archived room hides the choice on the form, so it raises no conflict either. */
export function sharedConversationNoun(
  fields: Pick<ResponseFields, "chatroomId" | "channelId" | "conversation">,
  rooms: readonly (Pick<Chatroom, "id" | "kind"> & { archivedAt?: string | null })[],
): string | null {
  if (fields.conversation !== "shared" || fields.channelId === "") return null;
  const room = rooms.find((r) => r.id === fields.chatroomId);
  if (room === undefined || (room.archivedAt ?? null) !== null) return null;
  if (isOneConversation(room.kind)) return null;
  return CONVERSATION_NOUN[room.kind];
}

/** Why a shared topic or thread holds one response at a time, as the form says it. */
const sharedReason = (noun: string) =>
  `Every response posts in one ${noun}, so only one is open at a time.`;

/** The reason a conversation choice can't keep several open at once, or null: a room that holds
 * one conversation, or a single shared topic or thread. */
export function oneConversationReason(
  fields: Pick<ResponseFields, "chatroomId" | "channelId" | "conversation">,
  rooms: readonly Pick<Chatroom, "id" | "kind">[],
): string | null {
  const reason = oneConversationRoom(fields, rooms);
  if (reason !== null) return reason;
  const noun = sharedConversationNoun(fields, rooms);
  return noun === null ? null : sharedReason(noun);
}

/**
 * Why the choice no longer fits what was picked around it: a trigger that reads nothing to
 * group by, or a room that holds one conversation. Kept apart from the step's other problems
 * because a change on another step causes it, so the step is marked at once.
 */
export function responseConflict(
  fields: ResponseFields,
  trigger: TriggerFields,
  rooms: readonly Pick<Chatroom, "id" | "kind">[],
): string | null {
  const choice = responseChoiceOf(fields, trigger);
  if (choice === "run") return null;
  if (choice === "key" && !triggerYieldsKeys(trigger)) {
    if (trigger.kind === "schedule") {
      return "A schedule has nothing to group conversations by. Pick another option.";
    }
    if (trigger.preset === "other" && trigger.formatKind === "custom") {
      return "Without an ID field there is nothing to group conversations by. Add one on the " +
        "Trigger step, or pick another option.";
    }
    return "A body passed on as is has nothing to group conversations by. Pick another option.";
  }
  if (choice !== "automation") {
    const reason = oneConversationRoom(fields, rooms);
    if (reason !== null) {
      return `${reason} Pick one shared conversation, or another room.`;
    }
    const noun = sharedConversationNoun(fields, rooms);
    if (noun !== null) {
      return `${sharedReason(noun)} Pick one shared conversation.`;
    }
  }
  return null;
}

/** Why the response step cannot be saved as it stands — or null. `roomBlocked` is the room
 * fields' verdict on the picked room and channel. */
export function responseProblem(
  fields: ResponseFields,
  trigger: TriggerFields,
  rooms: readonly Pick<Chatroom, "id" | "kind">[],
  roomBlocked: boolean,
): string | null {
  if (responseChoiceOf(fields, trigger) === "run") return null;
  const conflict = responseConflict(fields, trigger, rooms);
  if (conflict !== null) return conflict;
  if (roomBlocked) {
    return "The conversation has no room it can be sent to. Pick a live room, and a private " +
      "channel in it where the platform has channels.";
  }
  for (const minutes of [fields.idleMinutes, fields.attendedIdleMinutes]) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return "Each stretch of quiet is a whole number of minutes, from 1 to 1440.";
    }
  }
  return null;
}

/** The policy a form sends, or null for a plain run. The choice is sent as it is: a form with a
 * problem is never sent. */
export function composeResponse(
  fields: ResponseFields,
  trigger: TriggerFields,
  rooms: Pick<Chatroom, "id" | "kind">[],
): ResponsePolicyInput | null {
  const choice = responseChoiceOf(fields, trigger);
  if (choice === "run") return null;
  return composeResponsePolicy({ ...fields, correlation: choice }, rooms);
}
