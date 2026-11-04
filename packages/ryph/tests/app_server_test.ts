// The embedded app's environment, as adapter-node reads it at import. The body limit is the one
// that bites: its default refuses any check bundle over 512 KiB before the proxy sees it.

import { test } from "bun:test";
import http from "node:http";
import net from "node:net";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { allowedHosts, misdirected } from "@ryph/host";
import {
  APP_BODY_SIZE_LIMIT,
  appBinds,
  appEnv,
  appReach,
  forgeHooksUrl,
  forgeHookTarget,
  guardApp,
  listenAll,
} from "../src/app_server.ts";
import { appOrigin } from "../src/main.ts";

const opts = { origin: "http://localhost:3000", apiUrl: "http://localhost:7411" };

test("the embedded app gets the origin, the control plane and a body limit a bundle fits", () => {
  assertEquals(appEnv(opts, () => undefined), {
    ORIGIN: "http://localhost:3000",
    RYPH_API_URL: "http://localhost:7411",
    BODY_SIZE_LIMIT: APP_BODY_SIZE_LIMIT,
    PUBLIC_GITLAB_URL: "https://gitlab.com",
    PUBLIC_GITLAB_CLIENT_ID: "",
  });
  assertEquals(APP_BODY_SIZE_LIMIT, "110M");
});

test("GitLab sign-in on the app is the forge's own OAuth application and instance", () => {
  // A bot configured by hand links people through GitLab sign-in: the app's half of the pair
  // must be the forge's, as compose.yaml derives it.
  const env = appEnv(opts, (n) =>
    ({
      RYPH_FORGE_URL: "embedded",
      RYPH_GITLAB_URL: "https://git.example.com/gitlab",
      RYPH_GITLAB_CLIENT_ID: "gl-app",
      PUBLIC_GITLAB_CLIENT_ID: "something-else",
    } as Record<string, string>)[n]);
  assertEquals(env.PUBLIC_GITLAB_URL, "https://git.example.com/gitlab");
  assertEquals(env.PUBLIC_GITLAB_CLIENT_ID, "gl-app");
  // Unset, gitlab.com, and no sign-in button: never a stale client id the forge cannot redeem.
  const bare = appEnv(
    opts,
    (n) =>
      ({ RYPH_FORGE_URL: "embedded", PUBLIC_GITLAB_CLIENT_ID: "stale" } as Record<string, string>)[
        n
      ],
  );
  assertEquals(bare.PUBLIC_GITLAB_URL, "https://gitlab.com");
  assertEquals(bare.PUBLIC_GITLAB_CLIENT_ID, "");
});

test("beside a remote forge, the app's own GitLab sign-in settings are kept", () => {
  // RYPH_FORGE_URL names a forge elsewhere, so the pair the app must match is that forge's,
  // which this process cannot see: PUBLIC_GITLAB_* set here (as for GitHub) win, and
  // RYPH_GITLAB_URL / RYPH_GITLAB_CLIENT_ID stand in for them only when they are unset.
  const remote = { RYPH_FORGE_URL: "https://forge.internal:7412" };
  const explicit = appEnv(opts, (n) =>
    ({
      ...remote,
      PUBLIC_GITLAB_URL: "https://git.example.com",
      PUBLIC_GITLAB_CLIENT_ID: "gl-app",
    } as Record<string, string>)[n]);
  assertEquals(explicit.PUBLIC_GITLAB_URL, "https://git.example.com");
  assertEquals(explicit.PUBLIC_GITLAB_CLIENT_ID, "gl-app");
  const derived = appEnv(opts, (n) =>
    ({
      ...remote,
      RYPH_GITLAB_URL: "https://git.example.com/gitlab",
      RYPH_GITLAB_CLIENT_ID: "gl-forge",
    } as Record<string, string>)[n]);
  assertEquals(derived.PUBLIC_GITLAB_URL, "https://git.example.com/gitlab");
  assertEquals(derived.PUBLIC_GITLAB_CLIENT_ID, "gl-forge");
  const none = appEnv(opts, (n) => (remote as Record<string, string>)[n]);
  assertEquals(none.PUBLIC_GITLAB_URL, "https://gitlab.com");
  assertEquals(none.PUBLIC_GITLAB_CLIENT_ID, "");
});

test("an operator's own body limit is kept", () => {
  assertEquals(
    appEnv(opts, (n) => n === "BODY_SIZE_LIMIT" ? "2G" : undefined).BODY_SIZE_LIMIT,
    "2G",
  );
});

test("the app's origin is RYPH_APP_URL's, so a deployment behind a domain passes the CSRF check", () => {
  assertEquals(appOrigin("https://ryph.example.com/", 3000), "https://ryph.example.com");
  assertEquals(
    appOrigin("https://ryph.example.com:8443/app", 3000),
    "https://ryph.example.com:8443",
  );
  assertEquals(appOrigin("http://localhost:3000", 3000), "http://localhost:3000");
  // Unset: loopback on the app's own port.
  assertEquals(appOrigin(undefined, 3001), "http://localhost:3001");
  assertEquals(appOrigin("", 3001), "http://localhost:3001");
  assertEquals(appOrigin("  ", 3001), "http://localhost:3001");
});

test("a RYPH_APP_URL auth would refuse is refused here too, not swapped for loopback", () => {
  for (const bad of ["ryph.example.com", "localhost:5173", "ftp://ryph.example.com"]) {
    assertThrows(
      () => appOrigin(bad, 3001),
      Error,
      "RYPH_APP_URL must be an absolute http(s) URL",
    );
  }
});

test("RYPH_APP_URL has to name an address the app listens on", () => {
  const loopback = appBinds(undefined);
  for (const url of ["http://localhost:7410", "http://127.0.0.1:7410", "http://[::1]:7410"]) {
    assertEquals(appReach(url, loopback, 7410), null);
  }
  // An address literal nothing listens on: refused, naming the setting that would bind it.
  const lan = appReach("http://192.168.1.5:7410", loopback, 7410);
  assert(lan !== null && "refuse" in lan);
  assertStringIncludes(lan.refuse, "RYPH_APP_BIND");
  const v6 = appReach("http://[fd00::5]:7410", loopback, 7410);
  assert(v6 !== null && "refuse" in v6);
  // Bound, or covered by a wildcard of its family.
  assertEquals(appReach("http://192.168.1.5:7410", appBinds("192.168.1.5"), 7410), null);
  assertEquals(appReach("http://[fd00::5]:7410", appBinds("fd00::5"), 7410), null);
  assertEquals(appReach("http://192.168.1.5:7410", appBinds("0.0.0.0"), 7410), null);
  assertEquals(appReach("http://[fd00::5]:7410", appBinds("::"), 7410), null);
  assert("refuse" in (appReach("http://[fd00::5]:7410", appBinds("0.0.0.0"), 7410) ?? {}));
  // A name may be a reverse proxy delivering to loopback: warned of while only loopback is bound.
  const name = appReach("http://mybox.lan:7410", loopback, 7410);
  assert(name !== null && "warn" in name);
  assertStringIncludes(name.warn, "RYPH_APP_BIND");
  assertEquals(appReach("https://ryph.example.com", appBinds("10.0.0.5"), 7410), null);
  // An address on another port is something else on this machine (a reverse proxy, a forward)
  // that may deliver to loopback: warned of, never refused.
  const proxied = appReach("http://192.168.1.5", loopback, 7410);
  assert(proxied !== null && "warn" in proxied);
  const forwarded = appReach("http://100.64.0.5:8080", loopback, 7410);
  assert(forwarded !== null && "warn" in forwarded);
});

test("the app listens on both loopbacks, and on whatever RYPH_APP_BIND adds", () => {
  assertEquals(appBinds(undefined), { required: ["127.0.0.1"], optional: ["::1"] });
  assertEquals(appBinds("10.0.0.5"), { required: ["127.0.0.1", "10.0.0.5"], optional: ["::1"] });
  assertEquals(appBinds("0.0.0.0"), { required: ["0.0.0.0"], optional: ["::1"] });
  assertEquals(appBinds("::"), { required: ["::", "127.0.0.1"], optional: [] });
  assertEquals(appBinds("::1"), { required: ["127.0.0.1", "::1"], optional: [] });
  // `localhost` is 127.0.0.1, not a second claim on ::1 beside the optional one.
  assertEquals(appBinds("localhost"), { required: ["127.0.0.1"], optional: ["::1"] });
  assertEquals(appBinds("[::1]"), { required: ["127.0.0.1", "::1"], optional: [] });
  assertEquals(appBinds("0.0.0.0,127.0.0.1"), { required: ["0.0.0.0"], optional: ["::1"] });
});

/** A raw listener on `hostname`:`port`, rejecting with the bind error. */
function listenNet(hostname: string, port: number): Promise<net.Server> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve(server));
  });
}

const closeNet = (server: net.Server) => new Promise((r) => server.close(r));

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const l = await listenNet("127.0.0.1", 0);
  const port = (l.address() as net.AddressInfo).port;
  await closeNet(l);
  return port;
}

// These tests exercise local listeners, not the deployment's outbound proxy configuration.
// In particular, an older check launcher may not yet bypass IPv6 loopback in NO_PROXY.
const localFetch = (url: string): Promise<Response> =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve(new Response(body, { status: res.statusCode })));
      res.on("error", reject);
    }).on("error", reject);
  });

const closeAll = (servers: http.Server[]) =>
  Promise.all(servers.map((s) => new Promise((r) => s.close(r))));

/** Whether ::1 can be bound here at all; a machine without IPv6 skips those checks. */
async function hasIpv6Loopback(): Promise<boolean> {
  try {
    await closeNet(await listenNet("::1", 0));
    return true;
  } catch {
    return false;
  }
}

test("`localhost` reaches only the app: ::1 is bound beside 127.0.0.1, and a holder of it is fatal", async () => {
  const port = await freePort();
  const servers = await listenAll((_req, res) => res.end("ryph"), appBinds(undefined), port);
  try {
    assertEquals(await (await localFetch(`http://127.0.0.1:${port}/`)).text(), "ryph");
    if (await hasIpv6Loopback()) {
      assertEquals(await (await localFetch(`http://[::1]:${port}/`)).text(), "ryph");
    }
  } finally {
    await closeAll(servers);
  }
  if (!(await hasIpv6Loopback())) return;
  const squatter = await listenNet("::1", port);
  try {
    const err = await assertRejects(() =>
      listenAll((_req, res) => res.end("ryph"), appBinds(undefined), port)
    );
    assertStringIncludes(String(err), "::1");
    // Nothing is left listening on 127.0.0.1 after the refusal.
    const again = await listenAll((_req, res) => res.end("ok"), {
      required: ["127.0.0.1"],
      optional: [],
    }, port);
    await closeAll(again);
  } finally {
    await closeNet(squatter);
  }
});

test("a name the app does not answer to gets the control plane's own 421", async () => {
  const port = await freePort();
  const app = guardApp(
    (_req, res) => res.end("ryph"),
    allowedHosts({
      binds: ["127.0.0.1"],
      urls: [],
      extra: undefined,
    }),
  );
  const servers = await listenAll(app, { required: ["127.0.0.1"], optional: [] }, port);
  const get = (host: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on(
          "end",
          () =>
            resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body }),
        );
      }).on("error", reject);
    });
  try {
    assertEquals((await get(`localhost:${port}`)).body, "ryph");
    const refused = await get("evil.example");
    const expected = misdirected("evil.example");
    assertEquals(refused.status, expected.status);
    assertEquals(refused.type, expected.headers.get("content-type"));
    assertEquals(refused.body, await expected.text());
  } finally {
    await closeAll(servers);
  }
});

test("`::` leaves 127.0.0.1 answering, bound beside it or covered by it", async () => {
  if (!(await hasIpv6Loopback())) return;
  const port = await freePort();
  const servers = await listenAll((_req, res) => res.end("ryph"), appBinds("::"), port);
  try {
    assertEquals(await (await localFetch(`http://127.0.0.1:${port}/`)).text(), "ryph");
    assertEquals(await (await localFetch(`http://[::1]:${port}/`)).text(), "ryph");
  } finally {
    await closeAll(servers);
  }
});

test("a listening server's later error is reported, not thrown at the process", async () => {
  const port = await freePort();
  const errors: string[] = [];
  const servers = await listenAll(
    (_req, res) => res.end("ryph"),
    { required: ["127.0.0.1"], optional: [] },
    port,
    {},
    (err) => errors.push(err.message),
  );
  try {
    servers[0].emit("error", new Error("accept EMFILE"));
    assertEquals(errors, ["accept EMFILE"]);
    assertEquals(await (await localFetch(`http://127.0.0.1:${port}/`)).text(), "ryph");
  } finally {
    await closeAll(servers);
  }
});

/** One request to 127.0.0.1:`port` under `host`, as a webhook sender would send it. */
const deliver = (
  port: number,
  o: {
    method: string;
    path: string;
    host: string;
    headers?: Record<string, string>;
    body?: string;
  },
) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: o.method,
          path: o.path,
          headers: { host: o.host, ...o.headers },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => body += c);
          res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        },
      ).on("error", reject);
      req.end(o.body);
    },
  );

test("the front door hands GitLab's and GitHub's webhook deliveries to the forge, and nothing else", async () => {
  // The forge's stand-in: what reached it, and an answer of its own to relay.
  const seen: { method: string; path: string; token: string | null; body: string }[] = [];
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        token: req.headers.get("x-gitlab-token"),
        body: await req.text(),
      });
      return new Response("queued", { status: 202, headers: { "x-forge": "yes" } });
    },
  });
  const port = await freePort();
  const app = guardApp(
    (_req, res) => res.end("ryph"),
    allowedHosts({ binds: ["127.0.0.1"], urls: [], extra: undefined }),
    `http://127.0.0.1:${forge.port}`,
  );
  const servers = await listenAll(app, { required: ["127.0.0.1"], optional: [] }, port);
  try {
    // The URL the repo page shows, under the public name GitLab was handed (a tunnel's, which
    // the app's Host check does not know): the forge's own answer comes back.
    const body = JSON.stringify({ object_kind: "note" });
    const gitlab = await deliver(port, {
      method: "POST",
      path: "/v1/hooks/gitlab?project=42&generation=3",
      host: "ryph.tunnel.example",
      headers: { "content-type": "application/json", "x-gitlab-token": "tok" },
      body,
    });
    assertEquals(gitlab.status, 202);
    assertEquals(gitlab.body, "queued");
    assertEquals(gitlab.headers["x-forge"], "yes");
    assertEquals(seen, [{
      method: "POST",
      path: "/v1/hooks/gitlab?project=42&generation=3",
      token: "tok",
      body,
    }]);
    const github = await deliver(port, {
      method: "POST",
      path: "/v1/hooks/github",
      host: "ryph.tunnel.example",
      body: "{}",
    });
    assertEquals(github.status, 202);
    assertEquals(seen.length, 2);

    // Every other forge route stays where it was: the app's, behind the Host check.
    seen.length = 0;
    for (
      const [method, path] of [
        ["GET", "/v1/hooks/gitlab"],
        ["POST", "/v1/hooks/radicle"],
        ["POST", "/v1/hooks/gitlab/x"],
        ["POST", "/v1/hooks/gitlabx"],
        ["POST", "/v1/hooks/"],
        ["POST", "/v1/patches"],
        ["GET", "/git/acme/widgets.git/info/refs"],
      ]
    ) {
      assertEquals((await deliver(port, { method, path, host: `127.0.0.1:${port}` })).body, "ryph");
      assertEquals(
        (await deliver(port, { method, path, host: "ryph.tunnel.example" })).status,
        421,
      );
    }
    assertEquals(seen, []);
  } finally {
    await closeAll(servers);
    await forge.stop(true);
  }
});

test("with no forge to hand them to, a webhook delivery is the app's like any request", async () => {
  const port = await freePort();
  const app = guardApp(
    (_req, res) => res.end("ryph"),
    allowedHosts({ binds: ["127.0.0.1"], urls: [], extra: undefined }),
    null,
  );
  const servers = await listenAll(app, { required: ["127.0.0.1"], optional: [] }, port);
  try {
    const path = "/v1/hooks/gitlab?project=42&generation=3";
    assertEquals(
      (await deliver(port, { method: "POST", path, host: `127.0.0.1:${port}` })).body,
      "ryph",
    );
    assertEquals((await deliver(port, { method: "POST", path, host: "evil.example" })).status, 421);
  } finally {
    await closeAll(servers);
  }
});

test("a forge that does not answer is a 502 to the sender, so it retries", async () => {
  const port = await freePort();
  const dead = await freePort();
  const app = guardApp((_req, res) => res.end("ryph"), null, `http://127.0.0.1:${dead}`);
  const servers = await listenAll(app, { required: ["127.0.0.1"], optional: [] }, port);
  try {
    const res = await deliver(port, {
      method: "POST",
      path: "/v1/hooks/gitlab?project=42&generation=3",
      host: "ryph.tunnel.example",
      body: "{}",
    });
    assertEquals(res.status, 502);
  } finally {
    await closeAll(servers);
  }
});

test("deliveries go to the forge the host wires: in-process on its port, elsewhere, or none", () => {
  assertEquals(forgeHooksUrl("embedded", undefined), "http://127.0.0.1:7412");
  assertEquals(forgeHooksUrl("embedded", "7999"), "http://127.0.0.1:7999");
  assertEquals(forgeHooksUrl("http://forge:7412", "7999"), "http://forge:7412");
  assertEquals(forgeHooksUrl("noop", undefined), null);
  assertEquals(forgeHooksUrl(undefined, undefined), null);
});

/** One raw request line to 127.0.0.1:`port`, sent as written: no client normalises the target. */
const rawRequest = (port: number, target: string, host: string, body = "{}") =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nhost: ${host}\r\ncontent-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    let text = "";
    socket.on("data", (c) => text += c);
    socket.on("end", () => resolve({ status: Number(text.split(" ")[1]), text }));
    socket.on("error", reject);
  });

test("a request target that is not origin-form is a 400, never a delivery to another host", async () => {
  // The host a hostile target names: anything reaching it is the front door used as a relay.
  const reached: string[] = [];
  const victim = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      reached.push(new URL(req.url).pathname);
      return new Response("internal secret", { status: 200 });
    },
  });
  const forgeSeen: string[] = [];
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      forgeSeen.push(new URL(req.url).pathname);
      return new Response("queued", { status: 202 });
    },
  });
  const port = await freePort();
  const app = guardApp(
    (_req, res) => res.end("ryph"),
    allowedHosts({ binds: ["127.0.0.1"], urls: [], extra: undefined }),
    `http://127.0.0.1:${forge.port}`,
  );
  const servers = await listenAll(app, { required: ["127.0.0.1"], optional: [] }, port);
  const elsewhere = `127.0.0.1:${victim.port}`;
  try {
    for (
      const target of [
        `http://${elsewhere}/v1/hooks/github`,
        `http://${elsewhere}/v1/hooks/gitlab?project=1`,
        `//${elsewhere}/v1/hooks/gitlab`,
        `/\\${elsewhere}/v1/hooks/github`,
        `\\\\${elsewhere}/v1/hooks/github`,
        `*`,
      ]
    ) {
      const res = await rawRequest(port, target, "ryph.tunnel.example");
      assertEquals(res.status, 400, target);
      assert(!res.text.includes("internal secret"), target);
    }
    // Encoded and dotted spellings are origin-form: they stay on the forge's origin or are not
    // a webhook door at all, and never leave for another host.
    for (
      const [target, forged] of [
        [`/%2F%2F${elsewhere}/v1/hooks/github`, false],
        [`/v1/hooks/github/../x`, false],
        [`/v1/hooks/x/../github`, true],
      ] as const
    ) {
      const res = await rawRequest(port, target, "ryph.tunnel.example");
      assertEquals(res.status, forged ? 202 : 421, target);
    }
    assertEquals(forgeSeen, ["/v1/hooks/github"]);
    assertEquals(reached, []);
  } finally {
    await closeAll(servers);
    await forge.stop(true);
    await victim.stop(true);
  }
});

test("a delivery's upstream is the forge's origin with the target's path and query only", () => {
  const target = (t: string) => new URL(t, "http://ryph.invalid");
  assertEquals(
    forgeHookTarget("http://127.0.0.1:7412", target("/v1/hooks/gitlab?project=42")).href,
    "http://127.0.0.1:7412/v1/hooks/gitlab?project=42",
  );
  // A forge URL's own path, user or fragment is not the target's to keep or extend.
  assertEquals(
    forgeHookTarget("http://u:p@forge:7412/base#x", target("/v1/hooks/github")).href,
    "http://forge:7412/v1/hooks/github",
  );
  assertEquals(
    forgeHookTarget("http://forge:7412", new URL("http://elsewhere:1/v1/hooks/github")).origin,
    "http://forge:7412",
  );
});
