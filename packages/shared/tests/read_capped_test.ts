// Reading a request body under a byte cap that bites while it streams (src/http.ts).

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { BodyDeadlineError, parseBody, readCapped } from "../src/http.ts";

const enc = new TextEncoder();

function request(body: ReadableStream<Uint8Array>, length?: string): Request {
  return new Request("http://localhost/", {
    method: "POST",
    body,
    headers: length === undefined ? {} : { "content-length": length },
    duplex: "half",
  } as RequestInit);
}

function chunks(parts: Uint8Array[], length?: string): Request {
  let index = 0;
  return request(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (index < parts.length) c.enqueue(parts[index++]!);
        else c.close();
      },
    }, { highWaterMark: 0 }),
    length,
  );
}

test("readCapped validates the cap before touching the body", async () => {
  for (const cap of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const req = chunks([enc.encode("x")]);
    await assertRejects(() => readCapped(req, cap), RangeError, "positive safe integer");
    assertEquals(req.bodyUsed, false);
    assertEquals(req.body!.locked, false);
  }
  assertEquals(await readCapped(chunks([]), Number.MAX_SAFE_INTEGER), "");
});

test("readCapped accepts absent and empty bodies", async () => {
  assertEquals(await readCapped(new Request("http://localhost/"), 1), "");
  assertEquals(await readCapped(chunks([]), 1), "");
});

test("readCapped accepts exactly the cap and rejects one byte over, regardless of length", async () => {
  for (const length of [undefined, "0", "1", "4", "nonsense"]) {
    const exact = chunks([enc.encode("ab"), enc.encode("cd")], length);
    assertEquals(await readCapped(exact, 4), "abcd");
    assertEquals(exact.body!.locked, false);
    const over = chunks([enc.encode("ab"), enc.encode("cde")], length);
    assertEquals(await readCapped(over, 4), null);
    assertEquals(over.body!.locked, false);
  }
  assertEquals(await readCapped(chunks([enc.encode("abcde")]), 4), null);
});

test("readCapped counts UTF-8 bytes and decodes characters split across chunks", async () => {
  const bytes = enc.encode("é🙂");
  const parts = Array.from(bytes, (byte) => new Uint8Array([byte]));
  assertEquals(await readCapped(chunks(parts), 6), "é🙂");
  assertEquals(await readCapped(chunks(parts), 5), null);
});

test("readCapped flushes an incomplete UTF-8 sequence at EOF", async () => {
  assertEquals(await readCapped(chunks([new Uint8Array([0xe2, 0x82])]), 2), "�");
});

for (const early of [false, true]) {
  for (const cleanup of ["pending", "rejecting"] as const) {
    test(`readCapped cancels ${early ? "declared" : "streaming"} overflow without waiting for ${cleanup} cleanup`, async () => {
      let pulls = 0;
      let cancelled = 0;
      const req = request(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            c.enqueue(enc.encode("12345"));
          },
          cancel() {
            cancelled++;
            return cleanup === "pending"
              ? new Promise<void>(() => {})
              : Promise.reject(new Error("cleanup failed"));
          },
        }, { highWaterMark: 0 }),
        early ? "5" : undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          readCapped(req, 4),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 500);
          }),
        ]);
        assertEquals(result, null);
        assertEquals(cancelled, 1);
        assertEquals(pulls, early ? 0 : 1);
        assertEquals(req.body!.locked, false);
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

test("readCapped rejects enormous declared lengths before reading", async () => {
  const req = chunks([enc.encode("x")], "9".repeat(400));
  assertEquals(await readCapped(req, Number.MAX_SAFE_INTEGER), null);
  assertEquals(req.body!.locked, false);
});

test("readCapped propagates broken streams and releases the reader", async () => {
  let pulls = 0;
  const failure = new Error("upload interrupted");
  const req = request(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode("ok"));
        else c.error(failure);
      },
    }, { highWaterMark: 0 }),
  );
  const error = await assertRejects(() => readCapped(req, 4), Error, "upload interrupted");
  assertEquals(error, failure);
  assertEquals(req.body!.locked, false);
});

/** A body that sends one byte and then nothing, never closing: a slow-drip peer. */
function dripping(): { req: Request; cancelled: Promise<void> } {
  let cancelled!: () => void;
  const done = new Promise<void>((resolve) => cancelled = resolve);
  let sent = false;
  const req = request(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode("{"));
        }
        // Otherwise never answers: the next read waits forever.
        return new Promise(() => {});
      },
      cancel() {
        cancelled();
      },
    }, { highWaterMark: 0 }),
  );
  return { req, cancelled: done };
}

test("readCapped stops a body still arriving at its deadline and cancels the rest", async () => {
  const { req, cancelled } = dripping();
  const started = performance.now();
  await assertRejects(
    () => readCapped(req, 1024, AbortSignal.timeout(50)),
    BodyDeadlineError,
    "too long",
  );
  assertEquals(performance.now() - started < 1_000, true);
  await cancelled;
  // A deadline already past refuses before a byte is read.
  await assertRejects(
    () => readCapped(chunks([enc.encode("x")]), 4, AbortSignal.abort()),
    BodyDeadlineError,
  );
  // And one that never fires changes nothing.
  assertEquals(await readCapped(chunks([enc.encode("ab")]), 4, AbortSignal.timeout(10_000)), "ab");
});

test("parseBody answers 408 for a body past its deadline", async () => {
  const schema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
  const { req } = dripping();
  const body = await parseBody(req, schema, { signal: AbortSignal.timeout(50) });
  assertEquals(body.ok, false);
  if (!body.ok) assertEquals(body.res.status, 408);
});
