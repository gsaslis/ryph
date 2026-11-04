// The router, the JSON answer, the capped stream reads and body validation (src/http.ts).

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  describeIssues,
  json,
  makeRouter,
  parseBody,
  readCappedBytes,
  readCappedText,
  route,
  type Schema,
} from "../src/http.ts";

const enc = new TextEncoder();

test("the first route whose method and pattern match answers; nothing matching is a 404", async () => {
  const seen: string[] = [];
  const router = makeRouter([
    route("GET", "/v1/things/:id", (_req, p) => {
      seen.push(`a:${p.id}`);
      return json(200, { id: p.id });
    }),
    route("GET", "/v1/things/:id", () => {
      seen.push("b");
      return json(200, {});
    }),
    route("POST", "/v1/things", () => json(201, {})),
  ]);
  assertEquals((await router(new Request("http://x/v1/things/7"))).status, 200);
  assertEquals(seen, ["a:7"]);
  assertEquals((await router(new Request("http://x/v1/things", { method: "POST" }))).status, 201);
  const missing = await router(new Request("http://x/v1/things", { method: "DELETE" }));
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), { error: "not found" });
});

test("path groups arrive percent-decoded; a malformed escape or a control character is a 400", async () => {
  const router = makeRouter([route("GET", "/r/:rid", (_req, p) => json(200, p))]);
  assertEquals(await (await router(new Request("http://x/r/rad%3Az6Mk"))).json(), {
    rid: "rad:z6Mk",
  });
  assertEquals(await (await router(new Request("http://x/r/feat%2Fx"))).json(), { rid: "feat/x" });
  assertEquals(await (await router(new Request("http://x/r/plain"))).json(), { rid: "plain" });
  const bad = await router(new Request("http://x/r/%E0%A4%A"));
  assertEquals(bad.status, 400);
  // A control character is no id; refused here rather than handed to a text column.
  assertEquals((await router(new Request("http://x/r/a%00b"))).status, 400);
  assertEquals((await router(new Request("http://x/r/a%0Ab"))).status, 400);
});

test("an optional group left out is dropped, not handed over as undefined", async () => {
  const router = makeRouter([route("GET", "/a{/:b}?", (_req, p) => json(200, p))]);
  assertEquals(await (await router(new Request("http://x/a"))).json(), {});
  assertEquals(await (await router(new Request("http://x/a/1"))).json(), { b: "1" });
});

test("json is pretty-printed application/json, extra headers kept", async () => {
  const res = json(201, { a: 1 }, { "x-extra": "yes", "content-type": "text/plain" });
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(res.headers.get("x-extra"), "yes");
  assertEquals(await res.text(), '{\n  "a": 1\n}');
});

function stream(parts: Uint8Array[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < parts.length) c.enqueue(parts[i++]!);
      else if (!opts.hang) c.close();
      else return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
}

test("readCappedBytes reads up to the cap, refuses past it, and stops at its deadline", async () => {
  assertEquals(await readCappedBytes(null, 4), { ok: true, bytes: new Uint8Array() });
  const exact = await readCappedBytes(stream([enc.encode("ab"), enc.encode("cd")]), 4);
  assertEquals(exact.ok && new TextDecoder().decode(exact.bytes), "abcd");
  assertEquals(await readCappedBytes(stream([enc.encode("abc"), enc.encode("de")]), 4), {
    ok: false,
    reason: "too_large",
  });
  const deadline = new AbortController();
  const pending = readCappedBytes(stream([enc.encode("a")], { hang: true }), 4, deadline.signal);
  deadline.abort();
  assertEquals(await pending, { ok: false, reason: "timeout" });
  assertEquals(await readCappedText(stream([enc.encode("é")]), 4), { ok: true, text: "é" });
  assertEquals(await readCappedText(stream([enc.encode("hello")]), 4), {
    ok: false,
    reason: "too_large",
  });
});

test("readCappedBytes refuses a Request or Response by its Content-Length before reading", async () => {
  let pulled = 0;
  const unread = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(enc.encode("x"));
      },
    }, { highWaterMark: 0 });
  const announced = (length: string) => ({ "content-length": length });

  const req = new Request("http://x/", { method: "POST", body: unread(), headers: announced("5") });
  assertEquals(await readCappedBytes(req, 4), { ok: false, reason: "too_large" });
  const res = new Response(unread(), { headers: announced("5") });
  assertEquals(await readCappedText(res, 4), { ok: false, reason: "too_large" });
  assertEquals(pulled, 0);

  // A length within the cap is a claim, not an exemption: the stream is still counted.
  const liar = new Response(stream([enc.encode("abc"), enc.encode("de")]), {
    headers: announced("2"),
  });
  assertEquals(await readCappedBytes(liar, 4), { ok: false, reason: "too_large" });
  // No length, or one that is not a number, falls through to the streaming count.
  const chunked = new Response(stream([enc.encode("ab")]), { headers: announced("lots") });
  const read = await readCappedBytes(chunked, 4);
  assertEquals(read.ok && new TextDecoder().decode(read.bytes), "ab");
  assertEquals(await readCappedBytes(new Request("http://x/"), 4), {
    ok: true,
    bytes: new Uint8Array(),
  });
});

/** A zod-shaped schema without zod: an object with a string `name`. */
const named: Schema<{ name: string }> = {
  safeParse(v) {
    if (typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string") {
      return { success: true, data: v as { name: string } };
    }
    return {
      success: false,
      error: { issues: [{ path: ["name"], message: "Invalid input: expected string" }] },
    };
  },
};

const post = (body: string | Blob, contentType: string | null = "application/json") =>
  new Request("http://x/", {
    method: "POST",
    body,
    ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
  });

test("parseBody: valid data through, malformed JSON and schema failures as 400s", async () => {
  assertEquals(await parseBody(post('{"name":"a"}'), named), { ok: true, data: { name: "a" } });
  for (
    const [body, error] of [
      ["{", "body is not valid JSON"],
      ["", "body is not valid JSON"],
      ['{"name":1}', "name: Invalid input: expected string"],
    ] as const
  ) {
    const parsed = await parseBody(post(body), named);
    if (parsed.ok) throw new Error(`${body} parsed`);
    assertEquals(parsed.res.status, 400, body);
    assertEquals(await parsed.res.json(), { error }, body);
  }
});

test("parseBody: over the cap is a 413 naming it, 1 MiB by default", async () => {
  const small = await parseBody(post('{"name":"abcdef"}'), named, { maxBytes: 8 });
  if (small.ok) throw new Error("parsed past the cap");
  assertEquals(small.res.status, 413);
  assertEquals(await small.res.json(), { error: "body exceeds 8 bytes" });
  const big = await parseBody(post(JSON.stringify({ name: "x".repeat(1024 * 1024) })), named);
  if (big.ok) throw new Error("parsed past the default cap");
  assertEquals(await big.res.json(), { error: "body exceeds 1048576 bytes" });
});

test("parseBody: emptyIs stands in for a blank body, and is still held to the schema", async () => {
  const optional: Schema<{ name?: string }> = {
    safeParse: (v) => ({ success: true, data: v as { name?: string } }),
  };
  assertEquals(await parseBody(post("  "), optional, { emptyIs: {} }), { ok: true, data: {} });
  assertEquals(await parseBody(new Request("http://x/"), optional, { emptyIs: {} }), {
    ok: true,
    data: {},
  });
  const refused = await parseBody(post(""), named, { emptyIs: {} });
  assertEquals(refused.ok, false);
});

test("parseBody: a body that does not say it is JSON is a 415, whatever it holds", async () => {
  // What a page on another site can send without a preflight: text/plain (a string body), a
  // form type, or no type at all (a Blob without one). Each would have parsed as JSON.
  for (
    const sent of [
      post('{"name":"a"}', "text/plain;charset=UTF-8"),
      post('{"name":"a"}', "application/x-www-form-urlencoded"),
      post('{"name":"a"}', "multipart/form-data; boundary=x"),
      post(new Blob(['{"name":"a"}']), null),
    ]
  ) {
    const parsed = await parseBody(sent, named);
    if (parsed.ok) throw new Error(`${sent.headers.get("content-type")} parsed`);
    assertEquals(parsed.res.status, 415);
  }
  // Parameters and case are the sender's own business.
  assertEquals(await parseBody(post('{"name":"a"}', "Application/JSON; charset=utf-8"), named), {
    ok: true,
    data: { name: "a" },
  });
  // A blank body that `emptyIs` stands in for has no type to name.
  const optional: Schema<{ name?: string }> = {
    safeParse: (v) => ({ success: true, data: v as { name?: string } }),
  };
  assertEquals(await parseBody(post("", null), optional, { emptyIs: {} }), { ok: true, data: {} });
});

test("describeIssues: path.to.field: message, `; `-joined; a root issue is its message", () => {
  assertEquals(
    describeIssues({
      issues: [
        { path: ["a", 0, "b"], message: "bad" },
        { path: [], message: "root" },
        { path: [Symbol("s")], message: "sym" },
      ],
    }),
    "a.0.b: bad; root; Symbol(s): sym",
  );
});
