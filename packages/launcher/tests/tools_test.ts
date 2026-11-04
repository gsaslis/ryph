// The tool-host side of the seam: @ryph/mcp-gateway's launcher ToolHost against a real launcher
// over HTTP, with the real docker ToolHost behind it and only its docker CLI faked. (What the
// launcher makes for hosting — the network, the edge, the relay — is tool_network_test.ts's.)

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  connectLauncherToolHost,
  guardLaunchSpec,
  type ToolLaunchSpec,
} from "@ryph/mcp-gateway/tool-host";
import { LAUNCHER_ROUTES, localImagePrefix } from "@ryph/orchestrator/docker";
import { type FakeImage, imageId } from "../../orchestrator/tests/image_store.ts";
import {
  bodyReads,
  fakeDocker,
  fakeToolCli,
  raw,
  started,
  TOKEN,
  TOOLS_TOKEN,
  trickle,
} from "./harness.ts";
import { MAX_BODY_READS } from "../src/routes.ts";
import type { ToolsConfig } from "../src/config.ts";

/** A hosted server's container, named by its launch key as every vendor launch must be. */
const VENDOR = `ryph-tool-${"a1".repeat(16)}`;

/** Built by hosting's own builder, so a var hosting adds that the launcher refuses fails here. */
const GUARD: ToolLaunchSpec = guardLaunchSpec({
  name: "ryph-tool-guard-ryph-tools-test",
  image: "ryph-tool-guard:test",
  routes: `${"a1".repeat(16)}=${VENDOR}:8000/mcp`,
  token: "guard-secret",
  callers: `${"a1".repeat(16)}=${"c".repeat(32)}`,
});

/** How a joined test launcher hosts: on an edge network of its deployment's, no egress. */
const TOOLS: ToolsConfig = {
  network: "ryph-tools-test",
  joined: true,
  edge: "ryph-test",
  guardImage: "ryph-tool-guard:test",
  egress: null,
};

/** A daemon that is Docker Desktop and already holds a confining tools network. */
const confining = (args: string[]): string | Error =>
  args[0] === "info"
    ? "29.1.0|linux|Docker Desktop"
    : args[0] === "network" && args[1] === "inspect"
    ? "true|isolated|isolated"
    : args[0] === "inspect"
    ? new Error("Error: No such object")
    : "";

async function hosting(
  answer?: (args: string[]) => string | Error,
  runtime?: string,
  tools: ToolsConfig = TOOLS,
) {
  const tool = fakeToolCli(answer);
  const docker = fakeDocker(confining);
  const s = await started({
    exec: docker.exec,
    ...(runtime === undefined ? {} : { docker: { runtime } }),
    tools,
    toolCli: tool.cli,
  });
  return { s, tool, docker };
}

test("a joined launcher's tool host launches, lists, inspects and stops by name", async () => {
  const { s, tool } = await hosting((args) => {
    if (args[0] === "ps") return "ryph-tool-guard-ryph-tools-test\n";
    // Whose it is (its tools network and deployment labels), then how it is.
    if (args[0] === "inspect" && args.includes("--type")) return "ryph-tools-test\tdefault\n";
    if (args[0] === "inspect") return "running\n";
    return "";
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    assertEquals(host.reachesGuard, true);
    assertEquals(host.guardName, "ryph-tool-guard-ryph-tools-test");
    await host.ensureNetwork();
    assertEquals(await host.launch(GUARD), {
      handle: GUARD.name,
      address: `${GUARD.name}:8080`,
    });
    // Created on the edge, connected to the tools network, started.
    const create = tool.calls.find((c) => c.startsWith("create "))!;
    assertStringIncludes(create, "--network ryph-test");
    assert(tool.calls.includes(`network connect ryph-tools-test ${GUARD.name}`));
    assert(tool.calls.includes(`start ${GUARD.name}`));
    // The secret travelled by name on the CLI's environment, never as a word of its argv.
    assert(!create.includes("guard-secret"));
    assertEquals(tool.envs[tool.calls.indexOf(create)], GUARD.secretEnv);
    // A vendor goes onto the tools network alone.
    await host.launch({ ...GUARD, name: VENDOR, image: "grafana/mcp:1" });
    assertStringIncludes(
      tool.calls.find((c) => c.startsWith("run -d"))!,
      "--network ryph-tools-test",
    );
    assertEquals(await host.list(), ["ryph-tool-guard-ryph-tools-test"]);
    assertEquals(await host.inspect(GUARD.name), "running");
    assertEquals(await host.address(GUARD.name, 8080), `${GUARD.name}:8080`);
    await host.stop(GUARD.name);
    assert(tool.calls.includes(`rm -f ${GUARD.name}`));
  } finally {
    await s.close();
  }
});

test("hosted servers get the runtime the launcher's runs get; the guard, its own image, none", async () => {
  for (const runtime of [undefined, "runsc"]) {
    const { s, tool } = await hosting((args) => {
      if (args[0] === "inspect" && args.includes("--type")) return new Error("No such container");
      return "";
    }, runtime);
    try {
      const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
      await host.launch(GUARD);
      await host.launch({ ...GUARD, name: VENDOR, image: "anyone/anything:1" });
      const runs = tool.calls.filter((c) => c.startsWith("run -d"));
      assertEquals(runs.length, 1);
      if (runtime === undefined) assert(!runs[0]!.includes("--runtime"), runs[0]);
      else assertStringIncludes(runs[0]!, `--runtime ${runtime}`);
      assert(!tool.calls.find((c) => c.startsWith("create "))!.includes("--runtime"));
    } finally {
      await s.close();
    }
  }
});

test("the tools token reaches nothing on the run side, and the run token nothing here", async () => {
  const { s } = await hosting();
  try {
    for (
      const [method, path] of [["GET", LAUNCHER_ROUTES.info], ["GET", LAUNCHER_ROUTES.checksList]]
    ) {
      const res = await raw(s.launcher, method, path, TOOLS_TOKEN);
      assertEquals(res.status, 401, path);
      await res.body?.cancel();
    }
    const res = await raw(s.launcher, "POST", "/v1/tools/launch", TOKEN, { spec: GUARD });
    assertEquals(res.status, 401);
    await res.body?.cancel();
    const host = connectLauncherToolHost({ url: s.launcher.url, token: TOKEN }, { waitMs: 0 });
    await assertRejects(() => host);
  } finally {
    await s.close();
  }
});

test("a joined launcher publishes nothing, and touches no container it would not name", async () => {
  const { s, tool } = await hosting();
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    const err = await assertRejects(() => host.launch({ ...GUARD, publish: { hostPort: 0 } }));
    assertStringIncludes(String(err), "publishes nothing");
    // Nor a vendor, ever: only the guard is published, and only off a joined launcher.
    const vendor = await assertRejects(() =>
      host.launch({ ...GUARD, name: `ryph-tool-${"d4".repeat(16)}`, publish: { hostPort: 0 } })
    );
    assertStringIncludes(String(vendor), "only the tool guard");
    // The guard's name with the caller's image would put that image on the deployment network.
    const image = await assertRejects(() => host.launch({ ...GUARD, image: "evil/guard:1" }));
    assertStringIncludes(String(image), "no other");
    // The egress relay is no handle the tool routes take.
    await assertRejects(() => host.stop("ryph-egress-relay-ryph-tools-test"));
    await assertRejects(() => host.logs("ryph-egress-relay-ryph-tools-test", 10));
    // Not a tool container's name: refused by the schema, so `rm -f` never sees it.
    await assertRejects(() => host.stop("ryph-gate-default"));
    await assertRejects(() => host.launch({ ...GUARD, secretEnv: { DOCKER_HOST: "tcp://x" } }));
    assertEquals(
      tool.calls.filter((c) => /^(rm|run|create|logs)\b/.test(c)),
      [],
    );
  } finally {
    await s.close();
  }
});

test("a guard launch is hosting's shape or a 400: no env, command or port of the caller's", async () => {
  const { s, tool } = await hosting();
  try {
    const node = "--import=data:text/javascript,process.exit(1)";
    for (
      const [spec, why] of [
        [{ ...GUARD, env: { ...GUARD.env, NODE_OPTIONS: node } }, "NODE_OPTIONS"],
        [{ ...GUARD, secretEnv: { ...GUARD.secretEnv, NODE_OPTIONS: node } }, "NODE_OPTIONS"],
        [{ ...GUARD, command: ["--require", "/tmp/x.js"] }, "no command"],
        [{ ...GUARD, port: 7440 }, "listens on 8080"],
        [{ ...GUARD, memory: "64g" }, "memory"],
      ] as const
    ) {
      // Straight at the route, so the refusal is the launcher's and not the client's schema.
      const res = await raw(s.launcher, "POST", "/v1/tools/launch", TOOLS_TOKEN, { spec });
      assertEquals(res.status, 400, why);
      assertStringIncludes(await res.text(), why);
    }
    assertEquals(tool.calls.filter((c) => /^(rm|run|create)\b/.test(c)), []);
  } finally {
    await s.close();
  }
});

test("a vendor launch under any name but a launch key's is a 400, and runs nothing", async () => {
  const { s, tool } = await hosting();
  try {
    const spec = { ...GUARD, name: "ryph-tool-grafana-ms-1", image: "mcp/fetch:1" };
    const res = await raw(s.launcher, "POST", "/v1/tools/launch", TOOLS_TOKEN, { spec });
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "not a hosted container name");
    assertEquals(tool.calls.filter((c) => /^(rm|run|create)\b/.test(c)), []);
  } finally {
    await s.close();
  }
});

test("a tools network made a plain bridge since hosting's boot takes no launch", async () => {
  // Confining at boot; then something else on the daemon (an older binary, an older compose
  // file) removes it and makes it again as an ordinary bridge.
  let bridge = false;
  const tool = fakeToolCli((args) =>
    args[0] === "inspect" && args.includes("--type") ? new Error("No such container") : ""
  );
  const s = await started({
    exec: fakeDocker((args) =>
      bridge && args[0] === "network" && args[1] === "inspect" ? "false||" : confining(args)
    ).exec,
    tools: TOOLS,
    toolCli: tool.cli,
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    await host.ensureNetwork();
    const vendor = { ...GUARD, name: VENDOR, image: "grafana/mcp:1" };
    await host.launch(vendor);
    assertEquals(tool.calls.filter((c) => c.startsWith("run -d")).length, 1);
    bridge = true;
    for (const spec of [vendor, GUARD]) {
      const err = await assertRejects(() => host.launch(spec));
      assertStringIncludes(String(err), "is not an internal network");
    }
    // Nothing was removed to make room, and nothing more was run or made.
    assertEquals(tool.calls.filter((c) => c.startsWith("run -d")).length, 1);
    assertEquals(tool.calls.filter((c) => /^(rm|create)\b/.test(c)), []);
  } finally {
    await s.close();
  }
});

test("info says the guard's image and the relay hosted servers reach the internet by", async () => {
  const { s } = await hosting(undefined, undefined, {
    ...TOOLS,
    egress: { image: "ryph-run-gate:test", target: "egress-proxy", port: 7461 },
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    assertEquals(host.guardImage, "ryph-tool-guard:test");
    assertEquals(host.egressProxy, "http://ryph-egress-relay-ryph-tools-test:7460");
  } finally {
    await s.close();
  }
  const off = await hosting();
  try {
    const host = await connectLauncherToolHost({ url: off.s.launcher.url, token: TOOLS_TOKEN });
    assertEquals(host.egressProxy, null);
  } finally {
    await off.s.close();
  }
});

test("hosting is refused on an engine that cannot confine it, naming why", async () => {
  const tool = fakeToolCli();
  const s = await started({
    exec: fakeDocker((args) => args[0] === "info" ? "27.5.1|linux|Ubuntu 24.04" : "").exec,
    tools: TOOLS,
    toolCli: tool.cli,
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    const err = await assertRejects(() => host.ensureNetwork());
    assertStringIncludes(String(err), "older than 28.0");
  } finally {
    await s.close();
  }
});

test("a container on the daemon that is not this launcher's hosted server is never touched", async () => {
  // Another deployment's tool container, by a name the schema allows: on another tools network,
  // on this one but launched by another deployment, or carrying no deployment label at all.
  for (
    const labels of ["ryph-tools-other\tdefault", "ryph-tools-test\tryph", "ryph-tools-test\t"]
  ) {
    await untouched(labels);
  }
});

async function untouched(labels: string) {
  const { s, tool } = await hosting((args) => {
    if (args[0] === "inspect" && args.includes("--type")) return `${labels}\n`;
    if (args[0] === "inspect") return "running\n";
    return "";
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    await assertRejects(() => host.stop(GUARD.name));
    await assertRejects(() => host.logs(GUARD.name, 10));
    // A launch does not remove it to make room for its own.
    await assertRejects(() => host.launch(GUARD));
    assertEquals(await host.inspect(GUARD.name), "unknown");
    assertEquals(await host.address(GUARD.name, 8080), null);
    assertEquals(
      tool.calls.filter((c) => /^(rm|run|logs)\b/.test(c) || c.startsWith("inspect -f")),
      [],
    );
  } finally {
    await s.close();
  }
}

test("a hosted server never runs an environment image, whatever spelling resolves to one", async () => {
  const own = `${localImagePrefix("default")}repo:baked-env-1`;
  const theirs = "ryph-env/0123456789ab/repo:baked-env-1";
  const env: FakeImage = { id: imageId("e"), names: [own] };
  const foreign: FakeImage = { id: imageId("f"), names: [theirs] };
  const untagged: FakeImage = { id: imageId("9"), names: [] };
  const shadow: FakeImage = { id: imageId("5"), names: ["grafana/grafana:11", theirs + "x"] };
  const vendor: FakeImage = { id: imageId("4"), names: ["mcp/fetch:1"] };
  // No container by either name yet.
  const tool = fakeToolCli((args) =>
    args[0] === "inspect" && args.includes("--type") ? new Error("No such container") : ""
  );
  const s = await started({
    exec: fakeDocker(confining, [env, foreign, untagged, shadow, vendor]).exec,
    tools: TOOLS,
    toolCli: tool.cli,
  });
  try {
    const host = await connectLauncherToolHost({ url: s.launcher.url, token: TOOLS_TOKEN });
    const hex = foreign.id.slice("sha256:".length);
    for (
      const image of [
        own,
        env.id,
        theirs,
        foreign.id,
        hex.slice(0, 4),
        hex,
        `sha256:${hex.slice(0, 6)}`,
        `docker.io/${theirs}`,
        `index.docker.io/${own}`,
        `${theirs.split(":")[0]}@${foreign.id}`,
        untagged.id,
        "grafana/grafana:11",
        "ryph-env/absent/repo:1",
      ]
    ) {
      const err = await assertRejects(() => host.launch({ ...GUARD, name: VENDOR, image }));
      assertStringIncludes(String(err), "not a hosted server's image", image);
    }
    assertEquals(tool.calls.filter((c) => c.startsWith("run") || c.startsWith("rm")), []);
    // A vendor's image in the store runs by the id judged; one it lacks keeps its name.
    await host.launch({ ...GUARD, name: `ryph-tool-${"f2".repeat(16)}`, image: "mcp/fetch:1" });
    await host.launch({ ...GUARD, name: `ryph-tool-${"e3".repeat(16)}`, image: "mcp/other:1" });
    const runs = tool.calls.filter((c) => c.startsWith("run -d"));
    assert(runs[0]!.includes(` ${vendor.id}`) && !runs[0]!.includes("mcp/fetch:1"), runs[0]);
    assert(runs[1]!.includes(" mcp/other:1"), runs[1]);
  } finally {
    await s.close();
  }
});

test("the tools token reads at most MAX_BODY_READS bodies at once, and never the run side's share", async () => {
  const tool = fakeToolCli();
  const reads = bodyReads();
  const s = await started({
    exec: fakeDocker().exec,
    tools: TOOLS,
    toolCli: tool.cli,
    bodyReadMs: 2_000,
    serve: reads.serve,
  });
  const held = Array.from({ length: MAX_BODY_READS }, () => {
    const controller = new AbortController();
    const body = trickle();
    const res = fetch(`${s.launcher.url}/v1/tools/launch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOOLS_TOKEN}`, "content-type": "application/json" },
      body: body.body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit).catch(() => null);
    return { res, body, abort: () => controller.abort() };
  });
  try {
    await reads.reading(MAX_BODY_READS);
    const over = await raw(s.launcher, "POST", "/v1/tools/network", TOOLS_TOKEN, {});
    assertEquals(over.status, 503);
    await over.body?.cancel();
    // The run side reads its own bodies meanwhile.
    const run = await raw(s.launcher, "POST", LAUNCHER_ROUTES.kill, TOKEN, { nope: 1 });
    assertEquals(run.status, 400);
    await run.body?.cancel();
    for (const h of held) h.abort();
    await Promise.all(held.map((h) => h.res));
  } finally {
    for (const h of held) h.body.stop();
    await s.close();
  }
});
