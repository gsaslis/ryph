// `PreviewsService` over a standalone previews service. What these pin is the seam's contract:
// which answers are passed on, which are a definitive "no", and that everything else is a
// failure rather than a throw. `fetch` is stubbed so these stay socket-free.

import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  httpPreviews,
  ownerTunnelBase,
  replicaTunnelBases,
  tunnelBase,
} from "../src/adapters/previews/http.ts";
import { recordingDiagnostics, silentDiagnostics } from "./doubles.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";

interface Call {
  url: string;
  method?: string;
  auth: string | null;
  body?: string;
}

async function withFetch(
  reply: (call: Call) => Response | Promise<Response>,
  fn: (previews: ReturnType<typeof httpPreviews>, calls: Call[]) => Promise<void>,
  opts: { url?: string; tunnelUrl?: string; replicaHost?: string; diag?: Diagnostics } = {},
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
      httpPreviews({
        previewsUrl: opts.url ?? "http://previews.test:7493/",
        tunnelUrl: opts.tunnelUrl ?? "http://previews.test:7491",
        ...(opts.replicaHost === undefined ? {} : { replicaHost: opts.replicaHost }),
        previewsToken: "previews-token",
        diag: opts.diag ?? silentDiagnostics(),
      }),
      calls,
    );
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ID = "0123456789abcdef0123456789abcdef";
const URL_ = `https://${ID}.preview.ryph-previews.example`;
const INPUT = { runId: "run-1", port: 5173, label: "App", hosts: ["registry.npmjs.org"] };

test("register posts the run's preview to the API listener with the service token, and the tunnel is on the tunnel listener", async () => {
  await withFetch(() => json(201, { id: ID, url: URL_, ticket: "t/1 2" }), async (p, calls) => {
    assertEquals(await p.register(INPUT), {
      kind: "registered",
      id: ID,
      url: URL_,
      tunnel: "ws://previews.test:7491/tunnel/t%2F1%202",
    });
    assertEquals(calls[0].url, "http://previews.test:7493/internal/previews");
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].auth, "Bearer previews-token");
    assertEquals(JSON.parse(calls[0].body!), INPUT);
  });
});

test("an https service URL gives a wss tunnel", async () => {
  await withFetch(() => json(201, { id: ID, url: URL_, ticket: "abc" }), async (p) => {
    const outcome = await p.register(INPUT);
    assertEquals(outcome.kind === "registered" && outcome.tunnel, "wss://previews.test/tunnel/abc");
  }, { url: "https://previews.test:7493", tunnelUrl: "https://previews.test" });
  assertEquals(tunnelBase("http://a:7491//"), "ws://a:7491");
  assertThrows(() => tunnelBase("ftp://a"));
});

test("a run-facing address through a gate puts the tunnel there, and this process's calls stay direct", async () => {
  await withFetch(() => json(201, { id: ID, url: URL_, ticket: "abc" }), async (p, calls) => {
    const outcome = await p.register(INPUT);
    assertEquals(
      outcome.kind === "registered" && outcome.tunnel,
      "ws://ryph-gate-ryph:7491/tunnel/abc",
    );
    assertEquals(calls[0].url, "http://previews:7493/internal/previews");
  }, { url: "http://previews:7493", tunnelUrl: "http://ryph-gate-ryph:7491" });
});

test("a tunnel base the service names is where the runner dials, if it is a replica's own", async () => {
  // The API listener on its own port; the replicas' tunnel bases take the tunnel one's.
  const replicas = {
    url: "http://previews.ryph.svc:7493",
    tunnelUrl: "http://previews.ryph.svc:7491",
    replicaHost: "previews-{ordinal}.ryph.svc",
  };
  // The owning replica's own address, in place of the shared one.
  for (const k of [0, 2, 63]) {
    await withFetch(
      () =>
        json(201, {
          id: ID,
          url: URL_,
          ticket: "t/1",
          tunnelBase: `ws://previews-${k}.ryph.svc:7491`,
        }),
      async (p) => {
        const outcome = await p.register(INPUT);
        assertEquals(
          outcome.kind === "registered" && outcome.tunnel,
          `ws://previews-${k}.ryph.svc:7491/tunnel/t%2F1`,
        );
      },
      replicas,
    );
  }
  assertEquals(ownerTunnelBase("wss://previews-0.ryph.svc/"), "wss://previews-0.ryph.svc");
  assertEquals(ownerTunnelBase("ws://10.0.0.7:7491"), "ws://10.0.0.7:7491");
  const malformed = [
    "http://previews-0.ryph.svc:7491",
    "ws://previews-0.ryph.svc:7491/tunnel/other",
    "ws://previews-0.ryph.svc:7491/x",
    "ws://user:pw@previews-0.ryph.svc:7491",
    "ws://previews-0.ryph.svc:7491?x=1",
    "ws://previews-0.ryph.svc:7491#x",
    "ws://previews-0.ryph.svc:7491\\x",
    "javascript:alert(1)",
    "ws://",
    "",
  ];
  for (const base of malformed) assertEquals(ownerTunnelBase(base), null, base);
  assertEquals(
    replicaTunnelBases("https://previews.ryph.svc", "previews-{ordinal}.ryph.svc").size,
    64,
  );
  assert(
    replicaTunnelBases("https://previews.ryph.svc", "previews-{ordinal}.ryph.svc")
      .has("wss://previews-7.ryph.svc"),
  );
  assertEquals(replicaTunnelBases("http://previews.ryph.svc:7491", undefined).size, 0);
  assertEquals(replicaTunnelBases("http://previews.ryph.svc:7491", "previews.ryph.svc").size, 0);
  // Well-formed but not a replica's own: another host, port, scheme or ordinal; and any base at
  // all when no replica host is configured. Each fails the registration, and the log never holds
  // the ticket.
  const elsewhere = [
    "ws://evil.example:7491",
    "ws://previews-1.other.svc:7491",
    "ws://previews-1.ryph.svc:7492",
    // The API port is no tunnel base.
    "ws://previews-1.ryph.svc:7493",
    "ws://previews-1.ryph.svc",
    "wss://previews-1.ryph.svc:7491",
    "ws://previews-64.ryph.svc:7491",
    "ws://previews-01.ryph.svc:7491",
    "ws://previews.ryph.svc:7491",
  ];
  const cases = [
    ...[...malformed, ...elsewhere, "ws://" + "a".repeat(600)].map((base) => ({
      base,
      opts: replicas,
    })),
    {
      base: "ws://previews-1.ryph.svc:7491",
      opts: { url: replicas.url, tunnelUrl: replicas.tunnelUrl },
    },
  ];
  for (const { base, opts } of cases) {
    const { diag, events } = recordingDiagnostics();
    await withFetch(
      () => json(201, { id: ID, url: URL_, ticket: "secret-ticket", tunnelBase: base }),
      async (p) => {
        assertEquals((await p.register(INPUT)).kind, "failed", base);
      },
      { ...opts, diag },
    );
    assertEquals(events.map((e) => e.event), ["previews.register_failed"]);
    assertEquals(JSON.stringify(events).includes("secret-ticket"), false);
  }
});

test("findRun asks the service which run a preview is; 404 is missing", async () => {
  await withFetch(() => json(200, { runId: "run-1" }), async (p, calls) => {
    assertEquals(await p.findRun(ID), { kind: "run", runId: "run-1" });
    assertEquals(calls[0].url, `http://previews.test:7493/internal/previews/${ID}`);
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].auth, "Bearer previews-token");
  });
  // Not an id the service mints: nothing is asked.
  await withFetch(() => json(200, { runId: "run-1" }), async (p, calls) => {
    for (const id of ["../x", ID.toUpperCase(), `${ID}0`, "", "a/b"]) {
      assertEquals(await p.findRun(id), { kind: "missing" });
    }
    assertEquals(calls, []);
  });
  await withFetch(() => json(404, { error: "not found" }), async (p) => {
    assertEquals(await p.findRun(ID), { kind: "missing" });
  });
  for (
    const reply of [
      () => json(500, {}),
      () => json(200, {}),
      () => json(200, { runId: "../evil" }),
      () => new Response("not json"),
    ]
  ) {
    await withFetch(reply, async (p) => {
      assertEquals((await p.findRun(ID)).kind, "failed");
    });
  }
});

test("register passes the service's 400 and 429 on with their body", async () => {
  for (const status of [400, 429] as const) {
    await withFetch(() => json(status, { error: `nope ${status}` }), async (p) => {
      assertEquals(await p.register(INPUT), {
        kind: "refused",
        status,
        body: { error: `nope ${status}` },
      });
    });
  }
  await withFetch(() => new Response("busy", { status: 429 }), async (p) => {
    assertEquals(await p.register(INPUT), {
      kind: "refused",
      status: 429,
      body: { error: "preview limit reached" },
    });
  });
});

test("register fails, never throws, on anything else", async () => {
  const replies: Array<() => Response | Promise<Response>> = [
    () => json(500, { error: "boom" }),
    () => json(401, { error: "unauthorized" }),
    () => json(201, { id: ID, url: URL_ }), // no ticket
    () => json(201, { id: "../x", url: URL_, ticket: "t" }),
    () => json(201, { id: ID, url: "javascript:alert(1)", ticket: "t" }),
    () => new Response("not json", { status: 201 }),
    () => new Response("x".repeat(100_000), { status: 201 }),
    () => Promise.reject(new TypeError("connection refused")),
  ];
  for (const reply of replies) {
    const { diag, events } = recordingDiagnostics();
    await withFetch(reply, async (p) => {
      assertEquals((await p.register(INPUT)).kind, "failed");
    }, { diag });
    assertEquals(events.map((e) => e.event), ["previews.register_failed"]);
  }
});

test("list reads the run's open previews, path-encoded", async () => {
  const previews = [{ id: ID, port: 5173, label: "App", url: URL_ }];
  await withFetch(() => json(200, { previews }), async (p, calls) => {
    assertEquals(await p.list("run/1"), { kind: "previews", previews });
    assertEquals(calls[0].url, "http://previews.test:7493/internal/runs/run%2F1/previews");
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].auth, "Bearer previews-token");
  });
  for (const reply of [() => json(503, {}), () => json(200, { previews: [{ id: ID }] })]) {
    await withFetch(reply, async (p) => {
      assertEquals((await p.list("run-1")).kind, "failed");
    });
  }
});

test("openViewer asks for a viewer ticket for that run; 404 is missing", async () => {
  const enter = `${URL_}/__ryph/enter?ticket=abc`;
  await withFetch(() => json(200, { url: enter }), async (p, calls) => {
    assertEquals(await p.openViewer("run-1", ID), { kind: "url", url: enter });
    assertEquals(calls[0].url, `http://previews.test:7493/internal/previews/${ID}/viewer`);
    assertEquals(calls[0].method, "POST");
    assertEquals(JSON.parse(calls[0].body!), { runId: "run-1" });
    // Where the viewer lands, for the service to judge.
    await p.openViewer("run-1", ID, "/nodes/x?y=1");
    assertEquals(JSON.parse(calls[1].body!), { runId: "run-1", path: "/nodes/x?y=1" });
  });
  await withFetch(() => json(404, { error: "not found" }), async (p) => {
    assertEquals(await p.openViewer("run-1", ID), { kind: "missing" });
  });
  await withFetch(() => json(500, {}), async (p) => {
    assertEquals((await p.openViewer("run-1", ID)).kind, "failed");
  });
  // An id that is not an id never leaves this process.
  await withFetch(() => json(200, { url: enter }), async (p, calls) => {
    assertEquals(await p.openViewer("run-1", "../../internal"), { kind: "missing" });
    assertEquals(calls.length, 0);
  });
});

test("closeRun is fire and forget: it returns at once and swallows every failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const { diag, events } = recordingDiagnostics();
  await withFetch(async () => {
    await gate;
    throw new TypeError("connection refused");
  }, async (p, calls) => {
    p.closeRun("run-1"); // returns before the service has answered
    assertEquals(calls[0].url, "http://previews.test:7493/internal/runs/run-1");
    assertEquals(calls[0].method, "DELETE");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }, { diag });
  assertEquals(events.map((e) => e.event), ["previews.close_failed"]);
});
