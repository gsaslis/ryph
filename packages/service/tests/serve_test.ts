// `serve` over a real socket: streaming both ways, the request signal, errors before and after the
// headers, shutdown, and WebSocket upgrades — everything a service used to get from `Deno.serve`.

import { afterEach, describe, expect, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { type HttpServer, serve, type ServeHandler, type ServeOptions } from "../src/serve.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const open: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.shutdown()));
});

async function start(handler: ServeHandler, opts: ServeOptions = {}): Promise<{
  server: HttpServer;
  url: string;
}> {
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {}, ...opts },
    handler,
  );
  open.push(server);
  return { server, url: `http://127.0.0.1:${server.addr.port}` };
}

/** Raw HTTP/1.1 over a socket, for what fetch hides: exact header lines, keep-alive, a cut upload. */
function raw(port: number) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  let closed = false;
  socket.on("data", (d) => (received += d.toString()));
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  return {
    socket,
    write: (s: string | Uint8Array) => socket.write(s),
    received: () => received,
    closed: () => closed,
    // A bound on a wait for something that does arrive, not a measure of it: generous, so a
    // loaded runner that is slow to answer still answers before the caller's assertion.
    async until(pred: (s: string) => boolean, ms = 10_000) {
      for (let t = 0; t < ms && !pred(received); t += 10) await sleep(10);
      return received;
    },
  };
}

describe("requests", () => {
  test("a request arrives as a fetch Request, with its URL, headers and peer", async () => {
    let seen: { url: string; header: string | null; peer: string; method: string } | undefined;
    const { url } = await start((req, info) => {
      seen = {
        url: req.url,
        header: req.headers.get("x-thing"),
        peer: info.remoteAddr.hostname,
        method: req.method,
      };
      return new Response("ok");
    });
    const res = await fetch(`${url}/a/b?c=d`, { headers: { "x-thing": "1" } });
    assertEquals(await res.text(), "ok");
    assertEquals(seen, {
      url: `${url}/a/b?c=d`,
      header: "1",
      peer: "127.0.0.1",
      method: "GET",
    });
  });

  test("repeated request headers are all kept", async () => {
    let seen = "";
    const { server } = await start((req) => {
      seen = req.headers.get("x-repeat") ?? "";
      return new Response(null, { status: 204 });
    });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\nx-repeat: a\r\nx-repeat: b\r\nconnection: close\r\n\r\n");
    await c.until((s) => s.includes("204"));
    assertEquals(seen, "a, b");
  });

  test("a path that looks like another origin stays a path on this one", async () => {
    let seen = "";
    const { server } = await start((req) => {
      seen = req.url;
      return new Response("ok");
    });
    const c = raw(server.addr.port);
    c.write("GET //evil.example/x HTTP/1.1\r\nhost: svc.test\r\nconnection: close\r\n\r\n");
    await c.until((s) => s.includes("ok"));
    assertEquals(seen, "http://svc.test//evil.example/x");
  });

  test("a Host header that is not a host is refused before the handler", async () => {
    let called = false;
    const { server } = await start(() => {
      called = true;
      return new Response("ok");
    });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: a/b\r\nconnection: close\r\n\r\n");
    const got = await c.until((s) => s.includes("\r\n\r\n"));
    assert(got.startsWith("HTTP/1.1 400"), got);
    assert(!called);
  });

  test("a large upload streams through whole", async () => {
    const size = 16 * 1024 * 1024;
    const { url } = await start(async (req) => {
      let n = 0;
      const hash = createHash("sha256");
      for await (const chunk of req.body!) {
        n += chunk.byteLength;
        hash.update(chunk);
      }
      return Response.json({ n, sum: hash.digest("hex") });
    });
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i % 251;
    const sum = createHash("sha256").update(body).digest("hex");
    const res = await fetch(url, { method: "POST", body });
    assertEquals(await res.json(), { n: size, sum });
  });

  test("a request body is readable before the client has finished sending it", async () => {
    const firstChunk = Promise.withResolvers<string>();
    const { url } = await start(async (req) => {
      const reader = req.body!.getReader();
      const { value } = await reader.read();
      firstChunk.resolve(dec.decode(value));
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += dec.decode(value);
      }
      return new Response(rest);
    });
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const upload = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
    const answered = fetch(url, { method: "POST", body: upload, duplex: "half" } as RequestInit);
    push.enqueue(enc.encode("first\n"));
    // The handler sees it while the upload is still open: nothing waits for the whole body.
    assertEquals(await firstChunk.promise, "first\n");
    push.enqueue(enc.encode("second\n"));
    push.close();
    assertEquals(await (await answered).text(), "second\n");
  });

  test("an upload cut short errors the handler's read instead of ending it", async () => {
    const reading = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<string>();
    const { server } = await start(async (req) => {
      try {
        let n = 0;
        for await (const chunk of req.body!) {
          n += chunk.byteLength;
          reading.resolve();
        }
        outcome.resolve(`ended after ${n}`);
      } catch {
        outcome.resolve("errored");
      }
      return new Response("done");
    });
    const c = raw(server.addr.port);
    c.write("POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\n\r\n" + "x".repeat(100));
    // Cut only once the handler is reading the body: cut before the server has parsed the
    // request, there is no handler to hear it, and nothing would ever settle `outcome`.
    await reading.promise;
    c.socket.destroy();
    // A truncated body must never read as a complete one.
    assertEquals(await outcome.promise, "errored");
  });
});

describe("responses", () => {
  test("every Set-Cookie goes out as its own header line", async () => {
    const { server, url } = await start(() => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2, with a comma; Path=/");
      headers.append("x-other", "y");
      return new Response("ok", { headers });
    });
    const res = await fetch(url);
    assertEquals(res.headers.getSetCookie(), ["a=1; Path=/", "b=2, with a comma; Path=/"]);
    await res.text();
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
    const got = await c.until((s) => s.includes("ok"));
    assertEquals(got.match(/^set-cookie:/gim)?.length, 2);
  });

  test("a whole body gets a Content-Length, status text and headers intact", async () => {
    const { url } = await start(() =>
      new Response("hello", { status: 201, statusText: "Made", headers: { "x-a": "b" } })
    );
    const res = await fetch(url);
    assertEquals(res.status, 201);
    assertEquals(res.statusText, "Made");
    assertEquals(res.headers.get("x-a"), "b");
    assertEquals(res.headers.get("content-length"), "5");
    assertEquals(await res.text(), "hello");
  });

  test("an empty body and a 204 send nothing", async () => {
    const { url } = await start((req) =>
      new URL(req.url).pathname === "/none" ? new Response(null, { status: 204 }) : new Response("")
    );
    const none = await fetch(`${url}/none`);
    assertEquals(none.status, 204);
    assertEquals(await none.text(), "");
    const empty = await fetch(`${url}/empty`);
    assertEquals(empty.headers.get("content-length"), "0");
    assertEquals(await empty.text(), "");
  });

  test("HEAD answers headers only", async () => {
    const { url } = await start(() =>
      new Response("hello", { headers: { "content-length": "5", "x-a": "b" } })
    );
    const res = await fetch(url, { method: "HEAD" });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("x-a"), "b");
    assertEquals(await res.text(), "");
  });

  test("a streamed response arrives as it is produced, headers first", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const { url } = await start(() =>
      new Response(new ReadableStream<Uint8Array>({ start: (c) => void (push = c) }), {
        headers: { "content-type": "text/event-stream" },
      })
    );
    const res = await fetch(url);
    // The headers came before any body: an SSE client must see them at once.
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    push.enqueue(enc.encode("data: 1\n\n"));
    assertEquals(dec.decode((await reader.read()).value), "data: 1\n\n");
    push.enqueue(enc.encode("data: 2\n\n"));
    assertEquals(dec.decode((await reader.read()).value), "data: 2\n\n");
    push.close();
    assert((await reader.read()).done);
  });

  test("a large response streams out whole, honouring backpressure", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunks = 256; // 16 MiB
    let pulled = 0;
    const { url } = await start(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (pulled++ === chunks) c.close();
            else c.enqueue(chunk);
          },
        }, { highWaterMark: 0 }),
      )
    );
    const res = await fetch(url);
    const reader = res.body!.getReader();
    // A reader that has taken nothing yet holds the producer back to what the buffers hold.
    await sleep(100);
    assert(pulled < chunks, `the whole body was pulled before anyone read it (${pulled})`);
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
    }
    assertEquals(n, chunk.byteLength * chunks);
  });

  test("a body that errors after its headers reaches the client as an error, and onError hears it", async () => {
    const errors: unknown[] = [];
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const { url } = await start(
      () => new Response(new ReadableStream<Uint8Array>({ start: (c) => void (push = c) })),
      {
        onError: (err) => {
          errors.push(err);
          return new Response(null, { status: 500 });
        },
      },
    );
    const res = await fetch(url);
    const reader = res.body!.getReader();
    push.enqueue(enc.encode("partial"));
    await reader.read();
    push.error(new Error("cut"));
    await assertRejects(async () => {
      while (!(await reader.read()).done) { /* until it fails */ }
    });
    for (let i = 0; i < 50 && errors.length === 0; i++) await sleep(10);
    assertEquals((errors[0] as Error).message, "cut");
  });

  test("a whole body goes out with its real length, whatever Content-Length the handler set", async () => {
    // A proxy relaying a decompressed upstream body keeps the compressed length (Bun's fetch
    // does): sent as declared, the surplus would read as the next response on the connection.
    const { server } = await start((req) =>
      new URL(req.url).pathname === "/short"
        ? new Response("hello world", { headers: { "content-length": "3" } })
        : new Response("next")
    );
    const c = raw(server.addr.port);
    c.write("GET /short HTTP/1.1\r\nhost: x\r\n\r\nGET /next HTTP/1.1\r\nhost: x\r\n\r\n");
    const got = await c.until((s) => s.includes("next"));
    c.socket.destroy();
    assert(/content-length: 11\r\n/i.test(got), got);
    assert(!/content-length: 3\r\n/i.test(got), got);
    // The whole body, then the next response right behind it.
    assert(got.includes("\r\n\r\nhello worldHTTP/1.1 200"), got);
  });

  test("a null body goes out with Content-Length 0, whatever the handler set", async () => {
    // A relayed upstream null-body response keeps its Content-Length: sent as declared with no
    // bytes, the client would read the next response on the connection as this one's body.
    const { server } = await start((req) => {
      const path = new URL(req.url).pathname;
      const headers = { "content-length": "30" };
      if (path === "/null") return new Response(null, { headers });
      if (path === "/204") return new Response(null, { status: 204, headers });
      if (path === "/304") return new Response(null, { status: 304, headers });
      return new Response("next");
    });
    const c = raw(server.addr.port);
    c.write(
      "GET /null HTTP/1.1\r\nhost: x\r\n\r\nGET /204 HTTP/1.1\r\nhost: x\r\n\r\n" +
        "GET /304 HTTP/1.1\r\nhost: x\r\n\r\nGET /next HTTP/1.1\r\nhost: x\r\n\r\n",
    );
    const got = await c.until((s) => s.includes("next"));
    c.socket.destroy();
    const [nul, noContent, notModified] = got.split(/(?=HTTP\/1\.1 )/);
    assert(/^HTTP\/1\.1 200/.test(nul) && /content-length: 0\r\n/i.test(nul), got);
    assert(/^HTTP\/1\.1 204/.test(noContent) && !/content-length/i.test(noContent), got);
    // A 304 may carry the length its 200 would have had; it never has a body either way.
    assert(/^HTTP\/1\.1 304/.test(notModified) && /content-length: 30\r\n/i.test(notModified), got);
    assert(got.includes("\r\n\r\nnext"), got);
  });

  test("HEAD keeps the Content-Length its GET would have", async () => {
    const { server } = await start(() =>
      new Response(null, { headers: { "content-length": "30" } })
    );
    const c = raw(server.addr.port);
    c.write("HEAD / HTTP/1.1\r\nhost: x\r\n\r\n");
    const got = await c.until((s) => s.includes("\r\n\r\n"));
    c.socket.destroy();
    assert(/content-length: 30\r\n/i.test(got), got);
  });

  test("a streamed body is held to the Content-Length the handler declared, as Deno.serve held it", async () => {
    const stream = (parts: string[]) =>
      new ReadableStream<Uint8Array>({
        async start(c) {
          for (const p of parts) {
            c.enqueue(enc.encode(p));
            await sleep(30);
          }
          c.close();
        },
      });
    const { server } = await start((req) => {
      const long = new URL(req.url).pathname === "/long";
      const parts = long ? ["hello", " world", "HTTP/1.1 200 OK\r\n\r\nsmuggled"] : ["hello"];
      return new Response(stream(parts), {
        headers: { "content-length": long ? "8" : "500" },
      });
    });
    for (const path of ["/long", "/short"]) {
      const c = raw(server.addr.port);
      c.write(`GET ${path} HTTP/1.1\r\nhost: x\r\n\r\n`);
      const got = await c.until(() => c.closed());
      // Never a byte past the declared length; a body that falls short cuts the connection.
      assert(c.closed(), `${path}: the connection stayed open after a length mismatch`);
      assert(!got.includes("smuggled"), got);
      const sent = got.slice(got.indexOf("\r\n\r\n") + 4);
      assert(sent.length <= (path === "/long" ? 8 : 500), got);
    }
    // A stream that matches its length goes out whole, with it.
    const { url } = await start(() =>
      new Response(stream(["hello", " world"]), { headers: { "content-length": "11" } })
    );
    const res = await fetch(url);
    assertEquals(res.headers.get("content-length"), "11");
    assertEquals(await res.text(), "hello world");
  });

  test("hop-by-hop headers a handler relays are not sent; connection: close still closes", async () => {
    const { server } = await start((req) =>
      new URL(req.url).pathname === "/close"
        ? new Response("bye", { headers: { connection: "close" } })
        : new Response("hello", {
          headers: {
            "transfer-encoding": "chunked",
            connection: "keep-alive",
            "keep-alive": "timeout=5",
            upgrade: "h2c",
            "proxy-connection": "keep-alive",
            te: "trailers",
            "x-kept": "1",
          },
        })
    );
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\nGET /close HTTP/1.1\r\nhost: x\r\n\r\n");
    const got = await c.until(() => c.closed());
    const first = got.slice(0, got.indexOf("hello"));
    assert(!/transfer-encoding/i.test(first), first);
    assert(!/keep-alive: timeout=5/i.test(first), first);
    assert(!/^upgrade:/im.test(first), first);
    assert(!/proxy-connection/i.test(first), first);
    assert(!/^te:/im.test(first), first);
    assert(/^x-kept: 1/im.test(first), first);
    assert(/content-length: 5\r\n/i.test(first), first);
    assert(got.endsWith("bye"), got);
    assert(c.closed(), "connection: close from the handler did not close the connection");
  });

  test("a body with no content-type goes out as text/plain, as Deno.serve sent a string", async () => {
    const { url } = await start((req) =>
      new URL(req.url).pathname === "/typed"
        ? new Response("<b>", { headers: { "content-type": "text/html" } })
        : new Response("<script>alert(1)</script>")
    );
    const plain = await fetch(url);
    assertEquals(plain.headers.get("content-type"), "text/plain;charset=UTF-8");
    await plain.text();
    const typed = await fetch(`${url}/typed`);
    assertEquals(typed.headers.get("content-type"), "text/html");
    await typed.text();
  });

  test("a throwing handler is answered by onError, by default a logged 500", async () => {
    const custom = await start(() => {
      throw new Error("boom");
    }, { onError: (err) => new Response(String((err as Error).message), { status: 418 }) });
    const res = await fetch(custom.url);
    assertEquals(res.status, 418);
    assertEquals(await res.text(), "boom");

    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args[0]);
    try {
      const plain = await start(() => Promise.reject(new Error("boom")));
      const res = await fetch(plain.url);
      assertEquals(res.status, 500);
      assertEquals(await res.text(), "Internal Server Error");
    } finally {
      console.error = original;
    }
    assertEquals((logged[0] as Error).message, "boom");
  });
});

describe("the request signal", () => {
  test("aborts when the client goes away, and the response stream is cancelled", async () => {
    const aborted = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const { url } = await start((req) => {
      req.signal.addEventListener("abort", () => aborted.resolve());
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(enc.encode("data: hi\n\n")),
          cancel: () => cancelled.resolve(),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new AbortController();
    const res = await fetch(url, { signal: client.signal });
    await res.body!.getReader().read();
    client.abort();
    await aborted.promise;
    await cancelled.promise;
  });

  test("aborts while the handler is still working, when the client leaves", async () => {
    const aborted = Promise.withResolvers<void>();
    const { server } = await start(async (req) => {
      await new Promise<void>((r) => req.signal.addEventListener("abort", () => r()));
      aborted.resolve();
      return new Response("too late");
    });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await sleep(50);
    c.socket.destroy();
    await aborted.promise;
  });

  test("a client that left before the handler answered still cancels the body", async () => {
    // Deno.serve cancelled it; a body nobody cancels is a tail's subscription, an open file or
    // a git process kept forever, one per request a client walks away from.
    const cancelled = Promise.withResolvers<void>();
    const { server } = await start(async () => {
      await sleep(200);
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(enc.encode("data: hi\n\n")),
          cancel: () => cancelled.resolve(),
        }),
      );
    });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await sleep(50);
    c.socket.destroy();
    await cancelled.promise;
  });

  test("a child process streaming the body exits when the client left before the answer", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const exited = Promise.withResolvers<void>();
    const { server } = await start(async () => {
      child = spawn("yes", [], { stdio: ["ignore", "pipe", "ignore"] });
      child.once("exit", () => exited.resolve());
      const out = child.stdout!;
      await sleep(200);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            out.on("data", (d: Buffer) => {
              c.enqueue(new Uint8Array(d));
              if ((c.desiredSize ?? 0) <= 0) out.pause();
            });
            out.once("end", () => c.close());
          },
          pull: () => void out.resume(),
          cancel: () => void out.destroy(),
        }),
      );
    });
    const c = raw(server.addr.port);
    c.write("POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n");
    await sleep(50);
    c.socket.destroy();
    const outcome = await Promise.race([exited.promise.then(() => "exited"), sleep(3_000)]);
    if (outcome !== "exited") child?.kill("SIGKILL");
    assertEquals(outcome, "exited");
  });

  test("aborts once the response is done, as Deno's did", async () => {
    let signal: AbortSignal | undefined;
    const { url } = await start((req) => {
      signal = req.signal;
      return new Response("ok");
    });
    await (await fetch(url)).text();
    for (let i = 0; i < 50 && !signal?.aborted; i++) await sleep(10);
    assert(signal?.aborted);
  });
});

describe("listening and shutdown", () => {
  test("binding a taken port rejects with its code", async () => {
    const { server } = await start(() => new Response("ok"));
    const err = await serve(
      { hostname: "127.0.0.1", port: server.addr.port, onListen: () => {} },
      () => new Response(),
    ).then(() => null, (e) => e);
    assertEquals((err as NodeJS.ErrnoException).code, "EADDRINUSE");
  });

  test("onListen hears the bound address; the default banner goes to stderr", async () => {
    let heard: unknown;
    const { server } = await start(() => new Response(), { onListen: (a) => (heard = a) });
    assertEquals(heard, { transport: "tcp", hostname: "127.0.0.1", port: server.addr.port });
    assert(server.addr.port > 0);

    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      const quiet = await serve({ hostname: "127.0.0.1", port: 0 }, () => new Response());
      open.push(quiet);
      assertEquals(lines, [`Listening on http://127.0.0.1:${quiet.addr.port}/`]);
    } finally {
      console.error = original;
    }
  });

  test("shutdown waits for a request in flight, then resolves along with finished", async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { server, url } = await start(async () => {
      started.resolve();
      await release.promise;
      return new Response("finished");
    });
    const answered = fetch(url).then((r) => r.text());
    await started.promise;
    let down = false;
    const shutdown = server.shutdown().then(() => (down = true));
    await sleep(50);
    assert(!down, "shutdown did not wait for the request in flight");
    release.resolve();
    assertEquals(await answered, "finished");
    await shutdown;
    await server.finished;
    // And it no longer accepts.
    await assertRejects(() => fetch(url));
  });

  test("an idle keep-alive connection does not hold shutdown", async () => {
    const { server } = await start(() => new Response("ok"));
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await c.until((s) => s.includes("ok"));
    const t0 = performance.now();
    await server.shutdown();
    assert(performance.now() - t0 < 1_000, "shutdown waited on an idle connection");
    await c.until(() => c.closed());
    assert(c.closed());
  });

  test("a keep-alive connection trickling its next request's headers does not hold shutdown", async () => {
    const { server } = await start(() => new Response("ok"));
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await c.until((s) => s.includes("ok"));
    c.write("GET /b HTTP/1.1\r\n");
    const trickle = setInterval(() => c.closed() || c.write("x-a: b\r\n"), 100);
    try {
      await sleep(150);
      const t0 = performance.now();
      await server.shutdown();
      assert(performance.now() - t0 < 1_000, "shutdown waited on the half-sent request");
      await c.until(() => c.closed());
    } finally {
      clearInterval(trickle);
    }
  });

  test("an aborted signal shuts the listener down", async () => {
    const stop = new AbortController();
    const { server, url } = await start(() => new Response("ok"), { signal: stop.signal });
    assertEquals(await (await fetch(url)).text(), "ok");
    stop.abort();
    await server.finished;
    await assertRejects(() => fetch(url));
  });

  test("an idle keep-alive connection is kept for keepAliveTimeoutMs, then closed", async () => {
    const { server } = await start(() => new Response("ok"), { keepAliveTimeoutMs: 300 });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await c.until((s) => s.includes("ok"));
    await c.until(() => c.closed(), 4_000);
    assert(c.closed(), "the idle connection outlived its keep-alive");

    // The default is long: a load balancer must always be the one to close first.
    const long = await start(() => new Response("ok"));
    const d = raw(long.server.addr.port);
    d.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await d.until((s) => s.includes("ok"));
    await sleep(2_500);
    assert(!d.closed(), "the default keep-alive closed an idle connection within seconds");
    d.socket.destroy();
  }, 10_000);
});

describe("WebSocket upgrades", () => {
  /** A WebSocket handler that echoes, with the socket kept for the test. */
  function echo(sockets: WebSocket[], opts?: { maxPayload?: number }): ServeHandler {
    return (req, info) => {
      if (req.headers.get("upgrade") !== "websocket") return new Response("plain");
      const { socket, response } = info.upgradeWebSocket(req, opts);
      socket.binaryType = "arraybuffer";
      sockets.push(socket);
      socket.onmessage = ({ data }) => socket.send(data);
      return response;
    };
  }

  test("a handler upgrades, and the socket behaves like a WebSocket", async () => {
    const sockets: WebSocket[] = [];
    const opened = Promise.withResolvers<void>();
    const { url } = await start((req, info) => {
      const handled = echo(sockets)(req, info) as Response;
      sockets[0]?.addEventListener("open", () => opened.resolve());
      assertEquals(sockets[0]?.readyState, WebSocket.CONNECTING);
      return handled;
    });
    const ws = new WebSocket(url.replace("http", "ws") + "/tunnel");
    ws.binaryType = "arraybuffer";
    const messages: unknown[] = [];
    const got = Promise.withResolvers<void>();
    ws.onmessage = ({ data }) => {
      messages.push(data);
      if (messages.length === 2) got.resolve();
    };
    await new Promise((r) => (ws.onopen = r));
    await opened.promise;
    assertEquals(sockets[0].readyState, WebSocket.OPEN);
    ws.send("text");
    ws.send(new Uint8Array([1, 2, 3]));
    await got.promise;
    assertEquals(messages[0], "text");
    assertEquals([...new Uint8Array(messages[1] as ArrayBuffer)], [1, 2, 3]);

    const serverClosed = Promise.withResolvers<{ code: number; reason: string }>();
    sockets[0].onclose = (ev) => serverClosed.resolve({ code: ev.code, reason: ev.reason });
    ws.close(4000, "bye");
    assertEquals(await serverClosed.promise, { code: 4000, reason: "bye" });
    assertEquals(sockets[0].readyState, WebSocket.CLOSED);
  });

  test("a socket its handler closed or terminated before the handshake is refused, never opened", async () => {
    for (const how of ["close", "terminate"] as const) {
      const events: string[] = [];
      let socket!: WebSocket & { terminate?(): void };
      const { url } = await start((req, info) => {
        const upgraded = info.upgradeWebSocket(req);
        socket = upgraded.socket;
        socket.onopen = () => events.push("open");
        socket.onerror = () => events.push("error");
        socket.onclose = () => events.push("close");
        if (how === "close") socket.close();
        else socket.terminate!();
        return upgraded.response;
      });
      const ws = new WebSocket(url.replace("http", "ws") + "/tunnel");
      const result = await new Promise<string>((resolve) => {
        ws.onopen = () => resolve("open");
        ws.onclose = () => resolve("refused");
      });
      assertEquals(result, "refused", how);
      await sleep(20);
      assertEquals(socket.readyState, WebSocket.CLOSED, how);
      assertEquals(events, ["close"], how);
    }
  });

  test("a socket its handler closed before the handshake and then threw ends closed, with no error", async () => {
    const events: string[] = [];
    let socket!: WebSocket;
    const { url } = await start((req, info) => {
      socket = info.upgradeWebSocket(req).socket;
      socket.onerror = () => events.push("error");
      socket.onclose = () => events.push("close");
      socket.close();
      throw new Error("the handler gave up");
    });
    const ws = new WebSocket(url.replace("http", "ws") + "/tunnel");
    const result = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onclose = () => resolve("refused");
    });
    assertEquals(result, "refused");
    await sleep(20);
    assertEquals(socket.readyState, WebSocket.CLOSED);
    assertEquals(events, ["close"]);
  });

  test("a handshake ws refuses (a bad key or version) ends the handler's socket closed, not connecting", async () => {
    for (const bad of ["sec-websocket-version: 99", "sec-websocket-key: short"]) {
      const events: string[] = [];
      let socket!: WebSocket;
      const { server } = await start((req, info) => {
        const upgraded = info.upgradeWebSocket(req);
        socket = upgraded.socket;
        socket.onopen = () => events.push("open");
        socket.onerror = () => events.push("error");
        socket.onclose = () => events.push("close");
        return upgraded.response;
      });
      const headers = ["sec-websocket-version: 13", "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ=="]
        .map((one) => one.split(":")[0] === bad.split(":")[0] ? bad : one);
      const c = raw(server.addr.port);
      c.write(
        "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
          headers.map((one) => `${one}\r\n`).join("") + "\r\n",
      );
      const got = await c.until((s) => s.includes("HTTP/1.1 "), 1_000);
      assert(!got.includes("101"), got);
      for (let i = 0; i < 100 && socket?.readyState !== WebSocket.CLOSED; i++) await sleep(10);
      c.socket.destroy();
      assertEquals(socket.readyState, WebSocket.CLOSED, bad);
      assertEquals(events, ["error", "close"], bad);
    }
  });

  // Bun 1.4.2's node:http lost every write to an upgrade socket that arrived on a reused
  // keep-alive connection (the 101 never reached the client); 1.4.3 fixed it, as Node has it.
  test("an upgrade on a reused keep-alive connection completes", async () => {
    const { server } = await start((req, info) => {
      if (req.headers.get("upgrade") !== "websocket") return new Response("plain");
      return info.upgradeWebSocket(req).response;
    });
    const c = raw(server.addr.port);
    c.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    await c.until((s) => s.includes("plain"));
    c.write(
      "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const got = await c.until((s) => s.includes("101"), 1_000);
    c.socket.destroy();
    assert(got.includes("HTTP/1.1 101"), got);
  });

  test("a handler that answers an upgrade request plainly refuses the upgrade with its status", async () => {
    const { server } = await start(() => new Response("nope", { status: 403 }));
    const c = raw(server.addr.port);
    c.write(
      "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const got = await c.until(() => c.closed());
    assert(got.startsWith("HTTP/1.1 403"), got);
    assert(got.endsWith("nope"), got);
  });

  test("an Upgrade that is not a WebSocket handshake is served as a plain request, body and all", async () => {
    // curl --http2 and Java's HttpClient offer h2c on an ordinary POST.
    let seen = "";
    const { server } = await start(async (req) => {
      seen = await req.text();
      return new Response(`got ${seen}`);
    });
    for (const upgrade of ["h2c", "websocket"]) {
      // The second has no Sec-WebSocket-Key: not a handshake either.
      const c = raw(server.addr.port);
      c.write(
        `POST /x HTTP/1.1\r\nhost: x\r\nconnection: Upgrade, HTTP2-Settings\r\nupgrade: ${upgrade}\r\n` +
          "http2-settings: AAMAAABkAARAAAAAAAIAAAAA\r\ncontent-length: 5\r\n\r\nhello",
      );
      const got = await c.until((s) => s.includes("got"));
      c.socket.destroy();
      assert(got.startsWith("HTTP/1.1 200"), got);
      assert(got.endsWith("got hello"), got);
    }
  });

  test("a refused upgrade streams its answer, and cancels it when the client goes", async () => {
    let pulled = 0;
    const cancelled = Promise.withResolvers<void>();
    const { server } = await start(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            await sleep(5);
            pulled++;
            c.enqueue(new Uint8Array(64 * 1024));
          },
          cancel: () => cancelled.resolve(),
        }, { highWaterMark: 0 }),
        { headers: { "content-type": "text/event-stream" } },
      )
    );
    const c = raw(server.addr.port);
    c.socket.pause();
    c.write(
      "GET /tail HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await sleep(500);
    // A client that reads nothing holds the producer back: it is not buffered whole in memory.
    assert(pulled < 100, `pulled ${pulled} chunks for a client that read nothing`);
    c.socket.destroy();
    await cancelled.promise;
  });

  test("an open WebSocket does not hold shutdown; finished waits for it", async () => {
    const sockets: WebSocket[] = [];
    const { server, url } = await start(echo(sockets));
    const ws = new WebSocket(url.replace("http", "ws") + "/tunnel");
    await new Promise((r) => (ws.onopen = r));
    const t0 = performance.now();
    await server.shutdown();
    assert(performance.now() - t0 < 1_000, "shutdown waited on an open WebSocket");
    assertEquals(sockets[0].readyState, WebSocket.OPEN);
    let finished = false;
    void server.finished.then(() => (finished = true));
    await sleep(50);
    assert(!finished, "finished settled with a WebSocket still open");
    sockets[0].close();
    await server.finished;
  });

  test("a client that hangs up before its handshake is answered aborts the handler's signal", async () => {
    const aborted = Promise.withResolvers<void>();
    const { server } = await start(async (req, info) => {
      req.signal.addEventListener("abort", () => aborted.resolve());
      await aborted.promise;
      return info.upgradeWebSocket(req).response;
    });
    const c = raw(server.addr.port);
    c.write(
      "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await sleep(50);
    // A FIN only: the socket is not destroyed, so no reset says it went.
    c.socket.end();
    await aborted.promise;
    await c.until(() => c.closed());
    assert(c.closed(), "the half-closed socket was kept");
  });

  test("upgradeWebSocket on a plain request throws", async () => {
    let threw: unknown;
    const { url } = await start((req, info) => {
      try {
        info.upgradeWebSocket(req);
      } catch (err) {
        threw = err;
      }
      return new Response("plain");
    });
    assertEquals(await (await fetch(url)).text(), "plain");
    assert(threw instanceof TypeError);
  });

  test("maxFragments 1 delivers whole messages and refuses a fragmented one at its second frame", async () => {
    // A masked client frame (the mask all zeros, so the payload goes as it is).
    const frame = (fin: boolean, opcode: number, payload: Uint8Array) =>
      new Uint8Array([
        (fin ? 0x80 : 0) | opcode,
        0x80 | payload.byteLength,
        0,
        0,
        0,
        0,
        ...payload,
      ]);
    for (const tail of ["one continuation", "a flood of empty continuations"] as const) {
      const delivered: number[] = [];
      const errors: string[] = [];
      let socket!: WebSocket & { terminate?(): void };
      const { server } = await start((req, info) => {
        const upgraded = info.upgradeWebSocket(req, { maxFragments: 1 });
        socket = upgraded.socket;
        socket.binaryType = "arraybuffer";
        socket.onmessage = ({ data }) => delivered.push((data as ArrayBuffer).byteLength);
        // As a tunnel does: a broken wire is terminated, not closed politely.
        socket.onerror = (ev) => {
          errors.push(String((ev as ErrorEvent).message));
          socket.terminate!();
        };
        return upgraded.response;
      });
      const c = raw(server.addr.port);
      c.write(
        "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: upgrade\r\n" +
          "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      await c.until((s) => s.includes("101"), 2_000);
      c.write(frame(true, 2, new Uint8Array(3)));
      await sleep(20);
      assertEquals(delivered, [3], tail);
      // The first of a fragmented message is held; the next frame of it is one too many.
      const first = frame(false, 2, new Uint8Array(4));
      if (tail === "one continuation") {
        c.write(first);
        await sleep(20);
        assertEquals(errors, [], "a first fragment alone is no error yet");
        c.write(frame(true, 0, new Uint8Array(4)));
      } else {
        const flood = new Uint8Array(first.byteLength + 1_000 * 6);
        flood.set(first);
        for (let at = first.byteLength; at < flood.byteLength; at += 6) {
          flood.set(frame(false, 0, new Uint8Array(0)), at);
        }
        c.write(flood);
      }
      for (let t = 0; t < 2_000 && !c.closed(); t += 10) await sleep(10);
      assert(c.closed(), `${tail}: the socket was not closed`);
      assertEquals(delivered, [3], tail);
      assertEquals(errors, ["Too many message fragments"], tail);
      assertEquals(socket.readyState, WebSocket.CLOSED, tail);
    }
  });

  test("a message past maxPayload closes the socket instead of being delivered", async () => {
    const sockets: WebSocket[] = [];
    const delivered: number[] = [];
    const { url } = await start((req, info) => {
      const { socket, response } = info.upgradeWebSocket(req, { maxPayload: 1024 });
      socket.binaryType = "arraybuffer";
      sockets.push(socket);
      socket.onmessage = ({ data }) => delivered.push((data as ArrayBuffer).byteLength);
      return response;
    });
    const ws = new WebSocket(url.replace("http", "ws"));
    const closed = new Promise<number>((r) => (ws.onclose = (ev) => r(ev.code)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(new Uint8Array(512));
    await sleep(50);
    ws.send(new Uint8Array(4096));
    // 1009, message too big; or 1006 where the client only sees the connection drop.
    expect([1006, 1009]).toContain(await closed);
    assertEquals(delivered, [512]);
  });
});
