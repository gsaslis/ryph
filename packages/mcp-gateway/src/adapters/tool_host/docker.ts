// A docker ToolHost: hosted MCP servers as long-lived containers on the tools network, fronted by
// the tool guard. Run by the docker launcher (packages/launcher), the one process with the socket.
//
// THE TOOLS NETWORK CONFINES, as a run network does. The launcher makes it `--internal` with
// gateway mode `isolated` (packages/launcher/src/tools.ts, through `prepare`), so a vendor's
// container there has no default route, resolves no outside name, and reaches neither the docker
// host nor anything on another network — measured on Docker Desktop. What it can reach is what
// else is on the tools network: the guard, which dials it, and the egress relay, its one way to
// the internet (the egress proxy's tool listener, with a claim the gateway minted for it). A
// vendor's image is code nobody here wrote, and this is what keeps it from the deployment's
// services, the host's listeners and the LAN: Kubernetes's ryph-tools parity.
//
// THE GUARD IS DUAL-HOMED. Created on an ordinary network (`edge`: the deployment network, or one
// the launcher makes for a deployment without one), connected to the tools network, then started
// — the run gate's order, so its default route and any published port stay on the ordinary side,
// where whoever dials it reaches it. It runs the launcher's guard image and no other
// (`guardImage`: a caller names the container, never what is in it), so it gets docker's default
// runtime and the run gate's no-forwarding sysctl rather than the vendors' sandbox — and since an
// image is not all that runs (NODE_OPTIONS, a command), its launch is the gateway's fixed shape
// too (`guardSpecProblem`: no command, only the env the guard reads, its port, a bounded cap).
//
// Why the guard may be published: a gateway on the docker host (the binary) cannot route into
// Docker Desktop's VM, so something has to be published for it to dial. Publishing is exactly the
// hazard, though — a port published to the host is reachable from run containers through
// `host.docker.internal`, whose forwarder lands on the host's loopback — which is why only the
// token-gated guard ever is, and always with an explicit 127.0.0.1 bind (a bare `-p` also listens
// on every host interface). A gateway that is itself a container on `edge` (`joined`) publishes
// nothing: it dials the guard by name, as the Kubernetes adapter does.
//
// Vendor containers are addressed by NAME: docker's embedded DNS resolves container names on a
// user-defined network. A vendor container's name is its launch key's (`ryph-tool-<32 hex>`,
// core/tool_guard.ts `toolNameProblem`) and nothing else, which is what makes the guard's route to a
// key reach that launch or nothing; a launch under any other name is refused.

import type { ToolContainerState, ToolHost, ToolLaunchSpec } from "../../ports/tool_host.ts";
import { GUARD_NAME } from "../../core/hosting.ts";
import { guardSpecProblem, toolNameProblem } from "../../core/tool_guard.ts";
import {
  checkSpec,
  cli,
  DEFAULT_TOOL_DEPLOYMENT,
  envArgs,
  TOOL_DEPLOYMENT_LABEL,
  TOOL_LABEL,
  TOOL_NETWORK_LABEL,
  TOOL_USER,
  TOOLS_NETWORK,
} from "./cli.ts";

export interface DockerToolHostOptions {
  /** The tools network. Never the run network: a test pins that no launch names that one. */
  network?: string;
  /**
   * The ordinary network the guard is created on, and the one whoever dials it is on. Default
   * `toolEdgeNetwork(network)`, which the launcher makes for a deployment with no network of its
   * own.
   */
  edge?: string;
  /**
   * This process is attached to `edge` itself — a gateway in a container on the same daemon
   * (deploy/compose, deploy/compose-networked). The guard is then dialled by name, as on
   * Kubernetes, and never published: a loopback port on the docker host is not this container's
   * loopback, and publishing would put the guard where runs reach it.
   */
  joined?: boolean;
  /**
   * The OCI runtime every vendor's container gets (`docker run --runtime`): the launcher's
   * RYPH_DOCKER_RUNTIME, the one runs get, since a hosted server runs any image a tools-token
   * holder names. Not the guard's, whose image is `guardImage`. Unset: docker's default runtime.
   */
  runtime?: string;
  /**
   * The deployment whose servers these are (the docker provisioner's `deploymentId`: its
   * RYPH_DOCKER_NETWORK, "default" unset). Every container is labelled with it, and only one
   * carrying it and the tools network's label is this host's to list, stop, read or replace.
   */
  deployment?: string;
  /**
   * The one image a guard launch may name: the launcher's RYPH_TOOL_GUARD_IMAGE. A launch under
   * the guard's name with any other image is refused, and so is any guard launch while unset.
   */
  guardImage?: string;
  /** Where a vendor's container reaches the internet (`ToolHost.egressProxy`); null: nowhere. */
  egressProxy?: string | null;
  /**
   * Makes the tools network ready: internal and isolated, its edge, its egress relay. The
   * launcher's (packages/launcher/src/tools.ts), which reads the engine to do it. Unset,
   * `ensureNetwork` refuses: this package can make nothing that confines.
   */
  prepare?: () => Promise<void>;
  /**
   * Throws unless the tools network still confines, asked before every launch onto it — the
   * launcher's `verifyToolNetwork`: `prepare` judged it at boot, and the daemon's networks can
   * change under a running process. Unset: nothing is asked (this package's own tests).
   */
  confined?: () => Promise<void>;
}

/** The ordinary network a deployment with no network of its own puts its guard on. */
export function toolEdgeNetwork(network: string = TOOLS_NETWORK): string {
  return `${network}-edge`;
}

/** The sysctl that keeps the guard from routing between its two networks: the run gate's. */
const NO_FORWARD = "net.ipv4.ip_forward=0";

/** What every tool container is, the guard included: its labels and its posture. */
function postureArgs(spec: ToolLaunchSpec, opts: DockerToolHostOptions): string[] {
  return [
    "--label",
    `${TOOL_LABEL}=${spec.name}`,
    "--label",
    `${TOOL_NETWORK_LABEL}=${opts.network ?? TOOLS_NETWORK}`,
    "--label",
    `${TOOL_DEPLOYMENT_LABEL}=${opts.deployment ?? DEFAULT_TOOL_DEPLOYMENT}`,
    "--user",
    TOOL_USER,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    spec.memory,
    ...(spec.cpus === undefined ? [] : ["--cpus", spec.cpus]),
    // The gateway supervises; a crash is a status the row shows, not a loop the runtime owns.
    "--restart",
    "no",
  ];
}

/**
 * The `docker run` argv for one vendor's container: on the tools network alone, never published.
 * Pure, and exported for the test: this argv is where the isolation promises live, so it is the
 * thing worth pinning.
 */
export function toolLaunchArgs(spec: ToolLaunchSpec, opts: DockerToolHostOptions = {}): string[] {
  checkSpec(spec);
  if (spec.publish !== undefined) {
    throw new Error(`only the tool guard is ever published, and ${spec.name} is not it`);
  }
  return [
    "run",
    "-d",
    "--name",
    spec.name,
    ...postureArgs(spec, opts),
    "--network",
    opts.network ?? TOOLS_NETWORK,
    ...(opts.runtime ? ["--runtime", opts.runtime] : []),
    ...envArgs(spec),
    spec.image,
    ...spec.command,
  ];
}

/**
 * The `docker create` argv for the guard: on `edge`, which the launch then connects to the tools
 * network before starting it (see the header). Pure, and exported for the test.
 */
export function guardCreateArgs(spec: ToolLaunchSpec, opts: DockerToolHostOptions = {}): string[] {
  checkSpec(spec);
  // The launcher's route refuses these first; this is where the argv is, so it holds here too.
  const problem = guardSpecProblem(spec);
  if (problem !== null) throw new Error(problem);
  const args = [
    "create",
    "--name",
    spec.name,
    ...postureArgs(spec, opts),
    "--network",
    opts.edge ?? toolEdgeNetwork(opts.network),
    "--sysctl",
    NO_FORWARD,
  ];
  if (spec.publish !== undefined) {
    // Loopback, always spelled out. An empty host port asks docker for a free one.
    const hostPort = spec.publish.hostPort === 0 ? "" : String(spec.publish.hostPort);
    args.push("-p", `127.0.0.1:${hostPort}:${spec.port}`);
  }
  args.push(...envArgs(spec), spec.image, ...spec.command);
  return args;
}

/**
 * `docker ps` for every container this deployment launched onto `network`, stopped ones included
 * — the labels do the whole filtering, so the names come back one per line with nothing to
 * parse. Exported and pinned like the launch argv: it decides what a boot sweep may remove, so it
 * must never list another deployment's containers on the same daemon, even on the same network.
 */
export function toolListArgs(
  network: string = TOOLS_NETWORK,
  deployment: string = DEFAULT_TOOL_DEPLOYMENT,
): string[] {
  return [
    "ps",
    "--all",
    "--filter",
    `label=${TOOL_NETWORK_LABEL}=${network}`,
    "--filter",
    `label=${TOOL_DEPLOYMENT_LABEL}=${deployment}`,
    "--format",
    "{{.Names}}",
  ];
}

/**
 * The guard's container name on `network`: the shared default on `ryph-tools`, and one of its own
 * on any other, so two deployments on one daemon (each with a tools network of its own) never
 * replace each other's guard.
 */
export function dockerGuardName(network: string = TOOLS_NETWORK): string {
  return network === TOOLS_NETWORK ? GUARD_NAME : `${GUARD_NAME}-${network}`;
}

/** `docker logs` interleaves nothing: it returns two streams. Timestamps put them back in order. */
export function mergeTimestamped(stdout: string, stderr: string): string {
  const lines = [...stdout.split("\n"), ...stderr.split("\n")].filter((l) => l !== "");
  return lines
    .map((line) => {
      const space = line.indexOf(" ");
      return { at: space === -1 ? "" : line.slice(0, space), text: line.slice(space + 1) };
    })
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((l) => l.text)
    .join("\n");
}

const gone = (err: unknown) => /No such container|is not running/i.test(String(err));

/** The docker CLI as this adapter runs it: stdout and stderr, `env` added to its environment. */
export type DockerToolCli = (
  args: string[],
  env?: Record<string, string>,
) => Promise<{ stdout: string; stderr: string }>;

export function dockerToolHost(
  opts: DockerToolHostOptions = {},
  /** Injected for tests; the real CLI otherwise. */
  docker: DockerToolCli = (args, env) => cli("docker", args, env),
): ToolHost {
  const network = opts.network ?? TOOLS_NETWORK;
  const deployment = opts.deployment ?? DEFAULT_TOOL_DEPLOYMENT;

  /**
   * Whether `name` is a container this host launched onto its tools network (`ours`: its network
   * and deployment labels both say so), someone else's (`foreign`), none (`absent`), or cannot be told (`unknown`).
   * Every by-name act asks first: a name is the daemon's, and a caller of the docker launcher names
   * the handle, so a stop or a log read by name alone would reach any container on the daemon.
   */
  const owner = async (name: string): Promise<"ours" | "foreign" | "absent" | "unknown"> => {
    try {
      const { stdout } = await docker([
        "inspect",
        "--type",
        "container",
        "-f",
        `{{index .Config.Labels "${TOOL_NETWORK_LABEL}"}}\t` +
        `{{index .Config.Labels "${TOOL_DEPLOYMENT_LABEL}"}}`,
        name,
      ]);
      const [onNetwork, of] = stdout.trimEnd().split("\t");
      return onNetwork === network && of === deployment ? "ours" : "foreign";
    } catch (err) {
      return /No such (container|object)/i.test(String(err)) ? "absent" : "unknown";
    }
  };
  const notOurs = (name: string, found: string) =>
    new Error(
      found === "unknown"
        ? `docker did not say whose container ${name} is`
        : `${name} is not one of this deployment's hosted servers on ${network}`,
    );

  const guardName = dockerGuardName(network);

  return {
    kind: "docker",
    reachesGuard: opts.joined === true,
    guardName,
    ...(opts.guardImage === undefined ? {} : { guardImage: opts.guardImage }),
    egressProxy: opts.egressProxy ?? null,

    async ensureNetwork() {
      if (opts.prepare === undefined) {
        throw new Error(
          "the docker tools network is the launcher's to make (internal, its gateway isolated), " +
            "and this tool host was given no way to make it",
        );
      }
      await opts.prepare();
    },

    async launch(spec) {
      const guard = spec.name === guardName;
      if (guard) {
        if (opts.guardImage === undefined) {
          throw new Error("this tool host was given no guard image, so it launches no guard");
        }
        if (spec.image !== opts.guardImage) {
          throw new Error(`the tool guard runs ${opts.guardImage}, never ${spec.image}`);
        }
        // Before anything is removed to make room: a refused shape replaces nothing.
        const problem = guardSpecProblem(spec);
        if (problem !== null) throw new Error(problem);
        if (spec.publish !== undefined && opts.joined === true) {
          throw new Error("the guard's caller is on its network, so the guard publishes nothing");
        }
      } else {
        const problem = toolNameProblem(spec.name);
        if (problem !== null) throw new Error(problem);
      }
      // Before anything is removed: a network that stopped confining takes no launch at all.
      await opts.confined?.();
      // The one a relaunch replaces, when it is this host's: a name held by anything else is
      // refused, never removed to make room.
      const found = await owner(spec.name);
      if (found === "foreign" || found === "unknown") throw notOurs(spec.name, found);
      if (found === "ours") {
        await docker(["rm", "-f", spec.name]).catch((err) => {
          if (!gone(err)) throw err;
        });
      }
      // The secrets travel on this process's environment, not in the argv.
      if (!guard) {
        await docker(toolLaunchArgs(spec, opts), spec.secretEnv);
        return { handle: spec.name, address: `${spec.name}:${spec.port}` };
      }
      try {
        await docker(guardCreateArgs(spec, opts), spec.secretEnv);
        await docker(["network", "connect", network, spec.name]);
        await docker(["start", spec.name]);
      } catch (err) {
        // Half made — created and never connected, or connected and never started — is a guard
        // nobody can use holding the name: gone, so the next launch starts clean.
        await docker(["rm", "-f", spec.name]).catch(() => {});
        throw err;
      }
      if (spec.publish === undefined) {
        return { handle: spec.name, address: `${spec.name}:${spec.port}` };
      }
      const { stdout } = await docker(["port", spec.name, `${spec.port}/tcp`]);
      const bound = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("127.0.0.1:"));
      if (bound === undefined) {
        throw new Error(`docker reported no loopback binding for ${spec.name}: ${stdout.trim()}`);
      }
      return { handle: spec.name, address: bound };
    },

    async stop(handle) {
      const found = await owner(handle);
      if (found === "absent") return;
      if (found !== "ours") throw notOurs(handle, found);
      await docker(["rm", "-f", handle]).catch((err) => {
        if (!gone(err)) throw err;
      });
    },

    async list() {
      const { stdout } = await docker(toolListArgs(network, deployment));
      return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    },

    async inspect(handle): Promise<ToolContainerState> {
      // Another's container is not this host's to report on: "unknown", which acts on nothing.
      if (await owner(handle) !== "ours") return "unknown";
      try {
        const { stdout } = await docker(["inspect", "-f", "{{.State.Status}}", handle]);
        const status = stdout.trim();
        if (status === "running") return "running";
        if (status === "exited" || status === "dead" || status === "created") return "exited";
        return "unknown";
      } catch {
        return "unknown";
      }
    },

    async address(handle, port) {
      return (await this.inspect(handle)) === "running" ? `${handle}:${port}` : null;
    },

    async logs(handle, tail) {
      const found = await owner(handle);
      // Not launched yet (a launch window) or already gone: nothing to read, as under Kubernetes.
      if (found === "absent") return "";
      if (found !== "ours") throw notOurs(handle, found);
      const { stdout, stderr } = await docker([
        "logs",
        "--timestamps",
        "--tail",
        String(tail),
        handle,
      ]);
      return mergeTimestamped(stdout, stderr);
    },
  };
}
