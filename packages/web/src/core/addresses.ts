// WHERE web__fetch MAY GO. This service fetches a URL an AGENT chose — the one place in the
// platform where a run's own text decides what address a service in the cluster dials — so it is
// an SSRF engine by construction unless this module holds. Everything here is pure given a
// resolver, so every range is a unit test with a plain address rather than a live lookup.
//
// The rules, in order:
// - http(s) and nothing else. `file:`, `gopher:`, `data:` and friends are not "the web".
// - https only, unless RYPH_WEB_ALLOW_INSECURE=1 — a plain-http page is a page an on-path party
//   writes, and what comes back is read by a model that acts on it.
// - no userinfo: `https://user:pass@host` puts a credential in a URL that rides logs and rows.
// - the ordinary port for the scheme, and nothing else: 443, or 80 when insecure is allowed. A
//   public host is still a host with 65 000 other ports on it, and "fetch a page" does not mean
//   "reach the admin panel somebody left on :8080 of a box whose name resolves publicly".
// - every resolved address must be globally routable. Loopback, the unspecified block, RFC 1918,
//   CGNAT, link-local (169.254.0.0/16, which is where every cloud's metadata server lives, and
//   fe80::/10), multicast, the documentation and benchmarking blocks, and everything outside
//   IPv6 global unicast are refused — a name that resolves to one of them included.
// - EVERY redirect hop is judged again by the same rule, because the guard's verdict is about
//   the address, and a public host answering `302 http://169.254.169.254/` would otherwise carry
//   the fetch straight there (core/page.ts follows redirects by hand for exactly this reason).
//
// THE RESIDUAL, stated plainly: the runtime's fetch cannot be pinned to an address we resolved, so
// between this check and the connection the name can answer differently (DNS rebinding). The
// window is one lookup wide and the attacker must already control a name the agent was induced
// to fetch — but it is real, and what stands behind it DEPENDS ON THE DEPLOYMENT:
// - on Kubernetes there is a second layer, and it is a real one: this service's NetworkPolicy
//   (deploy/helm/ryph/templates/networkpolicies.yaml) excepts every private range from its egress and
//   opens 443 alone, so a rebound name reaches nothing the policy does not already allow.
// - under the single binary and under compose there is NO second layer. The process has an
//   ordinary route to the machine's own network, and a rebound name would reach whatever that
//   network reaches. The controls there are the ones above this line — the rules in this file —
//   plus the two the operator holds: RYPH_WEB_TOOLS=off, and the per-agent tool policy.
// The address classification is @ryph/shared/net's, the one the gateway's upstream guard
// (packages/mcp-gateway/src/core/upstream_guard.ts) holds too: two doors, one rule.

import { isBlockedAddress, isLoopbackHost, parseIp } from "@ryph/shared/net";

/** Injected so the rules are testable with a fixed table and the deployment keeps its resolver. */
export interface AddressPolicy {
  /** Permit plain `http://` pages (RYPH_WEB_ALLOW_INSECURE=1). Default: https only. */
  allowInsecure: boolean;
  /** Every address a name has, or [] when it has none. Throwing counts as none. */
  resolve(hostname: string): Promise<string[]>;
}

export type UrlRefusal =
  | "malformed"
  | "scheme"
  | "insecure"
  | "port"
  | "credentials_in_url"
  | "blocked"
  | "unresolvable";

export type UrlVerdict =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: UrlRefusal; detail: string };

/**
 * One URL, judged whole: the string, the scheme, the userinfo, and every address its host has.
 * `detail` is written for the AGENT to read — it says what was refused and why, and never
 * anything about this deployment beyond the address the name answered with.
 */
export async function checkFetchUrl(
  raw: string,
  policy: AddressPolicy,
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: "malformed",
      detail: `${raw} is not a valid absolute URL`,
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: "scheme",
      detail: `only http(s) URLs can be fetched (got ${url.protocol})`,
    };
  }
  if (url.protocol === "http:" && !policy.allowInsecure) {
    return {
      ok: false,
      reason: "insecure",
      detail: "this deployment fetches https only — try the https:// address of the same page",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "credentials_in_url",
      detail: "a URL carrying a username or password is refused",
    };
  }
  // An explicit port must be the scheme's own. `url.port` is "" when the URL names the default,
  // whatever it spelled, so this admits https://host and https://host:443 alike.
  const allowedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port !== "" && url.port !== allowedPort) {
    return {
      ok: false,
      reason: "port",
      detail: `only port ${allowedPort} is fetched, not ${url.port}`,
    };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHost(host)) {
    return {
      ok: false,
      reason: "blocked",
      detail: "loopback addresses are not reachable",
    };
  }
  const literal = parseIp(host);
  const addresses = literal !== null ? [host] : await resolveOrEmpty(policy, host);
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: "unresolvable",
      detail: `${host} does not resolve`,
    };
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return {
        ok: false,
        reason: "blocked",
        detail: `${host} resolves to ${address}, which is a private, loopback, link-local or ` +
          "otherwise non-public address",
      };
    }
  }
  return { ok: true, url, addresses };
}

async function resolveOrEmpty(
  policy: AddressPolicy,
  host: string,
): Promise<string[]> {
  try {
    return await policy.resolve(host);
  } catch {
    return [];
  }
}
