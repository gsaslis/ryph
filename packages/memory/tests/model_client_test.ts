// The proxy model client: all three dialects, a custom endpoint routed by its dialect alone, the
// credential cache, and the one re-mint on a 401.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { proxyModelClient } from "../src/adapters/model/proxy.ts";
import type { PlatformCredential } from "../src/ports/model.ts";

const silent = { warn() {} };

function credential(overrides: Partial<PlatformCredential> = {}): PlatformCredential {
  return {
    token: "ryph-vk-1",
    provider: "anthropic",
    dialect: "anthropic-messages",
    model: "claude-sonnet-5",
    allowedModels: "*",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    basePath: "",
    ...overrides,
  };
}

function fakeFetch(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const bodies: unknown[] = [];
  const f = (async (input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    seen.push(req);
    bodies.push(JSON.parse(await req.clone().text()));
    return await handler(req);
  }) as unknown as typeof fetch;
  return { fetch: f, seen, bodies };
}

test("anthropic: messages endpoint, x-api-key, text joined; the credential is minted once", async () => {
  let mints = 0;
  const upstream = fakeFetch(() =>
    Response.json({ content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }] })
  );
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test/",
    credentials: () => {
      mints += 1;
      return Promise.resolve(credential());
    },
    fetch: upstream.fetch,
    diag: silent,
  });
  const req = { system: "sys", prompt: "hi", maxTokens: 10 };
  assertEquals(await client.complete(req), "Hello");
  assertEquals(await client.complete(req), "Hello");
  assertEquals(mints, 1);
  assertEquals(upstream.seen[0].url, "http://proxy.test/v1/messages");
  assertEquals(upstream.seen[0].headers.get("x-api-key"), "ryph-vk-1");
  assertEquals(upstream.bodies[0], {
    model: "claude-sonnet-5",
    max_tokens: 10,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  });
});

test("openai: the Responses API under /v1, unstored, text gathered off the output items", async () => {
  const upstream = fakeFetch(() =>
    Response.json({
      object: "response",
      output: [
        // A reasoning item carries no text of its own and is passed over.
        { type: "reasoning", id: "rs_1", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hel" }, { type: "output_text", text: "lo" }],
        },
      ],
    })
  );
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(credential({
        provider: "openai",
        dialect: "openai-responses",
        model: "gpt-5",
        basePath: "/v1",
      })),
    fetch: upstream.fetch,
    diag: silent,
  });
  assertEquals(await client.complete({ system: "sys", prompt: "hi", maxTokens: 50 }), "Hello");
  assertEquals(upstream.seen[0].url, "http://proxy.test/v1/responses");
  assertEquals(upstream.seen[0].headers.get("authorization"), "Bearer ryph-vk-1");
  assertEquals(upstream.bodies[0], {
    model: "gpt-5",
    instructions: "sys",
    input: "hi",
    max_output_tokens: 50,
    store: false,
  });

  // Only reasoning came back (the budget ran out before any text): no text, said as such.
  const silentModel = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(credential({ dialect: "openai-responses", basePath: "/v1" })),
    fetch: fakeFetch(() =>
      Response.json({ status: "incomplete", output: [{ type: "reasoning", summary: [] }] })
    ).fetch,
    diag: silent,
  });
  await assertRejects(
    () => silentModel.complete({ system: "s", prompt: "p", maxTokens: 5 }),
    Error,
    "no text",
  );
});

test("openai: chat completions under /v1, bearer, and the policy's allowlist is honoured", async () => {
  const upstream = fakeFetch(() => Response.json({ choices: [{ message: { content: "yo" } }] }));
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(credential({
        provider: "openai",
        dialect: "openai-completions",
        model: "gpt-5",
        basePath: "/v1",
        allowedModels: ["gpt-5"],
      })),
    fetch: upstream.fetch,
    diag: silent,
  });
  assertEquals(await client.complete({ system: "s", prompt: "p", maxTokens: 5 }), "yo");
  assertEquals(upstream.seen[0].url, "http://proxy.test/v1/chat/completions");
  assertEquals(upstream.seen[0].headers.get("authorization"), "Bearer ryph-vk-1");

  const outside = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(
        credential({
          provider: "openai",
          dialect: "openai-completions",
          basePath: "/v1",
          allowedModels: ["gpt-5"],
        }),
      ),
    model: "gpt-4o",
    fetch: upstream.fetch,
    diag: silent,
  });
  await assertRejects(
    () => outside.complete({ system: "s", prompt: "p", maxTokens: 5 }),
    Error,
    "outside the platform policy",
  );
});

test("a custom endpoint is dialed on its dialect alone, whatever its slug", async () => {
  const upstream = fakeFetch(() => Response.json({ choices: [{ message: { content: "hi" } }] }));
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(credential({
        // A slug this package has never heard of, and never has to: the dialect is the switch.
        provider: "cloudflare",
        dialect: "openai-completions",
        model: "@cf/meta/llama-4",
        basePath: "/v1",
        allowedModels: ["@cf/meta/llama-4"],
      })),
    fetch: upstream.fetch,
    diag: silent,
  });
  assertEquals(await client.complete({ system: "s", prompt: "p", maxTokens: 5 }), "hi");
  assertEquals(upstream.seen[0].url, "http://proxy.test/v1/chat/completions");
  assertEquals(upstream.seen[0].headers.get("authorization"), "Bearer ryph-vk-1");
  assertEquals((upstream.bodies[0] as { model: string }).model, "@cf/meta/llama-4");
});

test("a dialect nobody here speaks is refused by name", async () => {
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(
        credential({ dialect: "gemini-generate" as PlatformCredential["dialect"] }),
      ),
    fetch: fakeFetch(() => Response.json({})).fetch,
    diag: silent,
  });
  await assertRejects(
    () => client.complete({ system: "s", prompt: "p", maxTokens: 5 }),
    Error,
    'no dialect "gemini-generate"',
  );
});

test("a 401 re-mints once; any other refusal throws", async () => {
  let mints = 0;
  const upstream = fakeFetch((req) =>
    req.headers.get("x-api-key") === "ryph-vk-2"
      ? Response.json({ content: [{ type: "text", text: "ok" }] })
      : new Response("nope", { status: 401 })
  );
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () => {
      mints += 1;
      return Promise.resolve(credential({ token: `ryph-vk-${mints}` }));
    },
    fetch: upstream.fetch,
    diag: silent,
  });
  assertEquals(await client.complete({ system: "s", prompt: "p", maxTokens: 5 }), "ok");
  assertEquals(mints, 2);
  assertEquals(upstream.seen.length, 2);

  const refusing = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: () => Promise.resolve(credential()),
    fetch: fakeFetch(() => new Response("rate limited", { status: 429 })).fetch,
    diag: silent,
  });
  await assertRejects(
    () => refusing.complete({ system: "s", prompt: "p", maxTokens: 5 }),
    Error,
    "answered 429",
  );
});

test("concurrent calls share one mint, cold and after a revocation", async () => {
  // The proxy keeps one live credential per consumer: minting a new one revokes the last.
  let mints = 0;
  let live = "";
  const issue = async () => {
    await new Promise((r) => setTimeout(r, 5));
    mints += 1;
    live = `ryph-vk-${mints}`;
    return credential({ token: live });
  };
  const upstream = fakeFetch(async (req) => {
    await new Promise((r) => setTimeout(r, 1));
    return req.headers.get("x-api-key") === live
      ? Response.json({ content: [{ type: "text", text: "ok" }] })
      : new Response("revoked", { status: 401 });
  });
  const client = proxyModelClient({
    proxyUrl: "http://proxy.test",
    credentials: issue,
    fetch: upstream.fetch,
    diag: silent,
  });
  const burst = () =>
    Promise.all(
      Array.from({ length: 8 }, () => client.complete({ system: "s", prompt: "p", maxTokens: 5 })),
    );

  assertEquals(await burst(), Array(8).fill("ok"));
  assertEquals(mints, 1);

  // Something else rotated the key: every call is refused once, and they re-mint together.
  live = "ryph-vk-elsewhere";
  assertEquals(await burst(), Array(8).fill("ok"));
  assertEquals(mints, 2);
});
