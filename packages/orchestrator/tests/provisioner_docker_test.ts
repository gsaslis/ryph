// The docker provisioner's argv, which is the whole contract between the orchestrator and an
// agent container: the image, the env the runner boots from, and the boundary.

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  bridgeOnThisMachine,
  browserArgs,
  browserContainerName,
  confinedNetworkFlags,
  defaultRunNetwork,
  dockerEngine,
  dockerProvisioner,
  ensureGate,
  ensureRunNetwork,
  EPHEMERAL_GATE_OWNER,
  GATE_DEFER_CAP_MS,
  gateArgs,
  gateCommand,
  gateCommandRoutes,
  gateCurrent,
  gateName,
  gateRoutesFor,
  gateSecurityDrift,
  inspectContainer,
  inspectInternalNetwork,
  launchArgs,
  localBridgeGateway,
  networkName,
  parseDockerEngine,
  reclaimOrphans,
  runContainerOwnership,
  runNetworkCreateArgs,
  runNetworkProblem,
  serviceArgs,
  serviceNetworkArgs,
} from "../src/adapters/provisioner/docker.ts";
import type { ServiceSpec } from "../src/core/types.ts";
import { ImageGone } from "../src/ports/image_gone.ts";
import { localImagePrefix, notOwnImage } from "../src/adapters/environment_builder/local_images.ts";
import { type FakeImage, imageId, storeExec } from "./image_store.ts";
import { silentDiagnostics, UNSIZED } from "./doubles.ts";

test("reclaim reads the store only after listing docker, and spares what it names", async () => {
  // Launches run concurrently with the reconcile. A run's row is written before its launch
  // creates anything, so reading the store AFTER the listing is what guarantees every object
  // listed belongs to a run the read can see — the opposite order reclaims a launch mid-boot.
  const calls: string[] = [];
  const exec = (args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return Promise.resolve("c-done\tr-done\nc-new\tr-new");
    if (args[0] === "network" && args[1] === "ls") {
      return Promise.resolve("n-done\tr-done\nn-new\tr-new");
    }
    return Promise.resolve("");
  };
  const reclaimed = await reclaimOrphans(
    {},
    () => {
      calls.push("store");
      return Promise.resolve(["r-new"]);
    },
    silentDiagnostics(),
    exec,
  );

  assertEquals(calls.map((c) => c.split(" --")[0]), [
    "ps -a",
    "network ls",
    "store",
    "rm -fv c-done",
    "network rm n-done",
  ]);
  assertEquals(reclaimed, { containers: 1, networks: 1 });
});

test("container inspection distinguishes absence from an unavailable daemon", async () => {
  for (
    const message of [
      "docker inspect failed: Error: No such container: removed",
      "docker inspect failed: Error: No such object: removed",
    ]
  ) {
    assertEquals(
      await inspectContainer("removed", () => Promise.reject(new Error(message))),
      "exited",
    );
  }
  for (
    const message of [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      "permission denied while trying to connect to the Docker daemon socket",
      "unexpected inspection failure",
    ]
  ) {
    assertEquals(
      await inspectContainer("live", () => Promise.reject(new Error(message))),
      "unknown",
    );
  }
});

test("container inspection preserves live, exited and unrecognised states", async () => {
  for (
    const [status, expected] of [
      ["created", "running"],
      ["running", "running"],
      ["restarting", "running"],
      ["exited", "exited"],
      ["dead", "exited"],
      ["paused", "unknown"],
    ]
  ) {
    const calls: string[][] = [];
    const state = await inspectContainer("container-id", (args) => {
      calls.push(args);
      return Promise.resolve(status);
    });
    assertEquals(calls, [["inspect", "-f", "{{.State.Status}}", "container-id"]]);
    assertEquals(state, expected);
  }
});

test("one orphan docker will not remove does not starve the rest", async () => {
  // Failing the pass on the first stuck object skipped every orphan after it, every tick, and
  // the ~31-network pool fills with leftovers that were each removable.
  const removed: string[] = [];
  const exec = (args: string[]) => {
    if (args[0] === "ps") return Promise.resolve("c-stuck\tr-a\nc-ok\tr-b");
    if (args[0] === "network" && args[1] === "ls") {
      return Promise.resolve("n-stuck\tr-a\nn-ok\tr-b");
    }
    if (args.includes("c-stuck") || args.includes("n-stuck")) {
      return Promise.reject(new Error("has active endpoints"));
    }
    removed.push(args.join(" "));
    return Promise.resolve("");
  };
  const diag = silentDiagnostics();
  const reclaimed = await reclaimOrphans({}, () => Promise.resolve([]), diag, exec);

  assertEquals(removed, ["rm -fv c-ok", "network rm n-ok"]);
  assertEquals(reclaimed, { containers: 1, networks: 1 });
});

test("a finished run's agent is reclaimed once it exited, never while it still flushes", async () => {
  // A terminal run's runner reports first and flushes its last transcript batch on the way out:
  // removing it while it runs cuts the tail. A service or browser has nothing to flush.
  const removed: string[] = [];
  const exec = (args: string[]) => {
    if (args[0] === "ps") {
      return Promise.resolve(
        [
          "agent-exited\tr-done\t\texited",
          "agent-flushing\tr-done\t\trunning",
          "browser-running\tr-done\tbrowser\trunning",
          "agent-live\tr-live\t\trunning",
        ].join("\n"),
      );
    }
    if (args[0] === "rm") removed.push(args.at(-1)!);
    return Promise.resolve("");
  };
  await reclaimOrphans({}, () => Promise.resolve(["r-live"]), silentDiagnostics(), exec);

  assertEquals(removed, ["agent-exited", "browser-running"]);
});

test("the agent carries the deployment label, so only its own deployment reclaims it", () => {
  const args = launchArgs(SPEC, { network: "ryph" });
  assertEquals(args.filter((_, i) => args[i - 1] === "--label").sort(), [
    "ryph.deployment=ryph",
    "ryph.run=r-1",
  ]);
});

const SPEC = {
  runId: "r-1",
  image: "ryph-agent",
  size: UNSIZED,
  env: { RYPH_RUN_ID: "r-1", RYPH_PUBLIC_URL: "http://host.docker.internal:7411" },
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("no runtime configured leaves docker on its default", () => {
  const args = launchArgs(SPEC, {});
  assertEquals(args.includes("--runtime"), false);
});

test("a configured runtime rides every launch, ahead of the image", () => {
  const args = launchArgs(SPEC, { runtime: "kata-runtime", network: "ryph" });
  assertEquals(flagValue(args, "--runtime"), "kata-runtime");
  assertEquals(args[args.length - 1], "ryph-agent");
  // The boundary is a run flag, not an argument to the container's own command line.
  assertEquals(args.indexOf("--runtime") < args.indexOf("ryph-agent"), true);
});

test("the runtime does not disturb the network or env", () => {
  const opts = { runtime: "runsc", network: "ryph" };
  const plain = launchArgs(SPEC, { network: "ryph" });
  const sandboxed = launchArgs(SPEC, opts);
  assertEquals(sandboxed.filter((a) => a !== "--runtime" && a !== "runsc"), plain);
  // No host path is ever bind-mounted into a run: a local repository reaches it through the
  // gateway like any other.
  assertEquals(sandboxed.includes("--mount"), false);
});

test("host.docker.internal is mapped, so the name resolves off Docker Desktop too", () => {
  // Desktop publishes it for free; a native Linux daemon does not. Without the mapping, the
  // address the orchestrator hands its runners is a name that NXDOMAINs on exactly the machines
  // a server deployment runs on — and the run fails long after the cause.
  const args = launchArgs(SPEC, {});
  assertEquals(args[args.indexOf("--add-host") + 1], "host.docker.internal:host-gateway");
});

test("the agent gets no capability and no privilege to gain, confined or not", () => {
  // As on Kubernetes (runnerSecurity in kubernetes.ts): the runner needs neither.
  for (const opts of [{}, { network: "ryph" }, { runNetwork: "ryph-runs" }]) {
    for (const verb of [["run", "-d"], ["create"]]) {
      const args = launchArgs(SPEC, opts, verb);
      assertEquals(flagValue(args, "--cap-drop"), "ALL");
      assertEquals(flagValue(args, "--security-opt"), "no-new-privileges");
      assertEquals(args.includes("--cap-add"), false);
      assertEquals(args.indexOf("--cap-drop") < args.indexOf("ryph-agent"), true);
    }
  }
});

test("a null image is refused rather than launched", () => {
  assertThrows(
    () => launchArgs({ ...SPEC, image: null }, { runtime: "kata-runtime" }),
    Error,
    "RYPH_AGENT_IMAGE",
  );
});

// ---------------------------------------------------------------------------
// Service containers.
// ---------------------------------------------------------------------------

const DB: ServiceSpec = {
  name: "db",
  image: `postgres:18@sha256:${"a".repeat(64)}`,
  command: ["postgres", "-p", "5433"],
  env: { POSTGRES_PASSWORD: "password" },
  port: 5433,
  security: { capabilities: ["CHOWN", "SETGID", "SETUID"], allowPrivilegeEscalation: false },
  resources: { cpus: "1", memory: "1g" },
};

test("a run with no services produces exactly the argv it always did", () => {
  // The overwhelmingly common case must not change shape under this feature.
  assertEquals(
    launchArgs({ ...SPEC, services: [] }, { network: "ryph" }),
    launchArgs(SPEC, {
      network: "ryph",
    }),
  );
});

test("with services the agent is CREATED, so it can join a second network first", () => {
  const created = launchArgs(SPEC, { network: "ryph" }, ["create"]);
  assertEquals(created[0], "create");
  // Everything else is identical: the services path adds steps, never variants. In particular
  // the agent KEEPS the deployment network and host-gateway alias — a shared network namespace
  // would have cost it both, i.e. its route to its own control plane.
  assertEquals(created.slice(1), launchArgs(SPEC, { network: "ryph" }).slice(2));
  assertEquals(flagValue(created, "--network"), "ryph");
  assertEquals(flagValue(created, "--add-host"), "host.docker.internal:host-gateway");
});

test("a service is dropped to ALL and handed back only the catalogue's capabilities", () => {
  const args = serviceArgs("r-1", DB, {});
  assertEquals(flagValue(args, "--cap-drop"), "ALL");
  assertEquals(args.filter((_, i) => args[i - 1] === "--cap-add"), [
    "CHOWN",
    "SETGID",
    "SETUID",
  ]);
  assertEquals(args.includes("--security-opt"), true);
  assertEquals(flagValue(args, "--security-opt"), "no-new-privileges");
  // THE CONTRACT: the declared name is the hostname, on its own network.
  assertEquals(flagValue(args, "--network"), networkName("r-1"));
  assertEquals(flagValue(args, "--network-alias"), "db");
  // The operator's caps, and no restart: a service that dies has failed, and restarting it
  // would hide the failure behind a health gate that eventually passes.
  assertEquals(flagValue(args, "--memory"), "1g");
  assertEquals(flagValue(args, "--cpus"), "1");
  assertEquals(flagValue(args, "--restart"), "no");
  // The image, then the repo's own command — in that order, or docker reads the command as
  // the image.
  assertEquals(args.slice(-4), [DB.image, "postgres", "-p", "5433"]);
});

test("a service runs under the same sandboxed runtime the agent does", () => {
  // A service is a repo-chosen image running a repo-supplied `command`. A deployment that
  // asked for gVisor and silently got the shared-kernel default HERE would have the hole
  // --runtime exists to close, on the container it has the least reason to trust.
  assertEquals(flagValue(serviceArgs("r-1", DB, { runtime: "runsc" }), "--runtime"), "runsc");
  assertEquals(serviceArgs("r-1", DB, {}).includes("--runtime"), false);
});

test("both a run's containers and its network carry the run label, for boot reconcile", () => {
  const service = serviceArgs("r-1", DB, { network: "ryph" });
  assertEquals(service.filter((_, i) => service[i - 1] === "--label").sort(), [
    "ryph.deployment=ryph",
    "ryph.role=service",
    "ryph.run=r-1",
  ]);
  // The network is named for the run too, so `docker network ls` reads as a list of live runs.
  assertEquals(networkName("r-1"), "ryph-run-r-1");
});

test("a deployment labels what it creates, and reclaims only what carries that label", async () => {
  // One daemon, two ryph deployments — the documented dev loop is exactly that (`bun run up`
  // beside `bun run compose:up`). Without this, each sweep finds the other's run ids missing
  // from ITS store and force-removes a live run's database mid-suite.
  const onDefaultBridge = serviceArgs("r-1", DB, {});
  assertEquals(
    onDefaultBridge.filter((_, i) => onDefaultBridge[i - 1] === "--label").sort(),
    ["ryph.deployment=default", "ryph.role=service", "ryph.run=r-1"],
  );

  const filters: string[][] = [];
  const exec = (args: string[]) => {
    if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) {
      filters.push(args.filter((_, i) => args[i - 1] === "--filter"));
    }
    return Promise.resolve("");
  };
  await reclaimOrphans(
    { network: "ryph" },
    () => Promise.resolve([]),
    silentDiagnostics(),
    exec,
  );
  // Both listings, not just the containers': a run network is as much this deployment's as the
  // services on it.
  assertEquals(filters, [
    // Every container of a run — services, browsers and the agent.
    ["label=ryph.run", "label=ryph.deployment=ryph"],
    ["label=ryph.run", "label=ryph.deployment=ryph"],
  ]);
});

test("a size class caps the container's cpus and memory, in docker's spelling", () => {
  const args = launchArgs({
    ...SPEC,
    size: {
      name: "large",
      cpu: "1500m",
      memory: "8Gi",
      ephemeralStorage: "10Gi",
      workVolume: "50Gi",
    },
  }, {});
  assertEquals(flagValue(args, "--cpus"), "1.5");
  // Mebibytes, not `8Gi`: docker reads `8gi` as nothing it knows and refuses the launch.
  assertEquals(flagValue(args, "--memory"), "8192m");
  // Disk has no portable flag; the adapter says so once rather than failing the launch.
  assertEquals(args.some((a) => a.startsWith("--storage-opt")), false);
  assertEquals(args.indexOf("--cpus") < args.indexOf("ryph-agent"), true);
});

test("an unconstrained class adds no resource flags at all", () => {
  const args = launchArgs(SPEC, {});
  assertEquals(flagValue(args, "--cpus"), undefined);
  assertEquals(flagValue(args, "--memory"), undefined);
});

// --- the browser sidecar ---------------------------------------------------------------------

const BROWSER = {
  image: "ryph-browser:test",
  port: 7490,
  resources: { cpu: "1", memory: "1536Mi" },
};

test("the browser joins the AGENT's namespace, confined like the agent, labelled for teardown", () => {
  assertEquals(browserArgs("r-1", "abc123", BROWSER, { network: "ryph" }), [
    "run",
    "-d",
    "--name",
    "ryph-browser-r-1",
    "--label",
    "ryph.run=r-1",
    "--label",
    "ryph.role=browser",
    "--label",
    "ryph.deployment=ryph",
    // localhost is the agent's: a dev server it starts is the page the browser opens.
    "--network",
    "container:abc123",
    "--user",
    "1994:1994",
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--shm-size",
    "256m",
    // runc: docker's seccomp refuses Chromium's sandbox, so the sidecar is told not to try.
    "--env",
    "RYPH_BROWSER_SANDBOX=off",
    "--cpus",
    "1",
    "--memory",
    "1536m",
    "ryph-browser:test",
  ]);
  assertEquals(browserContainerName("r-1"), "ryph-browser-r-1");
});

test("the browser runs under the agent's runtime, its sandbox left to try, and takes no port", () => {
  const args = browserArgs(
    "r-1",
    "abc",
    { ...BROWSER, resources: { cpu: "500m", memory: "2Gi" } },
    {
      runtime: "runsc",
    },
  );
  assertEquals(args[args.indexOf("--runtime") + 1], "runsc");
  assertEquals(args[args.indexOf("--cpus") + 1], "0.5");
  assertEquals(args[args.indexOf("--memory") + 1], "2048m");
  // A runtime of the operator's choosing: the sandbox policy is left unset (try, then fall back).
  assertEquals(args.some((a) => a.startsWith("RYPH_BROWSER_SANDBOX")), false);
  assertEquals(
    args.includes("--env") || args.includes("-e") || args.includes("-p") ||
      args.includes("--add-host"),
    false,
  );
  // The image is last: nothing after it, so the image's own entrypoint runs untouched.
  assertEquals(args.at(-1), "ryph-browser:test");
});

test("an uncapped browser omits resource flags without removing gate caps", () => {
  for (
    const resources of [{ cpu: null, memory: null }, { cpu: "1", memory: null }, {
      cpu: null,
      memory: "2Gi",
    }]
  ) {
    const args = browserArgs("r-1", "abc", { ...BROWSER, resources }, {});
    assertEquals(flagValue(args, "--cpus"), resources.cpu === null ? undefined : "1");
    assertEquals(flagValue(args, "--memory"), resources.memory === null ? undefined : "2048m");
  }
  assertEquals(flagValue(gateArgs(CONFINED), "--cpus"), "1");
  assertEquals(flagValue(gateArgs(CONFINED), "--memory"), "128m");
});

test("docker says it launches a browser", () => {
  assertEquals(dockerProvisioner({}, silentDiagnostics()).supportsBrowser, true);
});

// ── Confined runs: an internal run network, and the gate as the one way back to ryph ──────────

/** Each port to the same port on the host, as the binary's gate relays. */
const toHost = (...ports: number[]) =>
  ports.map((port) => ({ listen: port, target: "host.docker.internal", port }));

const CONFINED = {
  runNetwork: "ryph-runs",
  gate: { image: "ryph-run-gate:dev", routes: toHost(7460, 7411, 7430, 7420) },
};

test("a confined run joins the internal network alone, with no name for the host", () => {
  const args = launchArgs(SPEC, CONFINED);
  assertEquals(args.filter((a) => a === "--network").length, 1);
  assertEquals(flagValue(args, "--network"), "ryph-runs");
  // No host alias: the host is reachable only through the gate, and a mapping would be a name
  // pointing at a door the network has already shut.
  assertEquals(args.includes("--add-host"), false);
});

test("the deployment network never rides along with the run network", () => {
  // Attached to both, a run takes its route from the ordinary one, and reads as confined while
  // enforcing nothing.
  const args = launchArgs(SPEC, { ...CONFINED, network: "ryph" });
  assertEquals(args.filter((a) => a === "--network").length, 1);
  assertEquals(flagValue(args, "--network"), "ryph-runs");
});

test("an unconfined run is untouched by the confined path", () => {
  assertEquals(launchArgs(SPEC, { network: "ryph" }).includes("--add-host"), true);
  assertEquals(flagValue(launchArgs(SPEC, { network: "ryph" }), "--network"), "ryph");
});

test("a confined run's services network is internal too, and an unconfined one is not", () => {
  assertEquals(serviceNetworkArgs("r-1", CONFINED).includes("--internal"), true);
  assertEquals(serviceNetworkArgs("r-1", {}).includes("--internal"), false);
  assertEquals(serviceNetworkArgs("r-1", CONFINED).at(-1), "ryph-run-r-1");
});

test("the gate is named for the deployment, so two deployments on one daemon get one each", () => {
  assertEquals(gateName({}), "ryph-gate-default");
  assertEquals(gateName({ network: "ryph" }), "ryph-gate-ryph");
});

test("the gate's command is its whole policy: every route spelled out, sorted and unique", () => {
  assertEquals(gateCommand({ image: "g", routes: toHost(7460, 7411, 7411) }), [
    "7411=host.docker.internal:7411",
    "7460=host.docker.internal:7460",
  ]);
  assertEquals(
    gateCommand({
      image: "g",
      perSource: 64,
      routes: [
        { listen: 7420, target: "model-proxy", port: 7420 },
        { listen: 7411, target: "control-plane", port: 7411 },
        { listen: 80, target: "previews", port: 8080 },
      ],
    }),
    ["--per-source", "64", "80=previews:8080", "7411=control-plane:7411", "7420=model-proxy:7420"],
  );
  // One listen port, two destinations: nobody can mean that.
  assertThrows(
    () =>
      gateCommand({
        image: "g",
        routes: [{ listen: 7411, target: "a", port: 7411 }, {
          listen: 7411,
          target: "b",
          port: 7411,
        }],
      }),
    Error,
    "port 7411 to both a:7411 and b:7411",
  );
});

test("the gate is created on the ordinary side, stripped, and labelled out of the reclaim", () => {
  const args = gateArgs(CONFINED);
  assertEquals(args[0], "create");
  assertEquals(flagValue(args, "--name"), "ryph-gate-default");
  // The ordinary network first: docker takes the default route from it.
  assertEquals(flagValue(args, "--network"), "bridge");
  assertEquals(flagValue(args, "--add-host"), "host.docker.internal:host-gateway");
  assertEquals(flagValue(args, "--cap-drop"), "ALL");
  assertEquals(flagValue(args, "--security-opt"), "no-new-privileges");
  assertEquals(flagValue(args, "--user"), "65534:65534");
  assertEquals(args.includes("--read-only"), true);
  assertEquals(flagValue(args, "--restart"), "unless-stopped");
  // No `ryph.role`: reclaimOrphans removes any container carrying one whose run is not active.
  assertEquals(args.some((a) => a.startsWith("ryph.role")), false);
  assertEquals(args.includes("ryph.deployment=default"), true);
  assertEquals(args.slice(args.indexOf("ryph-run-gate:dev") + 1), [
    "7411=host.docker.internal:7411",
    "7420=host.docker.internal:7420",
    "7430=host.docker.internal:7430",
    "7460=host.docker.internal:7460",
  ]);
  assertEquals(flagValue(gateArgs({ ...CONFINED, network: "ryph" }), "--network"), "ryph");
});

test("a gate relaying only to containers on the deployment network gets no name for the host", () => {
  const args = gateArgs({
    ...CONFINED,
    network: "ryph-compose",
    gate: {
      ...CONFINED.gate,
      routes: [
        { listen: 7411, target: "control-plane", port: 7411 },
        { listen: 7420, target: "model-proxy", port: 7420 },
      ],
    },
  });
  assertEquals(flagValue(args, "--network"), "ryph-compose");
  assertEquals(args.includes("--add-host"), false);
  assertEquals(args.slice(args.indexOf("ryph-run-gate:dev") + 1), [
    "7411=control-plane:7411",
    "7420=model-proxy:7420",
  ]);
  // One route to the host is enough to need its name.
  const mixed = gateArgs({
    ...CONFINED,
    network: "ryph-compose",
    gate: {
      ...CONFINED.gate,
      routes: [{ listen: 7411, target: "control-plane", port: 7411 }, ...toHost(7460)],
    },
  });
  assertEquals(flagValue(mixed, "--add-host"), "host.docker.internal:host-gateway");
});

function gateInspect(over: {
  running?: boolean;
  image?: string;
  cmd?: string[];
  networks?: string[];
  owner?: string;
  forwards?: boolean;
} = {}): string {
  return JSON.stringify([{
    State: { Running: over.running ?? true },
    Image: over.image ?? "sha256:gate",
    HostConfig: { Sysctls: over.forwards ? {} : { "net.ipv4.ip_forward": "0" } },
    Config: {
      Cmd: over.cmd ?? gateCommand(CONFINED.gate),
      Labels: over.owner === undefined ? {} : { "ryph.gate.owner": over.owner },
    },
    NetworkSettings: {
      Networks: Object.fromEntries((over.networks ?? ["bridge", "ryph-runs"]).map((n) => [n, {}])),
    },
  }]);
}

test("a gate is current only when running, on the image, with the command, on both networks", () => {
  assertEquals(gateCurrent(gateInspect(), "sha256:gate", CONFINED), true);
  assertEquals(gateCurrent(gateInspect({ running: false }), "sha256:gate", CONFINED), false);
  assertEquals(gateCurrent(gateInspect(), "sha256:rebuilt", CONFINED), false);
  assertEquals(
    gateCurrent(gateInspect({ cmd: ["7411=host.docker.internal:7411"] }), "sha256:gate", CONFINED),
    false,
  );
  // The same routes in the gate's short form are not the command this deployment writes.
  assertEquals(
    gateCurrent(
      gateInspect({ cmd: ["--target", "host.docker.internal", "7411", "7420", "7430", "7460"] }),
      "sha256:gate",
      CONFINED,
    ),
    false,
  );
  assertEquals(gateCurrent(gateInspect({ networks: ["bridge"] }), "sha256:gate", CONFINED), false);
  // A confined build's own network beside them is no drift.
  assertEquals(
    gateCurrent(
      gateInspect({ networks: ["bridge", "ryph-runs", "ryph-build-env-1"] }),
      "sha256:gate",
      CONFINED,
    ),
    true,
  );
  // A gate made before it stopped routing between its networks is remade.
  assertEquals(gateCurrent(gateInspect({ forwards: true }), "sha256:gate", CONFINED), false);
  assertEquals(flagValue(gateArgs(CONFINED), "--sysctl"), "net.ipv4.ip_forward=0");
  assertEquals(gateCurrent("not json", "sha256:gate", CONFINED), false);
});

/** A fake docker CLI: answers by the argv's head, records every call. */
function fakeDocker(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const exec = (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    // The longest prefix that matches wins, so a specific answer can sit beside a general one.
    const hit = Object.entries(answers).filter(([prefix]) => line.startsWith(prefix))
      .sort(([a], [b]) => b.length - a.length)[0];
    if (hit !== undefined) {
      const answer = hit[1];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return Promise.resolve("");
  };
  return { calls, exec };
}

const DESKTOP = "29.8.0|linux|Docker Desktop";
const LINUX = "29.8.0|linux|Ubuntu 24.04.1 LTS";
const OLD_LINUX = "27.5.1|linux|Debian GNU/Linux 12 (bookworm)";
const ISOLATED = "true|isolated|isolated";

/** The answers a healthy confined deployment's docker gives, `over` on top. */
const healthy = (over: Record<string, string | Error> = {}) =>
  fakeDocker({
    info: LINUX,
    "network inspect": ISOLATED,
    "image inspect": "sha256:gate",
    "inspect --type container": gateInspect(),
    ...over,
  });

test("the engine reads as a VM on Desktop and OrbStack, native elsewhere", () => {
  assertEquals(parseDockerEngine(DESKTOP), {
    version: "29.8.0",
    vm: true,
    isolatedGateway: true,
    podman: false,
  });
  assertEquals(parseDockerEngine("28.0.0|linux|OrbStack").vm, true);
  assertEquals(parseDockerEngine(LINUX), {
    version: "29.8.0",
    vm: false,
    isolatedGateway: true,
    podman: false,
  });
  assertEquals(parseDockerEngine(OLD_LINUX).isolatedGateway, false);
  // Unreadable is the strict reading: native, and no isolated gateway.
  assertEquals(parseDockerEngine(""), {
    version: "",
    vm: false,
    isolatedGateway: false,
    podman: false,
  });
  // Colima, Rancher Desktop (Lima) and rootless docker are not positively VM-backed: strict.
  assertEquals(parseDockerEngine("28.1.1|linux|Ubuntu 24.04 LTS").vm, false);
  assertEquals(parseDockerEngine("27.3.1|linux|Rancher Desktop WSL Distribution").vm, false);
});

test("the engine is read once per docker, and a failed read is asked again", async () => {
  let reads = 0;
  const exec = (args: string[]) => {
    if (args[0] !== "info") return Promise.resolve("");
    return ++reads === 1 ? Promise.reject(new Error("daemon down")) : Promise.resolve(LINUX);
  };
  await assertRejects(() => dockerEngine(exec), Error, "daemon down");
  assertEquals((await dockerEngine(exec)).version, "29.8.0");
  await dockerEngine(exec);
  assertEquals(reads, 2);
});

test("a run network is created internal with no gateway on the host, where the engine can", () => {
  assertEquals(runNetworkCreateArgs("ryph-runs", parseDockerEngine(LINUX)), [
    "network",
    "create",
    "--internal",
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv6=isolated",
    "--label",
    "ryph.runs=1",
    "ryph-runs",
  ]);
  assertEquals(
    runNetworkCreateArgs("ryph-runs", parseDockerEngine("27.5.1|linux|Docker Desktop")).includes(
      "-o",
    ),
    false,
  );
});

test("on a Linux engine an internal run network with a host gateway does not confine", () => {
  const linux = parseDockerEngine(LINUX);
  const plain = { internal: true, isolated: false };
  const problem = runNetworkProblem("ryph-runs", plain, linux);
  assertEquals(problem?.includes("gateway mode `isolated`"), true);
  assertEquals(
    problem?.includes("gateway_mode_ipv4=isolated -o com.docker.network.bridge.gateway_mode_ipv6"),
    true,
    "the fix is named in full",
  );
  assertEquals(runNetworkProblem("ryph-runs", { internal: true, isolated: true }, linux), null);
  // Missing is fine: it will be made right.
  assertEquals(runNetworkProblem("ryph-runs", null, linux), null);
  // Desktop 28+ can make an isolated one, so it must: a VM-side 0.0.0.0 listener answers at a
  // plain internal network's gateway (MINOR 4). Only a VM-backed engine older than 28 is
  // grandfathered.
  const desktop = runNetworkProblem("ryph-runs", plain, parseDockerEngine(DESKTOP));
  assertEquals(desktop?.includes("gateway mode `isolated`"), true);
  assertEquals(desktop?.includes("docker network rm ryph-runs"), true, "names the recreate");
  assertEquals(desktop?.includes("ryph setup"), true);
  assertEquals(
    runNetworkProblem("ryph-runs", plain, parseDockerEngine("27.5.1|linux|Docker Desktop")),
    null,
  );
  // Not internal is refused everywhere.
  assertEquals(
    runNetworkProblem("ryph-runs", { internal: false, isolated: false }, parseDockerEngine(DESKTOP))
      ?.includes("not an internal network"),
    true,
  );
});

test("a Linux engine older than 28 cannot confine runs at all", () => {
  const problem = runNetworkProblem(
    "ryph-runs",
    { internal: true, isolated: false },
    parseDockerEngine(OLD_LINUX),
  );
  assertEquals(problem?.includes("27.5.1 is older than 28.0"), true);
  assertEquals(runNetworkProblem("ryph-runs", null, parseDockerEngine(OLD_LINUX)) !== null, true);
});

test("inspectInternalNetwork reads internal and isolated, and can't-tell", async () => {
  assertEquals(await inspectInternalNetwork("n", fakeDocker({ "": ISOLATED }).exec), {
    internal: true,
    isolated: true,
  });
  assertEquals(await inspectInternalNetwork("n", fakeDocker({ "": "true||" }).exec), {
    internal: true,
    isolated: false,
  });
  // Only the v4 half isolated is not isolated: a v6 gateway is a gateway.
  assertEquals(
    (await inspectInternalNetwork("n", fakeDocker({ "": "true|isolated|" }).exec))?.isolated,
    false,
  );
  assertEquals(await inspectInternalNetwork("n", fakeDocker({ "": "false||" }).exec), {
    internal: false,
    isolated: false,
  });
  assertEquals(await inspectInternalNetwork("n", fakeDocker({ "": new Error("no") }).exec), null);
  assertEquals(await inspectInternalNetwork("n", fakeDocker({ "": "<no value>" }).exec), null);
});

test("a confined run's own networks get the isolated gateway the engine allows", () => {
  assertEquals(confinedNetworkFlags({}), []);
  assertEquals(confinedNetworkFlags(CONFINED), ["--internal"]);
  assertEquals(confinedNetworkFlags({ ...CONFINED, isolateGateway: true }), [
    "--internal",
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv6=isolated",
  ]);
  assertEquals(
    serviceNetworkArgs("r-1", { ...CONFINED, isolateGateway: true }).includes(
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    ),
    true,
  );
  // Unconfined ignores it: an ordinary network cannot take the option.
  assertEquals(serviceNetworkArgs("r-1", { isolateGateway: true }).includes("-o"), false);
});

test("a current gate on a confining network is left alone", async () => {
  const { calls, exec } = healthy();
  assertEquals(await ensureGate(CONFINED, exec), { state: "current", isolateGateway: true });
  assertEquals(calls.some((c) => c.startsWith("create") || c.startsWith("rm")), false);
});

test("a stale gate with nothing behind it is replaced: removed, created, connected, started", async () => {
  const { calls, exec } = healthy({ "image inspect": "sha256:rebuilt" });
  assertEquals((await ensureGate(CONFINED, exec)).state, "created");
  const tail = calls.slice(calls.findIndex((c) => c === "rm -f ryph-gate-default"));
  assertEquals(tail.map((c) => c.split(" ").slice(0, 2).join(" ")), [
    "rm -f",
    "create --name",
    "network connect",
    "start ryph-gate-default",
  ]);
  assertEquals(calls.at(-2), "network connect ryph-runs ryph-gate-default");
});

test("a drifted gate with confined runs live behind it is kept, and remade once none are", async () => {
  // Drift that may wait: the configuration added a port (a new image would not wait — below).
  const live = healthy({
    "ps --filter network=ryph-runs": "ryph-gate-default\nryph-run-r-1\nryph-check-s-1-clone",
  });
  const ready = await ensureGate(addedPort, live.exec);
  assertEquals(ready.state, "deferred");
  assertEquals(ready.live, ["ryph-run-r-1", "ryph-check-s-1-clone"]);
  assertEquals(
    live.calls.some((c) => c.startsWith("rm -f ryph-gate") || c.startsWith("create")),
    false,
  );

  const idle = healthy({ "ps --filter network=ryph-runs": "ryph-gate-default" });
  const remade = await ensureGate(addedPort, idle.exec);
  assertEquals([remade.state, remade.forced], ["created", undefined]);
});

test("a stopped or missing gate is remade even with runs on the network", async () => {
  const stopped = healthy({
    "inspect --type container": gateInspect({ running: false }),
    "ps --filter network=ryph-runs": "ryph-run-r-1",
  });
  assertEquals((await ensureGate(CONFINED, stopped.exec)).state, "created");
  const missing = healthy({
    "inspect --type container": new Error("No such container"),
    "ps --filter network=ryph-runs": "ryph-run-r-1",
  });
  assertEquals((await ensureGate(CONFINED, missing.exec)).state, "created");
});

test("another deployment's gate is never taken from under its live runs", async () => {
  // Both deployments with RYPH_DOCKER_NETWORK unset: one gate name, different owners.
  const mine = { ...CONFINED, gate: { ...CONFINED.gate, routes: toHost(29411), owner: "aaaa" } };
  const { calls, exec } = healthy({
    "inspect --type container": gateInspect({ owner: "bbbb" }),
    "ps --filter network=ryph-runs": "ryph-run-theirs",
  });
  const err = await assertRejects(() => ensureGate(mine, exec), Error, "own RYPH_DOCKER_NETWORK");
  // Or this deployment's own earlier install, whose runs are still live: wait them out.
  assert(err.message.includes("let them finish"), err.message);
  assertEquals(calls.some((c) => c.startsWith("rm -f ryph-gate") || c.startsWith("create")), false);
  // Not even when its drift could not wait for runs of our own.
  const forwarding = healthy({
    "inspect --type container": gateInspect({ owner: "bbbb", forwards: true }),
    "ps --filter network=ryph-runs": "ryph-run-theirs",
  });
  await assertRejects(() => ensureGate(mine, forwarding.exec), Error, "own RYPH_DOCKER_NETWORK");
  assertEquals(forwarding.calls.some((c) => c.startsWith("rm -f ryph-gate")), false);
  // With nothing of theirs live, it is taken over: there is nobody to cut off.
  const idle = healthy({ "inspect --type container": gateInspect({ owner: "bbbb" }) });
  assertEquals((await ensureGate(mine, idle.exec)).state, "created");
});

const OWNED = { ...CONFINED, gate: { ...CONFINED.gate, owner: "aaaa" } };
const STRAYS = "ps -a --filter label=ryph.gate --filter label=ryph.gate.owner=aaaa";

test("gates this owner made under another name are swept", async () => {
  // A renamed deployment's old gate: a different name, so a sweep keyed on the gate name's own
  // label value could never find it. Found by owner instead.
  const { calls, exec } = healthy({
    [STRAYS]: "ryph-gate-default\nryph-gate-old",
    "inspect --type container ryph-gate-old": gateInspect({ running: false }),
  });
  await ensureGate(OWNED, exec);
  assertEquals(calls.includes(`${STRAYS} --format {{.Names}}`), true);
  assertEquals(calls.includes("rm -f ryph-gate-old"), true);
  assertEquals(calls.includes("rm -f ryph-gate-default"), false);
});

test("a stray gate with live runs behind it is kept, unless its drift cannot wait", async () => {
  const live = healthy({
    [STRAYS]: "ryph-gate-old",
    "inspect --type container ryph-gate-old": gateInspect({ networks: ["bridge", "old-runs"] }),
    "ps --filter network=old-runs": "ryph-gate-old\nryph-run-r-1",
  });
  const ready = await ensureGate(OWNED, live.exec);
  assertEquals(live.calls.includes("rm -f ryph-gate-old"), false);
  assertEquals(ready.forced, undefined);
  // On a different image it goes now, and says whose connections dropped.
  const stale = healthy({
    [STRAYS]: "ryph-gate-old",
    "inspect --type container ryph-gate-old": gateInspect({
      networks: ["bridge", "old-runs"],
      image: "sha256:older",
    }),
    "ps --filter network=old-runs": "ryph-run-r-1",
  });
  const forced = await ensureGate(OWNED, stale.exec);
  assertEquals(stale.calls.includes("rm -f ryph-gate-old"), true);
  assertEquals(forced.forced?.[0].gate, "ryph-gate-old");
  assertEquals(forced.forced?.[0].live, ["ryph-run-r-1"]);
});

test("an ephemeral owner sweeps nothing: the label says nothing about whose gate it is", async () => {
  const { calls, exec } = healthy();
  await ensureGate({ ...CONFINED, gate: { ...CONFINED.gate, owner: EPHEMERAL_GATE_OWNER } }, exec);
  assertEquals(calls.some((c) => c.startsWith("ps -a")), false);
});

test("concurrent callers of one gate are serialised, so none removes another's fresh gate", async () => {
  // Two callers (the run provisioner and the check launcher, say) both find the gate stale. With
  // no lock, the second's `rm -f` lands after the first's `create`; with one, the second finds the
  // first's gate current and touches nothing.
  let created = false;
  const log: string[] = [];
  const exec = async (args: string[]) => {
    const line = args.join(" ");
    log.push(line);
    await new Promise((r) => setTimeout(r, 1));
    if (line.startsWith("info")) return LINUX;
    if (line.startsWith("network inspect")) return ISOLATED;
    if (line.startsWith("image inspect")) return "sha256:gate";
    if (line.startsWith("inspect --type container")) {
      return created ? gateInspect() : gateInspect({ running: false });
    }
    if (line.startsWith("start")) created = true;
    return "";
  };
  const [a, b] = await Promise.all([ensureGate(CONFINED, exec), ensureGate(CONFINED, exec)]);
  assertEquals([a.state, b.state].sort(), ["created", "current"]);
  assertEquals(log.filter((l) => l.startsWith("rm -f ryph-gate-default")).length, 1);
});

test("a missing run network is created internal and isolated", async () => {
  const { calls, exec } = healthy({ "network inspect": new Error("No such network") });
  await ensureGate(CONFINED, exec);
  assertEquals(
    calls.includes(
      "network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated " +
        "-o com.docker.network.bridge.gateway_mode_ipv6=isolated --label ryph.runs=1 ryph-runs",
    ),
    true,
  );
});

test("a run network that is NOT internal is refused, naming the fix", async () => {
  const { calls, exec } = healthy({ "network inspect": "false||" });
  const err = await assertRejects(() => ensureGate(CONFINED, exec), Error, "not an internal");
  assertEquals(err.message.includes("docker network create --internal"), true);
  // Nothing was made: no gate beside a network that leaks.
  assertEquals(calls.some((c) => c.startsWith("create") || c.startsWith("network create")), false);
});

test("on a Linux engine an internal run network with a host gateway is refused", async () => {
  const { calls, exec } = healthy({ "network inspect": "true||" });
  await assertRejects(() => ensureGate(CONFINED, exec), Error, "gateway mode `isolated`");
  assertEquals(calls.some((c) => c.startsWith("create")), false);
  // So does Desktop 28+, which could have made it isolated; an older Desktop is grandfathered.
  const desktop = healthy({ info: DESKTOP, "network inspect": "true||" });
  await assertRejects(() => ensureGate(CONFINED, desktop.exec), Error, "gateway mode `isolated`");
  const oldDesktop = healthy({ info: "27.5.1|linux|Docker Desktop", "network inspect": "true||" });
  assertEquals((await ensureGate(CONFINED, oldDesktop.exec)).state, "current");
});

test("a Linux engine too old for an isolated gateway refuses confined mode", async () => {
  const { calls, exec } = healthy({ info: OLD_LINUX, "network inspect": new Error("No such") });
  await assertRejects(() => ensureGate(CONFINED, exec), Error, "older than 28.0");
  assertEquals(calls.some((c) => c.startsWith("network create")), false);
});

test("a gate image that is neither here nor pullable fails the launch, naming the task that builds it", async () => {
  const { calls, exec } = healthy({
    "image inspect": new Error("No such image"),
    pull: new Error("pull access denied"),
  });
  await assertRejects(() => ensureGate(CONFINED, exec), Error, "bun run agent-image");
  assert(calls.some((c) => c.startsWith("pull --quiet ")));
});

test("a gate image missing from the store is pulled, then used", async () => {
  let pulled = false;
  const { calls, exec: base } = healthy();
  const exec = (args: string[]) => {
    if (args[0] === "pull") pulled = true;
    if (args[0] === "image" && args[1] === "inspect" && !pulled) {
      calls.push(args.join(" "));
      return Promise.reject(new Error("No such image"));
    }
    return base(args);
  };
  assertEquals((await ensureGate(CONFINED, exec)).state, "current");
  assert(pulled);
});

test("the run network is named for the deployment, like the gate", () => {
  assertEquals(defaultRunNetwork({}), "ryph-runs");
  assertEquals(defaultRunNetwork({ network: "ryph" }), "ryph-runs-ryph");
});

test("the gate's routes are exactly the addresses runs are handed on it", () => {
  const target = "host.docker.internal";
  const { routes, elsewhere } = gateRoutesFor("ryph-gate-default", [
    { setting: "RYPH_PUBLIC_URL", url: "http://ryph-gate-default:7411", target },
    { setting: "RYPH_MODEL_PROXY_URL", url: "http://ryph-gate-default:7420", target },
    { setting: "RYPH_MCP_GATEWAY_URL", url: "http://ryph-gate-default:7430/", target },
    { setting: "RYPH_EGRESS_PROXY_URL", url: "http://ryph-gate-default:7460", target },
    { setting: "RYPH_GIT_GATEWAY_URL", url: "http://ryph-gate-default:7412", target },
    // The same port twice, to the same place, is one route.
    { setting: "RYPH_HISTORY_URL", url: "http://ryph-gate-default:7411/history", target },
    { setting: "RYPH_PREVIEW_URL", url: null, target },
  ]);
  assertEquals(routes, toHost(7411, 7412, 7420, 7430, 7460));
  assertEquals(elsewhere, []);
});

test("each address's route goes where the composition root says its service listens", () => {
  const { routes } = gateRoutesFor("ryph-gate-ryph", [
    { setting: "RYPH_PUBLIC_URL", url: "http://ryph-gate-ryph:7411", target: "control-plane" },
    { setting: "RYPH_MODEL_PROXY_URL", url: "http://ryph-gate-ryph:7420", target: "model-proxy" },
    { setting: "RYPH_HISTORY_URL", url: "http://ryph-gate-ryph", target: "historian", port: 7440 },
  ]);
  assertEquals(routes, [
    { listen: 80, target: "historian", port: 7440 },
    { listen: 7411, target: "control-plane", port: 7411 },
    { listen: 7420, target: "model-proxy", port: 7420 },
  ]);
  // One gate port, two services: refused, naming both, rather than one silently winning.
  assertThrows(
    () =>
      gateRoutesFor("ryph-gate-ryph", [
        { setting: "RYPH_PUBLIC_URL", url: "http://ryph-gate-ryph:7411", target: "control-plane" },
        { setting: "RYPH_HISTORY_URL", url: "http://ryph-gate-ryph:7411", target: "historian" },
      ]),
    Error,
    "RYPH_HISTORY_URL=http://ryph-gate-ryph:7411 sends the run gate's port 7411 to historian:7411",
  );
});

test("an address that does not go through the gate is named, and opens no port", () => {
  const target = "host.docker.internal";
  const { routes, elsewhere } = gateRoutesFor("ryph-gate-default", [
    { setting: "RYPH_PUBLIC_URL", url: "http://host.docker.internal:7411", target },
    { setting: "RYPH_MODEL_PROXY_URL", url: "http://ryph-gate-default", target },
  ]);
  assertEquals(routes, toHost(80));
  assertEquals(elsewhere, ["RYPH_PUBLIC_URL=http://host.docker.internal:7411"]);
});

test("losing a race to another process remaking the gate is fine when its gate is current", async () => {
  let inspections = 0;
  const exec = (args: string[]) => {
    const line = args.join(" ");
    if (line.startsWith("info")) return Promise.resolve(LINUX);
    if (line.startsWith("network inspect")) return Promise.resolve(ISOLATED);
    if (line.startsWith("image inspect")) return Promise.resolve("sha256:gate");
    if (line.startsWith("inspect --type container")) {
      // Stale on the first look; the other process's fresh gate on the second.
      return Promise.resolve(inspections++ === 0 ? gateInspect({ running: false }) : gateInspect());
    }
    if (line.startsWith("create")) return Promise.reject(new Error("name already in use"));
    return Promise.resolve("");
  };
  assertEquals((await ensureGate(CONFINED, exec)).state, "current");
});

// ── MAJOR 1: binds move to the bridge only when it is this machine's ──────────────────────────

test("the bridge is a bind address only on Linux, and only when this machine has it", () => {
  assertEquals(
    bridgeOnThisMachine("172.17.0.1", "linux", ["127.0.0.1", "172.17.0.1"]),
    "172.17.0.1",
  );
  // Colima / Rancher Desktop / rootless: the engine reports a bridge this machine has no
  // address on — writing it would be EADDRNOTAVAIL at boot.
  assertEquals(bridgeOnThisMachine("172.17.0.1", "linux", ["127.0.0.1", "192.168.1.5"]), null);
  assertEquals(bridgeOnThisMachine("172.17.0.1", "darwin", ["172.17.0.1"]), null);
  assertEquals(bridgeOnThisMachine(null, "linux", ["172.17.0.1"]), null);
});

test("localBridgeGateway reads the bridge and asks this machine's interfaces", async () => {
  const exec = fakeDocker({ "network inspect bridge": "172.17.0.1 fd00::1 " }).exec;
  assertEquals(await localBridgeGateway(exec, "linux", () => ["172.17.0.1"]), "172.17.0.1");
  assertEquals(await localBridgeGateway(exec, "linux", () => ["10.0.0.2"]), null);
  const { calls, exec: mac } = fakeDocker({});
  assertEquals(await localBridgeGateway(mac, "darwin", () => ["172.17.0.1"]), null);
  assertEquals(calls.length, 0, "not even asked off Linux");
  const down = fakeDocker({ "network inspect": new Error("no daemon") }).exec;
  assertEquals(await localBridgeGateway(down, "linux", () => ["172.17.0.1"]), null);
});

// ── MINOR 7: Podman ─────────────────────────────────────────────────────────────────────────

test("Podman behind the docker CLI is named, not read as a docker newer than any", async () => {
  const podman = parseDockerEngine(
    "5.2.0|linux|fedora",
    "Podman Engine;Conmon;OCI Runtime (crun);",
  );
  assertEquals(podman.podman, true);
  assertEquals(podman.isolatedGateway, false);
  const problem = runNetworkProblem("ryph-runs", null, podman);
  assertEquals(problem?.includes("Podman is not supported for confined runs"), true);
  assertEquals(problem?.includes("older than 28.0"), false);
  assertEquals(parseDockerEngine(LINUX, "Engine;containerd;runc;docker-init;").podman, false);
  // Read through dockerEngine: the components come from `docker version`.
  const exec = fakeDocker({ info: "5.2.0|linux|fedora", version: "Podman Engine;Conmon;" }).exec;
  assertEquals((await dockerEngine(exec)).podman, true);
  // A docker that will not answer `version` is not Podman.
  const plain = fakeDocker({ info: LINUX, version: new Error("nope") }).exec;
  assertEquals((await dockerEngine(plain)).podman, false);
});

// ── MAJOR 2: deferral is capped, and security drift never waits ─────────────────────────────

test("a gate command's routes are read back as the gate reads them, flags skipped", () => {
  assertEquals(gateCommandRoutes(gateCommand(CONFINED.gate)), toHost(7411, 7420, 7430, 7460));
  assertEquals(
    gateCommandRoutes(["--per-source", "64", "7411=control-plane:7411", "80=previews:8080"]),
    [{ listen: 7411, target: "control-plane", port: 7411 }, {
      listen: 80,
      target: "previews",
      port: 8080,
    }],
  );
  // The short forms, on `--target` wherever it stands.
  assertEquals(gateCommandRoutes(["7411", "8000:7412", "--target", "h"]), [
    { listen: 7411, target: "h", port: 7411 },
    { listen: 8000, target: "h", port: 7412 },
  ]);
  assertEquals(gateCommandRoutes(["--target", "h", "nope"]), null);
  assertEquals(
    gateCommandRoutes(["7411"]),
    null,
    "a short form with no --target relays nowhere known",
  );
  for (const bad of ["7411=h", "7411=:1", "7411=h:1:2", "=h:1", "7411=h:0", "1:2:3"]) {
    assertEquals(gateCommandRoutes([bad]), null, bad);
  }
  assertEquals(gateCommandRoutes("7411"), null);
});

test("only drift that adds may wait: a new image, a dropped or moved port, forwarding is security", () => {
  const gate = JSON.parse(gateInspect())[0];
  assertEquals(gateSecurityDrift(gate, "sha256:gate", CONFINED), null);
  // A port added by the config: the old gate relays a subset — may wait.
  const added = {
    ...CONFINED,
    gate: { ...CONFINED.gate, routes: toHost(7460, 7411, 7430, 7420, 7412) },
  };
  assertEquals(gateSecurityDrift(gate, "sha256:gate", added), null);
  // So may one added to another target: the old routes are all still where the config sends them.
  const addedElsewhere = {
    ...CONFINED,
    gate: {
      ...CONFINED.gate,
      routes: [...CONFINED.gate.routes, { listen: 7412, target: "forge", port: 7412 }],
    },
  };
  assertEquals(gateSecurityDrift(gate, "sha256:gate", addedElsewhere), null);
  // A port the config removed must not stay relayed.
  const removed = { ...CONFINED, gate: { ...CONFINED.gate, routes: toHost(7411, 7420, 7430) } };
  assertEquals(gateSecurityDrift(gate, "sha256:gate", removed)?.includes("port 7460"), true);
  // Nor may a port the config now sends elsewhere — another host, or another port on the same one.
  const moved = {
    ...CONFINED,
    gate: {
      ...CONFINED.gate,
      routes: [...toHost(7411, 7430, 7460), { listen: 7420, target: "model-proxy", port: 7420 }],
    },
  };
  assertEquals(
    gateSecurityDrift(gate, "sha256:gate", moved),
    "it relays port 7420 to host.docker.internal:7420, which this configuration sends to " +
      "model-proxy:7420",
  );
  const repointed = {
    ...CONFINED,
    gate: {
      ...CONFINED.gate,
      routes: [...toHost(7411, 7430, 7460), {
        listen: 7420,
        target: "host.docker.internal",
        port: 7421,
      }],
    },
  };
  assertEquals(
    gateSecurityDrift(gate, "sha256:gate", repointed)?.includes("host.docker.internal:7421"),
    true,
  );
  assertEquals(gateSecurityDrift(gate, "sha256:new", CONFINED)?.includes("image changed"), true);
  // A gate that routes between its networks — made before it stopped — must not wait either.
  const forwarding = JSON.parse(gateInspect({ forwards: true }))[0];
  assertEquals(
    gateSecurityDrift(forwarding, "sha256:gate", CONFINED)?.includes("forwards packets"),
    true,
  );
});

/** A docker whose gate drifted by an added port, with `r-1` live behind it on the run network. */
const addedPort = {
  ...CONFINED,
  gate: { ...CONFINED.gate, routes: toHost(7460, 7411, 7430, 7420, 7412) },
};
const liveBehindGate = (over: Record<string, string | Error> = {}) =>
  healthy({ "ps --filter network=ryph-runs": "ryph-gate-default\nryph-run-r-1", ...over });

test("a drifted gate is kept for live runs only up to the cap, then remade anyway", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const { calls, exec } = liveBehindGate();
  const first = await ensureGate(addedPort, exec, now);
  assertEquals(first.state, "deferred");
  assertEquals(first.deferredMs, 0);
  clock += GATE_DEFER_CAP_MS - 1;
  const second = await ensureGate(addedPort, exec, now);
  assertEquals(second.state, "deferred");
  assertEquals(second.deferredMs, GATE_DEFER_CAP_MS - 1, "measured from the FIRST deferral");
  assertEquals(calls.some((c) => c.startsWith("rm -f ryph-gate")), false);
  clock += 1;
  const third = await ensureGate(addedPort, exec, now);
  assertEquals(third.state, "created");
  assertEquals(third.forced?.[0].live, ["ryph-run-r-1"]);
  assertEquals(third.forced?.[0].why.includes("past the 30 min cap"), true);
  assertEquals(calls.includes("rm -f ryph-gate-default"), true);
});

test("the cap is the gate's own when configured", async () => {
  let clock = 0;
  const { exec } = liveBehindGate();
  const short = { ...addedPort, gate: { ...addedPort.gate, deferCapMs: 5_000 } };
  assertEquals((await ensureGate(short, exec, () => clock)).state, "deferred");
  clock = 5_000;
  assertEquals((await ensureGate(short, exec, () => clock)).state, "created");
});

test("the deferral clock restarts once the gate is current again", async () => {
  let clock = 0;
  let current = false;
  const base = liveBehindGate();
  const exec = (args: string[]) =>
    current && args.join(" ").startsWith("inspect --type container")
      ? Promise.resolve(gateInspect({ cmd: gateCommand(addedPort.gate) }))
      : base.exec(args);
  assertEquals((await ensureGate(addedPort, exec, () => clock)).state, "deferred");
  current = true;
  clock = GATE_DEFER_CAP_MS;
  assertEquals((await ensureGate(addedPort, exec, () => clock)).state, "current");
  current = false;
  const again = await ensureGate(addedPort, exec, () => clock);
  assertEquals([again.state, again.deferredMs], ["deferred", 0]);
});

test("a new gate image or a dropped or moved port is remade at once, live runs or not", async () => {
  const image = liveBehindGate({ "image inspect": "sha256:rebuilt" });
  const byImage = await ensureGate(CONFINED, image.exec, () => 0);
  assertEquals(byImage.state, "created");
  assertEquals(byImage.forced?.[0].why.includes("image changed"), true);
  assertEquals(byImage.forced?.[0].live, ["ryph-run-r-1"]);

  const removed = { ...CONFINED, gate: { ...CONFINED.gate, routes: toHost(7411, 7420, 7430) } };
  const port = liveBehindGate();
  const byPort = await ensureGate(removed, port.exec, () => 0);
  assertEquals(byPort.state, "created");
  assertEquals(byPort.forced?.[0].why.includes("7460"), true);

  // A port the configuration now sends to another target: the old destination is reach taken away.
  const moved = {
    ...CONFINED,
    gate: {
      ...CONFINED.gate,
      routes: [...toHost(7411, 7430, 7460), { listen: 7420, target: "model-proxy", port: 7420 }],
    },
  };
  const target = liveBehindGate();
  const byTarget = await ensureGate(moved, target.exec, () => 0);
  assertEquals(byTarget.state, "created");
  assertEquals(byTarget.forced?.[0].why.includes("sends to model-proxy:7420"), true);
  assertEquals(byTarget.forced?.[0].live, ["ryph-run-r-1"]);

  // A gate made before it stopped routing between its networks.
  const forwarding = liveBehindGate({
    "inspect --type container": gateInspect({ forwards: true }),
  });
  const byForwarding = await ensureGate(CONFINED, forwarding.exec, () => 0);
  assertEquals(byForwarding.state, "created");
  assertEquals(byForwarding.forced?.[0].why.includes("forwards packets"), true);
});

// ── MINOR 1: live runs on every internal network the gate is on ─────────────────────────────

test("runs on the gate's OLD run network hold a recreate back after the setting moved", async () => {
  // RYPH_DOCKER_RUN_NETWORK moved from old-runs to ryph-runs: the gate is still on old-runs
  // (drift: networks), and r-1 is live there — not on the configured network.
  const { calls, exec } = healthy({
    "inspect --type container": gateInspect({ networks: ["bridge", "old-runs"] }),
    "ps --filter network=old-runs": "ryph-gate-default\nryph-run-r-1",
    "ps --filter network=ryph-runs": "",
  });
  const ready = await ensureGate(CONFINED, exec, () => 0);
  assertEquals(ready.state, "deferred");
  assertEquals(ready.live, ["ryph-run-r-1"]);
  assertEquals(calls.includes("rm -f ryph-gate-default"), false);
});

test("containers on the gate's ORDINARY side do not hold it back", async () => {
  const base = healthy({
    "ps --filter network=bridge": "ryph-gate-default\nsome-unrelated-container",
  });
  const exec = (args: string[]) =>
    args[0] === "network" && args[1] === "inspect" && args.at(-1) === "bridge"
      ? Promise.resolve("false||")
      : base.exec(args);
  const ready = await ensureGate(addedPort, exec, () => 0);
  assertEquals(ready.state, "created");
  assertEquals(base.calls.some((c) => c.startsWith("ps --filter network=bridge")), false);
  assertEquals(base.calls.some((c) => c.startsWith("ps --filter network=ryph-runs")), true);
});

// ── MINOR 4: setup remakes an old non-isolated network when only the gate is attached ───────

/** A docker whose ryph-runs is internal but not isolated until it is remade. */
function oldNetwork(attached: string, label = "1") {
  let remade = false;
  const calls: string[] = [];
  const exec = (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("info")) return Promise.resolve(DESKTOP);
    if (line.startsWith("network inspect -f {{index .Labels")) {
      return Promise.resolve(`${label}|${attached}`);
    }
    if (line.startsWith("network inspect")) {
      return Promise.resolve(remade ? ISOLATED : "true||");
    }
    if (line.startsWith("ps -a --filter label=ryph.gate")) {
      return Promise.resolve("ryph-gate-default");
    }
    if (line.startsWith("network create")) remade = true;
    return Promise.resolve("");
  };
  return { calls, exec };
}

test("setup remakes ryph's own non-isolated run network when only the gate is attached", async () => {
  const { calls, exec } = oldNetwork("ryph-gate-default ");
  await ensureRunNetwork("ryph-runs", exec, { replaceIdle: true });
  const tail = calls.filter((c) =>
    c === "rm -f ryph-gate-default" || c === "network rm ryph-runs" ||
    c.startsWith("network create")
  );
  assertEquals(tail.map((c) => c.split(" ").slice(0, 2).join(" ")), [
    "rm -f",
    "network rm",
    "network create",
  ]);
  assertEquals(tail[2].includes("gateway_mode_ipv4=isolated"), true);
});

test("setup leaves a run network alone with anything else attached, or not ryph's", async () => {
  const busy = oldNetwork("ryph-gate-default ryph-run-r-1 ");
  await assertRejects(
    () => ensureRunNetwork("ryph-runs", busy.exec, { replaceIdle: true }),
    Error,
    "gateway mode `isolated`",
  );
  assertEquals(busy.calls.some((c) => c.startsWith("network rm") || c.startsWith("rm -f")), false);
  const foreign = oldNetwork("", "<no value>");
  await assertRejects(() => ensureRunNetwork("ryph-runs", foreign.exec, { replaceIdle: true }));
  assertEquals(foreign.calls.some((c) => c.startsWith("network rm")), false);
  // And never at launch: there the refusal is the answer.
  const launch = oldNetwork("");
  await assertRejects(() => ensureRunNetwork("ryph-runs", launch.exec));
  assertEquals(launch.calls.some((c) => c.startsWith("network rm")), false);
});

/** A daemon whose store lacks `image`: any command naming it fails as docker says it. */
function daemonWithout(image: string) {
  const calls: string[] = [];
  const exec = (args: string[]) => {
    calls.push(args.join(" "));
    if (args.includes(image)) {
      return Promise.reject(
        new Error(
          `docker ${args[0]} failed: docker: Error response from daemon: No such image: ${image}`,
        ),
      );
    }
    // A container left by an earlier attempt is this deployment's run; its network, by label.
    if (args[0] === "inspect" && args.includes("--type")) return Promise.resolve("r-1|default");
    if (args[0] === "network" && args[1] === "ls") return Promise.resolve("net-r-1");
    return Promise.resolve("");
  };
  return { exec, calls };
}

const GONE_ID = `sha256:${"c".repeat(64)}`;

for (const services of [[], [DB]] as ServiceSpec[][]) {
  const shape = services.length === 0 ? "no services" : "services";
  test(`a launch on a locally built image the daemon lacks throws ImageGone (${shape})`, async () => {
    // Judged this deployment's, then gone from the store before docker is asked to run it.
    const daemon = daemonWithout(GONE_ID);
    const own = { id: GONE_ID, names: [`${localImagePrefix("default")}repo:env-1`] };
    const provisioner = dockerProvisioner({}, silentDiagnostics(), storeExec([own], daemon.exec));
    const err = await assertRejects(() =>
      provisioner.launch({ ...SPEC, image: GONE_ID, services })
    );
    assert(err instanceof ImageGone, `ImageGone, not ${String(err)}`);
    if (services.length > 0) {
      // The half-built run is still taken down before the error is translated.
      assert(daemon.calls.includes("rm -f ryph-run-r-1"), daemon.calls.join("\n"));
      assert(daemon.calls.includes("network rm net-r-1"), daemon.calls.join("\n"));
    }
  });

  test(`a registry image the daemon lacks is an ordinary launch failure (${shape})`, async () => {
    const image = "quay.io/ryph/ryph-agent:latest";
    const daemon = daemonWithout(image);
    // Nothing in the store: every image a registry's, launched by its name and pulled by docker.
    const provisioner = dockerProvisioner({}, silentDiagnostics(), storeExec([], daemon.exec));
    const err = await assertRejects(() => provisioner.launch({ ...SPEC, image, services }));
    assert(!(err instanceof ImageGone), "a pullable image is never named gone");
    assert(String(err).includes("No such image"));
  });
}

test("a run's cleanup touches only this deployment's objects, whatever run id it is handed", async () => {
  // Another deployment on the daemon holds `ryph-run-r-1` and its network: this launch's
  // `create` is refused over the name, and the cleanup must leave both alone.
  const calls: string[] = [];
  const exec = (args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "network" && args[1] === "create") {
      return Promise.reject(new Error("network with name ryph-run-r-1 already exists"));
    }
    if (args[0] === "inspect" && args.includes("--type")) {
      return Promise.resolve("r-1|someone-else");
    }
    // Filtered on this deployment's label, the daemon lists nothing of theirs.
    if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) return Promise.resolve("");
    return Promise.resolve("");
  };
  const provisioner = dockerProvisioner(
    { network: "mine" },
    silentDiagnostics(),
    storeExec([], exec),
  );
  await assertRejects(
    () => provisioner.launch({ ...SPEC, services: [DB] }),
    Error,
    "already exists",
  );
  assertEquals(calls.filter((c) => c.startsWith("rm") || c.startsWith("network rm")), []);
  for (const listing of calls.filter((c) => c.startsWith("ps") || c.startsWith("network ls"))) {
    assert(listing.includes("label=ryph.deployment=mine"), listing);
  }
});

test("ownership reads a container's labels, by --type container", async () => {
  const seen: string[][] = [];
  const answer = (out: string | Error) => (args: string[]) => {
    seen.push(args);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  assertEquals(await runContainerOwnership("c", {}, answer("r-1|default")), "ours");
  assertEquals(await runContainerOwnership("c", {}, answer("r-1|other")), "foreign");
  assertEquals(await runContainerOwnership("c", {}, answer("<no value>|default")), "foreign");
  assertEquals(
    await runContainerOwnership("c", {}, answer(new Error("Error: No such container: c"))),
    "absent",
  );
  assertEquals(
    await runContainerOwnership("c", {}, answer(new Error("Cannot connect to the daemon"))),
    "unknown",
  );
  assert(seen.every((args) => args.slice(0, 3).join(" ") === "inspect --type container"));
});

test("kill reads the run off a CONTAINER's label, then tears that run's services down", async () => {
  const calls: string[] = [];
  const provisioner = dockerProvisioner({}, silentDiagnostics(), (args) => {
    calls.push(args.join(" "));
    if (args[0] === "inspect") return Promise.resolve("r-1");
    return Promise.resolve("");
  });
  await provisioner.kill("c-1", { graceful: true });
  // `--type container`: an image by the handle's name would name a run in its labels too.
  assertEquals(calls[0], 'inspect --type container -f {{index .Config.Labels "ryph.run"}} c-1');
  assertEquals(calls[1], "stop -t 30 c-1");
  assert(calls.slice(2).some((c) => c.includes("label=ryph.run=r-1")), calls.join("\n"));
});

test("a run launches on no image of another deployment's, whatever spelling resolves to it", async () => {
  const mine = localImagePrefix("mine");
  const theirs = `${localImagePrefix("theirs")}repo:env-1`;
  const foreign: FakeImage = { id: imageId("f"), names: [theirs, "ryph-env/repo:baked-env-1"] };
  const untagged: FakeImage = { id: imageId("9"), names: [] };
  const own: FakeImage = { id: imageId("7"), names: [`${mine}repo:env-1`] };
  const shadowed = "quay.io/ryph/ryph-universal:1";
  const shadow: FakeImage = { id: imageId("5"), names: [shadowed, `${localImagePrefix("x")}a:b`] };
  const pulled: FakeImage = { id: imageId("4"), names: ["postgres:16"] };
  const store = [foreign, untagged, own, shadow, pulled];
  const daemon = () => {
    const calls: string[] = [];
    const exec = storeExec(store, (args: string[]) => {
      calls.push(args.join(" "));
      return Promise.resolve("handle");
    });
    return {
      exec,
      calls,
      provisioner: dockerProvisioner({ network: "mine" }, silentDiagnostics(), exec),
    };
  };
  const launched = (calls: string[]) => calls.filter((c) => /^(run|create) /.test(c));
  const hex = foreign.id.slice("sha256:".length);
  const refused = [
    hex.slice(0, 4),
    hex,
    `sha256:${hex.slice(0, 6)}`,
    `docker.io/${theirs}`,
    `index.docker.io/${theirs}`,
  ];
  const resolved = [
    theirs,
    "ryph-env/repo:baked-env-1",
    foreign.id,
    `${theirs.split(":")[0]}@${foreign.id}`,
    untagged.id,
    shadowed,
  ];

  for (const image of resolved) {
    // The run's own image: met as gone, worded as an absent one is, before anything is made.
    const run = daemon();
    const err = await assertRejects(() => run.provisioner.launch({ ...SPEC, image }));
    assert(err instanceof ImageGone, `${image}: ${String(err)}`);
    assertStringIncludes(String(err), notOwnImage(image));
    assertEquals(launched(run.calls), []);
    // A service's or the browser's: refused, and not as ImageGone.
    for (
      const spec of [
        { ...SPEC, image: own.id, services: [{ ...DB, image }] },
        { ...SPEC, image: own.id, browser: { ...BROWSER, image } },
      ]
    ) {
      const other = daemon();
      const refusal = await assertRejects(() => other.provisioner.launch(spec));
      assert(!(refusal instanceof ImageGone), String(refusal));
      assertEquals(launched(other.calls), []);
    }
  }
  for (const image of refused) {
    const run = daemon();
    const err = await assertRejects(() => run.provisioner.launch({ ...SPEC, image }));
    assert(!(err instanceof ImageGone), `${image}: ${String(err)}`);
    assertEquals(launched(run.calls), []);
  }

  // Its own, by tag or id, goes ahead on the id judged, and so do a pulled service and browser;
  // an image the store lacks keeps its registry name for docker to pull.
  for (const image of [own.names[0]!, own.id]) {
    const ok = daemon();
    await ok.provisioner.launch({
      ...SPEC,
      image,
      services: [{ ...DB, image: "postgres:16" }],
      browser: { ...BROWSER, image: "postgres:16" },
    });
    const made = launched(ok.calls);
    assert(made.length === 3, made.join("\n"));
    assert(
      made.every((c) => !c.includes(" postgres:16") && !c.includes(`${mine}repo`)),
      made.join("\n"),
    );
    assert(made.some((c) => c.endsWith(own.id)) && made.some((c) => c.endsWith(pulled.id)));
  }
  const registry = daemon();
  await registry.provisioner.launch({ ...SPEC, image: "quay.io/ryph/ryph-agent:1" });
  assert(launched(registry.calls)[0]!.endsWith(" quay.io/ryph/ryph-agent:1"));
});
