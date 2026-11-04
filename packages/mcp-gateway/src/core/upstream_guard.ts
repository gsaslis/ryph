// Where the gateway may dial. It forwards to operator-supplied URLs with operator-supplied
// credentials, which makes it a confused-deputy and SSRF target by construction: a run that
// could point it at the control plane's address would reach a host the run network was never
// meant to see. So by default the upstream must be a public https host, and everything else —
// loopback, link-local, RFC 1918, the CGNAT range, the documentation and benchmarking ranges,
// multicast, any address outside global unicast, and a name that resolves to any of them — is
// refused. Operators are trusted, but "we did not mean to grant that route" is a bug
// worth a flag: RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS opens it for deployments whose servers are
// internal, and RYPH_MCP_ALLOW_INSECURE permits plain http.
//
// The check runs at registration (so a bad URL is a 400 the operator sees), at probe time, and
// again on the data plane before every forward, cached briefly — a name that resolved publicly at
// registration and privately later (DNS rebinding) is caught on the next forward, not never.
// fetch cannot pin a resolved address, so this is a re-check rather than a pin; the
// platform's own service hosts sit in private ranges in every deployment shape we ship, which is
// what makes the range rule cover them too.
//
// Pure given a resolver: the platform's DNS is injected, so every rule is unit-tested with
// plain addresses. What counts as private is @ryph/shared/net's `isBlockedAddress`, the one rule
// every service that dials a chosen address shares.
//
// A PLATFORM server is exempt too, for a simpler reason: its row carries no address at all, only
// a marker, and what the data plane dials for it is deployment configuration rather than a row.
//
// A HOSTED server never comes here to be dialled: its url is a marker, and the data plane and the
// probe dial its launch key on the tool guard (core/sealing.ts `hostedDial`). Asked about one, the
// rule refuses it, so no hosted row is ever dialled at an address a database column names.

import { isBlockedAddress, parseIp } from "@ryph/shared/net";
import type { McpServer } from "./types.ts";

export interface UpstreamPolicy {
  /** Permit plain `http://` upstreams. */
  allowInsecure: boolean;
  /** Permit upstreams in private, loopback, and link-local ranges. */
  allowPrivate: boolean;
  /** Resolves a hostname to its addresses; throws, or returns [], when it does not resolve. */
  resolve(hostname: string): Promise<string[]>;
}

/** What the rule judges: enough of a server to know whose URL it is. */
export type UpstreamTarget = Pick<McpServer, "kind" | "slug" | "url">;

export type UpstreamVerdict =
  | { ok: true; url: URL }
  | {
    ok: false;
    reason:
      | "malformed"
      | "scheme"
      | "insecure"
      | "credentials_in_url"
      | "private"
      | "unresolvable"
      | "hosted";
    detail: string;
  };

export async function checkUpstreamUrl(
  target: UpstreamTarget,
  policy: UpstreamPolicy,
): Promise<UpstreamVerdict> {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return { ok: false, reason: "malformed", detail: "not a valid absolute URL" };
  }
  if (target.kind === "hosted") {
    return {
      ok: false,
      reason: "hosted",
      detail:
        "a hosted server is dialled at its launch's route on the tool guard, never at its url",
    };
  }
  // A platform row's URL is a marker the data plane never dials: it forwards to the address the
  // deployment configured for that slug, which nobody typed into a row. Nothing to judge here.
  if (target.kind === "platform") return { ok: true, url };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "scheme", detail: `scheme must be https (got ${url.protocol})` };
  }
  if (url.protocol === "http:" && !policy.allowInsecure) {
    return {
      ok: false,
      reason: "insecure",
      detail: "plain http upstreams are refused (RYPH_MCP_ALLOW_INSECURE opens them)",
    };
  }
  if (url.username !== "" || url.password !== "") {
    // A credential belongs in the sealed header map, never in a URL that rides logs and rows.
    return { ok: false, reason: "credentials_in_url", detail: "the URL must not carry userinfo" };
  }
  if (policy.allowPrivate) return { ok: true, url };

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "private", detail: "loopback upstreams are refused" };
  }
  const literal = parseIp(host);
  const addresses = literal !== null ? [host] : await resolveOrEmpty(policy, host);
  if (addresses.length === 0) {
    return { ok: false, reason: "unresolvable", detail: `${host} does not resolve` };
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return {
        ok: false,
        reason: "private",
        detail: `${host} resolves to ${address}, a private or local address ` +
          "(RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS opens these)",
      };
    }
  }
  return { ok: true, url };
}

async function resolveOrEmpty(policy: UpstreamPolicy, host: string): Promise<string[]> {
  try {
    return await policy.resolve(host);
  } catch {
    return [];
  }
}
