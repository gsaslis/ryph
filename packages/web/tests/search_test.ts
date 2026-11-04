// The Brave adapter and the choice above it: what the request carries, what the answer maps to,
// and — the part that matters — that the key never appears anywhere but the one header.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { braveSearch } from "../src/adapters/search/brave.ts";
import { searchBackendFromEnv } from "../src/adapters/search/config.ts";
import { SearchRefusedError } from "../src/ports/search.ts";

const KEY = "brave-subscription-key";

function recordingFetch(answer: Response | (() => Response)) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const fn = ((input: URL | Request | string, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url: new URL(href), headers: new Headers(init?.headers) });
    return Promise.resolve(typeof answer === "function" ? answer() : answer);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("the query, the count and the freshness ride the request; the key rides one header", async () => {
  const upstream = recordingFetch(ok({ web: { results: [] } }));
  const backend = braveSearch({ key: KEY, fetch: upstream.fetch });
  await backend.search({ query: "deno serve", count: 3, freshness: "week" });
  const call = upstream.calls[0];
  assertEquals(call.url.host, "api.search.brave.com");
  assertEquals(call.url.searchParams.get("q"), "deno serve");
  assertEquals(call.url.searchParams.get("count"), "3");
  assertEquals(call.url.searchParams.get("freshness"), "pw");
  assertEquals(call.headers.get("x-subscription-token"), KEY);
  assert(!call.url.href.includes(KEY), "the key must never be in a URL");
});

test("results map onto the port's shape, markup stripped, age taken where it is", async () => {
  const upstream = recordingFetch(ok({
    web: {
      results: [
        {
          title: "Deno <strong>serve</strong>",
          url: "https://docs.deno.com/a",
          description: "The  <em>handler</em>\nform",
          age: "3 days ago",
        },
        {
          title: "Second",
          url: "https://docs.deno.com/b",
          description: "",
          page_age: "2024-01-02",
        },
        { title: "No URL", description: "dropped" },
      ],
    },
  }));
  const results = await braveSearch({ key: KEY, fetch: upstream.fetch })
    .search({ query: "x", count: 5 });
  assertEquals(results.length, 2, "a result with no URL is dropped");
  assertEquals(results[0], {
    title: "Deno serve",
    url: "https://docs.deno.com/a",
    snippet: "The handler form",
    age: "3 days ago",
  });
  assertEquals(results[1].age, "2024-01-02");
});

test("a provider refusal names the provider and never the credential", async () => {
  for (const [status, needle] of [[401, "credential"], [429, "rate-limiting"], [503, "trouble"]]) {
    const upstream = recordingFetch(new Response("body", { status: status as number }));
    const backend = braveSearch({ key: KEY, fetch: upstream.fetch });
    const err = await backend.search({ query: "x", count: 1 }).catch((e) => e);
    assert(err instanceof SearchRefusedError, `${status}`);
    assert(err.message.includes(needle as string), err.message);
    assert(!err.message.includes(KEY), "a refusal must never carry the key");
  }
});

test("an upstream that cannot be reached is a refusal, not a crash", async () => {
  const fn = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
  const err = await braveSearch({ key: KEY, fetch: fn })
    .search({ query: "x", count: 1 })
    .catch((e) => e);
  assert(err instanceof SearchRefusedError);
  assert(!err.message.includes(KEY));
});

test("no key means no backend, and the reason names the variable", () => {
  const choice = searchBackendFromEnv({ provider: undefined, key: undefined });
  assertEquals(choice.backend, null);
  assert(!choice.backend && choice.reason.includes("RYPH_WEB_SEARCH_KEY"));
  assert(!choice.backend && choice.reason.includes("web__fetch is"));
});

test("a provider nobody implements is refused by name, not silently ignored", () => {
  const choice = searchBackendFromEnv({ provider: "google", key: "k" });
  assertEquals(choice.backend, null);
  assert(!choice.backend && choice.reason.includes("google"));
});

test("a key plus the default provider is Brave", () => {
  const choice = searchBackendFromEnv({ provider: undefined, key: KEY });
  assertEquals(choice.backend?.provider, "brave");
});
