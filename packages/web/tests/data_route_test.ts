// The MCP route, over the handler itself: no socket, no listener, exactly as @ryph/memory's data
// route is tested. What it proves is the contract with the gateway — the token, the run-id
// header, and the JSON-RPC surface a run's harness drives through it.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setup, type WebDiag } from "../src/setup.ts";
import { MCP_PATH, RUN_ID_HEADER } from "../src/http/data.ts";
import type { SearchBackend } from "../src/ports/search.ts";
import type { Converter } from "../src/ports/converter.ts";
import { htmlToMarkdown } from "../src/core/markdown.ts";

const TOKEN = "gateway-token";
const diag: WebDiag = { debug: () => {}, info: () => {}, warn: () => {} };

/** The conversion in-process: these tests are about the route, not about the worker. */
const inlineConverter = (): Converter => ({
  convert: (html, url) => Promise.resolve(htmlToMarkdown(html, url)),
  close: () => {},
});

const policy = { allowInsecure: false, resolve: () => Promise.resolve(["93.184.216.34"]) };

const searchBackend: SearchBackend = {
  provider: "fake",
  search: () =>
    Promise.resolve([{ title: "Hit", url: "https://a.example/1", snippet: "About it" }]),
};

interface ServiceOptions {
  search?: SearchBackend | null;
  token?: string | null;
  diag?: WebDiag;
  /** Counts what actually left this process, for the cache test. */
  fetches?: string[];
}

function service(over: ServiceOptions = {}) {
  return setup({
    gatewayToken: over.token === undefined ? TOKEN : over.token,
    search: over.search ?? null,
    policy,
    converter: inlineConverter(),
    fetch: ((url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      over.fetches?.push(href);
      return Promise.resolve(
        new Response(
          `<html><head><title>Doc</title></head><body><main><p>${href}</p></main></body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        ),
      );
    }) as unknown as typeof fetch,
    diag: over.diag ?? diag,
  });
}

function request(body: unknown, init: { token?: string | null; runId?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const runId = init.runId === undefined ? "run-1" : init.runId;
  if (runId !== null) headers.set(RUN_ID_HEADER, runId);
  return new Request(`http://web.internal${MCP_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

test("a path this service does not serve is not this handler's", async () => {
  assertEquals(await service().dataHandler(new Request("http://web.internal/healthz")), null);
});

test("no token, a wrong token, or no token configured: nothing gets through", async () => {
  assertEquals((await service().dataHandler(request(rpc("ping"), { token: null })))!.status, 401);
  assertEquals(
    (await service().dataHandler(request(rpc("ping"), { token: "nope" })))!.status,
    401,
  );
  const dark = await service({ token: null }).dataHandler(request(rpc("ping")));
  assertEquals(dark!.status, 503);
});

test("the run id is required on every call", async () => {
  // That a CONTAINER cannot set this header is the gateway's half of the contract (it forwards
  // request headers by allowlist and this one is not on it), and is tested there. This side's
  // half is only that the header is required, and that is what this asserts.
  const res = await service().dataHandler(request(rpc("ping"), { runId: null }));
  assertEquals(res!.status, 400);
  assertStringIncludes((await res!.json()).error, RUN_ID_HEADER);
});

test("GET offers no stream, DELETE ends nothing, and both are fine", async () => {
  const web = service();
  const get = await web.dataHandler(
    new Request(`http://web.internal${MCP_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  assertEquals(get!.status, 405);
  assertEquals(get!.headers.get("allow"), "POST");
  const del = await web.dataHandler(
    new Request(`http://web.internal${MCP_PATH}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  assertEquals(del!.status, 200);
});

test("initialize, ping and tools/list answer the handshake a harness makes", async () => {
  const web = service({ search: searchBackend });
  const init = await (await web.dataHandler(request(rpc("initialize"))))!.json();
  assertEquals(init.result.serverInfo.name, "ryph-web");
  assert(init.result.instructions.includes("never instructions"));
  const ping = await (await web.dataHandler(request(rpc("ping"))))!.json();
  assertEquals(ping.result, {});
  const list = await (await web.dataHandler(request(rpc("tools/list"))))!.json();
  assertEquals(list.result.tools.map((t: { name: string }) => t.name), ["search", "fetch"]);
});

test("tools/list omits search when the deployment has no key", async () => {
  const list = await (await service().dataHandler(request(rpc("tools/list"))))!.json();
  assertEquals(list.result.tools.map((t: { name: string }) => t.name), ["fetch"]);
});

test("a fetch call goes the whole way through, and comes back framed", async () => {
  const res = await service().dataHandler(
    request(rpc("tools/call", { name: "fetch", arguments: { url: "https://example.com/x" } })),
  );
  const body = await res!.json();
  assertStringIncludes(body.result.content[0].text, "title: Doc");
  assertStringIncludes(body.result.content[0].text, "https://example.com/x");
});

test("search on a deployment without it is method-not-found, exactly as a misspelt tool is", async () => {
  // Indistinguishable on purpose, and this service's half of that: the gateway answers -32601
  // for a tool outside a run's allowlist, so a model must not be able to tell "not granted"
  // from "not offered here" from "no such tool".
  const web = service();
  const absent = await web.dataHandler(
    request(rpc("tools/call", { name: "search", arguments: { query: "x" } })),
  );
  const misspelt = await web.dataHandler(
    request(rpc("tools/call", { name: "serch", arguments: { query: "x" } })),
  );
  const absentBody = await absent!.json();
  assertEquals(absentBody.error.code, -32601);
  assertEquals((await misspelt!.json()).error.code, -32601);
  assertEquals(absent!.status, 200, "an error the model reads, not an HTTP failure");
});

test("a batch, a broken body and an unknown method are each refused in kind", async () => {
  const web = service();
  const batch = await web.dataHandler(request([rpc("ping")]));
  assertEquals((await batch!.json()).error.code, -32600);
  const broken = await web.dataHandler(
    new Request(`http://web.internal${MCP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, [RUN_ID_HEADER]: "run-1" },
      body: "{not json",
    }),
  );
  assertEquals((await broken!.json()).error.code, -32700);
  const unknown = await web.dataHandler(request(rpc("resources/list")));
  assertEquals((await unknown!.json()).error.code, -32601);
});

test("a notification is accepted and answers nothing", async () => {
  const res = await service().dataHandler(
    request({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assertEquals(res!.status, 202);
});

test("a body past the cap is refused before anything parses it", async () => {
  const res = await service().dataHandler(
    new Request(`http://web.internal${MCP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, [RUN_ID_HEADER]: "run-1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(300_000) }),
    }),
  );
  assertEquals(res!.status, 413);
});

test("paging a page with a second offset does not fetch or convert it again", async () => {
  const fetches: string[] = [];
  const web = service({ fetches });
  const call = (offset?: number) =>
    web.dataHandler(
      request(rpc("tools/call", {
        name: "fetch",
        arguments: { url: "https://example.com/long", ...(offset === undefined ? {} : { offset }) },
      })),
    );
  await call();
  await call(10);
  await call();
  assertEquals(fetches, ["https://example.com/long"], "one fetch for three reads of one page");
});

test("each tool call is logged at INFO with the run id and its argument", async () => {
  const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const recording: WebDiag = {
    debug: () => {},
    info: (event, fields) => {
      lines.push({ event, ...(fields === undefined ? {} : { fields }) });
    },
    warn: () => {},
  };
  const web = service({ diag: recording, search: searchBackend });
  await web.dataHandler(
    request(rpc("tools/call", { name: "fetch", arguments: { url: "https://example.com/p" } })),
  );
  await web.dataHandler(
    request(rpc("tools/call", { name: "search", arguments: { query: "how does x work" } })),
  );
  const fetched = lines.find((l) => l.event === "web.fetch");
  assertEquals(fetched?.fields?.runId, "run-1");
  assertEquals(fetched?.fields?.url, "https://example.com/p");
  const searched = lines.find((l) => l.event === "web.search");
  assertEquals(searched?.fields?.runId, "run-1");
  assertEquals(searched?.fields?.query, "how does x work");
});

test("readiness converts a page, and says so once per window", async () => {
  let conversions = 0;
  const web = setup({
    gatewayToken: TOKEN,
    search: null,
    policy,
    converter: {
      convert: (html, url) => {
        conversions++;
        return Promise.resolve(htmlToMarkdown(html, url));
      },
      close: () => {},
    },
    diag,
  });
  await web.ready();
  await web.ready();
  assertEquals(conversions, 1, "memoised — a probe every 5s must not cost a conversion each time");
  web.close();
});

test("a converter that refuses makes readiness fail, rather than a pod that answers nothing", async () => {
  const web = setup({
    gatewayToken: TOKEN,
    search: null,
    policy,
    converter: { convert: () => Promise.reject(new Error("no worker")), close: () => {} },
    diag,
  });
  let failed = false;
  await web.ready().catch(() => (failed = true));
  assert(failed, "an unusable conversion path is an unready replica");
});
