import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MAX_JSON_BODY_BYTES, parseBody } from "@ryph/shared/http";
import { CreateAutomationSchema, UpdateAutomationSchema } from "../src/schema.ts";
import { api, makeService, webhookCreateBody } from "./harness.ts";

// 100,000-character instructions JSON-escaped at six bytes a character, plus management metadata,
// fit the default JSON cap. Webhook payloads have their own separate budget.
test("automation parser accepts maximum instructions with worst-case JSON escaping", async () => {
  const instructions = `x${"\u0000".repeat(99_999)}`;
  // Exercise the ingest parser, not PostgreSQL's separate prohibition on NUL in text columns.
  for (const schema of [CreateAutomationSchema, UpdateAutomationSchema]) {
    const body = schema === CreateAutomationSchema
      ? webhookCreateBody({ instructions })
      : { instructions };
    const encoded = JSON.stringify(body);
    assert(new TextEncoder().encode(encoded).byteLength > 256 * 1024);
    const parsed = await parseBody<{ instructions?: string }>(
      new Request("http://automations.test/v1/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
      }),
      schema,
    );
    assert(parsed.ok);
    assertEquals(parsed.data.instructions, instructions);
  }
});

test("automation JSON cap refuses one byte over before creating hooks or looking up rooms", async () => {
  const svc = await makeService();
  try {
    const json = JSON.stringify(webhookCreateBody());
    for (
      const [size, expected] of [[MAX_JSON_BODY_BYTES + 1, 413], [MAX_JSON_BODY_BYTES, 201]]
    ) {
      const bytes = new TextEncoder().encode(json.padEnd(size));
      const req = new Request("http://automations.test/v1/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      });
      assertEquals(req.headers.has("content-length"), false);
      const res = await svc.handler(req);
      assertEquals(res.status, expected);
      if (expected === 413) {
        assertStringIncludes((await res.json()).error, String(MAX_JSON_BODY_BYTES));
        assertEquals((await (await api(svc, "GET", "/v1/automations")).json()).automations, []);
        assertEquals(svc.lookups, []);
        assertEquals(svc.probes, []);
      }
    }
  } finally {
    await svc.db.close();
  }
});
