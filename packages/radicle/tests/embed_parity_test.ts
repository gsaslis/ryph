// The bridge restates the control plane's attachment cap for the embeds it serves, because it
// imports nothing of the orchestrator's. Held to the original here; tests sit outside the
// architecture guard, so the import across packages is a test's, never the bridge's.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { MAX_EMBED_BYTES } from "../src/core/service.ts";
import { MAX_ATTACHMENT_BYTES } from "../../orchestrator/src/core/attachments.ts";

test("the largest embed the bridge serves is the largest image the control plane takes", () => {
  assertEquals(MAX_EMBED_BYTES, MAX_ATTACHMENT_BYTES);
});
