// The orchestrator's `ChatAccess` port over @ryph/chat's service in this process — the
// single-process twin of the orchestrator's `httpChatAccess`, and held to the same contract
// (ports/chat_access.ts): the binding calls throw on a refusal, `ConversationBusyError` for a
// conversation that already holds a run; the reads never throw.

import type { ChatService } from "@ryph/chat";
import { type ChatAccess, ConversationBusyError } from "@ryph/orchestrator";

export function inProcessChatAccess(
  service: Pick<
    ChatService,
    | "openBinding"
    | "closeBinding"
    | "checkCommander"
    | "fetchThread"
    | "fetchContinuedThread"
    | "describeRoom"
  >,
): ChatAccess {
  return {
    async openBinding(req) {
      const outcome = await service.openBinding(req);
      if (outcome.kind !== "refused") return;
      // Told apart by the refusal's `reason`, as the HTTP adapter tells it apart off the 409's
      // body: the run's page then says its conversation was busy — something a person can act
      // on — rather than that the chat service refused or did not answer.
      if (outcome.reason === "conversation_held") throw new ConversationBusyError();
      throw new Error(outcome.error);
    },
    closeBinding: ({ runId, ...closing }) => service.closeBinding(runId, closing),
    // The reads never throw by contract (ports/chat_access.ts); the service already answers
    // every platform failure as a value, and these catches hold the promise if a store read
    // fails.
    checkCommander: (req) => service.checkCommander(req).catch(() => "unknown" as const),
    fetchThread: (req) => service.fetchThread(req).catch(() => ({ kind: "unavailable" as const })),
    fetchContinuedThread: (req) =>
      service.fetchContinuedThread(req).catch(() => ({ kind: "unavailable" as const })),
    describeRoom: (chatroomId) => service.describeRoom(chatroomId).catch(() => null),
  };
}
