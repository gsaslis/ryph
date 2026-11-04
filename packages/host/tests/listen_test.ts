// A listener that cannot bind its configured address fails as a named configuration error, not
// as an unhandled `error` event, except the address runs dial found after boot, which is bound
// late and waited for.

import { test } from "bun:test";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type HttpServer, serve as serveHttp, type ServeOptions } from "@ryph/service";
import {
  bindErrorKind,
  bindFailure,
  bindOrder,
  classifyBind,
  lateRunAddress,
  serveOn,
} from "../src/listen.ts";

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const notAvailable = () => coded("EADDRNOTAVAIL", "listen EADDRNOTAVAIL: address not available");
const inUse = () => coded("EADDRINUSE", "listen EADDRINUSE: address already in use");

test("an address no interface has names the variable and the dockerd ordering", () => {
  const err = Object.assign(new Error("listen EADDRNOTAVAIL: address not available"), {
    code: "EADDRNOTAVAIL",
  });
  const message = bindFailure("the egress proxy", "RYPH_EGRESS_BIND", "172.17.0.1", 7460, err);
  assertStringIncludes(message, "the egress proxy cannot listen on 172.17.0.1:7460");
  assertStringIncludes(message, "RYPH_EGRESS_BIND=172.17.0.1");
  assertStringIncludes(message, "start ryph after docker");
  // Deno's node:http on macOS: measured, binding an address no interface has was EINVAL.
  const einval = Object.assign(new Error("listen EINVAL: invalid argument 172.17.0.1:7460"), {
    code: "EINVAL",
  });
  assertStringIncludes(
    bindFailure("the egress proxy", "RYPH_EGRESS_BIND", "172.17.0.1", 7460, einval),
    "start ryph after docker",
  );
});

/** A `serve` that answers on loopback and has no `missing` address until `appear()`. */
function fakeServe(missing: string) {
  let present = false;
  const bound: string[] = [];
  const serve = (options: ServeOptions): Promise<HttpServer> => {
    if (options.hostname === missing && !present) {
      return Promise.reject(notAvailable());
    }
    bound.push(options.hostname!);
    return Promise.resolve({
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: options.hostname!, port: options.port! },
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as HttpServer);
  };
  return { serve, bound, appear: () => (present = true) };
}

test("a run's address found after boot is bound, and waited for while missing", async () => {
  const fake = fakeServe("192.168.64.1");
  const waiting: string[] = [];
  const bound = Promise.withResolvers<string>();
  const later = Promise.withResolvers<string | null>();
  const server = await serveOn({
    binds: ["127.0.0.1"],
    later: later.promise,
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: (m) => waiting.push(m),
    onBound: (h) => bound.resolve(h),
    serve: fake.serve,
    retryMs: 10,
  });
  try {
    assertEquals(fake.bound, ["127.0.0.1"]);
    later.resolve("192.168.64.1");
    await new Promise((r) => setTimeout(r, 30));
    // Missing is waited for in silence: the host said why when it started looking.
    assertEquals(waiting, []);
    assertEquals(fake.bound, ["127.0.0.1"]);
    fake.appear();
    // The retry timer is unref'd, so something here has to hold the event loop open for it.
    const hold = setTimeout(() => {}, 1_000);
    try {
      assertEquals(await bound.promise, "192.168.64.1");
    } finally {
      clearTimeout(hold);
    }
    assertEquals(fake.bound, ["127.0.0.1", "192.168.64.1"]);
  } finally {
    await server.shutdown();
  }
});

test("shutting down stops waiting for an address that never appears", async () => {
  const fake = fakeServe("192.168.64.1");
  const server = await serveOn({
    binds: ["127.0.0.1"],
    later: Promise.resolve("192.168.64.1"),
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: () => {},
    onBound: () => {},
    serve: fake.serve,
    retryMs: 10,
  });
  await new Promise((r) => setTimeout(r, 0));
  // A timer left running would keep the test process up.
  await server.shutdown();
  assertEquals(fake.bound, ["127.0.0.1"]);
});

test("an address RYPH_BIND lists that is missing is fatal", async () => {
  const fake = fakeServe("10.0.0.55");
  const shutDown: string[] = [];
  const serve = async (options: ServeOptions): Promise<HttpServer> => {
    const server = await fake.serve(options);
    return { ...server, shutdown: () => (shutDown.push(options.hostname!), Promise.resolve()) };
  };
  await assertRejects(
    () =>
      serveOn({
        binds: ["127.0.0.1", "10.0.0.55", "192.168.64.1"],
        port: 7411,
        variable: "RYPH_BIND",
        what: "the control plane",
        options: {},
        handler: () => new Response(),
        onWaiting: () => {},
        onBound: () => {},
        serve,
      }),
    Error,
    "cannot listen on 10.0.0.55:7411 (RYPH_BIND=10.0.0.55)",
  );
  assertEquals(shutDown, ["127.0.0.1"]);
});

/** A fake listener that records ref/unref and finishes only once shut down. */
function trackedServe(missing: string) {
  let present = false;
  const refs: Record<string, boolean> = {};
  const serve = (options: ServeOptions): Promise<HttpServer> => {
    const hostname = options.hostname!;
    if (hostname === missing && !present) {
      return Promise.reject(notAvailable());
    }
    refs[hostname] = true;
    const done = Promise.withResolvers<void>();
    return Promise.resolve({
      finished: done.promise,
      addr: { transport: "tcp", hostname, port: options.port! },
      shutdown: () => (done.resolve(), Promise.resolve()),
      ref: () => (refs[hostname] = true),
      unref: () => (refs[hostname] = false),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as HttpServer);
  };
  return { serve, refs, appear: () => (present = true) };
}

test("a listener bound late takes the last unref, and `finished` waits for it", async () => {
  const fake = trackedServe("192.168.64.1");
  const bound = Promise.withResolvers<string>();
  const server = await serveOn({
    binds: ["127.0.0.1"],
    later: Promise.resolve("192.168.64.1"),
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: () => {},
    onBound: (h) => bound.resolve(h),
    serve: fake.serve,
    retryMs: 5,
  });
  let finished = false;
  server.finished.then(() => (finished = true));
  server.unref();
  fake.appear();
  const hold = setTimeout(() => {}, 1_000);
  try {
    assertEquals(await bound.promise, "192.168.64.1");
  } finally {
    clearTimeout(hold);
  }
  assertEquals(fake.refs, { "127.0.0.1": false, "192.168.64.1": false });
  server.ref();
  assertEquals(fake.refs, { "127.0.0.1": true, "192.168.64.1": true });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(finished, false);
  await server.shutdown();
  await server.finished;
  assertEquals(finished, true);
});

test("`finished` read while still waiting resolves on shutdown, timer stopped", async () => {
  const fake = trackedServe("192.168.64.1");
  const server = await serveOn({
    binds: ["127.0.0.1"],
    later: Promise.resolve("192.168.64.1"),
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: () => {},
    onBound: () => {},
    serve: fake.serve,
    retryMs: 5,
  });
  const finished = server.finished;
  await new Promise((r) => setTimeout(r, 0));
  await server.shutdown();
  await finished;
});

test("bindErrorKind reads every spelling the bind decisions use", () => {
  assertEquals(bindErrorKind(coded("EADDRNOTAVAIL", "listen EADDRNOTAVAIL")), "missing");
  // node:http under Deno on macOS: a missing address was EINVAL.
  assertEquals(bindErrorKind(coded("EINVAL", "listen EINVAL: invalid argument")), "missing");
  assertEquals(bindErrorKind(coded("EADDRINUSE", "listen EADDRINUSE")), "in-use");
  assertEquals(bindErrorKind(coded("EAFNOSUPPORT", "listen EAFNOSUPPORT: ::1")), "unsupported");
  assertEquals(bindErrorKind(coded("EACCES", "listen EACCES: permission denied")), "other");
  assertEquals(bindErrorKind("weird"), "other");
});

test("loopback missing, or nothing bound at all, is still a configuration error", async () => {
  const fake = fakeServe("192.168.64.1");
  const base = {
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: () => {},
    onBound: () => {},
    serve: fake.serve,
  };
  await assertRejects(
    () => serveOn({ ...base, binds: ["192.168.64.1"] }),
    Error,
    "cannot listen on",
  );
  const loopbackGone = fakeServe("127.0.0.1");
  await assertRejects(
    () => serveOn({ ...base, serve: loopbackGone.serve, binds: ["127.0.0.1", "10.0.0.5"] }),
    Error,
    "cannot listen on 127.0.0.1",
  );
});

test("a retry that fails for another reason is said once, named, and still retried", async () => {
  let attempts = 0;
  let free = false;
  const bound = Promise.withResolvers<string>();
  const waiting: [string, string][] = [];
  const serve = (options: ServeOptions): Promise<HttpServer> => {
    if (options.hostname === "192.168.64.1") {
      attempts++;
      // Missing at first, then there but the port held by something else, then free.
      if (attempts === 1) return Promise.reject(notAvailable());
      if (!free) return Promise.reject(inUse());
    }
    return Promise.resolve({
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: options.hostname!, port: options.port! },
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as HttpServer);
  };
  const server = await serveOn({
    binds: ["127.0.0.1"],
    later: Promise.resolve("192.168.64.1"),
    port: 7411,
    variable: "RYPH_BIND",
    what: "the control plane",
    options: {},
    handler: () => new Response(),
    onWaiting: (m, h) => waiting.push([h, m]),
    onBound: (h) => bound.resolve(h),
    serve,
    retryMs: 5,
  });
  const hold = setTimeout(() => {}, 1_000);
  try {
    while (attempts < 5) await new Promise((r) => setTimeout(r, 5));
    free = true;
    assertEquals(await bound.promise, "192.168.64.1");
    assertEquals(waiting.map(([h]) => h), ["192.168.64.1"]);
    assertStringIncludes(waiting[0][1], "already listening there");
  } finally {
    clearTimeout(hold);
    await server.shutdown();
  }
});

/** A `serve` where `::` is dual-stack (`dualStack`) or v6-only, and records what it bound. */
function wildcardServe(dualStack: boolean) {
  const bound: string[] = [];
  const serve = (options: ServeOptions): Promise<HttpServer> => {
    if (dualStack && bound.includes("::") && /^\d/.test(options.hostname!)) {
      return Promise.reject(inUse());
    }
    bound.push(options.hostname!);
    return Promise.resolve({
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: options.hostname!, port: options.port! },
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as HttpServer);
  };
  return { serve, bound };
}

test("IPv4 beside `::` is skipped where `::` already holds it, bound where it does not", async () => {
  for (const dualStack of [true, false]) {
    const fake = wildcardServe(dualStack);
    const waiting: string[] = [];
    const server = await serveOn({
      binds: ["::", "127.0.0.1", "172.17.0.1"],
      port: 7411,
      variable: "RYPH_BIND",
      what: "the control plane",
      options: {},
      handler: () => new Response(),
      onWaiting: (m) => waiting.push(m),
      onBound: () => {},
      serve: fake.serve,
    });
    assertEquals(fake.bound, dualStack ? ["::"] : ["::", "127.0.0.1", "172.17.0.1"]);
    assertEquals(waiting, []);
    await server.shutdown();
  }
  // Taken without `::` bound before it is still the named error.
  await assertRejects(
    () =>
      serveOn({
        binds: ["127.0.0.1"],
        port: 7411,
        variable: "RYPH_BIND",
        what: "the control plane",
        options: {},
        handler: () => new Response(),
        onWaiting: () => {},
        onBound: () => {},
        serve: () => Promise.reject(inUse()),
      }),
    Error,
    "already listening",
  );
});

test("one bind policy for both listener sets: what to try, and what a failure means", () => {
  assertEquals(bindOrder(["127.0.0.1", "10.0.0.5"], ["::1", "10.0.0.5"]), [
    "127.0.0.1",
    "10.0.0.5",
    "::1",
  ]);
  const missing = notAvailable();
  const einval = Object.assign(new Error("listen EINVAL: invalid argument"), { code: "EINVAL" });
  const taken = inUse();
  const noFamily = Object.assign(new Error("listen EAFNOSUPPORT: ::1"), { code: "EAFNOSUPPORT" });
  // An IPv4 address taken while `::` holds the port is covered, never an error.
  assertEquals(classifyBind("127.0.0.1", taken, { bound: ["::"] }), "covered");
  assertEquals(classifyBind("127.0.0.1", taken, { bound: [] }), "fatal");
  // An optional address the machine lacks is skipped; held by something else, it is fatal.
  assertEquals(classifyBind("::1", einval, { bound: [], optional: true }), "skip");
  assertEquals(classifyBind("::1", noFamily, { bound: [], optional: true }), "skip");
  assertEquals(classifyBind("::1", taken, { bound: [], optional: true }), "fatal");
  // A run's address not there yet is waited for where the caller retries; loopback never is.
  assertEquals(classifyBind("192.168.64.1", missing, { bound: [], waitable: true }), "wait");
  assertEquals(classifyBind("192.168.64.1", missing, { bound: [] }), "fatal");
  assertEquals(classifyBind("127.0.0.1", missing, { bound: [], waitable: true }), "fatal");
  assertEquals(classifyBind("192.168.64.1", taken, { bound: [], waitable: true }), "fatal");
});

test("a fatal bind shuts down the listeners that bound before it", async () => {
  const shutDown: string[] = [];
  const serve = (options: ServeOptions): Promise<HttpServer> => {
    if (options.hostname === "10.0.0.5") return Promise.reject(inUse());
    return Promise.resolve({
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: options.hostname!, port: options.port! },
      shutdown: () => {
        shutDown.push(options.hostname!);
        return Promise.resolve();
      },
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as HttpServer);
  };
  await assertRejects(
    () =>
      serveOn({
        binds: ["127.0.0.1", "10.0.0.5"],
        port: 7411,
        variable: "RYPH_BIND",
        what: "the control plane",
        options: {},
        handler: () => new Response(),
        onWaiting: () => {},
        onBound: () => {},
        serve,
      }),
    Error,
    "cannot listen on 10.0.0.5",
  );
  assertEquals(shutDown, ["127.0.0.1"]);
});

test("a late bind settles at once on nothing to bind, or an address already bound", async () => {
  for (const later of [null, "127.0.0.1"]) {
    const fake = trackedServe("192.168.64.1");
    const server = await serveOn({
      binds: ["127.0.0.1"],
      later: Promise.resolve(later),
      port: 7411,
      variable: "RYPH_BIND",
      what: "the control plane",
      options: {},
      handler: () => new Response(),
      onWaiting: () => {},
      onBound: () => {},
      serve: fake.serve,
      retryMs: 5,
    });
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(Object.keys(fake.refs), ["127.0.0.1"]);
    await server.shutdown();
    await server.finished;
  }
});

test("lateRunAddress asks until there is an answer, and gives up on abort", async () => {
  const hold = setTimeout(() => {}, 1_000);
  try {
    let asked = 0;
    const answers = [null, null, { address: "172.17.0.1" }];
    const found = await lateRunAddress({
      detect: () => Promise.resolve(answers[asked++]),
      signal: new AbortController().signal,
      retryMs: 1,
    });
    assertEquals([found, asked], ["172.17.0.1", 3]);
    // Docker answered, and its bridge is not this machine's: nothing to bind, and no more asking.
    assertEquals(
      await lateRunAddress({
        detect: () => Promise.resolve({ address: null }),
        signal: new AbortController().signal,
        retryMs: 1,
      }),
      null,
    );
    const stop = new AbortController();
    const never = lateRunAddress({
      detect: () => Promise.reject(new Error("docker is not running")),
      signal: stop.signal,
      retryMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    assertEquals(await never, null);
  } finally {
    clearTimeout(hold);
  }
});

test("lateRunAddress waits twice as long after every look that finds nothing, up to its cap", async () => {
  const waits: number[] = [];
  let asked = 0;
  const found = await lateRunAddress({
    detect: () => Promise.resolve(++asked < 7 ? null : { address: "172.17.0.1" }),
    signal: new AbortController().signal,
    setTimer: (fn, ms) => {
      waits.push(ms);
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  });
  assertEquals(found, "172.17.0.1");
  assertEquals(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
});

test("a missing address reads as missing through the real listeners, not as a port taken", async () => {
  // 192.0.2.1 is TEST-NET-1: never one of this machine's addresses. Bun's node:http calls that
  // EADDRINUSE; @ryph/service's serve asks node:net, which says EADDRNOTAVAIL.
  const viaServe = await serveHttp(
    { hostname: "192.0.2.1", port: 0, onListen: () => {} },
    () => new Response(),
  ).then(() => null, (err) => err);
  assertEquals(bindErrorKind(viaServe), "missing");
  await assertRejects(
    () =>
      serveOn({
        binds: ["127.0.0.1", "192.0.2.1"],
        port: 0,
        variable: "RYPH_BIND",
        what: "the control plane",
        options: {},
        handler: () => new Response(),
        onWaiting: () => {},
        onBound: () => {},
      }),
    Error,
    "no interface on this machine has that address",
  );
  // A port really taken is still in use.
  const taken = await serveHttp(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () => new Response(),
  );
  try {
    const err = await serveHttp(
      { hostname: "127.0.0.1", port: taken.addr.port, onListen: () => {} },
      () => new Response(),
    ).then(() => null, (e) => e);
    assertEquals(bindErrorKind(err), "in-use");
  } finally {
    await taken.shutdown();
  }
});
