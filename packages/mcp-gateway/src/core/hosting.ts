// A hosted server's life: the gateway launching a vendor's MCP container on the tools network,
// fronting it with the tool guard, and keeping the row honest about whether it answers.
//
//   create → seal → launch → probe until healthy (≤ startupTimeoutMs) → healthy
//   healthy → unreachable after three failed supervisor probes
//   unreachable → starting again on Restart, or on the supervisor's backoff (30 s → 10 min)
//   archive → stop · remove → stopped
//   process exit → every container and the guard removed, rows untouched → relaunched at boot
//
// The mechanics each state change rests on:
// - the ROW is application truth and the CONTAINER RUNTIME is infrastructure truth, reconciled
//   at boot — the reaper's pattern, for the reaper's reason. Every hosted row that is not
//   stopped is relaunched — its caller token, egress claim and route lived and died with the
//   previous gateway process — and every container no live row's current launch key names is
//   removed, at boot and on every supervisor tick (`sweep`). A clean exit removes them all
//   (`shutdown`), so what boot finds running is what a crash left behind.
// - the TOOL GUARD is launched at boot with a token minted there and kept in this process's
//   memory only; it rotates on every boot, is never written down, and rides every forward and
//   probe (see core/tool_guard.ts). The guard is relaunched whenever its route table changes —
//   a launch landed, or a server stopped.
// - a hosted row's stored URL is a marker nobody dials (`hosted://<slug>`).
// - a crash is a STATUS, not a loop: containers run with no restart policy, and only the
//   supervisor relaunches, on a doubling backoff, so a misconfigured server reads "unreachable ·
//   see logs" instead of pinning a CPU. A bad CREDENTIAL is not a crash: a probe that finds it
//   unopenable or refused upstream leaves the container healthy and routed, with the reason on
//   the row, since a relaunch cannot fix what only an admin re-entering it can.
// - a CALLER TOKEN — for every row but a catalogue entry that opted out with a reviewed reason —
//   is minted per launch, handed to the container's env and to the guard's, and presented by the
//   guard on every forward: the server itself then refuses a caller who reached it around the
//   guard. Defence in depth now that the tools network confines on both backends (internal under
//   docker, NetworkPolicy under Kubernetes): what can still reach a hosted server's address there
//   is ANOTHER hosted server on the same network, and under OrbStack, whose networks do not
//   isolate (measured), a run. It is not the operator's credential: it opens this one container,
//   and the container already holds it.
// - an EGRESS CLAIM, where the tool host confines and offers a way out (`ToolHost.egressProxy`:
//   the docker launcher's egress relay), is minted per launch too (core/tool_egress.ts) and rides
//   the vendor container's proxy env — never the guard's, which dials only the tools network. It
//   opens the public internet through the egress proxy and nothing private. The key may be one
//   this process minted at boot (the binary), so every row is relaunched at boot for a claim the
//   proxy still honours, rather than kept running on one that died with the last process.
// - the credential is not involved in launching. A hosted container is launched with its
//   settings and never its credential, so rotation is a row write and nothing here reacts to it.
//   Where the credential is SENT is addressing, not bookkeeping: every launch is named by its
//   LAUNCH KEY (core/sealing.ts `launchKey`: 128 bits of a hash over the row's id, its credential
//   binding, the image digest it runs and a custom image's caller-auth env var), the container is
//   `ryph-tool-<key>`, the guard routes `/<key>/mcp` to that name and no other, and the data plane
//   computes the key from the row as it stands right before it dials. Nothing else ever runs under that name (the launchers refuse any
//   other shape), so a credential reaches a container launched from exactly the inputs it is bound
//   to or nothing at all — whatever a database writer edits, reverts or swaps, and however launches
//   race. The route table below is only for saying WHY a dial is refused (`hosted_starting`,
//   `hosted_stale`, `hosted_not_running`); it carries no safety.
// - ONE PROCESS ACTS AT A TIME: the holder of the hosting lease (core/lease.ts). Every call that
//   changes what runs — a launch, a stop, the guard's relaunch, the shutdown sweep — is refused by
//   a process that does not hold it at that moment. Boot waits for the lease, and a clean shutdown
//   releases it only after its sweep, so where two gateways overlap (every rolling update and
//   eviction on Kubernetes) the arriving one launches after the departing one has finished
//   removing, never before. A process that loses the lease stops acting, sweeps nothing — what
//   runs is a successor's now — and asks the composition root to restart it. Where only one
//   gateway can exist the lease is SOLE_GATEWAY, held always.
//
// Pure given its ports: the ToolHost, the store, the catalogue, and a probe are all injected, so
// every transition is tested against a fake host with no container runtime anywhere.

import { mintToken } from "@ryph/sealed";
import { atDigest, callerAuthEnvOf, digestOf, launchOf } from "./catalogue.ts";
import { toolProxyEnv } from "./tool_egress.ts";
import { type HostingLease, SOLE_GATEWAY } from "./lease.ts";
import { HOSTED_STALE, type HostedRouteState, IMAGE_DIGEST, launchKey } from "./sealing.ts";
import {
  formatCallerTokens,
  formatGuardRoutes,
  guardLaunchSpec,
  type GuardRoute,
  TOOL_CONTAINER_NAME,
  TOOL_GUARD_TOKEN_HEADER,
  toolContainerName,
  type ToolGuardAccess,
} from "./tool_guard.ts";
import type { HostState, McpServer } from "./types.ts";
import type { Catalogue } from "../ports/catalogue.ts";
import type { GatewayStore } from "../ports/gateway_store.ts";
import type { ToolHost, ToolLaunchSpec } from "../ports/tool_host.ts";

export type HostingAvailability =
  | { available: true }
  | {
    available: false;
    reason: string;
    /**
     * A state this gateway leaves by itself — booting, waiting for the hosting lease, handing over
     * to a successor — rather than one only a person ends (no backend, a misconfiguration).
     */
    pending?: boolean;
  };

/**
 * Whether a hosted row with nothing routed for it will be, without anyone acting: a launch under
 * way or due (a boot, a backoff relaunch, a lease handover), or not (hosting off, the row
 * stopped, a launch that cannot be derived from the row).
 */
export type HostedOutlook = { coming: true } | { coming: false; reason: string };

/** Every line the lifecycle waits on, and the defaults a deployment starts with. */
export interface HostingLimits {
  /** A tool container's memory cap unless its catalogue entry says otherwise. */
  memory: string;
  /** A tool container's CPU cap unless its catalogue entry says otherwise. Whole CPUs, decimal
   * ("0.25") — see core/catalogue.ts, where the spelling has to satisfy three backends. */
  cpus: string;
  /** How long a fresh launch may take to answer `initialize` + `tools/list`. */
  startupTimeoutMs: number;
  /** How often a starting server is probed. */
  startupPollMs: number;
  /** Consecutive failed supervisor probes before a healthy server reads unreachable. */
  failuresBeforeUnreachable: number;
  /**
   * How many hosted servers may exist at once, archived ones aside. Each is a container with a
   * memory cap on the machine the control plane itself runs on, and creating one is a user
   * action, so the ceiling is a number rather than trust: without it a loop of creates (or a
   * stolen token) exhausts the host and takes the control plane down with it.
   */
  maxServers: number;
  /** The supervisor's first relaunch of an unreachable server waits this long… */
  backoffMinMs: number;
  /** …doubling on every failure, up to this. */
  backoffMaxMs: number;
}

export const DEFAULT_HOSTING_LIMITS: HostingLimits = {
  memory: "512m",
  // A quarter of a CPU, because an MCP server is idle between tool calls — it parses a small
  // JSON request, makes one upstream call, and waits. A whole CPU as the FLOOR for every vendor
  // container is a bill, not a safety margin: on a per-request-billed platform it is paid in
  // full whether or not a tool is ever called, and it is paid per server.
  //
  // It also drags memory up behind it. GKE Autopilot enforces a CPU:memory ratio of at least
  // 1:1, so "1" against this 512m was silently rewritten to 1Gi in the deployed object —
  // double the memory nobody asked for. At 0.25 the pair is 1:2 and survives untouched.
  //
  // An entry that genuinely needs more says so (`cpus` in its catalogue JSON). Raising the
  // floor for everyone to suit one entry is the trade backwards.
  cpus: "0.25",
  startupTimeoutMs: 60_000,
  startupPollMs: 2_000,
  // 16 × the default 512m is 8 GiB of tool containers — already more than most machines running
  // this want to give away, and far more hosted servers than a deployment has been seen to need.
  // A deployment that genuinely wants more says so (RYPH_TOOL_MAX_SERVERS).
  maxServers: 16,
  failuresBeforeUnreachable: 3,
  backoffMinMs: 30_000,
  backoffMaxMs: 10 * 60_000,
};

export const GUARD_NAME = "ryph-tool-guard";

/** Why a call that changes what runs was refused. */
const NOT_HOLDER =
  "this gateway does not hold the hosting lease — another one is managing hosted servers";
/** How a row records a stop that did not happen — which the next holder's boot finishes. */
const STOP_FAILED = "could not stop the container";

/**
 * The container a hosted row's CURRENT launch runs under: its launch key's name, from what the
 * row says now and the digest it names. Null for a row never launched (no digest yet).
 */
export async function currentContainer(server: McpServer): Promise<string | null> {
  const digest = server.host?.imageDigest ?? null;
  return digest === null ? null : toolContainerName(await launchKey(server, digest));
}

export interface HostingDeps {
  store: GatewayStore;
  host: ToolHost;
  catalogue: Catalogue;
  /**
   * Connects to a server the way the probe route does — through the guard, with its token and
   * the row's sealed headers — and says whether it answered. Injected because the probe is an
   * HTTP client, which the core does not import.
   */
  probe(server: McpServer): Promise<ProbeVerdict>;
  /**
   * The tool guard's image (`ryph-tool-guard:dev`), unless the backend names its own
   * (`ToolHost.guardImage`, the docker launcher's), which wins: it runs no other under that name.
   */
  guardImage?: string;
  /**
   * Mints a vendor container's egress claim (core/tool_egress.ts), for a tool host that hands one
   * a proxy (`ToolHost.egressProxy`). Required there: a host that confines and offers a way out
   * with no minter here is hosting that cannot reach any vendor's API, and boot says so instead.
   */
  toolEgress?: { mint(subject: string): Promise<string> };
  now(): Date;
  diag: {
    debug(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
  limits?: Partial<HostingLimits>;
  /**
   * Who may launch and stop: nothing that changes what runs goes out from a process not holding
   * this lease. Absent, the process is the only gateway there can be (compose, the single binary)
   * and holds it always. See core/lease.ts.
   */
  lease?: HostingLease;
  /** Called once, if a held lease is lost. The composition root restarts the process. */
  onLeaseLost?: () => void;
  /** The wait between startup probes; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HostingService {
  availability(): HostingAvailability;
  /** Where the guard is and its token — what the data plane and the probe add to a forward. */
  guard(): ToolGuardAccess | null;
  /**
   * The launch key this gateway has routed for a row, and whether the running guard serves it.
   * Null when nothing is. For the refusal's code only: the key the data plane dials is computed
   * from the row (core/sealing.ts `hostedDial`).
   */
  route(serverId: string): HostedRouteState | null;
  /** For a hosted row with nothing routed (`route` null): whether a launch is coming. */
  outlook(server: McpServer): HostedOutlook;
  /**
   * Whether a refused connection to this row's route is most likely a launch still coming up: a
   * guard relaunch is in flight, or the row's route was set or the guard relaunched within the
   * last `SETTLE_MS`. A heuristic — the guard's launch returns before it accepts connections (a
   * moment under docker; a pod start under Kubernetes, which can be longer) — for the code a
   * refusal carries, never for where anything is sent.
   */
  settling(serverId: string): boolean;
  /** Network, guard, reconcile. Never throws: a failure is recorded as unavailability. */
  boot(): Promise<void>;
  /**
   * (Re)launches a hosted row's container in the background and returns the row as it now
   * reads — `starting`. `updateImage` moves a catalogue row to the digest its entry pins today;
   * otherwise a relaunch keeps the digest the row was launched from.
   */
  launch(server: McpServer, opts?: { updateImage?: boolean }): Promise<McpServer>;
  /** Stops and removes the container and drops its route. The row reads `stopped`. */
  stop(server: McpServer): Promise<McpServer>;
  logs(server: McpServer, tail: number): Promise<string>;
  /** One supervisor tick: probe the healthy, relaunch the unreachable whose backoff is up. */
  supervise(): Promise<void>;
  /** What the row's catalogue entry pins today; null for custom rows. */
  latestDigest(server: McpServer): Promise<string | null>;
  /** Resolves once no background launch or wait is running — for tests. */
  idle(): Promise<void>;
  /** The hosted rows meant to be running — what `shutdown` will stop, for saying so first. */
  live(): Promise<McpServer[]>;
  /**
   * How many hosted servers this deployment has against how many it allows. Asked before a
   * create, because the answer is a container on the control plane's own machine.
   */
  capacity(): Promise<{ live: number; max: number }>;
  /**
   * For a clean exit: stops every hosted container and the guard, and touches no row — a row says
   * what should run, and the next boot relaunches it. Nothing they hold outlives this process (the
   * guard's token, a caller token), so a container left running would be relaunched at the next
   * boot regardless, and sit idle until then with nothing able to reach it. Launches still in
   * flight are superseded, and nothing launches after this. The hosting lease is released last, once
   * the sweep is done.
   */
  shutdown(): Promise<void>;
}

export type { HostedRouteState } from "./sealing.ts";

/** The stored url of a hosted row: a marker, never dialled (see the opening). */
export const hostedMarkerUrl = (slug: string) => `hosted://${slug}`;

/** What a probe of a hosted row answers, as the supervisor reads it (http/probe.ts). */
export type ProbeVerdict =
  | { ok: true }
  | {
    ok: false;
    reason?: string;
    detail: string;
    /** The data plane's refusal code, when the probe was refused for the row's routing. */
    code?: string;
  };

/**
 * A probe verdict about the CREDENTIAL, not the container (http/probe.ts): it is missing or will
 * not open (the probe reached the container without it first), or upstream refused it while the
 * row holds one. A relaunch changes neither; an admin entering the credential again does. A
 * refusal of a row holding NO credential is the container's own doing, and a relaunch's to fix.
 */
const credentialBad = (result: ProbeVerdict, server: McpServer): boolean =>
  !result.ok && (
    result.reason === "secret_required" ||
    (result.reason === "credential_rejected" && server.encryptedAuth !== null)
  );

/** A refusal of the route itself — nothing routed, or routed to another launch: relaunch now. */
const unroutedCode = (result: ProbeVerdict): string | null =>
  !result.ok && result.code !== undefined && result.code.startsWith("hosted_") ? result.code : null;

/**
 * A row's guard route: its launch's key, address and caller token, the container, and when the
 * guard began serving it (unset until then).
 */
type HostedRoute = GuardRoute & { serverId: string; container: string; routedAt?: number };

/** How long after a route is set, or the guard relaunched, a refused connection counts as a
 * launch still coming up (`settling`). A heuristic; see `settling`. */
export const SETTLE_MS = 10_000;

/** Why a launch cannot be derived from a row — the catalogue lost its entry, most likely. */
export class HostingError extends Error {
  override readonly name = "HostingError";
}

/** A HostingService for a deployment that cannot host: every question answers with the reason. */
export function unavailableHosting(reason: string): HostingService {
  const refuse = () => Promise.reject(new HostingError(reason));
  return {
    availability: () => ({ available: false, reason }),
    guard: () => null,
    route: () => null,
    outlook: () => ({ coming: false, reason }),
    settling: () => false,
    boot: () => Promise.resolve(),
    launch: refuse,
    stop: refuse,
    logs: refuse,
    supervise: () => Promise.resolve(),
    latestDigest: () => Promise.resolve(null),
    idle: () => Promise.resolve(),
    live: () => Promise.resolve([]),
    capacity: () => Promise.resolve({ live: 0, max: DEFAULT_HOSTING_LIMITS.maxServers }),
    shutdown: () => Promise.resolve(),
  };
}

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export function makeHosting(deps: HostingDeps): HostingService {
  const { store, host, catalogue, diag } = deps;
  // Per tools network under docker, so two deployments on one daemon keep a guard each.
  const guardName = host.guardName ?? GUARD_NAME;
  // The backend's own when it names one: the docker launcher runs no other image as the guard.
  const guardImage = host.guardImage ?? deps.guardImage ?? null;
  /** Where a vendor's container reaches the internet, with a claim minted per launch; null: the
   * backend hands no proxy (its network policy is the way out, or there is none). */
  const egressProxy = host.egressProxy ?? null;
  const limits: HostingLimits = { ...DEFAULT_HOSTING_LIMITS, ...deps.limits };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = () => deps.now().getTime();
  const lease = deps.lease ?? SOLE_GATEWAY;
  /** Aborted as shutdown begins: a boot still waiting for the lease stops waiting. */
  const waiting = new AbortController();
  /** Aborted once the shutdown sweep is done, just before the release: renewing stops. */
  const keeping = new AbortController();
  /** Set when a held lease was lost. From then on this process removes nothing, not even at exit. */
  let leaseLost = false;

  let availability: HostingAvailability = {
    available: false,
    reason: "hosting has not started yet",
    pending: true,
  };
  // One token per gateway process: minted at boot, handed to the guard's env, never stored.
  let token = mintToken();
  let access: ToolGuardAccess | null = null;
  /** The route table the running guard was launched with; null before the first launch. */
  let guardTable: string | null = null;
  /** The published host port, kept across guard relaunches so rows' URLs stay put. */
  let guardHostPort = 0;
  /** When the guard last (re)launched — every route's connections go through it. */
  let guardLaunchedAt = -Infinity;
  /** Guard relaunches in flight: the one being replaced may refuse connections meanwhile. */
  let guardRelaunching = 0;
  /** By server id: each row's current launch, as the guard routes it. */
  const routes = new Map<string, HostedRoute>();
  /** Every container this process launched and has not stopped — what `shutdown` removes. */
  const ours = new Set<string>();
  /** Bumped by every launch and stop, so a superseded background wait never writes. */
  const generation = new Map<string, number>();
  const failures = new Map<string, number>();
  const backoff = new Map<string, { attempts: number; nextAt: number }>();
  /** Rows whose launch cannot be derived from what they say (`HostingError`), and why. */
  const blocked = new Map<string, string>();
  const running = new Set<Promise<void>>();
  const busy = new Set<string>();
  /** The tools network exists — so there may be containers of ours to stop at shutdown. */
  let networkReady = false;
  /** Set by `shutdown`; nothing launches after it. */
  let closed = false;
  let guardQueue: Promise<void> = Promise.resolve();
  const launchQueues = new Map<string, Promise<unknown>>();

  const bump = (id: string): number => {
    const next = (generation.get(id) ?? 0) + 1;
    generation.set(id, next);
    return next;
  };
  const current = (id: string, gen: number) => generation.get(id) === gen;

  /** Background work, tracked so `idle()` can wait for it and the supervisor can skip its row. */
  const track = (id: string, work: () => Promise<void>) => {
    busy.add(id);
    const p = work()
      .catch((err) => diag.warn("hosting.background_failed", { serverId: id, err: describe(err) }))
      .finally(() => {
        running.delete(p);
        busy.delete(id);
      });
    running.add(p);
  };

  /** One backend call per container name at a time: a relaunch must not race a stop. */
  const serial = <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const prev = launchQueues.get(name) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    launchQueues.set(name, next);
    return next;
  };

  /**
   * A backend call that changes what runs: serialized per name like any other, and refused unless
   * this process holds the lease at the moment it would go out — after whatever it queued behind.
   */
  const mutate = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    serial(name, () => lease.held() ? work() : Promise.reject(new HostingError(NOT_HOLDER)));

  /**
   * Writes the host columns and nothing else — a concurrent rename, rotation or settings edit must
   * not be clobbered by a status flip.
   */
  const save = async (
    id: string,
    patch: Partial<HostState>,
    opts: { gen?: number; evenIfArchived?: boolean } = {},
  ): Promise<McpServer | null> => {
    if (opts.gen !== undefined && !current(id, opts.gen)) return null;
    const fresh = await store.getServer(id);
    if (fresh === null || fresh.kind !== "hosted") return null;
    if (fresh.archivedAt !== null && !opts.evenIfArchived) return null;
    const base: HostState = fresh.host ??
      { handle: null, status: "starting", imageDigest: null, startedAt: null, lastError: null };
    return await store.updateServer(id, {
      host: { ...base, ...patch },
      updatedAt: deps.now().toISOString(),
    });
  };

  /** What to launch for a row, from its catalogue entry or its custom image. */
  const targetFor = async (
    server: McpServer,
    updateImage: boolean,
  ): Promise<{ spec: ToolLaunchSpec; path: string; digest: string; callerEnv: string | null }> => {
    // Named by the key of exactly what is launched below: this row as read, at this digest.
    const named = async (digest: string) => toolContainerName(await launchKey(server, digest));
    if (server.custom !== null) {
      const { image, command, port, path, callerAuth } = server.custom;
      // No caller token, no launch. The tools network keeps runs out where the backend isolates
      // its networks, but not the other hosted servers on it, nor runs under OrbStack (measured),
      // so a custom image that authenticates nobody is one they reach directly — every tool it
      // has, outside any run's allowlist, with nothing in `mcp_usage`. Null is a row from before
      // this was required; naming the var is a re-create, which is why the message says so.
      if (callerAuth === null) {
        throw new HostingError(
          "this custom container names no caller-auth env var — re-create it naming the one its " +
            "image reads a bearer token from, so a run that reaches its address is refused",
        );
      }
      const digest = digestOf(image);
      return {
        spec: {
          name: await named(digest),
          image,
          command,
          env: {},
          port,
          memory: limits.memory,
          cpus: limits.cpus,
          lifetime: "shared",
        },
        path,
        digest,
        callerEnv: callerAuth.env,
      };
    }
    const found = server.catalogueId === null ? null : await catalogue.get(server.catalogueId);
    // A remote preset's row is never hosted; an entry that changed kind under a hosted row is as
    // gone as one that was deleted.
    const entry = found?.kind === "hosted" ? found : null;
    if (entry === null) {
      throw new HostingError(
        `the catalogue has no entry "${server.catalogueId}" any more — archive this server`,
      );
    }
    const pinned = server.host?.imageDigest ?? null;
    // Spliced into the image reference below, and writable by anything that writes the row.
    if (pinned !== null && !updateImage && !IMAGE_DIGEST.test(pinned)) {
      throw new HostingError(
        "this server's recorded image digest is malformed — restart it with the latest image",
      );
    }
    const digest = updateImage || pinned === null ? digestOf(entry.image) : pinned;
    const { command, env } = launchOf(entry, server.settings ?? {});
    return {
      spec: {
        name: await named(digest),
        image: atDigest(entry.image, digest),
        command,
        env,
        port: entry.port,
        memory: entry.memory ?? limits.memory,
        cpus: entry.cpus ?? limits.cpus,
        lifetime: "shared",
      },
      path: entry.path,
      digest,
      callerEnv: callerAuthEnvOf(entry),
    };
  };

  /** Every live hosted row not stopped — the set boot reconciles and the supervisor watches. */
  const liveHosted = async (): Promise<McpServer[]> =>
    (await store.listServers()).filter((s) =>
      s.kind === "hosted" && s.archivedAt === null && s.host?.status !== "stopped"
    );

  /**
   * The backend's containers judged against the rows, and every one that is not the guard and not
   * the CURRENT launch of a live row (its launch key, from what the row says now) removed. Every
   * settings or image change moves a row to a new name, so what it ran before is left behind under
   * the old one; so is a container an archive's stop missed, one from before launch keys, and one a
   * superseded launch put up. Run at boot and on every supervisor tick.
   *
   * Listed BEFORE the rows are read: a row names its new key before its container exists (`relaunch`
   * writes the digest first), so a container that is listed and current is never taken for stale.
   * A row stopped or archived accounts for nothing.
   *
   * Best-effort. A backend that cannot list is a debug line, never a boot failure — hosting works
   * without this, it just leaks.
   *
   * It matches by name within what the backend lists. Under docker that is this deployment's
   * containers on its tools network (`ryph.tool.network` and `ryph.deployment` both), so two
   * deployments on one daemon never sweep each other's, even sharing one tools network.
   */
  const sweep = async () => {
    let found: string[];
    try {
      found = await host.list();
    } catch (err) {
      diag.debug("hosting.sweep_skipped", { err: describe(err) });
      return;
    }
    let accounted = await accountedFor();
    for (const name of found) {
      if (accounted.has(name)) continue;
      try {
        // Judged again under the name's lock, from the rows as they read now: the list and the rows
        // above are a snapshot, and an edit back (A→B→A) can queue a launch of this very name while
        // the sweep works through the others. Queued behind it, the stop must not take it down.
        const removed = await mutate(name, async () => {
          accounted = await accountedFor();
          if (accounted.has(name)) return false;
          await host.stop(name);
          ours.delete(name);
          dropRoutesTo(name);
          return true;
        });
        if (removed) diag.debug("hosting.orphan_removed", { container: name });
      } catch (err) {
        diag.warn("hosting.orphan_stop_failed", { container: name, err: describe(err) });
      }
    }
    await refreshDropped();
  };

  /**
   * The names the sweep keeps: the guard, and each live row's current launch — but not a row whose
   * launch cannot be derived any more (`blocked`): nothing relaunches it, so what it ran before is
   * removed rather than kept forever.
   */
  const accountedFor = async (): Promise<Set<string>> => {
    const accounted = new Set<string>([guardName]);
    for (const row of await liveHosted()) {
      if (blocked.has(row.id)) continue;
      const name = await currentContainer(row);
      if (name !== null) accounted.add(name);
    }
    return accounted;
  };

  /** Routes whose container is gone are dropped (see `dropRoute`); true if any was. */
  let routesDropped = false;
  const dropRoute = (id: string, route: HostedRoute) => {
    if (routes.get(id) !== route) return;
    routes.delete(id);
    routesDropped = true;
  };
  /**
   * Drops every route to a container that was just removed: a "ready" route to nothing answers
   * uncoded guard 502s, where no route answers a coded `hosted_starting` (or `hosted_stale`) and
   * sends the supervisor's probe to relaunch the row.
   */
  const dropRoutesTo = (name: string) => {
    for (const [id, route] of routes) if (route.container === name) dropRoute(id, route);
  };
  /** The guard relaunched without the routes dropped since it last was. */
  const refreshDropped = async () => {
    if (!routesDropped || access === null) return;
    routesDropped = false;
    await refreshGuard().catch((err) =>
      diag.warn("hosting.guard_refresh_failed", { err: describe(err) })
    );
  };

  /**
   * Is the guard gone? Asked only when the route table alone would say "nothing to do", so the
   * cost is one backend call per supervisor tick and none on the launch path.
   *
   * An error is NOT a missing guard. Relaunching on the strength of a backend that would not
   * answer would turn a blip into a real outage; the next tick asks again.
   */
  const guardMissing = async (): Promise<boolean> => {
    if (access === null) return true;
    try {
      return (await host.inspect(guardName)) !== "running";
    } catch (err) {
      diag.debug("hosting.guard_uninspectable", { err: describe(err) });
      return false;
    }
  };

  /**
   * Relaunches the guard when its route table changed, or when it is not running, serialized so
   * two launches landing together produce one guard with both routes rather than a race.
   *
   * The "not running" half is not hypothetical bookkeeping. The guard's name is stable on
   * purpose — it is how a restarted gateway finds its own containers instead of leaking them —
   * so anything that removes by that name removes it from under this process. Before the hosting
   * lease, a departing gateway's shutdown did exactly that through every rolling update; an
   * operator's `kubectl delete` still can.
   */
  const refreshGuard = (): Promise<void> => {
    const next = guardQueue.catch(() => {}).then(async () => {
      if (closed) return;
      const table = formatGuardRoutes([...routes.values()]);
      const callers = formatCallerTokens([...routes.values()]);
      // A caller token rotates with every launch of its container, so it is part of the table.
      if (`${table}|${callers}` === guardTable && !(await guardMissing())) return;
      guardRelaunching++;
      let launched;
      try {
        launched = await mutate(guardName, () =>
          host.launch(guardLaunchSpec({
            name: guardName,
            image: guardImage!,
            routes: table,
            token,
            callers,
            // Published only where this process cannot dial the guard by name — and then on
            // loopback, which the adapter enforces. See ports/tool_host.ts.
            ...(host.reachesGuard ? {} : { publish: { hostPort: guardHostPort } }),
          })));
      } finally {
        guardRelaunching--;
      }
      if (!host.reachesGuard) {
        guardHostPort = Number(launched.address.slice(launched.address.lastIndexOf(":") + 1));
      }
      access = { origin: `http://${launched.address}`, token };
      guardTable = `${table}|${callers}`;
      guardLaunchedAt = nowMs();
      diag.debug("hosting.guard_launched", { address: launched.address, routes: routes.size });
    });
    guardQueue = next;
    return next;
  };

  const scheduleBackoff = (id: string) => {
    const attempts = (backoff.get(id)?.attempts ?? 0) + 1;
    const delay = Math.min(limits.backoffMinMs * 2 ** (attempts - 1), limits.backoffMaxMs);
    backoff.set(id, { attempts, nextAt: nowMs() + delay });
  };

  /** Probes a starting server until it answers or the startup window closes. */
  const awaitHealthy = async (id: string, gen: number) => {
    const deadline = nowMs() + limits.startupTimeoutMs;
    let detail = "no answer yet";
    for (;;) {
      if (!current(id, gen)) return;
      const server = await store.getServer(id);
      if (server === null || server.archivedAt !== null) return;
      const result = await deps.probe(server);
      if (result.ok || credentialBad(result, server)) {
        failures.delete(id);
        backoff.delete(id);
        // A credential that will not open, or that upstream refuses, is the row's to fix: the
        // container stays up and routed, and the row says what is wrong instead of relaunching.
        await save(id, { status: "healthy", lastError: result.ok ? null : result.detail }, {
          gen,
        });
        return;
      }
      detail = result.detail;
      // The row changed under this launch (a database revert while it was under way): its route
      // is the key of what was launched, which the row no longer names, so no probe will pass
      // until a relaunch — and the supervisor skips a row with a wait running. Relaunch from the
      // row as it stands now rather than probe out the startup window — counted against the
      // row's backoff, so a database writer toggling the row gets relaunches 30 s, 60 s, 120 s…
      // apart rather than one per probe; while one is not due it probes on like any launch.
      if (unroutedCode(result) === HOSTED_STALE && current(id, gen)) {
        const due = backoff.get(id);
        if (due === undefined || due.nextAt <= nowMs()) {
          scheduleBackoff(id);
          diag.debug("hosting.stale_relaunch", { serverId: id });
          const next = bump(id);
          await save(id, { status: "starting", lastError: null }, { gen: next });
          await relaunch(id, next, false);
          return;
        }
      }
      if (nowMs() >= deadline) {
        await save(id, {
          status: "unreachable",
          lastError: `did not answer within ${
            Math.round(limits.startupTimeoutMs / 1000)
          } s: ${detail}`,
        }, { gen });
        scheduleBackoff(id);
        return;
      }
      await sleep(limits.startupPollMs);
    }
  };

  /** The background half of a launch: the container, its route, the guard, the wait. */
  const relaunch = async (id: string, gen: number, updateImage: boolean) => {
    const server = await store.getServer(id);
    if (server === null || server.archivedAt !== null || !current(id, gen)) return;
    blocked.delete(id);
    /** The name a launch went out under, once it did. */
    let launching: string | null = null;
    try {
      const { spec, path, digest, callerEnv } = await targetFor(server, updateImage).catch(
        (err) => {
          // Nothing a relaunch can fix: the outlook says so rather than promising one.
          if (err instanceof HostingError) blocked.set(id, describe(err));
          throw err;
        },
      );
      // Minted per launch and held in memory only: a fresh container gets a fresh token, and a
      // gateway that restarts relaunches the container rather than trying to remember it.
      const callerToken = callerEnv === null ? undefined : mintToken();
      if (callerEnv !== null) spec.secretEnv = { ...spec.secretEnv, [callerEnv]: callerToken! };
      // Its one way out, merged last so nothing the entry set can stand in for it (the catalogue
      // refuses those names anyway). Plain env, not secretEnv: see core/tool_egress.ts.
      if (egressProxy !== null) {
        spec.env = {
          ...spec.env,
          ...toolProxyEnv(egressProxy, await deps.toolEgress!.mint(spec.name)),
        };
      }
      if (closed || !current(id, gen)) return;
      // The digest is on the row before anything runs under the key it names, so the sweep never
      // takes a container being launched for the row's current key for a stale one.
      const named = await save(id, { status: "starting", imageDigest: digest, lastError: null }, {
        gen,
      });
      // Checked in the same tick as the launch is queued: a shutdown queues its stop behind it.
      if (named === null || closed || !current(id, gen)) return;
      ours.add(spec.name);
      launching = spec.name;
      const launched = await mutate(spec.name, () => {
        // Replacing the container a ready route serves (the same inputs again, or A→B→A): it is
        // not ready until the guard routes the new one, so a dial meanwhile is `hosted_starting`,
        // not an uncoded 502 from a guard whose container is being swapped.
        const was = routes.get(id);
        if (was?.container === spec.name && was.routedAt !== undefined) {
          routes.set(id, { ...was, routedAt: undefined });
        }
        return host.launch(spec);
      });
      const written = await save(id, {
        handle: launched.handle,
        startedAt: deps.now().toISOString(),
      }, { gen });
      if (written === null || !current(id, gen)) return;
      // Ready once the guard routes the key: until then a dial is `hosted_starting`, not a 404.
      const route: HostedRoute = {
        key: spec.name.slice("ryph-tool-".length),
        address: launched.address,
        path,
        callerToken,
        serverId: server.id,
        container: spec.name,
      };
      routes.set(server.id, route);
      await refreshGuard();
      if (current(id, gen) && routes.get(server.id) === route) {
        routes.set(server.id, { ...route, routedAt: nowMs() });
      }
      diag.debug("hosting.launched", { serverId: id, image: spec.image });
    } catch (err) {
      diag.warn("hosting.launch_failed", { serverId: id, err: describe(err) });
      // Superseded, the newer launch owns the row: under the same inputs it has the same name, so
      // a route to that name may be its own, and its own failure schedules its own backoff.
      if (!current(id, gen)) return;
      // A failed relaunch under the name a route serves has taken that container down with it.
      if (launching !== null && routes.get(id)?.container === launching) {
        dropRoute(id, routes.get(id)!);
        await refreshDropped();
      }
      await save(id, { status: "unreachable", lastError: describe(err) }, { gen });
      scheduleBackoff(id);
      return;
    }
    await awaitHealthy(id, gen);
  };

  const start = (server: McpServer, updateImage: boolean): void => {
    if (closed) return;
    const gen = bump(server.id);
    track(server.id, () => relaunch(server.id, gen, updateImage));
  };

  /** The lease went to another gateway: stop acting on what runs at once, and ask to restart. */
  const leaseWasLost = () => {
    if (closed) return;
    leaseLost = true;
    closed = true;
    for (const id of [...generation.keys()]) bump(id);
    routes.clear();
    availability = {
      available: false,
      reason: "this gateway lost the hosting lease and is restarting",
      pending: true,
    };
    diag.warn("hosting.lease_lost", { identity: lease.identity });
    deps.onLeaseLost?.();
  };

  return {
    availability: () => availability,
    guard: () => access,
    route: (serverId) => {
      const route = routes.get(serverId);
      return route === undefined ? null : { key: route.key, ready: route.routedAt !== undefined };
    },
    settling(serverId) {
      if (guardRelaunching > 0) return true;
      const at = Math.max(routes.get(serverId)?.routedAt ?? -Infinity, guardLaunchedAt);
      return nowMs() - at < SETTLE_MS;
    },
    outlook(server) {
      if (!availability.available) {
        return availability.pending === true
          ? { coming: true }
          : { coming: false, reason: availability.reason };
      }
      if (server.archivedAt !== null) return { coming: false, reason: "it is archived" };
      if (server.host?.status === "stopped") {
        return { coming: false, reason: "it is stopped — restart it from its settings" };
      }
      const why = blocked.get(server.id);
      return why === undefined ? { coming: true } : { coming: false, reason: why };
    },

    async boot() {
      if (!lease.held()) {
        availability = {
          available: false,
          reason: "waiting for the hosting lease — the previous gateway is still handing hosted " +
            "servers over",
          pending: true,
        };
        diag.debug("hosting.lease_waiting", { identity: lease.identity });
      }
      try {
        await lease.acquire(waiting.signal);
      } catch {
        return; // a shutdown landed while this process was still waiting its turn
      }
      if (closed) return;
      // Rows created before the marker still show the guard url of their day. Nothing dials it;
      // the API shows the marker from here on. One idempotent write.
      try {
        const marked = await store.markHostedUrls();
        if (marked > 0) diag.debug("hosting.urls_marked", { rows: marked });
      } catch (err) {
        diag.warn("hosting.urls_mark_failed", { err: describe(err) });
      }
      void lease.keep(keeping.signal).then((outcome) => {
        if (outcome === "lost") leaseWasLost();
      });
      const misconfigured = guardImage === null
        ? `no tool guard image is configured for ${host.kind} (RYPH_TOOL_GUARD_IMAGE)`
        : egressProxy !== null && deps.toolEgress === undefined
        ? `the ${host.kind} tool host sends hosted servers to the internet through an egress ` +
          `proxy (${egressProxy}), but this gateway has no RYPH_EGRESS_TOOL_KEY to mint their ` +
          "claims, so no server could reach its vendor's API"
        : null;
      if (misconfigured !== null) {
        availability = { available: false, reason: misconfigured };
        diag.warn("hosting.unavailable", { reason: misconfigured });
        return;
      }
      try {
        await host.ensureNetwork();
      } catch (err) {
        availability = {
          available: false,
          reason: `could not prepare the tools network on ${host.kind}: ${describe(err)}`,
        };
        diag.warn("hosting.unavailable", { reason: availability.reason });
        return;
      }
      networkReady = true;
      token = mintToken();
      access = null;
      guardTable = null;

      // Every live row is relaunched once the guard is up: a container a previous process left
      // running holds a caller token and an egress claim that died with it, and a route this one
      // never set. Anything not some row's current launch goes first — before the guard, since a
      // boot that cannot start the guard returns below, and an orphan left holding its memory cap
      // is exactly as wrong then as it is on a boot that succeeds.
      const rows = await liveHosted();
      await sweep();

      try {
        await refreshGuard();
      } catch (err) {
        const why = describe(err);
        // The one failure with a fix to name: the guard is our own build, never a pull.
        const missing = /no such image|not found|pull access denied|manifest unknown/i.test(why);
        availability = {
          available: false,
          reason: `the tool guard would not start on ${host.kind} (${why})` +
            (missing ? " — build its image with `bun run agent-image`" : ""),
        };
        diag.warn("hosting.unavailable", { reason: availability.reason });
        return;
      }
      // A shutdown that landed while the boot was still pulling or reconciling.
      if (closed) return;
      // Every row about to be relaunched reads `starting` before hosting reads available, so no
      // refusal in between calls a launch that is coming a container that is not.
      for (const row of rows) await save(row.id, { status: "starting", lastError: null });
      if (closed) return;
      availability = { available: true };
      diag.debug("hosting.booted", { relaunching: rows.length });
      for (const row of rows) start(row, false);

      // A stop that did not happen — refused while another gateway held the lease, or failed
      // outright — left a container behind a row that reads stopped. The holder finishes it.
      // The handle is read from the row, which a database writer can point anywhere: only a vendor
      // container's name is taken, and never the guard or a live row's current launch.
      const keep = await accountedFor();
      for (const row of await store.listServers()) {
        const handle = row.host?.handle ?? null;
        const stopped = row.archivedAt !== null || row.host?.status === "stopped";
        if (row.kind !== "hosted" || !stopped || handle === null) continue;
        if (!row.host?.lastError?.startsWith(STOP_FAILED)) continue;
        if (!TOOL_CONTAINER_NAME.test(handle) || handle === guardName || keep.has(handle)) {
          diag.warn("hosting.stop_retry_refused", { serverId: row.id });
          continue;
        }
        try {
          await mutate(handle, () => host.stop(handle));
          await save(row.id, { lastError: null }, { evenIfArchived: true });
        } catch (err) {
          diag.warn("hosting.stop_retry_failed", { serverId: row.id, err: describe(err) });
        }
      }
    },

    async launch(server, opts = {}) {
      if (!availability.available) throw new HostingError(availability.reason);
      backoff.delete(server.id);
      failures.delete(server.id);
      blocked.delete(server.id);
      const written = await save(server.id, { status: "starting", lastError: null });
      start(server, opts.updateImage ?? false);
      return written ?? server;
    },

    async stop(server) {
      bump(server.id);
      backoff.delete(server.id);
      failures.delete(server.id);
      blocked.delete(server.id);
      const route = routes.get(server.id);
      routes.delete(server.id);
      let lastError: string | null = null;
      // The handle a launch wrote, the name its route was serving, and the name of its current
      // key — which a launch still in flight is launching under (it writes the digest first, and
      // `serial` queues this stop behind it). Anything a row edit left under another name the
      // supervisor's sweep removes.
      const names = new Set(
        [server.host?.handle ?? null, route?.container ?? null, await currentContainer(server)]
          .filter((name): name is string => name !== null),
      );
      for (const name of names) {
        try {
          await mutate(name, () => host.stop(name));
          ours.delete(name);
        } catch (err) {
          // The row is stopped regardless — nothing routes to the container any more, and the
          // data plane refuses a stopped row — and the next holder's boot finishes the stop.
          lastError = `${STOP_FAILED}: ${describe(err)}`;
          diag.warn("hosting.stop_failed", { serverId: server.id, err: lastError });
        }
      }
      if (route !== undefined && availability.available) {
        await refreshGuard().catch((err) =>
          diag.warn("hosting.guard_refresh_failed", { err: describe(err) })
        );
      }
      const written = await save(server.id, { status: "stopped", lastError }, {
        evenIfArchived: true,
      });
      return written ?? server;
    },

    async logs(server, tail) {
      if (!availability.available) throw new HostingError(availability.reason);
      // The name derived from the row, never its stored handle, which anything that writes the
      // row can point at another container (the guard's, say).
      const name = await currentContainer(server);
      return name === null ? "" : await host.logs(name, tail);
    },

    async supervise() {
      if (!availability.available) return;
      // A lease lapsing unnoticed: probing and relaunching are the holder's, and this may no longer
      // be it. `mutate` would refuse the relaunches; this spares the rows the probes' writes too.
      if (!lease.held()) return;
      // The guard first, because it is not a row: the loop below walks hosted servers, so a
      // guard that vanished is the one failure nothing here would ever notice. It recovers on
      // its own only by accident — when some server's relaunch happens to refresh it — and a
      // deployment with no hosted servers has no such accident available.
      await refreshGuard().catch((err) => {
        diag.warn("hosting.guard_reconcile_failed", { err: describe(err) });
      });
      // What settings and image changes left behind under their old keys, and anything else no
      // row's current launch accounts for.
      await sweep();
      for (const server of await liveHosted()) {
        if (busy.has(server.id)) continue;
        const status = server.host?.status;
        if (status === "healthy") {
          const result = await deps.probe(server);
          const code = unroutedCode(result);
          if (code !== null) {
            // Nothing routed for it here, or routed to another launch: three more probes and a
            // backoff would only keep its runs refused. Relaunched from the row as it stands.
            failures.delete(server.id);
            backoff.delete(server.id);
            diag.debug("hosting.unrouted_relaunch", { serverId: server.id, code });
            await save(server.id, { status: "starting", lastError: null });
            start(server, false);
            continue;
          }
          if (result.ok || credentialBad(result, server)) {
            failures.delete(server.id);
            const lastError = result.ok ? null : result.detail;
            if ((server.host?.lastError ?? null) !== lastError) {
              await save(server.id, { status: "healthy", lastError });
            }
            continue;
          }
          const count = (failures.get(server.id) ?? 0) + 1;
          failures.set(server.id, count);
          diag.debug("hosting.probe_failed", { serverId: server.id, count, detail: result.detail });
          if (count >= limits.failuresBeforeUnreachable) {
            failures.delete(server.id);
            await save(server.id, { status: "unreachable", lastError: result.detail });
            scheduleBackoff(server.id);
          }
        } else if (status === "unreachable" || status === "starting") {
          // `starting` with nothing in flight is a wait this process never began (or lost): give
          // it the same backoff an unreachable server gets, starting now.
          const due = backoff.get(server.id);
          if (due === undefined && status === "starting") scheduleBackoff(server.id);
          if (due !== undefined && due.nextAt <= nowMs()) {
            diag.debug("hosting.backoff_relaunch", { serverId: server.id, attempt: due.attempts });
            await save(server.id, { status: "starting", lastError: server.host?.lastError });
            start(server, false);
          }
        }
      }
    },

    async latestDigest(server) {
      if (server.kind !== "hosted" || server.catalogueId === null) return null;
      const entry = await catalogue.get(server.catalogueId);
      return entry?.kind === "hosted" ? digestOf(entry.image) : null;
    },

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
      await guardQueue.catch(() => {});
    },

    live: () => liveHosted(),

    async capacity() {
      // Every row that is not archived, `stopped` ones included: a stopped row is one Restart
      // away from a container, so counting only what runs right now would be a cap a client can
      // walk around by stopping and creating.
      const live = (await store.listServers())
        .filter((s) => s.kind === "hosted" && s.archivedAt === null).length;
      return { live, max: limits.maxServers };
    },

    async shutdown() {
      // Synchronously, before any await: every background launch and wait is superseded from
      // here, so none of them writes a row or queues a launch behind the stops below — and every
      // route is dropped before the first stop goes out.
      closed = true;
      for (const id of [...generation.keys()]) bump(id);
      routes.clear();
      // Pending: the successor waiting for the lease relaunches every row.
      availability = { available: false, reason: "hosting is shutting down", pending: true };
      waiting.abort();
      // Nothing is removed by a process that does not hold the lease: after a loss, what runs is a
      // successor's. (`mutate` would refuse each stop; skipping says so once rather than per name.)
      if (networkReady && !leaseLost && lease.held()) {
        // Everything this process launched, by name: a launch still in flight is among them from
        // the moment it was queued, and `serial` puts each stop behind it.
        // And whatever else the backend lists as this deployment's — a container this process
        // never launched (a blocked row's, left from before its boot) included — so a clean exit
        // removes every one. A backend that cannot list stops what this process knows of.
        const listed = await host.list().catch((err) => {
          diag.debug("hosting.shutdown_list_failed", { err: describe(err) });
          return [] as string[];
        });
        const names = [...new Set([...ours, ...listed, guardName])];
        const outcomes = await Promise.allSettled(
          names.map((name) => mutate(name, () => host.stop(name))),
        );
        for (const [i, outcome] of outcomes.entries()) {
          if (outcome.status === "rejected") {
            diag.warn("hosting.shutdown_stop_failed", {
              container: names[i],
              err: describe(outcome.reason),
            });
          }
        }
        diag.debug("hosting.shut_down", { stopped: names.length });
      }
      access = null;
      // Only after the sweep: a successor waiting for the lease launches once this is done, and
      // never while it is still removing.
      keeping.abort();
      await lease.release();
    },
  };
}

/** The guard's header on an outbound request to a hosted row — the data plane's and the probe's. */
export function guardHeaders(
  server: Pick<McpServer, "kind">,
  guard: ToolGuardAccess | null,
): Record<string, string> {
  return server.kind === "hosted" && guard !== null
    ? { [TOOL_GUARD_TOKEN_HEADER]: guard.token }
    : {};
}
