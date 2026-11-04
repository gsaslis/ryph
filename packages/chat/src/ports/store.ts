// Persistence, as the core sees it — a row-holder, same doctrine as the other services' stores:
// every decision (who may bind, which conversation a mention matched) happens in the service and lands here
// fully formed.

import type { ChatBinding, Chatroom, PollCursor } from "../core/types.ts";

export interface ChatStore {
  /**
   * Adds a room, or answers false when it is a Discord room on a bot that already serves a live
   * (unarchived) one — in one statement, so two concurrent creations cannot both land. The
   * caller's refusal.
   */
  createChatroom(room: Chatroom): Promise<boolean>;
  getChatroom(id: string): Promise<Chatroom | null>;
  /** Newest first, archived included (a historical binding still resolves its room). */
  listChatrooms(): Promise<Chatroom[]>;
  /** Full-row write keyed by id — renames, the learned chat id, archiving. An existing row's
   * sealed secrets are left as they stand: they are written only when the room is created. */
  saveChatroom(room: Chatroom): Promise<void>;

  /**
   * Adds a binding, or answers false when the conversation (room, threadKey) already has an
   * ACTIVE one — in one statement, so two concurrent opens cannot both land. The caller's 409.
   */
  createBinding(binding: ChatBinding): Promise<boolean>;
  /** The newest binding for a run, active or closed. */
  getBindingByRun(runId: string): Promise<ChatBinding | null>;
  /** Every active binding of a room, oldest first — one per conversation. */
  listActiveBindings(chatroomId: string): Promise<ChatBinding[]>;
  /**
   * Closes a binding while it is still active, in one conditional statement, and answers whether
   * this call closed it. Two closes racing (the run's conclusion and a person closing its
   * response) both read it active; only the one that wins may say the closing line.
   */
  closeBinding(bindingId: string, closedAt: string): Promise<boolean>;

  getCursor(chatroomId: string): Promise<PollCursor | null>;
  /** Upsert keyed by chatroom. */
  saveCursor(cursor: PollCursor): Promise<void>;

  close(): Promise<void>;
}
