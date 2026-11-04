// What a model call's BODY may ask the provider to do. The route table (core/endpoints.ts) says
// which calls a run may make with the real key; this says what one of those calls may carry.
//
// A model call is not only tokens in and tokens out. Both providers run tools on their own side
// (web search and fetch, code execution, file search, image generation, hosted MCP servers and
// connectors), fetch images and documents from a URL the request names, and read files, vector
// stores and stored responses the organization keeps. Each of those reaches past what the proxy
// can see or count: the provider dials an address the run chose, from outside the run's network
// (an exfiltration channel and a way around its egress rules); a hosted tool is billed per call
// or per container hour, never in the tokens metered here; and a file id or a stored response
// is the organization's data, other runs' included.
//
// So a body is held to what the harness actually sends — client-side function tools and inline
// (base64) media — and anything else is refused with a 400 that names it. Refused, never
// stripped: a run whose tool or image silently vanished would only find out from the model's
// confusion.
//
// What pi 1.5.0 sends, which this must keep passing (pi-ai's anthropic-messages,
// openai-responses-shared and openai-completions): Anthropic tools with no `type` (client tools),
// `tool_addition` blocks carrying the same, images as `source: {type: "base64"}`; OpenAI
// Responses `function`/`custom` tools, top-level and in `additional_tools` and client
// `tool_search_output` items, images as `input_image` with a `data:` URL; Chat Completions
// `function` tools and `image_url` parts with a `data:` URL.
//
// Invariants:
// - the body is walked once, as bytes (core/model_field.ts `visitObjects`), never parsed whole:
//   the same reason the model is read that way
// - every rule is keyed on an object's own `type`, never on a bare member name, so a tool's
//   JSON Schema with a `file_id` or `url` property, or a tool call's arguments, is not judged
// - unknown is refused: a tool type, a media source type or a URL scheme this does not know
//   fails closed, and the provider's own refusal is never what is relied on

import type { BodyShape } from "./endpoints.ts";
import { NOT_A_STRING, type ObjectSeen, visitObjects } from "./model_field.ts";

/** How deep a body may nest. A conversation is a handful of levels and a tool's JSON Schema
 * rarely twenty. */
export const MAX_BODY_DEPTH = 256;

/** At most this many refusals are named in one answer. */
const MAX_NAMED = 10;

/** Tool types each shape's provider runs on the CALLER's side. Anthropic's client tools carry
 * no type at all (`ABSENT`), or `custom`; every typed one is a server tool. A Responses
 * `namespace` only groups tools, and its members are judged as tools themselves. */
const ABSENT = "";
const CLIENT_TOOL_TYPES: Record<BodyShape, ReadonlySet<string>> = {
  "anthropic-messages": new Set([ABSENT, "custom"]),
  "openai-responses": new Set(["function", "custom", "namespace"]),
  "openai-chat": new Set(["function", "custom"]),
};

/**
 * Top-level fields that pull in state the proxy cannot see, or reach past one metered call:
 * - `previous_response_id`, `conversation`: a stored response or conversation, by id. pi sends
 *   `store: false` and carries its history in `input`, so it never uses either, and an id from
 *   another run (or another person's session on the same key) would hand its whole context over
 * - `prompt`: a prompt template the organization stored on OpenAI's side, the same kind of data
 * - `mcp_servers` (Anthropic): servers the provider dials on the run's behalf
 * - `container` (Anthropic): a code-execution container, billed by the hour
 * - `web_search_options` (Chat Completions): the search models' built-in web search
 */
const REFUSED_TOP_LEVEL: Record<BodyShape, readonly string[]> = {
  "anthropic-messages": ["mcp_servers", "container"],
  "openai-responses": ["previous_response_id", "conversation", "prompt"],
  "openai-chat": ["web_search_options"],
};

/** Every top-level field any shape refuses, for the walk that finds them. */
export const REFUSED_TOP_LEVEL_FIELDS: readonly string[] = [
  ...new Set(Object.values(REFUSED_TOP_LEVEL).flat()),
];

/** Anthropic media sources that carry their content inline. `url` has the provider fetch it,
 * `file` reads the Files API. */
const INLINE_SOURCES = new Set(["base64", "text", "content"]);

/** Content and input items that only exist to reference what a provider stores: a stored
 * response item, a file uploaded to a code-execution container. */
const REFUSED_ITEM_TYPES = new Set(["item_reference", "container_upload"]);

const WATCH = {
  strings: new Set(["type", "image_url", "url", "file_id", "file_url"]),
  children: new Set(["source", "image_url", "file", "definition"]),
};

/** Whether a URL, as a prefix, is a `data:` URL: the only kind that carries its bytes along. A
 * URL parser drops leading spaces and control characters and reads the scheme in any case. */
function isDataUrl(prefix: string): boolean {
  let i = 0;
  while (i < prefix.length && prefix.charCodeAt(i) <= 0x20) i++;
  return prefix.slice(i, i + 5).toLowerCase() === "data:";
}

/**
 * What a model call's body asks for that the proxy does not forward, each named with where it
 * is; empty when nothing. `topLevel` is the set of top-level member names the body carries
 * with a non-null value.
 */
export function refusedInBody(
  bytes: Uint8Array,
  shape: BodyShape,
  topLevel: ReadonlySet<string>,
): string[] {
  const refused: string[] = [];
  for (const field of REFUSED_TOP_LEVEL[shape]) {
    if (topLevel.has(field)) refused.push(`${field} (stored or provider-side state)`);
  }
  const clientTools = CLIENT_TOOL_TYPES[shape];
  const refuse = (seen: ObjectSeen, what: string) => {
    if (refused.length < MAX_NAMED) refused.push(`${seen.path() || "the body"}: ${what}`);
  };
  const ok = visitObjects(bytes, WATCH, MAX_BODY_DEPTH, (seen) => {
    const type = seen.strings.get("type");
    // A tool definition, wherever a tool list stands: top-level `tools`, an `additional_tools`
    // or `tool_search_output` item's, a namespace's.
    if (seen.inArray && seen.key === "tools" && !clientTools.has(type ?? ABSENT)) {
      refuse(seen, `tool type ${JSON.stringify(type ?? null)} runs on the provider's side`);
    }
    if (type === undefined) return;
    if (REFUSED_ITEM_TYPES.has(type)) {
      refuse(seen, `${type} references data stored with the provider`);
      return;
    }
    switch (type) {
      // Anthropic's mid-conversation tool change: the definition is a tool like any other.
      case "tool_definition": {
        const defined = seen.children.get("definition")?.get("type") ?? ABSENT;
        if (!clientTools.has(defined)) {
          refuse(seen, `tool type ${JSON.stringify(defined)} runs on the provider's side`);
        }
        return;
      }
      // Anthropic media: inline only.
      case "image":
      case "document": {
        const source = seen.children.get("source");
        const kind = source?.get("type");
        if (source !== undefined && (kind === undefined || !INLINE_SOURCES.has(kind))) {
          refuse(seen, `a ${type} source of type ${JSON.stringify(kind ?? null)}: send it inline`);
        }
        return;
      }
      // Responses media.
      case "input_image":
      case "computer_screenshot": {
        const url = seen.strings.get("image_url");
        if (url !== undefined && (url === NOT_A_STRING || !isDataUrl(url))) {
          refuse(seen, "an image by URL: send it as a data: URL");
        }
        if (seen.strings.has("file_id")) refuse(seen, "an image by file_id: send it inline");
        return;
      }
      case "input_file": {
        if (seen.strings.has("file_url")) refuse(seen, "a file by URL: send it as file_data");
        if (seen.strings.has("file_id")) refuse(seen, "a file by file_id: send it as file_data");
        return;
      }
      // Chat Completions media.
      case "image_url": {
        const child = seen.children.get("image_url")?.get("url");
        const url = child ?? seen.strings.get("image_url");
        if (url !== undefined && (url === NOT_A_STRING || !isDataUrl(url))) {
          refuse(seen, "an image by URL: send it as a data: URL");
        }
        return;
      }
      case "file": {
        if (seen.children.get("file")?.has("file_id")) {
          refuse(seen, "a file by file_id: send it as file_data");
        }
        return;
      }
    }
  });
  if (!ok) refused.push(`the body nests more than ${MAX_BODY_DEPTH} levels deep`);
  return refused;
}
