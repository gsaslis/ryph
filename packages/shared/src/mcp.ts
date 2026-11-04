// MCP's JSON-RPC, in the minimum a client needs: initialize, ping, notifications (acknowledged,
// never acted on), tools/list and tools/call. Every ryph tool server — memory, chat, web, the
// browser, the forge, the runner's loopback, the `ryph mcp` binary — is this and a list of tools.
// Hand-rolled rather than the SDK's server, which would pull a dependency tree into every process
// that mounts one, the single binary included, for five methods.
//
// Transport-free: one parsed message in, the frame to answer it with out. An HTTP mount carries
// that frame as one JSON response (no sessions, no server→client stream: a GET answers 405, which
// a streamable-HTTP client takes as "no stream offered"); `ryph mcp` carries it as a line on
// stdout, and keeps its framing, cancellation and in-flight ids to itself.
//
// Invariants:
// - never throws: a malformed message is a JSON-RPC error, a tool that throws is -32603 with a
//   message the server chose (never the exception's own text unless the server says so)
// - batches are refused, as the gateway refuses them
// - an unknown tool is -32601, the code the gateway's allowlist uses for a denied one, so the
//   model cannot tell the two apart; a server that would rather answer in words returns a tool
//   error from `call` instead of null
// - a call whose signal was aborted is not answered: the client has stopped listening for its id

export const PROTOCOL_VERSION = "2025-06-18";
/** The versions this server answers as asked; any other gets PROTOCOL_VERSION back, and the
 * client decides whether it can go on — MCP's negotiation, rather than echoing a version this
 * server has never spoken. Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type Id = string | number;
export type Frame = Record<string, unknown>;

/** One block of a tool's answer: text, an image, or whatever else MCP carries. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface ToolResult {
  content: ToolContent[];
  /** The call could not be made, said in words the model reads. A bad verdict is not an error. */
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** A tool as tools/list sends it. Served as given: a definition carrying more (a handler, the
 * capabilities it needs) is the server's to strip before `list` returns it. */
export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object;
  annotations?: object;
}

/** What a call is handed beyond its name and arguments. */
export interface CallExtra {
  /** Aborted when the client cancelled the call or went away. Never aborted over HTTP unless
   * the mount passes a signal. */
  signal: AbortSignal;
  /** Sends a `notifications/progress` for this call — a no-op unless the client asked for
   * progress (`_meta.progressToken`), the transport can notify, and the call is still live. */
  progress(message: string): void;
}

export interface ToolServer {
  info: { name: string; version: string };
  /** Sent with initialize; a function for instructions that depend on the run. */
  instructions?: string | (() => string);
  tools: {
    list(): readonly ToolDef[] | Promise<readonly ToolDef[]>;
    /** The call's result, or null for a tool this server does not have (-32601). A rejection is
     * a bug, answered with `failed`'s message as -32603. */
    call(
      name: string,
      args: Record<string, unknown>,
      extra: CallExtra,
    ): Promise<ToolResult | null> | ToolResult | null;
  };
  /** A call threw: log it here, and return the message the client reads. Defaults to a message
   * that says nothing of this server's internals. */
  failed?(name: string, err: unknown): string | void;
}

/** What the transport hands each message. */
export interface MessageOptions {
  signal?: AbortSignal;
  /** Sends a notification to the client; a transport that cannot (one HTTP response) leaves it
   * out, and progress goes nowhere. */
  notify?(frame: Frame): void;
}

/** A frame to send back, with the HTTP status a single-response transport answers it with. */
export interface Reply {
  status: number;
  body: Frame;
}

function rpcResult(id: Id | null, value: unknown): Frame {
  return { jsonrpc: "2.0", id, result: value };
}

export function rpcError(id: Id | null, code: number, message: string): Frame {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool's answer as text; `isError` for a call that could not be made. */
export function toolText(text: string, isError = false): ToolResult & {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** The answer to a message that is not JSON. */
export const parseError = (): Frame => rpcError(null, PARSE_ERROR, "Parse error");

/** The answer to a request whose id is still in flight under an earlier one. */
export const duplicateIdError = (id: Id): Frame =>
  rpcError(id, INVALID_REQUEST, `Invalid Request: id ${JSON.stringify(id)} is already in flight`);

/** The id of a request, or null for a notification or a response. */
export function requestIdOf(raw: unknown): Id | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.method !== "string") return null;
  return typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
}

/** The request a `notifications/cancelled` names, or null for any other message. */
export function cancelledRequestId(raw: unknown): Id | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.method !== "notifications/cancelled" || "id" in msg) return null;
  const params = msg.params as Record<string, unknown> | undefined;
  const id = params?.requestId;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** One body (text) → the reply, or null for a notification or a response (nothing to send). */
export async function handleBody(
  server: ToolServer,
  body: string,
  opts: MessageOptions = {},
): Promise<Reply | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { status: 400, body: parseError() };
  }
  return await handleMessage(server, raw, opts);
}

/** One parsed message → the reply, or null for a notification or a response. Never throws. */
export async function handleMessage(
  server: ToolServer,
  raw: unknown,
  opts: MessageOptions = {},
): Promise<Reply | null> {
  if (Array.isArray(raw)) {
    return {
      status: 400,
      body: rpcError(null, INVALID_REQUEST, "JSON-RPC batches are not accepted"),
    };
  }
  if (raw === null || typeof raw !== "object") {
    return { status: 400, body: rpcError(null, INVALID_REQUEST, "Invalid Request") };
  }
  const msg = raw as Record<string, unknown>;
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const method = typeof msg.method === "string" ? msg.method : null;
  if (method === null) {
    // A response to something this server never asks: nothing to answer. An id with neither a
    // method nor a result is a request that cannot be served.
    if (id !== null && !("result" in msg) && !("error" in msg)) {
      return { status: 400, body: rpcError(id, INVALID_REQUEST, "Invalid Request: no method") };
    }
    return null;
  }
  // A notification: acknowledged by not answering.
  if (id === null) return null;
  const ok = (value: unknown): Reply => ({ status: 200, body: rpcResult(id, value) });
  const fail = (code: number, message: string): Reply => ({
    status: 200,
    body: rpcError(id, code, message),
  });
  const params = (msg.params ?? {}) as Record<string, unknown>;

  try {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const instructions = typeof server.instructions === "function"
          ? server.instructions()
          : server.instructions;
        return ok({
          protocolVersion:
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: server.info,
          ...(instructions === undefined ? {} : { instructions }),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: await server.tools.list() });
      case "tools/call":
        return await call(server, id, params, opts, ok, fail);
      default:
        return fail(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    // Only tools/list can land here: a call's own failure is handled where the call is made.
    return fail(INTERNAL_ERROR, failure(server, method, err));
  }
}

async function call(
  server: ToolServer,
  id: Id,
  params: Record<string, unknown>,
  opts: MessageOptions,
  ok: (value: unknown) => Reply,
  fail: (code: number, message: string) => Reply,
): Promise<Reply | null> {
  const name = typeof params.name === "string" ? params.name : null;
  if (name === null) return fail(INVALID_PARAMS, "tools/call needs a tool name");
  const args = params.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return fail(INVALID_PARAMS, "tools/call arguments must be an object");
  }
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const token = typeof meta.progressToken === "string" || typeof meta.progressToken === "number"
    ? meta.progressToken
    : null;
  const signal = opts.signal ?? new AbortController().signal;
  let step = 0;
  const progress = (message: string) => {
    if (token === null || !opts.notify || signal.aborted) return;
    opts.notify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: ++step, message },
    });
  };
  try {
    const result = await server.tools.call(name, args as Record<string, unknown>, {
      signal,
      progress,
    });
    // Cancelled: the client has stopped listening for this id, and the spec says not to answer.
    if (signal.aborted) return null;
    if (result == null) return fail(METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    return ok(result);
  } catch (err) {
    if (signal.aborted) return null;
    return fail(INTERNAL_ERROR, failure(server, name, err));
  }
}

function failure(server: ToolServer, name: string, err: unknown): string {
  return server.failed?.(name, err) ?? `${server.info.name} could not complete the call`;
}

// --- Over HTTP ---

/**
 * The streamable-HTTP methods that carry no message: a GET is "nothing to stream" (405, which a
 * client takes as no stream offered), a DELETE "nothing to end" (200, there are no sessions),
 * anything but POST 405. Null for a POST, whose body the mount reads under its own cap.
 */
export function nonPostResponse(req: Request): Response | null {
  if (req.method === "POST") return null;
  if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
  });
}

/** A reply as the one HTTP response that carries it; nothing to send is 202 Accepted. */
export function replyResponse(reply: Reply | null): Response {
  if (reply === null) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}
