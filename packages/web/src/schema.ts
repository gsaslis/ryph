// The ingest boundary: every tool argument is parsed against a schema here before it reaches a
// core function, the same doctrine as @ryph/memory's. The schemas double as the JSON Schema the
// MCP `tools/list` answers — derived with `jsonSchemaOf` rather than restated, so the contract
// the model reads and the contract this service enforces cannot drift.

import { z } from "@zod/zod";

export const FRESHNESS = ["day", "week", "month", "year"] as const;

export const SearchArgsSchema = z.object({
  query: z.string().trim().min(1).max(400).describe(
    "What you are looking for, in plain words. A search engine query, not a sentence to a person",
  ),
  count: z.number().int().min(1).max(10).optional().describe(
    "How many results to return, 1 to 10 (default 5)",
  ),
  freshness: z.enum(FRESHNESS).optional().describe(
    "Only pages the index saw within the last day, week, month or year. Leave it out unless " +
      "recency actually matters — it throws away good older pages",
  ),
});

export const FetchArgsSchema = z.object({
  url: z.string().trim().min(1).max(2048).describe(
    "The http(s) address of the page to read, exactly as it appears — including its query string",
  ),
  offset: z.number().int().min(0).optional().describe(
    "Where to start reading, as a character offset into the page's markdown (default 0). The " +
      "end of a truncated result says which offset comes next",
  ),
});

export type SearchArgs = z.infer<typeof SearchArgsSchema>;
export type FetchArgs = z.infer<typeof FetchArgsSchema>;

/** The schema as the JSON Schema `tools/list` carries. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}
