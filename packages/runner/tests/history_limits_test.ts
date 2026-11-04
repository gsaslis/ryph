// Cross-boundary contract test: no production dependency between runner and historian.
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_BATCH_BYTES,
  MAX_TEXT_CHARS,
} from "../src/adapters/history/emitter.ts";
import { SUBAGENT_MAX_STARTED } from "../src/ports/run_actions.ts";
import { MAX_ASSISTANT_TEXT, MAX_INGEST_BYTES, MAX_TEXT } from "../../historian/src/schema.ts";
import { MAX_SUBAGENT_LANES } from "../../historian/src/core/types.ts";

test("history emitter and ingest limits cannot drift", () => {
  assertEquals(MAX_ASSISTANT_TEXT_CHARS, MAX_ASSISTANT_TEXT);
  assertEquals(MAX_TEXT_CHARS, MAX_TEXT);
  assertEquals(MAX_BATCH_BYTES, MAX_INGEST_BYTES);
});

test("every subagent the runner can start has a lane the historian takes", () => {
  // A subagent's lane is `sa-<n>` for its n, and the historian refuses lanes past its ceiling.
  assert(
    SUBAGENT_MAX_STARTED <= MAX_SUBAGENT_LANES,
    `${SUBAGENT_MAX_STARTED} subagents, ${MAX_SUBAGENT_LANES} lanes`,
  );
});
