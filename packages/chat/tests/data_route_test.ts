// The MCP data route driven by the real SDK client over an in-process fetch — the same shape the
// pi extension uses through the gateway — plus the raw refusals: the gateway token, the run id
// header, and a run with no room.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RUN_ID_HEADER } from "../src/http/data.ts";
import { bindRun, GATEWAY, makeApi, makeRoom } from "./api.ts";
import { BOT_TOKEN, mention } from "./fake_transport.ts";

const URL_ = "http://chat.test/v1/chat-mcp";

/** What the gateway does on the way in: the service token and the run id, nothing else. */
function gatewayFetch(
  data: (req: Request) => Promise<Response | null>,
  runId: string,
  token = GATEWAY,
): typeof fetch {
  return (async (input: URL | Request | string, init?: RequestInit) => {
    const req = typeof input === "string" || input instanceof URL
      ? new Request(String(input), init)
      : new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set(RUN_ID_HEADER, runId);
    const res = await data(new Request(req.url, { method: req.method, headers, body: req.body }));
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function connect(data: (req: Request) => Promise<Response | null>, runId: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: gatewayFetch(data, runId),
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

test("a real MCP client lists `post` and posts into the bound room", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 1, text: `@ryph_bot ${room.linkCode}` }));
    await api.service.pollOnce(room.id, new AbortController().signal);
    await bindRun(api, room.id);
    const { client, close } = await connect(api.data, "r-1");
    try {
      const tools = await client.listTools() as { tools: Array<{ name: string }> };
      assertEquals(tools.tools.map((t) => t.name), ["post"]);
      const posted = await client.callTool({
        name: "post",
        arguments: { text: "Cache TTL is 5s; raising it." },
      }) as CallResult;
      assertEquals(posted.isError ?? false, false);
      assertEquals(api.transport.sent.at(-1)?.text, "[Ada] Cache TTL is 5s; raising it.");
      const bad = await client.callTool({ name: "post", arguments: {} }) as CallResult;
      assertEquals(bad.isError, true);
    } finally {
      await close();
    }
    // A run with no room: the tool answers its own error, so the model reads why.
    const { client: unbound, close: closeUnbound } = await connect(api.data, "r-none");
    try {
      const res = await unbound.callTool({ name: "post", arguments: { text: "x" } }) as CallResult;
      assertEquals(res.isError, true);
      assert(res.content[0].text?.includes("not bound"));
    } finally {
      await closeUnbound();
    }
  } finally {
    await api.close();
  }
});

test("the raw route refuses a wrong token, a missing run id, and a batch", async () => {
  const api = await makeApi();
  try {
    const post = (headers: Record<string, string>, body: unknown) =>
      api.data(
        new Request(URL_, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    assertEquals(
      (await post({ authorization: "Bearer nope", [RUN_ID_HEADER]: "r-1" }, ping))?.status,
      401,
    );
    assertEquals((await post({ authorization: `Bearer ${GATEWAY}` }, ping))?.status, 400);
    assertEquals(
      (await post({ authorization: `Bearer ${GATEWAY}`, [RUN_ID_HEADER]: "r-1" }, [ping]))?.status,
      400,
    );
    assertEquals(
      (await post({ authorization: `Bearer ${GATEWAY}`, [RUN_ID_HEADER]: "r-1" }, ping))?.status,
      200,
    );
    assertEquals(await api.data(new Request("http://chat.test/elsewhere")), null);
  } finally {
    await api.close();
  }
});
