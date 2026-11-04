// The background model over the model proxy (adapters/platform_model/proxy.ts): a platform
// credential, the dialect it names, and one re-mint on a 401.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import {
  type PlatformCredential,
  proxyPlatformModel,
} from "../src/adapters/platform_model/proxy.ts";

const credential = (over: Partial<PlatformCredential> = {}): PlatformCredential => ({
  token: "vk-1",
  provider: "anthropic",
  dialect: "anthropic-messages",
  model: "claude-haiku-5",
  allowedModels: "*",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  basePath: "",
  ...over,
});

test("an Anthropic credential speaks messages; an OpenAI-compatible one chat completions", async () => {
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher = ((input: string, init: RequestInit) => {
    seen.push({
      url: input,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    });
    return Promise.resolve(
      input.endsWith("/v1/messages")
        ? Response.json({ content: [{ type: "text", text: "Fix the login" }] })
        : Response.json({ choices: [{ message: { content: "Fix the signup" } }] }),
    );
  }) as unknown as typeof fetch;
  const diag = { warn: () => {} };
  const anthropic = proxyPlatformModel({
    proxyUrl: "http://proxy.test/",
    credentials: () => Promise.resolve(credential()),
    fetch: fetcher,
    diag,
  });
  assertEquals(
    await anthropic.complete({ system: "s", prompt: "p", maxTokens: 40 }),
    "Fix the login",
  );
  assertEquals(seen[0].url, "http://proxy.test/v1/messages");
  assertEquals(seen[0].headers.get("x-api-key"), "vk-1");
  assertEquals(seen[0].body.model, "claude-haiku-5");

  const openai = proxyPlatformModel({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(credential({ dialect: "openai-completions", basePath: "/v1" })),
    fetch: fetcher,
    diag,
  });
  assertEquals(
    await openai.complete({ system: "s", prompt: "p", maxTokens: 40 }),
    "Fix the signup",
  );
  assertEquals(seen[1].url, "http://proxy.test/v1/chat/completions");
  assertEquals(seen[1].headers.get("authorization"), "Bearer vk-1");
});

test("an OpenAI credential speaks Responses and reads its text off the output items", async () => {
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const fetcher = ((input: string, init: RequestInit) => {
    seen = { url: input, body: JSON.parse(String(init.body)) };
    return Promise.resolve(Response.json({
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "Fix the reset" }] },
      ],
    }));
  }) as unknown as typeof fetch;
  const model = proxyPlatformModel({
    proxyUrl: "http://proxy.test",
    credentials: () =>
      Promise.resolve(
        credential({ provider: "openai", dialect: "openai-responses", basePath: "/v1" }),
      ),
    fetch: fetcher,
    diag: { warn: () => {} },
  });
  const text = await model.complete({
    system: "Title it.",
    prompt: "reset is broken",
    maxTokens: 40,
  });
  assertEquals(text, "Fix the reset");
  assertEquals(seen!.url, "http://proxy.test/v1/responses");
  assertEquals(seen!.body.instructions, "Title it.");
  assertEquals(seen!.body.input, "reset is broken");
  assertEquals(seen!.body.store, false);
});

test("a 401 re-mints once; anything else not ok is a throw", async () => {
  let minted = 0;
  let calls = 0;
  const model = proxyPlatformModel({
    proxyUrl: "http://proxy.test",
    credentials: () => Promise.resolve(credential({ token: `vk-${++minted}` })),
    fetch: (() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response("expired", { status: 401 })
          : calls === 2
          ? Response.json({ content: [{ type: "text", text: "ok" }] })
          : new Response("nope", { status: 503 }),
      );
    }) as unknown as typeof fetch,
    diag: { warn: () => {} },
  });
  assertEquals(await model.complete({ system: "s", prompt: "p", maxTokens: 1 }), "ok");
  assertEquals(minted, 2);
  await assertRejects(() => model.complete({ system: "s", prompt: "p", maxTokens: 1 }));
});

test("concurrent calls share one mint, cold and after a revocation", async () => {
  // The proxy keeps one live credential per consumer: minting a new one revokes the last.
  let minted = 0;
  let live = "";
  const model = proxyPlatformModel({
    proxyUrl: "http://proxy.test",
    credentials: async () => {
      await new Promise((r) => setTimeout(r, 5));
      live = `vk-${++minted}`;
      return credential({ token: live });
    },
    fetch: (async (_input: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 1));
      return new Headers(init.headers).get("x-api-key") === live
        ? Response.json({ content: [{ type: "text", text: "ok" }] })
        : new Response("revoked", { status: 401 });
    }) as unknown as typeof fetch,
    diag: { warn: () => {} },
  });
  const burst = () =>
    Promise.all(
      Array.from({ length: 8 }, () => model.complete({ system: "s", prompt: "p", maxTokens: 1 })),
    );

  assertEquals(await burst(), Array(8).fill("ok"));
  assertEquals(minted, 1);

  // Something else rotated the key: every call is refused once, and they re-mint together.
  live = "vk-elsewhere";
  assertEquals(await burst(), Array(8).fill("ok"));
  assertEquals(minted, 2);
});
