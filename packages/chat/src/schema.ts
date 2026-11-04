// The ingest boundary — every JSON payload is parsed against a schema here before it may travel
// as a core type, same doctrine as the other services'. The tool argument schema doubles as the
// JSON Schema the MCP `tools/list` answers, derived rather than restated so the two cannot drift.

import { z } from "@zod/zod";
import { MAX_POST_TEXT } from "./core/types.ts";

const MAX_LEN = 100_000;
const singleLine = z.string().trim().min(1).max(200).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});
const mintedId = singleLine.regex(/^[A-Za-z0-9._-]+$/, { error: "not a valid id" });

// ── The management surface ─────────────────────────────────────────────────────────────────

/**
 * Whether a realm URL's scheme is acceptable: `https:` always, plain `http:` only for a host that
 * is loopback by name — `localhost`, `*.localhost`, or `127.0.0.1.nip.io` (and its subdomains) —
 * so a dev Zulip in docker works and nothing else is ever dialled in the clear. The API key rides
 * every call as basic auth; over http to a real host it would cross the network readable.
 */
export function realmTransportAllowed(url: string): boolean {
  const u = new URL(url);
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1.nip.io" || host.endsWith(".127.0.0.1.nip.io");
}

/** A token as it rides a header: visible ASCII, nothing else. */
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;

/** Whether the room drops the platform's own bookkeeping lines (core/types.ts `Chatroom.quiet`);
 * off unless asked for, at creation as on every room made before it. */
const quiet = z.boolean().default(false);

/** What POST /v1/chatrooms accepts: a name and the platform credential — shown to nobody
 * afterwards. The platform is the one that judges the credential (Telegram's `getMe`, Zulip's
 * `GET /users/me`, Discord's `GET /users/@me`), and a refusal there is the caller's 400, so these
 * are bounds, not patterns — but for an id whose shape is the platform's own. */
export const CreateChatroomSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("telegram"),
    name: singleLine,
    quiet,
    // A Telegram bot token is `<id>:<secret>`.
    botToken: z.string().trim().min(1).max(500),
  }),
  z.object({
    kind: z.literal("zulip"),
    name: singleLine,
    quiet,
    // The organization's root: a Zulip realm lives at its host's root, so a pasted link to a
    // channel or a trailing slash still names the same realm.
    realmUrl: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }).max(500)
      .refine(realmTransportAllowed, {
        error: "must be an https URL (plain http only for a localhost dev server)",
      })
      .transform((u) => new URL(u).origin),
    botEmail: singleLine.max(320).refine((s) => s.includes("@"), { error: "not an email" }),
    apiKey: z.string().trim().min(1).max(500),
  }),
  z.object({
    kind: z.literal("slack"),
    name: singleLine,
    quiet,
    // The two halves of a Slack app's credential: the bot token the Web API takes, and the
    // app-level token Socket Mode opens a connection with. The prefixes are Slack's own and
    // asked for here so a pair swapped by hand is a field error rather than a puzzling refusal
    // from Slack — the platform is still what judges them.
    // Both ride an `authorization` header, so visible ASCII only: a zero-width space pasted
    // with one would make every call throw, with the header (the token) in the error.
    botToken: z.string().trim().min(1).max(500).regex(VISIBLE_ASCII, {
      error: "must be visible ASCII with no whitespace",
    }).startsWith("xoxb-", {
      error: "must be a bot token, which starts with xoxb-",
    }),
    appToken: z.string().trim().min(1).max(500).regex(VISIBLE_ASCII, {
      error: "must be visible ASCII with no whitespace",
    }).startsWith("xapp-", {
      error: "must be an app-level token, which starts with xapp-",
    }),
  }),
  z.object({
    kind: z.literal("discord"),
    name: singleLine,
    quiet,
    // The bot token from the developer portal's Bot page. It rides `Authorization: Bot <token>`,
    // so visible ASCII only, for the reason Slack's must — which also refuses the header's own
    // `Bot ` pasted with it, by name.
    botToken: z.string().trim().min(1).max(500).regex(VISIBLE_ASCII, {
      error: 'must be visible ASCII with no whitespace — the token alone, without "Bot "',
    }),
    // The server (guild) the room is: a Discord bot can be in many. A snowflake, copied with
    // Developer Mode on (right-click the server → Copy Server ID) — and a string, always: it is
    // past 2^53, where a JSON number would round it to another server.
    guildId: z.string().trim().regex(/^\d{17,20}$/, {
      error: "must be a server id — 17 to 20 digits, from Copy Server ID",
    }),
  }),
]);

export type CreateChatroomInput = z.infer<typeof CreateChatroomSchema>;

/** What PATCH /v1/chatrooms/:id accepts: the room's own settings, each left as it stands when
 * absent — a rename, a quiet switch, or both. Not the credential, which is the room. */
export const UpdateChatroomSchema = z.object({
  name: singleLine.optional(),
  quiet: z.boolean().optional(),
}).refine((edit) => edit.name !== undefined || edit.quiet !== undefined, {
  error: "name the setting to change: name, quiet, or both",
});

export type UpdateChatroomInput = z.infer<typeof UpdateChatroomSchema>;

// ── The internal surface ───────────────────────────────────────────────────────────────────

/** A conversation's key: Telegram "", Zulip a message id, Slack `<channel>:<thread root>`,
 * Discord `<channel>:<thread>`. Bounded and plain in every form. */
const threadKey = z.string().max(200).regex(/^[A-Za-z0-9:._-]*$/, { error: "not a thread key" });

/** A platform's id for a user or a group: Zulip's are integers, Slack's are `U…` and `S…`,
 * Discord's are snowflakes, and all of them are carried as strings. */
const platformId = singleLine.max(100).regex(/^[A-Za-z0-9._:-]+$/, { error: "not a valid id" });

/** The name a conversation the platform opens is asked for, as Zulip bounds a topic: one line,
 * at most 60 characters — inside a Discord thread name's 100. Slack threads have no name and
 * ignore it. */
const topic = z.string().trim().min(1).max(60).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

/**
 * Which conversation a run binds to: an existing one by its key (Telegram "", Zulip a message
 * id, Slack `<channel>:<thread root>`, Discord `<channel>:<thread>`), or a NEW one the platform
 * opens in `channelId` by posting the opening line: a Zulip topic of the name given, a Slack
 * thread under the post itself, a Discord thread of the name given started from it. The
 * run is then keyed by that post. `continue` is the conversation an earlier run was bound to —
 * a shared response conversation, every response of one automation in one place — or, when that
 * one cannot be continued, a `new` one opened as `channelId` and `topic` say
 * (core/service.ts `OpenBindingConversation`).
 */
export const OpenBindingConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadKey }),
  z.object({ kind: z.literal("new"), channelId: singleLine, topic }),
  z.object({
    kind: z.literal("continue"),
    // Newest first; the control plane sends the automation's last few.
    previousRunIds: z.array(mintedId).min(1).max(20),
    channelId: singleLine,
    topic,
  }),
]);

export const OpenBindingSchema = z.object({
  runId: mintedId,
  chatroomId: mintedId,
  agentName: singleLine,
  taskTitle: singleLine.max(500),
  runUrl: z.url().max(2_000).nullable(),
  conversation: OpenBindingConversationSchema,
  // The fire that opened a response, for the opening line to show. The control plane sends at
  // most 64 KiB of the payload; the line shows far less (service.ts `alertBlock`).
  alert: z.object({
    title: z.string().max(500).nullable(),
    payload: z.string().max(64 * 1024),
  }).optional(),
});

export const CloseBindingSchema = z.object({
  outcome: singleLine.max(64),
  summary: z.string().max(MAX_LEN),
  patches: z.array(z.object({
    path: singleLine,
    state: singleLine.max(64),
    forgeUrl: z.url().max(2_000).nullable(),
  })).max(100),
  issues: z.array(z.object({
    repo: singleLine,
    // A GitHub issue's number; a Radicle issue has no number, only an id, which the control
    // plane sends as a short prefix string.
    number: z.union([z.number().int().positive(), singleLine.max(64)]),
    url: z.url().max(2_000).nullable(),
  })).max(100),
  runUrl: z.url().max(2_000).nullable(),
  // Release a stale binding without a closing line (core/types.ts `RunClosing.silent`).
  silent: z.boolean().optional(),
});

export const CommanderCheckSchema = z.object({
  chatroomId: mintedId,
  userId: platformId,
  groupId: platformId,
});

export const ThreadFetchSchema = z.object({
  chatroomId: mintedId,
  threadKey,
});

/** The conversation a shared response would continue — `OpenBindingConversationSchema`'s
 * `continue`, without the topic a new one would open under. */
export const ContinuedThreadFetchSchema = z.object({
  chatroomId: mintedId,
  previousRunIds: z.array(mintedId).min(1).max(20),
  channelId: singleLine,
});

// ── The mention door's answer ───────────────────────────────────────────────────────────────

/** What the control plane's `POST /v1/chat/mentions` answers — parsed here because it crosses
 * a process boundary like any request does. */
export const MentionVerdictSchema = z.object({
  outcome: z.enum([
    "started",
    "joined",
    "denied",
    "refused",
    "not-served",
    "rate-limited",
    "unverifiable",
    "no-binding",
    "deduped",
  ]),
  reply: z.string().max(MAX_LEN).nullable(),
  react: z.boolean(),
  runId: z.string().max(200).optional(),
  taskId: z.string().max(200).optional(),
});

// ── The control plane's image resolution ──────────────────────────────────────────────────

/** A ref as the control plane names an image: `img-` and twelve hex characters. */
const imageRef = z.string().regex(/^img-[0-9a-f]{12}$/, { error: "not an image ref" });

/** What `POST /v1/chat/runs/:runId/images/resolve` answers. */
export const ImageResolutionSchema = z.object({
  images: z.array(z.object({
    ref: imageRef,
    attachmentId: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    url: z.string().max(2_000).nullable(),
  })).max(100),
  unknown: z.array(z.string().max(200)).max(100),
});

// ── The tools ───────────────────────────────────────────────────────────────────────────────

export const PostArgsSchema = z.object({
  text: z.string().min(1).max(MAX_POST_TEXT).describe(
    "What to say in the conversation this run is bound to. Keep it short: people read it " +
      "on their phones, and it is not a document. To show an image a tool returned in this " +
      "run, write ![what it shows](img-…) with the ref from its `Image ref:` line, at most 10 " +
      "in one text. Where the room can, each shows where you put it (Zulip, Telegram); " +
      "elsewhere the images are posted after the text.",
  ),
});

/** The JSON Schema the MCP `tools/list` answers, derived from the zod schema. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}
