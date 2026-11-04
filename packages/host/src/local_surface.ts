// The local deployment's listeners as the network sees them: which interfaces they bind, and
// which names they answer to.
//
// Loopback by default. The control plane, the model proxy and the app all used to bind every
// interface, which put an unclaimed instance — and before single-user, its "first to register
// becomes owner" form — on whatever network the laptop was on. A container run still has to
// reach the first two, so the host adds the one address its runs dial, detected at every boot
// (`runAddress`: the docker bridge on a Linux engine) rather than opening everything; Docker
// Desktop delivers `host.docker.internal` to loopback and needs nothing. RYPH_BIND is only for addresses beyond those two.
//
// The Host check is the other half, and is about the browser rather than the network: a page on
// any site can point its own DNS name at 127.0.0.1 and then talk to a loopback listener as
// same-origin. Answering only the names this deployment is actually reached by closes that.

import { isLoopbackHost } from "@ryph/shared/net";

/** The default bind: loopback only. */
export const LOOPBACK = "127.0.0.1";

/**
 * A bind setting as the addresses to listen on: comma-separated, brackets dropped, deduplicated,
 * and always loopback, first, whatever the setting names, plus `runAddress` (the detected one,
 * `runAddress` below) last, unless the setting already names it or a wildcard covers it. This process dials its own control
 * plane and forge at 127.0.0.1, as do the embedded app and `ryph login`, so a list that left it
 * out would cut them off. `localhost` is read as 127.0.0.1: a listener on a name binds only the
 * first address it resolves to, ::1 on macOS. A wildcard drops what it surely covers, since a
 * second listener on the same port would only collide: 0.0.0.0 every IPv4 address, `::` every
 * IPv6 one. `::` comes first and keeps the IPv4 addresses behind it: it covers them only on a
 * dual-stack socket, and with IPV6_V6ONLY (Linux's net.ipv6.bindv6only=1) 127.0.0.1 would go
 * unbound. Where it is dual-stack those binds fail as taken, which `serveOn` reads as covered
 * (`coveredByWildcard`). Pure and exported for the test.
 */
export function bindAddresses(
  raw: string | undefined,
  runAddress: string | null = null,
): string[] {
  const listed = [raw ?? "", runAddress ?? ""].join(",").split(",").map((a) =>
    a.trim().replace(/^\[(.*)\]$/, "$1")
  )
    .filter((a) => a !== "").map((a) => a.toLowerCase() === "localhost" ? LOOPBACK : a);
  const all = [...new Set([LOOPBACK, ...listed])];
  const v4 = listed.includes("0.0.0.0") ? ["0.0.0.0"] : all.filter(isIPv4);
  if (listed.includes("::")) return ["::", ...v4];
  return listed.includes("0.0.0.0") ? ["0.0.0.0", ...all.filter((a) => !isIPv4(a))] : all;
}

/**
 * The address runs on this machine dial it at, when that is not loopback and so has to be bound
 * beside it; null when there is none, or it could not be found. `docker` is the default bridge's
 * gateway when it is one of this machine's own addresses (`dockerBridge`, `localBridgeGateway`'s
 * answer: a native Linux engine, which maps `host.docker.internal` there), and null on Docker
 * Desktop or OrbStack, which forward the name to loopback. Every other backend calls home from
 * elsewhere, and binds nothing more; whether any backend's runs reach what is bound is
 * `remoteRunReach`'s question. Pure and exported for the test.
 */
export function runAddress(o: {
  provisioner: string;
  dockerBridge: string | null;
}): string | null {
  return o.provisioner === "docker" ? o.dockerBridge : null;
}

/** Whether an address is an IPv4 literal. */
export function isIPv4(address: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(address);
}

/** Whether an address answers more than this machine. */
export function isWildcard(address: string): boolean {
  return address === "0.0.0.0" || address === "::" || address === "[::]";
}

/** A deployment may declare an isolated container network scope; this changes logging only. */
export function wildcardBindNotice(
  binds: string[],
  scope: string | undefined,
  forgeEmbedded: boolean,
): { level: "info" | "warn"; message: string } | null {
  if (!binds.some(isWildcard)) return null;
  const container = scope === "container";
  return {
    level: container ? "info" : "warn",
    message: `RYPH_BIND=${binds.join(",")} — the control plane, the model proxy${
      forgeEmbedded ? " and the forge" : ""
    } answer ${
      container
        ? "the container's attached networks, including other containers on them; host exposure depends on published ports and network configuration"
        : "every network this machine is on"
    }`,
  };
}

/**
 * An address the way a URL and a Host header spell it: lowercased, and an IPv6 literal in
 * brackets (`fd00::5` becomes `[fd00::5]`), which is what `hostOf` hands back for comparing and
 * what `http://<host>:<port>` needs to parse.
 */
export function urlHost(address: string): string {
  const a = address.trim().toLowerCase();
  return a.includes(":") && !a.startsWith("[") ? `[${a}]` : a;
}

/** Names a container engine on this machine delivers to its loopback. */
const LOOPBACK_ALIASES = ["host.docker.internal", "host.orb.internal"];

/**
 * Whether runs can reach this process at every address they are handed, given the listeners
 * bound at `binds`: a refusal or a warning per host in question, and nothing when all answer.
 * `urls` pairs each setting with the URL a run dials (null: not handed out), and a host several
 * of them share is judged once, naming them all. Loopback, the names an engine delivers to
 * loopback and `aliases` (a confined docker run's gate, which relays to them) always answer, and
 * a wildcard answers every address of its family. An address literal that is neither loopback
 * nor bound can never answer, so it is refused. A name is warned of while only loopback
 * is bound: it may be a tunnel that delivers there, and this process cannot tell where it lands.
 * Pure and exported for the test.
 */
export function remoteRunReach(o: {
  binds: string[];
  urls: ReadonlyArray<readonly [string, string | null]>;
  aliases?: string[];
}): ({ refuse: string } | { warn: string })[] {
  const settings = new Map<string, string[]>();
  for (const [setting, url] of o.urls) {
    const host = url === null ? undefined : URL.parse(url)?.hostname.toLowerCase();
    if (host === undefined) continue;
    settings.set(host, [...settings.get(host) ?? [], setting]);
  }
  const fine = new Set([...LOOPBACK_ALIASES, ...(o.aliases ?? []).map((a) => a.toLowerCase())]);
  const bound = new Set(o.binds.map(urlHost));
  const listening = `the control plane, the model proxy and the forge listen only on ${
    o.binds.join(", ")
  }`;
  const out: ({ refuse: string } | { warn: string })[] = [];
  for (const [host, named] of settings) {
    if (isLoopbackHost(host) || fine.has(host) || bound.has(host)) continue;
    const dialed = `runs dial this process at ${host} (${named.join(", ")}), but ${listening}`;
    const v6 = host.startsWith("[");
    if (isIPv4(host) || v6) {
      if (o.binds.includes("::") || (!v6 && o.binds.includes("0.0.0.0"))) continue;
      out.push({
        refuse: `${dialed}. ` +
          "Add that address to RYPH_BIND (comma-separated; loopback stays bound either way)",
      });
    } else if (o.binds.every(isLoopbackHost)) {
      out.push({
        warn: `${dialed}. That works only if the name delivers to this machine's loopback, as a ` +
          "tunnel does; if runs fail at their first call, add the address they reach it at to " +
          "RYPH_BIND",
      });
    }
  }
  return out;
}

/** The names every local surface answers to, whatever is configured. */
const ALWAYS = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];

/**
 * The host names a local surface answers to: loopback's, `host.docker.internal`, every address
 * it binds, the host of every URL this deployment hands out for itself (what a run or a browser
 * dials), and RYPH_ALLOWED_HOSTS. Null when that setting is `*`: no check at all, for an
 * operator who has put the surface behind names of their own.
 */
export function allowedHosts(opts: {
  binds: string[];
  urls: (string | null | undefined)[];
  extra: string | undefined;
}): Set<string> | null {
  const extra = (opts.extra ?? "").split(",").map((h) => h.trim()).filter((h) => h !== "");
  if (extra.includes("*")) return null;
  // Every entry spelled the way `hostOf` reads a Host header, trailing dot and all, or a name
  // written one way never matches the header that names it the other.
  const hosts = new Set<string>(ALWAYS);
  const add = (host: string | null) => host !== null && hosts.add(host);
  for (const entry of extra) add(allowedHostEntry(entry));
  for (const bind of opts.binds) if (!isWildcard(bind)) add(hostOf(urlHost(bind)));
  for (const url of opts.urls) {
    const parsed = url ? URL.parse(url) : null;
    if (parsed !== null) add(hostOf(parsed.host));
  }
  return hosts;
}

/**
 * The names the embedded forge answers to: `allowedHosts` over every address this deployment
 * configures for reaching it — what runs are handed (the control plane's and the git gateway's),
 * how a build's clone dials it (RYPH_ENV_GIT_GATEWAY_URL: a launcher elsewhere clones by this
 * process's name on the deployment network), and the tool surface's. An address the deployment
 * itself names and the forge then refuses with a 421 is a build or a run that cannot clone.
 */
export function forgeAllowedHosts(opts: {
  binds: string[];
  publicUrl: string;
  gitGatewayUrl: string | null;
  buildGatewayUrl: string | null;
  toolsUrl: string | undefined;
  extra: string | undefined;
}): Set<string> | null {
  return allowedHosts({
    binds: opts.binds,
    urls: [opts.publicUrl, opts.gitGatewayUrl, opts.buildGatewayUrl, opts.toolsUrl],
    extra: opts.extra,
  });
}

/**
 * One RYPH_ALLOWED_HOSTS entry as `hostOf` spells a host: a bare name or address, `host:port`,
 * an IPv6 literal bare or bracketed with or without a port, or a whole URL. Null for an entry
 * that names no host. Pure and exported for the test.
 */
export function allowedHostEntry(entry: string): string | null {
  const e = entry.trim();
  if (e === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    const parsed = URL.parse(e);
    return parsed === null ? null : hostOf(parsed.host);
  }
  // More than one colon and no bracket is a bare IPv6 literal, never host:port.
  if (!e.startsWith("[") && (e.match(/:/g) ?? []).length > 1) return hostOf(`[${e}]`);
  return hostOf(e);
}

/** The host name a Host header names, port and trailing dot dropped; null when it is absent. */
export function hostOf(header: string | null): string | null {
  if (header === null || header === "") return null;
  const parsed = URL.parse(`http://${header}`);
  if (parsed === null) return null;
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

/** Whether a request's Host header is one `allowed` answers to. A null set allows everything. */
export function hostAllowed(header: string | null, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  const host = hostOf(header);
  return host !== null && allowed.has(host);
}

/** The refusal for a name this deployment does not answer to. */
export function misdirected(header: string | null): Response {
  return new Response(
    JSON.stringify({
      error: `this ryph does not answer to ${JSON.stringify(header ?? "")} — ` +
        "add the name to RYPH_ALLOWED_HOSTS if it should",
    }),
    { status: 421, headers: { "content-type": "application/json" } },
  );
}

/**
 * A handler that answers only the names in `allowed`, except requests `exempt` lets through on
 * any name: routes a non-browser sender calls by whatever name it was given, and which a
 * rebound page gains nothing from because they read no cookie and need a credential of their
 * own.
 */
export function guardHost<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
  allowed: Set<string> | null,
  exempt?: (req: Request) => boolean,
): (req: Request, ...rest: A) => Response | Promise<Response> {
  if (allowed === null) return handler;
  return (req, ...rest) => {
    const header = req.headers.get("host");
    return hostAllowed(header, allowed) || exempt?.(req)
      ? handler(req, ...rest)
      : misdirected(header);
  };
}
