// The extension against a REAL MCP server — the SDK's server behind a fetch-shaped door, no
// sockets — and a fake pi that records what gets registered. Pins the contract the runner's pi
// adapter relies on: one file, `${VAR}` only, namespaced tool names, round-tripping calls, and
// a fatal (never silent) failure when the run cannot reach its tools.

import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CONFIG_DIR_ENV,
  CONFIG_FILE,
  makeExtension,
  mapContent,
  parseConfig,
  type PiApi,
  type PiToolDefinition,
  resolveHeaders,
  toolName,
} from "../index.ts";

const TOKEN = "ryph-mcp-virtual-1";

// The handful of SDK callback shapes these tests rely on, spelled out.
interface CallToolRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}

interface ListToolsRequest {
  params?: { cursor?: string };
}

/** One `tools/list` page per cursor, for a test that paginates. */
type ListPage = (cursor: string | undefined) => { tools: unknown[]; nextCursor?: string };

/**
 * An SDK server at `/v1/mcp/run-1/<slug>` that demands the virtual bearer, lists a few tools
 * (or the pages `listPage` answers), and answers `echo` with its own slug — so a call can be
 * traced to the server it reached.
 */
function makeUpstream(slug: string, listPage?: ListPage, expectedToken = TOKEN) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const authSeen: Array<string | null> = [];

  const makeServer = () => {
    const srv = new Server({ name: slug, version: "0.0.1" }, { capabilities: { tools: {} } });
    srv.setRequestHandler(
      ListToolsRequestSchema,
      (req: ListToolsRequest) =>
        Promise.resolve(
          listPage ? listPage(req.params?.cursor) : {
            tools: [
              {
                name: "echo",
                description: "Echoes text back.\nSecond line.",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
              { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
              { name: "picture", description: "An image.", inputSchema: { type: "object" } },
              { name: "dotted.name", inputSchema: { type: "object" } },
            ],
          },
        ),
    );
    srv.setRequestHandler(CallToolRequestSchema, (req: CallToolRequest) => {
      switch (req.params.name) {
        case "echo":
          return Promise.resolve({
            content: [{ type: "text", text: `${slug}:${req.params.arguments?.text}` }],
          });
        case "fail":
          return Promise.resolve({
            isError: true,
            content: [{ type: "text", text: "upstream said no" }],
          });
        case "picture":
          return Promise.resolve({
            content: [
              { type: "image", data: "aGk=", mimeType: "image/png" },
              { type: "resource", resource: { uri: "x://y", text: "r" } },
            ],
          });
        default:
          return Promise.resolve({ content: [{ type: "text", text: req.params.name }] });
      }
    });
    return srv;
  };

  const fetchLike = (async (input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(input instanceof URL ? input.href : input, init);
    authSeen.push(req.headers.get("authorization"));
    if (req.headers.get("authorization") !== `Bearer ${expectedToken}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const sid = req.headers.get("mcp-session-id");
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (req.method !== "POST") return new Response("no session", { status: 400 });
      const fresh = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, fresh);
        },
      });
      await makeServer().connect(fresh);
      transport = fresh;
    }
    return await transport.handleRequest(req);
  }) as typeof fetch;

  return {
    slug,
    url: `http://gw.test:7430/v1/mcp/run-1/${slug}`,
    fetch: fetchLike,
    authSeen,
    close: () => Promise.all([...sessions.values()].map((t) => t.close())),
  };
}

/** Routes each request to the upstream whose URL prefix it carries. */
function router(...upstreams: ReturnType<typeof makeUpstream>[]): typeof fetch {
  return ((input: URL | Request | string, init?: RequestInit) => {
    const href = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const target = upstreams.find((u) => href.startsWith(u.url));
    if (!target) return Promise.resolve(new Response("no such server", { status: 404 }));
    return target.fetch(input, init);
  }) as typeof fetch;
}

/** The slice of pi the extension touches, recording. */
function fakePi() {
  const tools = new Map<string, PiToolDefinition>();
  const handlers = new Map<string, () => Promise<void> | void>();
  const pi: PiApi = {
    registerTool: (t) => {
      tools.set(t.name, t);
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  return { pi, tools, handlers };
}

/** Writes `mcp.json` into a fresh config dir; returns the env that points at it. */
async function configDir(
  servers: Record<string, { url: string; headers?: Record<string, string> }>,
): Promise<{ env: Record<string, string>; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  await writeFile(`${dir}/${CONFIG_FILE}`, JSON.stringify({ mcpServers: servers }));
  return {
    env: { [CONFIG_DIR_ENV]: dir, MCP_GATEWAY_TOKEN: TOKEN },
    cleanup: () => rm(dir, { recursive: true }),
  };
}

const bearerRef = { Authorization: "Bearer ${MCP_GATEWAY_TOKEN}" };
const throwing = (message: string): never => {
  throw new Error(message);
};

test("registers every listed tool under <slug>__<name>, with the server's schema and description", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi, tools, handlers } = fakePi();
  const notes: string[] = [];
  try {
    await makeExtension({
      env: cfg.env,
      fetch: linear.fetch,
      fatal: throwing,
      note: (m) => notes.push(m),
    })(pi);

    // the line the runner's pi adapter looks for: proof the extension loaded at all, which
    // nothing else about a tool-enabled run would show
    assertEquals(notes, ["ready — 4 tool(s) from 1 server(s)"]);

    assertEquals(
      [...tools.keys()].sort(),
      [toolName("linear", "dotted.name"), "linear__echo", "linear__fail", "linear__picture"],
    );
    const echo = tools.get("linear__echo")!;
    assertEquals(echo.label, "linear: echo");
    assertEquals(echo.description, "Echoes text back.\nSecond line.");
    assertEquals(echo.promptSnippet, "linear__echo — Echoes text back.");
    assertEquals(echo.parameters, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    // a tool with no description still gets one the model can read
    assertEquals(
      tools.get(toolName("linear", "dotted.name"))!.description,
      "dotted.name on linear",
    );

    // the call round-trips under the REMOTE name, with the bearer, and maps the content
    const result = await echo.execute("c1", { text: "hi" }, undefined);
    assertEquals(result.content, [{ type: "text", text: "linear:hi" }]);
    assertEquals(result.details, { server: "linear", tool: "echo" });
    assert(linear.authSeen.every((a) => a === `Bearer ${TOKEN}`));

    assert(handlers.has("session_shutdown"), "a shutdown handler closes the clients");
    await handlers.get("session_shutdown")!();
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("an isError result becomes a thrown error carrying the server's text", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({ env: cfg.env, fetch: linear.fetch, fatal: throwing })(pi);
    const err = await assertRejects(
      () => tools.get("linear__fail")!.execute("c2", {}, undefined),
      Error,
    );
    assertEquals(err.message, "upstream said no");
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("images pass through; other content blocks are described as text", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({ env: cfg.env, fetch: linear.fetch, fatal: throwing })(pi);
    const result = await tools.get("linear__picture")!.execute("c3", {}, undefined);
    assertEquals(result.content[0], { type: "image", data: "aGk=", mimeType: "image/png" });
    assertEquals(result.content[1].type, "text");
    assertStringIncludes((result.content[1] as { text: string }).text, "x://y");
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("two servers exposing the same tool name cannot shadow each other", async () => {
  const linear = makeUpstream("linear");
  const github = makeUpstream("github");
  const cfg = await configDir({
    linear: { url: linear.url, headers: bearerRef },
    github: { url: github.url, headers: bearerRef },
  });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({ env: cfg.env, fetch: router(linear, github), fatal: throwing })(pi);
    const a = await tools.get("linear__echo")!.execute("c4", { text: "x" }, undefined);
    const b = await tools.get("github__echo")!.execute("c5", { text: "x" }, undefined);
    assertEquals(a.content, [{ type: "text", text: "linear:x" }]);
    assertEquals(b.content, [{ type: "text", text: "github:x" }]);
  } finally {
    await Promise.all([linear.close(), github.close()]);
    await cfg.cleanup();
  }
});

test("tools/list is read to its last page, past a page the gateway filtered empty", async () => {
  const pages: Record<string, { tools: unknown[]; nextCursor?: string }> = {
    "": { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "p2" },
    p2: { tools: [], nextCursor: "p3" },
    p3: { tools: [{ name: "fail", inputSchema: { type: "object" } }] },
  };
  const linear = makeUpstream("linear", (cursor) => pages[cursor ?? ""]);
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({ env: cfg.env, fetch: linear.fetch, fatal: throwing })(pi);
    assertEquals([...tools.keys()].sort(), ["linear__echo", "linear__fail"]);
    // a tool from a later page calls through like any other
    const err = await assertRejects(
      () => tools.get("linear__fail")!.execute("c6", {}, undefined),
      Error,
    );
    assertEquals(err.message, "upstream said no");
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("a cursor that repeats, or a list that never ends, is fatal — never a prefix of the tools", async () => {
  const page = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  for (
    const [listPage, expected] of [
      [() => ({ ...page, nextCursor: "again" }), "repeated a cursor"],
      [(cursor) => ({ ...page, nextCursor: `${Number(cursor ?? 0) + 1}` }), "had not ended"],
    ] as Array<[ListPage, string]>
  ) {
    const linear = makeUpstream("linear", listPage);
    const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
    const { pi, tools } = fakePi();
    try {
      const err = await assertRejects(
        () => makeExtension({ env: cfg.env, fetch: linear.fetch, fatal: throwing })(pi),
        Error,
      );
      assertStringIncludes(err.message, '"linear"');
      assertStringIncludes(err.message, expected);
      assertEquals(tools.size, 0);
    } finally {
      await linear.close();
      await cfg.cleanup();
    }
  }
});

test("a tool the server lists twice is fatal, never a silently dropped tool", async () => {
  const twice = {
    tools: [{ name: "echo", inputSchema: { type: "object" } }, {
      name: "echo",
      inputSchema: { type: "object" },
    }],
  };
  const linear = makeUpstream("linear", () => twice);
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi } = fakePi();
  try {
    const err = await assertRejects(
      () => makeExtension({ env: cfg.env, fetch: linear.fetch, fatal: throwing })(pi),
      Error,
    );
    assertStringIncludes(err.message, '"linear"');
    assertStringIncludes(err.message, '"echo"');
    assertStringIncludes(err.message, "twice");
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("each server's ${VAR} resolves on its own: the runner's loopback token beside the gateway's", async () => {
  // The runner's own tool server rides mcp.json under `ryph` with a second env reference; the
  // gateway's token must never be sent there, nor the loopback's to the gateway.
  const linear = makeUpstream("linear");
  const ryph = makeUpstream("ryph", undefined, "loop-1");
  const cfg = await configDir({
    linear: { url: linear.url, headers: bearerRef },
    ryph: { url: ryph.url, headers: { Authorization: "Bearer ${MCP_LOOPBACK_TOKEN}" } },
  });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({
      env: { ...cfg.env, MCP_LOOPBACK_TOKEN: "loop-1" },
      fetch: router(linear, ryph),
      fatal: throwing,
    })(pi);
    const a = await tools.get("linear__echo")!.execute("c1", { text: "x" }, undefined);
    const b = await tools.get("ryph__echo")!.execute("c2", { text: "y" }, undefined);
    assertEquals(a.content, [{ type: "text", text: "linear:x" }]);
    assertEquals(b.content, [{ type: "text", text: "ryph:y" }]);
    assert(linear.authSeen.every((h) => h === `Bearer ${TOKEN}`));
    assert(ryph.authSeen.every((h) => h === "Bearer loop-1"));

    // the loopback's variable unset: fatal by that name, and the loopback never dialed
    const { pi: pi2 } = fakePi();
    const err = await assertRejects(
      () => makeExtension({ env: cfg.env, fetch: router(linear, ryph), fatal: throwing })(pi2),
      Error,
    );
    assertStringIncludes(err.message, "MCP_LOOPBACK_TOKEN");
    assertStringIncludes(err.message, '"ryph"');
  } finally {
    await Promise.all([linear.close(), ryph.close()]);
    await cfg.cleanup();
  }
});

test("an unset ${VAR} is fatal by variable name, and the server is never dialed", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi } = fakePi();
  const { MCP_GATEWAY_TOKEN: _dropped, ...env } = cfg.env;
  try {
    const err = await assertRejects(
      () => makeExtension({ env, fetch: linear.fetch, fatal: throwing })(pi),
      Error,
    );
    assertStringIncludes(err.message, "MCP_GATEWAY_TOKEN");
    assertStringIncludes(err.message, '"linear"');
    assertEquals(linear.authSeen, []);
  } finally {
    await cfg.cleanup();
  }
});

test("a refused connection is fatal, naming the server and its host but never the token", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi } = fakePi();
  try {
    const err = await assertRejects(
      () =>
        makeExtension({
          env: { ...cfg.env, MCP_GATEWAY_TOKEN: "forged" },
          fetch: linear.fetch,
          fatal: throwing,
        })(pi),
      Error,
    );
    assertStringIncludes(err.message, '"linear"');
    assertStringIncludes(err.message, "gw.test:7430");
    assert(!err.message.includes("forged"), err.message);
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

/**
 * A door in front of `upstream` that may answer a request itself: `answer` sees each request's
 * index and JSON-RPC method (`""` for anything without one) and returns a Response, throws, or
 * returns undefined to let it through.
 */
function door(
  upstream: ReturnType<typeof makeUpstream>,
  answer: (index: number, method: string) => Response | Promise<Response> | undefined,
) {
  let index = 0;
  const methods: string[] = [];
  const fetchLike = (async (input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(input instanceof URL ? input.href : input, init);
    let method = "";
    if (req.method === "POST") {
      try {
        method = ((await req.clone().json()) as { method?: string }).method ?? "";
      } catch {
        // not JSON-RPC
      }
    }
    methods.push(method);
    const own = answer(index++, method);
    return own ?? upstream.fetch(req);
  }) as typeof fetch;
  return { fetch: fetchLike, methods };
}

const guard502 = () =>
  Response.json({ error: "the hosted server did not answer" }, { status: 502 });

/** A fake clock: `sleep` records the wait and moves time on by it, and so does `advance`. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => void (t += ms),
    slept,
  };
}

/** Runs the extension against one upstream behind `fetch`, on `clock`, and returns the outcome. */
async function startWith(
  fetchLike: typeof fetch,
  upstream: ReturnType<typeof makeUpstream>,
  extra: { clock?: ReturnType<typeof fakeClock>; connectRetryMs?: number } = {},
) {
  const cfg = await configDir({ [upstream.slug]: { url: upstream.url, headers: bearerRef } });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({
      env: cfg.env,
      fetch: fetchLike,
      fatal: throwing,
      note: () => {},
      ...(extra.clock ? { now: extra.clock.now, sleep: extra.clock.sleep } : {}),
      ...(extra.connectRetryMs !== undefined ? { connectRetryMs: extra.connectRetryMs } : {}),
    })(pi);
    return { tools, error: undefined };
  } catch (err) {
    return { tools, error: err as Error };
  } finally {
    await upstream.close();
    await cfg.cleanup();
  }
}

test("a server the tool guard cannot reach yet is retried with backoff, then connects", async () => {
  // what a node scale-down looks like from a run: the hosted pod is being replaced, and the tool
  // guard's 502 comes back through the gateway until the new one is up
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, (i) => (i < 3 ? guard502() : undefined));
  const { tools, error } = await startWith(d.fetch, linear, { clock });

  assertEquals(error, undefined);
  assertEquals(clock.slept, [250, 500, 1000]);
  assert(tools.has("linear__echo"));
});

test("the gateway's own 'upstream unreachable', a 503 and a 504 are retried too", async () => {
  for (
    const fail of [
      () => Response.json({ error: "upstream unreachable" }, { status: 502 }),
      () => new Response("busy", { status: 503 }),
      () => new Response("slow", { status: 504 }),
    ]
  ) {
    const linear = makeUpstream("linear");
    const clock = fakeClock();
    const d = door(linear, (i) => (i < 1 ? fail() : undefined));
    const { tools, error } = await startWith(d.fetch, linear, { clock });
    assertEquals(error, undefined);
    assertEquals(clock.slept, [250]);
    assert(tools.has("linear__echo"));
  }
});

test("a 502 that is the gateway refusing is fatal at once, never retried", async () => {
  for (
    const body of [
      "upstream refused by gateway policy",
      "this platform server is not configured on this deployment",
      "the upstream rejected the gateway's credential",
    ]
  ) {
    const linear = makeUpstream("linear");
    const clock = fakeClock();
    const d = door(linear, () => Response.json({ error: body }, { status: 502 }));
    const { error } = await startWith(d.fetch, linear, { clock });
    assertStringIncludes(error?.message ?? "", body);
    assertEquals(clock.slept, []);
  }
});

test("a hosted server relaunching or starting is waited out; one with nothing coming is fatal at once", async () => {
  for (const code of ["hosted_stale", "hosted_starting"]) {
    const linear = makeUpstream("linear");
    const clock = fakeClock();
    const d = door(
      linear,
      (
        i,
      ) => (i < 1
        ? Response.json({ error: "try again shortly", code }, { status: 503 })
        : undefined),
    );
    const { tools, error } = await startWith(d.fetch, linear, { clock });
    assertEquals(error, undefined, code);
    assertEquals(clock.slept, [250]);
    assert(tools.has("linear__echo"));
  }
  for (const status of [502, 503]) {
    const linear = makeUpstream("linear");
    const clock = fakeClock();
    const body = "this server has no running container on this gateway: hosting is off";
    const d = door(
      linear,
      () => Response.json({ error: body, code: "hosted_not_running" }, { status }),
    );
    const { error } = await startWith(d.fetch, linear, { clock });
    assertStringIncludes(error?.message ?? "", body);
    assertEquals(clock.slept, [], `${status} is not waited on`);
  }
});

test("no answer at all is retried, under Deno's wording and under Node's", async () => {
  for (
    const thrown of [
      () =>
        new TypeError("error sending request for url (http://gw.test:7430/): connection refused"),
      () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    ]
  ) {
    const linear = makeUpstream("linear");
    const clock = fakeClock();
    const d = door(linear, (i) => {
      if (i < 1) throw thrown();
      return undefined;
    });
    const { tools, error } = await startWith(d.fetch, linear, { clock });
    assertEquals(error, undefined);
    assertEquals(clock.slept, [250]);
    assert(tools.has("linear__echo"));
  }
});

test("a TypeError that is not about the network is fatal at once", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, () => {
    throw new TypeError("Headers.append: invalid header value");
  });
  const { error } = await startWith(d.fetch, linear, { clock });
  assertStringIncludes(error?.message ?? "", "invalid header value");
  assertEquals(clock.slept, []);
});

test("a server still unreachable when the window closes is fatal, naming Node's hidden cause", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  const { error } = await startWith(d.fetch, linear, { clock, connectRetryMs: 10_000 });

  assertStringIncludes(error?.message ?? "", '"linear"');
  assertStringIncludes(error?.message ?? "", "is unreachable: fetch failed (ECONNREFUSED)");
  // 250 + 500 + 1000 + 2000 + 4000 = 7750 ms; the last wait is cut to 1250 so one more attempt
  // starts with the 1 s an attempt needs, and after it there is no room left
  assertEquals(clock.slept, [250, 500, 1000, 2000, 4000, 1250]);
});

test("the window is wall clock: an upstream slow to say 502 uses it up, not just the waits", async () => {
  // the gateway gives a silent upstream 30 s before it answers 502; three of those used to
  // cost three times that plus the waits
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, () => {
    clock.advance(20_000);
    return guard502();
  });
  const { error } = await startWith(d.fetch, linear, { clock });

  assertStringIncludes(error?.message ?? "", "the hosted server did not answer");
  // attempts end at 20 s, 40.25 s and 60.75 s; the third is past the 60 s window
  assertEquals(clock.slept, [250, 500]);
  assertEquals(d.methods.filter((m) => m === "initialize").length, 3);
  assert(clock.now() < 61_000, `took ${clock.now()} ms`);
});

test("an attempt that never answers is cut off when the window closes", async () => {
  const linear = makeUpstream("linear");
  const d = door(linear, () => new Promise<Response>(() => {}));
  const started = Date.now();
  const { error } = await startWith(d.fetch, linear, { connectRetryMs: 200 });

  assertStringIncludes(error?.message ?? "", "is unreachable: did not answer within 0.2 s");
  assert(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("an attempt the window cuts off reports what the server said before it", async () => {
  // a server answering 502 at once, then hanging: the fatal must name the 502, not the cut-off
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, (i) => (i < 1 ? guard502() : new Promise<Response>(() => {})));
  const { error } = await startWith(d.fetch, linear, { clock, connectRetryMs: 1_400 });

  assertStringIncludes(error?.message ?? "", "is unreachable");
  assertStringIncludes(error?.message ?? "", "the hosted server did not answer");
  assert(!error?.message.includes("did not answer within"), error?.message);
  assertEquals(clock.slept, [250]);
});

test("each attempt only gets what is left of the window, not a window of its own", async () => {
  // the first answer comes at 1.5 s of a 3 s window; the hanging second attempt must be cut at
  // the 3 s mark, not allowed a window of its own
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, (i) => {
    if (i > 0) return new Promise<Response>(() => {});
    clock.advance(1_500);
    return guard502();
  });
  const started = Date.now();
  const { error } = await startWith(d.fetch, linear, { clock, connectRetryMs: 3_000 });

  assertStringIncludes(
    error?.message ?? "",
    'the hosted server did not answer"} (after 2 attempts)',
  );
  assert(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
});

test("a tool list that never ends is cut off and named as the list, not the connect", async () => {
  const linear = makeUpstream("linear");
  const d = door(
    linear,
    (_, method) => method === "tools/list" ? new Promise<Response>(() => {}) : undefined,
  );
  const { error } = await startWith(d.fetch, linear, { connectRetryMs: 300 });

  assertStringIncludes(
    error?.message ?? "",
    'server "linear" at gw.test:7430 could not list its tools: did not answer within 0.3 s',
  );
});

test("the wait between attempts stops growing at 4 s", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const { error } = await startWith(door(linear, guard502).fetch, linear, {
    clock,
    connectRetryMs: 30_000,
  });

  assertStringIncludes(error?.message ?? "", "attempts)");
  assertEquals(clock.slept.slice(0, 7), [250, 500, 1000, 2000, 4000, 4000, 4000]);
});

test("a fetch failure that is not a socket error is fatal at once", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, () => {
    throw new TypeError("fetch failed", { cause: { code: "ERR_INVALID_URL" } });
  });
  const { error } = await startWith(d.fetch, linear, { clock });

  assertStringIncludes(error?.message ?? "", "fetch failed (ERR_INVALID_URL)");
  assert(!error?.message.includes("attempts"), error?.message);
  assertEquals(clock.slept, []);
});

test("every attempt is a fresh client: a 502 after initialize still initializes again", async () => {
  // the SDK refuses to start a closed transport again, so an attempt that reused one would fail
  // for good; and a client that skipped initialize would go on with no session
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  let failed = false;
  const d = door(linear, (_, method) => {
    if (method === "notifications/initialized" && !failed) {
      failed = true;
      return guard502();
    }
    return undefined;
  });
  const { tools, error } = await startWith(d.fetch, linear, { clock });

  assertEquals(error, undefined);
  assertEquals(d.methods.filter((m) => m === "initialize").length, 2);
  assert(tools.has("linear__echo"));
});

test("a tool list cut short by the same gap is retried with the connect", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  let failed = false;
  const d = door(linear, (_, method) => {
    if (method === "tools/list" && !failed) {
      failed = true;
      return guard502();
    }
    return undefined;
  });
  const { tools, error } = await startWith(d.fetch, linear, { clock });

  assertEquals(error, undefined);
  assertEquals(clock.slept, [250]);
  assert(tools.has("linear__echo"));
});

test("a refusal after a retry is fatal at once, with the refusal's own answer", async () => {
  const linear = makeUpstream("linear");
  const clock = fakeClock();
  const d = door(linear, (i) => (i < 1 ? guard502() : undefined));
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi } = fakePi();
  try {
    const err = await assertRejects(
      () =>
        makeExtension({
          env: { ...cfg.env, MCP_GATEWAY_TOKEN: "forged" },
          fetch: d.fetch,
          fatal: throwing,
          now: clock.now,
          sleep: clock.sleep,
        })(pi),
      Error,
    );
    assert(!err.message.includes("hosted server did not answer"), err.message);
    assert(!err.message.includes("forged"), err.message);
    assertEquals(clock.slept, [250]);
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("a server listed after one that retried still registers, and no fatal names the token", async () => {
  const linear = makeUpstream("linear");
  const github = makeUpstream("github");
  const clock = fakeClock();
  const flakyLinear = door(linear, (i) => (i < 2 ? guard502() : undefined));
  const cfg = await configDir({
    linear: { url: linear.url, headers: bearerRef },
    github: { url: github.url, headers: bearerRef },
  });
  const { pi, tools } = fakePi();
  try {
    await makeExtension({
      env: cfg.env,
      fetch: ((input: URL | Request | string, init?: RequestInit) => {
        const href = input instanceof URL
          ? input.href
          : input instanceof Request
          ? input.url
          : input;
        return href.startsWith(linear.url)
          ? flakyLinear.fetch(input, init)
          : github.fetch(input, init);
      }) as typeof fetch,
      fatal: throwing,
      note: () => {},
      now: clock.now,
      sleep: clock.sleep,
    })(pi);
    assert(tools.has("linear__echo"));
    assert(tools.has("github__echo"));
    assertEquals(clock.slept, [250, 500]);
  } finally {
    await linear.close();
    await github.close();
    await cfg.cleanup();
  }

  // and when the window closes, the fatal names the server and host, never the token
  const down = makeUpstream("linear");
  const { error } = await startWith(door(down, guard502).fetch, down, {
    clock: fakeClock(),
    connectRetryMs: 1_000,
  });
  assertStringIncludes(error?.message ?? "", "gw.test:7430");
  assert(!error?.message.includes(TOKEN), error?.message);
});

test("the default wait really waits", async () => {
  const linear = makeUpstream("linear");
  const d = door(linear, (i) => (i < 1 ? guard502() : undefined));
  const started = Date.now();
  const { tools, error } = await startWith(d.fetch, linear);

  assertEquals(error, undefined);
  assert(Date.now() - started >= 250, `took ${Date.now() - started} ms`);
  assert(tools.has("linear__echo"));
});

test("a refusal is fatal at once, never retried", async () => {
  const linear = makeUpstream("linear");
  const cfg = await configDir({ linear: { url: linear.url, headers: bearerRef } });
  const { pi } = fakePi();
  const clock = fakeClock();
  try {
    await assertRejects(
      () =>
        makeExtension({
          env: { ...cfg.env, MCP_GATEWAY_TOKEN: "forged" },
          fetch: linear.fetch,
          fatal: throwing,
          now: clock.now,
          sleep: clock.sleep,
        })(pi),
      Error,
    );
    assertEquals(clock.slept, []);
  } finally {
    await linear.close();
    await cfg.cleanup();
  }
});

test("no config dir, no file, or a malformed file is fatal, each named", async () => {
  const { pi } = fakePi();
  const noDir = await assertRejects(
    () => makeExtension({ env: {}, fatal: throwing })(pi),
    Error,
  );
  assertStringIncludes(noDir.message, CONFIG_DIR_ENV);

  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  try {
    const noFile = await assertRejects(
      () => makeExtension({ env: { [CONFIG_DIR_ENV]: dir }, fatal: throwing })(pi),
      Error,
    );
    assertStringIncludes(noFile.message, `${dir}/${CONFIG_FILE}`);

    await writeFile(`${dir}/${CONFIG_FILE}`, "{ not json");
    const notJson = await assertRejects(
      () => makeExtension({ env: { [CONFIG_DIR_ENV]: dir }, fatal: throwing })(pi),
      Error,
    );
    assertStringIncludes(notJson.message, "not JSON");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the default fatal writes one stderr line and exits 1 — never a silent, toolless run", async () => {
  // The production instance, driven from a child process so its exit can be observed.
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  const drive = new URL("./fixtures/fatal_drive.ts", import.meta.url).pathname;
  try {
    const { status, stdout, stderr } = spawnSync(process.execPath, ["--no-env-file", drive], {
      env: { ...process.env, [CONFIG_DIR_ENV]: dir }, // a dir with no mcp.json in it
      encoding: "utf8",
    });
    assertEquals(status, 1);
    assertEquals(stdout, "");
    assertStringIncludes(stderr, "ryph pi-mcp: cannot read");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("parseConfig: exactly { mcpServers: { slug: { url, headers? } } }, errors by slug", () => {
  assertEquals(parseConfig({ mcpServers: { a: { url: "http://x/" } } }), {
    mcpServers: { a: { url: "http://x/" } },
  });
  for (
    const [bad, expected] of [
      [{}, 'expected { "mcpServers"'],
      [{ mcpServers: { a: {} } }, 'server "a" needs a string "url"'],
      [{ mcpServers: { a: { url: "nope" } } }, 'server "a" has an invalid url'],
      [{ mcpServers: { a: { url: "http://x/", headers: "h" } } }, "headers must be an object"],
      [
        { mcpServers: { a: { url: "http://x/", headers: { h: 1 } } } },
        'header "h" must be a string',
      ],
    ] as Array<[unknown, string]>
  ) {
    let message = "";
    try {
      parseConfig(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, expected);
  }
});

test("resolveHeaders: ${VAR} anywhere in a value, nothing else expanded, unset is an error", () => {
  const env = { TOK: "t1", OTHER: "o" };
  assertEquals(
    resolveHeaders({ Authorization: "Bearer ${TOK}", "X-Plain": "$TOK ${OTHER}!" }, env, "s"),
    { Authorization: "Bearer t1", "X-Plain": "$TOK o!" },
  );
  let message = "";
  try {
    resolveHeaders({ Authorization: "Bearer ${MISSING}" }, env, "s");
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "MISSING");
  assertStringIncludes(message, '"Authorization"');
});

test("toolName: every remote name gets a provider-safe, bounded name, and distinct ones stay distinct", () => {
  const safe = /^[A-Za-z0-9_-]{1,64}$/;
  // already safe and short: unchanged, so the common case stays readable
  assertEquals(toolName("linear", "create_issue"), "linear__create_issue");
  assertEquals(toolName("linear", "issues_list"), "linear__issues_list");
  assertEquals(toolName("linear", "a".repeat(56)), "linear__" + "a".repeat(56));

  // names that fold alike keep apart by the hash
  const dotted = toolName("linear", "issues.list");
  assertMatch(dotted, /^linear__issues_list_[0-9a-f]{8}$/);
  assertNotEquals(dotted, toolName("linear", "issues_list"));
  assertNotEquals(dotted, toolName("linear", "issues/list"));
  assertEquals(toolName("linear", "issues.list"), dotted, "deterministic across runs");

  // a plain name that already READS like a rewritten one is rewritten too — otherwise a short
  // rewritten name and a plain name spell the same string, and one of the two tools is lost
  const folds = toolName("a", "x.y");
  const looksRewritten = toolName("a", "x_y_b24ca9b7");
  assertMatch(looksRewritten, /^a__x_y_b24ca9b7_[0-9a-f]{8}$/);
  assertNotEquals(folds, looksRewritten);
  for (const name of [folds, looksRewritten]) assertMatch(name, safe);

  // the longest slug and a 128-char remote name fit; names that clip alike stay distinct
  const slug = "s".repeat(39);
  const a = toolName(slug, "a".repeat(127) + "x");
  const b = toolName(slug, "a".repeat(127) + "y");
  const justOver = toolName("linear", "a".repeat(57));
  for (const name of [dotted, a, b, justOver]) assertMatch(name, safe);
  assertNotEquals(a, b);
  assertEquals(justOver.length, 64);
});

test("mapContent: empty or absent content still tells the model something", () => {
  assertEquals(mapContent(undefined), [{ type: "text", text: "(no content)" }]);
  assertEquals(mapContent([]), [{ type: "text", text: "(no content)" }]);
  assertEquals(mapContent([{ type: "text", text: "a" }, { type: "audio", data: "x" }]), [
    { type: "text", text: "a" },
    { type: "text", text: '{"type":"audio","data":"x"}' },
  ]);
});
