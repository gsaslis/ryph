// The conversion budget and the ceiling — the two things standing between one hostile page and
// every other run's tool calls. These spawn REAL workers (no sockets, no network): the point is
// that termination and the in-flight count behave as claimed.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_CONVERT_BUDGET_MS,
  workerConverter,
} from "../src/adapters/convert/worker_converter.ts";
import { ConversionRefusedError } from "../src/ports/converter.ts";
import { makePageCache } from "../src/core/cache.ts";
import { setup } from "../src/setup.ts";

const ARTICLE = `<html><head><title>A page</title></head><body><article>${
  "<p>A paragraph of real content, at length, so the extractor keeps it.</p>".repeat(6)
}</article></body></html>`;

test("a page converts in a worker and comes back as markdown", async () => {
  const converter = workerConverter();
  try {
    const page = await converter.convert(ARTICLE, "https://example.com/doc");
    assertEquals(page.title, "A page");
    assertStringIncludes(page.markdown, "A paragraph of real content");
  } finally {
    converter.close();
  }
});

test("a link resolved INSIDE the worker points at the page, not at the worker's module", async () => {
  // The one that only reproduces here: in the main thread there is no `location`, so a relative
  // link was resolved correctly by accident; inside a web Worker `location` is the module's file:
  // URL, and readability rewrote every href against it.
  const converter = workerConverter();
  try {
    const page = await converter.convert(
      `<html><head><title>T</title></head><body><article>${
        "<p>A paragraph of real content, at length, so the extractor keeps it.</p>".repeat(6)
      }<p><a href="../other">there</a></p></article></body></html>`,
      "https://example.com/docs/page",
    );
    assertStringIncludes(page.markdown, "[there](https://example.com/other)");
    assert(!page.markdown.includes("file://"), "no link may point at this deployment's disk");
  } finally {
    converter.close();
  }
});

test("a conversion past its budget is terminated, and the refusal names the budget", async () => {
  // One millisecond: spawning the worker alone takes tens, so this is the timeout path every
  // time, and what it proves is that the timeout fires, kills the worker and answers.
  const converter = workerConverter({ budgetMs: 1 });
  try {
    const err = await converter.convert(ARTICLE, "https://example.com/doc").catch((e) => e);
    assert(err instanceof ConversionRefusedError, `got ${err}`);
    assertStringIncludes(err.message, "0s to convert and was stopped");
    // And the slot is given back: the converter is not wedged by the page it killed.
    const after = await workerConverter().convert(ARTICLE, "https://example.com/doc");
    assertEquals(after.title, "A page");
  } finally {
    converter.close();
  }
});

test("the default budget is seconds, not milliseconds", () => {
  assertEquals(DEFAULT_CONVERT_BUDGET_MS, 5_000);
});

test("past the ceiling a conversion is refused, not queued", async () => {
  const converter = workerConverter({ maxInFlight: 1 });
  try {
    const first = converter.convert(ARTICLE, "https://example.com/1");
    const err = await converter.convert(ARTICLE, "https://example.com/2").catch((e) => e);
    assert(err instanceof ConversionRefusedError);
    assertStringIncludes(err.message, "converting 1 pages at once");
    // The first one still finishes, and the slot then frees.
    assertEquals((await first).title, "A page");
    assertEquals((await converter.convert(ARTICLE, "https://example.com/3")).title, "A page");
  } finally {
    converter.close();
  }
});

test("close() ends the conversions in flight, and answers the callers waiting on them", async () => {
  // The claim three composition roots make in their comments — "in-flight conversions die with
  // their workers" — which used to be false: close() set a flag and terminated nothing, so a
  // caller mid-conversion waited on a promise that would never settle and the drain waited with
  // it.
  const heavy = `<html><body><article>${
    "<p>A sentence with enough words in it to be kept by the extractor.</p>".repeat(6000)
  }</article></body></html>`;
  const converter = workerConverter({ maxInFlight: 2, budgetMs: 60_000 });
  const first = converter.convert(heavy, "https://example.com/1");
  const second = converter.convert(heavy, "https://example.com/2");
  converter.close();
  for (const pending of [first, second]) {
    const err = await pending.catch((e) => e);
    assert(err instanceof ConversionRefusedError, `got ${err}`);
    assertStringIncludes(err.message, "shutting down");
  }
});

test("a closed converter refuses rather than spawning anything", async () => {
  const converter = workerConverter();
  converter.close();
  const err = await converter.convert(ARTICLE, "https://example.com/doc").catch((e) => e);
  assert(err instanceof ConversionRefusedError);
});

// ---- the page cache ------------------------------------------------------------

test("the cache answers a repeat, evicts the oldest, and forgets past its TTL", () => {
  let now = 1000;
  const cache = makePageCache<string>({ max: 2, ttlMs: 100, now: () => now });
  cache.set("a", "A", 1);
  cache.set("b", "B", 1);
  assertEquals(cache.get("a"), "A");
  // "a" was just used, so "b" is the oldest and goes when a third arrives.
  cache.set("c", "C", 1);
  assertEquals(cache.size, 2);
  assertEquals(cache.get("b"), null);
  assertEquals(cache.get("c"), "C");
  now += 101;
  assertEquals(cache.get("c"), null, "past its TTL");
  // Expiry is lazy — an entry goes when it is asked for, or when the caps push it out — which is
  // why what bounds the memory is the caps and not the clock.
  assertEquals(cache.size, 1);
});

test("the cache is bounded by characters as well as entries", () => {
  const cache = makePageCache<string>({ max: 10, maxChars: 100 });
  cache.set("a", "A", 60);
  cache.set("b", "B", 60);
  assertEquals(cache.get("a"), null, "the oldest went when the two together crossed the cap");
  assertEquals(cache.get("b"), "B");
  // A page bigger than the whole cache is not cached at all, rather than evicting everything.
  cache.set("huge", "H", 1000);
  assertEquals(cache.get("huge"), null);
  assertEquals(cache.get("b"), "B");
});

test("a saturated service still reads ready: the probe has a slot of its own", async () => {
  // The service's own converters, not an injected one — which is the case the split exists for.
  // A page big enough that four of them are genuinely mid-conversion while the probe runs.
  const heavy = `<html><body><article>${
    "<p>A sentence with enough words in it to be kept by the extractor.</p>".repeat(4000)
  }</article></body></html>`;
  const web = setup({
    gatewayToken: "t",
    search: null,
    policy: { allowInsecure: false, resolve: () => Promise.resolve(["93.184.216.34"]) },
    fetch: (() =>
      Promise.resolve(
        new Response(heavy, { headers: { "content-type": "text/html" } }),
      )) as unknown as typeof fetch,
    diag: { debug: () => {}, info: () => {}, warn: () => {} },
  });
  try {
    // Four conversions in flight, which is the whole ceiling.
    const busy = Array.from({ length: 4 }, () =>
      web.dataHandler(
        new Request("http://web.internal/v1/web-mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer t",
            "x-ryph-run-id": "r-1",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "fetch", arguments: { url: "https://example.com/never" } },
          }),
        }),
      ));
    // The probe must ANSWER while they are in flight, not wait behind them — asserted as a race
    // it has to win, because "it did not throw" would also be true of a promise that simply
    // resolved after the four finished.
    const readyFirst = await Promise.race([
      web.ready().then(() => "ready" as const),
      Promise.all(busy).then(() => "conversions" as const),
    ]);
    assertEquals(readyFirst, "ready", "readiness waited behind the tool calls");
    const answers = await Promise.all(busy);
    const texts = await Promise.all(
      answers.map(async (res) => (await res!.json()).result.content[0].text as string),
    );
    // Whatever the four did — converted, or hit the ceiling — none of them made readiness fail.
    assertEquals(texts.length, 4);
  } finally {
    web.close();
  }
});
