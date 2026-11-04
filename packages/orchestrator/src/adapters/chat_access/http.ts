// `ChatAccess` over a standalone chat service's internal surface — the adapter that replaces
// `chatAccess: null` in the networked deployment. The port is the orchestrator's and does not
// change: the single-process host builds the same six methods over @ryph/chat's service
// in-process, and the core cannot tell which it got.
//
// The wire contract (implemented by @ryph/chat's internal surface):
//   POST /internal/v1/bindings           {runId, chatroomId, conversation, agentName, taskTitle, runUrl}
//                                        conversation: {kind:"thread", threadKey}
//                                                    | {kind:"new", channelId, topic}   (Zulip only)
//                                        → 2xx; 409 {error, reason:"conversation_held"} when that
//                                          conversation is already bound (other 409s carry no reason)
//   POST /internal/v1/runs/:id/close     {outcome, summary, patches, issues, runUrl} → 2xx
//   POST /internal/v1/commanders/check   {chatroomId, userId, groupId} → 200 {verdict}
//   POST /internal/v1/threads/fetch      {chatroomId, threadKey}
//                                        → 200 {kind:"thread", thread} | {kind:"gone"} | {kind:"unavailable"}
//   POST /internal/v1/threads/continued  {chatroomId, previousRunIds, channelId}
//                                        → 200 {kind:"thread", thread, botId} | {kind:"none"} | {kind:"unavailable"}
//   GET  /internal/v1/chatrooms/:id/context
//                                        → 200 {kind, roomTitle, botHandle, quiet?}; 404 when the room is
//                                          missing or archived
//
// Service-authed with the shared RYPH_CHAT_TOKEN — the same credential the chat service
// presents on the way back, when it delivers a mention to the door: one link, one token, both
// directions. The binding calls are best-effort at their call sites, so both throw on anything
// but a clean answer and let the caller warn and go on. The four reads never throw: anything
// but a well-formed answer is "unknown" / "unavailable" / null — the door refuses out loud on
// the first two and never reads them as a yes; a run whose room reads null starts without it.

import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  type ChatAccess,
  type ChatContinuedThreadOutcome,
  type ChatThreadOutcome,
  type CommanderVerdict,
  ConversationBusyError,
} from "../../ports/chat_access.ts";
import type { ChatContext } from "../../core/types.ts";
import {
  ChatContextSchema,
  ChatContinuedThreadOutcomeSchema,
  ChatThreadOutcomeSchema,
} from "../../schema.ts";

export interface HttpChatAccessOptions {
  /** The chat service, as this process dials it; a trailing slash is tolerated. */
  chatUrl: string;
  /** The shared service credential this process presents. */
  chatToken: string;
  diag: Diagnostics;
  /** Per-request deadline. Default 10s. */
  requestTimeoutMs?: number;
  /** The thread read's own deadline — a whole topic, possibly paged. Default 20s. */
  threadTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_THREAD_TIMEOUT_MS = 20_000;

export function httpChatAccess(opts: HttpChatAccessOptions): ChatAccess {
  const { diag } = opts;
  const base = opts.chatUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${opts.chatToken}`,
    "content-type": "application/json",
  };

  const send = (path: string, body: unknown, deadlineMs: number): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });

  const call = async (path: string, body: unknown, what: string): Promise<void> => {
    let res: Response;
    try {
      res = await send(path, body, timeoutMs);
    } catch (err) {
      throw new Error(`chat service unreachable: ${err instanceof Error ? err.message : err}`);
    }
    // A refusal's body is read for its words; an answer's is only drained. (Cancelling a body
    // `text()` has read throws, which used to turn every refusal with words into a TypeError.)
    const detail = res.ok ? "" : await res.text().then((t) => t.slice(0, 300)).catch(() => "");
    if (res.ok) await res.body?.cancel();
    if (!res.ok) {
      diag.warn(`chat_access.${what}_failed`, { status: res.status, detail });
      // The chat service's 409 for a held conversation, told apart from its 409 for an archived
      // room by the `reason` it carries — a field, not the refusal's words.
      if (res.status === 409 && refusalReason(detail) === "conversation_held") {
        throw new ConversationBusyError();
      }
      throw new Error(`chat service refused to ${what} (HTTP ${res.status})`);
    }
  };

  return {
    openBinding: (req) => call("/internal/v1/bindings", req, "open_binding"),
    closeBinding: ({ runId, ...req }) =>
      call(`/internal/v1/runs/${encodeURIComponent(runId)}/close`, req, "close_binding"),

    async checkCommander(req): Promise<CommanderVerdict> {
      try {
        const res = await send("/internal/v1/commanders/check", req, timeoutMs);
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && (body.verdict === "allowed" || body.verdict === "denied")) {
          return body.verdict;
        }
        diag.warn("chat_access.commander_unanswerable", { status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("chat_access.commander_unreachable", { err: String(err) });
        return "unknown";
      }
    },

    async fetchThread(req): Promise<ChatThreadOutcome> {
      try {
        const res = await send(
          "/internal/v1/threads/fetch",
          req,
          opts.threadTimeoutMs ?? DEFAULT_THREAD_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        // Checked, not duck-typed: this answer is headed for an agent's prompt, and a half-shaped
        // one would throw in the composer after the mention was claimed.
        const parsed = res.ok ? ChatThreadOutcomeSchema.safeParse(body) : null;
        if (parsed?.success) return parsed.data;
        diag.warn("chat_access.thread_unanswerable", {
          status: res.status,
          why: parsed?.error.issues.map((i) => i.path.join(".")).join(", ") ?? null,
        });
        return { kind: "unavailable" };
      } catch (err) {
        diag.warn("chat_access.thread_unreachable", { err: String(err) });
        return { kind: "unavailable" };
      }
    },

    async fetchContinuedThread(req): Promise<ChatContinuedThreadOutcome> {
      try {
        const res = await send(
          "/internal/v1/threads/continued",
          req,
          opts.threadTimeoutMs ?? DEFAULT_THREAD_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        // Checked like the thread above, for the same prompt.
        const parsed = res.ok ? ChatContinuedThreadOutcomeSchema.safeParse(body) : null;
        if (parsed?.success) return parsed.data;
        diag.warn("chat_access.continued_thread_unanswerable", {
          status: res.status,
          why: parsed?.error.issues.map((i) => i.path.join(".")).join(", ") ?? null,
        });
        return { kind: "unavailable" };
      } catch (err) {
        diag.warn("chat_access.continued_thread_unreachable", { err: String(err) });
        return { kind: "unavailable" };
      }
    },

    async describeRoom(chatroomId): Promise<ChatContext | null> {
      try {
        const res = await fetch(
          `${base}/internal/v1/chatrooms/${encodeURIComponent(chatroomId)}/context`,
          { headers, signal: AbortSignal.timeout(timeoutMs) },
        );
        const body = (await res.json().catch(() => null)) ?? {};
        // Checked like the thread: these strings are headed for the agent's prompt.
        const parsed = res.ok ? ChatContextSchema.safeParse(body) : null;
        if (parsed?.success) return parsed.data;
        // A 404 is the room being gone, which a run starting in it can meet in a race with
        // an archive; anything else is the service misbehaving.
        if (res.status !== 404) {
          diag.warn("chat_access.room_unanswerable", {
            status: res.status,
            why: parsed?.error.issues.map((i) => i.path.join(".")).join(", ") ?? null,
          });
        }
        return null;
      } catch (err) {
        diag.warn("chat_access.room_unreachable", { err: String(err) });
        return null;
      }
    },
  };
}

/** A refusal body's machine-readable `reason`, if it is JSON and has one. */
function refusalReason(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
      return typeof parsed.reason === "string" ? parsed.reason : null;
    }
  } catch {
    // not JSON: no reason
  }
  return null;
}
