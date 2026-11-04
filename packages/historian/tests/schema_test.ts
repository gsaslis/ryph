import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { IngestBatchSchema } from "../src/schema.ts";

test("ingest permits long assistant prose while bounding other event text", () => {
  for (
    const [voice, kind, limit] of [
      ["transcript", "assistant", 128_000],
      ["transcript", "tool_result", 8_000],
      ["diag", "assistant", 8_000],
    ] as const
  ) {
    for (const length of [2_001, 8_001, limit, limit + 1]) {
      const result = IngestBatchSchema.safeParse({
        events: [{
          seq: 0,
          at: "2026-10-07T00:00:00.000Z",
          voice,
          kind,
          text: "x".repeat(length),
          payload: { truncated: true },
        }],
      });
      assertEquals(result.success, length <= limit, `${voice}/${kind}: ${length}`);
      if (result.success) assertEquals(result.data.events[0].text, "x".repeat(length));
    }
  }
});
