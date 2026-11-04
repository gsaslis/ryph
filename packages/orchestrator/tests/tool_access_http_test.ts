// `ToolAccess` over a standalone mcp-gateway. As with the model adapter, what these pin is the
// seam's error contract: which failures are a definitive answer and which mean "ask again".
// `fetch` is stubbed so the orchestrator's tests stay socket-free.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { httpToolAccess } from "../src/adapters/tool_access/http.ts";
import { silentDiagnostics } from "./doubles.ts";

interface Call {
  url: string;
  method?: string;
  auth: string | null;
  body?: string;
}

/** Runs `fn` with `fetch` answering from `reply`, and hands back what was asked. */
async function withFetch(
  reply: (call: Call) => Response | Promise<Response>,
  fn: (access: ReturnType<typeof httpToolAccess>, calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  }) as typeof fetch;
  try {
    await fn(
      httpToolAccess({
        // A trailing slash is tolerated, and every assertion below proves it was trimmed.
        gatewayControlUrl: "http://mcp-gateway.test/",
        gatewayToken: "gateway-token",
        diag: silentDiagnostics(),
      }),
      calls,
    );
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SERVER = { id: "ms-1", slug: "linear", name: "Linear", archivedAt: null };
const SCOPE = {
  runId: "run-1",
  servers: [{ serverId: "ms-1", allowedTools: ["search_issues"] as string[] | "*" }],
};
const CREDENTIALS = {
  token: "ryph-mcp-abc",
  servers: [{ slug: "linear", name: "Linear", url: "http://gw:7430/v1/mcp/run-1/linear" }],
};

test("getServer reads the internal lookup with the service token", async () => {
  await withFetch(() => json(200, SERVER), async (access, calls) => {
    assertEquals(await access.getServer("ms-1"), SERVER);
    assertEquals(calls[0].url, "http://mcp-gateway.test/internal/v1/mcp-servers/ms-1");
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].auth, "Bearer gateway-token");
  });
});

test("getServer path-encodes the id", async () => {
  await withFetch(() => json(404, { error: "no such server" }), async (access, calls) => {
    await access.getServer("ms/../secrets");
    assertEquals(
      calls[0].url,
      "http://mcp-gateway.test/internal/v1/mcp-servers/ms%2F..%2Fsecrets",
    );
  });
});

test("getServer answers null ONLY on 404", async () => {
  await withFetch(() => json(404, { error: "no such server" }), async (access) => {
    assertEquals(await access.getServer("ms-nope"), null);
  });
});

test("getServer throws when the gateway could not answer", async () => {
  // A user must never be told their server vanished because a service blinked: agent creation
  // reads this to validate a tool policy, and a 500 there is the honest outcome.
  for (const status of [401, 500, 502, 503]) {
    await withFetch(() => json(status, { error: "nope" }), async (access) => {
      await assertRejects(() => access.getServer("ms-1"), Error, "refused a server lookup");
    });
  }
  const original = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch;
  try {
    const access = httpToolAccess({
      gatewayControlUrl: "http://mcp-gateway.test",
      gatewayToken: "gateway-token",
      diag: silentDiagnostics(),
    });
    await assertRejects(() => access.getServer("ms-1"), Error, "mcp gateway unreachable");
  } finally {
    globalThis.fetch = original;
  }
});

test("getServer rejects a malformed answer rather than inventing a server", async () => {
  await withFetch(() => json(200, { id: "ms-1", name: "Linear" }), async (access) => {
    await assertRejects(() => access.getServer("ms-1"), Error, "malformed");
  });
});

test("issueRunCredentials posts the frozen scope and returns the credentials", async () => {
  await withFetch(() => json(200, CREDENTIALS), async (access, calls) => {
    assertEquals(await access.issueRunCredentials(SCOPE), CREDENTIALS);
    assertEquals(calls[0].url, "http://mcp-gateway.test/internal/v1/runs/run-1/mcp-credentials");
    assertEquals(calls[0].method, "POST");
    // The run id rides the path; the body is the scope alone.
    assertEquals(JSON.parse(calls[0].body!), { servers: SCOPE.servers });
  });
});

test("issueRunCredentials carries the gateway's reason into the thrown error", async () => {
  // The runner turns any throw into a retried 503 either way, so this message is the only place
  // the operator learns that the server was archived rather than the gateway being down.
  await withFetch(
    () => json(400, { error: 'server "linear" is archived' }),
    async (access) => {
      const err = await assertRejects(() => access.issueRunCredentials(SCOPE), Error);
      assert(err.message.includes("is archived"), err.message);
    },
  );
});

test("issueRunCredentials rejects a malformed credentials body", async () => {
  const cases: unknown[] = [
    {},
    { token: "", servers: [] },
    { token: "t" }, // no servers array
    { token: "t", servers: [{ slug: "linear" }] }, // a server missing its url
    { token: 42, servers: [] },
  ];
  for (const body of cases) {
    await withFetch(() => json(200, body), async (access) => {
      await assertRejects(() => access.issueRunCredentials(SCOPE), Error, "malformed");
    });
  }
});

test("revokeRunCredentials deletes, and surfaces a failure to its best-effort caller", async () => {
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.revokeRunCredentials("run-1");
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[0].url, "http://mcp-gateway.test/internal/v1/runs/run-1/mcp-credentials");
  });
  // Call sites already `.catch()` this one; a failed revoke leaves the TTL as the backstop.
  await withFetch(() => json(503, { error: "down" }), async (access) => {
    await assertRejects(() => access.revokeRunCredentials("run-1"), Error, "refused to revoke");
  });
});

test("archiveServer posts to the internal archive and passes the row through", async () => {
  const archived = { ...SERVER, archivedAt: "2026-11-04T00:00:00.000Z", kind: "remote" };
  await withFetch(() => json(200, archived), async (access, calls) => {
    assertEquals(await access.archiveServer("ms-1"), { kind: "archived", server: archived });
    assertEquals(calls[0].url, "http://mcp-gateway.test/internal/v1/mcp-servers/ms-1/archive");
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].auth, "Bearer gateway-token");
  });
});

test("archiveServer reads 404 as missing and a platform 409 as platform; anything else throws", async () => {
  await withFetch(() => json(404, { error: "no such server" }), async (access) => {
    assertEquals(await access.archiveServer("ms-nope"), { kind: "missing" });
  });
  await withFetch(
    () => json(409, { error: "platform", code: "platform_managed" }),
    async (access) => {
      assertEquals(await access.archiveServer("ms-platform-memory"), { kind: "platform" });
    },
  );
  for (const res of [() => json(503, { error: "db down" }), () => json(409, { error: "other" })]) {
    await withFetch(res, async (access) => {
      await assertRejects(() => access.archiveServer("ms-1"), Error, "refused to archive");
    });
  }
  await withFetch(() => json(200, { nope: true }), async (access) => {
    await assertRejects(() => access.archiveServer("ms-1"), Error, "malformed");
  });
});
