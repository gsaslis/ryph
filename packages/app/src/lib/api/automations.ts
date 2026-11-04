import { z } from "zod";
import { apiCall } from "./call";
import {
  type Automation,
  type AutomationFire,
  automationFireSchema,
  automationSchema,
  type AutomationTarget,
  type Chatroom,
  type Correlation,
  isOneConversation,
  type ResponseConversation,
  type WebhookFormat,
} from "./types";

/** How a webhook's requests are trusted, as a create sends it; an absent header or prefix is
 * the service's default. Standard Webhooks (Svix) has fixed headers and a pasted secret. A
 * `secret` is one pasted from the sender; absent, one is minted (for a sender that makes its own,
 * a hidden placeholder until its secret is pasted by rotate). */
export type VerificationInput =
  | { kind: "hmac-sha256"; header?: string; prefix?: string; secret?: string }
  | { kind: "secret-header"; header?: string; prefix?: string; secret?: string }
  | { kind: "standard-webhooks"; secret?: string };

export type CreateAutomationInput = {
  name: string;
  trigger:
    | {
      kind: "webhook";
      verification: VerificationInput;
      format: WebhookFormat;
      rateLimit?: { maxPerWindow: number; windowMs: number };
    }
    | { kind: "schedule"; cron: string; timezone?: string };
  agentId: string;
  target: AutomationTarget;
  instructions: string;
  /** Set: fires open or join a response instead of starting a run each. Absent or null: a run
   * per fire. The clocks default server-side to five and thirty minutes. */
  response?: ResponsePolicyInput | null;
};

/** The response policy as a caller writes it; the idle clocks are optional and defaulted. */
export type ResponsePolicyInput = {
  chatroomId?: string | null;
  /** Rooms with channels only: the one each response opens its own conversation in. The service
   * refuses such a room without one, and a channel on a Telegram room or with no room. */
  channelId?: string | null;
  correlation?: Correlation;
  idleMs?: number;
  attendedIdleMs?: number;
  /** The opening message carries the alert that started the conversation. Off by default. */
  postAlert?: boolean;
  /** Rooms with channels only: "shared" continues one conversation across every response. The
   * service refuses it without a channel, and with a "fire" or "key" correlation (an unnamed
   * one then defaults to "automation"). Defaults to "per-response". */
  conversation?: ResponseConversation;
};

/** The response fields as both forms hold them: "" for no room, no channel; clocks in minutes. */
export type ResponseFields = {
  chatroomId: string;
  channelId: string;
  correlation: Correlation;
  idleMinutes: number;
  attendedIdleMinutes: number;
  postAlert: boolean;
  conversation: ResponseConversation;
};

/**
 * The policy a form sends. A channel belongs to a room that has channels: whatever the form
 * holds, a Telegram room or no room sends `channelId: null`, so a channel left over from an
 * earlier pick never reaches the service. The correlation is sent as picked: a Telegram room
 * holds one response at a time and the service refuses any but "automation" there, which the
 * form reports before sending rather than changing the pick. A shared conversation needs a
 * channel, so it is sent only with one.
 */
export function composeResponsePolicy(
  fields: ResponseFields,
  rooms: Pick<Chatroom, "id" | "kind">[],
): ResponsePolicyInput {
  const chatroomId = fields.chatroomId === "" ? null : fields.chatroomId;
  const room = rooms.find((r) => r.id === chatroomId);
  const channelId = room !== undefined && !isOneConversation(room.kind) && fields.channelId !== ""
    ? fields.channelId
    : null;
  return {
    chatroomId,
    channelId,
    correlation: fields.correlation,
    idleMs: Math.round(fields.idleMinutes * 60_000),
    attendedIdleMs: Math.round(fields.attendedIdleMinutes * 60_000),
    // Only a room hears the opening message.
    postAlert: chatroomId !== null && fields.postAlert,
    conversation: channelId !== null ? fields.conversation : "per-response",
  };
}

export type UpdateAutomationInput = {
  name?: string;
  agentId?: string;
  target?: AutomationTarget;
  instructions?: string;
  /** `null` clears the policy back to a run per fire. */
  response?: ResponsePolicyInput | null;
  rateLimit?: { maxPerWindow: number; windowMs: number };
  /** Webhooks only: how the body is read. */
  format?: WebhookFormat;
  cron?: string;
  timezone?: string;
};

/** The create response: the automation plus, for a webhook whose secret was minted, the secret:
 * the ONE time the server ever reveals it. */
export type CreatedAutomation = { automation: Automation; secret: string | null };

const createdSchema = z.object({
  automation: automationSchema,
  secret: z.string().nullish().transform((secret) => secret ?? null),
});
const oneSchema = z.object({ automation: automationSchema });

export async function getAutomations(f = fetch): Promise<Automation[]> {
  const res = await apiCall(f, "/v1/automations");
  return z.object({ automations: z.array(automationSchema) }).parse(res).automations;
}

export async function getAutomation(f = fetch, id: string): Promise<Automation> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}`);
  return oneSchema.parse(res).automation;
}

export async function createAutomation(
  f = fetch,
  input: CreateAutomationInput,
): Promise<CreatedAutomation> {
  return createdSchema.parse(
    await apiCall(f, "/v1/automations", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateAutomation(
  f = fetch,
  id: string,
  input: UpdateAutomationInput,
): Promise<Automation> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return oneSchema.parse(res).automation;
}

export async function deleteAutomation(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function enableAutomation(f = fetch, id: string): Promise<Automation> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}/enable`, {
    method: "POST",
  });
  return oneSchema.parse(res).automation;
}

export async function disableAutomation(f = fetch, id: string): Promise<Automation> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}/disable`, {
    method: "POST",
  });
  return oneSchema.parse(res).automation;
}

/**
 * Replaces the secret, and the old one stops verifying at once. With no `secret`, one is minted
 * and returned this once; with one pasted from the sender, nothing is returned.
 */
export async function rotateAutomationSecret(
  f = fetch,
  id: string,
  secret?: string,
): Promise<string | null> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}/rotate-secret`, {
    method: "POST",
    body: JSON.stringify(secret === undefined ? {} : { secret }),
  });
  // A pasted secret may come back as an empty body: nothing to show either way.
  return z.object({ secret: z.string().nullish() }).nullish().parse(res)?.secret ?? null;
}

export async function getAutomationFires(f = fetch, id: string): Promise<AutomationFire[]> {
  const res = await apiCall(f, `/v1/automations/${encodeURIComponent(id)}/fires`);
  return z.object({ fires: z.array(automationFireSchema) }).parse(res).fires;
}
