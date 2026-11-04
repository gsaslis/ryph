// Where hosted servers run, as the launcher makes it (src/tools.ts): the tools network internal
// and isolated or refused, a non-confining one replaced only when nothing but this deployment's
// own is on it, the guard's edge made where the deployment has none, and the egress relay in the
// run gate's posture — remade when it drifts, removed when egress is off, never someone else's.
// Against a small stateful fake of the daemon, so each test reads as what docker ends up holding.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DockerExec } from "@ryph/orchestrator/docker";
import type { ToolsConfig } from "../src/config.ts";
import {
  egressRelayArgs,
  egressRelayName,
  egressRelayOrigin,
  ensureToolNetwork,
  prepareTools,
} from "../src/tools.ts";

interface Net {
  internal: boolean;
  isolated: boolean;
  labels: Record<string, string>;
}
interface Box {
  labels: Record<string, string>;
  image: string;
  cmd: string[];
  running: boolean;
  networks: Set<string>;
  sysctl: Record<string, string>;
  addHost: string[];
}

const VALUED = new Set([
  "--name",
  "--label",
  "--network",
  "--add-host",
  "--restart",
  "--cap-drop",
  "--security-opt",
  "--user",
  "--memory",
  "--cpus",
  "--pids-limit",
  "--ulimit",
  "--sysctl",
  "-o",
]);

/** A docker daemon in a map: networks, containers, and the calls that changed them. */
function daemon(engine = "29.1.0|linux|Docker Desktop", images = ["ryph-run-gate:test"]) {
  const networks = new Map<string, Net>();
  const boxes = new Map<string, Box>();
  const calls: string[] = [];
  const ids = new Map(images.map((image, i) => [image, `sha256:${String(i + 1).repeat(64)}`]));
  const labelsOf = (args: string[]) =>
    Object.fromEntries(
      args.flatMap((a, i) => a === "--label" ? [args[i + 1]!.split("=")] : []) as [
        string,
        string,
      ][],
    );
  const exec: DockerExec = (args) => {
    calls.push(args.join(" "));
    const [verb, sub] = args;
    const no = (what: string) => Promise.reject(new Error(`Error: No such ${what}`));
    const ok = (out = "") => Promise.resolve(out);
    if (verb === "info") return ok(engine);
    if (verb === "version") return ok("Engine;containerd;");
    if (verb === "image" && sub === "inspect") {
      const id = ids.get(args.at(-1)!);
      return id === undefined ? no("image") : ok(id);
    }
    if (verb === "pull") return Promise.reject(new Error("pull access denied"));
    if (verb === "network") {
      const name = args.at(-1)!;
      if (sub === "inspect") {
        const net = networks.get(name);
        if (net === undefined) return no("network");
        const format = args[args.indexOf("-f") + 1] ?? "";
        if (format.includes(".Internal")) {
          const mode = net.isolated ? "isolated" : "";
          return ok(`${net.internal}|${mode}|${mode}`);
        }
        if (format.includes(".Containers")) {
          return ok(
            [...boxes].filter(([, b]) => b.networks.has(name)).map(([n]) => `${n} `).join(""),
          );
        }
        return ok(name);
      }
      if (sub === "create") {
        if (networks.has(name)) return Promise.reject(new Error(`network ${name} already exists`));
        networks.set(name, {
          internal: args.includes("--internal"),
          isolated: args.includes("com.docker.network.bridge.gateway_mode_ipv4=isolated"),
          labels: labelsOf(args),
        });
        return ok();
      }
      if (sub === "rm") {
        if ([...boxes.values()].some((b) => b.networks.has(name))) {
          return Promise.reject(new Error("network has active endpoints"));
        }
        networks.delete(name);
        return ok();
      }
      if (sub === "connect") {
        const box = boxes.get(args.at(-1)!);
        if (box === undefined) return no("container");
        box.networks.add(args.at(-2)!);
        return ok();
      }
    }
    if (verb === "rm") {
      boxes.delete(args.at(-1)!);
      return ok();
    }
    if (verb === "start") {
      const box = boxes.get(args.at(-1)!);
      if (box === undefined) return no("container");
      box.running = true;
      return ok();
    }
    if (verb === "create") {
      let at = 1;
      while (args[at]?.startsWith("-")) at += VALUED.has(args[at]!) ? 2 : 1;
      const value = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
      boxes.set(value("--name")[0]!, {
        labels: labelsOf(args.slice(0, at)),
        image: ids.get(args[at]!) ?? args[at]!,
        cmd: args.slice(at + 1),
        running: false,
        networks: new Set(value("--network")),
        sysctl: Object.fromEntries(value("--sysctl").map((s) => s.split("=") as [string, string])),
        addHost: value("--add-host"),
      });
      return ok();
    }
    if (verb === "inspect") {
      const box = boxes.get(args.at(-1)!);
      if (box === undefined) return no("container");
      const format = args.includes("-f") ? args[args.indexOf("-f") + 1]! : null;
      if (format !== null) {
        return ok(
          [...format.matchAll(/index \.Config\.Labels "([^"]+)"/g)]
            .map((m) => box.labels[m[1]!] ?? "").join("|"),
        );
      }
      return ok(JSON.stringify([{
        State: { Running: box.running },
        Image: box.image,
        Config: { Cmd: box.cmd, Labels: box.labels },
        HostConfig: { Sysctls: box.sysctl },
        NetworkSettings: { Networks: Object.fromEntries([...box.networks].map((n) => [n, {}])) },
      }]));
    }
    return ok();
  };
  /** A container as the docker tool host would have left one. */
  const hosted = (name: string, network: string, deployment = "dep") =>
    boxes.set(name, {
      labels: { "ryph.tool": name, "ryph.tool.network": network, "ryph.deployment": deployment },
      image: "sha256:vendor",
      cmd: [],
      running: true,
      networks: new Set([network]),
      sysctl: {},
      addHost: [],
    });
  return { exec, networks, boxes, calls, hosted };
}

const TOOLS: ToolsConfig = {
  network: "ryph-tools-dep",
  joined: true,
  edge: "dep",
  guardImage: "ryph-tool-guard:test",
  egress: { image: "ryph-run-gate:test", target: "egress-proxy", port: 7461 },
};

test("a tools network is made internal, its gateway isolated, labelled for the deployment", async () => {
  const d = daemon();
  await ensureToolNetwork(TOOLS, "dep", d.exec);
  assertEquals(d.networks.get("ryph-tools-dep"), {
    internal: true,
    isolated: true,
    labels: { "ryph.tools": "1", "ryph.deployment": "dep" },
  });
  // Made again on the next boot: nothing to do.
  const before = d.calls.length;
  await ensureToolNetwork(TOOLS, "dep", d.exec);
  assert(!d.calls.slice(before).some((c) => c.startsWith("network create")));
});

test("an engine that cannot confine hosted servers is refused, and nothing is made", async () => {
  for (
    const [engine, says] of [
      ["5.2.0|linux|Fedora (podman)", "Podman"],
      ["27.5.1|linux|Ubuntu 24.04", "older than 28.0"],
    ]
  ) {
    const d = daemon(engine);
    const err = await assertRejects(() => ensureToolNetwork(TOOLS, "dep", d.exec));
    assertStringIncludes(String(err), says);
    assertStringIncludes(String(err), "hosted");
    assertEquals(d.networks.size, 0);
  }
  // A VM engine before 28 cannot isolate the gateway, whose host is its VM: internal alone.
  const old = daemon("27.5.1|linux|Docker Desktop");
  await ensureToolNetwork(TOOLS, "dep", old.exec);
  assertEquals(old.networks.get("ryph-tools-dep")?.internal, true);
  assertEquals(old.networks.get("ryph-tools-dep")?.isolated, false);
});

test("a plain tools network holding only this deployment's servers is replaced", async () => {
  const d = daemon();
  // What an older ryph left: a plain bridge, its guard and a vendor on it.
  d.networks.set("ryph-tools-dep", { internal: false, isolated: false, labels: {} });
  d.hosted("ryph-tool-guard-ryph-tools-dep", "ryph-tools-dep");
  d.hosted("ryph-tool-grafana-1", "ryph-tools-dep");
  await ensureToolNetwork(TOOLS, "dep", d.exec);
  assertEquals(d.networks.get("ryph-tools-dep")?.internal, true);
  assertEquals(d.networks.get("ryph-tools-dep")?.isolated, true);
  // Hosting relaunches them onto the new one.
  assertEquals(d.boxes.size, 0);
});

test("a plain tools network with anything else on it is refused, naming it, and kept", async () => {
  const d = daemon();
  d.networks.set("ryph-tools-dep", { internal: false, isolated: false, labels: {} });
  d.hosted("ryph-tool-grafana-1", "ryph-tools-dep");
  // An older compose file's gateway, and another deployment's server on the same name.
  d.hosted("ryph-mcp-gateway-1", "ryph-tools-dep");
  d.boxes.get("ryph-mcp-gateway-1")!.labels = {};
  d.hosted("ryph-tool-other-1", "ryph-tools-dep", "elsewhere");
  const err = await assertRejects(() => ensureToolNetwork(TOOLS, "dep", d.exec));
  assertStringIncludes(String(err), "ryph-mcp-gateway-1, ryph-tool-other-1");
  assertStringIncludes(String(err), "docker network disconnect ryph-tools-dep");
  assertEquals(d.boxes.size, 3);
  assertEquals(d.networks.get("ryph-tools-dep")?.internal, false);
  assert(!d.calls.some((c) => c.startsWith("rm") || c.startsWith("network rm")));
});

test("the egress relay is the run gate in its posture, with one route to the tool listener", () => {
  const args = egressRelayArgs(TOOLS, "dep");
  const values = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assertEquals(values("--name"), ["ryph-egress-relay-ryph-tools-dep"]);
  // Outside the `ryph-tool-*` handles the tool routes take, so a tools token never names it.
  assert(!egressRelayName("x").startsWith("ryph-tool-"));
  // Never `ryph.gate`, which the run gate's stray sweep removes.
  assertEquals(values("--label"), ["ryph.tool.egress=ryph-tools-dep", "ryph.deployment=dep"]);
  assertEquals(values("--network"), ["dep"]);
  assertEquals(values("--sysctl"), ["net.ipv4.ip_forward=0"]);
  assertEquals(values("--cap-drop"), ["ALL"]);
  assertEquals(values("--user"), ["65534:65534"]);
  assert(args.includes("--read-only"));
  assertEquals(values("--add-host"), []);
  assertEquals(args.slice(args.indexOf("ryph-run-gate:test")), [
    "ryph-run-gate:test",
    "7460=egress-proxy:7461",
  ]);
  // To the host (the binary's tool listener), and only then, the host's name is mapped.
  const host = egressRelayArgs({
    ...TOOLS,
    edge: undefined,
    egress: { ...TOOLS.egress!, target: "host.docker.internal" },
  }, "default");
  assertEquals(host.flatMap((a, i) => (a === "--add-host" ? [host[i + 1]] : [])), [
    "host.docker.internal:host-gateway",
  ]);
  assertEquals(host[host.indexOf("--network") + 1], "ryph-tools-dep-edge");
  assertEquals(egressRelayOrigin("ryph-tools-dep"), "http://ryph-egress-relay-ryph-tools-dep:7460");
});

test("preparing hosting makes the network, the relay on both sides, and keeps a current one", async () => {
  const d = daemon();
  d.networks.set("dep", { internal: false, isolated: false, labels: {} });
  await prepareTools(TOOLS, "dep", d.exec);
  const relay = d.boxes.get("ryph-egress-relay-ryph-tools-dep")!;
  assertEquals([...relay.networks].sort(), ["dep", "ryph-tools-dep"]);
  assert(relay.running);
  // Created on the edge and connected after, so its default route is the edge's.
  const order = d.calls.filter((c) => /^(create|network connect|start)/.test(c));
  assertEquals(order.map((c) => c.split(" ").slice(0, 2).join(" ")), [
    "create --name",
    "network connect",
    "start ryph-egress-relay-ryph-tools-dep",
  ]);
  const before = d.calls.length;
  await prepareTools(TOOLS, "dep", d.exec);
  assert(!d.calls.slice(before).some((c) => /^(rm|create)/.test(c)), "a current relay is kept");
  // A new target is drift: remade.
  await prepareTools({ ...TOOLS, egress: { ...TOOLS.egress!, port: 7462 } }, "dep", d.exec);
  assertEquals(d.boxes.get("ryph-egress-relay-ryph-tools-dep")!.cmd, ["7460=egress-proxy:7462"]);
  // Egress off: the relay goes, a way out the configuration took away.
  await prepareTools({ ...TOOLS, egress: null }, "dep", d.exec);
  assertEquals(d.boxes.has("ryph-egress-relay-ryph-tools-dep"), false);
});

test("a deployment with no network gets an edge of its own for the guard and the relay", async () => {
  const d = daemon();
  await prepareTools({ ...TOOLS, edge: undefined }, "default", d.exec);
  assertEquals(d.networks.get("ryph-tools-dep-edge")?.internal, false);
  assertEquals(d.networks.get("ryph-tools-dep-edge")?.labels, {
    "ryph.tools.edge": "ryph-tools-dep",
    "ryph.deployment": "default",
  });
  assertEquals(
    [...d.boxes.get("ryph-egress-relay-ryph-tools-dep")!.networks].sort(),
    ["ryph-tools-dep", "ryph-tools-dep-edge"],
  );
});

test("a container holding the relay's name that is not this deployment's is refused, never removed", async () => {
  const d = daemon();
  d.hosted("ryph-egress-relay-ryph-tools-dep", "ryph-tools-dep", "elsewhere");
  d.boxes.get("ryph-egress-relay-ryph-tools-dep")!.labels = { "ryph.deployment": "elsewhere" };
  const err = await assertRejects(() => prepareTools(TOOLS, "dep", d.exec));
  assertStringIncludes(String(err), "not this deployment's egress relay");
  assert(d.boxes.has("ryph-egress-relay-ryph-tools-dep"));
});

test("a relay image that is nowhere is said with the task that builds it", async () => {
  const d = daemon(undefined, []);
  const err = await assertRejects(() => prepareTools(TOOLS, "dep", d.exec));
  assertStringIncludes(String(err), "egress relay's image");
  assertStringIncludes(String(err), "bun run agent-image");
});
