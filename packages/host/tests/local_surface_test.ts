// The local listeners' reach: loopback unless widened, and only the names the deployment is
// reached by — the DNS-rebinding half of the same boundary.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  allowedHostEntry,
  allowedHosts,
  bindAddresses,
  guardHost,
  hostAllowed,
  hostOf,
  isWildcard,
  remoteRunReach,
  runAddress,
  urlHost,
  wildcardBindNotice,
} from "../src/local_surface.ts";
import { isHookDelivery } from "@ryph/forge";

test("binds are loopback plus whatever the setting lists, unless a wildcard covers it", () => {
  assertEquals(bindAddresses(undefined), ["127.0.0.1"]);
  assertEquals(bindAddresses(""), ["127.0.0.1"]);
  assertEquals(bindAddresses(" 127.0.0.1, 172.17.0.1 ,127.0.0.1"), ["127.0.0.1", "172.17.0.1"]);
  // An address listed by hand alone still leaves this process able to dial itself.
  assertEquals(bindAddresses("172.17.0.1"), ["127.0.0.1", "172.17.0.1"]);
  assertEquals(bindAddresses("::1"), ["127.0.0.1", "::1"]);
  assertEquals(bindAddresses("0.0.0.0"), ["0.0.0.0"]);
  // `::` keeps IPv4 behind it: with IPV6_V6ONLY it does not cover them (`coveredByWildcard`).
  assertEquals(bindAddresses("::"), ["::", "127.0.0.1"]);
  assertEquals(bindAddresses("[::1]"), ["127.0.0.1", "::1"]);
  // `localhost` would bind only what it resolves to first (::1 on macOS), so it is 127.0.0.1.
  assertEquals(bindAddresses("localhost,10.0.0.5"), ["127.0.0.1", "10.0.0.5"]);
  assertEquals(bindAddresses("LOCALHOST"), ["127.0.0.1"]);
  // A wildcard drops what it covers rather than binding the same port twice.
  assertEquals(bindAddresses("0.0.0.0,127.0.0.1"), ["0.0.0.0"]);
  assertEquals(bindAddresses("127.0.0.1,0.0.0.0,10.0.0.5,::1"), ["0.0.0.0", "::1"]);
  assertEquals(bindAddresses("localhost,0.0.0.0"), ["0.0.0.0"]);
  assertEquals(bindAddresses("::1,[::],0.0.0.0,127.0.0.1"), ["::", "0.0.0.0"]);
  assertEquals(bindAddresses("::,10.0.0.5,fd00::5"), ["::", "127.0.0.1", "10.0.0.5"]);
  assert(isWildcard("0.0.0.0") && isWildcard("::"));
  assert(!isWildcard("127.0.0.1"));
});

test("wildcard bind notices warn by default and describe an explicit container scope", () => {
  for (const address of ["0.0.0.0", "::", "[::]"]) {
    for (const scope of [undefined, "", "host", "typo"]) {
      assertEquals(wildcardBindNotice([address], scope, true), {
        level: "warn",
        message:
          `RYPH_BIND=${address} — the control plane, the model proxy and the forge answer every network this machine is on`,
      });
    }
    for (const forge of [false, true]) {
      const notice = wildcardBindNotice([address], "container", forge);
      assertEquals(notice?.level, "info");
      assert(notice?.message.includes("the container's attached networks"));
      assert(notice?.message.includes("including other containers on them"));
      assert(notice?.message.includes("host exposure depends on published ports"));
      assertEquals(notice?.message.includes("and the forge"), forge);
      assertEquals(
        wildcardBindNotice([address], undefined, forge)?.message.includes("and the forge"),
        forge,
      );
    }
  }
  for (const scope of [undefined, "container"]) {
    assertEquals(wildcardBindNotice(["127.0.0.1", "::1", "10.0.0.5"], scope, true), null);
  }
});

test("the run address is detected per backend and bound beside loopback", () => {
  const at = (provisioner: string, dockerBridge: string | null = null) =>
    runAddress({ provisioner, dockerBridge });
  // A native Linux engine maps host.docker.internal to the bridge on this machine; Docker
  // Desktop forwards it to loopback, so localBridgeGateway answers null there and nothing moves.
  assertEquals(at("docker", "172.17.0.1"), "172.17.0.1");
  assertEquals(at("docker"), null);
  // Every other backend calls home from elsewhere (remoteRunReach), whatever was found.
  for (const kind of ["manual", "kubernetes"]) {
    assertEquals(at(kind, "172.17.0.1"), null);
  }

  // Bound after what RYPH_BIND lists, once, and never beside a wildcard that covers it.
  assertEquals(bindAddresses(undefined, null), ["127.0.0.1"]);
  assertEquals(bindAddresses(undefined, "172.17.0.1"), ["127.0.0.1", "172.17.0.1"]);
  assertEquals(bindAddresses("172.17.0.1", "172.17.0.1"), ["127.0.0.1", "172.17.0.1"]);
  assertEquals(bindAddresses("10.0.0.5", "192.168.64.1"), [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.64.1",
  ]);
  assertEquals(bindAddresses("0.0.0.0", "172.17.0.1"), ["0.0.0.0"]);
  assertEquals(bindAddresses("::", "172.17.0.1"), ["::", "127.0.0.1", "172.17.0.1"]);
});

test("the names answered: loopback, the docker host, the binds and the handed-out URLs", () => {
  const hosts = allowedHosts({
    binds: ["127.0.0.1", "172.17.0.1"],
    urls: ["http://ryph-gate-default:7411", "http://192.168.64.1:7420", null, "not a url"],
    extra: "ryph.lan, Box.Local",
  })!;
  for (
    const ok of [
      "localhost:7411",
      "127.0.0.1:7411",
      "[::1]:7411",
      "host.docker.internal:7411",
      "172.17.0.1:7411",
      "ryph-gate-default:7411",
      "192.168.64.1",
      "ryph.lan",
      "box.local:3000",
      "LOCALHOST.:3000",
    ]
  ) {
    assert(hostAllowed(ok, hosts), ok);
  }
  // A rebinding page arrives under its own name; a wildcard bind adds no name of its own.
  for (const no of ["evil.example:7411", "", "127.0.0.1.evil.example"]) {
    assert(!hostAllowed(no, hosts), no);
  }
  assert(!hostAllowed(null, hosts));
  assertEquals(
    allowedHosts({ binds: ["0.0.0.0"], urls: [], extra: undefined })!.has("0.0.0.0"),
    false,
  );
  assertEquals(hostOf("[::1]:3000"), "[::1]");
});

test("RYPH_ALLOWED_HOSTS=* turns the check off", () => {
  const hosts = allowedHosts({ binds: [], urls: [], extra: "*" });
  assertEquals(hosts, null);
  assert(hostAllowed("anything.example", hosts));
});

test("a guarded handler answers 421 to a name it does not know", async () => {
  const handler = guardHost(() => new Response("ok"), new Set(["localhost"]));
  const ok = await handler(
    new Request("http://localhost:7411/v1/auth/bootstrap", {
      headers: { host: "localhost:7411" },
    }),
  );
  assertEquals(await ok.text(), "ok");
  const rebound = await handler(
    new Request("http://localhost:7411/v1/auth/bootstrap", {
      headers: { host: "attacker.example:7411" },
    }),
  );
  assertEquals(rebound.status, 421);
  await rebound.body?.cancel();
});

test("an IPv6 bind or extra name matches the bracketed Host a browser sends", () => {
  assertEquals(urlHost("fd00::5"), "[fd00::5]");
  assertEquals(urlHost("[FD00::5]"), "[fd00::5]");
  assertEquals(urlHost("10.0.0.5"), "10.0.0.5");
  const hosts = allowedHosts({ binds: ["fd00::5"], urls: [], extra: "fd00::6" })!;
  assert(hostAllowed("[fd00::5]:7411", hosts));
  assert(hostAllowed("[fd00::6]:7411", hosts));
  assert(hostAllowed("[::1]:7411", hosts));
});

test("webhook ingestion answers any name; the rest of the control plane does not", async () => {
  const handler = guardHost(() => new Response("ok"), new Set(["localhost"]), isHookDelivery);
  const at = (path: string, method = "POST") =>
    handler(
      new Request(`http://abc.tunnel.example${path}`, {
        method,
        headers: { host: "abc.tunnel.example" },
      }),
    );
  const hook = await at("/v1/hooks/github");
  assertEquals(await hook.text(), "ok");
  for (const [path, method] of [["/v1/hooks/github", "GET"], ["/v1/hooks/../runs", "POST"]]) {
    const refused = await at(path, method);
    assertEquals(refused.status, 421, `${method} ${path}`);
    await refused.body?.cancel();
  }
});

test("an allowed-hosts entry is read in any shape a person would write it", () => {
  const cases: [string, string | null][] = [
    ["ryph.lan", "ryph.lan"],
    ["Ryph.LAN:3000", "ryph.lan"],
    ["http://ryph.lan", "ryph.lan"],
    ["https://ryph.lan:8443/some/path", "ryph.lan"],
    ["10.0.0.5:7411", "10.0.0.5"],
    ["fd00::5", "[fd00::5]"],
    ["[fd00::5]", "[fd00::5]"],
    ["[FD00::5]:3000", "[fd00::5]"],
    ["http://[fd00::5]:3000", "[fd00::5]"],
    ["ryph.lan.", "ryph.lan"],
    ["", null],
  ];
  for (const [entry, host] of cases) assertEquals(allowedHostEntry(entry), host, entry);
  const hosts = allowedHosts({
    binds: [],
    urls: [],
    extra: "ryph.lan:3000, http://box.local, [fd00::7]:80",
  })!;
  for (const ok of ["ryph.lan:3000", "ryph.lan", "box.local:5173", "[fd00::7]:7411"]) {
    assert(hostAllowed(ok, hosts), ok);
  }
});

test("a URL's host is allowed however its trailing dot is written", () => {
  const hosts = allowedHosts({
    binds: ["127.0.0.1"],
    urls: ["http://ryph.example.com.:7411", "http://Box.Local:3000"],
    extra: undefined,
  })!;
  for (const ok of ["ryph.example.com.:7411", "ryph.example.com", "box.local.", "BOX.local"]) {
    assert(hostAllowed(ok, hosts), ok);
  }
  assert(!hosts.has("ryph.example.com."));
});

test("every URL a run dials must be one a listener answers", () => {
  const reach = (binds: string[], urls: [string, string | null][], aliases?: string[]) =>
    remoteRunReach({ binds, urls, aliases });
  const kinds = (r: ReturnType<typeof remoteRunReach>) =>
    r.map((x) => "refuse" in x ? "refuse" : "warn");
  const pub = (url: string): [string, string] => ["RYPH_PUBLIC_URL", url];
  // An address no listener holds can never answer.
  assertEquals(kinds(reach(["127.0.0.1"], [pub("http://10.0.0.5:7411")])), ["refuse"]);
  assertEquals(kinds(reach(["127.0.0.1", "::1"], [pub("http://[fd00::5]:7411")])), ["refuse"]);
  // Loopback itself, or a name an engine delivers to loopback, answers.
  for (
    const url of [
      "http://127.0.0.1:7411",
      "http://localhost:7411",
      "http://[::1]:7411",
      "http://host.docker.internal:7411",
      "http://host.orb.internal:7411",
    ]
  ) assertEquals(reach(["127.0.0.1"], [pub(url)]), [], url);
  // Any other name may be a tunnel to loopback: said, not refused.
  assertEquals(kinds(reach(["127.0.0.1"], [pub("https://ryph.example.com")])), ["warn"]);
  // A bound address answers, and a wildcard answers its family.
  assertEquals(reach(["127.0.0.1", "10.0.0.5"], [pub("http://10.0.0.5:7411")]), []);
  assertEquals(reach(["0.0.0.0"], [pub("http://10.0.0.9:7411")]), []);
  assertEquals(reach(["::", "127.0.0.1"], [pub("http://[fd00::9]:7411")]), []);
  assertEquals(kinds(reach(["0.0.0.0"], [pub("http://[fd00::9]:7411")])), ["refuse"]);
});

test("each backend's own defaults reach what it binds", () => {
  const urls = (host: string): [string, string][] => [
    ["RYPH_PUBLIC_URL", `http://${host}:7411`],
    ["RYPH_MODEL_PROXY_URL", `http://${host}:7420`],
    ["RYPH_GIT_GATEWAY_URL", `http://${host}:7412`],
  ];
  // Unset: loopback, under any backend.
  assertEquals(
    remoteRunReach({ binds: ["127.0.0.1"], urls: urls("127.0.0.1") }),
    [],
  );
  // Docker Desktop and OrbStack: host.docker.internal, delivered to loopback.
  assertEquals(
    remoteRunReach({
      binds: ["127.0.0.1"],
      urls: urls("host.docker.internal"),
    }),
    [],
  );
  // A Linux engine: the same name, which lands on the bridge it binds.
  const bridge = bindAddresses(undefined, "172.17.0.1");
  assertEquals(
    remoteRunReach({ binds: bridge, urls: urls("host.docker.internal") }),
    [],
  );
  assertEquals(
    remoteRunReach({ binds: bridge, urls: urls("172.17.0.1") }),
    [],
  );
  // Confined docker: the gate, which relays to loopback.
  assertEquals(
    remoteRunReach({
      binds: ["127.0.0.1"],
      urls: urls("ryph-gate-default"),
      aliases: ["ryph-gate-default"],
    }),
    [],
  );
});

test("a stale or unbound address is refused once per host, naming every setting on it", () => {
  // An address that is no longer the one bound (a Linux bridge renumbered since it was written).
  const moved = remoteRunReach({
    binds: ["127.0.0.1", "172.18.0.1"],
    urls: [
      ["RYPH_PUBLIC_URL", "http://172.17.0.1:7411"],
      ["RYPH_MODEL_PROXY_URL", "http://172.17.0.1:7420"],
      ["RYPH_GIT_GATEWAY_URL", null],
    ],
  });
  assertEquals(moved.length, 1);
  const refusal = (moved[0] as { refuse: string }).refuse;
  assert(refusal.includes("RYPH_PUBLIC_URL, RYPH_MODEL_PROXY_URL"), refusal);
  assert(refusal.includes("Add that address to RYPH_BIND"), refusal);
  // Each URL is checked on its own: a model proxy or git gateway elsewhere is refused too.
  for (const setting of ["RYPH_MODEL_PROXY_URL", "RYPH_GIT_GATEWAY_URL"]) {
    const r = remoteRunReach({
      binds: ["127.0.0.1"],
      urls: [["RYPH_PUBLIC_URL", "http://127.0.0.1:7411"], [setting, "http://10.0.0.5:7420"]],
    });
    assertEquals(r.length, 1);
    const text = (r[0] as { refuse: string }).refuse;
    assert(text.includes(`(${setting})`) && text.includes("Add that address to RYPH_BIND"), text);
  }
  // A name is warned of only while loopback alone is bound.
  assertEquals(
    remoteRunReach({
      binds: ["127.0.0.1", "10.0.0.5"],
      urls: [["RYPH_PUBLIC_URL", "https://ryph.example.com"]],
    }),
    [],
  );
});
