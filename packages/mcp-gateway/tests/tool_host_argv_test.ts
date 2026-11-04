// The docker ToolHost adapter's argv — where the isolation promises actually live. A vendor's
// container joins the tools network and nothing else and is never published; the guard is created
// on its ordinary network (`edge`), connected to the tools network before it starts, published
// only on loopback, and runs the configured guard image alone; and every one of them runs
// non-root, read-only, capability-less, memory-capped and unrestarted.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  dockerGuardName,
  dockerToolHost,
  guardCreateArgs,
  mergeTimestamped,
  toolEdgeNetwork,
  toolLaunchArgs,
  toolListArgs,
} from "../src/adapters/tool_host/docker.ts";
import {
  TOOL_DEPLOYMENT_LABEL,
  TOOL_LABEL,
  TOOL_NETWORK_LABEL,
  TOOL_USER,
  TOOLS_NETWORK,
} from "../src/adapters/tool_host/cli.ts";
import type { ToolLaunchSpec } from "../src/ports/tool_host.ts";

const SPEC: ToolLaunchSpec = {
  name: `ryph-tool-${"a1".repeat(16)}`,
  image: `grafana/mcp-grafana@sha256:${"a".repeat(64)}`,
  command: ["-t", "streamable-http", "--address", "0.0.0.0:8000", "--disable-write"],
  env: { GRAFANA_URL: "https://grafana.example.com" },
  port: 8000,
  memory: "512m",
  cpus: "1",
  lifetime: "shared",
};

const GUARD_TOKEN = "t".repeat(64);
const GUARD: ToolLaunchSpec = {
  name: "ryph-tool-guard",
  image: "ryph-tool-guard:dev",
  command: [],
  env: { RYPH_TOOL_ROUTES: "" },
  secretEnv: { RYPH_TOOL_GUARD_TOKEN: GUARD_TOKEN },
  port: 8080,
  memory: "128m",
  lifetime: "shared",
};

/** Every value of a repeated flag. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
}

/** The vendor's argv, or the guard's — whichever the adapter would run for the spec. */
const dockerArgs = (spec: ToolLaunchSpec, opts: Parameters<typeof toolLaunchArgs>[1] = {}) =>
  spec.name.startsWith("ryph-tool-guard")
    ? guardCreateArgs(spec, opts)
    : toolLaunchArgs(spec, opts);

/** The run networks a deployment is likely to use — none may ever appear in a tool launch. */
const RUN_NETWORKS = ["ryph", "default", "bridge", "host", "ryph-run"];

test("a vendor's container joins the tools network and no other", () => {
  const args = toolLaunchArgs(SPEC, {});
  assertEquals(values(args, "--network"), [TOOLS_NETWORK]);
  for (const run of RUN_NETWORKS) assert(!args.includes(run), `${run} in ${args.join(" ")}`);
  // Even an adapter configured with another tools network (and an edge) puts it there, once.
  assertEquals(
    values(toolLaunchArgs(SPEC, { network: "iso-tools", edge: "ryph" }), "--network"),
    ["iso-tools"],
  );
});

test("the guard is created on its edge network, never forwarding, and connected after", () => {
  const args = guardCreateArgs(GUARD, {});
  assertEquals(args[0], "create");
  assertEquals(values(args, "--network"), [toolEdgeNetwork(TOOLS_NETWORK)]);
  assertEquals(toolEdgeNetwork(TOOLS_NETWORK), "ryph-tools-edge");
  assertEquals(values(args, "--sysctl"), ["net.ipv4.ip_forward=0"]);
  assertEquals(
    values(guardCreateArgs(GUARD, { network: "ryph-tools-ryph", edge: "ryph" }), "--network"),
    ["ryph"],
  );
});

test("a vendor's container gets the configured runtime and only that; the guard none", () => {
  assertEquals(values(toolLaunchArgs(SPEC, {}), "--runtime"), []);
  assertEquals(values(toolLaunchArgs(SPEC, { runtime: "runsc" }), "--runtime"), ["runsc"]);
  // The runtime is a flag of `docker run`, so it sits before the image, never in its command.
  const args = toolLaunchArgs(SPEC, { runtime: "runsc" });
  assert(args.indexOf("--runtime") < args.indexOf(SPEC.image));
  // The guard's image is the launcher's own (`guardImage`), so it runs as the run gate does.
  assertEquals(values(guardCreateArgs(GUARD, { runtime: "runsc" }), "--runtime"), []);
});

test("only the guard is ever published, and every publish binds 127.0.0.1", () => {
  const plain = toolLaunchArgs(SPEC, {});
  assert(!plain.includes("-p") && !plain.includes("--publish"));
  assertThrows(
    () => toolLaunchArgs({ ...SPEC, publish: { hostPort: 7439 } }, {}),
    Error,
    "only the tool guard",
  );
  assert(!guardCreateArgs(GUARD, {}).includes("-p"));
  for (const hostPort of [0, 7439]) {
    const published = values(guardCreateArgs({ ...GUARD, publish: { hostPort } }, {}), "-p");
    assertEquals(published.length, 1);
    assert(published[0].startsWith("127.0.0.1:"), published[0]);
    assert(published[0].endsWith(":8080"), published[0]);
  }
});

test("non-root, read-only, no capabilities, no mounts, memory-capped — the guard too", () => {
  for (const spec of [SPEC, GUARD]) {
    const args = dockerArgs(spec, {});
    assertEquals(values(args, "--user"), [TOOL_USER]);
    assert(args.includes("--read-only"));
    assertEquals(values(args, "--cap-drop"), ["ALL"]);
    assert(!args.includes("--cap-add"));
    for (const flag of ["--mount", "-v", "--volume", "--privileged", "--tmpfs", "--add-host"]) {
      assert(!args.includes(flag), flag);
    }
    assertEquals(values(args, "--memory")[0].toLowerCase(), spec.memory);
  }
  assertEquals(values(toolLaunchArgs(SPEC, {}), "--cpus"), ["1"]);
});

test("a secret rides as a NAME, never as a value in the argv", () => {
  // `/proc/<pid>/cmdline` is world-readable on Linux, so a token spelled `-e K=V` is readable
  // by any local user — and by a sibling container with host PID access — for the length of
  // the exec. docker reads a bare `-e NAME` from the launching process's environment
  // ("key=value, or just key to inherit from host"), which is where cli.ts puts the value.
  const caller = "c".repeat(64);
  const args = dockerArgs({ ...SPEC, secretEnv: { MCP_GRAFANA_SERVER_TOKEN: caller } }, {});
  assertEquals(values(args, "-e"), [
    "GRAFANA_URL=https://grafana.example.com",
    "MCP_GRAFANA_SERVER_TOKEN",
  ]);
  assert(!args.join(" ").includes(caller), "a caller token is never a word in the argv");
  const guard = dockerArgs(GUARD, {});
  assertEquals(values(guard, "-e"), ["RYPH_TOOL_ROUTES=", "RYPH_TOOL_GUARD_TOKEN"]);
  assert(!guard.join(" ").includes(GUARD_TOKEN), "the guard token is never in the argv");
});

test("settings ride as env, then the image, then the entry's argv", () => {
  const args = dockerArgs(SPEC, {});
  assertEquals(values(args, "-e"), ["GRAFANA_URL=https://grafana.example.com"]);
  const image = args.indexOf(SPEC.image);
  assertEquals(args.slice(image + 1), SPEC.command);
  assert(args.indexOf("-e") < image, "env is a run flag, not an argument to the server");
});

test("per-run lifetimes and flag-shaped names are refused", () => {
  assertThrows(() => dockerArgs({ ...SPEC, lifetime: "run" }, {}), Error, "per-run");
  assertThrows(() => dockerArgs({ ...SPEC, name: "--privileged" }, {}), Error, "name");
  assertThrows(() => dockerArgs({ ...SPEC, image: "--privileged" }, {}), Error, "image");
});

test("a tool container is never restarted", () => {
  assertEquals(values(dockerArgs(SPEC), "--restart"), ["no"]);
  assertEquals(values(dockerArgs(GUARD), "--restart"), ["no"]);
});

test("our containers are listed by label, argv arrays and no shell", () => {
  // The other direction from every other call: rows name a container, this names what is running
  // that we launched — the pair is what makes an orphan visible to the boot sweep.
  const args = toolListArgs();
  assert(args.every((a) => typeof a === "string" && !/[|;&$`]/.test(a)), args.join(" "));
  assert(args.includes("--all"), `stopped containers count too: ${args.join(" ")}`);
  // Filtered at the daemon, to this deployment's tools network AND this deployment: never
  // another deployment's, even one on the same network.
  assertEquals(values(args, "--filter"), [
    `label=${TOOL_NETWORK_LABEL}=${TOOLS_NETWORK}`,
    `label=${TOOL_DEPLOYMENT_LABEL}=default`,
  ]);
  assertEquals(values(toolListArgs("ryph-compose-tools", "ryph-compose"), "--filter"), [
    `label=${TOOL_NETWORK_LABEL}=ryph-compose-tools`,
    `label=${TOOL_DEPLOYMENT_LABEL}=ryph-compose`,
  ]);
  assertEquals(args.at(-1), "{{.Names}}");
  // And every launch carries the labels the sweep looks for.
  assertEquals(values(dockerArgs(SPEC, {}), "--label"), [
    `${TOOL_LABEL}=${SPEC.name}`,
    `${TOOL_NETWORK_LABEL}=${TOOLS_NETWORK}`,
    `${TOOL_DEPLOYMENT_LABEL}=default`,
  ]);
  assertEquals(
    values(
      dockerArgs(GUARD, { network: "ryph-compose-tools", deployment: "ryph-compose" }),
      "--label",
    ),
    [
      `${TOOL_LABEL}=${GUARD.name}`,
      `${TOOL_NETWORK_LABEL}=ryph-compose-tools`,
      `${TOOL_DEPLOYMENT_LABEL}=ryph-compose`,
    ],
  );
});

test("a deployment with a tools network of its own has a guard of its own", () => {
  assertEquals(dockerGuardName(), "ryph-tool-guard");
  assertEquals(dockerGuardName(TOOLS_NETWORK), "ryph-tool-guard");
  assertEquals(dockerGuardName("ryph-compose-tools"), "ryph-tool-guard-ryph-compose-tools");
  assertEquals(
    dockerToolHost({ network: "ryph-compose-tools" }).guardName,
    dockerGuardName("ryph-compose-tools"),
  );
});

test("docker logs are put back in order across the two streams", () => {
  const stdout = "2026-09-11T10:00:00.000000002Z b\n2026-09-11T10:00:00.000000004Z d\n";
  const stderr = "2026-09-11T10:00:00.000000001Z a\n2026-09-11T10:00:00.000000003Z c\n";
  assertEquals(mergeTimestamped(stdout, stderr), "a\nb\nc\nd");
});

test("a gateway on the guard's edge network dials it by name, so nothing is published", () => {
  // From a host process the guard must be published (Docker Desktop's VM is unroutable); from a
  // container on the edge network a host loopback port is unreachable, and the name is not.
  assertEquals(dockerToolHost().reachesGuard, false);
  const joined = dockerToolHost({
    network: "ryph-compose-tools",
    edge: "ryph-compose",
    joined: true,
  });
  assertEquals(joined.reachesGuard, true);
});

/** A fake docker CLI: every call recorded, and an answer per verb (`inspect` absent by default). */
function fakeCli(answers: Record<string, (args: string[]) => string | Error> = {}) {
  const calls: string[][] = [];
  const cli = (args: string[]) => {
    calls.push(args);
    const answer = answers[args[0]]?.(args) ??
      (args[0] === "inspect" ? new Error("Error: No such object") : "");
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ stdout: answer, stderr: "" });
  };
  return { calls, cli };
}

const HOSTED = {
  network: "ryph-tools-ryph",
  edge: "ryph",
  joined: true,
  deployment: "ryph",
  guardImage: "ryph-tool-guard:dev",
};
const HOSTED_GUARD: ToolLaunchSpec = { ...GUARD, name: dockerGuardName("ryph-tools-ryph") };

test("the guard is made in three steps: created on the edge, connected, then started", async () => {
  const { calls, cli } = fakeCli();
  const host = dockerToolHost(HOSTED, cli);
  const launched = await host.launch(HOSTED_GUARD);
  assertEquals(launched.address, `${HOSTED_GUARD.name}:8080`);
  const verbs = calls.map((c) => c[0]);
  assertEquals(verbs, ["inspect", "create", "network", "start"]);
  assertEquals(values(calls[1], "--network"), ["ryph"]);
  assertEquals(calls[2], ["network", "connect", "ryph-tools-ryph", HOSTED_GUARD.name]);
  // And a vendor goes straight onto the tools network.
  const vendor = fakeCli();
  await dockerToolHost(HOSTED, vendor.cli).launch(SPEC);
  assertEquals(vendor.calls.map((c) => c[0]), ["inspect", "run"]);
  assertEquals(values(vendor.calls[1], "--network"), ["ryph-tools-ryph"]);
});

test("a vendor launch under any name but a launch key's is refused before docker sees it", async () => {
  // The name is the address the guard routes a key to: nothing else ever runs under one.
  const { calls, cli } = fakeCli();
  const host = dockerToolHost(HOSTED, cli);
  for (
    const name of [
      "ryph-tool-grafana-ms-abc123", // a name from before launch keys
      "ryph-tool-s-ms-01jb", // the old shape's collision: slug `s` + id `ms-01jb`…
      `ryph-tool-${"a".repeat(31)}`,
      `ryph-tool-${"a".repeat(32)}-x`,
      dockerGuardName("elsewhere"), // a guard name that is not this host's guard
    ]
  ) {
    await assertRejects(() => host.launch({ ...SPEC, name }), Error, "launch key", name);
  }
  assertEquals(calls, [], "nothing reached docker");
});

test("logs of a container not launched yet are empty; another's are still refused", async () => {
  // A launch window: the row names its new key before the container exists.
  const absent = fakeCli();
  assertEquals(await dockerToolHost(HOSTED, absent.cli).logs(SPEC.name, 50), "");
  assertEquals(absent.calls.map((c) => c[0]), ["inspect"]);
  const foreign = fakeCli({ inspect: () => "other-net\tother" });
  await assertRejects(
    () => dockerToolHost(HOSTED, foreign.cli).logs(SPEC.name, 50),
    Error,
    "not one of this deployment's",
  );
  assertEquals(foreign.calls.map((c) => c[0]), ["inspect"]);
});

test("a guard half made is removed, so its name does not hold a guard nobody can use", async () => {
  const { calls, cli } = fakeCli({ network: () => new Error("network connect failed") });
  await assertRejects(() => dockerToolHost(HOSTED, cli).launch(HOSTED_GUARD), Error, "connect");
  assertEquals(calls.at(-1), ["rm", "-f", HOSTED_GUARD.name]);
});

test("the guard runs the configured guard image and no other, and publishes only off its edge", async () => {
  const { calls, cli } = fakeCli();
  const host = dockerToolHost(HOSTED, cli);
  await assertRejects(
    () => host.launch({ ...HOSTED_GUARD, image: "evil/image:latest" }),
    Error,
    "never evil/image:latest",
  );
  await assertRejects(
    () => host.launch({ ...HOSTED_GUARD, publish: { hostPort: 0 } }),
    Error,
    "publishes nothing",
  );
  await assertRejects(
    () => dockerToolHost({ ...HOSTED, guardImage: undefined }, cli).launch(HOSTED_GUARD),
    Error,
    "no guard image",
  );
  await assertRejects(
    () => host.launch({ ...SPEC, publish: { hostPort: 0 } }),
    Error,
    "only the tool guard",
  );
  // Nothing was created for any of them.
  assert(!calls.some((c) => c[0] === "create" || c[0] === "run"), JSON.stringify(calls));
});

test("the tools network is the launcher's to make, and the host says its way out", async () => {
  await assertRejects(() => dockerToolHost().ensureNetwork(), Error, "launcher's to make");
  let prepared = 0;
  await dockerToolHost({ prepare: () => Promise.resolve(void prepared++) }).ensureNetwork();
  assertEquals(prepared, 1);
  assertEquals(dockerToolHost().egressProxy, null);
  const relayed = dockerToolHost({ ...HOSTED, egressProxy: "http://ryph-egress-relay-x:7460" });
  assertEquals(relayed.egressProxy, "http://ryph-egress-relay-x:7460");
  assertEquals(relayed.guardImage, "ryph-tool-guard:dev");
});

test("a gateway hosting through the launcher refuses the launcher's own tool settings", async () => {
  const { launcherToolSettingsRefusal, LAUNCHER_OWNED_TOOL_SETTINGS } = await import(
    "../src/adapters/tool_host/launcher.ts"
  );
  const url = "http://launcher:7470";
  assertEquals(launcherToolSettingsRefusal(() => undefined, url), null);
  for (const name of LAUNCHER_OWNED_TOOL_SETTINGS) {
    const refusal = launcherToolSettingsRefusal((n) => (n === name ? "" : undefined), url);
    assert(refusal?.includes(`configuration ${name} is`), `${name}: ${refusal}`);
  }
  assertEquals([...LAUNCHER_OWNED_TOOL_SETTINGS].sort(), [
    "RYPH_DOCKER_RUNTIME",
    "RYPH_TOOL_EGRESS_TARGET",
    "RYPH_TOOL_GUARD_IMAGE",
    "RYPH_TOOL_NETWORK",
  ]);
});

test("the guard's launch is hosting's fixed shape: no env, command, port or cap of the caller's", async () => {
  const { calls, cli } = fakeCli();
  const host = dockerToolHost(HOSTED, cli);
  const node = "--import=data:text/javascript,process.exit(1)";
  const refused: Array<[ToolLaunchSpec, string]> = [
    [{ ...HOSTED_GUARD, env: { ...HOSTED_GUARD.env, NODE_OPTIONS: node } }, "NODE_OPTIONS"],
    [{ ...HOSTED_GUARD, secretEnv: { NODE_OPTIONS: node } }, "NODE_OPTIONS"],
    [{ ...HOSTED_GUARD, command: ["-e", "1"] }, "no command"],
    [{ ...HOSTED_GUARD, port: 22 }, "listens on 8080"],
    [{ ...HOSTED_GUARD, memory: "64g" }, "memory"],
    [{ ...HOSTED_GUARD, cpus: "64" }, "CPU"],
  ];
  for (const [spec, why] of refused) {
    await assertRejects(() => host.launch(spec), Error, why);
    assertThrows(() => guardCreateArgs(spec, HOSTED), Error, why);
  }
  // Refused before anything was inspected, removed or made.
  assertEquals(calls, []);
});
