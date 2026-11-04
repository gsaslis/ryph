// The drizzle schema for the chat service's tables. Same conventions as the memory service's:
// drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601 text
// timestamps, columns mirror the core types field-for-field.
//
// Where these rows live is deployment-dependent, exactly as memory's are: the shared instance
// under the single process, a database of their own (`ryph_chat`) when the service runs
// standalone. So there is no FK to any other owner's table — `run_id` is the control plane's id,
// carried as text.

import { bigint, boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ChatBinding, ChatroomKind } from "../../../core/types.ts";

export const chatrooms = pgTable("chatrooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<ChatroomKind>().notNull(),
  botUsername: text("bot_username").notNull(),
  botId: text("bot_id").notNull(),
  // The platform secret — Telegram's bot token, Zulip's bot API key, Slack's bot token — AES-GCM
  // under RYPH_CHAT_KEY. Never selected into a response.
  sealedBotToken: text("sealed_bot_token").notNull(),
  // Slack only, sealed the same way: the app-level token Socket Mode opens a connection with.
  // Slack is the one platform whose room holds two secrets.
  sealedAppToken: text("sealed_app_token"),
  // Zulip only: the organization and the bot's email, the public halves of its credential.
  realmUrl: text("realm_url"),
  botEmail: text("bot_email"),
  chatId: text("chat_id"),
  chatTitle: text("chat_title"),
  // The one-time code a linking mention must quote; cleared the moment the room links. A bare
  // mention authenticates nobody — the bot's @username is public and privacy mode is off.
  linkCode: text("link_code"),
  // Drops the platform's own opening and success lines (core/types.ts `Chatroom.quiet`). Off for
  // every room made before it, which then sounds exactly as it did.
  quiet: boolean("quiet").notNull().default(false),
  ownerUserId: text("owner_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
}, (t) => [
  index("chatrooms_by_owner").on(t.ownerUserId),
  // One bot, one live Discord room: one Gateway connection carries every server a bot is in, and
  // the day's identify budget is the token's. The service checks first to name the twin; this is
  // what decides when two creations race, and an archived room frees its bot.
  uniqueIndex("chatrooms_one_discord_bot").on(t.botId).where(
    sql`${t.kind} = 'discord' AND ${t.archivedAt} IS NULL`,
  ),
]);

// One active binding per CONVERSATION (room, thread key) is the rule — Telegram's constant key
// makes that one per room — and a PARTIAL UNIQUE INDEX is what enforces it. A conditional insert
// cannot: its `WHERE NOT EXISTS` subquery reads the same snapshot as its racer, so under READ
// COMMITTED two concurrent opens both see no active binding and both land — and a follow-up
// mention then matches one of two live runs at random while both runs' posts interleave in the
// conversation. The loser's insert raises 23505, which the store maps to the same "no" the
// caller's 409 already handles.
export const chatBindings = pgTable("chat_bindings", {
  id: text("id").primaryKey(),
  chatroomId: text("chatroom_id").notNull().references(() => chatrooms.id),
  runId: text("run_id").notNull(),
  // Telegram "", Zulip the id of the mention that started the run, Slack `<channel>:<thread>`.
  threadKey: text("thread_key").notNull(),
  agentName: text("agent_name").notNull(),
  taskTitle: text("task_title").notNull(),
  runUrl: text("run_url"),
  state: text("state").$type<ChatBinding["state"]>().notNull(),
  // The room's quiet switch as it stood when the run bound (core/types.ts `ChatBinding.quiet`).
  quiet: boolean("quiet").notNull().default(false),
  createdAt: text("created_at").notNull(),
  closedAt: text("closed_at"),
}, (t) => [
  index("chat_bindings_by_run").on(t.runId, t.createdAt),
  index("chat_bindings_by_room").on(t.chatroomId, t.state),
  uniqueIndex("chat_bindings_one_active").on(t.chatroomId, t.threadKey).where(
    sql`${t.state} = 'active'`,
  ),
]);

export const chatPollCursors = pgTable("chat_poll_cursors", {
  chatroomId: text("chatroom_id").primaryKey().references(() => chatrooms.id),
  // Telegram: the next update id. Zulip: the events queue's last event id. Slack: zero — Socket
  // Mode has no position to resume from, so the row says only that the room has been heard from.
  offset: integer("offset").notNull(),
  // Zulip: the registered events queue, and the newest message handled — the backfill anchor
  // when the queue is lost. Null for Telegram and Slack.
  queueId: text("queue_id"),
  lastMessageId: bigint("last_message_id", { mode: "number" }),
  updatedAt: text("updated_at").notNull(),
});
