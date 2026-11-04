// The standalone composition root: reads the environment, owns the listeners, and nothing else.
// Everything is in memory: a restart drops every tunnel the pod held, and runners re-register the
// same ports to the same ids, so links and viewer cookies survive it.
//
// With RYPH_PREVIEWS_REPLICAS above 1 (the Helm chart's one Deployment per ordinal), each pod owns
// the runs core/cluster.ts gives its ordinal (RYPH_PREVIEWS_ORDINAL), and reaches its peers, as
// runs reach it, at the host the chart's template names for each ordinal: that ordinal's own
// Service. Unset, or 1 (compose), none of that applies and nothing is forwarded.
//
// Three listeners: the public one (RYPH_PREVIEWS_PORT, 7490) for browsers, the tunnel one
// (RYPH_PREVIEWS_TUNNEL_PORT, 7491) for runners, and the API one (RYPH_PREVIEWS_API_PORT, 7493)
// for the control plane; with several replicas a fourth, the peer one (RYPH_PREVIEWS_PEER_PORT,
// 7492). ONE credential meets it: RYPH_PREVIEWS_TOKEN, which only the control plane holds. It is
// the bearer on the API listener's `/internal/*` and the key preview ids and viewer cookies are
// signed with.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { installDrain, makeHealth, refusePublicDevSecrets } from "@ryph/service";
import { type Cluster, peerHosts } from "./core/cluster.ts";
import { appOrigin, onAppSite } from "./core/gate.ts";
import { badWatermarks, CRITICAL, HIGH, memorySource, uncappedSocketBuffers } from "./memory.ts";
import { previews } from "./service.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const portEnv = (name: string, fallback?: number): number | undefined => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    fail(`${name} must be a port, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** Like `portEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const integerEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** A fraction above 0 and at most 1, or null: `badWatermarks` says which pairs are watermarks (a
 * critical of 1 is one, a high of 1 is not). */
export function fraction(raw: string): number | null {
  const value = Number(raw);
  return value > 0 && value <= 1 ? value : null;
}

/** Variables this service once read and reads no more, with what took each one's place. */
const RETIRED: Record<string, string> = {
  RYPH_PREVIEWS_INTERNAL_PORT:
    "RYPH_PREVIEWS_TUNNEL_PORT (runners' tunnels, 7491) and RYPH_PREVIEWS_API_PORT (the control plane, 7493)",
};

/** What a boot line says of the retired variables `get` has set: each, and what replaced it. */
export function retiredEnv(get: (name: string) => string | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(RETIRED).filter(([name]) => get(name) !== undefined));
}

/** `fraction` of the variable, or the fallback when unset. */
const fractionEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return fraction(raw) ??
    fail(`${name} must be a fraction above 0 and at most 1, got ${JSON.stringify(raw)}`);
};

/**
 * This pod among its replicas, or undefined with one. RYPH_PREVIEWS_REPLICAS is how many
 * Deployments the chart renders; RYPH_PREVIEWS_ORDINAL is this one's; RYPH_PREVIEWS_PEER_HOST
 * names each ordinal's Service with `{ordinal}` in it; RYPH_PREVIEWS_PEER_PORT is the peer
 * listener on every pod. Every pod's tunnel and API ports are this one's: a runner dials its owner
 * at `ws://<that host>:<tunnel port>`, and a pod forwards a call to `<that host>:<API port>`.
 */
function clusterFromEnv(tunnelPort: number, apiPort: number): Cluster | undefined {
  const raw = env("RYPH_PREVIEWS_REPLICAS");
  const replicas = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 64) {
    fail(`RYPH_PREVIEWS_REPLICAS must be an integer from 1 to 64, got ${JSON.stringify(raw)}`);
  }
  if (replicas === 1) return undefined;
  const ordinal = env("RYPH_PREVIEWS_ORDINAL") ??
    fail("RYPH_PREVIEWS_ORDINAL is required with more than one replica");
  const self = /^(0|[1-9][0-9]?)$/.test(ordinal) ? Number(ordinal) : replicas;
  if (self >= replicas) {
    fail(
      `RYPH_PREVIEWS_ORDINAL must be an integer below ${replicas}, got ${JSON.stringify(ordinal)}`,
    );
  }
  const template = env("RYPH_PREVIEWS_PEER_HOST") ??
    fail("RYPH_PREVIEWS_PEER_HOST is required with more than one replica");
  const hosts = peerHosts(template, replicas) ??
    fail(
      `RYPH_PREVIEWS_PEER_HOST must be a hostname with {ordinal} in it once, got ${
        JSON.stringify(template)
      }`,
    );
  const peerPort = portEnv("RYPH_PREVIEWS_PEER_PORT", 7492)!;
  return { self, peers: hosts.map((host) => ({ host, tunnelPort, apiPort, peerPort })) };
}

export async function main(): Promise<void> {
  refusePublicDevSecrets("previews");
  setupLoggerFromEnv();
  const log = new Logger("previews");
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: String(reason) });
  });

  const token = env("RYPH_PREVIEWS_TOKEN") ?? fail("RYPH_PREVIEWS_TOKEN is required");
  if (token.length < 32) fail("RYPH_PREVIEWS_TOKEN must be at least 32 characters");
  const domain = (env("RYPH_PREVIEWS_DOMAIN") ?? fail("RYPH_PREVIEWS_DOMAIN is required"))
    .toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
    fail(`RYPH_PREVIEWS_DOMAIN must be a hostname, got ${JSON.stringify(domain)}`);
  }
  const local = domain === "localhost" || domain.endsWith(".localhost");
  const publicPort = portEnv("RYPH_PREVIEWS_PUBLIC_PORT");
  if (publicPort !== undefined && !local) {
    fail("RYPH_PREVIEWS_PUBLIC_PORT is only for a domain under localhost");
  }
  // The app a cookieless link is sent to for a ticket. Unset, such a link is a 401 page.
  const rawAppUrl = env("RYPH_PREVIEWS_APP_URL");
  const appUrl = rawAppUrl === undefined ? undefined : appOrigin(rawAppUrl) ??
    fail(`RYPH_PREVIEWS_APP_URL must be an http(s) origin, got ${JSON.stringify(rawAppUrl)}`);
  if (appUrl !== undefined && onAppSite(domain, appUrl)) {
    fail(
      `RYPH_PREVIEWS_DOMAIN (${domain}) is on the app's registrable domain (${appUrl}): a page an ` +
        "agent wrote there could set cookies the app reads. Put previews on a domain of their own",
    );
  }
  // What the guard measures against: the pod's cgroup limit (the chart's `resources.limits.memory`,
  // compose's `mem_limit`), else the process's RSS against RYPH_PREVIEWS_MEMORY_LIMIT_MIB. With
  // neither, nothing but the counts holds it, and the boot line says so.
  const limitMiB = integerEnv("RYPH_PREVIEWS_MEMORY_LIMIT_MIB", 0);
  const high = fractionEnv("RYPH_PREVIEWS_MEMORY_HIGH", HIGH);
  const critical = fractionEnv("RYPH_PREVIEWS_MEMORY_CRITICAL", CRITICAL);
  const bad = badWatermarks(high, critical);
  if (bad !== null) {
    fail(`RYPH_PREVIEWS_MEMORY_HIGH and RYPH_PREVIEWS_MEMORY_CRITICAL: ${bad}`);
  }
  const source = memorySource({ limitBytes: limitMiB > 0 ? limitMiB * 2 ** 20 : undefined });
  const port = portEnv("RYPH_PREVIEWS_PORT", 7490)!;
  const tunnelPort = portEnv("RYPH_PREVIEWS_TUNNEL_PORT", 7491)!;
  const apiPort = portEnv("RYPH_PREVIEWS_API_PORT", 7493)!;
  const cluster = clusterFromEnv(tunnelPort, apiPort);
  const ports = [
    port,
    tunnelPort,
    apiPort,
    ...(cluster ? [cluster.peers[cluster.self].peerPort] : []),
  ];
  if (new Set(ports).size !== ports.length) {
    fail(`the public, tunnel, API and peer ports must differ, got ${ports.join(", ")}`);
  }

  const health = makeHealth({ log });
  const service = await previews({
    token,
    domain,
    publicPort,
    appUrl,
    memory: source === null ? undefined : { source, high, critical },
    cluster,
    health: health.routes,
    log: {
      info: (event, fields) => log.info(event, fields),
      warn: (event, fields) => log.warn(event, fields),
      error: (event, fields) => log.error(event, fields),
    },
  });
  await new Promise<void>((resolve, reject) => {
    service.public.once("error", reject);
    service.public.listen(port, "0.0.0.0", resolve);
  });
  for (const [listener, at] of [[service.tunnel, tunnelPort], [service.api, apiPort]] as const) {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(at, "0.0.0.0", resolve);
    });
  }
  const peer = service.peer;
  const peerPort = cluster?.peers[cluster.self].peerPort;
  if (peer !== null && peerPort !== undefined) {
    await new Promise<void>((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(peerPort, "0.0.0.0", resolve);
    });
  }
  // Once listening, a listener's error (an accept failing for want of descriptors, say) is said:
  // with no listener for it, it would be thrown and take the pod down.
  const listeners = { public: service.public, tunnel: service.tunnel, api: service.api, peer };
  for (const [name, listener] of Object.entries(listeners)) {
    listener?.on(
      "error",
      (err) => log.error("previews.listener_error", { listener: name, err: String(err) }),
    );
  }
  // Unguarded is worth a warning: nothing but the counts keeps the pod inside its memory.
  (source === null ? log.warn.bind(log) : log.info.bind(log))(
    `listening on :${port} (public), :${tunnelPort} (tunnels) and :${apiPort} (API)` +
      (peer === null ? "" : ` and :${peerPort} (peers)`),
    {
      domain,
      scheme: local ? "http" : "https",
      appUrl: appUrl ?? null,
      memory: source === null ? "unguarded" : source.kind,
      memoryLimitMiB: source === null ? null : Math.round(source.limit / 2 ** 20),
      memoryHigh: high,
      memoryCritical: critical,
      replicas: cluster?.peers.length ?? 1,
      ordinal: cluster?.self ?? 0,
    },
  );

  // The chart caps every socket's kernel buffers (`previews.capSocketBuffers`); without that a page
  // that never reads can grow them faster than the guard samples, and no memory limit makes up for
  // it. Said once, at boot.
  const buffers = uncappedSocketBuffers();
  if (buffers !== null) {
    log.warn("previews.socket_buffers_uncapped", {
      tcpRmemMax: buffers.rmem,
      tcpWmemMax: buffers.wmem,
      want: "net.ipv4.tcp_rmem and tcp_wmem at most 131072 (previews.capSocketBuffers)",
    });
  }

  // A variable this service no longer reads is a deployment that thinks it set something: its
  // value is ignored, and said so once, at boot.
  const retired = retiredEnv(env);
  if (Object.keys(retired).length > 0) log.warn("previews.retired_env", { ignored: retired });

  installDrain({
    servers: [
      { name: "public", server: { shutdown: () => service.shutdownPublic() } },
      {
        name: "tunnels and API",
        server: {
          // Requests in flight on the public listener ride the tunnels, so they go last.
          async shutdown() {
            await service.shutdownPublic();
            // Closes every tunnel and connection, the tunnel and API listeners' included.
            service.close();
            await Promise.all(
              [service.tunnel, service.api].map((listener) =>
                new Promise<void>((resolve) => listener.close(() => resolve()))
              ),
            );
          },
        },
      },
    ],
    beginDrain: health.beginDrain,
    close: () => service.close(),
    preStopMs: integerEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: integerEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
  });
}

if (import.meta.main) {
  await main();
}
