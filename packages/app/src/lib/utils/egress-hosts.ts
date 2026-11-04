// The two host rules every egress form needs: how a typed list becomes hostnames, and why one
// of them is not a hostname at all.
//
// Lives in $lib rather than beside one form because there are two — an agent narrowing what it
// may reach, and an admin setting what this deployment allows at all — and they have to judge a
// hostname identically. A form that judged it differently from the API would submit an entry the
// API then refuses with a zod 400, which surfaces as a generic "something went wrong" rather
// than as the named, actionable refusal these exist to produce.

/** The hosts as typed: trimmed, blanks dropped, each once (the first spelling wins). */
export function parseHosts(hosts: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hosts.split(",")) {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/**
 * Why a hostname is not one an allowlist may name — or null when it is.
 *
 * A fourth copy of a rule kept in step by hand, for the reason the file header gives: the form
 * cannot import the orchestrator, and a form that judged this differently from the API would
 * submit an entry the API's schema then rejects with a zod 400, which surfaces as a generic
 * "something went wrong" rather than as the named, actionable refusal this bridge exists to
 * produce. `hostCovered` below answers a different question — whether the ceiling grants it —
 * and an entry has to pass both.
 *
 * Deliberately NOT a URL, a port or an address: a scheme would silently never match (the proxy
 * compares the CONNECT authority) and a CIDR would be the IP-layer fiction the design refuses.
 */
export function hostGrammarProblem(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name === "") return "A hostname cannot be blank.";
  if (name.length > 253) return `${host} is longer than a hostname may be.`;
  const body = name.startsWith("*.") ? name.slice(2) : name;
  if (body === "") return `${host} names every host — a wildcard needs a domain under it.`;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(body)) {
    return `${host} is not a hostname. An allowlist names hosts — never a URL, a port or an ` +
      `address.`;
  }
  if (!body.includes(".")) {
    return `${host} is a single label. An allowlist names a full hostname, like ` +
      `registry.npmjs.org.`;
  }
  // An address, not a name: `127.0.0.1` passes every rule above. No real TLD is all digits,
  // which makes the rightmost label the whole test.
  if (/^\d+$/.test(body.slice(body.lastIndexOf(".") + 1))) {
    return `${host} is an address. An allowlist names hosts, and the proxy compares the name a ` +
      `run asked for.`;
  }
  return null;
}
