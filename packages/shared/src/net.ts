// What an address IS: parsing an IP literal, telling a globally routable address from one that
// reaches inward, and telling this machine's loopback from everything else. The services that
// dial an address somebody else chose (web__fetch, the MCP gateway's upstreams, memory's URL
// fetcher, the egress proxy) all ask the first question, and an answer that differs between two
// of them is a door one of them leaves open. So there is one rule, and it is the strictest union
// of the copies it replaced: nothing any of them refused is allowed here.
//
// The rule, in order:
// - unparseable is blocked: an address this cannot read is not provably public. A zone id
//   (`fe80::1%eth0`) is refused outright, as is an IPv4 octet with a leading zero (`010.0.0.1`
//   means 8.0.0.1 to some parsers and 10.0.0.1 to others).
// - IPv4 is judged against a denylist of every non-public block, plus the cloud metadata
//   endpoints that sit at ordinary-looking addresses (Azure's wireserver, Oracle's in 192.0.0/24).
// - IPv6 is an ALLOWLIST: global unicast 2000::/3 and nothing else, minus the special blocks inside
//   it (Teredo and the IETF assignments, documentation, 6to4). Everything outside — ::, ::1, ULA,
//   link-local, site-local, multicast, NAT64 both well-known and local-use, SIIT, the IPv4-
//   compatible form — is refused wholesale rather than listed.
// - an IPv4-mapped address (`::ffff:a.b.c.d`, or `::ffff:a00:1` as a URL parser writes it) is a
//   dual-stack spelling of that IPv4 destination, so it is judged as that IPv4 address. The other
//   forms that wrap an IPv4 address (compatible, NAT64, SIIT, 6to4) stay refused even around a
//   public one: each needs a translator on the path, which is somebody's network by definition.
//
// This judges an address. Resolving a name, and the window between a check and a connect (DNS
// rebinding), stay with the caller.

export type ParsedIp = { v: 4; octets: number[] } | { v: 6; groups: number[] };

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(text: string): number[] | null {
  const m = text.match(V4);
  if (!m) return null;
  const parts = m.slice(1);
  if (parts.some((p) => p.length > 1 && p.startsWith("0"))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function parseV6(text: string): number[] | null {
  if (text.length > 45 || text.includes("%")) return null;
  let hex = text.toLowerCase();
  // A trailing dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) becomes its two groups first,
  // so the parse below deals with one notation rather than two.
  const tail = hex.match(/^(.*:)([^:]*\.[^:]*)$/);
  if (tail) {
    const octets = parseV4(tail[2]!);
    if (octets === null) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    hex = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = hex.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]!);
  const rest = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/**
 * An IPv4 dotted quad or an IPv6 literal (`::` expanded, a dotted tail folded in, brackets
 * allowed); null for a hostname, a zone id, or anything malformed.
 */
export function parseIp(host: string): ParsedIp | null {
  const text = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const octets = parseV4(text);
  if (octets !== null) return { v: 4, octets };
  if (!text.includes(":")) return null;
  const groups = parseV6(text);
  return groups === null ? null : { v: 6, groups };
}

function blockedV4([a, b, c, d]: number[] = []): boolean {
  if (a === undefined || b === undefined || c === undefined || d === undefined) return true;
  return a === 0 || // 0.0.0.0/8 "this network", which reaches the local host on most stacks
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT, Alibaba's metadata inside it
    (a === 169 && b === 254) || // link-local: 169.254.169.254 is AWS's and GCP's metadata server
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 168 && b === 63 && c === 129 && d === 16) || // Azure's wireserver
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF assignments, Oracle's 192.0.0.192
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224; // multicast, reserved, broadcast
}

/** The IPv4 address an IPv4-mapped IPv6 one (`::ffff:a.b.c.d`, ::ffff:0:0/96) stands for, or
 * null. */
function mappedV4(groups: number[]): number[] | null {
  if (!groups.slice(0, 5).every((g) => g === 0) || groups[5] !== 0xffff) return null;
  const hi = groups[6]!;
  const lo = groups[7]!;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * Anything not globally routable: loopback, unspecified, private, link-local (the cloud metadata
 * addresses included), CGNAT, the documentation and benchmarking ranges, multicast, reserved,
 * every IPv6 address outside global unicast. An address this cannot parse is refused too.
 */
export function isBlockedAddress(addr: string): boolean {
  const ip = parseIp(addr);
  if (ip === null) return true;
  if (ip.v === 4) return blockedV4(ip.octets);
  const mapped = mappedV4(ip.groups);
  if (mapped !== null) return blockedV4(mapped);
  const [g0 = 0, g1 = 0] = ip.groups;
  // Global unicast is 2000::/3; everything outside it is refused wholesale (see the header).
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23 IETF protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x2002) return true; // 2002::/16 6to4, which wraps an arbitrary IPv4
  if (g0 === 0x3fff && g1 < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

/**
 * Whether a host names this machine's loopback: `localhost` and any `*.localhost`, 127.0.0.0/8,
 * `::1`, and 127/8 IPv4-mapped (`::ffff:127.0.0.1`, as a dual-stack socket names its peer).
 * Brackets, case and surrounding blanks are ignored.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const ip = parseIp(h);
  if (ip === null) return false;
  if (ip.v === 4) return ip.octets[0] === 127;
  if (ip.groups.every((g, i) => g === (i === 7 ? 1 : 0))) return true;
  return mappedV4(ip.groups)?.[0] === 127;
}
