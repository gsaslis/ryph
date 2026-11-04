// The drizzle `ChatStore` on Postgres — reads via the relational `db.query.*` API, the builder
// where a write has to be conditional. Same conventions as the other services' stores; the rows
// mirror the core types field-for-field, so nothing here maps.

import { and, eq } from "drizzle-orm";
import type { ChatBinding } from "../../core/types.ts";
import type { ChatStore } from "../../ports/store.ts";
import type { ChatDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

/**
 * A unique index refusing a row — `chat_bindings_one_active` a second active binding (the photo
 * finish between two opens on one conversation), `chatrooms_one_discord_bot` a second live room
 * on one Discord bot. The driver wraps its error in one of its own, so the SQLSTATE sits down the
 * cause chain; the control plane walks it the same way for its own duplicates.
 */
function isUniqueRefusal(err: unknown, index: string): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 4; hops++) {
    const it = e as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const names = `${String(it.constraint_name ?? "")} ${String(it.message ?? "")}`;
    if (it.code === "23505" && names.includes(index)) return true;
    e = it.cause;
  }
  return false;
}

export function drizzleChatStore(handle: ChatDbHandle): ChatStore {
  const { db } = handle;
  return {
    async createChatroom(room) {
      try {
        await db.insert(schema.chatrooms).values(room);
        return true;
      } catch (err) {
        if (isUniqueRefusal(err, "chatrooms_one_discord_bot")) return false;
        throw err;
      }
    },
    async getChatroom(id) {
      const row = await db.query.chatrooms.findFirst({ where: (r, { eq }) => eq(r.id, id) });
      return row ?? null;
    },
    async listChatrooms() {
      return await db.query.chatrooms.findMany({
        orderBy: (r, { asc, desc }) => [desc(r.createdAt), asc(r.id)],
      });
    },
    async saveChatroom(room) {
      // An existing row's sealed secrets are never rewritten here: a rename, an archive or a
      // learned chat id carries the secrets it read, and has no business writing them back.
      const { sealedBotToken: _bot, sealedAppToken: _app, ...edit } = room;
      await db.insert(schema.chatrooms).values(room)
        .onConflictDoUpdate({ target: schema.chatrooms.id, set: edit });
    },
    async createBinding(binding: ChatBinding) {
      // The partial unique index on (chatroom_id, thread_key) WHERE state = 'active' is the rule, and the
      // database is the only place it can be decided: a conditional insert's subquery reads the
      // same snapshot as its racer, so two concurrent opens both saw no active binding and both
      // landed. The loser raises 23505, and that is this caller's "no" — the 409 the service
      // already answers with.
      try {
        await db.insert(schema.chatBindings).values(binding);
        return true;
      } catch (err) {
        if (isUniqueRefusal(err, "chat_bindings_one_active")) return false;
        throw err;
      }
    },
    async getBindingByRun(runId) {
      const row = await db.query.chatBindings.findFirst({
        where: (b, { eq }) => eq(b.runId, runId),
        orderBy: (b, { desc }) => [desc(b.createdAt), desc(b.id)],
      });
      return row ?? null;
    },
    async listActiveBindings(chatroomId) {
      return await db.query.chatBindings.findMany({
        where: (b, { and, eq }) => and(eq(b.chatroomId, chatroomId), eq(b.state, "active")),
        orderBy: (b, { asc }) => [asc(b.createdAt), asc(b.id)],
      });
    },
    async closeBinding(bindingId, closedAt) {
      const closed = await db.update(schema.chatBindings)
        .set({ state: "closed", closedAt })
        .where(and(eq(schema.chatBindings.id, bindingId), eq(schema.chatBindings.state, "active")))
        .returning({ id: schema.chatBindings.id });
      return closed.length > 0;
    },
    async getCursor(chatroomId) {
      const row = await db.query.chatPollCursors.findFirst({
        where: (c, { eq }) => eq(c.chatroomId, chatroomId),
      });
      return row ?? null;
    },
    async saveCursor(cursor) {
      await db.insert(schema.chatPollCursors).values(cursor)
        .onConflictDoUpdate({
          target: schema.chatPollCursors.chatroomId,
          set: {
            offset: cursor.offset,
            queueId: cursor.queueId,
            lastMessageId: cursor.lastMessageId,
            updatedAt: cursor.updatedAt,
          },
        });
    },
    close: handle.close,
  };
}
