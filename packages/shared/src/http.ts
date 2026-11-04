// The HTTP layer every ryph service is built the same way: a deliberately tiny router over
// URLPattern — no framework, no middleware stack — so the whole surface is a pure
// `Request → Response` function that tests drive in-process without ever opening a socket, plus
// the JSON answer, and reading a body under a byte cap that bites WHILE it streams.
//
// These used to be a copy per service (a router in each of ten packages, a `parseBody` in five,
// a `describeIssues` in thirteen). The copies agreed on the shape and drifted on the edges: one
// router percent-decoded its path groups and the rest did not, one 413 said "-byte limit".
//
// Invariants:
// - first route whose method and pattern match wins; nothing matching is a 404 `not found`
// - a path group reaches its handler percent-decoded; a malformed escape is a 400, never passed
//   through raw for some later validator to misread
// - a body is never buffered past its cap: counted as it arrives, cancelled the moment it crosses
// - a schema is anything with zod's `safeParse` shape; this file never imports zod

/** A route's handler: the request and its path groups, decoded. */
export type Handler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

export interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

export function route(method: string, pathname: string, handler: Handler): Route {
  return { method, pattern: new URLPattern({ pathname }), handler };
}

/** The `Request → Response` function a route list makes. */
export function makeRouter(routes: Route[]): (req: Request) => Promise<Response> {
  return async (req) => {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value === undefined) continue;
        const decoded = decodeGroup(value);
        if (decoded === null) return json(400, { error: `malformed escape in ${key}` });
        params[key] = decoded;
      }
      return await r.handler(req, params);
    }
    return json(404, { error: "not found" });
  };
}

/**
 * A path group, percent-decoded; null when its escaping is malformed or it decodes to a control
 * character, which no id holds and a text column refuses with an error rather than a miss.
 *
 * URLPattern hands groups through RAW, and ids a caller must escape (a RID is `rad:z…`, a comment
 * handle `<kind>:<thread>:<oid>`, a branch name holds `/`) would otherwise arrive as `rad%3Az…`
 * and be refused by a validator that never sees what was meant.
 */
function decodeGroup(value: string): string | null {
  if (!value.includes("%")) return value;
  try {
    const decoded = decodeURIComponent(value);
    // oxlint-disable-next-line no-control-regex -- a decoded group holding one is refused
    return /[\x00-\x1f\x7f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

/** A JSON answer, pretty-printed. */
export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(body, null, 2), { status, headers: h });
}

// ── Reading a body ──────────────────────────────────────────────────────────

/** A body read that ran past its deadline: the peer was still sending, or had stopped sending
 * without closing. What is left of the stream has been cancelled. */
export class BodyDeadlineError extends Error {
  override readonly name = "BodyDeadlineError";
  constructor() {
    super("the body took too long to arrive");
  }
}

/**
 * Read UTF-8 text within a byte budget. `null` means overflow; a broken body still throws.
 * Content-Length can reject a body early, but never exempts it from the streaming limit.
 * Callers own response policy (including authentication and how to report either failure).
 * `signal` is the read's DEADLINE: once it aborts, the rest is cancelled and the read throws
 * BodyDeadlineError — a cap bounds how much a peer may send, not how long it may hold the
 * handler (and the bytes already buffered) by sending it one drip at a time.
 */
export async function readCapped(
  req: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const length = req.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    // A producer's cleanup may hang or fail. Neither should delay reporting overflow.
    void req.body?.cancel().catch(() => {});
    return null;
  }
  if (req.body === null) return "";

  const reader = req.body.getReader();
  if (signal?.aborted) {
    void reader.cancel().catch(() => {});
    throw new BodyDeadlineError();
  }
  let onAbort = () => {};
  const expired = signal === undefined ? null : new Promise<"deadline">((resolve) => {
    onAbort = () => resolve("deadline");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = expired === null
        ? await reader.read()
        : await Promise.race([reader.read(), expired]);
      if (next === "deadline") {
        void reader.cancel().catch(() => {});
        throw new BodyDeadlineError();
      }
      const { done, value } = next;
      if (done) return text + decoder.decode();
      if (value.byteLength > maxBytes - bytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A read the deadline raced may still be pending; releasing the lock then rejects it, which
    // nothing awaits any more, and must not replace the error this read is answering with.
    try {
      reader.releaseLock();
    } catch {
      // Older stream implementations throw instead; the lock goes with the reader either way.
    }
  }
}

/** Why a capped read stopped short. */
export type CappedReadFailure = { ok: false; reason: "too_large" | "timeout" };

/**
 * Reads a body to its bytes, or reports that it crossed the cap or ran past its deadline —
 * cancelling the rest unread either way. Given a whole Request or Response, a Content-Length over
 * the cap is refused before a byte is read; it never exempts the body from the streaming count,
 * since a chunked body announces no length at all. A stream that fails mid-read (a reset) throws;
 * the caller decides what that means. `signal` is the DEADLINE for the whole read: a cap alone
 * bounds how much a peer may send, not how long it may take to send it, and a stream that never
 * closes would otherwise hold the handler until the client gives up.
 */
export async function readCappedBytes(
  body: Request | Response | ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<{ ok: true; bytes: Uint8Array } | CappedReadFailure> {
  if (body instanceof Request || body instanceof Response) {
    const length = body.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > max) {
      // A producer's cleanup may hang or fail. Neither should delay reporting overflow.
      void body.body?.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    return await readCappedBytes(body.body, max, signal);
  }
  if (body === null) return { ok: true, bytes: new Uint8Array() };
  const reader = body.getReader();
  const expired = signal === undefined ? null : new Promise<"timeout">((resolve) => {
    if (signal.aborted) resolve("timeout");
    else signal.addEventListener("abort", () => resolve("timeout"), { once: true });
  });
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const next = expired === null
      ? await reader.read()
      : await Promise.race([reader.read(), expired]);
    if (next === "timeout") {
      reader.cancel().catch(() => {});
      return { ok: false, reason: "timeout" };
    }
    const { value, done } = next;
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: all };
}

/** `readCappedBytes`, decoded leniently to a string — for what a peer sends back. */
export async function readCappedText(
  body: Request | Response | ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | CappedReadFailure> {
  const read = await readCappedBytes(body, max, signal);
  return read.ok ? { ok: true, text: new TextDecoder().decode(read.bytes) } : read;
}

// ── Validating a body ───────────────────────────────────────────────────────

/** One validation failure: where in the value, and what is wrong there. */
export interface SchemaIssue {
  path: PropertyKey[];
  message: string;
}

/** What `parseBody` needs of a schema — zod's `safeParse`, structurally, so zod is never imported. */
export interface Schema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: SchemaIssue[] } };
}

/** Issues as one line: `path.to.field: message`, `; `-separated; a root issue is its message. */
export function describeIssues(error: { issues: readonly SchemaIssue[] }): string {
  return error.issues
    .map((i) => i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message)
    .join("; ");
}

/** Management JSON is small by default; routes carrying more opt in. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Whether a request says its body is JSON: `application/json`, with or without parameters
 * (`; charset=utf-8`).
 */
export function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

/**
 * Reads, parses and validates a bounded JSON body. Over the cap answers 413, malformed JSON (or a
 * body cut short) 400, a schema failure 400 with its issues described. `emptyIs` is what an absent
 * or blank body stands for — `{}` for a verb whose body is a set of optional knobs, `null` for a
 * route whose body may be left out; without it, an empty body is malformed. `signal` is the read's
 * deadline (readCapped): a body still arriving when it aborts answers 408.
 *
 * A body that is there must say it is JSON, or it is a 415. The types a browser may send to any
 * origin without asking first (`text/plain`, the form types, or none at all) are exactly the
 * ones a page on another site can aim at a route that would otherwise parse them as JSON anyway;
 * `application/json` is not among them, so requiring it keeps a cookie-carrying cross-site
 * request from ever reaching a handler with a body it chose.
 */
export async function parseBody<T>(
  req: Request,
  schema: Schema<T>,
  opts: { maxBytes?: number; emptyIs?: unknown; signal?: AbortSignal } = {},
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const maxBytes = opts.maxBytes ?? MAX_JSON_BODY_BYTES;
  let raw: unknown;
  try {
    const text = await readCapped(req, maxBytes, opts.signal);
    if (text === null) {
      return { ok: false, res: json(413, { error: `body exceeds ${maxBytes} bytes` }) };
    }
    if ("emptyIs" in opts && text.trim() === "") {
      raw = opts.emptyIs;
    } else if (!isJsonContentType(req.headers.get("content-type"))) {
      return {
        ok: false,
        res: json(415, { error: "body must be sent as content-type: application/json" }),
      };
    } else {
      raw = JSON.parse(text);
    }
  } catch (err) {
    if (err instanceof BodyDeadlineError) {
      return { ok: false, res: json(408, { error: err.message }) };
    }
    return { ok: false, res: json(400, { error: "body is not valid JSON" }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: json(400, { error: describeIssues(parsed.error) }) };
  }
  return { ok: true, data: parsed.data };
}
