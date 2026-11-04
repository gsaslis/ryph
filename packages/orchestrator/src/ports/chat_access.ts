// The chat service, as the orchestrator touches it: the questions the mention door asks, and the
// two moments a run's conversation is bound and closed.
//
// `openBinding` when a run starts with a conversation — a response's room, or the thread a
// command-room mention came from — and the chat service posts its own opening line INTO THAT
// CONVERSATION at once (a container takes tens of seconds to boot, and the room should hear
// within one that something is happening). `closeBinding` when the run concludes — the chat
// service posts the closing line: the outcome, the patches, the issues the run opened, the run
// link. Both best-effort at their call sites: a room that could not be bound is a run without a
// room, never a failed one.
//
// `fetchContinuedThread` is the automations door's read of the same kind: the conversation a
// shared response is about to continue, for the run's task — a value, never a throw, and a run
// that could not have it starts without it.
//
// `checkCommander` and `fetchThread` are the mention door's two reads — the chat analogue of the
// forge's `checkPermission` and `fetchThread`: the chat service asks the platform, the control
// plane decides. Both answer VALUES and never throw, for the forge port's reason: "the platform
// said no" and "the platform did not answer" are different facts, and only the caller knows what
// each one means for the mention in front of it.
//
// `describeRoom` is the task start's read: the room's facts (its platform, its title, what
// people type to reach the bot), frozen onto a bound run's work item so the agent knows which
// room "the chat" is and how it is addressed there. A value or null, never a throw, like the
// two reads above: a run whose room could not be described starts without the facts — the
// agent is told less, and nothing else changes.
//
// Everything else between the two services runs the OTHER way and does not cross this port:
// the chat service delivers every mention to the door (http/chat_api.ts), and the agent's own
// posts reach the room through the gateway's platform server, which dials the chat service
// directly. The bot's credential never enters this process.
//
// A PORT rather than an HTTP-layer interface, because the door and the conclusion — core —
// call it. Two adapters stand behind it: the single-process host builds one over @ryph/chat's
// service in-process, adapters/chat_access/http.ts dials a standalone chat service's internal
// surface with the shared RYPH_CHAT_TOKEN.

import type { ChatChannelVisibility, ChatContext } from "../core/types.ts";

/**
 * A conversation as the chat service read it, for the agent — every string in it typed by
 * someone in the channel, which on an open server is anyone. Rendered only by
 * core/thread_context.ts, which quotes it as evidence and never as an instruction.
 */
export interface ChatThread {
  channel: { id: string; name: string; visibility: ChatChannelVisibility };
  topic: string | null;
  /** Oldest first, platform notices already removed; text as its author typed it. */
  messages: Array<{
    id: string;
    sender: { id: string; name: string };
    text: string;
    sentAt: string;
    hasAttachment: boolean;
  }>;
  /** Older messages were dropped to fit the chat service's size bound. */
  truncated: boolean;
  /** The platform hides history from before the bot joined — the start may be missing. */
  historyLimited: boolean;
}

export type ChatThreadOutcome =
  | { kind: "thread"; thread: ChatThread }
  /** The key message no longer exists or cannot be read — nothing a retry brings back. */
  | { kind: "gone" }
  /** The platform did not answer. Worth asking again. */
  | { kind: "unavailable" };

/**
 * The conversation a shared response is about to continue, read for the run that will — its
 * earlier responses' posts and people's answers. `botId` is the room's bot as the platform names
 * it: the messages it sent are the platform's own posts and earlier runs' (`sender.id`), which a
 * display name could only claim.
 */
export type ChatContinuedThreadOutcome =
  | { kind: "thread"; thread: ChatThread; botId: string }
  /** Nothing to continue: the binding opens a new conversation. */
  | { kind: "none" }
  /** The platform or the chat service did not answer. */
  | { kind: "unavailable" };

/** Three-valued on purpose — "unknown" is an outage, never a no and never a yes. */
export type CommanderVerdict = "allowed" | "denied" | "unknown";

/**
 * Which conversation of a room a binding covers. "thread" is one that exists: the platform's
 * thread key — "" on Telegram, whose room is one conversation; on Zulip the id of the message
 * that started it; on Slack `<channel>:<thread root>`; on Discord `<channel>:<thread>`. "new" is
 * for a platform with channels: the chat service posts the opening line into the named channel —
 * a Zulip topic of the name given, a Slack thread under the post itself, a Discord thread of the
 * name given started from the post — and binds the run to that post, so the opening line IS the
 * key message. That is how a response, which no mention started, gets a conversation of its own.
 * "continue" is how responses that SHARE one get it: the chat service binds the run to the
 * conversation the newest of `previousRunIds` (newest first) that was bound in the room was
 * bound to, on the same key message, when that one is still there in `channelId` — and opens a
 * "new" one with `channelId` and `topic` when it is not. It refuses (409) while that previous
 * run is still bound there, so the caller releases the binding of one already over first.
 */
export type BindingConversation =
  | { kind: "thread"; threadKey: string }
  | { kind: "new"; channelId: string; topic: string }
  | { kind: "continue"; previousRunIds: string[]; channelId: string; topic: string };

/**
 * What `openBinding` throws when the chat service refused because the conversation already
 * holds a run (its 409): one active binding per conversation is the rule. Its own class so a
 * caller can tell a busy conversation, which a person can do something about, from a chat
 * service that did not answer.
 */
export class ConversationBusyError extends Error {
  constructor() {
    super("the conversation already holds a run");
    this.name = "ConversationBusyError";
  }
}

export interface ChatAccess {
  /** Binds the conversation to the run; the chat service posts the opening line into it.
   * Throws when it refuses: `ConversationBusyError` when that conversation already has an
   * active binding. */
  openBinding(req: {
    runId: string;
    chatroomId: string;
    conversation: BindingConversation;
    agentName: string;
    taskTitle: string;
    /** The run page as a browser reaches it; null omits the link. */
    runUrl: string | null;
    /** The fire that opened a response, for the opening line to show — its title as the format
     * read it, and the payload verbatim (untrusted). Absent: the line says nothing of it. */
    alert?: { title: string | null; payload: string };
  }): Promise<void>;
  /** Closes the run's binding, if any; the chat service posts the closing line. Idempotent. */
  closeBinding(req: {
    runId: string;
    /** The run's terminal state, in words the room can read. */
    outcome: string;
    /** The agent's own account of the run — the result's summary, or "". */
    summary: string;
    patches: Array<{ path: string; state: string; forgeUrl: string | null }>;
    /**
     * The issues the run opened on the forge, read from its action ledger. `number` is the
     * thread as its forge names it: a number on GitHub, a short object id on Radicle (whose
     * issues have no number at all). `url` is null where the forge has no web address for it.
     */
    issues: Array<{ repo: string; number: number | string; url: string | null }>;
    runUrl: string | null;
    /** Release without a closing line: the binding is stale, its run over a while ago and the
     * line long overdue (core/conclude_run.ts `releaseRunBinding`). */
    silent?: boolean;
  }): Promise<void>;
  /** Is this platform user a member of this platform group, asked live. Never throws. */
  checkCommander(req: {
    chatroomId: string;
    userId: string;
    groupId: string;
  }): Promise<CommanderVerdict>;
  /** The conversation behind a thread key, as evidence for the agent. Never throws. */
  fetchThread(req: { chatroomId: string; threadKey: string }): Promise<ChatThreadOutcome>;
  /** The conversation a `continue` binding with these `previousRunIds` (newest first) and
   * `channelId` would bind to — by the chat service's own rule, so a run is not shown another
   * one (read before the bind, which may still be refused) — as evidence for the run about to
   * start there. Never throws. */
  fetchContinuedThread(req: {
    chatroomId: string;
    previousRunIds: string[];
    channelId: string;
  }): Promise<ChatContinuedThreadOutcome>;
  /** The room as a bound run's agent is told about it. Null: the room is missing or archived,
   * or the chat service did not answer. Never throws. */
  describeRoom(chatroomId: string): Promise<ChatContext | null>;
}
