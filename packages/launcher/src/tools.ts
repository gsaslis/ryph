// Where hosted MCP servers run under docker, made by the one process that may make it: the tools
// network, the guard's ordinary side, and the egress relay. The docker tool host
// (@ryph/mcp-gateway's adapters/tool_host/docker.ts) launches containers onto what this makes;
// it holds none of the engine checks, so its `ensureNetwork` is this (`prepareTools`).
//
// The posture is a confined run's, for a confined run's reason: a vendor's image is code nobody
// here wrote, with an operator's credential in its hands.
//
//   vendor ─┐ tools network: --internal, gateway mode `isolated` (no route, no outside DNS, no host)
//   vendor ─┤
//           ├─ ryph-tool-guard-…    ─┐ the edge: the deployment network (or `<tools>-edge`)
//           └─ ryph-egress-relay-… ─┤   guard ← the gateway (by name, or a 127.0.0.1 publish)
//                                    │   relay → the egress proxy's tool listener (`egress.target`)
//
// - the TOOLS NETWORK is made `--internal` with gateway mode `isolated` (Docker Engine 28+; a VM
//   engine older than that gets `--internal` alone, its bridge's host being the VM, as the run
//   network's rule has it), and hosting is REFUSED on an engine that cannot make one — Podman, a
//   native engine before 28 — because there is no unconfined fallback worth having: a vendor's
//   container on an ordinary bridge reaches every listener of everything on it, the docker host's
//   bridge gateway, the LAN and the internet. Measured on Docker Desktop 29: on the tools network
//   alone a container resolves no outside name, reaches neither 1.1.1.1 nor the host, and reaches
//   the guard and the relay by name.
// - every LAUNCH asks again (`verifyToolNetwork`) and is refused, not remade, on a network that
//   stopped confining since: the engine's networks are not this process's to keep as made.
// - a tools network that exists and does not confine (an older ryph made it a plain bridge) is
//   REPLACED when everything attached to it is this deployment's — its hosted servers, its guard,
//   its relay — which hosting relaunches anyway; anything else attached (an older compose file put
//   ryph or mcp-gateway on it) is refused, by name, with the fix: that container is not ours to
//   remove.
// - the GUARD's ordinary side is `edge`: the deployment network (deploy/compose and
//   compose-networked; the binary when RYPH_DOCKER_NETWORK is set), or `<tools>-edge`, which this
//   makes for a deployment without one. A user-defined network rather than docker's default
//   bridge, so the guard is certain of docker's embedded DNS, which is how it dials vendors.
// - the EGRESS RELAY is the run gate's image and posture (`relayCreateArgs`), with one route:
//   :7460 on the tools network to the egress proxy's TOOL listener, where only a hosted server's
//   claim opens anything and nothing private is ever dialled (images/egress-proxy/main.ts). A
//   container of its own rather than a port on the guard, because the guard is relaunched on every
//   route change and holds the most sensitive tokens hosting has. Named outside the `ryph-tool-*`
//   handles the tool routes take, so a tools-token holder can neither stop it nor read it, and
//   labelled `ryph.tool.egress` rather than `ryph.gate`, which the run gate's stray sweep removes.

import {
  DEPLOYMENT_LABEL,
  type DockerEngine,
  dockerEngine,
  type DockerExec,
  ensureImageId,
  GATE_NO_FORWARD,
  GATE_TARGET,
  inspectInternalNetwork,
  internalNetworkCommand,
  internalNetworkCreateArgs,
  internalNetworkProblem,
  type InternalNetworkWords,
  relayCreateArgs,
} from "@ryph/orchestrator/docker";
import {
  TOOL_DEPLOYMENT_LABEL,
  TOOL_NETWORK_LABEL,
  toolEdgeNetwork,
} from "@ryph/mcp-gateway/tool-host";
import type { ToolsConfig } from "./config.ts";

/** The label on the egress relay, value = its tools network. */
export const EGRESS_RELAY_LABEL = "ryph.tool.egress";
/** The labels on the networks made here, value = the tools network. */
const TOOLS_NETWORK_LABEL = "ryph.tools";
const EDGE_NETWORK_LABEL = "ryph.tools.edge";
/** Where the relay listens on the tools network — the egress proxy's run port, for familiarity. */
export const EGRESS_RELAY_PORT = 7460;

/** The egress relay's container name for a tools network: outside the `ryph-tool-*` handles. */
export function egressRelayName(network: string): string {
  return `ryph-egress-relay-${network}`;
}

/** The proxy a hosted server is handed (`ToolHost.egressProxy`), as it dials the relay. */
export function egressRelayOrigin(network: string): string {
  return `http://${egressRelayName(network)}:${EGRESS_RELAY_PORT}`;
}

/** The guard's and the relay's ordinary network: `edge`, or the one made for it. */
export function edgeOf(tools: Pick<ToolsConfig, "network" | "edge">): string {
  return tools.edge ?? toolEdgeNetwork(tools.network);
}

/** The tools network's words, as `internalNetworkProblem` says them. */
export const TOOL_NETWORK_WORDS: InternalNetworkWords = {
  setting: "RYPH_TOOL_NETWORK",
  confined: "hosted MCP servers",
  one: "a hosted MCP server",
  onIt: "a hosted server",
  all: "hosted servers",
  without: "register MCP servers by their remote URL instead of hosting them",
  recreate: (network, engine) =>
    `remove every container from it, then \`docker network rm ${network}\` and ` +
    `\`${internalNetworkCommand(network, engine)}\` (the launcher does this itself when only ` +
    `its own hosted servers are attached)`,
};

/** Why this engine cannot confine hosted servers, or null — said at boot, refused at hosting's. */
export function toolsEngineProblem(network: string, engine: DockerEngine): string | null {
  return internalNetworkProblem(network, null, engine, TOOL_NETWORK_WORDS);
}

/** The `docker create` argv for the egress relay. Pure, and exported for the test. */
export function egressRelayArgs(tools: ToolsConfig, deployment: string): string[] {
  if (tools.egress === null) throw new Error("this launcher's hosted servers have no egress");
  return relayCreateArgs({
    name: egressRelayName(tools.network),
    labels: [`${EGRESS_RELAY_LABEL}=${tools.network}`, `${DEPLOYMENT_LABEL}=${deployment}`],
    network: edgeOf(tools),
    addHost: tools.egress.target === GATE_TARGET,
    image: tools.egress.image,
    command: [`${EGRESS_RELAY_PORT}=${tools.egress.target}:${tools.egress.port}`],
  });
}

/**
 * Whether the relay `docker inspect` describes is the one `tools` asks for: running, on the image
 * `imageId` names, with the same route, not forwarding, on both networks. Pure and exported for
 * the test; anything unreadable is "no", which only costs a recreate.
 */
export function egressRelayCurrent(
  inspectJson: string,
  imageId: string,
  tools: ToolsConfig,
  deployment: string,
): boolean {
  try {
    const parsed = JSON.parse(inspectJson);
    const relay = Array.isArray(parsed) ? parsed[0] : parsed;
    if (relay?.State?.Running !== true || relay?.Image !== imageId) return false;
    const want = egressRelayArgs(tools, deployment);
    const command = want.slice(want.indexOf(tools.egress!.image) + 1);
    const have = relay?.Config?.Cmd;
    if (!Array.isArray(have) || have.join(" ") !== command.join(" ")) return false;
    if (relay?.HostConfig?.Sysctls?.[GATE_NO_FORWARD] !== "0") return false;
    const networks = Object.keys(relay?.NetworkSettings?.Networks ?? {});
    return networks.includes(tools.network) && networks.includes(edgeOf(tools));
  } catch {
    return false;
  }
}

/** One preparation per tools network at a time, across every caller in this process. */
const locks = new Map<string, Promise<unknown>>();

/**
 * Everything hosting needs on docker, made or remade until it is what `tools` asks for: the tools
 * network (internal, isolated), the guard's ordinary network when it is the launcher's to make,
 * and the egress relay. Idempotent and cheap when nothing changed; throws, naming the fix, where
 * the engine cannot confine or something not ours holds the network. What `ensureNetwork` is.
 */
export function prepareTools(
  tools: ToolsConfig,
  deployment: string,
  exec: DockerExec,
): Promise<void> {
  const next = (locks.get(tools.network) ?? Promise.resolve()).then(async () => {
    await ensureToolNetwork(tools, deployment, exec);
    await ensureEdgeNetwork(tools, deployment, exec);
    await ensureToolEgressRelay(tools, deployment, exec);
  });
  const settled = next.catch(() => {});
  locks.set(tools.network, settled);
  settled.then(() => {
    if (locks.get(tools.network) === settled) locks.delete(tools.network);
  });
  return next;
}

/**
 * That the tools network STILL confines, asked before every launch onto it: refusing, never
 * remaking. `prepareTools` makes it right at hosting's boot, but a network is the daemon's, not
 * this process's — an older binary or compose file on the same engine can remove it and make it
 * again as a plain bridge while this launcher runs, and every launch after that would put a
 * vendor's image on a network that confines nothing, with no boot to notice. Remaking it here
 * would remove running servers under a launch that asked for one; the refusal names the fix, and
 * hosting's next boot remakes it. One `network inspect` per launch (the engine is read once), beside
 * a launch that may pull an image.
 */
export async function verifyToolNetwork(tools: ToolsConfig, exec: DockerExec): Promise<void> {
  const engine = await dockerEngine(exec);
  const state = await inspectInternalNetwork(tools.network, exec);
  const problem = state === null
    ? `RYPH_TOOL_NETWORK=${tools.network} is gone (or docker would not describe it), so nothing ` +
      "says a hosted server launched onto it now would be confined — restart the gateway, whose " +
      "boot makes it again"
    : internalNetworkProblem(tools.network, state, engine, TOOL_NETWORK_WORDS);
  if (problem !== null) throw new Error(`refusing to launch: ${problem}`);
}

const lines = (out: string) => out.split(/\s+/).map((l) => l.trim()).filter((l) => l !== "");

/** Whether a container attached to the tools network is this deployment's own: one of its hosted
 * servers or its guard (the docker tool host's labels), or its egress relay. */
async function ours(
  container: string,
  tools: ToolsConfig,
  deployment: string,
  exec: DockerExec,
): Promise<boolean> {
  const out = await exec([
    "inspect",
    "--type",
    "container",
    "-f",
    `{{index .Config.Labels "${TOOL_NETWORK_LABEL}"}}|` +
    `{{index .Config.Labels "${TOOL_DEPLOYMENT_LABEL}"}}|` +
    `{{index .Config.Labels "${EGRESS_RELAY_LABEL}"}}`,
    container,
  ]).catch(() => null);
  if (out === null) return false;
  const [network, of, relay] = out.trim().split("|");
  return of === deployment && (network === tools.network || relay === tools.network);
}

/** The tools network, made if it is missing and remade if it does not confine (see the header). */
export async function ensureToolNetwork(
  tools: ToolsConfig,
  deployment: string,
  exec: DockerExec,
): Promise<DockerEngine> {
  const { network } = tools;
  const engine = await dockerEngine(exec);
  const refused = toolsEngineProblem(network, engine);
  if (refused !== null) throw new Error(refused);
  const create = () =>
    exec(internalNetworkCreateArgs(network, engine, [
      `${TOOLS_NETWORK_LABEL}=1`,
      `${DEPLOYMENT_LABEL}=${deployment}`,
    ]));
  const state = await inspectInternalNetwork(network, exec);
  if (state === null) {
    await create().catch(async (err) => {
      // Another caller made it between the read and the create: the read again decides.
      if (await inspectInternalNetwork(network, exec) === null) throw err;
    });
  } else if (internalNetworkProblem(network, state, engine, TOOL_NETWORK_WORDS) !== null) {
    const attached = lines(
      await exec(["network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", network]),
    );
    const foreign: string[] = [];
    for (const container of attached) {
      if (!await ours(container, tools, deployment, exec)) foreign.push(container);
    }
    if (foreign.length > 0) {
      throw new Error(
        `RYPH_TOOL_NETWORK=${network} does not confine hosted servers (it is not internal, or ` +
          `keeps a gateway on the docker host), and ${foreign.join(", ")} ` +
          `${foreign.length === 1 ? "is" : "are"} attached to it, which ${
            foreign.length === 1 ? "is not one" : "are not"
          } of this deployment's hosted servers — so it is not the launcher's to remake. ` +
          `Detach ${foreign.length === 1 ? "it" : "them"} (\`docker network disconnect ` +
          `${network} <container>\`; an older compose file put ryph or mcp-gateway there, and ` +
          "`docker compose up -d` with this one recreates them without it), and hosting " +
          "remakes the network on its next boot.",
      );
    }
    // Only this deployment's hosted servers, which hosting relaunches onto the new network.
    for (const container of attached) await exec(["rm", "-f", container]);
    await exec(["network", "rm", network]);
    await create();
  }
  const problem = internalNetworkProblem(
    network,
    await inspectInternalNetwork(network, exec),
    engine,
    TOOL_NETWORK_WORDS,
  );
  if (problem !== null) throw new Error(problem);
  return engine;
}

/** The guard's ordinary network, when it is the one made beside the tools network. */
async function ensureEdgeNetwork(
  tools: ToolsConfig,
  deployment: string,
  exec: DockerExec,
): Promise<void> {
  // The deployment's own network is the deployment's to make (compose makes it).
  if (tools.edge !== undefined) return;
  const edge = edgeOf(tools);
  if (await exec(["network", "inspect", "-f", "{{.Name}}", edge]).then(() => true, () => false)) {
    return;
  }
  await exec([
    "network",
    "create",
    "--label",
    `${EDGE_NETWORK_LABEL}=${tools.network}`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deployment}`,
    edge,
  ]).catch((err) => {
    if (!/already exists/i.test(String(err))) throw err;
  });
}

/**
 * The egress relay, made or remade until it is what `tools` asks for — or removed, where hosted
 * servers have no egress (RYPH_TOOL_EGRESS_TARGET=off): a relay left from before would be a way out
 * the configuration took away. A container of that name that is not this deployment's relay is
 * refused, never removed.
 */
export async function ensureToolEgressRelay(
  tools: ToolsConfig,
  deployment: string,
  exec: DockerExec,
): Promise<void> {
  const name = egressRelayName(tools.network);
  const inspect = () => exec(["inspect", "--type", "container", name]).catch(() => null);
  const existing = await inspect();
  if (existing !== null) {
    let labels: Record<string, string> = {};
    try {
      const parsed = JSON.parse(existing);
      labels = (Array.isArray(parsed) ? parsed[0] : parsed)?.Config?.Labels ?? {};
    } catch {
      // unreadable: judged as not ours below
    }
    if (labels[EGRESS_RELAY_LABEL] !== tools.network || labels[DEPLOYMENT_LABEL] !== deployment) {
      throw new Error(
        `a container named ${name} is not this deployment's egress relay, so hosted servers ` +
          "have no way out — remove it, or give this deployment its own RYPH_TOOL_NETWORK",
      );
    }
  }
  if (tools.egress === null) {
    if (existing !== null) await exec(["rm", "-f", name]);
    return;
  }
  const imageId = await ensureImageId(tools.egress.image, exec, {
    image: "the egress relay's image (the run gate's, RYPH_DOCKER_GATE_IMAGE)",
    without: "hosted MCP servers have no way to the internet",
  });
  if (existing !== null && egressRelayCurrent(existing, imageId, tools, deployment)) return;
  try {
    await exec(["rm", "-f", name]).catch(() => {});
    await exec(egressRelayArgs(tools, deployment));
    await exec(["network", "connect", tools.network, name]);
    await exec(["start", name]);
  } catch (err) {
    // Another process (a second launcher on the same daemon and network) may be making it too:
    // what decides is whether it is right now.
    const now = await inspect();
    if (now !== null && egressRelayCurrent(now, imageId, tools, deployment)) return;
    throw err;
  }
}
