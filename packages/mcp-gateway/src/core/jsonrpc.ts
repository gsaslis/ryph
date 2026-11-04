// The minimum of JSON-RPC and MCP framing the data plane has to understand — and no more. A
// reverse proxy that reads `method` and `params.name` off a request, and rewrites exactly one
// kind of response (`tools/list`). Pure functions over strings and plain objects.
//
// Invariants:
// - a BATCH is refused, never forwarded: the 2025-06-18 MCP spec removed JSON-RPC batching, and
//   a batch through an allowlisting proxy would be a bypass (one denied call hidden among allowed
//   ones). Refusing at the door costs nothing a compliant client wants.
// - what goes UPSTREAM is the message as judged, re-serialised — never the client's bytes. JSON
//   parsers disagree: Go's encoding/json matches keys case-insensitively and keeps the last
//   duplicate, so `"Method":"resources/read"` was no method here and a method there, and
//   `params:{"name":"allowed","Name":"denied"}` passed the allowlist and ran the denied tool. So
//   the door also refuses what could be read two ways: a key repeated in any object, a top-level
//   member JSON-RPC does not define, a `params` member that folds to `name`/`arguments` without
//   being spelled so, invalid UTF-8, and a method-less message that is not a well-formed response.
// - a denied `tools/call` is INDISTINGUISHABLE from calling a tool that does not exist: the same
//   -32601 "method not found" the upstream would produce for an unknown name
// - a filtered `tools/list` carries NO event id: the ids are upstream's resumption handles, and
//   a client holding one could ask for the events after it to be replayed — unfiltered. The GET
//   stream refuses to carry `last-event-id` for the same reason (see http/proxy.ts).
// - `tools/list` is filtered in BOTH framings upstreams use — a JSON body, or an SSE stream with
//   the result in an event's data — because the SDK server picks per deployment, and the client
//   accepts either. SSE is read by the spec's rules, the same ones the client applies, and what
//   cannot be read is dropped rather than passed.

import { isToolAllowed } from "./enforce.ts";
import type { AllowedTools } from "./types.ts";

/** What the data plane reads off an inbound request body. */
export interface ClientMessage {
  /** Absent on a response (the client answering a server→client request). */
  method: string | null;
  /** Absent on a notification. */
  id: string | number | null;
  /** `params.name` when the method is `tools/call`; null otherwise. */
  toolName: string | null;
}

/** Why a body was refused before any policy looked at it. */
export type ClientMessageRefusal =
  | "invalid_utf8"
  | "invalid_json"
  | "batch"
  | "not_an_object"
  | "duplicate_key"
  | "unexpected_member"
  | "invalid_message";

export type ParsedClientMessage =
  | {
    ok: true;
    message: ClientMessage;
    /** The message re-serialised from what was judged: the ONLY bytes that may go upstream. */
    canonical: string;
  }
  | { ok: false; reason: ClientMessageRefusal };

/** Every member a JSON-RPC message may have at its top level, spelled exactly. */
const MESSAGE_MEMBERS = new Set(["jsonrpc", "id", "method", "params", "result", "error"]);
/** The `params` members a decision reads, or that a lenient upstream could take for one. */
const PARAMS_MEMBERS = ["name", "arguments"] as const;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A request body as bytes: refused unless it is valid UTF-8, then read as `parseClientMessage`
 * reads it. A lenient decoder turns bad bytes into U+FFFD where another may decode an overlong
 * sequence as a letter; a body no conforming client sends is not one to guess about (the model
 * proxy's `modelNamedIn` draws the same line). A `\ud800` ESCAPE is JSON and passes — the
 * canonical body carries it as the same escape.
 */
export function parseClientBody(bytes: Uint8Array): ParsedClientMessage {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
  return parseClientMessage(text);
}

/**
 * Reads, validates and canonicalises one client message. `canonical` is the message the policy
 * judged, written out again — the upstream parses exactly what was enforced, never the client's
 * bytes (see the parser-differential invariant above).
 */
export function parseClientMessage(body: string): ParsedClientMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (Array.isArray(raw)) return { ok: false, reason: "batch" };
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "not_an_object" };
  if (hasDuplicateKey(body)) return { ok: false, reason: "duplicate_key" };
  const msg = raw as Record<string, unknown>;

  for (const key of Object.keys(msg)) {
    if (!MESSAGE_MEMBERS.has(key)) return { ok: false, reason: "unexpected_member" };
  }
  // One level down, only the members a decision reads: everything else in `params` — and all of
  // `arguments`, which is the tool's data — may be spelled however the tool likes.
  if (isPlainObject(msg.params)) {
    for (const key of Object.keys(msg.params)) {
      if (PARAMS_MEMBERS.some((member) => key !== member && couldMean(key, member))) {
        return { ok: false, reason: "unexpected_member" };
      }
    }
  }

  const message = validMessage(msg);
  if (message === null) return { ok: false, reason: "invalid_message" };
  return { ok: true, message, canonical: JSON.stringify(JSON.parse(body, keepNumberSource)) };
}

/**
 * The message's shape, or null when it is not one a client sends. A REQUEST or notification has
 * a string `method`, no `result`/`error`, and an object `params` if any. A RESPONSE — no `method`
 * member at all — has an `id` and exactly one of `result` and `error`, an object either way, and
 * no `params`. Anything else is refused rather than guessed at: a method-less message used to
 * pass as a response whatever else it carried.
 */
function validMessage(msg: Record<string, unknown>): ClientMessage | null {
  if (msg.jsonrpc !== "2.0") return null;
  const hasId = "id" in msg;
  const id = msg.id;
  if (hasId && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    return null;
  }
  const rpcId = hasId ? id as string | number : null;

  if ("method" in msg) {
    if (typeof msg.method !== "string") return null;
    if ("result" in msg || "error" in msg) return null;
    if ("params" in msg && !isPlainObject(msg.params)) return null;
    let toolName: string | null = null;
    if (msg.method === "tools/call" && isPlainObject(msg.params)) {
      const name = msg.params.name;
      if (typeof name === "string") toolName = name;
    }
    return { method: msg.method, id: rpcId, toolName };
  }

  if (!hasId || "params" in msg) return null;
  const hasResult = "result" in msg;
  if (hasResult === "error" in msg) return null;
  if (!isPlainObject(hasResult ? msg.result : msg.error)) return null;
  return { method: null, id: rpcId, toolName: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a lenient decoder could read `key` as `member` (lowercase ASCII). Go's encoding/json
 * matches names case-insensitively under Unicode simple folding (`ſ` is `s`, `K` is `k`), and
 * other decoders normalise further, so this over-approximates every one-to-one folding: the same
 * length in code points, each position the member's letter in either case or any non-ASCII
 * character at all. A false positive costs a key no MCP `params` uses; a miss is a bypass.
 */
export function couldMean(key: string, member: string): boolean {
  const chars = [...key];
  if (chars.length !== member.length) return false;
  return chars.every((ch, i) => ch.codePointAt(0)! > 0x7f || ch.toLowerCase() === member[i]);
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Whether any object, at any depth, of a VALID JSON text repeats a key — compared decoded, so
 * `"name"` and `"name"` are the same key. `JSON.parse` keeps the last of two, other parsers
 * keep the first or refuse, so such a document means different things to different readers, and
 * no serialiser a client uses produces one. One pass and no recursion: a stack of the open
 * containers, each object's keys in a set — linear in the body, which is already capped.
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      let end = i + 1;
      let escaped = false;
      for (; end < text.length; end++) {
        const d = text.charCodeAt(end);
        if (d === QUOTE) break;
        if (d === BACKSLASH) {
          escaped = true;
          end++;
        }
      }
      const keys = stack[stack.length - 1];
      if (expectKey && keys) {
        const token = text.slice(i, end + 1);
        const key = escaped ? JSON.parse(token) as string : token.slice(1, -1);
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (c === 0x7b) { // {
      stack.push(new Set());
      expectKey = true;
    } else if (c === 0x5b) { // [
      stack.push(null);
      expectKey = false;
    } else if (c === 0x7d || c === 0x5d) { // } ]
      stack.pop();
      expectKey = false;
    } else if (c === 0x2c) { // ,
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return false;
}

// Standard (ES2025, JSON.parse source text access), in V8 and JavaScriptCore, but not yet in
// TypeScript's lib types.
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/**
 * A `JSON.parse` reviver that keeps every number exactly as it was written. Re-serialising a
 * parsed number is lossy — `9007199254740993` comes back `…992`, `1e400` comes back `null` — and
 * the canonical body must change nothing about what the message says, tool arguments included.
 */
function keepNumberSource(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === "number" && context?.source !== undefined
    ? rawJSON(context.source)
    : value;
}

/** What the client is told when its body is refused, by reason. */
export function refusalMessage(reason: ClientMessageRefusal): string {
  switch (reason) {
    case "invalid_utf8":
      return "body is not valid UTF-8";
    case "invalid_json":
      return "body is not JSON";
    case "batch":
      return "JSON-RPC batches are not accepted";
    case "not_an_object":
      return "body is not a JSON-RPC message";
    case "duplicate_key":
      return "a JSON object in the message repeats a key";
    case "unexpected_member":
      return "the message has a member JSON-RPC and MCP do not define here";
    case "invalid_message":
      return "body is not a valid JSON-RPC request, notification or response";
  }
}

/** A server-defined error: what an upstream that refused OUR credential turns into. */
export const UPSTREAM_REJECTED = -32000;

export function rpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Removes every tool outside the allowlist from a `tools/list` result, in place. Anything that
 * is not a tools/list result (an error, a notification, some other response) passes untouched.
 */
export function filterToolsListPayload(payload: unknown, allowed: AllowedTools): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const result = (payload as { result?: unknown }).result;
  if (result === null || typeof result !== "object") return payload;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return payload;
  (result as { tools: unknown[] }).tools = tools.filter((tool) =>
    tool !== null && typeof tool === "object" &&
    typeof (tool as { name?: unknown }).name === "string" &&
    isToolAllowed(allowed, (tool as { name: string }).name)
  );
  return payload;
}

/** One event of an SSE body, read the way the spec (and so every client) reads it. */
interface SseEvent {
  /** The event's lines that are not `data` fields — event, id, retry, comments — in order. */
  other: string[];
  /** Where among `other` the first data line stood. */
  dataAt: number;
  /** Every `data` field's value joined with "\n", as a client dispatches it; null when none. */
  data: string | null;
}

/** An SSE line's field name — "" for a comment line, the whole line when there is no colon. */
function fieldOf(line: string): string {
  const colon = line.indexOf(":");
  return colon === -1 ? line : line.slice(0, colon);
}

/**
 * Splits an SSE body into events exactly as a client would: any of CRLF, CR or LF ends a line, a
 * blank line ends an event, one space after the colon is dropped, and an event's `data` fields
 * join with "\n". A filter that read lines any other way would see a different payload than the
 * client does — one JSON document split across two `data:` lines, say — and let it through.
 * A trailing event with no blank line after it is kept: a client may still dispatch it.
 */
function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let current: SseEvent = { other: [], dataAt: 0, data: null };
  const flush = () => {
    if (current.other.length > 0 || current.data !== null) events.push(current);
    current = { other: [], dataAt: 0, data: null };
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    const colon = line.indexOf(":");
    const field = fieldOf(line);
    if (field !== "data") {
      current.other.push(line);
      continue;
    }
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (current.data === null) {
      current.dataAt = current.other.length;
      current.data = value;
    } else {
      current.data += `\n${value}`;
    }
  }
  flush();
  return events;
}

/**
 * The same filter over a complete SSE body, event by event: each event's joined data that parses
 * as JSON is filtered and re-serialised onto ONE `data:` line; event names and comments are kept.
 * It FAILS CLOSED: an event whose data is not JSON loses its data rather than pass through
 * unread — a client cannot use it as a message anyway, and nothing unread may reach one.
 *
 * `id:` lines are STRIPPED. They are upstream's resumption ids, and a client that has them can
 * ask upstream (through us, on the GET stream) to replay the events after one — which would
 * replay the tool list we just rewrote, unrewritten. A client cannot usefully resume a body the
 * gateway filtered anyway, so the id is not its to hold.
 */
export function filterToolsListSse(text: string, allowed: AllowedTools): string {
  return parseSse(text).map((event) => {
    const lines = [...event.other];
    if (event.data !== null) {
      try {
        const payload = filterToolsListPayload(JSON.parse(event.data), allowed);
        lines.splice(event.dataAt, 0, `data: ${JSON.stringify(payload)}`);
      } catch {
        // not JSON: dropped, see above
      }
    }
    return `${lines.filter((line) => fieldOf(line) !== "id").join("\n")}\n\n`;
  }).join("");
}

/** Whether a string is one complete JSON document — how the framing is decided below. */
function isJsonDocument(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `tools/list` response filtered in whichever framing carried it, decided by SNIFFING the
 * body rather than trusting a label. `content-type` is not evidence: it is case-insensitive by
 * spec, some servers send `application/octet-stream`, and some send nothing — and every one of
 * those, matched literally, used to fall down the JSON path, fail to parse, and hand the client
 * the unfiltered body. So: a body that is one JSON document is JSON; a body with at least one
 * event carrying readable JSON is SSE; anything else cannot be read, and so cannot be filtered.
 *
 * Null means "could not filter" and the caller MUST refuse — never pass an unread body on. This
 * is the fail-closed rule `filterToolsListSse` already follows per event, applied to the body.
 */
export function filterToolsListResponse(text: string, allowed: AllowedTools): string | null {
  if (isJsonDocument(text)) {
    return JSON.stringify(filterToolsListPayload(JSON.parse(text), allowed));
  }
  const events = parseSse(text);
  if (!events.some((event) => event.data !== null && isJsonDocument(event.data))) return null;
  return filterToolsListSse(text, allowed);
}

/**
 * Every JSON-RPC message in a response body, whichever framing carried it: one message for a
 * JSON body, one per event for an SSE body. Non-JSON events are skipped. Used by the probe, which
 * has to find its own response among possible notifications.
 */
export function messagesInResponse(contentType: string | null, text: string): unknown[] {
  // Media types are case-insensitive by spec, so `Text/Event-Stream` is a conforming label.
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    const out: unknown[] = [];
    for (const event of parseSse(text)) {
      if (event.data === null) continue;
      try {
        out.push(JSON.parse(event.data));
      } catch {
        // a keepalive dressed as data; not ours
      }
    }
    return out;
  }
  if (text.trim() === "") return [];
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}
