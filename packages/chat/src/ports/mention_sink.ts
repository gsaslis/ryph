// Where a mention goes: the control plane's mention door (`POST /v1/chat/mentions`), which runs
// the whole decision ladder and answers what the room should hear. Over HTTP standalone
// (adapters/mention_sink/http.ts), in-process under the single binary — the service cannot tell
// which.
//
// The sink never throws: every way the door can fail is a value, because each one has its own
// handling in the poller (a 4xx is dropped, a 5xx retried then apologised for).

import type { ChatMention, ChatMentionVerdict } from "../core/types.ts";

export type MentionDelivery =
  /** The door decided. */
  | { kind: "verdict"; verdict: ChatMentionVerdict }
  /** The door called the request malformed (4xx): logged and dropped, never retried. */
  | { kind: "malformed"; status: number; error: string }
  /** The door could not decide (5xx), or could not be asked at all: retried. */
  | { kind: "failed"; error: string };

export interface MentionSink {
  deliver(mention: ChatMention): Promise<MentionDelivery>;
}
