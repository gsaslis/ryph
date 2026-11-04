// `ModelAccess` over a standalone model-proxy. The whole point of this adapter is that the HTTP
// layer above it cannot tell it from the in-process one, so what these tests pin is the seam's
// error contract: which failures are a definitive answer and which mean "ask again". `fetch` is
// stubbed so the orchestrator's tests stay socket-free.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { httpModelAccess } from "../src/adapters/model_access/http.ts";
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
  fn: (access: ReturnType<typeof httpModelAccess>, calls: Call[]) => Promise<void>,
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
      httpModelAccess({
        // A trailing slash is tolerated, and every assertion below proves it was trimmed.
        modelProxyUrl: "http://model-proxy.test/",
        modelProxyToken: "proxy-token",
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

test("getKey reads the internal lookup with the service token", async () => {
  await withFetch(
    () =>
      json(200, {
        id: "pk-1",
        provider: "anthropic",
        dialect: "anthropic-messages",
        providerArchivedAt: null,
        archivedAt: null,
      }),
    async (access, calls) => {
      assertEquals(await access.getKey("pk-1"), {
        id: "pk-1",
        provider: "anthropic",
        dialect: "anthropic-messages",
        providerArchivedAt: null,
        archivedAt: null,
      });
      assertEquals(calls[0].url, "http://model-proxy.test/internal/v1/provider-keys/pk-1");
      assertEquals(calls[0].method, "GET");
      assertEquals(calls[0].auth, "Bearer proxy-token");
    },
  );
});

test("getKey path-encodes the id", async () => {
  await withFetch(() => json(404, { error: "no such provider key" }), async (access, calls) => {
    await access.getKey("pk/../secrets");
    assertEquals(
      calls[0].url,
      "http://model-proxy.test/internal/v1/provider-keys/pk%2F..%2Fsecrets",
    );
  });
});

test("getKey answers null ONLY on 404", async () => {
  await withFetch(() => json(404, { error: "no such provider key" }), async (access) => {
    assertEquals(await access.getKey("pk-nope"), null);
  });
});

test("getKey tells the ENDPOINT's archived state apart from the key's", async () => {
  // Two kill switches, one lookup: a live key against a withdrawn endpoint is the case the
  // policy check has to refuse, and it is invisible in the key's own archivedAt. A proxy that
  // sends neither field means neither is archived — the adapter must not invent a timestamp.
  await withFetch(
    () =>
      json(200, {
        id: "pk-cf",
        provider: "cloudflare-workers-ai",
        dialect: "openai-completions",
        providerArchivedAt: "2026-07-01T00:00:00.000Z",
        archivedAt: null,
      }),
    async (access) => {
      const key = await access.getKey("pk-cf");
      assertEquals(key?.providerArchivedAt, "2026-07-01T00:00:00.000Z");
      assertEquals(key?.archivedAt, null);
    },
  );
  await withFetch(
    () => json(200, { id: "pk-1", provider: "openai", dialect: "openai-completions" }),
    async (access) => {
      assertEquals((await access.getKey("pk-1"))?.providerArchivedAt, null);
    },
  );
});

test("getKey throws when the proxy could not answer", async () => {
  // A user must never be told their key vanished because a service blinked: agent creation
  // reads this to validate a model policy, and a 500 there is the honest outcome. 502 is in
  // this list deliberately — it is the proxy saying the KEY's provider resolves to nothing,
  // which is drift in the deployment's provider table and not a verdict on the key. Answering
  // null there would tell the user a working key disappeared.
  for (const status of [401, 500, 502, 503]) {
    await withFetch(() => json(status, { error: "nope" }), async (access) => {
      await assertRejects(() => access.getKey("pk-1"), Error, "refused a key lookup");
    });
  }
  const original = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch;
  try {
    const access = httpModelAccess({
      modelProxyUrl: "http://model-proxy.test",
      modelProxyToken: "proxy-token",
      diag: silentDiagnostics(),
    });
    await assertRejects(() => access.getKey("pk-1"), Error, "model proxy unreachable");
  } finally {
    globalThis.fetch = original;
  }
});

test("getKey rejects a malformed answer rather than inventing a key", async () => {
  const bodies: unknown[] = [
    { provider: "anthropic" },
    // No dialect at all, and a dialect this build has never heard of: both are malformed
    // rather than a maybe, because the harness check has nothing to fall back on.
    { id: "pk-1", provider: "anthropic", archivedAt: null },
    { id: "pk-1", provider: "anthropic", dialect: "google-gemini", archivedAt: null },
  ];
  for (const body of bodies) {
    await withFetch(() => json(200, body), async (access) => {
      await assertRejects(() => access.getKey("pk-1"), Error, "malformed");
    });
  }
});

test("issueRunCredentials posts the frozen scope and returns the env", async () => {
  await withFetch(
    () => json(200, { env: { ANTHROPIC_API_KEY: "ryph-vk-abc", ANTHROPIC_BASE_URL: "http://p" } }),
    async (access, calls) => {
      const env = await access.issueRunCredentials({
        runId: "run-1",
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: "pk-1",
        provider: "anthropic",
        allowedModels: ["claude-opus-5"],
        spendUsd: null,
        callsInFlight: null,
      });
      assertEquals(env, { ANTHROPIC_API_KEY: "ryph-vk-abc", ANTHROPIC_BASE_URL: "http://p" });
      assertEquals(calls[0].url, "http://model-proxy.test/internal/v1/runs/run-1/credentials");
      assertEquals(calls[0].method, "POST");
      // The run id rides the path; the body is the scope alone, caps included.
      assertEquals(JSON.parse(calls[0].body!), {
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: "pk-1",
        provider: "anthropic",
        allowedModels: ["claude-opus-5"],
        spendUsd: null,
        callsInFlight: null,
      });
    },
  );
});

test("issueRunCredentials carries the proxy's reason into the thrown error", async () => {
  // The runner turns any throw into a retried 503 either way, so this message is the only place
  // the operator learns that the key was archived rather than the proxy being down.
  await withFetch(
    () => json(400, { error: 'provider key "pk-1" is archived' }),
    async (access) => {
      const err = await assertRejects(
        () =>
          access.issueRunCredentials({
            runId: "run-1",
            agentId: "a-1",
            taskId: "t-1",
            providerKeyId: "pk-1",
            provider: "anthropic",
            allowedModels: "*",
            spendUsd: null,
            callsInFlight: null,
          }),
        Error,
      );
      assert(err.message.includes("is archived"), err.message);
    },
  );
});

test("issueRunCredentials rejects an env that is not all strings", async () => {
  const cases: Array<[unknown, string]> = [
    [{}, "malformed"],
    [{ env: null }, "malformed"],
    [{ env: ["a"] }, "malformed"],
    [{ env: { A: 1 } }, "not all strings"],
  ];
  for (const [body, message] of cases) {
    await withFetch(() => json(200, body), async (access) => {
      await assertRejects(
        () =>
          access.issueRunCredentials({
            runId: "run-1",
            agentId: "a-1",
            taskId: "t-1",
            providerKeyId: "pk-1",
            provider: "anthropic",
            allowedModels: "*",
            spendUsd: null,
            callsInFlight: null,
          }),
        Error,
        message,
      );
    });
  }
});

test("revokeRunCredentials deletes, and surfaces a failure to its best-effort caller", async () => {
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.revokeRunCredentials("run-1");
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[0].url, "http://model-proxy.test/internal/v1/runs/run-1/credentials");
  });
  // Call sites already `.catch()` this one; a failed revoke leaves the TTL as the backstop.
  await withFetch(() => json(503, { error: "down" }), async (access) => {
    await assertRejects(() => access.revokeRunCredentials("run-1"), Error, "refused to revoke");
  });
});

test("spendOf reads the run's priced total with the service token, and a failure throws", async () => {
  await withFetch(
    () => json(200, { runId: "run-1", spentUsd: 1.25, unpricedRequests: 0 }),
    async (access, calls) => {
      assertEquals(await access.spendOf("run-1"), 1.25);
      assertEquals(calls[0].url, "http://model-proxy.test/internal/v1/runs/run-1/spend");
      assertEquals(calls[0].auth, "Bearer proxy-token");
    },
  );
  // A proxy that is down is a could-not-ask, never "$0 spent": the sweep must not read it as
  // a run under its cap.
  await withFetch(
    () => json(503, { error: "database went away" }),
    async (access) => {
      await assertRejects(() => access.spendOf("run-1"), Error, "database went away");
    },
  );
  await withFetch(
    () => json(200, { spentUsd: "lots" }),
    async (access) => {
      await assertRejects(() => access.spendOf("run-1"), Error, "malformed");
    },
  );
});

test("ceilingReached reads the deployment gauge, and a failure throws", async () => {
  await withFetch(
    () => json(200, { reached: true, ceiling: { usd: 100, windowDays: 30 } }),
    async (access, calls) => {
      assertEquals(await access.ceilingReached(), true);
      assertEquals(calls[0].url, "http://model-proxy.test/internal/v1/spend-ceiling");
    },
  );
  await withFetch(
    () => json(500, { error: "boom" }),
    async (access) => {
      await assertRejects(() => access.ceilingReached(), Error, "boom");
    },
  );
});
