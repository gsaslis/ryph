// A local-docker `Provisioner`: shells out to the docker CLI, one container per run — plus, when
// the run declares them, one container per service on a network of the run's own.
//
// Known tradeoff, accepted: `-e K=V` makes the env visible in `docker inspect`. What it shows is
// the launch's single-use bootstrap bearer, spent by the runner at boot and expiring unredeemed
// otherwise; the run's own credentials arrive over that exchange and never ride the env.
//
// The services path is the docker adapter's hardest case, and the shape below is the one that
// survives contact with the daemon:
//
// - TWO networks, not a shared namespace. The agent needs the deployment network to reach the
//   control plane and the run network to reach its services, and `docker run --network` takes
//   one — hence create, connect, start. Sharing a namespace (`--network container:…`) was tried
//   and rejected: docker then forbids `--add-host host.docker.internal:host-gateway`, which the
//   agent needs, and forbids joining a second network at all. It would break the run's route to
//   its own control plane to buy an addressing symmetry Kubernetes gives for free.
// - the no-services path is byte-for-byte what it always was, single-shot `run -d`. The
//   overwhelmingly common run must not pay for this feature, nor change shape under it.
// - `docker network create` allocates from a fixed pool (~31 subnets by default) and NOTHING
//   reclaims it: the ceiling is cumulative, not concurrent, so a deployment hits "all predefined
//   address pools have been fully subnetted" around the 31st run it has ever done — an error
//   with no visible connection to its cause. So teardown is in three places, all of them here:
//   the launch `catch`, `kill`, and `reclaimOrphans`. Measured: `docker network rm` succeeds
//   with a STOPPED container still attached, which is why kill removes the containers first and
//   why the reconcile can remove a network whose containers are already gone.
//
//   `reclaimOrphans` is the one that carries the weight, and it runs on the REAPER'S TICK and
//   not only at boot. `kill` covers a run that is lost or cancelled; a run that simply
//   FINISHES leaves the active set without ever being killed, so it is the ordinary, happy
//   path that leaks — a Postgres per successful run, and the pool exhausted on success rather
//   than on any failure.
//
// The BROWSER (`LaunchSpec.browser`, core/browser.ts) is the one container that DOES share the
// agent's namespace: `--network container:<agent>`, started after the agent is. The reason the
// services rejected it is the reason the browser wants it — the agent keeps its own networks and
// its host alias, and the browser simply rides along, so `localhost:5173` is the agent's dev
// server here exactly as it is in a Kubernetes pod. It joins nothing of its own, holds no port
// on the host, and goes with the run through the same teardown as the services (`ryph.role`).
// Being started second means the runner may boot before it answers; the runner waits a minute.
// A browser container that fails to start — an image that will not pull included — is warned
// about and never fails the launch: the run goes on without one, as the runner's own wait would
// have it. Its only env is the sandbox policy (`browserArgs`).
//
// And the honest limitation, for the docs: a per-run docker network gives ADDRESSING isolation,
// not enforced isolation. OrbStack's networks do not isolate (measured), so another run can
// reach this run's database by IP.
// The real boundary is the Kubernetes NetworkPolicy; docker services are for development and
// trusted deployments.
//
// CONFINED RUNS (`runNetwork`, RYPH_DOCKER_RUN_NETWORK). Unset, a run keeps docker's default
// route and reaches the whole internet around the egress proxy — said once per process as
// `docker.egress_not_enforced`. Set, the run joins ONLY that network, which must be `--internal`:
// measured on Docker Desktop, a container there reaches no internet, resolves no outside name,
// and cannot reach the host either (`host.docker.internal` does not resolve and the gateway
// refuses). That last part is why this used to be declined — the control plane, model proxy, MCP
// gateway, forge and egress proxy are all the host-resident `ryph` process. The way back in is
// the GATE: one container per deployment (`gateName`), attached to the internal network AND an
// ordinary one, relaying a fixed list of TCP ports and nothing else (images/run-gate), each to a
// target of its own (`GateOptions.routes`). In the binary every route goes to
// `host.docker.internal:<same port>`, or to one name on the deployment network when an embedded
// launcher's host is itself a container (RYPH_DOCKER_GATE_TARGET, the embedded launcher's only);
// and a standalone launcher — deploy/compose and deploy/compose-networked alike — sends each port
// to the service behind it (the launcher's RYPH_DOCKER_GATE_ROUTES). A confined run is handed
// `http://<gate>:<port>` for every platform address, so the gate's route list is exactly what it
// can reach outside its network, and the egress proxy behind one of those ports is its only way
// to the internet. The proxy refuses loopback, private and the host's own addresses, so it cannot
// be turned into a second door.
//
// What changes for a confined run, and nothing else does:
//   · the agent joins `runNetwork` and no other network, and gets no `host.docker.internal`
//     mapping — there is nothing on the host it should reach except through the gate
//   · a run's services network is created `--internal` too, so a service container is exactly
//     as confined as the agent that declared it
//   · the browser is untouched: `--network container:<agent>` puts it in the agent's namespace,
//     so it inherits the confinement rather than needing any of its own
// The gate is made (or remade, when it has drifted — see `ensureGate` for when that waits on live
// runs and for how long) before every confined launch, under one lock per gate name, and a
// confined launch REFUSES a run network that cannot confine: one that is not internal, or — on an
// engine that can make one without — one whose bridge keeps a gateway address on the docker host
// (see `ISOLATED_GATEWAY`). A run that silently kept a way out while the deployment reads as
// confined is the one outcome this exists to make impossible.
//
// What confinement does NOT separate: runs of one deployment share the run network, so sibling
// runs — and check stages running a pull request's code — can reach each other's open ports.
// The runner's control listener is token-gated and the browser binds 127.0.0.1.

import { networkInterfaces } from "node:os";
import { command } from "@ryph/process";
import type {
  BrowserLaunch,
  LaunchSpec,
  Provisioner,
  ServiceSpec,
} from "../../ports/provisioner.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { ImageGone } from "../../ports/image_gone.ts";
import {
  CONFINED_BUILDER_PREFIX,
  daemonLacksImage,
  localImagePrefix,
  localOnlyImage,
  notOwnImage,
  ownImageRef,
} from "../environment_builder/local_images.ts";
import { memoryMebibytes, quantityCores, unappliedSizeFields } from "../../core/run_sizes.ts";
import { RUNNER_CONTROL_PORT } from "../../core/services.ts";

export interface DockerOptions {
  /** Docker network to attach, e.g. so containers can resolve the orchestrator by name. */
  network?: string;
  /** Seconds `docker stop` waits between SIGTERM and SIGKILL (the runner's graceful window). */
  stopGraceSeconds?: number;
  /**
   * The OCI runtime handed to `docker run --runtime`, i.e. the boundary an agent container gets.
   *
   * Unset is docker's default, `runc`: namespaces on the SHARED kernel. A container escape there
   * reaches the daemon, every sibling run's credentials, and — on Linux, where that kernel is the
   * real one — the host. A sandboxed runtime puts a second boundary in the way: `kata-runtime`
   * (a microVM with its own kernel) or `runsc` (gVisor's userspace kernel). Nothing else changes:
   * same image, same network, and the same SIGTERM-then-grace stop the runner's
   * graceful cancel is built on.
   *
   * Linux only in practice: Docker Desktop ships runc alone. An unregistered runtime
   * fails the launch loudly, naming itself, which is the intended outcome: a run that silently
   * fell back to runc would report a boundary it does not have.
   */
  runtime?: string;
  /**
   * The INTERNAL docker network runs join instead of `network`, when this deployment confines
   * them (RYPH_DOCKER_RUN_NETWORK). Requires `gate`. Unset keeps the old shape: a run with the
   * whole internet, warned once as `docker.egress_not_enforced`.
   */
  runNetwork?: string;
  /** The run gate a confined deployment's runs reach ryph through — see the header. */
  gate?: GateOptions;
  /**
   * Whether the networks a confined launch makes for itself (a run's services, a check suite's)
   * get gateway mode `isolated`, as the run network does. Not configuration: the launchers set it
   * per launch from what `ensureGate` read off the engine.
   */
  isolateGateway?: boolean;
  /**
   * The most any ONE container of a check suite (a check, setup, the clone) may use
   * (RYPH_CHECKS_CPUS / RYPH_CHECKS_MEMORY), on top of its size-class share; `auto` is half of
   * what the daemon has. The check launcher's alone.
   */
  checkCaps?: CheckCaps;
}

/** RYPH_CHECKS_CPUS / RYPH_CHECKS_MEMORY: cores and MiB, `auto`, or null for no cap. */
export interface CheckCaps {
  cpus: number | "auto" | null;
  memoryMi: number | "auto" | null;
}

/** One port the gate relays, and exactly where to. */
export interface GateRoute {
  /** The port the gate listens on: the port of a run-facing address that names the gate. */
  listen: number;
  /**
   * The host it relays to, as the gate resolves it — on the deployment network the gate is
   * created on (`DockerOptions.network`, else docker's default bridge), or the host itself as
   * `GATE_TARGET`. A name nothing on that network answers to is a route that refuses, not one that
   * goes somewhere else.
   */
  target: string;
  /** The port on `target`. */
  port: number;
}

export interface GateOptions {
  /** The gate's image (images/run-gate), RYPH_DOCKER_GATE_IMAGE. */
  image: string;
  /**
   * What it relays: exactly these listen ports, each to its own target, and nothing else. One
   * listen port names one destination — two routes that disagree about one are refused (see
   * `gateRoutesFor`, which derives them from the run-facing addresses).
   */
  routes: GateRoute[];
  /** Relays one run may hold open through the gate at once; unset is the gate's own default. */
  perSource?: number;
  /**
   * This deployment INSTANCE, as a label on the gate it makes. Two deployments with the same
   * deployment id (RYPH_DOCKER_NETWORK unset in both) share a gate name; this is how one tells the
   * other's gate from its own drifted one, and refuses to remove it from under live runs.
   * `EPHEMERAL_GATE_OWNER` for a deployment with no durable identity (an in-memory database).
   */
  owner?: string;
  /**
   * How long a drifted gate may be kept for the confined runs live behind it before it is remade
   * anyway, cutting them off. Unset is `GATE_DEFER_CAP_MS`.
   */
  deferCapMs?: number;
}

/** The owner label of a deployment with no durable identity — an in-memory database, which is a
 * new deployment every boot. One ephemeral deployment takes over another's gate like its own. */
export const EPHEMERAL_GATE_OWNER = "ephemeral";

/**
 * How long a drifted gate is kept for live runs before it is remade anyway: long enough for a
 * typical run to finish on the old gate, short enough that a configuration change is not held
 * back indefinitely by a deployment that is never idle.
 */
export const GATE_DEFER_CAP_MS = 30 * 60_000;

/** The label every object this adapter creates carries: containers, and now networks too. */
const RUN_LABEL = "ryph.run";
/** Tells a run's service and browser containers from its agent, which carries none. The
 * reconcile removes a role-carrying container even while it runs; an agent only once it exited. */
const ROLE_LABEL = "ryph.role";
/**
 * Which deployment created the object, so `reclaimOrphans` only ever reclaims its own.
 *
 * One docker daemon can carry two ryph deployments — the documented dev loop is exactly that,
 * `bun run up` in host mode beside `bun run compose:up`, both on RYPH_PROVISIONER=docker.
 * Without this, each sweep sees the other's service containers and run networks, finds their run
 * ids absent from ITS store, and force-removes them: the victim's database vanishes mid-suite
 * with nothing in its own logs to explain it.
 */
export const DEPLOYMENT_LABEL = "ryph.deployment";

/**
 * The deployment's identity, from the one thing configuration already gives a deployment of its
 * own: the docker network it puts its containers on (`RYPH_DOCKER_NETWORK`). Unset is a
 * deployment on the default bridge, which is a deployment too — it gets a name of its own rather
 * than an empty label, so the sweep's filter is always an equality and never a "has the key".
 */
export function deploymentId(opts: Pick<DockerOptions, "network">): string {
  return opts.network ?? "default";
}

/** Marks the gate container, whose lifetime is the deployment's and not any run's. Never
 * `ryph.role`: `reclaimOrphans` removes any container carrying one whose run is not active. */
const GATE_LABEL = "ryph.gate";
/** Which deployment INSTANCE made the gate (`GateOptions.owner`): two deployments that share a
 * deployment id — both with RYPH_DOCKER_NETWORK unset — would otherwise remake each other's. */
const GATE_OWNER_LABEL = "ryph.gate.owner";

/**
 * The gate's container name — also the hostname a confined run dials every platform address
 * at, so the wizard writes it into RYPH_PUBLIC_URL and friends. One per deployment, named for it,
 * so the documented two-deployments-on-one-daemon loop gets one each.
 */
export function gateName(opts: Pick<DockerOptions, "network"> = {}): string {
  return `ryph-gate-${deploymentId(opts)}`;
}

/**
 * The run network a deployment's confined runs join unless RYPH_DOCKER_RUN_NETWORK names another,
 * named for the deployment like the gate: `ryph-runs` on the default bridge, `ryph-runs-<network>`
 * beside a deployment network. `ryph setup` writes it; the host takes whatever is configured.
 */
export function defaultRunNetwork(opts: Pick<DockerOptions, "network"> = {}): string {
  return opts.network === undefined ? "ryph-runs" : `ryph-runs-${opts.network}`;
}

/** The host, as Docker Desktop names it (and as the `--add-host` below makes true on a native Linux
 * daemon): where the binary's gate relays every route, ryph being the host-resident process. */
export const GATE_TARGET = "host.docker.internal";

/**
 * The gate's open-file limit. Two descriptors per relay, and the gate caps itself at 4096 relays
 * (images/run-gate's MAX_CONNECTIONS), so this leaves double the worst case: the gate refuses a
 * connection by its own count long before the kernel would refuse it an accept.
 */
const GATE_NOFILE = 16_384;

/** Where a route goes, as the gate's argv and the drift warnings write it. */
const destination = (route: Pick<GateRoute, "target" | "port">) => `${route.target}:${route.port}`;

/**
 * The routes, one per listen port and sorted by it, so that the same configuration is always the
 * same command line — which is what `gateCurrent` compares. The same route twice is one route; two
 * that send one listen port to different places are a configuration nobody can mean, and throw.
 */
function gateRoutes(gate: Pick<GateOptions, "routes">): GateRoute[] {
  const byListen = new Map<number, GateRoute>();
  for (const route of gate.routes) {
    const seen = byListen.get(route.listen);
    if (seen !== undefined && destination(seen) !== destination(route)) {
      throw new Error(
        `the run gate cannot relay port ${route.listen} to both ${destination(seen)} and ` +
          destination(route),
      );
    }
    byListen.set(route.listen, route);
  }
  return [...byListen.values()].sort((a, b) => a.listen - b.listen);
}

/** The gate's own command line — its whole policy, and what `ensureGate` compares to decide
 * whether a running gate is still the one this deployment wants. Every route spelled out as
 * `<listen>=<target>:<port>`: the gate's short forms, which lean on one `--target`, are never
 * written, so `docker inspect` names each port's destination where it stands. */
export function gateCommand(gate: GateOptions): string[] {
  return [
    ...(gate.perSource === undefined ? [] : ["--per-source", String(gate.perSource)]),
    ...gateRoutes(gate).map((r) => `${r.listen}=${destination(r)}`),
  ];
}

/** A run-facing address, and where the gate sends it when it names the gate. */
export interface GateAddress {
  /** The setting it comes from, as the warning about an address off the gate names it. */
  setting: string;
  /** The address a confined run is handed; null when the setting is unset. */
  url: string | null;
  /** Where the gate relays the address's port (`GateRoute.target`). */
  target: string;
  /** The port on `target`; unset is the address's own port. */
  port?: number;
}

/**
 * The gate's routes, read off the addresses a confined run is handed — and the addresses that do
 * NOT go through it, which a confined run cannot reach at all. Pure and exported for the test.
 *
 * Derived rather than configured, so the gate's list and the runs' addresses cannot drift apart:
 * a port is open exactly when some run-facing address names it on the gate, and it goes where
 * the composition root says that address's service listens. The binary sends every address to
 * one target (the host, or itself as a container); a deployment of separate services gives each
 * its own. Two addresses on one gate port must agree on where it goes, or this throws: the gate
 * can relay a port to one place only, and guessing which would hand one service's traffic to the
 * other.
 */
export function gateRoutesFor(
  gate: string,
  addresses: readonly GateAddress[],
): { routes: GateRoute[]; elsewhere: string[] } {
  const routes: GateRoute[] = [];
  const elsewhere: string[] = [];
  for (const { setting, url: value, target, port } of addresses) {
    if (value === null) continue;
    const url = URL.parse(value);
    if (url === null || url.hostname !== gate) {
      elsewhere.push(`${setting}=${value}`);
      continue;
    }
    const listen = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const route = { listen, target, port: port ?? listen };
    const clash = routes.find((r) => r.listen === listen && destination(r) !== destination(route));
    if (clash !== undefined) {
      throw new Error(
        `${setting}=${value} sends the run gate's port ${listen} to ${destination(route)}, but ` +
          `another run-facing address sends it to ${destination(clash)} — give each its own port`,
      );
    }
    routes.push(route);
  }
  return { routes: gateRoutes({ routes }), elsewhere };
}

/** The sysctl that keeps a relay from routing between the networks it is on. IPv4 only: the
 * IPv6 one does not exist where the host has IPv6 off, and the run networks are IPv4. */
export const GATE_NO_FORWARD = "net.ipv4.ip_forward";

/** One relay container: the run gate, or hosting's egress relay (packages/launcher), which is the
 * run gate's image with a route of its own. */
export interface RelaySpec {
  name: string;
  /** `key=value`, each one `--label`. */
  labels: string[];
  /** The ORDINARY network it is created on (see `relayCreateArgs`). */
  network: string;
  /** Some route relays to the host (`GATE_TARGET`), so the name has to be mapped. */
  addHost: boolean;
  image: string;
  /** The routes, as the run gate's argv. */
  command: string[];
}

/**
 * The `docker create` argv for a relay — the run gate, or hosting's egress relay. Pure and
 * exported for the test and for the launcher, which makes the egress relay with the same posture.
 *
 * Created on the ORDINARY side — the deployment network, or docker's default bridge — and then
 * connected to the internal network, rather than the other way round, because the first network
 * is the one docker takes the default route from: created on the internal network, the relay
 * would have no way out either. It is also the network every route's target resolves on — the
 * one ryph, or each service a route names, shares with the relay — and the only one besides the
 * internal side (and, for the run gate, a confined build's own, which the builder attaches): a
 * target on any other network is a route that refuses. Everything a relay does not need is taken
 * away: no capability, no privilege to gain, a read-only root, a non-root user, small caps —
 * except open files, which a relay for every confined run needs plenty of. `unless-stopped` so
 * that a daemon restart brings back the one thing every confined container's way out goes
 * through.
 */
export function relayCreateArgs(spec: RelaySpec): string[] {
  return [
    "create",
    "--name",
    spec.name,
    ...spec.labels.flatMap((label) => ["--label", label]),
    "--network",
    spec.network,
    // The host's name, only when some route relays there: a relay relaying only to containers
    // needs no way to the host at all.
    ...(spec.addHost ? ["--add-host", `${GATE_TARGET}:host-gateway`] : []),
    "--restart",
    "unless-stopped",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--ulimit",
    `nofile=${GATE_NOFILE}:${GATE_NOFILE}`,
    // A relay, not a router: it sits on an internal network and an ordinary one (the run gate on
    // every confined build's own too), and a packet addressed through it from one must not come
    // out on another.
    "--sysctl",
    `${GATE_NO_FORWARD}=0`,
    spec.image,
    ...spec.command,
  ];
}

/** The `docker create` argv for the gate (`relayCreateArgs`). Pure and exported for the test. */
export function gateArgs(opts: DockerOptions): string[] {
  if (!opts.gate) throw new Error("a confined docker deployment needs a gate image");
  const deployment = deploymentId(opts);
  return relayCreateArgs({
    name: gateName(opts),
    labels: [
      `${GATE_LABEL}=${deployment}`,
      `${DEPLOYMENT_LABEL}=${deployment}`,
      ...(opts.gate.owner === undefined ? [] : [`${GATE_OWNER_LABEL}=${opts.gate.owner}`]),
    ],
    network: opts.network ?? "bridge",
    addHost: gateRoutes(opts.gate).some((r) => r.target === GATE_TARGET),
    image: opts.gate.image,
    command: gateCommand(opts.gate),
  });
}

/**
 * Whether the gate `docker inspect` describes is the one `opts` asks for: running, on the image
 * `imageId` names, with the same command, attached to the run network. Pure and exported for the
 * test; anything unreadable is "no", which only costs a recreate.
 */
export function gateCurrent(inspectJson: string, imageId: string, opts: DockerOptions): boolean {
  try {
    const gate = inspected(inspectJson);
    if (gate?.State?.Running !== true) return false;
    if (gate?.Image !== imageId) return false;
    const want = gateCommand(opts.gate!);
    const have = gate?.Config?.Cmd;
    if (!Array.isArray(have) || have.join(" ") !== want.join(" ")) return false;
    if (gate?.HostConfig?.Sysctls?.[GATE_NO_FORWARD] !== "0") return false;
    const networks = Object.keys(gate?.NetworkSettings?.Networks ?? {});
    return networks.includes(opts.runNetwork!) && networks.includes(opts.network ?? "bridge");
  } catch {
    return false;
  }
}

/**
 * The routes a gate's command line relays, read as the gate reads it — `<listen>=<host>:<port>`,
 * or a short form on `--target` (`<port>`, `<listen>:<port>`) — or null when the command cannot
 * be read as one, which is treated as "relays who knows what". Every flag the gate takes has a
 * value, so an unknown one skips its value rather than reading it as a route.
 */
export function gateCommandRoutes(cmd: unknown): GateRoute[] | null {
  if (!Array.isArray(cmd)) return null;
  const portOf = (raw: string | undefined) => {
    const port = /^\d{1,5}$/.test(raw ?? "") ? Number(raw) : 0;
    return port >= 1 && port <= 65535 ? port : null;
  };
  let target: string | null = null;
  const routes: Array<{ listen: number; target: string | null; port: number }> = [];
  for (let i = 0; i < cmd.length; i++) {
    const arg = String(cmd[i]);
    if (arg.startsWith("--")) {
      if (arg === "--target") target = cmd[i + 1] === undefined ? null : String(cmd[i + 1]);
      i++;
      continue;
    }
    const at = arg.indexOf("=");
    if (at !== -1) {
      // `<listen>=<host>:<port>`: a destination of its own.
      const [host, rawPort, extra] = arg.slice(at + 1).split(":");
      const listen = portOf(arg.slice(0, at));
      const port = portOf(rawPort);
      if (host === "" || extra !== undefined || listen === null || port === null) return null;
      routes.push({ listen, target: host, port });
      continue;
    }
    // `<listen>[:<port>]`, on whatever `--target` says.
    const [rawListen, rawPort, extra] = arg.split(":");
    const listen = portOf(rawListen);
    const port = rawPort === undefined ? listen : portOf(rawPort);
    if (extra !== undefined || listen === null || port === null) return null;
    routes.push({ listen, target: null, port });
  }
  if (routes.some((r) => r.target === null) && target === null) return null;
  return routes.map((r) => ({ listen: r.listen, target: r.target ?? target!, port: r.port }));
}

/**
 * Why a drifted gate must be remade NOW, live runs or not — or null when its drift may wait for
 * them (up to `GateOptions.deferCapMs`). Pure and exported for the test.
 *
 * Four kinds of drift never wait. A new image is new gate code, which may be the fix for the
 * gate itself. A gate that routes between its networks must not stay on them: it sits on every
 * confined build's own, where a RUN step can hand it raw packets for the run network. A listen
 * port the configuration no longer opens must not stay relayed: that is reach the operator took
 * away. And a listen port the configuration now sends somewhere else must not keep going where it
 * went — a MOVED route is not an added one, it is a dropped destination and a new one at once,
 * and the dropped half is reach taken away like any other: the old target may be a service that
 * is gone, or one that has since become something a run must not touch (the host, say, once
 * that port moved into a container), and every byte a run sends to the address it was handed goes
 * on landing there, while the service the configuration now names never sees it.
 *
 * What may wait is drift that only ADDS: a listen port the old gate does not relay yet. The old
 * gate then relays a strict subset of the routes this configuration names, each to the place it
 * names, so a run behind it can reach nothing the configuration does not allow; it merely cannot
 * reach the new address until the gate is remade — an outage for that one address, never a way
 * out. So may drift that moves nothing a run can reach: its networks, its per-source cap.
 */
export function gateSecurityDrift(
  // oxlint-disable-next-line typescript/no-explicit-any
  gate: any,
  imageId: string,
  opts: DockerOptions,
): string | null {
  if (gate?.Image !== imageId) return "its image changed (new gate code)";
  if (gate?.HostConfig?.Sysctls?.[GATE_NO_FORWARD] !== "0") {
    return "it forwards packets between the networks it is on";
  }
  const have = gateCommandRoutes(gate?.Config?.Cmd);
  if (have === null) return "its command line cannot be read, so what it relays is unknown";
  const want = new Map(gateRoutes(opts.gate!).map((r) => [r.listen, r]));
  const dropped = [...new Set(have.map((r) => r.listen))].filter((p) => !want.has(p))
    .sort((a, b) => a - b);
  if (dropped.length > 0) {
    return `it relays port${dropped.length === 1 ? "" : "s"} ${
      dropped.join(", ")
    } that this configuration no longer opens`;
  }
  const moved = have.filter((r) => destination(r) !== destination(want.get(r.listen)!))
    .sort((a, b) => a.listen - b.listen);
  if (moved.length > 0) {
    return `it relays ${
      moved.map((r) =>
        `port ${r.listen} to ${destination(r)}, which this configuration sends to ` +
        destination(want.get(r.listen)!)
      ).join("; ")
    }`;
  }
  return null;
}

// oxlint-disable-next-line typescript/no-explicit-any
function inspected(json: string): any {
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

// ── The engine, and what an internal network is on it ─────────────────────────────────────────
//
// `--internal` takes a network's default route away, but on a native Linux daemon it does NOT
// take the host away: the bridge still gets a gateway address on the host, and docker's
// isolation filters what is FORWARDED, not what is delivered to the host itself. So a run on a
// plain internal network can dial that gateway — or docker0's 172.17.0.1, also the host — on any
// port a host service binds on 0.0.0.0. (Reproduced inside Docker Desktop's VM, which is the
// same Linux engine: a 0.0.0.0 listener in the VM answered a container on a plain internal
// network at its gateway, and nothing on an isolated one.) Engine 28.0 added the fix, gateway
// mode `isolated`, legal only on an internal network: the bridge gets no address at all.
//
// So wherever the engine can make one, the run network must be isolated — on Docker Desktop and
// OrbStack too, whose bridges' host is their VM: what listens there is not this machine, but it
// is reachable, and nothing is gained by leaving it so. Only a VM-backed engine too old to make
// one is grandfathered, its bridge's host not being this machine; a native engine that old
// cannot confine runs at all.
//
// Two different questions are asked about the engine, and they are kept apart:
//   · whether isolation is ENFORCED trusts only what it can positively identify. An engine is
//     VM-backed only when docker says it is Docker Desktop or OrbStack; Colima, Rancher Desktop,
//     rootless docker and anything unknown get the strict reading
//   · whether this process's listeners MOVE to the docker bridge asks the machine, not the engine
//     (`localBridgeGateway`): only when the bridge's gateway is an address of this very machine —
//     a native Linux engine — does a container's `host.docker.internal` land on it. Mistaking a
//     VM's bridge for this machine's writes a bind address no interface here has, and the
//     listener fails to start.

/** `docker network create` options that leave an internal bridge with no address on the host. */
const ISOLATED_GATEWAY = [
  "-o",
  "com.docker.network.bridge.gateway_mode_ipv4=isolated",
  "-o",
  "com.docker.network.bridge.gateway_mode_ipv6=isolated",
];

/** The docker engine as confinement needs to know it. */
export interface DockerEngine {
  /** The server version, as `docker info` reports it — Podman's own, behind Podman. */
  version: string;
  /**
   * POSITIVELY known to be VM-backed: Docker Desktop or OrbStack, whose daemon and every bridge's
   * host side live in a VM. Anything else — Colima, Rancher Desktop, rootless docker, unknown —
   * reads false, which is the strict reading for enforcement.
   */
  vm: boolean;
  /** A Docker engine 28.0 or later: an internal network can be made with no gateway on its host. */
  isolatedGateway: boolean;
  /** The docker CLI is talking to Podman's docker-compatible API. */
  podman: boolean;
}

/**
 * `{{.ServerVersion}}|{{.OSType}}|{{.OperatingSystem}}`, and the server's component names from
 * `docker version`, → the engine. Pure and exported for the test. Anything unreadable is the
 * strict reading: a native engine without the option.
 *
 * Podman's docker API answers with Podman's own version ("5.2.0"), which would otherwise read as
 * a docker newer than any there is; it names itself in its components ("Podman Engine").
 */
export function parseDockerEngine(line: string, components = ""): DockerEngine {
  const [version = "", , os = ""] = line.trim().split("|");
  const podman = /podman/i.test(components) || /podman/i.test(os);
  const major = Number(/^(\d+)\./.exec(version)?.[1] ?? NaN);
  return {
    version,
    vm: !podman && /Docker Desktop|OrbStack/i.test(os),
    isolatedGateway: !podman && Number.isFinite(major) && major >= 28,
    podman,
  };
}

const engines = new WeakMap<DockerExec, Promise<DockerEngine>>();

/** How long reading the engine may take before docker counts as not answering. */
export const ENGINE_TIMEOUT_MS = 15_000;

/**
 * The engine behind `exec`, read once per exec (once per process for the real CLI). A failed
 * read is forgotten, so the next caller asks again. Cached for the process's lifetime: a daemon
 * upgrade or a switch of docker context is noticed on the next restart.
 */
export function dockerEngine(exec: DockerExec = docker): Promise<DockerEngine> {
  let engine = engines.get(exec);
  if (engine === undefined) {
    // Bounded, so a daemon that holds the socket without answering (Docker Desktop starting, or
    // paused) fails the read and is asked again next time, rather than every later caller
    // awaiting the one read that never ends.
    const signal = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
    engine = Promise.all([
      exec(["info", "--format", "{{.ServerVersion}}|{{.OSType}}|{{.OperatingSystem}}"], { signal }),
      // Only Podman's answer matters here, so a CLI or daemon that will not say is not Podman.
      exec(["version", "--format", "{{range .Server.Components}}{{.Name}};{{end}}"], { signal })
        .catch(() => ""),
    ]).then(([info, components]) => parseDockerEngine(info, components));
    engines.set(exec, engine);
    engine.catch(() => engines.delete(exec));
  }
  return engine;
}

/**
 * The default bridge's gateway when it is one of THIS machine's own addresses — the pure half of
 * `localBridgeGateway`. Linux only: no other OS runs a docker bridge on its own interfaces.
 */
export function bridgeOnThisMachine(
  gateway: string | null,
  os: string,
  addresses: Iterable<string>,
): string | null {
  if (os !== "linux" || gateway === null) return null;
  for (const address of addresses) if (address === gateway) return gateway;
  return null;
}

function interfaceAddresses(): string[] {
  try {
    return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
  } catch {
    return []; // nothing to look at: nothing is known to be local, so nothing moves
  }
}

/**
 * Where this machine's listeners must bind for a container's `host.docker.internal` to reach
 * them: the default bridge's IPv4 gateway, when that is one of this machine's own addresses (a
 * native Linux engine, which maps the name there) — otherwise null, and loopback is right. Docker
 * Desktop and OrbStack forward the name to this machine's loopback; Colima, Rancher Desktop and
 * rootless docker keep the bridge in a VM or a namespace this machine has no address on. Null too
 * when docker does not answer.
 */
export async function localBridgeGateway(
  exec: DockerExec = docker,
  os: string = process.platform,
  addresses: () => Iterable<string> = interfaceAddresses,
): Promise<string | null> {
  if (os !== "linux") return null;
  const out = await exec([
    "network",
    "inspect",
    "bridge",
    "-f",
    "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
  ]).catch(() => "");
  const gateway = out.split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
  return bridgeOnThisMachine(gateway, os, addresses());
}

/** What `docker network inspect` says of an internal network (the run network, the tools
 * network): internal, and its gateway isolated. */
export interface InternalNetworkState {
  internal: boolean;
  isolated: boolean;
}

/** An internal network's state, or null for "could not tell" (no such network, no daemon). The
 * confined launch, the host's boot check and the launcher's tools network all read it. */
export async function inspectInternalNetwork(
  network: string,
  exec: DockerExec = docker,
): Promise<InternalNetworkState | null> {
  try {
    const out = await exec([
      "network",
      "inspect",
      "-f",
      `{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|` +
      `{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}`,
      network,
    ]);
    const [internal, v4, v6] = out.split("|");
    if (internal !== "true" && internal !== "false") return null;
    return { internal: internal === "true", isolated: v4 === "isolated" && v6 === "isolated" };
  } catch {
    return null;
  }
}

/** Marks a run network ryph made, which `ryph setup` may therefore remake (`replaceIdle`). */
const RUN_NETWORK_LABEL = "ryph.runs=1";

/**
 * The `docker network create` argv for an internal network on `engine`: `--internal`, and gateway
 * mode `isolated` wherever the engine can make it (see `ISOLATED_GATEWAY`), with `labels`
 * (`key=value`). Pure and exported for the launcher's tools network.
 */
export function internalNetworkCreateArgs(
  network: string,
  engine: DockerEngine,
  labels: readonly string[],
): string[] {
  return [
    "network",
    "create",
    "--internal",
    ...(engine.isolatedGateway ? ISOLATED_GATEWAY : []),
    ...labels.flatMap((label) => ["--label", label]),
    network,
  ];
}

/** The `docker network create` argv for a run network on `engine`. Pure and exported for setup
 * and the test. */
export function runNetworkCreateArgs(network: string, engine: DockerEngine): string[] {
  return internalNetworkCreateArgs(network, engine, [RUN_NETWORK_LABEL]);
}

/** The command that makes `network` as `internalNetworkCreateArgs` would, labels aside: what an
 * operator types. */
export function internalNetworkCommand(network: string, engine: DockerEngine): string {
  return ["docker", ...internalNetworkCreateArgs(network, engine, [])].join(" ");
}

const recreateHint = (network: string, engine: DockerEngine) =>
  `\`docker network rm ${network}\` then \`${internalNetworkCommand(network, engine)}\` — a ` +
  `network with containers attached will not go until they do (\`docker network ` +
  `inspect ${network}\` lists them; the run gate is remade by the next launch). \`ryph setup\` ` +
  `does this for you when nothing but ryph's run gate is attached.`;

/**
 * Who an internal network confines, in the words `internalNetworkProblem` says it with: the runs
 * (`RUN_NETWORK_WORDS`), or hosted MCP servers (the launcher's tools network).
 */
export interface InternalNetworkWords {
  /** The setting that names the network: `RYPH_DOCKER_RUN_NETWORK`. */
  setting: string;
  /** What is confined, as Podman is said not to support it: "confined runs". */
  confined: string;
  /** One of them, as the subject of what it could reach: "a confined run". */
  one: string;
  /** One of them on the network named: "a run". */
  onIt: string;
  /** All of them: "runs" (cannot be confined on it). */
  all: string;
  /** The way to go without: "unset RYPH_DOCKER_RUN_NETWORK to run unconfined". */
  without: string;
  /** How to make it again, for a network that exists and cannot confine. */
  recreate(network: string, engine: DockerEngine): string;
}

/** The run network's words, which every run-side refusal has always said. */
export const RUN_NETWORK_WORDS: InternalNetworkWords = {
  setting: "RYPH_DOCKER_RUN_NETWORK",
  confined: "confined runs",
  one: "a confined run",
  onIt: "a run",
  all: "runs",
  without: "unset RYPH_DOCKER_RUN_NETWORK to run unconfined",
  recreate: recreateHint,
};

/**
 * Why `network` cannot confine what `words` names on `engine`, or null when it can. `state` null
 * is a network not made yet, judged on whether this engine could make one that confines. Pure
 * and exported: the run network's checks and the launcher's tools network both ask it.
 */
export function internalNetworkProblem(
  network: string,
  state: InternalNetworkState | null,
  engine: DockerEngine,
  words: InternalNetworkWords,
): string | null {
  if (engine.podman) {
    return `the docker CLI is talking to Podman ${engine.version || ""} (its docker-compatible ` +
      `API), and Podman is not supported for ${words.confined}: they rely on docker's internal ` +
      `networks with gateway mode \`isolated\` (Docker Engine 28.0+), which Podman does not ` +
      `implement. Point docker at a Docker engine, or ${words.without}.`;
  }
  if (!engine.vm && !engine.isolatedGateway) {
    return `docker ${engine.version || "(unknown version)"} is older than 28.0, so an internal ` +
      `network keeps a gateway address on its host, where ${words.one} could reach every ` +
      `service bound to 0.0.0.0 — ${words.all} cannot be confined on it. Upgrade docker to 28.0 ` +
      `or later, or ${words.without}.`;
  }
  if (state === null) return null;
  if (!state.internal) {
    return `${words.setting}=${network} is not an internal network, so ${words.onIt} on it would ` +
      `keep its default route. Recreate it: ${words.recreate(network, engine)}`;
  }
  if (engine.isolatedGateway && !state.isolated) {
    return `${words.setting}=${network} is internal but keeps a gateway address on the ` +
      `docker host (this machine on a native engine, the engine's VM on Docker Desktop or ` +
      `OrbStack), where ${words.onIt} could reach every service bound to 0.0.0.0 there — docker ` +
      `${engine.version} makes it with gateway mode \`isolated\` instead. Recreate it: ${
        words.recreate(network, engine)
      }`;
  }
  return null;
}

/**
 * Why `network` cannot confine runs on `engine`, or null when it can (`internalNetworkProblem`
 * in the run network's words). Pure and exported: the launch, the host's boot check and `ryph
 * setup` all ask it.
 */
export function runNetworkProblem(
  network: string,
  state: InternalNetworkState | null,
  engine: DockerEngine,
): string | null {
  return internalNetworkProblem(network, state, engine, RUN_NETWORK_WORDS);
}

/**
 * The run network, made if it is missing — and REFUSED if it exists and cannot confine (see
 * `runNetworkProblem`). A run launched onto a network that leaks keeps its route while every log
 * line reads as confined, and a launch that fails naming the fix is worth infinitely more.
 *
 * `replaceIdle` is `ryph setup`'s: a network that cannot confine but that ryph made (it carries
 * `ryph.runs=1`) and that nothing but ryph's run gates is attached to — one an older ryph made
 * before isolation was required — is removed and made again, the gates with it. Never at launch:
 * there, a refusal naming the fix is the answer.
 */
export async function ensureRunNetwork(
  network: string,
  exec: DockerExec = docker,
  opts: { replaceIdle?: boolean } = {},
): Promise<DockerEngine> {
  const engine = await dockerEngine(exec);
  const state = await inspectInternalNetwork(network, exec);
  const problem = runNetworkProblem(network, state, engine);
  if (problem !== null) {
    const fixable = opts.replaceIdle === true && state !== null &&
      runNetworkProblem(network, null, engine) === null;
    if (!fixable || !await replaceIdleRunNetwork(network, engine, exec)) throw new Error(problem);
    return engine;
  }
  if (state !== null) return engine;
  await exec(runNetworkCreateArgs(network, engine)).catch(async (err) => {
    // Another caller made it between the read and the create: the read again decides.
    const again = await inspectInternalNetwork(network, exec);
    if (again === null || runNetworkProblem(network, again, engine) !== null) throw err;
  });
  return engine;
}

/** `ensureRunNetwork`'s `replaceIdle`: true when the network was ryph's, idle, and is now remade
 * so that it confines. */
async function replaceIdleRunNetwork(
  network: string,
  engine: DockerEngine,
  exec: DockerExec,
): Promise<boolean> {
  const out = await exec([
    "network",
    "inspect",
    "-f",
    `{{index .Labels "ryph.runs"}}|{{range .Containers}}{{.Name}} {{end}}`,
    network,
  ]).catch(() => null);
  if (out === null) return false;
  const [label, names = ""] = out.split("|");
  if (label.trim() !== "1") return false;
  const attached = names.split(/\s+/).filter((n) => n !== "");
  const gates = new Set(
    (await exec(["ps", "-a", "--filter", `label=${GATE_LABEL}`, "--format", "{{.Names}}"])
      .catch(() => "")).split("\n").map((l) => l.trim()).filter((l) => l !== ""),
  );
  if (attached.some((name) => !gates.has(name))) return false;
  for (const gate of attached) await exec(["rm", "-f", gate]);
  await exec(["network", "rm", network]);
  await exec(runNetworkCreateArgs(network, engine));
  const again = await inspectInternalNetwork(network, exec);
  return again !== null && runNetworkProblem(network, again, engine) === null;
}

/** A gate remade or removed although confined containers were live behind it. */
export interface GateForced {
  gate: string;
  /** The containers whose connections through it dropped. */
  live: string[];
  /** Why it could not wait for them: `gateSecurityDrift`'s answer, or the cap. */
  why: string;
}

/** What `ensureGate` found, and what the launch it precedes needs to know. */
export interface GateReady {
  /** `deferred`: the gate drifted from `opts` but confined runs are live on it, so it was kept. */
  state: "current" | "created" | "deferred";
  /** Whether this engine isolates internal gateways, so the run's own networks are made so too. */
  isolateGateway: boolean;
  /** The confined containers that held a deferred recreate back. */
  live?: string[];
  /** `deferred`: how long this process has kept the gate out of date, in milliseconds. */
  deferredMs?: number;
  /** Gates that did NOT wait for their live runs — every one of them is worth a warning. */
  forced?: GateForced[];
}

/**
 * One lock per gate name, across EVERY caller in this process — the run provisioner, the check
 * launcher and the host's boot call alike. Two callers that both find the gate stale must not
 * both remove and recreate it: the second `rm -f` would take down the gate the first just made.
 */
const gateLocks = new Map<string, Promise<unknown>>();

/**
 * When this process first kept each drifted gate for its live runs, per docker (one for the real
 * CLI), by gate name — what the deferral cap is measured from. In memory on purpose: a restart
 * starts the clock again, which can only delay a recreate by one more cap.
 */
const keptSince = new WeakMap<DockerExec, Map<string, number>>();

function keptFor(exec: DockerExec): Map<string, number> {
  let kept = keptSince.get(exec);
  if (kept === undefined) keptSince.set(exec, kept = new Map());
  return kept;
}

const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * The run network and the gate, made or remade until both are what `opts` asks for. Idempotent
 * and cheap when nothing changed. Exported so the host can do it once at boot and say so, rather
 * than leave the first run to find out.
 *
 * A gate that has DRIFTED while confined runs are live behind it is kept for them, not remade:
 * removing it would cut every one of them off mid-run. It is remade by the first call that finds
 * none running — or once it has been kept for `GateOptions.deferCapMs`, so a deployment that is
 * never idle still gets its configuration. Drift that must not wait at all (`gateSecurityDrift`:
 * new gate code, a gate that forwards packets between its networks, a port taken away, a port
 * whose target moved) is remade at once. Every recreate that drops live runs comes
 * back in `forced`. A gate that is missing or stopped is always remade — nothing is going through
 * it. And a gate another deployment instance owns (`GateOptions.owner`) is never taken from under
 * its live runs: that is two deployments sharing a deployment id, and the launch fails naming the
 * fix rather than fight over it.
 *
 * Gates this owner made under another name — a renamed deployment's — are swept, by the same
 * rules: kept while runs are live behind them, unless their drift cannot wait.
 */
export function ensureGate(
  opts: DockerOptions,
  exec: DockerExec = docker,
  now: () => number = Date.now,
): Promise<GateReady> {
  const name = gateName(opts);
  const next = (gateLocks.get(name) ?? Promise.resolve()).then(() =>
    ensureGateNow(opts, exec, now())
  );
  const settled = next.catch(() => {});
  gateLocks.set(name, settled);
  settled.then(() => {
    if (gateLocks.get(name) === settled) gateLocks.delete(name);
  });
  return next;
}

function isConfinedBuilder(container: string): boolean {
  return container.startsWith(`buildx_buildkit_${CONFINED_BUILDER_PREFIX}`);
}

/** A recreate that dropped live containers, as each caller's warning says it: the runs and the
 * confined builds named apart, so a build's BuildKit is not taken for a run. */
export function gateForcedWarning(forced: GateForced) {
  return {
    gate: forced.gate,
    live: forced.live.filter((c) => !isConfinedBuilder(c)),
    builds: forced.live.filter(isConfinedBuilder),
    detail: `the run gate was replaced although confined containers were live behind it, ` +
      `because ${forced.why} — their open connections through it dropped`,
  };
}

/**
 * The containers live behind a gate: running on any INTERNAL network it is attached to, the gate
 * itself aside — a confined environment build's BuildKit among them, since a recreate takes its
 * proxy away mid-build as it does a run's — whichever run network they joined, so a run network renamed in configuration
 * still protects the runs on the old one. The gate's ordinary side does not count: nothing there
 * needs the gate. A network that cannot be read counts as internal, because "nobody there" is the
 * guess that cuts runs off.
 */
// oxlint-disable-next-line typescript/no-explicit-any
async function liveBehind(gate: any, name: string, exec: DockerExec): Promise<string[]> {
  const live = new Set<string>();
  for (const network of Object.keys(gate?.NetworkSettings?.Networks ?? {}).sort()) {
    const state = await inspectInternalNetwork(network, exec);
    if (state !== null && !state.internal) continue;
    const out = await exec(["ps", "--filter", `network=${network}`, "--format", "{{.Names}}"]);
    for (const container of out.split("\n").map((l) => l.trim())) {
      if (container !== "" && container !== name) live.add(container);
    }
  }
  return [...live];
}

/**
 * Whether a running gate with live runs behind it must go now — the reason — or is kept for them
 * (null). Starts the deferral clock for it on the first keep.
 */
function mustGoNow(
  name: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  gate: any,
  imageId: string,
  opts: DockerOptions,
  kept: Map<string, number>,
  now: number,
): string | null {
  const security = gateSecurityDrift(gate, imageId, opts);
  if (security !== null) return security;
  const since = kept.get(name) ?? now;
  kept.set(name, since);
  const cap = opts.gate!.deferCapMs ?? GATE_DEFER_CAP_MS;
  if (now - since < cap) return null;
  return `it has been kept out of date for live runs for ${minutes(now - since)}, past the ` +
    `${minutes(cap)} cap`;
}

// oxlint-disable-next-line typescript/no-explicit-any
function readInspect(json: string | null): any {
  if (json === null) return null;
  try {
    return inspected(json);
  } catch {
    return null;
  }
}

/**
 * An image's id, pulled first when docker's store does not have it: a published ref
 * (`quay.io/ryph/ryph-run-gate:…`, the binary's default) arrives on first use, as a run's image
 * does through `docker run`. A local tag no registry serves fails the pull too, and is named with
 * the task that builds it. `what` says whose image it is and what fails without it: the run
 * gate's here, the egress relay's in the launcher.
 */
export async function ensureImageId(
  image: string,
  exec: DockerExec,
  what: { image: string; without: string },
): Promise<string> {
  const inspect = () => exec(["image", "inspect", "-f", "{{.Id}}", image]);
  try {
    return await inspect();
  } catch {
    // Not here: pull it, then read it again.
  }
  try {
    await exec(["pull", "--quiet", image]);
    return await inspect();
  } catch (err) {
    throw new Error(
      `${what.image} ${image} is not in docker's store and could not be pulled ` +
        `(${err instanceof Error ? err.message.trim() : String(err)}), so ${what.without}. ` +
        "Pull it, or build it with `bun run agent-image`",
    );
  }
}

const gateImageId = (image: string, exec: DockerExec) =>
  ensureImageId(image, exec, {
    image: "the run gate image",
    without: "confined runs have no way to reach ryph",
  });

async function ensureGateNow(
  opts: DockerOptions,
  exec: DockerExec,
  now: number,
): Promise<GateReady> {
  if (!opts.runNetwork || !opts.gate) {
    throw new Error("ensureGate needs a run network and a gate image");
  }
  const engine = await ensureRunNetwork(opts.runNetwork, exec);
  const isolateGateway = engine.isolatedGateway;
  const name = gateName(opts);
  const imageId = await gateImageId(opts.gate.image, exec);
  const kept = keptFor(exec);
  const forced: GateForced[] = [];
  const done = (ready: GateReady): GateReady => forced.length > 0 ? { ...ready, forced } : ready;

  // Gates THIS owner made under any other name — a renamed deployment's — relay for nobody once
  // their runs are gone. Not for an ephemeral owner: every in-memory deployment is one, so the
  // label says nothing about whose gate it is.
  const owner = opts.gate.owner;
  if (owner !== undefined && owner !== EPHEMERAL_GATE_OWNER) {
    const strays = (await exec([
      "ps",
      "-a",
      "--filter",
      `label=${GATE_LABEL}`,
      "--filter",
      `label=${GATE_OWNER_LABEL}=${owner}`,
      "--format",
      "{{.Names}}",
    ]).catch(() => "")).split("\n").map((l) => l.trim()).filter((n) => n !== "" && n !== name);
    for (const stray of strays) {
      const gate = readInspect(
        await exec(["inspect", "--type", "container", stray]).catch(() => null),
      );
      if (gate?.State?.Running === true) {
        const live = await liveBehind(gate, stray, exec);
        if (live.length > 0) {
          const why = mustGoNow(stray, gate, imageId, opts, kept, now);
          if (why === null) continue;
          forced.push({ gate: stray, live, why });
        }
      }
      await exec(["rm", "-f", stray]).catch(() => {});
      kept.delete(stray);
    }
  }

  const inspect = () => exec(["inspect", "--type", "container", name]).catch(() => null);
  const existing = await inspect();
  if (existing !== null && gateCurrent(existing, imageId, opts)) {
    kept.delete(name);
    return done({ state: "current", isolateGateway });
  }

  const gate = readInspect(existing);
  if (gate?.State?.Running === true) {
    const live = await liveBehind(gate, name, exec);
    if (live.length > 0) {
      const owner = gate?.Config?.Labels?.[GATE_OWNER_LABEL];
      if (opts.gate.owner !== undefined && owner !== undefined && owner !== opts.gate.owner) {
        throw new Error(
          `the run gate ${name} is owned by ${owner}, not this deployment (${opts.gate.owner}), ` +
            `with ${live.length} confined container(s) live behind it — refusing to take it ` +
            `from under them. Either another ryph deployment on this docker daemon is on the same ` +
            `network (two deployments need their own RYPH_DOCKER_NETWORK), or a previous install of this deployment ` +
            `made the gate (a new database, a fresh launcher volume) and its runs are still ` +
            `live: let them finish, and the gate is remade once none are left.`,
        );
      }
      const why = mustGoNow(name, gate, imageId, opts, kept, now);
      if (why === null) {
        return done({
          state: "deferred",
          isolateGateway,
          live,
          deferredMs: now - kept.get(name)!,
        });
      }
      forced.push({ gate: name, live, why });
    }
  }

  try {
    await exec(["rm", "-f", name]).catch(() => {});
    await exec(gateArgs(opts));
    await exec(["network", "connect", opts.runNetwork, name]);
    await exec(["start", name]);
  } catch (err) {
    // Another PROCESS (a second replica, the CLI) may be remaking it too; this process's own
    // callers are serialised above. What decides is whether the gate is now right.
    const now = await inspect();
    if (now !== null && gateCurrent(now, imageId, opts)) {
      kept.delete(name);
      return done({ state: "current", isolateGateway });
    }
    throw err;
  }
  kept.delete(name);
  return done({ state: "created", isolateGateway });
}

type DockerExec = (args: string[], opts?: { signal?: AbortSignal }) => Promise<string>;

async function docker(args: string[], opts: { signal?: AbortSignal } = {}): Promise<string> {
  const { code, stdout, stderr } = await command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  }).output();
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${new TextDecoder().decode(stderr).trim()}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

/**
 * The uid:gid the browser container runs as: the run user every image we ship pins
 * (kubernetes.ts's DEFAULT_RUN_USER), which images/browser is built for. Pinned by number for the
 * same reason as there — the image's `USER` is the image's promise, and this is ours to keep.
 */
const BROWSER_USER = "1994:1994";

/** The browser container's name: one per run, beside `ryph-run-<id>` and `ryph-svc-<id>-*`. */
export function browserContainerName(runId: string): string {
  return `ryph-browser-${runId}`;
}

/** The run's own container: its name, and the name docker's DNS answers for it on a network. */
export function runContainerName(runId: string): string {
  return `ryph-run-${runId}`;
}

/**
 * The run's cancel endpoint, by the container's name on the port the runner's control API takes
 * (core/services.ts). Only the run id goes into it, and the control plane minted that, so the run
 * has no say in where its cancel is sent. It answers only where the caller shares a docker network
 * with the run — a control plane in compose beside unconfined runs; from the host, or toward a
 * confined run, the name does not resolve and the push fails as it always has, leaving the cancel
 * to the heartbeat's answer.
 */
export function runControlUrl(runId: string): string {
  return `http://${runContainerName(runId)}:${RUNNER_CONTROL_PORT}/cancel`;
}

/** One network per run, named for it, so `docker network ls` reads as a list of live runs. */
export function networkName(runId: string): string {
  return `ryph-run-${runId}`;
}

/**
 * The flags a network a confined launch makes for itself needs, so it confines like the run
 * network: `--internal`, and no gateway on the host where the engine allows (see `ISOLATED_GATEWAY`).
 * Nothing on an unconfined deployment.
 */
export function confinedNetworkFlags(opts: DockerOptions): string[] {
  if (!opts.runNetwork) return [];
  return ["--internal", ...(opts.isolateGateway ? ISOLATED_GATEWAY : [])];
}

/**
 * The `docker network create` argv for a run's services. Pure and exported for the test: on a
 * confined deployment it is `--internal`, or the services network would be the run's way out.
 */
export function serviceNetworkArgs(runId: string, opts: DockerOptions): string[] {
  return [
    "network",
    "create",
    ...confinedNetworkFlags(opts),
    "--label",
    `${RUN_LABEL}=${runId}`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
    networkName(runId),
  ];
}

/**
 * The `docker run` argv for one launch. Pure, and exported for the test: this argv *is* the
 * contract between the orchestrator and the container, so it is the thing worth pinning.
 *
 * `verb` is `["run", "-d"]` for the ordinary single-shot launch and `["create"]` when the run
 * has services and must be attached to a second network before it starts. Everything else is
 * identical between the two, which is the point: the services path adds steps, never variants.
 */
export function launchArgs(
  spec: LaunchSpec,
  opts: DockerOptions,
  verb: string[] = ["run", "-d"],
): string[] {
  if (spec.image === null) {
    throw new Error(
      "no agent-container image configured (set RYPH_AGENT_IMAGE)",
    );
  }
  const args = [
    ...verb,
    "--name",
    runContainerName(spec.runId),
    "--label",
    `${RUN_LABEL}=${spec.runId}`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
    // No capability and no privilege to gain, as on Kubernetes (kubernetes.ts's runnerSecurity):
    // the runner needs neither, and the image's USER is the run user, so these only matter for an
    // image that forgot one — which is exactly when they matter most.
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  if (opts.runtime) args.push("--runtime", opts.runtime);
  // The size class, as far as docker can express it: cores and a memory cap. Disk has no
  // portable flag (`--storage-opt size=` works on one storage driver, and fails the launch on
  // the rest), so ephemeral-storage and work-volume are said once by the adapter, not applied.
  if (spec.size.cpu !== null) args.push("--cpus", String(quantityCores(spec.size.cpu)));
  if (spec.size.memory !== null) args.push("--memory", `${memoryMebibytes(spec.size.memory)}m`);
  if (opts.runNetwork) {
    // Confined: the internal network and nothing else, and no name for the host — the gate is
    // the run's one way to ryph. Never both networks: a run attached to the internal network AND
    // an ordinary one takes its route from the ordinary one, and the confinement reads as
    // configured while enforcing nothing.
    args.push("--network", opts.runNetwork);
  } else {
    // Docker Desktop publishes `host.docker.internal` for free; a native Linux daemon does not,
    // so the address the orchestrator hands its runners (RYPH_PUBLIC_URL and friends) is a name
    // that resolves on a laptop and NXDOMAINs on a server — a run that boots, cannot fetch its
    // work item, and fails a long way from the cause. Mapping it explicitly makes the one name
    // true everywhere; on Desktop it is a redundant alias for what is already there, verified
    // rather than assumed.
    args.push("--add-host", "host.docker.internal:host-gateway");
    if (opts.network) args.push("--network", opts.network);
  }
  for (const [key, value] of Object.entries(spec.env)) args.push("-e", `${key}=${value}`);
  args.push(spec.image);
  return args;
}

/**
 * The `docker run` argv for one service container. Pure and exported, for launchArgs's reason.
 *
 * The confinement here is not the agent's. `--cap-drop ALL` alone breaks both postgres and redis
 * at entrypoint (measured: each drops privileges as root and needs SETUID/SETGID to do it, and
 * redis additionally needs SETPCAP because it uses `setpriv`, which shrinks the bounding set).
 * Leaving the runtime default instead would hand a repo-chosen image CAP_NET_RAW — so the
 * capability set is the catalogue's, added back one at a time on top of ALL dropped. That
 * per-image knowledge is the entire reason a catalogue exists; see core/services.ts.
 */
export function serviceArgs(runId: string, service: ServiceSpec, opts: DockerOptions): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    `ryph-svc-${runId}-${service.name}`,
    "--label",
    `${RUN_LABEL}=${runId}`,
    "--label",
    `${ROLE_LABEL}=service`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
    "--network",
    networkName(runId),
    // THE CONTRACT: the declared name is the hostname. `localhost` is not offered, on any
    // backend, so a repo cannot go green here and fail on Kubernetes or the reverse.
    "--network-alias",
    service.name,
    // A service that dies has failed; restarting it under the run would hide the failure behind
    // a health gate that eventually passes.
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
  ];
  // The SAME boundary the agent gets. A service is a repo-chosen image running a repo-supplied
  // `command`, so a deployment that asked for `runsc` or Kata and got the default shared-kernel
  // runtime here would have exactly the hole `--runtime` exists to close — on the container it
  // has the least reason to trust.
  if (opts.runtime) args.push("--runtime", opts.runtime);
  for (const cap of service.security.capabilities) args.push("--cap-add", cap);
  args.push("--security-opt", "no-new-privileges");
  args.push("--memory", service.resources.memory, "--cpus", service.resources.cpus);
  for (const [key, value] of Object.entries(service.env)) args.push("-e", `${key}=${value}`);
  args.push(service.image);
  if (service.command) args.push(...service.command);
  return args;
}

/**
 * The `docker run` argv for the browser sidecar, in the namespace of the agent container `agent`
 * (its id or name). Pure and exported, for launchArgs's reason.
 *
 * The agent's confinement, not a service's: no capability added back, no privilege to gain, the
 * run user, the same runtime. `--network container:` refuses `--add-host`, `--network-alias` and
 * any second network, and the browser needs none of them — it reaches what the agent reaches, by
 * the agent's own /etc/hosts. `--shm-size` because docker's 64 MiB /dev/shm is what Chromium's
 * renderers share frames through, and running out of it crashes tabs rather than slowing them.
 */
export function browserArgs(
  runId: string,
  agent: string,
  browser: BrowserLaunch,
  opts: DockerOptions,
): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    browserContainerName(runId),
    "--label",
    `${RUN_LABEL}=${runId}`,
    "--label",
    `${ROLE_LABEL}=browser`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
    "--network",
    `container:${agent}`,
    "--user",
    BROWSER_USER,
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--shm-size",
    "256m",
  ];
  // The sandbox policy, the one env var it gets. Under runc (no `--runtime`), docker's default
  // seccomp profile refuses the user namespace Chromium's sandbox needs, so `off` says so up front
  // rather than have every launch try and fall back. Under a runtime of the operator's choosing
  // (runsc, kata) it is left to the sidecar to try, then fall back.
  if (opts.runtime) args.push("--runtime", opts.runtime);
  else args.push("--env", "RYPH_BROWSER_SANDBOX=off");
  if (browser.resources.cpu !== null) {
    args.push("--cpus", String(quantityCores(browser.resources.cpu)));
  }
  if (browser.resources.memory !== null) {
    args.push("--memory", `${memoryMebibytes(browser.resources.memory)}m`);
  }
  args.push(browser.image);
  return args;
}

/** Runtime absence is evidence of exit; a failed inspection is not. */
export async function inspectContainer(
  handle: string,
  exec: DockerExec = docker,
): Promise<"running" | "exited" | "unknown"> {
  try {
    const status = await exec(["inspect", "-f", "{{.State.Status}}", handle]);
    if (status === "running" || status === "restarting" || status === "created") {
      return "running";
    }
    if (status === "exited" || status === "dead") return "exited";
    return "unknown";
  } catch (err) {
    if (/No such (container|object)/i.test(String(err))) return "exited";
    return "unknown"; // an unavailable daemon does not prove the container is gone
  }
}

/**
 * Whether `handle` names a run container THIS deployment launched (`ours`), a container that is
 * someone else's (`foreign`: no run label, or another deployment's), none at all (`absent`), or
 * cannot be told (`unknown`: docker did not answer). The docker launcher asks before it stops a
 * container on a caller's word, so a caller holding the launcher's token can stop runs and
 * nothing else on the daemon.
 */
export async function runContainerOwnership(
  handle: string,
  opts: Pick<DockerOptions, "network">,
  exec: DockerExec = docker,
): Promise<"ours" | "foreign" | "absent" | "unknown"> {
  let out: string;
  try {
    // `--type container`: a name may also be an image's or a network's, whose labels say nothing.
    out = await exec([
      "inspect",
      "--type",
      "container",
      "-f",
      `{{index .Config.Labels "${RUN_LABEL}"}}|{{index .Config.Labels "${DEPLOYMENT_LABEL}"}}`,
      handle,
    ]);
  } catch (err) {
    return /No such (container|object)/i.test(String(err)) ? "absent" : "unknown";
  }
  const [runId = "", deployment = ""] = out.split("|").map((v) => v === "<no value>" ? "" : v);
  return runId !== "" && deployment === deploymentId(opts) ? "ours" : "foreign";
}

export function dockerProvisioner(
  opts: DockerOptions,
  diag: Diagnostics,
  exec: DockerExec = docker,
): Provisioner {
  const imagePrefix = localImagePrefix(deploymentId(opts));
  /**
   * The spec with every image it names pinned to the one docker will use (`ownImageRef`): a local
   * image by its resolved id, so no retag between this judgement and the launch can swap it, and a
   * registry reference as it is, pulled by `docker run` as before. The spec's images are the
   * caller's word, and on a shared daemon another deployment's environment images sit in the same
   * store, reachable by more spellings than any check of the name can follow; so whose an image is
   * is read off the image docker resolves. The run's own image, absent or another deployment's,
   * answers `ImageGone`, which the core meets by building the environment again — from this
   * deployment's view the image is not there; a service's or the browser's is an ordinary
   * refusal, worded the same.
   */
  const pinImages = async (spec: LaunchSpec): Promise<LaunchSpec> => {
    const pin = (image: string) => ownImageRef(image, imagePrefix, (args) => exec(args));
    let image = spec.image;
    if (image !== null) {
      const pinned = await pin(image);
      if (pinned === null) throw new ImageGone(notOwnImage(image));
      image = pinned;
    }
    const other = async (ref: string) => {
      const pinned = await pin(ref);
      if (pinned === null) throw new Error(`${notOwnImage(ref)}; not launched`);
      return pinned;
    };
    const services = spec.services === undefined ? undefined : await Promise.all(
      spec.services.map(async (service) => ({ ...service, image: await other(service.image) })),
    );
    const browser = spec.browser
      ? { ...spec.browser, image: await other(spec.browser.image) }
      : spec.browser;
    return {
      ...spec,
      image,
      ...(services === undefined ? {} : { services }),
      ...(spec.browser === undefined ? {} : { browser }),
    };
  };

  /** This deployment's objects of one run, as `docker ps` and `docker network ls` filter them. */
  const ofRun = (runId: string) => [
    "--filter",
    `label=${RUN_LABEL}=${runId}`,
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
  ];

  /**
   * Everything a run's services and browser occupy, removed in the order the daemon accepts. Found
   * by this deployment's labels and never by name: a run id is the caller's word, and another
   * deployment on the same daemon may have a run, and so a `ryph-run-<id>` network, by that id.
   */
  const teardown = async (runId: string): Promise<void> => {
    // Any role: the services and the browser carry one, the agent container none.
    const ids = await exec(["ps", "-aq", ...ofRun(runId), "--filter", `label=${ROLE_LABEL}`]);
    // `-v`: an image that declares a VOLUME (postgres does) leaves an anonymous one behind.
    for (const id of ids.split("\n").filter((line) => line !== "")) {
      await exec(["rm", "-fv", id]).catch((err) =>
        diag.warn("docker.service_rm_failed", { runId, id, err: String(err) })
      );
    }
    // Only after the containers: a network with a RUNNING container attached cannot be removed
    // (a stopped one can — measured).
    const networks = await exec(["network", "ls", "-q", ...ofRun(runId)]);
    for (const id of networks.split("\n").filter((line) => line !== "")) {
      await exec(["network", "rm", id]).catch((err) => {
        if (!/not found|No such network/i.test(String(err))) {
          diag.warn("docker.network_rm_failed", { runId, err: String(err) });
        }
      });
    }
  };

  /** Removes the container `name` when it is one of this deployment's runs' (`runContainerOwnership`),
   * and leaves it otherwise: a container name is the daemon's, so it may be another deployment's. */
  const removeOwn = async (name: string): Promise<void> => {
    if (await runContainerOwnership(name, opts, exec) === "ours") {
      await exec(["rm", "-f", name]).catch(() => {});
    }
  };

  // Said once per process, not per run: a boot-time posture, and a line per launch would be
  // noise an operator learns to scroll past.
  let warnedEgress = false;
  // Once per class, for the same reason: which of a class's fields this backend leaves alone.
  const narratedSizes = new Set<string>();

  /**
   * The browser, in the namespace of the agent container just started. Never fatal: a run whose
   * browser would not start still has everything it was asked to do, and its runner says the
   * browser failed after its wait. Whatever half-started is removed so a retry-free run leaves
   * nothing behind; the reconcile sweeps it anyway once the run ends.
   */
  /**
   * The gate, checked before every confined launch (`ensureGate` serialises every caller in the
   * process). A failure fails the launch, naming why — a confined run with no gate could reach
   * nothing, not even its own work item. Answers the options this launch's own networks use.
   */
  const gateReady = async (runId: string): Promise<DockerOptions> => {
    const ready = await ensureGate(opts, exec);
    for (const forced of ready.forced ?? []) {
      diag.warn("docker.gate_recreated_under_live_runs", { runId, ...gateForcedWarning(forced) });
    }
    if (ready.state === "created") {
      diag.debug("docker.gate_created", {
        gate: gateName(opts),
        runNetwork: opts.runNetwork,
        routes: opts.gate?.routes.map((r) => `${r.listen}=${destination(r)}`),
      });
    } else if (ready.state === "deferred") {
      diag.warn("docker.gate_recreate_deferred", {
        runId,
        gate: gateName(opts),
        live: ready.live,
        deferredMs: ready.deferredMs,
        detail: "the run gate no longer matches this deployment's configuration, but confined " +
          "runs are live behind it and removing it would cut them off — it is remade on the " +
          "first launch that finds none running, or once it has waited out the cap. Until " +
          "then runs use the gate as it is.",
      });
    }
    return { ...opts, isolateGateway: ready.isolateGateway };
  };

  const startBrowser = async (spec: LaunchSpec, agent: string): Promise<void> => {
    if (!spec.browser) return;
    try {
      await exec(browserArgs(spec.runId, agent, spec.browser, opts));
    } catch (err) {
      diag.warn("docker.browser_failed", { runId: spec.runId, err: String(err) });
      await removeOwn(browserContainerName(spec.runId));
    }
  };

  const launchContainers = async (spec: LaunchSpec): Promise<{ handle: string }> => {
    const services = spec.services ?? [];
    const unapplied = unappliedSizeFields(spec.size, ["cpu", "memory"]);
    if (unapplied.length > 0 && !narratedSizes.has(spec.size.name)) {
      narratedSizes.add(spec.size.name);
      diag.debug("docker.size_partially_applied", {
        sizeClass: spec.size.name,
        unapplied,
        detail: "docker caps cpu and memory; a container's disk is the daemon's to size",
      });
    }
    if (spec.deadlineSeconds !== undefined) {
      diag.debug("docker.deadline_unsupported", {
        runId: spec.runId,
        deadlineSeconds: spec.deadlineSeconds,
        detail: "docker has no run deadline; the reaper enforces the wall clock alone",
      });
    }
    const launchOpts = opts.runNetwork ? await gateReady(spec.runId) : opts;
    if (spec.env.RYPH_EGRESS_PROXY !== undefined && !warnedEgress && !opts.runNetwork) {
      warnedEgress = true;
      diag.warn("docker.egress_not_enforced", {
        proxy: spec.env.RYPH_EGRESS_PROXY,
        detail: "runs are handed an egress proxy and an allowlist, and the runner uses them " +
          "for setup steps — but nothing holds a run to them: a container here keeps its " +
          "default route and can reach the internet around the proxy. Set " +
          "RYPH_DOCKER_RUN_NETWORK (answer `confined` in `ryph setup`) to put runs on an " +
          "internal network whose only way out is the run gate.",
      });
    }
    if (services.length === 0) {
      // Unchanged, deliberately: one command, one round trip, no new failure modes for the
      // run that declares nothing.
      const handle = await exec(launchArgs(spec, opts));
      await startBrowser(spec, handle);
      diag.debug("docker.launched", {
        runId: spec.runId,
        image: spec.image,
        runtime: opts.runtime ?? "default",
        browser: spec.browser ? true : undefined,
        handle,
      });
      return { handle };
    }

    /** The agent container this attempt created, once it has. */
    let created: string | null = null;
    try {
      await exec(serviceNetworkArgs(spec.runId, launchOpts));
      for (const service of services) {
        await exec(serviceArgs(spec.runId, service, opts));
      }
      // Created, not started: the agent joins the run network before its first instruction
      // runs, so it can never observe a half-attached world.
      const handle = await exec(launchArgs(spec, opts, ["create"]));
      created = handle;
      await exec(["network", "connect", networkName(spec.runId), handle]);
      await exec(["start", handle]);
      await startBrowser(spec, handle);
      diag.debug("docker.launched", {
        runId: spec.runId,
        image: spec.image,
        runtime: opts.runtime ?? "default",
        services: services.map((s) => `${s.name}:${s.port}`),
        browser: spec.browser ? true : undefined,
        handle,
      });
      return { handle };
    } catch (err) {
      // A half-built run leaves a network behind, and the pool it comes from is small and
      // never refilled. Take down whatever was made before rethrowing — the same posture the
      // kubernetes adapter takes when its Secret write fails.
      // The agent this attempt made, by its id; with none, one an earlier attempt left under the
      // name, only when it is this deployment's — a `create` refused over the name may be refused
      // over another deployment's container.
      if (created !== null) await exec(["rm", "-f", created]).catch(() => {});
      else await removeOwn(runContainerName(spec.runId));
      await teardown(spec.runId).catch((cleanupErr) =>
        diag.warn("docker.launch_cleanup_failed", {
          runId: spec.runId,
          err: String(cleanupErr),
        })
      );
      throw err;
    }
  };

  return {
    supportsBrowser: true,
    controlUrl: (run) => runControlUrl(run.id),

    async launch(asked: LaunchSpec) {
      const spec = await pinImages(asked);
      try {
        return await launchContainers(spec);
      } catch (err) {
        // A docker-built environment's image, gone from the store between the judgement and the
        // launch (a prune, a daemon reset): the daemon's own word about the id it was handed, the
        // same evidence a check launch reads, so the core can retire the build rather than launch
        // every run onto it.
        if (
          spec.image !== null && localOnlyImage(spec.image) && daemonLacksImage(err, spec.image)
        ) {
          throw new ImageGone(notOwnImage(asked.image ?? spec.image));
        }
        throw err;
      }
    },

    async kill(handle, { graceful }) {
      // The run id off the container's own label, so the handle stays what it always was (a
      // container id) and services need no second handle format. A container already gone
      // takes its services' cleanup with it — reconcile at boot AND on every sweep is the
      // backstop for exactly that, reclaiming its labelled services once the run is terminal.
      // `--type container`: a name may also be an image's, whose labels would name a run too.
      const runId = await exec([
        "inspect",
        "--type",
        "container",
        "-f",
        `{{index .Config.Labels "${RUN_LABEL}"}}`,
        handle,
      ]).catch(() => "");
      try {
        if (graceful) {
          await exec(["stop", "-t", String(opts.stopGraceSeconds ?? 30), handle]);
        } else {
          await exec(["kill", handle]);
        }
      } catch (err) {
        // An already-dead or already-removed container is the outcome kill wants. docker offers no
        // exit code for it — only this message — and an unrecognized error rethrows (fail-safe), so
        // a real fault still makes the reaper retry rather than orphan a live container.
        if (!/is not running|No such container/i.test(String(err))) throw err;
      }
      // After the agent, always: the services exist for it and nothing else may reach them.
      // Best-effort, because a failure here must not stop the reaper concluding the run.
      if (runId !== "") {
        await teardown(runId).catch((err) =>
          diag.warn("docker.teardown_failed", { runId, err: String(err) })
        );
      }
    },

    inspect: (handle) => inspectContainer(handle, exec),
  };
}

/**
 * The containers and run networks of runs the store no longer considers active, removed.
 * Called at boot and then on every reaper tick.
 *
 * Deliberately NOT on the `Provisioner` port — the composition root knows which adapter it
 * built, and no other backend has this problem (a Kubernetes Job cascades). The framing is
 * @ryph/mcp-gateway's hosting reconcile: the row is application truth, the container runtime is
 * infrastructure truth, and this is where they meet.
 *
 * It is the PRIMARY reclaim path, not a backstop, and that is worth being explicit about
 * because the obvious reading is wrong. `kill` reaches a run that was marked lost or cancelled.
 * A run that succeeds is never killed: the runner reports, the row goes terminal, the run drops
 * out of the active set, and its containers are simply still there. So the happy path is the
 * leaking path, and this is what closes it. The launch `catch` handles a failure mid-sequence.
 *
 * The one case neither covers promptly is a crash between `network create` and storing the
 * handle: the row exists and is `starting`, so it is ACTIVE, so this deliberately leaves its
 * network alone — it cannot tell that network from one whose run is booting normally. That
 * orphan waits out the reaper's startup grace (600 s by default), gets marked lost, leaves the
 * active set, and is reclaimed on the tick after. Late, not permanent, and the alternative —
 * reclaiming networks belonging to active runs — would tear down runs that are merely slow to
 * boot.
 *
 * Agent containers go too, once they have EXITED. The run's transcript lives in the history
 * store, so a stopped container only repeats it, and on a laptop they pile up by the dozen. A
 * terminal run's agent can still be running: the runner reports first and flushes its last
 * transcript batch on the way out, so removing it then would cut the tail. It is reclaimed on
 * the tick after it exits. An agent launched before it carried the deployment label is never
 * listed, and stays until removed by hand.
 *
 * ORDER is the correctness argument, because launches run concurrently with this. The runtime
 * is enumerated first and the store read second: a run's row is written before its launch
 * creates anything, so every object the enumeration saw belongs to a run the later read names.
 * The other way round, a launch landing between the two reads would be reclaimed mid-boot.
 */
export async function reclaimOrphans(
  opts: DockerOptions,
  listActiveRunIds: () => Promise<Iterable<string>>,
  diag: Diagnostics,
  exec: (args: string[]) => Promise<string> = docker,
): Promise<{ containers: number; networks: number }> {
  let candidates: OrphanCandidates;
  try {
    candidates = await listOrphanCandidates(opts, exec);
  } catch (err) {
    // Never fatal at boot. A deployment that cannot reconcile should still serve; it will hit
    // the pool ceiling eventually, and this line is what explains it when it does.
    diag.warn("docker.reclaim_failed", { err: String(err) });
    return { containers: 0, networks: 0 };
  }
  // Only now — see the doc comment on why this read must follow both listings.
  let active: Iterable<string>;
  try {
    active = await listActiveRunIds();
  } catch (err) {
    diag.warn("docker.reclaim_failed", { err: String(err) });
    return { containers: 0, networks: 0 };
  }
  return reclaimCandidates(candidates, active, diag, exec);
}

/**
 * What `reclaimOrphans` may remove, as the runtime holds it right now: every container and run
 * network this deployment labelled. The FIRST half of the reconcile, split out so it can cross a
 * process boundary (the docker launcher answers it on one request and reclaims on the next, with
 * the caller's store read in between) without the order — runtime first, store second — being
 * anyone's to get wrong. Throws when docker does not answer.
 */
export interface OrphanCandidates {
  containers: Array<{ id: string; runId: string; role: string; state: string }>;
  networks: Array<{ id: string; runId: string }>;
}

export async function listOrphanCandidates(
  opts: DockerOptions,
  exec: (args: string[]) => Promise<string> = docker,
): Promise<OrphanCandidates> {
  const deployment = deploymentId(opts);
  const list = async (args: string[]): Promise<string[][]> => {
    const out = await exec(args);
    return out.split("\n").filter((line) => line.trim() !== "").map((line) => line.split("\t"));
  };
  // Every container of a run: services, browsers and the agent.
  const containers = await list([
    "ps",
    "-a",
    "--filter",
    `label=${RUN_LABEL}`,
    // Ours only. Another deployment against this daemon has its own store and its own active
    // set, and its live runs are not this one's orphans.
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deployment}`,
    "--format",
    `{{.ID}}\t{{.Label "${RUN_LABEL}"}}\t{{.Label "${ROLE_LABEL}"}}\t{{.State}}`,
  ]);
  const networks = await list([
    "network",
    "ls",
    "--filter",
    `label=${RUN_LABEL}`,
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deployment}`,
    "--format",
    `{{.ID}}\t{{.Label "${RUN_LABEL}"}}`,
  ]);
  return {
    containers: containers.map(([id, runId = "", role = "", state = ""]) => ({
      id,
      runId,
      role,
      state,
    })),
    networks: networks.map(([id, runId = ""]) => ({ id, runId })),
  };
}

/**
 * The SECOND half: removes the listed candidates whose run is not in `active`, which the caller
 * read after the listing. Never throws; one object docker will not remove is warned about and
 * the rest still go.
 */
export async function reclaimCandidates(
  candidates: OrphanCandidates,
  activeRunIds: Iterable<string>,
  diag: Diagnostics,
  exec: (args: string[]) => Promise<string> = docker,
): Promise<{ containers: number; networks: number }> {
  const reclaimed = { containers: 0, networks: 0 };
  const active = new Set(activeRunIds);
  // Per object, not per pass: one container docker will not remove, or one network with an
  // endpoint stuck on it, must not starve every orphan listed after it — tick after tick, until
  // the pool is exhausted by leftovers that were each perfectly removable.
  const remove = async (
    kind: "container" | "network",
    id: string,
    runId: string,
    args: string[],
  ) => {
    try {
      await exec(args);
      return true;
    } catch (err) {
      diag.warn("docker.reclaim_object_failed", { kind, id, runId, err: String(err) });
      return false;
    }
  };
  for (const { id, runId, role, state } of candidates.containers) {
    if (active.has(runId)) continue;
    // An agent still running is still flushing; see `reclaimOrphans`.
    if (role === "" && state === "running") continue;
    if (await remove("container", id, runId, ["rm", "-fv", id])) reclaimed.containers++;
  }
  // An exited agent container this pass could not remove still names this network, which does
  // not block the removal: an EXITED container holds no endpoint (`network inspect` counts zero),
  // so `network rm` succeeds. Measured, docker engine 29.4. Only a RUNNING container blocks it,
  // and that warns and is retried on the next tick.
  for (const { id, runId } of candidates.networks) {
    if (active.has(runId)) continue;
    if (await remove("network", id, runId, ["network", "rm", id])) reclaimed.networks++;
  }
  if (reclaimed.containers > 0 || reclaimed.networks > 0) {
    diag.debug("docker.reclaimed", reclaimed);
  }
  return reclaimed;
}
