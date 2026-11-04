// The in-process ChatAccess: the same contract as the HTTP adapter — a held conversation's
// refusal is a ConversationBusyError, told apart by the service's `reason` and never its words.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { OpenBindingOutcome } from "@ryph/chat";
import { ConversationBusyError } from "@ryph/orchestrator";
import { inProcessChatAccess } from "../src/chat_access.ts";

const OPENING = {
  runId: "r-1",
  chatroomId: "chr-1",
  conversation: { kind: "continue" as const, previousRunIds: ["r-0"], channelId: "4", topic: "t" },
  agentName: "Ada",
  taskTitle: "t",
  runUrl: null,
};

function accessAnswering(outcome: OpenBindingOutcome) {
  const unused = () => Promise.reject(new Error("not asked"));
  return inProcessChatAccess({
    openBinding: () => Promise.resolve(outcome),
    closeBinding: unused,
    checkCommander: unused,
    fetchThread: unused,
    fetchContinuedThread: unused,
    describeRoom: unused,
  });
}

async function thrownBy(outcome: OpenBindingOutcome): Promise<unknown> {
  try {
    await accessAnswering(outcome).openBinding(OPENING);
  } catch (err) {
    return err;
  }
  return null;
}

test("a held conversation's refusal is busy; any other refusal is a plain error", async () => {
  const held = await thrownBy({
    kind: "refused",
    status: 409,
    error: "that conversation already has a run bound",
    reason: "conversation_held",
  });
  assert(held instanceof ConversationBusyError, String(held));
  // The archived room's 409 — and the same words without the reason — are not busy.
  for (
    const error of ["the chatroom is archived", "that conversation already has a run bound"]
  ) {
    const other = await thrownBy({ kind: "refused", status: 409, error });
    assert(other instanceof Error && !(other instanceof ConversationBusyError), String(other));
    assertEquals((other as Error).message, error);
  }
});

test("the reads answer values when the service throws", async () => {
  const access = inProcessChatAccess({
    openBinding: () => Promise.reject(new Error("db down")),
    closeBinding: () => Promise.reject(new Error("db down")),
    checkCommander: () => Promise.reject(new Error("db down")),
    fetchThread: () => Promise.reject(new Error("db down")),
    fetchContinuedThread: () => Promise.reject(new Error("db down")),
    describeRoom: () => Promise.reject(new Error("db down")),
  });
  assertEquals(
    await access.checkCommander({ chatroomId: "c", userId: "u", groupId: "g" }),
    "unknown",
  );
  assertEquals((await access.fetchThread({ chatroomId: "c", threadKey: "k" })).kind, "unavailable");
  assertEquals(
    (await access.fetchContinuedThread({ chatroomId: "c", previousRunIds: [], channelId: "4" }))
      .kind,
    "unavailable",
  );
  assertEquals(await access.describeRoom("c"), null);
});
