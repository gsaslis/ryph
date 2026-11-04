// The MCP data route driven by the real SDK client over an in-process fetch — the same shape the
// pi extension uses through the gateway — plus the raw refusals: the gateway token, the run id
// header, batches, and a run this service never briefed.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RUN_ID_HEADER } from "../src/http/data.ts";
import { GATEWAY, makeApi } from "./api.ts";
import { memory } from "./fixtures.ts";

const URL_ = "http://memory.test/v1/memory-mcp";

/** What the gateway does on the way in: the service token and the run id, nothing else. */
function gatewayFetch(
  data: (req: Request) => Promise<Response | null>,
  runId: string,
  token = GATEWAY,
): typeof fetch {
  return (async (input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set(RUN_ID_HEADER, runId);
    const res = await data(new Request(req.url, { method: req.method, headers, body: req.body }));
    return res ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function connect(data: (req: Request) => Promise<Response | null>, runId: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: gatewayFetch(data, runId),
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

// The slice of the SDK's types used here, spelled out.
interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

test("a real MCP client lists the tools and round-trips search, get, propose, confirm and refute", async () => {
  const { data, service, store } = makeApi();
  await store.insertMemory(memory({ id: "mem-1", text: "The app tests are vitest" }));
  await store.insertMemory(
    memory({ id: "mem-2", text: "Deploys use kustomize", subject: { kind: "org" } }),
  );
  await service.composeBrief({
    runId: "r-1",
    taskId: "t-1",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    task: { title: "t", instructions: "i" },
  });
  const { client, close } = await connect(data, "r-1");
  try {
    const tools = await client.listTools() as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    assertEquals(tools.tools.map((t) => t.name), [
      "search",
      "get",
      "doc",
      "propose",
      "confirm",
      "refute",
    ]);
    const search = tools.tools[0].inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assertEquals(search.required, ["query"]);
    assert("subject" in search.properties);

    const found = await client.callTool({
      name: "search",
      arguments: { query: "vitest tests" },
    }) as CallResult;
    assertStringIncludes(found.content[0].text!, "[mem-1] The app tests are vitest (procedure");
    assert(!found.content[0].text!.includes("mem-2"));
    // A repo the run does not hold is refused with the reason, never an empty answer.
    const elsewhere = await client.callTool({
      name: "search",
      arguments: { query: "vitest tests", repo: "github.com/acme/other" },
    }) as CallResult;
    assertEquals(elsewhere.isError, true);
    assertStringIncludes(elsewhere.content[0].text!, 'does not hold "github.com/acme/other"');
    assertStringIncludes(elsewhere.content[0].text!, "github.com/acme/app");

    const got = await client.callTool({ name: "get", arguments: { id: "mem-2" } }) as CallResult;
    assertStringIncludes(got.content[0].text!, "subject: org");
    assertStringIncludes(got.content[0].text!, "provenance: run r-0");

    const proposed = await client.callTool({
      name: "propose",
      arguments: {
        text: "CI needs --no-lock",
        kind: "gotcha",
        evidence: { sha: "abcdef1", paths: ["deno.json"] },
        basis: "observed",
      },
    }) as CallResult;
    assertStringIncludes(proposed.content[0].text!, "Recorded as proposal prop-1");
    assertEquals((await store.getProposal("prop-1"))?.evidence, {
      sha: "abcdef1",
      paths: ["deno.json"],
    });

    const confirmed = await client.callTool({
      name: "confirm",
      arguments: { id: "mem-1" },
    }) as CallResult;
    assertStringIncludes(confirmed.content[0].text!, "Confirmed mem-1 (now 1×)");

    const refuted = await client.callTool({
      name: "refute",
      arguments: {
        id: "mem-1",
        reason: "moved",
        replacement: "The app tests are deno test",
        basis: "observed",
      },
    }) as CallResult;
    assertStringIncludes(refuted.content[0].text!, "needing verification");
    assertStringIncludes(refuted.content[0].text!, "proposal prop-2");

    const noBasis = await client.callTool({
      name: "propose",
      arguments: { text: "CI needs --no-lock" },
    }) as CallResult;
    assertEquals(noBasis.isError, true);
    assertStringIncludes(noBasis.content[0].text!, "basis");
    const bad = await client.callTool({ name: "get", arguments: {} }) as CallResult;
    assertEquals(bad.isError, true);
    assertStringIncludes(bad.content[0].text!, "invalid arguments");
    const secret = await client.callTool({
      name: "propose",
      arguments: { text: "AKIAIOSFODNN7EXAMPLE", basis: "observed" },
    }) as CallResult;
    assertEquals(secret.isError, true);
    const unseen = await client.callTool({ name: "get", arguments: { id: "mem-9" } }) as CallResult;
    assertEquals(unseen.isError, true);
  } finally {
    await close();
  }
});

test("an unknown tool is method-not-found, as the gateway's allowlist would answer", async () => {
  const { data, service } = makeApi();
  await service.composeBrief({
    runId: "r-1",
    taskId: "t-1",
    agentId: "a-1",
    repos: [],
    task: { title: "t", instructions: "i" },
  });
  const { client, close } = await connect(data, "r-1");
  try {
    let message = "";
    try {
      await client.callTool({ name: "delete_everything", arguments: {} });
    } catch (err) {
      message = String(err);
    }
    assertStringIncludes(message, "Unknown tool");
  } finally {
    await close();
  }
});

test("a run this service never briefed still handshakes, and every call says why", async () => {
  const { data } = makeApi();
  const { client, close } = await connect(data, "r-unknown");
  try {
    const tools = await client.listTools() as { tools: unknown[] };
    assertEquals(tools.tools.length, 6);
    const res = await client.callTool({ name: "search", arguments: { query: "x" } }) as CallResult;
    assertEquals(res.isError, true);
    assertStringIncludes(res.content[0].text!, "no memory scope");
  } finally {
    await close();
  }
});

test("raw refusals: the gateway token, the run header, batches, other paths", async () => {
  const { data } = makeApi();
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    data(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const good = { authorization: `Bearer ${GATEWAY}`, [RUN_ID_HEADER]: "r-1" };
  assertEquals((await post(ping))!.status, 401);
  assertEquals(
    (await post(ping, { authorization: "Bearer wrong", [RUN_ID_HEADER]: "r-1" }))!.status,
    401,
  );
  assertEquals((await post(ping, { authorization: `Bearer ${GATEWAY}` }))!.status, 400);
  assertEquals((await post(ping, good))!.status, 200);
  assertEquals((await post([ping], good))!.status, 400);
  assertEquals(
    (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, good))!.status,
    202,
  );
  assertEquals((await data(new Request(URL_, { method: "GET", headers: good })))!.status, 405);
  assertEquals(await data(new Request("http://memory.test/v1/memories", { headers: good })), null);
});
