// The MCP server core: the protocol every ryph tool server answers, and the HTTP edges around it.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cancelledRequestId,
  duplicateIdError,
  type Frame,
  handleBody,
  handleMessage,
  nonPostResponse,
  PROTOCOL_VERSION,
  replyResponse,
  requestIdOf,
  rpcError,
  type ToolServer,
  toolText,
} from "../src/mcp.ts";

function rpcResult(id: string | number, value: unknown): Frame {
  return { jsonrpc: "2.0", id, result: value };
}

const TOOLS = [{ name: "echo", description: "says it back", inputSchema: { type: "object" } }];

function server(overrides: Partial<ToolServer> = {}): ToolServer {
  return {
    info: { name: "ryph-test", version: "0.0.1" },
    instructions: "test tools",
    tools: {
      list: () => TOOLS,
      call: (name, args) => name === "echo" ? toolText(String(args.text)) : null,
    },
    ...overrides,
  };
}

const req = (id: string | number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

test("initialize answers a supported version as asked, any other with the latest", async () => {
  const asked = await handleMessage(
    server(),
    req(1, "initialize", { protocolVersion: "2025-03-26" }),
  );
  assertEquals(asked, {
    status: 200,
    body: rpcResult(1, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "ryph-test", version: "0.0.1" },
      instructions: "test tools",
    }),
  });
  for (const params of [{ protocolVersion: "1999-01-01" }, {}, undefined]) {
    const r = await handleMessage(server(), req(2, "initialize", params));
    assertEquals((r!.body.result as Frame).protocolVersion, PROTOCOL_VERSION);
  }
});

test("instructions may be computed per handshake, or left out", async () => {
  let n = 0;
  const computed = server({ instructions: () => `call ${++n}` });
  const a = await handleMessage(computed, req(1, "initialize"));
  const b = await handleMessage(computed, req(2, "initialize"));
  assertEquals((a!.body.result as Frame).instructions, "call 1");
  assertEquals((b!.body.result as Frame).instructions, "call 2");
  const none = await handleMessage(server({ instructions: undefined }), req(3, "initialize"));
  assertEquals("instructions" in (none!.body.result as Frame), false);
});

test("ping, tools/list and a call answer the protocol", async () => {
  assertEquals(await handleMessage(server(), req(1, "ping")), {
    status: 200,
    body: rpcResult(1, {}),
  });
  assertEquals(await handleMessage(server(), req("l", "tools/list")), {
    status: 200,
    body: rpcResult("l", { tools: TOOLS }),
  });
  const called = await handleMessage(
    server(),
    req(3, "tools/call", { name: "echo", arguments: { text: "hi" } }),
  );
  assertEquals(called, {
    status: 200,
    body: rpcResult(3, { content: [{ type: "text", text: "hi" }] }),
  });
});

test("an async tool list is awaited", async () => {
  const s = server({ tools: { list: () => Promise.resolve(TOOLS), call: () => null } });
  assertEquals(((await handleMessage(s, req(1, "tools/list")))!.body.result as Frame).tools, TOOLS);
});

test("malformed messages, batches and unknown methods are refused with their codes", async () => {
  assertEquals(await handleBody(server(), "{not json"), {
    status: 400,
    body: rpcError(null, -32700, "Parse error"),
  });
  const batch = await handleBody(server(), JSON.stringify([req(1, "ping")]));
  assertEquals(batch!.status, 400);
  assertEquals((batch!.body.error as Frame).code, -32600);
  for (const raw of ["null", "3", '"ping"']) {
    const r = await handleBody(server(), raw);
    assertEquals(r!.status, 400);
    assertEquals((r!.body.error as Frame).code, -32600);
  }
  const unknown = await handleMessage(server(), req(4, "resources/list"));
  assertEquals(unknown, {
    status: 200,
    body: rpcError(4, -32601, "Method not found: resources/list"),
  });
});

test("notifications and responses are acknowledged by answering nothing", async () => {
  assertEquals(
    await handleMessage(server(), { jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
  assertEquals(await handleMessage(server(), { jsonrpc: "2.0", id: 9, result: {} }), null);
  assertEquals(
    await handleMessage(server(), { jsonrpc: "2.0", id: 9, error: { code: 1, message: "x" } }),
    null,
  );
  // An id with neither a method nor a result cannot be served.
  const noMethod = await handleMessage(server(), { jsonrpc: "2.0", id: 9 });
  assertEquals((noMethod!.body.error as Frame).code, -32600);
});

test("an unknown tool is method-not-found, as the gateway's allowlist would answer", async () => {
  const r = await handleMessage(server(), req(1, "tools/call", { name: "delete_everything" }));
  assertEquals(r, { status: 200, body: rpcError(1, -32601, "Unknown tool: delete_everything") });
  // A call that answers nothing at all is unknown too, never a reply with neither result nor error.
  const silent = server({ tools: { list: () => TOOLS, call: () => undefined as never } });
  const s = await handleMessage(silent, req(2, "tools/call", { name: "echo" }));
  assertEquals(s, { status: 200, body: rpcError(2, -32601, "Unknown tool: echo") });
});

test("a call needs a name and object arguments; left-out arguments are an empty object", async () => {
  const noName = await handleMessage(server(), req(1, "tools/call", {}));
  assertEquals(noName, { status: 200, body: rpcError(1, -32602, "tools/call needs a tool name") });
  for (const args of [[1], "x", 3]) {
    const r = await handleMessage(
      server(),
      req(2, "tools/call", { name: "echo", arguments: args }),
    );
    assertEquals((r!.body.error as Frame).code, -32602);
  }
  let seen: unknown;
  const s = server({
    tools: {
      list: () => TOOLS,
      call: (_name, args) => {
        seen = args;
        return toolText("ok");
      },
    },
  });
  await handleMessage(s, req(3, "tools/call", { name: "echo" }));
  assertEquals(seen, {});
});

test("a tool that throws is an internal error, in the server's words, never the exception's", async () => {
  const logged: Array<[string, string]> = [];
  const throwing: ToolServer["tools"] = {
    list: () => TOOLS,
    call: () => Promise.reject(new Error("db password is hunter2")),
  };
  const quiet = await handleMessage(
    server({ tools: throwing }),
    req(1, "tools/call", { name: "echo" }),
  );
  assertEquals(quiet, {
    status: 200,
    body: rpcError(1, -32603, "ryph-test could not complete the call"),
  });
  const chosen = await handleMessage(
    server({
      tools: throwing,
      failed: (name, err) => {
        logged.push([name, String(err)]);
        return "the memory service could not complete the call";
      },
    }),
    req(2, "tools/call", { name: "echo" }),
  );
  assertEquals(
    (chosen!.body.error as Frame).message,
    "the memory service could not complete the call",
  );
  assertEquals(logged, [["echo", "Error: db password is hunter2"]]);
  // A hook that only logs keeps the default message.
  const logOnly = await handleMessage(
    server({ tools: throwing, failed: () => {} }),
    req(3, "tools/call", { name: "echo" }),
  );
  assertEquals((logOnly!.body.error as Frame).message, "ryph-test could not complete the call");
});

test("a failing tool list is an internal error too", async () => {
  const s = server({
    tools: {
      list: () => {
        throw new Error("x");
      },
      call: () => null,
    },
  });
  const r = await handleMessage(s, req(1, "tools/list"));
  assertEquals((r!.body.error as Frame).code, -32603);
});

test("a tool error is a successful call carrying isError", async () => {
  const s = server({ tools: { list: () => TOOLS, call: () => toolText("not ready", true) } });
  const r = await handleMessage(s, req(1, "tools/call", { name: "echo" }));
  assertEquals(r!.body.result, { content: [{ type: "text", text: "not ready" }], isError: true });
  assertEquals(toolText("fine"), { content: [{ type: "text", text: "fine" }] });
});

test("a cancelled call is never answered, whether it resolved or threw", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const abort = new AbortController();
    const s = server({
      tools: {
        list: () => TOOLS,
        call: (_name, _args, { signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () =>
              outcome === "resolve" ? resolve(toolText("late")) : reject(signal.reason));
          }),
      },
    });
    const pending = handleMessage(s, req(1, "tools/call", { name: "echo" }), {
      signal: abort.signal,
    });
    abort.abort();
    assertEquals(await pending, null);
  }
});

test("progress reaches the client only when it asked, and stops once the call is cancelled", async () => {
  const sent: Frame[] = [];
  const abort = new AbortController();
  const s = server({
    tools: {
      list: () => TOOLS,
      call: (_name, _args, { progress }) => {
        progress("one");
        progress("two");
        abort.abort();
        progress("three");
        return toolText("done");
      },
    },
  });
  await handleMessage(s, req(1, "tools/call", { name: "echo", _meta: { progressToken: "p" } }), {
    signal: abort.signal,
    notify: (f) => sent.push(f),
  });
  assertEquals(sent, [
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p", progress: 1, message: "one" },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p", progress: 2, message: "two" },
    },
  ]);
  const quiet: Frame[] = [];
  await handleMessage(s, req(2, "tools/call", { name: "echo" }), { notify: (f) => quiet.push(f) });
  assertEquals(quiet, []);
});

test("the stdio helpers: request ids, cancellations, duplicate ids", () => {
  assertEquals(requestIdOf(req(7, "ping")), 7);
  assertEquals(requestIdOf({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assertEquals(requestIdOf({ jsonrpc: "2.0", id: 7, result: {} }), null);
  assertEquals(requestIdOf([req(7, "ping")]), null);
  assertEquals(
    cancelledRequestId({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "a" },
    }),
    "a",
  );
  // A request named notifications/cancelled is not a cancellation.
  assertEquals(
    cancelledRequestId({
      jsonrpc: "2.0",
      id: 1,
      method: "notifications/cancelled",
      params: { requestId: "a" },
    }),
    null,
  );
  assertEquals(cancelledRequestId(req(1, "ping")), null);
  const dup = duplicateIdError(5);
  assertEquals((dup.error as Frame).code, -32600);
  assertStringIncludes((dup.error as Frame).message as string, "already in flight");
});

test("over HTTP: GET is no stream, DELETE no session, other methods 405, POST is the body's", async () => {
  const at = (method: string) => nonPostResponse(new Request("http://x/mcp", { method }));
  const get = at("GET")!;
  assertEquals([get.status, get.headers.get("allow")], [405, "POST"]);
  assertEquals(at("DELETE")!.status, 200);
  assertEquals(at("PUT")!.status, 405);
  assertEquals(at("POST"), null);

  const accepted = replyResponse(null);
  assertEquals(accepted.status, 202);
  const replied = replyResponse({ status: 400, body: rpcError(null, -32700, "Parse error") });
  assertEquals(replied.status, 400);
  assertEquals(replied.headers.get("content-type"), "application/json");
  assertEquals(await replied.json(), rpcError(null, -32700, "Parse error"));
});
