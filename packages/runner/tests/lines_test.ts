// A cue naming no valid line (the rule is @ryph/shared/lines) is dropped at the schema.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { parseInboundMessages } from "../src/schema.ts";

test("lines: a cue naming no valid line is dropped at the schema, its text still delivered", () => {
  const message = (line: unknown) => ({
    seq: 1,
    kind: "system",
    sender: { kind: "platform" },
    text: "merged",
    attachments: [],
    createdAt: "2026-10-13T00:00:00Z",
    payload: {
      kind: "patch",
      patchId: "p-1",
      path: "repo",
      ...(line === undefined ? {} : { line }),
      headSha: "abc1234",
      generation: 1,
      state: "submitted",
      forgeUrl: null,
      reason: null,
    },
  });
  const parsed = parseInboundMessages({
    messages: [message("fix-login"), message("Fix"), message(undefined)],
  });
  if (!parsed.ok) throw new Error(parsed.issues);
  assertEquals(parsed.messages.map((m) => m.payload?.kind === "patch" && m.payload.line), [
    "fix-login",
    false,
    false,
  ]);
});
