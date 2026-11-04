// The whole data plane between a REAL MCP client and a REAL MCP server — the SDK on both ends,
// the gateway handler in the middle, and no sockets: the client transport's fetch is the gateway
// handler, the gateway's upstream fetch is the server transport. This is the spike that decided
// the design, kept as the regression test for what it verified:
// session passthrough, the standalone GET stream, tools/list filtering in both framings, an
// allowed call round-tripping, a denied call surfacing as "unknown tool", in-call notifications
// reaching the client, and upstream seeing only the real bearer.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { makeGatewayHandler } from "../src/http/proxy.ts";
import { makeMcpCredentialIssuer } from "../src/core/service.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { fakeDecrypt, openPolicy, server, T0 } from "./fixtures.ts";

const REAL = "Bearer real-linear-token";

// The handful of SDK callback shapes these tests use, spelled out.
interface CallToolRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}

/** An SDK server behind a fetch-shaped door that demands the real bearer. */
function makeUpstream(jsonMode: boolean) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const authSeen: Array<string | null> = [];

  const makeServer = () => {
    const srv = new Server(
      { name: "roundtrip-upstream", version: "0.0.1" },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
    srv.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [
          {
            name: "echo",
            description: "echo back",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
          {
            name: "secret_dump",
            description: "should be hidden",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
    srv.setRequestHandler(
      CallToolRequestSchema,
      async (req: CallToolRequest, extra: { sendNotification(n: unknown): Promise<void> }) => {
        if (req.params.name === "echo") {
          await extra.sendNotification({
            method: "notifications/message",
            params: { level: "info", data: "progress from upstream" },
          });
          const text = (req.params.arguments as { text?: string } | undefined)?.text;
          return { content: [{ type: "text", text: `echo:${text}` }] };
        }
        if (req.params.name === "secret_dump") {
          return { content: [{ type: "text", text: "LEAKED" }] };
        }
        throw new Error("unknown tool");
      },
    );
    return srv;
  };

  const fetchLike = (async (input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    authSeen.push(req.headers.get("authorization"));
    if (req.headers.get("authorization") !== REAL) {
      return new Response("unauthorized", { status: 401 });
    }
    const sid = req.headers.get("mcp-session-id");
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (req.method !== "POST") return new Response("no session", { status: 400 });
      const fresh = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: jsonMode,
        onsessioninitialized: (id: string) => void sessions.set(id, fresh),
      });
      await makeServer().connect(fresh);
      transport = fresh;
    }
    return await transport.handleRequest(req);
  }) as unknown as typeof fetch;

  return {
    fetch: fetchLike,
    authSeen,
    close: () => Promise.all([...sessions.values()].map((t) => t.close())),
  };
}

async function makeGateway(jsonMode: boolean, allowedTools: string[] | "*") {
  const store = memoryGatewayStore();
  await store.createServer(server({ url: "https://upstream.test/mcp" }));
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://gw.test",
    ttlMs: 60_000,
  });
  const creds = await issuer.issue({ runId: "r-1", servers: [{ serverId: "ms-1", allowedTools }] });
  const upstream = makeUpstream(jsonMode);
  const handler = makeGatewayHandler({
    store,
    decrypt: fakeDecrypt,
    now: () => new Date(T0), // the issuer's clock: a real "now" would be past the 60s TTL
    diag: { debug() {}, warn() {} },
    upstream: openPolicy,
    upstreamFetch: upstream.fetch,
  });
  return { handler, store, creds, upstream };
}

async function connect(
  handler: (req: Request) => Promise<Response>,
  url: string,
  token: string,
) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input: string | URL, init?: RequestInit) =>
      handler(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      ),
  });
  const client = new Client({ name: "roundtrip-client", version: "0.0.1" });
  await client.connect(transport);
  return { client, transport };
}

for (const jsonMode of [false, true]) {
  const mode = jsonMode ? "JSON responses" : "SSE responses";

  test(`SDK round trip (${mode}): session, filtered list, allowed and denied calls`, async () => {
    const { handler, store, creds, upstream } = await makeGateway(jsonMode, ["echo"]);
    const { client, transport } = await connect(handler, creds.servers[0].url, creds.token);
    try {
      assert(transport.sessionId, "the client adopted upstream's session id through the gateway");

      const listed = (await client.listTools()).tools.map((t: { name: string }) => t.name);
      assertEquals(listed, ["echo"], "the hidden tool is absent from the client's view");

      const notes: string[] = [];
      client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        (n: { params: { data: unknown } }) => {
          notes.push(String(n.params.data));
        },
      );
      const echoed = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      assertEquals(echoed.content, [{ type: "text", text: "echo:hi" }]);
      if (!jsonMode) {
        // In JSON-response mode the SDK server itself drops notifications emitted during a
        // call — a property of upstream, not of the gateway.
        assertEquals(notes, ["progress from upstream"]);
      }

      let denied = "";
      try {
        await client.callTool({ name: "secret_dump", arguments: {} });
      } catch (err) {
        denied = (err as Error).message;
      }
      assert(denied.includes("-32601") && denied.includes("Unknown tool"), denied);

      assert(upstream.authSeen.every((a) => a === REAL), "upstream saw only the real bearer");
      assert(!upstream.authSeen.some((a) => a?.includes("ryph-mcp-")));

      const { records: usage } = await store.listUsageForRun("r-1");
      const calls = usage.filter((u) => u.method === "tools/call");
      assertEquals(calls.map((u) => [u.tool, u.status]), [["echo", "ok"], [
        "secret_dump",
        "denied",
      ]]);
    } finally {
      await client.close();
      await upstream.close();
    }
  });
}

test("SDK round trip: a wrong virtual token is refused at the gateway; upstream is never dialed", async () => {
  const { handler, creds, upstream } = await makeGateway(true, "*");
  let failed = "";
  try {
    await connect(handler, creds.servers[0].url, "ryph-mcp-forged");
  } catch (err) {
    failed = (err as Error).message;
  }
  assert(failed !== "", "connecting with a forged token must fail");
  assertEquals(upstream.authSeen, []);
  await upstream.close();
});
