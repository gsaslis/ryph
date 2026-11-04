// The egress proxy: the one way out of a run's network, and the only place a hostname
// allowlist can actually be enforced.
//
// WHY A PROXY AND NOT A FIREWALL RULE. A host allowlist cannot be enforced at the IP layer.
// `registry.npmjs.org` is Cloudflare, and the CIDR that carries it carries a few million other
// sites — so an `ipBlock` allowlist naming it would read like a boundary and be a fiction. What
// a forward proxy sees is the name the client asked for, in the `CONNECT` line, before any TLS
// exists. That is the granularity an operator actually wants, and it is the same granularity on
// every backend, because the enforcement is a process we own rather than a CNI feature.
//
//   CONNECT registry.npmjs.org:443  →  allowed   → 200, then bytes both ways, untouched
//   CONNECT evil.example:443        →  refused   → 403, naming the host and the bundle
//
// PER-HOST, NOT PER-PATH, and NO TLS INTERCEPTION. The URL stays inside TLS and this process
// never sees it. Intercepting would need a CA in every agent image and would put every
// request's plaintext in the platform's hands, for a granularity nobody asked for.
//
// THE PROXY HOLDS NO CREDENTIAL, and that is what bounds the prize here. It cannot mint a
// token, it holds no key to anything of ours, and compromising it buys an attacker the
// allowlist they already had. RYPH_EGRESS_KEY only VERIFIES — see below.
//
// IT DOES REPORT WHAT IT REFUSES, and that is the one link back. A refusal used to end in this
// process's stderr: the run heard `tunnel error: unsuccessful` from whatever it was running and
// nothing else, and an environment BUILD that was refused a host settled `ready` anyway and
// shipped an image missing what that host was for. So a refused host and port are POSTed to the
// control plane — never on the request path, which answers first and always — and the
// credential presented is the SUBJECT'S OWN TOKEN, the claim this process just verified. That
// keeps the sentence above true: forwarding a caller's credential back to the party that minted
// it is not a credential of this process's own. See `makeRefusalReporter` and the control
// plane's http/egress_api.ts.
//
// AUTHORIZATION IS THE TOKEN, NEVER REACHABILITY. Under OrbStack docker networks do not isolate
// (measured), so a sibling run's proxy is reachable by IP; the same reason hosted MCP servers
// carry a per-launch caller token beside the network that confines them. A run presents `Proxy-Authorization: Basic <runId:token>` and
// the token is a SIGNED CLAIM carrying that run's allowlist — minted by the control plane at
// launch (packages/orchestrator/src/core/egress.ts), verified here with a shared HMAC key. So
// this process needs no database, no control listener, and no lookup: the request carries the
// policy, and the signature is why the request cannot lie about it.
//
// Basic, not Bearer, because the clients are not ours: `HTTPS_PROXY=http://run:token@proxy:7460`
// is what npm, pip, apt, cargo, go and curl all already understand.
//
// HOSTED MCP SERVERS GET A LISTENER OF THEIR OWN, for a claim of their own. Under docker a hosted
// server sits on an internal network whose only way out is this proxy, reached through an egress
// relay the launcher starts beside it (packages/launcher/src/tools.ts) — the tool host's parity
// with Kubernetes, where a ryph-tools pod reaches the public internet and nothing private. Its
// claim (`t1.…`, minted by the gateway per launch: packages/mcp-gateway/src/core/tool_egress.ts)
// names no hosts and never expires, being bound by a key that only the gateway and this process
// hold; what it grants is the public internet on ANY port, which is what a vendor's MCP server
// needs of it (an API on :8443, a database's own port). What it never grants is the inside:
// every private, loopback, link-local and CGNAT address and every one of this machine's own is
// refused, RYPH_EGRESS_ALLOW_PRIVATE notwithstanding — that switch is an operator's word about
// their runs' allowlist, and a vendor's image is nobody's allowlist. The two kinds of claim never
// cross: separate keys (this refuses to start with one key for both), a version inside the MAC
// that each verifier alone accepts, and a listener per kind, each with the one verifier. A tool
// claim's refusal is reported nowhere but stderr: there is no run to tell, and no allowlist an
// admin could widen. A tool claim does not expire either — a vendor's container is long-lived and
// relaunched only at a gateway's boot — so REVOCATION IS THE KEY: rotate RYPH_EGRESS_TOOL_KEY on
// both ends and restart them, and every claim signed with the old one is a 407 (the binary mints
// a fresh key every boot when it is unset, so its restart is the rotation).
//
// THE RESIDUAL: THIS HOST'S OWN PUBLIC ADDRESS. "Never the inside" is the ranges above plus
// `ownAddresses` — this machine's interfaces. On a cloud VM the public address is often on no
// interface (a 1:1 NAT), and in a container (deploy/compose-networked's egress-proxy service) the
// interfaces are the container's own; either way a tool claim, which may name an IP literal on any
// port, can dial the VM's public address and reach anything on the host bound to 0.0.0.0, past
// the cloud firewall that was keeping the internet off it. Nothing here can learn that address
// reliably, so the operator says it: set RYPH_EGRESS_DENY_CIDRS to this host's public addresses
// on a cloud VM. (A run's claim names hostnames only, so it reaches the same address only through
// an allowlisted name that resolves to it — and the deny list holds there too.)
//
// Configuration, all from env:
//   RYPH_EGRESS_KEY         hex-encoded HMAC key; ≥ 32 hex chars or this refuses to start
//   RYPH_EGRESS_PORT        the listen port, 7460 by default
//   RYPH_EGRESS_TOOL_KEY    hosted servers' key, hex like the other and never equal to it. Unset:
//                           no tool listener, and a hosted server has no way to the internet
//   RYPH_EGRESS_TOOL_PORT   the tool listener's port, 7461 by default
//   RYPH_EGRESS_REPORT_URL  the control plane's origin, for refusal reports. Unset: nothing is
//                           reported and every refusal is this process's stderr again
//   RYPH_EGRESS_DENY_CIDRS  comma-separated CIDRs (v4 and v6) neither listener ever dials,
//                           RYPH_EGRESS_ALLOW_PRIVATE or not. On a cloud VM: this host's public
//                           addresses (see below). A malformed entry refuses to start
//
// The format below is the control plane's, and this program cannot import it — the two are kept
// in step by hand and by the orchestrator's test suite, which drives this file.

import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";

/** The listen port, and the one the run contract names. */
export const DEFAULT_PORT = 7460;

/** The tool listener's port: hosted MCP servers' claims, and nothing else (see the header). */
export const DEFAULT_TOOL_PORT = 7461;

/** Ports a CONNECT may name. 443 is the whole point; 80 is here for plain-http registries that
 * still exist (deb.debian.org among them). Anything else is refused: a proxy that will open an
 * arbitrary port is a tunnel to anywhere the allowlist happens to also resolve. */
const ALLOWED_PORTS = new Set([80, 443]);

/** How long a dial to an allowed host may take before the client is told, rather than hung. */
const DIAL_TIMEOUT_MS = 10_000;

/**
 * Limits, so one run cannot hold what every run shares.
 *
 * This process is a shared listener — a Deployment every run's installs cross on Kubernetes, and
 * in the binary the same process as the control plane, the model proxy and the MCP gateway — and
 * sockets are the resource it runs out of first. Node's own defaults would do most of this, but
 * a posture inherited from a runtime default is one nobody chose: these are stated so that a
 * change in either direction is a decision with a reason next to it.
 *
 * The tunnel timer is INACTIVITY, not lifetime — bytes reset it, so a slow download is fine and
 * a tunnel opened and then abandoned is not. TEN MINUTES OF IT is a long time to hold two
 * sockets, which is why the timers are not the whole story: the two caps below bound how many
 * can be held at once, and `MAX_TUNNELS_PER_RUN` bounds what a SINGLE run can take. Without it
 * a few thousand entirely in-policy CONNECTs to `registry.npmjs.org`, opened and left idle, are
 * every other run's setup failing — a denial of service that never breaks a single rule.
 */
/** How long the ClientHello may take to arrive, and how much of it is read before giving up.
 * A record is capped at 16 KiB by TLS itself; 32 KiB covers a hello split across segments with
 * room to spare, and both bounds exist so that "waiting for the hello" cannot itself become the
 * way to hold a socket open — the failure MAX_TUNNELS_PER_RUN exists to bound. */
const HELLO_TIMEOUT_MS = 10_000;
const HELLO_MAX_BYTES = 32 * 1024;

const HEADERS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 300_000;
const TUNNEL_IDLE_MS = 600_000;
const MAX_CONNECTIONS = 2_000;
const MAX_TUNNELS_PER_RUN = 256;

/**
 * Address ranges an allowed NAME may never resolve to.
 *
 * The allowlist is a list of hostnames, and a hostname's owner chooses what it points at. So
 * `evil.example` in an operator's allowlist — or a hijacked record for one that belongs there —
 * can name `127.0.0.1` and turn this proxy into a way back into the machine it runs on. That is
 * worth closing here rather than only in the network, because the two deployments have very
 * different backstops: on Kubernetes every internet rule already carries this list as its
 * `except` (deploy/helm/ryph/templates/networkpolicies.yaml), while the binary serves this proxy IN
 * PROCESS with the host's full network access and the control plane, model proxy and MCP
 * gateway all listening on loopback.
 *
 * The first six mirror that `except` list exactly, so the boundary reads the same on both. The
 * rest are ranges a Kubernetes pod cannot route to anyway and a laptop very much can.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // carrier-grade NAT, and Alibaba's metadata address inside it
  ["169.254.0.0", 16], // link-local, and AWS's and GCP's metadata address with it
  ["127.0.0.0", 8],
  ["0.0.0.0", 8], // "this network" — reaches the local host on most stacks
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  // Two metadata endpoints that live at ORDINARY-LOOKING addresses rather than in a range
  // anyone would think to block. Same prize as 169.254.169.254 — a credential vendor answering
  // whatever asks it from inside the machine — with nothing about the address to suggest it.
  ["168.63.129.16", 32], // Azure's wireserver
  ["192.0.0.0", 24], // IETF protocol assignments, which is where Oracle's 192.0.0.192 sits
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function refusedV4(v4: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const network = ipv4ToInt(base);
    if (network === null) return false;
    const shift = 32 - bits;
    return (v4 >>> shift) === (network >>> shift);
  });
}

/** An IPv6 address as its 16 bytes, or null when it is not one. Handles `::` and a trailing
 * dotted quad, so every notation below is read the same way. */
function parseIpv6(address: string): Uint8Array | null {
  let text = address.toLowerCase().replace(/%.*$/, ""); // drop any zone id
  if (!text.includes(":")) return null;
  // A trailing dotted quad (`::ffff:127.0.0.1`, `64:ff9b::127.0.0.1`) becomes two hex groups,
  // so the parsing below deals with one notation rather than two.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted !== null) {
    const v4 = ipv4ToInt(dotted[1]);
    if (v4 === null) return null;
    text = text.slice(0, dotted.index) +
      ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = groupsOf(halves[0]);
  const right = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...new Array(missing).fill(0), ...right] : left;
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >>> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/**
 * The IPv4 address an IPv6 one carries inside it, or null when it carries none.
 *
 * There are five ways to write an IPv4 destination as an IPv6 address, and they are all still
 * that IPv4 destination. A guard that knew only the common spelling would be walked straight
 * past by the other four: `::127.0.0.1`, `::ffff:0:127.0.0.1`, `2002:7f00:1::` and
 * `64:ff9b::7f00:1` all mean loopback, and each would otherwise read as "some IPv6 address, not
 * loopback, fine". (NAT64's local-use prefix is refused whole: `localNat64`.)
 */
function embeddedIpv4(bytes: Uint8Array): number | null {
  const zerosUpTo = (upto: number) => bytes.slice(0, upto).every((b) => b === 0);
  const last4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
  // ::ffff:a.b.c.d — IPv4-mapped, which is what a dual-stack lookup hands back.
  if (zerosUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return last4;
  // ::a.b.c.d — IPv4-compatible. Deprecated, and still the v4 address underneath. `::` and
  // `::1` are left to the checks below, being IPv6 addresses in their own right.
  if (zerosUpTo(12) && last4 !== 0 && last4 !== 1) return last4;
  // 2002:a.b.c.d::/16 — 6to4 carries the address in the two groups after the prefix.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
  }
  // ::ffff:0:a.b.c.d (::ffff:0:0/96) — SIIT's IPv4-translated form (RFC 2765), which a
  // translator on the path turns back into that IPv4 destination.
  if (
    zerosUpTo(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0
  ) {
    return last4;
  }
  // 64:ff9b::/96 — NAT64's well-known prefix, the address in the last four bytes.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return last4;
  }
  return null;
}

/**
 * 64:ff9b:1::/48 — NAT64's LOCAL-USE prefix (RFC 8215), refused whole rather than unpacked: an
 * operator picks the prefix length inside it (/48 to /96), and RFC 6052 puts the IPv4 address at
 * a different offset for each, so no one reading says which destination it is. It is a
 * translator inside someone's network by definition, which is reason enough.
 */
function localNat64(bytes: Uint8Array): boolean {
  return bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes[4] === 0x00 && bytes[5] === 0x01;
}

/**
 * Whether a RESOLVED address is one this proxy refuses to dial. Exported for the test.
 *
 * Anything unparseable is refused rather than allowed: a dial target this function cannot read
 * is not a target worth guessing about.
 */
export function addressRefused(address: string): boolean {
  const v4 = ipv4ToInt(address);
  if (v4 !== null) return refusedV4(v4);
  const bytes = parseIpv6(address);
  if (bytes === null) return true; // neither notation: unreadable, so refused
  const embedded = embeddedIpv4(bytes);
  if (embedded !== null) return refusedV4(embedded);
  if (localNat64(bytes)) return true;
  if (bytes.every((b) => b === 0)) return true; // ::
  if (bytes.every((b, i) => b === (i === 15 ? 1 : 0))) return true; // ::1
  if (bytes[0] === 0xff) return true; // multicast ff00::/8
  const first = (bytes[0] << 8) | bytes[1];
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique-local fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  if (first >= 0xfec0 && first <= 0xfeff) return true; // site-local fec0::/10, deprecated, still routed
  return false;
}

/**
 * One RYPH_EGRESS_DENY_CIDRS entry: a prefix over an address's sixteen bytes, an IPv4 one held
 * as its IPv4-mapped form, so one comparison serves both families.
 */
export interface DenyCidr {
  /** As the operator wrote it, for the refusal. */
  text: string;
  bytes: Uint8Array;
  bits: number;
}

/** `a.b.c.d` as `::ffff:a.b.c.d`'s bytes. */
function mappedV4(v4: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[10] = 0xff;
  bytes[11] = 0xff;
  bytes[12] = v4 >>> 24;
  bytes[13] = (v4 >>> 16) & 0xff;
  bytes[14] = (v4 >>> 8) & 0xff;
  bytes[15] = v4 & 0xff;
  return bytes;
}

/** Either family as sixteen bytes, or null when it is neither. */
function addressBytes(address: string): Uint8Array | null {
  const v4 = ipv4ToInt(address);
  return v4 !== null ? mappedV4(v4) : parseIpv6(address);
}

/**
 * RYPH_EGRESS_DENY_CIDRS: comma-separated CIDRs, IPv4 or IPv6, a bare address meaning just it.
 * Throws naming the first entry it cannot read — at boot, loudly, since a deny list that quietly
 * dropped an entry is the boundary an operator thinks they have and do not. Exported for the test.
 *
 * WHY IT EXISTS. `ownAddresses` reads this machine's interfaces, and on a cloud VM the public
 * address is often on none of them (a 1:1 NAT: GCP, AWS) — and inside a container (deploy/
 * compose-networked's egress-proxy) the interfaces are the container's, never the VM's. A
 * hosted server's claim opens every public address on every port, IP literals included, so the
 * VM's own public address is a way past the cloud firewall to anything on the host bound to
 * 0.0.0.0. Nothing here can learn that address reliably; the operator can, and says it here.
 * A run's claim is held to it too (both listeners), though a run names hostnames, not literals.
 */
export function parseDenyCidrs(raw: string): DenyCidr[] {
  const out: DenyCidr[] = [];
  for (const item of raw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const match = item.match(/^([0-9A-Fa-f.:]+)(?:\/(\d{1,3}))?$/);
    const address = match?.[1] ?? "";
    const family = net.isIP(address);
    const bytes = family === 0 ? null : addressBytes(address.toLowerCase());
    const max = family === 4 ? 32 : 128;
    const length = match?.[2] === undefined ? max : Number(match[2]);
    if (bytes === null || length > max) {
      throw new Error(
        `RYPH_EGRESS_DENY_CIDRS: ${JSON.stringify(item)} is not an IPv4 or IPv6 CIDR ` +
          "(10.0.0.0/8, 2001:db8::/32, or a bare address)",
      );
    }
    out.push({ text: item, bytes, bits: family === 4 ? 96 + length : length });
  }
  return out;
}

function inPrefix(bytes: Uint8Array, cidr: DenyCidr): boolean {
  for (let i = 0, bits = cidr.bits; i < 16 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i] & mask) !== (cidr.bytes[i] & mask)) return false;
  }
  return true;
}

/**
 * The deny entry `address` falls in, or null — under every spelling of it: an IPv6 address that
 * carries an IPv4 one (`embeddedIpv4`) is checked as that one as well, so `::ffff:203.0.113.7`
 * and `2002:cb00:7107::` are refused by `203.0.113.7/32`. Exported for the test.
 */
export function deniedBy(address: string, deny: readonly DenyCidr[]): DenyCidr | null {
  if (deny.length === 0) return null;
  const bytes = addressBytes(address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (bytes === null) return null;
  const embedded = embeddedIpv4(bytes);
  const forms = embedded === null ? [bytes] : [bytes, mappedV4(embedded)];
  return deny.find((cidr) => forms.some((form) => inPrefix(form, cidr))) ?? null;
}

const deniedMessage = (host: string, address: string, cidr: DenyCidr) =>
  `${host}${address === host ? "" : ` resolves to ${address}, which`} is in ` +
  `RYPH_EGRESS_DENY_CIDRS (${cidr.text}) — this deployment closed it to the egress proxy`;

/** Why an IP LITERAL target is in the deny list, or null: names are the lookup's to check. */
function deniedLiteral(host: string, deny: readonly DenyCidr[]): string | null {
  const name = host.replace(/^\[|\]$/g, "");
  if (net.isIP(name.replace(/%.*$/, "")) === 0) return null;
  const cidr = deniedBy(name, deny);
  return cidr === null ? null : deniedMessage(host, name, cidr);
}

/**
 * Every address this machine itself answers on, read once.
 *
 * The ranges above catch a run reaching "inside" on a laptop or in a cluster, where the host's
 * own addresses are private anyway. They do not catch a binary running on a cloud VM with a
 * PUBLIC address: a service bound to `0.0.0.0` there answers on that public address exactly as
 * it answers on loopback, so a name resolving to the machine's own address walks around the
 * loopback rule without ever touching a blocked range.
 *
 * Best-effort on purpose. A runtime's permission model may refuse the interface list (Node's
 * `--permission` does not gate it today), and this is one layer of several rather than the
 * boundary itself — so a refusal to answer costs the public-VM case and nothing else, and is
 * not worth refusing to start over.
 */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        const address = String(entry.address).toLowerCase().replace(/%.*$/, "");
        if (address !== "") out.add(address);
      }
    }
  } catch {
    // Left empty: see above.
  }
  return out;
}

/**
 * Names that mean THIS MACHINE (or the container runtime's view of it) whatever they resolve to.
 *
 * `host.docker.internal` is the one that matters most. Under the docker backend a confined run
 * reaches ryph only through the run gate, whose fixed port list is the whole of what it can
 * reach of the host — and this proxy is one of those ports. Asked to dial the host by name, it
 * would be a second door with no list at all. The resolved-address check below usually catches
 * it anyway (these names resolve to loopback or a private address), but "usually" depends on
 * what this machine's resolver says about a name it does not own, so the name is refused first.
 */
const HOST_ALIASES =
  /(^|\.)(localhost|docker\.internal|containers\.internal|orb\.internal|lima\.internal)$/;

/**
 * Why a TARGET, as the client named it, is one this proxy refuses to dial — or null. Exported for
 * the test.
 *
 * Two cases the resolved-address check cannot see. A name from `HOST_ALIASES`, refused before any
 * resolver is asked. And an IP LITERAL: node's `net.connect` skips `lookup` entirely when handed
 * an address, so `guardedLookup` never runs for one and a literal would be dialled unexamined.
 * Allowlists hold hostnames (the control plane refuses an address in one), so a literal reaching
 * here is already refused by `hostAllowed`; this keeps that true should an allowlist ever hold one.
 */
export function inwardRefusal(host: string, own: ReadonlySet<string> = new Set()): string | null {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const inward = HOST_ALIASES.test(name) ||
    (net.isIP(name.replace(/%.*$/, "")) !== 0 && (addressRefused(name) || own.has(name)));
  return inward
    ? `${host} is this machine or an address inside its network — the egress proxy is a way OUT ` +
      `and never a way back in`
    : null;
}

/** `dns.lookup`'s shape: what `guardedLookup` asks before it vetoes. Injected by the test. */
// oxlint-disable-next-line no-explicit-any
export type Resolve = (hostname: string, options: any, callback: any) => void;

/**
 * A `lookup` for node's own dialling, which vetoes the resolved address.
 *
 * Done as the lookup rather than a check before connecting, because that gap is the bug: a name
 * checked and then resolved again by the dial is a name that can answer differently the second
 * time. Here node connects to the address this function returned, so there is no second answer.
 */
function guardedLookup(
  allowPrivate: boolean,
  deny: readonly DenyCidr[] = [],
  resolve: Resolve = dns.lookup,
) {
  const own = allowPrivate ? new Set<string>() : ownAddresses();
  // oxlint-disable-next-line no-explicit-any
  return (hostname: string, options: any, callback: any): void => {
    if (!allowPrivate) {
      const inward = inwardRefusal(hostname, own);
      if (inward !== null) return callback(new Error(inward), undefined, undefined);
    }
    // oxlint-disable-next-line no-explicit-any
    resolve(hostname, options, (err: any, address: any, family: any) => {
      if (err !== null) return callback(err, address, family);
      const list = Array.isArray(address)
        // oxlint-disable-next-line no-explicit-any
        ? (address as any[]).map((a) => String(a.address))
        : [String(address)];
      // The operator's list holds whatever RYPH_EGRESS_ALLOW_PRIVATE says: it is their word too.
      for (const a of list) {
        const cidr = deniedBy(a, deny);
        if (cidr !== null) return callback(new Error(deniedMessage(hostname, a, cidr)));
      }
      if (allowPrivate) return callback(null, address, family);
      const refused = list.find((a) => addressRefused(a) || own.has(a.toLowerCase()));
      if (refused !== undefined) {
        return callback(
          new Error(
            `${hostname} resolves to ${refused}, which is a private, loopback or link-local ` +
              `address — the egress proxy is a way OUT and never a way back in`,
          ),
          address,
          family,
        );
      }
      callback(null, address, family);
    });
  };
}

/**
 * Headers a forward proxy must not pass on (RFC 9110 §7.6.1), plus whatever the client's own
 * `Connection` header names.
 *
 * Forwarding these is how a forward proxy becomes a request-smuggling vector against whatever
 * is upstream: a client-chosen `transfer-encoding` sitting beside the framing node computes for
 * itself is exactly the disagreement between two parsers that smuggling is built out of.
 */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * The client's headers, minus every hop-by-hop one and minus `host`. Exported for the test.
 *
 * `host` GOES TOO, and it is not a hop-by-hop header — it is dropped because keeping it would
 * undo the allowlist. Node only synthesizes a `Host` when the caller's header object has none,
 * so a forwarded one rides the connection this proxy opened to `url.hostname`: `GET
 * http://deb.debian.org/x` with `Host: evil.example` dials the allowlisted host's shared CDN
 * address and asks it for the attacker's vhost. Everything this proxy checked was the URL, and
 * the trail would record the URL's name as the destination. Dropping it lets node write the
 * `Host` that matches the address it actually connected to.
 */
export function forwardableHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const out = { ...headers };
  const named = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "");
  for (const name of [...HOP_BY_HOP, ...named, "host"]) delete out[name];
  return out;
}

/** What a run's token says it may reach. The claim, not a lookup: see the header. */
export interface EgressClaim {
  /** The run this token was minted for — narration and the trail, never authorization. */
  runId: string;
  /** Epoch seconds. A token outliving its run is why this exists at all. */
  expiresAt: number;
  /** Hostnames, already expanded from bundles by the control plane. `*.` prefixes one label
   * or more, so `*.githubusercontent.com` covers `objects.githubusercontent.com`. */
  hosts: string[];
}

function b64urlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded + "=".repeat((4 - padded.length % 4) % 4)), (c) => c.charCodeAt(0)),
  );
}

/** The hex key as bytes, or null when it is not one. Exported for the boot check's message. */
export function keyBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)),
  );
}

/** Constant-time over a fixed length — the tool guard's rule, for the same reason. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * The claim inside a token, or null when the token is not one this key signed.
 *
 * Every failure answers null and nothing says which failure it was: a proxy that distinguished
 * "bad signature" from "expired" from "malformed" would be an oracle for shaping the next
 * attempt. The run sees one 407 whatever went wrong.
 */
export async function verifyToken(
  token: string,
  key: Uint8Array,
  nowSeconds: number,
): Promise<EgressClaim | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [version, payload, signature] = parts;
  const expected = await hmac(key, `${version}.${payload}`);
  const presented = keyBytesFromB64url(signature);
  if (presented === null || !sameBytes(expected, presented)) return null;
  let claim: EgressClaim;
  try {
    const parsed = JSON.parse(b64urlDecode(payload)) as {
      r?: unknown;
      e?: unknown;
      h?: unknown;
    };
    if (
      typeof parsed.r !== "string" || typeof parsed.e !== "number" ||
      !Array.isArray(parsed.h) || !parsed.h.every((h) => typeof h === "string")
    ) {
      return null;
    }
    claim = { runId: parsed.r, expiresAt: parsed.e, hosts: parsed.h as string[] };
  } catch {
    return null;
  }
  // Checked AFTER the signature, so an unsigned payload never reaches a comparison that could
  // be timed, and so an expired token is indistinguishable from a forged one.
  if (claim.expiresAt <= nowSeconds) return null;
  return claim;
}

/** What a hosted server's token says: whose it is, and when it was minted. The claim grants the
 * public internet and nothing narrower, so it carries no hosts (see the header). */
export interface ToolClaim {
  /** The tool container it was minted for — narration and the tunnel cap, never authorization. */
  subject: string;
  /** Epoch seconds, for the trail: the claim does not expire, the key it is signed with does. */
  issuedAt: number;
}

/**
 * The claim inside a hosted server's token (`t1.<payload>.<mac>`), or null when the token is not
 * one this key signed — a run's `v1` token included, whatever key signed it. As `verifyToken`,
 * every failure is the same null.
 */
export async function verifyToolToken(token: string, key: Uint8Array): Promise<ToolClaim | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "t1") return null;
  const [version, payload, signature] = parts;
  const expected = await hmac(key, `${version}.${payload}`);
  const presented = keyBytesFromB64url(signature);
  if (presented === null || !sameBytes(expected, presented)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(payload)) as { s?: unknown; i?: unknown };
    if (typeof parsed.s !== "string" || parsed.s === "" || typeof parsed.i !== "number") {
      return null;
    }
    return { subject: parsed.s, issuedAt: parsed.i };
  } catch {
    return null;
  }
}

function keyBytesFromB64url(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(
      atob(padded + "=".repeat((4 - padded.length % 4) % 4)),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

/**
 * Whether `host` is in `allowed`.
 *
 * Case-insensitive, and a trailing dot is stripped: `REGISTRY.NPMJS.ORG.` is the same name, and
 * a matcher that did not know it would be walked past by anything that appends one. A `*.`
 * entry matches one label or more — never the bare domain, because `*.example.com` is not a
 * grant of `example.com` and a proxy that read it that way would be handing out more than the
 * operator ticked.
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "") return false;
  for (const raw of allowed) {
    const entry = raw.toLowerCase().replace(/\.$/, "");
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (name.endsWith(suffix) && name.length > suffix.length) return true;
      continue;
    }
    if (name === entry) return true;
  }
  return false;
}

/**
 * The SNI server name in a TLS ClientHello, `null` when there is none, or `undefined` when the
 * bytes are not yet a complete ClientHello record.
 *
 * WHY THE PROXY PARSES TLS AT ALL. The CONNECT target is a name the client chose and the proxy
 * checked; the name the client then asks the server for is a SECOND, independent choice, and
 * until this existed nothing compared them. `CONNECT registry.npmjs.org:443` is allowed, the
 * dial lands on the CDN edge that serves it, and the ClientHello inside the tunnel says
 * `exfil.attacker.tld` — a free domain on the same anycast edge — which the edge routes to the
 * attacker's own origin. The allowlist silently degrades to "any host sharing a CDN with an
 * allowlisted one", which for the default bundles is most of the web. Fastly (deb.debian.org)
 * and the pythonhosted edge are the same trick.
 *
 * The SNI is the one field readable here: it is plaintext in the ClientHello because the server
 * needs it before it can choose a certificate. Everything after the hello stays opaque, which is
 * the property this design keeps — no interception, no CA, no bytes seen. Returns `undefined`
 * rather than throwing on a short read so the caller can buffer another segment; a record that
 * parses but carries no server_name is `null`, which is a refusal and not an omission.
 *
 * Exported for the test.
 */
export function parseSni(data: Buffer): string | null | undefined {
  // A TLS record: type(1) version(2) length(2). 0x16 is handshake.
  if (data.length < 5) return undefined;
  if (data[0] !== 0x16) return null;
  const recordLength = data.readUInt16BE(3);
  if (data.length < 5 + recordLength) return undefined;
  let at = 5;
  const end = 5 + recordLength;
  // Handshake: type(1) length(3). 0x01 is client_hello.
  if (at + 4 > end || data[at] !== 0x01) return null;
  at += 4;
  at += 2; // client_version
  at += 32; // random
  if (at >= end) return null;
  const sessionIdLength = data[at];
  at += 1 + sessionIdLength;
  if (at + 2 > end) return null;
  const cipherSuitesLength = data.readUInt16BE(at);
  at += 2 + cipherSuitesLength;
  if (at + 1 > end) return null;
  const compressionLength = data[at];
  at += 1 + compressionLength;
  // No extensions at all is a hello with no SNI, which is a refusal rather than a short read.
  if (at + 2 > end) return null;
  const extensionsLength = data.readUInt16BE(at);
  at += 2;
  const extensionsEnd = Math.min(at + extensionsLength, end);
  while (at + 4 <= extensionsEnd) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    at += 4;
    if (type !== 0x0000) {
      at += length;
      continue;
    }
    // server_name extension: list length(2), then entries of type(1) length(2) name.
    let entry = at + 2;
    const listEnd = Math.min(at + length, extensionsEnd);
    while (entry + 3 <= listEnd) {
      const nameType = data[entry];
      const nameLength = data.readUInt16BE(entry + 1);
      entry += 3;
      if (entry + nameLength > listEnd) return null;
      // 0 is host_name, the only type ever assigned.
      if (nameType === 0) return data.subarray(entry, entry + nameLength).toString("latin1");
      entry += nameLength;
    }
    return null;
  }
  return null;
}

/** `host:port` from a CONNECT target or a Host header, IPv6 literals included. */
export function parseAuthority(authority: string, fallbackPort: number): {
  host: string;
  port: number;
} | null {
  const bracketed = authority.match(/^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/);
  if (bracketed !== null) {
    return { host: bracketed[1], port: Number(bracketed[2] ?? fallbackPort) };
  }
  const match = authority.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/);
  if (match === null) return null;
  const port = Number(match[2] ?? fallbackPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/** The `runId:token` inside a `Proxy-Authorization: Basic …`, or null. */
export function parseProxyAuth(
  header: string | undefined,
): { runId: string; token: string } | null {
  if (header === undefined) return null;
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (match === null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { runId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

/**
 * Why a request is refused, in the words the operator needs — or null when it is allowed.
 *
 * A refusal is LOUD AND NAMES THE FIX, never a timeout. A run that cannot install and does not
 * say why fails a long way from the cause, which is the failure this platform keeps spending
 * effort to remove; reproducing it as a policy outcome would be perverse.
 */
export function refusalFor(
  host: string,
  port: number,
  claim: EgressClaim,
  ports: ReadonlySet<number> = ALLOWED_PORTS,
): string | null {
  if (!ports.has(port)) {
    return `this run may not open port ${port} on ${host} — the egress proxy forwards ` +
      `${[...ports].sort((a, b) => a - b).join(" and ")} only`;
  }
  if (!hostAllowed(host, claim.hosts)) {
    const allowed = claim.hosts.length === 0
      ? "nothing — this run has no egress allowlist at all"
      : claim.hosts.join(", ");
    return `this run may not reach ${host}. Its allowlist is: ${allowed}. Add the bundle that ` +
      `covers it to the agent's network policy, or to the deployment's RYPH_EGRESS_BUNDLES`;
  }
  return null;
}

/**
 * Why a hosted server's claim may not reach `host`, or null: the inside alone (`inwardRefusal`,
 * always strict), since the claim grants every public host on every port. Names resolved here are
 * checked again as the dial resolves them (`guardedLookup`), so this is the literal and alias half.
 * Exported for the test.
 */
export function toolRefusalFor(host: string, own: ReadonlySet<string> = new Set()): string | null {
  return inwardRefusal(host, own);
}

/**
 * Wires a tunnel that is open both ways: what already arrived from the client goes upstream first,
 * then bytes both ways, untouched, until either end closes or the tunnel sits idle.
 */
function splice(client: net.Socket, remote: net.Socket, first: Buffer): void {
  if (first.length > 0) remote.write(first);
  // Either end closing takes the other with it; an error on one must not be an unhandled throw
  // on the process. The client's own handler is already attached, at the top of the handler.
  remote.on("error", () => client.destroy());
  // Inactivity, not lifetime: bytes reset it, so a slow download is untouched while a tunnel
  // opened and then abandoned stops holding a socket.
  const idle = () => {
    client.destroy();
    remote.destroy();
  };
  client.setTimeout(TUNNEL_IDLE_MS, idle);
  remote.setTimeout(TUNNEL_IDLE_MS, idle);
  remote.pipe(client);
  client.pipe(remote);
}

interface Logger {
  refused(fields: Record<string, unknown>): void;
  allowed(fields: Record<string, unknown>): void;
}

/**
 * Tells the control plane which host a subject was refused — the one thing this process sends
 * anywhere of ours.
 *
 * Fire and forget by contract. `report` returns nothing and is never awaited: the request path
 * has already written its 403 by the time it is called, and a control plane that is slow, down
 * or mid-rollout must not be able to make a refusal slower than it already is, let alone hang
 * one. Every failure is swallowed — the stderr line above is still written either way, and it
 * was the whole trail until this existed.
 */
export interface RefusalReporter {
  report(subjectId: string, token: string, host: string, port: number): void;
}

/**
 * How many DISTINCT host:port pairs are remembered, and therefore reported, per claim.
 *
 * The bound that matters, because the caller is a run: a loop that dials a new name per attempt
 * would otherwise be a POST per attempt at the control plane, from a process every run in the
 * deployment shares. Twenty is past what anybody reads and past what the control plane keeps
 * (MAX_EGRESS_REFUSALS, core/egress.ts) — the two caps agree by intent, not by import.
 */
const MAX_REPORTED_PER_SUBJECT = 20;

/**
 * How many claims are remembered at once, oldest evicted first.
 *
 * The dedupe table is the only thing in this process that grows with the number of runs rather
 * than with the number of open sockets, so it needs a ceiling of its own. Evicting the oldest
 * costs a re-report for a subject that has been quiet longer than five hundred others have been
 * seen, which the control plane then dedupes anyway.
 */
const MAX_REPORTED_SUBJECTS = 500;

/** How long a report may take before it is abandoned. Nothing waits on it; this bounds the
 * in-flight requests a stalled control plane could accumulate. */
const REPORT_TIMEOUT_MS = 5_000;

/**
 * The reporter, over HTTP to the control plane.
 *
 * `ended` is why the answer is read at all: a 410 says the run concluded or the build settled,
 * so the subject is written off and nothing more is sent for it — which is what keeps a
 * container that keeps retrying after its run is over from reporting forever. Any other answer,
 * and any failure, is ignored: this is a diagnostic channel, and a retry queue here would be a
 * queue on the byte path of every install in the deployment.
 */
export function makeRefusalReporter(
  reportUrl: string,
  opts: {
    fetch?: typeof globalThis.fetch;
    maxPerSubject?: number;
    maxSubjects?: number;
    timeoutMs?: number;
  } = {},
): RefusalReporter {
  const send = opts.fetch ?? globalThis.fetch;
  const maxPerSubject = opts.maxPerSubject ?? MAX_REPORTED_PER_SUBJECT;
  const maxSubjects = opts.maxSubjects ?? MAX_REPORTED_SUBJECTS;
  const timeoutMs = opts.timeoutMs ?? REPORT_TIMEOUT_MS;
  const endpoint = `${reportUrl.replace(/\/+$/, "")}/v1/egress/refusals`;
  // Insertion-ordered, which is what makes the eviction below a FIFO without a second structure.
  const seen = new Map<string, { hosts: Set<string>; ended: boolean }>();
  return {
    report(subjectId, token, host, port) {
      let entry = seen.get(subjectId);
      if (entry === undefined) {
        if (seen.size >= maxSubjects) {
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
        entry = { hosts: new Set(), ended: false };
        seen.set(subjectId, entry);
      }
      if (entry.ended) return;
      const key = `${host.toLowerCase()}:${port}`;
      if (entry.hosts.has(key)) return;
      if (entry.hosts.size >= maxPerSubject) return;
      entry.hosts.add(key);
      const held = entry;
      void (async () => {
        try {
          const answer = await send(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // The subject's own claim, handed back to the party that minted it. This process
              // has no credential of its own and must not acquire one.
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ host, port }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          // Drain, so a kept-alive connection is released rather than left half-read.
          await answer.body?.cancel();
          if (answer.status === 410) held.ended = true;
        } catch {
          // Swallowed on purpose: see the docstring. The stderr line is still the trail.
        }
      })();
    },
  };
}

const consoleLogger: Logger = {
  // stderr, so stdout carries nothing an operator has to filter.
  refused: (fields) => console.error(`egress: refused ${JSON.stringify(fields)}`),
  allowed: (fields) => console.error(`egress: allowed ${JSON.stringify(fields)}`),
};

export interface ProxyOptions {
  key: Uint8Array;
  /**
   * Which claims this listener takes: a run's (`v1`, its allowlist; the default) or a hosted
   * server's (`t1`, the public internet on any port — see the header). One kind per listener, so
   * a token of the other kind is the same 407 as no token at all. A tool listener dials strictly
   * whatever `allowPrivate` says, opens no SNI check (there is no allowlist for the hello to
   * disagree with) and reports nothing.
   */
  claims?: "run" | "tool";
  now?: () => number;
  log?: Logger;
  /**
   * Dial private, loopback and link-local addresses too — on a run listener only. Off, because an allowlisted NAME whose
   * record points inside the network is the way this proxy would otherwise become a route back
   * in — see `addressRefused`. On, it is the operator saying their allowlist names an internal
   * mirror on purpose, which is the same bargain `RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS` offers the
   * gateway, and it is logged at boot for the same reason.
   */
  allowPrivate?: boolean;
  /**
   * RYPH_EGRESS_DENY_CIDRS, parsed (`parseDenyCidrs`): addresses neither listener ever dials,
   * RYPH_EGRESS_ALLOW_PRIVATE or not — checked as the dial resolves a name, and on a literal.
   */
  deny?: readonly DenyCidr[];
  /** Injected by the test; defaults to a real TCP dial. */
  dial?: (host: string, port: number) => Promise<net.Socket>;
  /** Injected by the test, so a name can resolve inside without a resolver; `dns.lookup`. */
  resolve?: Resolve;
  /** The ports a run's claim may name; the test widens it past 80 and 443 to reach a loopback
   * upstream. Never set outside a test. */
  ports?: ReadonlySet<number>;
  /** Process-wide accepted-socket ceiling; the test lowers it. */
  maxConnections?: number;
  /** Open tunnels one run id may hold at once; the test lowers it. */
  maxTunnelsPerRun?: number;
  /** How long the ClientHello may take to arrive; the test lowers it. */
  helloTimeoutMs?: number;
  /**
   * Where a refused host is reported. Absent: nothing is reported, which is what this process
   * did before the channel existed and what it still does on a deployment that has not wired
   * `RYPH_EGRESS_REPORT_URL`.
   */
  report?: RefusalReporter;
}

function realDial(allowPrivate: boolean, deny: readonly DenyCidr[], resolve?: Resolve) {
  const lookup = guardedLookup(allowPrivate, deny, resolve);
  return (host: string, port: number): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      // oxlint-disable-next-line no-explicit-any
      const socket = net.connect({ host, port, lookup } as any);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out after ${DIAL_TIMEOUT_MS}ms`));
      }, DIAL_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

/** One refusal, written to a raw socket in the shape a CONNECT client understands. */
function writeStatus(socket: net.Socket, status: number, reason: string, body: string): void {
  // The client this refuses may already be gone — a run that opens a tunnel and resets is the
  // ordinary case here, not an exotic one. Writing to a destroyed socket raises `error`, and on
  // this path that is the very event the handler above exists to keep off the process.
  if (socket.destroyed || socket.writableEnded) return;
  const payload = JSON.stringify({ error: body });
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(payload)}\r\n` +
      // Without this a client keeps the tunnel open waiting for bytes that never come — the
      // timeout this whole design exists to avoid.
      `connection: close\r\n` +
      (status === 407 ? `proxy-authenticate: Basic realm="ryph"\r\n` : "") +
      `\r\n${payload}`,
  );
  socket.end();
}

export function makeProxy(opts: ProxyOptions): http.Server {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const log = opts.log ?? consoleLogger;
  const tool = opts.claims === "tool";
  // Never on a tool listener: see `ProxyOptions.allowPrivate`.
  const allowPrivate = !tool && (opts.allowPrivate ?? false);
  const deny = opts.deny ?? [];
  const dial = opts.dial ?? realDial(allowPrivate, deny, opts.resolve);
  const lookup = guardedLookup(allowPrivate, deny, opts.resolve);
  const own = allowPrivate ? new Set<string>() : ownAddresses();
  /** `inwardRefusal`, unless the operator opened the inside on purpose (RYPH_EGRESS_ALLOW_PRIVATE). */
  const inward = (host: string) => allowPrivate ? null : inwardRefusal(host, own);
  const report = tool ? null : (opts.report ?? null);
  /**
   * The token verified as this listener's kind, as one shape: who it is (the tunnel cap's key and
   * the trail's), and a run's claim, or null for a hosted server's.
   */
  const verify = async (
    token: string,
  ): Promise<{ subject: string; run: EgressClaim | null } | null> => {
    if (tool) {
      const claim = await verifyToolToken(token, opts.key);
      return claim === null ? null : { subject: claim.subject, run: null };
    }
    const claim = await verifyToken(token, opts.key, now());
    return claim === null ? null : { subject: claim.runId, run: claim };
  };
  /** Why `host:port` is refused to this claim: a run's allowlist and ports, or for a hosted
   * server only the inside (`toolRefusalFor`). */
  const refuse = (host: string, port: number, run: EgressClaim | null) =>
    (run === null
      ? toolRefusalFor(host, own)
      : (refusalFor(host, port, run, opts.ports) ?? inward(host))) ??
      // A literal skips the lookup (see `inwardRefusal`), so the deny list is checked here too.
      deniedLiteral(host, deny);
  /**
   * Reports a refusal, but only the kind that has a remedy.
   *
   * A HOST the claim does not carry is a gap in somebody's allowlist, and naming it is the whole
   * point. A refused PORT on a host that IS allowed is not — the proxy forwards 80 and 443 and
   * that is not an allowlist an admin can widen — so reporting it would put a line in a run's
   * trail whose remedy does not exist. Same for an SNI that disagrees with the CONNECT target:
   * that is a tunnel being aimed somewhere else, and the honest place for it is the refusal log.
   */
  const reportRefusal = (claim: EgressClaim, token: string, host: string, port: number) => {
    if (report === null) return;
    if (hostAllowed(host, claim.hosts)) return;
    report.report(claim.runId, token, host, port);
  };
  const server = http.createServer();
  // Stated rather than inherited — see the constants. A run that opens a socket and sends no
  // request line is otherwise holding a slot on the one listener every other run shares.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  // The process-wide ceiling. Node refuses past this by CLOSING the accepted socket, which is
  // the honest answer when there is no request to answer yet — and it is what keeps a flood
  // from being an EMFILE that takes the control plane down beside it in the binary.
  server.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;

  // Open tunnels per run id, so one run's share of that ceiling is bounded before the ceiling
  // is reached. Keyed on the CLAIM's run id rather than the socket's peer: on Kubernetes every
  // run dials from a different pod, and in the binary they all dial from the same host.
  const tunnels = new Map<string, number>();
  const maxPerRun = opts.maxTunnelsPerRun ?? MAX_TUNNELS_PER_RUN;
  const helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const release = (runId: string) => {
    const held = (tunnels.get(runId) ?? 1) - 1;
    if (held <= 0) tunnels.delete(runId);
    else tunnels.set(runId, held);
  };

  // CONNECT: the tunnel, and the only path that matters for https. The socket is taken over
  // raw — nothing here parses, rewrites or even sees what crosses it once the tunnel is open.
  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    // BEFORE ANYTHING ELSE, and before the first await. Node hands the CONNECT socket over with
    // its own error handler removed, so from this line on it is ours — and in node an `error`
    // on an emitter with no listener is not a rejected promise, it is a throw that ends the
    // process. Every step below sits inside that window: a client that resets while its token
    // is verified, while the dial is in flight, or immediately after being told 407/403/400/502.
    // Those refusal paths are the ones an adversarial run reaches deliberately, and this process
    // is a single replica shared by every run — in the single binary, shared with the control
    // plane, the model proxy and the MCP gateway as well.
    let upstream: net.Socket | null = null;
    clientSocket.on("error", () => {
      clientSocket.destroy();
      upstream?.destroy();
    });
    void (async () => {
      const auth = parseProxyAuth(req.headers["proxy-authorization"]);
      const verified = auth === null ? null : await verify(auth.token);
      if (auth === null || verified === null) {
        log.refused({ target: req.url, reason: "unauthorized" });
        writeStatus(clientSocket, 407, "Proxy Authentication Required", "unauthorized");
        return;
      }
      const { subject, run: claim } = verified;
      const target = parseAuthority(req.url ?? "", 443);
      if (target === null) {
        writeStatus(clientSocket, 400, "Bad Request", `not a CONNECT target: ${req.url}`);
        return;
      }
      const refusal = refuse(target.host, target.port, claim);
      if (refusal !== null) {
        log.refused({
          [claim === null ? "tool" : "runId"]: subject,
          host: target.host,
          port: target.port,
        });
        writeStatus(clientSocket, 403, "Forbidden", refusal);
        // AFTER the answer, and not awaited: the client has its 403 either way.
        if (claim !== null) reportRefusal(claim, auth.token, target.host, target.port);
        return;
      }
      let remote: net.Socket;
      try {
        remote = await dial(target.host, target.port);
      } catch (err) {
        writeStatus(
          clientSocket,
          502,
          "Bad Gateway",
          `${target.host}:${target.port} did not answer: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return;
      }
      upstream = remote;
      // The client can have gone while we dialled. Without this the tunnel is wired to a corpse
      // and the upstream socket is held until it times out on its own.
      if (clientSocket.destroyed) {
        remote.destroy();
        return;
      }
      // Counted only now, once there is a tunnel to count: everything above answers and
      // returns, so a run cannot spend its share on refusals.
      const held = tunnels.get(subject) ?? 0;
      if (held >= maxPerRun) {
        log.refused({ subject, host: target.host, reason: "too_many_tunnels" });
        writeStatus(
          clientSocket,
          429,
          "Too Many Requests",
          `this ${claim === null ? "hosted server" : "run"} already holds ${held} open tunnels ` +
            `through the egress proxy, which is its ` +
            `limit — the proxy is shared by every run in this deployment. Close connections, ` +
            `or install with less concurrency`,
        );
        remote.destroy();
        return;
      }
      tunnels.set(subject, held + 1);
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        release(subject);
      };
      clientSocket.once("close", releaseOnce);
      remote.once("close", releaseOnce);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // A hosted server's tunnel is opaque from its first byte: its claim grants every public
      // host, so there is no allowlist for an SNI to disagree with, and the resolved address
      // (checked as the dial's lookup) is the whole of its policy. Nor need it be TLS at all.
      if (claim === null) {
        log.allowed({ tool: subject, host: target.host, port: target.port });
        splice(clientSocket, remote, head ?? Buffer.alloc(0));
        return;
      }
      // THE SECOND NAME. The target above was checked; the name the client asks the server for
      // is a separate choice, and a CDN edge routes by it. So the ClientHello is read before a
      // byte reaches the upstream, and the tunnel opens only if its SNI both sits in this run's
      // allowlist AND is the host this connection was dialled for. See `parseSni`.
      //
      // `head` is whatever arrived after the CONNECT line before we answered; the rest comes off
      // the client socket. Nothing is written upstream until the hello is whole, and nothing
      // after the hello is looked at again — the tunnel stays opaque, as it must.
      let hello: Buffer = head !== undefined && head.length > 0 ? head : Buffer.alloc(0);
      let sni = parseSni(hello);
      if (sni === undefined) {
        sni = await new Promise<string | null | undefined>((resolve) => {
          const done = (answer: string | null | undefined) => {
            clearTimeout(timer);
            clientSocket.off("data", onData);
            resolve(answer);
          };
          const timer = setTimeout(() => done(undefined), helloTimeoutMs);
          const onData = (chunk: Buffer) => {
            hello = Buffer.concat([hello, chunk]);
            // Bounded, so a client that dribbles bytes forever is not holding a socket for free.
            if (hello.length > HELLO_MAX_BYTES) return done(null);
            const parsed = parseSni(hello);
            if (parsed !== undefined) done(parsed);
          };
          clientSocket.on("data", onData);
        });
      }
      if (sni === undefined) {
        log.refused({ runId: subject, host: target.host, reason: "no_client_hello" });
        clientSocket.destroy();
        remote.destroy();
        return;
      }
      const name = sni === null ? null : sni.toLowerCase().replace(/\.$/, "");
      if (
        name === null || name !== target.host.toLowerCase().replace(/\.$/, "") ||
        !hostAllowed(name, claim.hosts)
      ) {
        log.refused({
          runId: subject,
          host: target.host,
          sni: name ?? "(none)",
          reason: "sni_mismatch",
        });
        // The 200 is already sent, so there is no status left to write: the client is inside a
        // tunnel that will not carry anything. Closing both ends is the whole answer, and the
        // trail above is where an operator reads why.
        clientSocket.destroy();
        remote.destroy();
        return;
      }
      log.allowed({ runId: subject, host: target.host, port: target.port, sni: name });
      splice(clientSocket, remote, hello);
    })().catch((err) => {
      // Nothing above is expected to reject — every failure it anticipates answers with a
      // status. This exists because an unhandled rejection inside a handler is the same
      // process-level crash by a quieter route, and one run must not be able to end every
      // other run's.
      log.refused({ target: req.url, reason: "internal", detail: String(err) });
      clientSocket.destroy();
      upstream?.destroy();
    });
  });

  // Plain http, for the registries that still serve it. Same gate, one hop, no rewriting beyond
  // the hop-by-hop header a forward proxy must not pass on.
  server.on("request", (req, res) => {
    void (async () => {
      const auth = parseProxyAuth(req.headers["proxy-authorization"]);
      const verified = auth === null ? null : await verify(auth.token);
      if (auth === null || verified === null) {
        log.refused({ target: req.url, reason: "unauthorized" });
        res.writeHead(407, {
          "content-type": "application/json",
          "proxy-authenticate": 'Basic realm="ryph"',
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // An absolute-form request line is what a proxy gets; anything else is a client that did
      // not mean to talk to a proxy at all, and there is nothing useful to do with it.
      //
      // `https:` is REFUSED here rather than downgraded, which is the whole reason the check is
      // spelled this way. An https origin is reached through CONNECT; a request arriving on
      // THIS path naming one would be forwarded as plaintext to port 443 carrying whatever
      // headers the client attached — an `Authorization:` among them. Nothing legitimate takes
      // that route, so closing it costs nothing and leaving it open would be a downgrade this
      // proxy performed on its own client's behalf.
      const url = URL.parse(req.url ?? "");
      if (url === null || url.protocol !== "http:") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: url?.protocol === "https:"
            ? "the egress proxy does not forward absolute https: requests — an https origin is " +
              "reached through CONNECT, and forwarding this would be a plaintext hop to :443"
            : "the egress proxy takes absolute-form http requests only",
        }));
        return;
      }
      const { subject, run: claim } = verified;
      const who = { [claim === null ? "tool" : "runId"]: subject };
      const port = Number(url.port || 80);
      const refusal = refuse(url.hostname, port, claim);
      if (refusal !== null) {
        log.refused({ ...who, host: url.hostname, port });
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: refusal }));
        if (claim !== null) reportRefusal(claim, auth.token, url.hostname, port);
        return;
      }
      log.allowed({ ...who, host: url.hostname, port });
      const upstream = http.request({
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: forwardableHeaders(req.headers),
        lookup,
        // NEVER POOLED. Node's (and bun's) global agent keeps sockets alive keyed by host:port,
        // not by the lookup that vetted them — and both listeners share this process (the
        // image's main below, the binary's). A run's listener with RYPH_EGRESS_ALLOW_PRIVATE
        // would leave a socket to a private address that a hosted server's request for the same
        // host:port reuses, never asking the guarded lookup. A fresh socket per forward is the
        // price of the lookup meaning anything, and plain http here is rare (CONNECT is the path).
        agent: false,
        // oxlint-disable-next-line no-explicit-any
      } as any, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", (err) => {
        // Once the response has begun there is no status left to send: writing a second head
        // would throw, which on this path means taking the process with it.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `${url.hostname} did not answer: ${err.message}` }));
      });
      req.pipe(upstream);
    })().catch(() => {
      // Same reasoning as the CONNECT path's: an unhandled rejection here is a process-level
      // crash, and node's server owning this socket does not make the rejection safe.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the egress proxy failed to handle this request" }));
    });
  });

  return server;
}

if (import.meta.main) {
  const hex = process.env.RYPH_EGRESS_KEY ?? "";
  const key = keyBytes(hex);
  if (key === null || key.length < 16) {
    // Never echoes the value.
    console.error(
      "egress: RYPH_EGRESS_KEY must be at least 32 hex characters — refusing to start",
    );
    process.exit(2);
  }
  const port = Number(process.env.RYPH_EGRESS_PORT ?? String(DEFAULT_PORT));
  const allowPrivate = /^(1|true|on|yes)$/i.test(
    process.env.RYPH_EGRESS_ALLOW_PRIVATE?.trim() ?? "",
  );
  if (allowPrivate) {
    console.error(
      "egress: RYPH_EGRESS_ALLOW_PRIVATE — an allowlisted name may resolve to a private, " +
        "loopback or link-local address",
    );
  }
  let deny: DenyCidr[];
  try {
    deny = parseDenyCidrs(process.env.RYPH_EGRESS_DENY_CIDRS ?? "");
  } catch (err) {
    console.error(`egress: ${err instanceof Error ? err.message : err} — refusing to start`);
    process.exit(2);
  }
  if (deny.length > 0) {
    console.error(`egress: never dialling ${deny.map((c) => c.text).join(", ")}`);
  }
  // A backstop, and deliberately only in the STANDALONE process. Every path above owns its own
  // sockets; this catches the one nobody predicted rather than excusing it. `makeProxy` does
  // not install it, because in the single binary that call shares a process with the control
  // plane — and swallowing everyone else's fatal errors is not the proxy's decision to take on
  // their behalf.
  process.on("uncaughtException", (err) => {
    console.error(`egress: uncaught ${err instanceof Error ? err.stack ?? err.message : err}`);
  });
  // As a container's PID 1 this process has no default action for a signal it does not handle,
  // so without these a stop waits out the whole grace period and ends in SIGKILL. Exits at once
  // rather than draining: a tunnel lives as long as its install does, so a drain would only wait
  // out the same grace period.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }
  // Where a refused host goes. Unset is a supported deployment and not a half-wired one: the
  // single binary serves the control plane in the same process, and a self-hoster who has not
  // set it keeps exactly the behaviour this process had before the channel existed.
  const reportUrl = process.env.RYPH_EGRESS_REPORT_URL?.trim().replace(/\/+$/, "") || null;
  if (reportUrl !== null && !URL.canParse(reportUrl)) {
    console.error(
      `egress: RYPH_EGRESS_REPORT_URL must be an absolute URL, got ${JSON.stringify(reportUrl)}`,
    );
    process.exit(2);
  }
  if (reportUrl === null) {
    console.error(
      "egress: RYPH_EGRESS_REPORT_URL unset — refusals are logged here and nowhere else, so a " +
        "run that cannot reach a host, and a build that ships an image missing one, both say " +
        "only that something failed",
    );
  }
  makeProxy({
    key,
    allowPrivate,
    deny,
    report: reportUrl === null ? undefined : makeRefusalReporter(reportUrl),
  }).listen(port, "0.0.0.0", () => {
    console.error(`egress: listening on :${port}`);
  });
  // Hosted servers' listener, on a key of its own (see the header). Unset is a deployment that
  // hosts nothing through this proxy, and a hosted server there has no way out at all.
  const toolHex = process.env.RYPH_EGRESS_TOOL_KEY?.trim() ?? "";
  if (toolHex !== "") {
    const toolKey = keyBytes(toolHex);
    if (toolKey === null || toolKey.length < 16) {
      console.error(
        "egress: RYPH_EGRESS_TOOL_KEY must be at least 32 hex characters — refusing to start",
      );
      process.exit(2);
    }
    // One key for both kinds would let either listener's verifier stand in for the other's
    // minter: a version check would be all that kept a hosted server's claim off a run's door.
    if (toolHex.toLowerCase() === hex.trim().toLowerCase()) {
      console.error(
        "egress: RYPH_EGRESS_TOOL_KEY must differ from RYPH_EGRESS_KEY — refusing to start",
      );
      process.exit(2);
    }
    const toolPort = Number(process.env.RYPH_EGRESS_TOOL_PORT ?? String(DEFAULT_TOOL_PORT));
    if (allowPrivate) {
      console.error(
        `egress: RYPH_EGRESS_ALLOW_PRIVATE does not apply to the tool listener on :${toolPort} — ` +
          "a hosted server never reaches a private, loopback or link-local address",
      );
    }
    makeProxy({ key: toolKey, claims: "tool", deny }).listen(toolPort, "0.0.0.0", () => {
      console.error(`egress: listening on :${toolPort} for hosted MCP servers`);
    });
  }
}
