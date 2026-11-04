import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { parseBody } from "@ryph/shared/http";
import {
  MAX_RUNNER_SETUP_FAILURE_BYTES,
  MAX_RUNNER_STALE_MEMORY_BYTES,
} from "../src/http/runner_api.ts";
import {
  CreateAgentSchema,
  MAX_PATCH_DECISION_BODY_BYTES,
  MAX_PROMPT_BODY_BYTES,
  PatchDecisionSchema,
  SetupFailuresSchema,
  StaleMemoriesSchema,
  UpdateAgentSchema,
} from "../src/schema.ts";

/** Deliberately not a string body: exercise streamed bytes, not a trusted length header. */
function request(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  return new Request("http://app.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    }),
  });
}

test("report caps fit what a runner sends, not every list the schema could hold", async () => {
  // The runner's own bounds (packages/runner's STALE_MEMORY_LIMITS): 50 paths a memory, and
  // ordinary repository paths. 200 memories of them fit; schema-length paths at full count do not,
  // and are refused before they are parsed.
  const stale = (path: string) =>
    JSON.stringify({
      stale: Array.from({ length: 200 }, (_, i) => ({
        memoryId: `memory-${i}`,
        changedPaths: Array.from({ length: 50 }, (_, j) => `${path}/${j}.ts`),
        headSha: "0123456789abcdef0123456789abcdef01234567",
      })),
    });
  const ordinary = stale("packages/orchestrator/src/http/runner");
  assert(new TextEncoder().encode(ordinary).length < MAX_RUNNER_STALE_MEMORY_BYTES);
  assert(
    (await parseBody(request(ordinary), StaleMemoriesSchema, {
      maxBytes: MAX_RUNNER_STALE_MEMORY_BYTES,
    })).ok,
  );
  const hostile = await parseBody(request(stale("\u0000".repeat(1000))), StaleMemoriesSchema, {
    maxBytes: MAX_RUNNER_STALE_MEMORY_BYTES,
  });
  assertEquals(hostile.ok ? 200 : hostile.res.status, 413);

  // Setup warnings at the runner's bounds (SETUP_FAILURE_LIMITS), every character escaped six
  // bytes wide, and the widest shape — 64 file names of 200 three-byte characters per entry.
  const failures = {
    failures: Array.from({ length: 64 }, () => ({
      kind: "step",
      path: "repo",
      step: "\u0000".repeat(200),
      index: 1,
      total: 1,
      code: 1,
      output: "\u0000".repeat(4_096),
      discarded: false,
    })),
  };
  const dirty = {
    failures: Array.from({ length: 64 }, (_, i) => ({
      kind: "dirty",
      path: `repo-${i}`,
      files: Array(64).fill("界".repeat(200)),
    })),
  };
  for (const report of [failures, dirty]) {
    assert(
      (await parseBody(request(JSON.stringify(report)), SetupFailuresSchema, {
        maxBytes: MAX_RUNNER_SETUP_FAILURE_BYTES,
      })).ok,
    );
  }
});

test("agent caps admit full tool allowlists alongside an escaped system prompt", async () => {
  const body = {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
    systemPrompt: "\u0000".repeat(100_000),
    toolPolicy: {
      servers: Array.from({ length: 32 }, (_, i) => ({
        serverId: `server-${i}`,
        allowedTools: Array.from({ length: 200 }, (_, j) => `tool${j}`.padEnd(128, "x")),
      })),
    },
  };
  const text = JSON.stringify(body);
  assert(text.length > 1024 * 1024);
  assert(
    (await parseBody(request(text), CreateAgentSchema, { maxBytes: MAX_PROMPT_BODY_BYTES })).ok,
  );
  assert(
    (await parseBody(request(text), UpdateAgentSchema, { maxBytes: MAX_PROMPT_BODY_BYTES })).ok,
  );
});

test("patch decisions admit maximum hook paths with three-byte UTF-8 names", async () => {
  const text = JSON.stringify({ hookPaths: Array(1000).fill("界".repeat(4096)) });
  assert(new TextEncoder().encode(text).length > 12 * 1024 * 1024 - 1024 * 1024);
  const body = await parseBody(request(text), PatchDecisionSchema.nullable(), {
    maxBytes: MAX_PATCH_DECISION_BODY_BYTES,
    emptyIs: null,
  });
  assert(body.ok);
  assertEquals(body.data?.hookPaths?.length, 1000);
});
