// Egress: what a run may reach on the open internet, and the rules that turn an operator's
// ceiling and an agent's blueprint into one frozen allowlist. Pure — the key arrives as bytes,
// the policy as a value, the clock as an argument, and nothing here reads a file or an env var.
//
// The shape of the problem, and why this file exists at all:
//
// - A HOST ALLOWLIST CANNOT BE ENFORCED AT THE IP LAYER. `registry.npmjs.org` is Cloudflare, so
//   an `ipBlock` naming it would read like a boundary and be a fiction. The enforcement point
//   has to be a forward proxy that sees the requested NAME — images/egress-proxy/main.ts.
// - That proxy needs no database and no control listener, because the run's token IS the
//   policy: a signed claim minted here at launch, carrying the run id, an expiry and the
//   expanded host list. `mintEgressToken` below writes it; the proxy verifies it with the same
//   key and never asks us anything.
// - An operator vouches for a BUNDLE (`npm`, `pypi`) and the catalogue expands it into the hosts
//   that registry actually uses. `registry.npmjs.org` alone does not survive first contact with
//   a tarball fetch, and finding that out from a hung `npm ci` is the experience this catalogue
//   exists to prevent. core/services.ts and the gateway's catalogue.ts encode the same instinct
//   for the same reason; this is their sibling, not their subclass.
//
// Invariants:
// - the agent NARROWS, never widens. A blueprint may name a subset of the deployment's bundles
//   and hosts and nothing else; the ceiling is the operator's and no policy can move it
// - the REPO gets no say at all. `.ryph/services.yml` is read through the forge because a repo
//   cannot be trusted with its own confinement, and the argument is strictly stronger here: a
//   repo asking for egress is the exfiltration channel filing a request for itself
// - every refusal names the fix, and nothing is silently dropped — including the refusals the
//   PROXY makes, which travel back here and are worded against this catalogue (see
//   core/egress_refusals.ts and http/egress_api.ts). A host nobody hears about is the same
//   failure as a host nobody named

/** Whether this deployment enforces anything, and how. */
export type EgressMode =
  /** No enforcement claimed. What every backend did before this existed. */
  | "open"
  /** Runs reach the internet through the egress proxy, and only the allowlist. */
  | "proxy";

/**
 * One bundle: a name an operator vouches for, and the hosts that registry actually uses.
 *
 * `hosts` may carry a `*.` prefix, which matches one label or more and never the bare domain.
 * That is not laziness about CDNs — it is the only honest way to write `githubusercontent.com`,
 * whose asset hostnames are generated per release.
 */
export interface EgressBundle {
  id: string;
  name: string;
  description: string;
  hosts: string[];
}

/**
 * The catalogue. Each entry is the digest of institutional knowledge nobody should rediscover
 * per deployment: what breaks is never the registry's front door, it is the redirect target the
 * front door hands back.
 */
export const EGRESS_BUNDLES: readonly EgressBundle[] = [
  {
    id: "npm",
    name: "npm",
    description: "The npm registry and the tarballs it redirects to.",
    hosts: ["registry.npmjs.org", "registry.yarnpkg.com"],
  },
  {
    id: "deno",
    name: "Deno & JSR",
    description:
      "JSR, the URL registry, and the CDN a Deno RELEASE comes from — `dl.deno.land`, which is " +
      "where mise or `deno upgrade` fetches a pinned version, not just where modules live. " +
      "`npm.jsr.io` is how a package manager other than Deno reaches the same packages, and a " +
      "JSR module's npm dependencies come from the `npm` bundle.",
    hosts: ["jsr.io", "npm.jsr.io", "deno.land", "dl.deno.land"],
  },
  {
    id: "pypi",
    name: "PyPI",
    description: "The Python package index. `files.pythonhosted.org` is where every wheel is.",
    hosts: ["pypi.org", "files.pythonhosted.org"],
  },
  {
    id: "cargo",
    name: "crates.io",
    description: "Rust's registry: the sparse index, the API, and the crate files.",
    hosts: ["crates.io", "index.crates.io", "static.crates.io"],
  },
  {
    id: "debian",
    name: "Debian & Ubuntu",
    description:
      "`apt-get` — the archives and their security suites, for both distributions, plus the PPA " +
      "host. The PPA is not an extra: our own universal image takes git from git-core's, so any " +
      "`apt-get update` on it reads `ppa.launchpadcontent.net` and fails the whole command " +
      "without it — measured inside a repo's own Dockerfile build.",
    hosts: [
      "deb.debian.org",
      "security.debian.org",
      "archive.ubuntu.com",
      "security.ubuntu.com",
      "ports.ubuntu.com",
      "ppa.launchpadcontent.net",
      "keyserver.ubuntu.com",
    ],
  },
  {
    id: "golang",
    name: "Go modules",
    description: "The module proxy and the checksum database Go verifies every download against.",
    hosts: ["proxy.golang.org", "sum.golang.org"],
  },
  {
    id: "github-releases",
    name: "GitHub releases",
    description:
      "Release assets and source tarballs — what a `setup.yml` reaches for to install a tool. " +
      "Note it opens github.com, as the `mise` bundle does.",
    hosts: [
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "*.githubusercontent.com",
    ],
  },
  // The three version managers the universal image ships. A repo that pins a toolchain gets it
  // installed on first use, and these are what that install dials. They are in the default set like
  // everything else: a run on an environment image carries its toolchain, but the build that makes
  // that image installs it through these same hosts, and so does any run before its environment is
  // ready.
  {
    id: "rustup",
    name: "rustup",
    description: "Rust toolchains: what `rustup` downloads when `rust-toolchain.toml` pins a " +
      "version the image does not carry. Crates themselves are the `cargo` bundle.",
    hosts: ["static.rust-lang.org"],
  },
  {
    id: "node-dist",
    name: "Node.js releases",
    description: "Node.js release tarballs and their index, as nvm, fnm, volta and corepack " +
      "fetch them. Packages themselves are the `npm` bundle.",
    hosts: ["nodejs.org"],
  },
  {
    id: "mise",
    name: "mise",
    description: "mise's own version index, and the GitHub release assets most of its backends " +
      "install from — so, like `github-releases`, it opens github.com — and get.helm.sh, where " +
      "Helm publishes its binaries. Node itself comes from `node-dist`.",
    hosts: [
      "mise.jdx.dev",
      "mise-versions.jdx.dev",
      // The github and aqua backends list a tool's releases through the API before they fetch
      // an asset; without it, every `mise install` of such a tool fails at "no versions found".
      "api.github.com",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "*.githubusercontent.com",
      // Helm, which this repo's own checks install, downloads from its own host rather than a
      // GitHub release: `mise install helm` lists versions through the API, then fetches the
      // tarball and its .sha256sum from get.helm.sh (no redirects), and fails there without it.
      "get.helm.sh",
    ],
  },
  // Browser tests, which are two fetches and only one of them is this bundle's. `npm i -D
  // @playwright/test` is the `npm` bundle's business and already works — modern Playwright has no
  // postinstall hook, so that install succeeds and downloads no browser. What fails is the next
  // line of every Playwright setup, `npx playwright install`.
  //
  // `--with-deps` is a different thing again, and this bundle does not make it work: it shells out
  // to `apt-get update && apt-get install`, which needs root, and a run is uid 1994. It belongs in
  // a `.ryph/Dockerfile` (`USER root` … `RUN npx playwright install --with-deps`), where the
  // packages come from `debian`.
  {
    id: "playwright",
    name: "Playwright browsers",
    description:
      "The browser builds `playwright install` downloads: chromium, firefox, webkit and ffmpeg. " +
      "The package itself comes from the `npm` bundle, and the system libraries `--with-deps` " +
      "installs from `debian` — and `--with-deps` needs root, so it belongs in a build rather " +
      "than a run. Branded channels (`playwright install chrome`, `msedge`) add a vendor apt " +
      "repository and are not covered.",
    hosts: [
      "cdn.playwright.dev",
      // Mirror two of three (playwright-core's `PLAYWRIGHT_CDN_MIRRORS`: the CDN, the ESRP CDN
      // hit directly, then the storage bucket — the first and third are the same host). It is
      // walked in order only when the one before it fails, so a bundle without it installs
      // perfectly until the day the first mirror has a bad one, and then reads like a missing
      // release rather than an allowlist.
      "playwright.download.prss.microsoft.com",
    ],
  },
] as const;

/**
 * What a deployment allows when nobody narrowed it: the whole catalogue, so a first run, and a
 * first environment build, installs what its repo pins with no setup at all.
 *
 * It used to be the package managers plus `playwright`, on the theory that an environment image
 * retires the version managers. That only half holds: the build that makes the image installs
 * the toolchain through `node-dist`, `mise` or `rustup`, and so does a run that starts before
 * its environment is ready. The cost of leaving one out is a 403 in the middle of a setup step,
 * which reads as a broken mirror rather than a policy decision.
 *
 * The broad entries are `github-releases` and `mise`, which open github.com and every
 * `*.githubusercontent.com` host. They are on anyway. mise needs them to install most tools,
 * so leaving `github-releases` off while `mise` is on would close nothing; and the allowlist was
 * never a promise that no host accepts an upload, since `npm` and `crates.io` already take a
 * publish from whoever holds a token.
 *
 * Derived from the catalogue rather than listed, so a bundle added later is on by default too.
 * Anything that should stay off goes in a list here, with its reason, and in its description,
 * which is what Settings → Internet access shows.
 *
 * And this is a seed, not a cap. An admin who disagrees unticks a bundle there, and a deployment
 * that already saved an allowlist keeps the set it saved.
 */
export const DEFAULT_EGRESS_BUNDLES: readonly string[] = EGRESS_BUNDLES.map((bundle) => bundle.id);

/**
 * The operator's ceiling, resolved once by the composition root — the outer bound on every
 * agent in this deployment.
 */
export interface EgressPolicy {
  mode: EgressMode;
  /** Bundle ids. Every agent's set must be a subset of this one. */
  bundles: string[];
  /** Raw hostnames, the escape hatch — `RYPH_EGRESS_HOSTS`, gated exactly as
   * `RYPH_SERVICE_IMAGES` gates raw image refs, and with the same rule: whoever takes it owns
   * what they let through. */
  hosts: string[];
  /** The proxy as an AGENT CONTAINER dials it. Null: none configured, so no run is handed a
   * route out — which is what "default closed" means when the operator has not finished wiring. */
  proxyUrl: string | null;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  mode: "proxy",
  bundles: [...DEFAULT_EGRESS_BUNDLES],
  hosts: [],
  proxyUrl: null,
};

/**
 * The half of the ceiling an ADMIN owns: what a run may reach, never whether it is enforced or
 * where the proxy lives.
 *
 * That line is the whole design of this type. `mode`, `proxyUrl` and the signing key are infra
 * facts — they say whether there IS a boundary and how a run dials it, they are settled by
 * whoever deploys the thing, and an admin flipping `mode` to `open` from a web form would be
 * turning the control off from inside the thing it controls. The allowlist is the opposite: it
 * is a product decision, it changes when a repo picks up a new package manager, and making it a
 * redeploy means the first person to hit it is a run failing in the middle of a setup step.
 *
 * Env is the SEED and not the ceiling over this: `RYPH_EGRESS_BUNDLES` and `RYPH_EGRESS_HOSTS`
 * are what a deployment allows until an admin says otherwise, and the saved row wins from then
 * on. The alternative — env as a hard cap the admin narrows within — sounds safer and is not: it
 * means the answer to "a run cannot resolve its lockfile" is still a redeploy, which is the
 * failure this exists to end.
 */
export interface EgressAllowlist {
  /** Bundle ids, validated against the catalogue when they are saved. */
  bundles: string[];
  /** Raw hostnames on top, each of which must be a hostname and not a URL or an address. */
  hosts: string[];
  updatedAt: string;
  /** The admin who last moved it — the audit question an allowlist always raises. */
  updatedBy: string | null;
}

/** The infra facts from the environment, the allowlist from whoever owns it. */
export function ceilingWith(policy: EgressPolicy, allowlist: EgressAllowlist): EgressPolicy {
  return { ...policy, bundles: [...allowlist.bundles], hosts: [...allowlist.hosts] };
}

/**
 * The ceiling as it stands right now: the saved allowlist if an admin has ever set one, else
 * what the environment seeded.
 *
 * Read per call rather than cached, and that is deliberate. An allowlist that took a restart to
 * take effect would be the redeploy this moved away from, wearing a form instead of a variable;
 * and every caller is already async and already doing a round trip or two.
 */
export async function liveCeiling(
  reader: { getEgressAllowlist(): Promise<EgressAllowlist | null> },
  seed: EgressPolicy,
): Promise<EgressPolicy> {
  const saved = await reader.getEgressAllowlist();
  return saved === null ? seed : ceilingWith(seed, saved);
}

/** Ceilings this size are a judgement, not a limit anything technical imposes. */
export const MAX_CEILING_HOSTS = 200;

/**
 * Why an allowlist may not be saved, or null when it may.
 *
 * The catalogue check is the one that matters: a bundle id nobody offers would be stored
 * happily and then refuse every launch with a message about a variable the admin did not set.
 * Caught here, at the form, in the words of the surface the admin is actually using.
 */
export function allowlistRefusal(
  next: { bundles: readonly string[]; hosts: readonly string[] },
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): string | null {
  const expanded = expandBundles(next.bundles, catalogue);
  if (expanded.kind === "refused") return expanded.error;
  if (next.hosts.length > MAX_CEILING_HOSTS) {
    return `an allowlist may name at most ${MAX_CEILING_HOSTS} hosts of its own; ` +
      `${next.hosts.length} is more than anyone reviews`;
  }
  for (const host of next.hosts) {
    const refusal = hostRefusal(host);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * An agent's network policy — the fourth sibling of modelPolicy, toolPolicy and memoryPolicy,
 * and the same rule as all three: names only, never a secret, and NARROWING ONLY. Null on the
 * agent means "whatever the deployment allows", which is the ceiling — unlike toolPolicy, where
 * null means none, because an agent with no egress cannot run `npm ci` and almost nobody wants
 * that as the unstated default.
 */
export interface NetworkPolicy {
  /** Bundle ids, a subset of the deployment's. */
  bundles: string[];
  /** Raw hostnames, a subset of what the deployment's own ceiling already permits. */
  hosts: string[];
}

/**
 * A run's egress, frozen at provision time beside modelScope, toolScope and services: editing
 * the agent's policy mid-run never changes where an in-flight run may reach.
 */
export interface RunNetworkScope {
  mode: EgressMode;
  /** The bundles as named, kept for the UI and the environment block the agent is shown. */
  bundles: string[];
  /** Every host the run may reach, expanded, normalized, deduped and sorted. This is what the
   * token carries and what the proxy enforces. */
  hosts: string[];
}

/** Lowercased, trailing dot removed — the one spelling everything downstream compares. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * A hostname an allowlist may name: a DNS name, optionally with a leading `*.`.
 *
 * Deliberately NOT a URL, an address or a port. A proxy allowlist entry that carried a scheme
 * would silently never match (the proxy compares the CONNECT authority), and one that carried a
 * CIDR would be the IP-layer fiction this whole design exists to refuse.
 */
export function hostRefusal(host: string): string | null {
  const name = normalizeHost(host);
  if (name === "") return "an empty hostname";
  if (name.length > 253) return `${host} is longer than a hostname may be`;
  const body = name.startsWith("*.") ? name.slice(2) : name;
  if (body === "") return `${host} names every host — a wildcard must have a domain under it`;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(body)) {
    return `${host} is not a hostname (an allowlist names hosts — never a URL, port or address)`;
  }
  if (!body.includes(".")) {
    return `${host} is a single label — an allowlist names a full hostname, e.g. registry.npmjs.org`;
  }
  // An address, not a name. `127.0.0.1` passes every rule above — digits are in the charset and
  // it carries dots — so without this the promise in the docstring is only prose. No real TLD is
  // all digits, which makes the rightmost label the whole test. It matters past tidiness: the
  // proxy refuses to DIAL loopback and private addresses, so an address that got in here would
  // be a host every run is then refused at, learned from a failing install rather than from the
  // variable that set it.
  if (/^\d+$/.test(body.slice(body.lastIndexOf(".") + 1))) {
    return `${host} is an address — an allowlist names hosts, and the proxy compares the name a ` +
      `run asked for (an address or CIDR is the IP-layer fiction this design exists to refuse)`;
  }
  return null;
}

/**
 * Whether the ceiling already covers everything an entry would grant.
 *
 * The narrowing check cannot be set membership, because the ceiling's own entries are not all
 * literal. A deployment vouching for `*.githubusercontent.com` has ALREADY granted
 * `release-assets.githubusercontent.com`, so an agent naming that one host is narrowing — asking
 * for less than it holds. Comparing strings refuses it, and then advises the operator to WIDEN
 * the deployment in order to narrow an agent, which is advice that makes the deployment worse.
 *
 * The rules are the proxy's `hostAllowed` read from the other side:
 * - a literal entry covers only the identical name
 * - `*.suffix` covers any name under it: one label or more, never the bare domain — the same
 *   reading images/egress-proxy/main.ts enforces, and for the same reason
 * - `*.suffix` also covers a NARROWER wildcard, since `*.a.example.com` grants nothing that
 *   `*.example.com` had not already granted
 *
 * Kept in step with the proxy by hand and by the suite that drives both, exactly as the token
 * format is: this directory may not import the proxy (it is a standalone compile target with no
 * workspace deps, and the architecture guard fences core/), so the pair is tested, not shared.
 */
export function hostCovered(entry: string, ceiling: Iterable<string>): boolean {
  const name = normalizeHost(entry);
  if (name === "") return false;
  for (const raw of ceiling) {
    const allowed = normalizeHost(raw);
    if (name === allowed) return true;
    if (!allowed.startsWith("*.")) continue;
    const suffix = allowed.slice(1); // ".example.com"
    const body = name.startsWith("*.") ? name.slice(1) : name;
    // `.a.example.com` ends with `.example.com` and is longer; a bare `example.com` does not end
    // with it at all, which is exactly what stops `*.example.com` granting the domain itself.
    if (body.endsWith(suffix) && body.length > suffix.length) return true;
  }
  return false;
}

/** The hosts a bundle covers, or a refusal naming what this deployment actually offers. */
export function expandBundles(
  ids: readonly string[],
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): { kind: "ok"; hosts: string[] } | { kind: "refused"; error: string } {
  const byId = new Map(catalogue.map((b) => [b.id, b]));
  const hosts: string[] = [];
  for (const id of ids) {
    const bundle = byId.get(id);
    if (bundle === undefined) {
      const known = [...byId.keys()].sort().join(", ");
      return {
        kind: "refused",
        error: `no egress bundle "${id}" — the catalogue offers: ${known}`,
      };
    }
    hosts.push(...bundle.hosts);
  }
  return { kind: "ok", hosts };
}

/** Normalized, deduped, sorted — so two policies that say the same thing freeze identically. */
function tidy(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map(normalizeHost))].sort();
}

// ── Refusals, as the person who has to fix one reads them ──────────────────────────────────────
//
// The proxy refuses a host and logs it. That line is in a pod's stderr, in a namespace most of
// the people this platform is for cannot reach, and the run it belongs to hears nothing at all:
// a `mise` that cannot fetch a Deno release says `tunnel error: unsuccessful` and stops. A
// BUILD is worse than a run, because a refused build still settles `ready` and ships an image
// that fails later, in a run, far from the cause.
//
// So a refusal travels: the proxy reports the host and the port it refused, the control plane
// records it against the run or the build, and these functions turn it back into a sentence.
// The lookup is the catalogue above — the only place that knows `dl.deno.land` is the Deno
// bundle — which is why the wording lives here rather than in the app or the HTTP layer.

/** One host a run or a build was refused, exactly what a CONNECT line gives the proxy. */
export interface EgressRefusal {
  host: string;
  port: number;
  /** When the control plane recorded it. */
  at: string;
}

/**
 * What became of a report.
 *
 * `ended` is the one that matters on the wire: the subject is over (or was never here), so the
 * proxy should stop reporting for that claim rather than keep a loop's worth of POSTs coming at
 * a run nobody can act on any more.
 */
export type EgressRefusalOutcome = "recorded" | "duplicate" | "ended";

/**
 * How many refusals one subject keeps.
 *
 * The proxy dedupes per claim and caps what it reports, so this is the second bound rather than
 * the first: two replicas, a restart, or a claim the proxy has forgotten can each send again.
 * Twenty distinct hosts is already more than anyone reads, and a setup that misses more than
 * that is not going to be diagnosed one host at a time.
 */
export const MAX_EGRESS_REFUSALS = 20;

/**
 * The bundle whose hosts would cover `host`, or null when the catalogue offers none.
 *
 * The FIRST match, and the catalogue is ordered, so a host two bundles both carry is named by
 * the one an operator would tick first. Null is a real answer and not a failure: plenty of
 * hosts are nobody's registry, and saying "no bundle covers it" is what sends the admin to the
 * hosts field instead of hunting for a checkbox that does not exist.
 */
export function bundleCovering(
  host: string,
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): EgressBundle | null {
  const name = normalizeHost(host);
  if (name === "") return null;
  return catalogue.find((bundle) => hostCovered(name, bundle.hosts)) ?? null;
}

/**
 * The refusal list with `next` appended — or null when nothing changed, which is the caller's
 * signal that there is no write to make and no event to append.
 *
 * Deduped on host AND port, because `:80` and `:443` on one name are two different missing
 * grants; capped at `MAX_EGRESS_REFUSALS`, and the cap DROPS rather than evicting: the first
 * hosts a setup was refused are the ones that explain it, and a loop that discovers a new name
 * per attempt must not be able to push them out.
 */
export function appendRefusal(
  existing: readonly EgressRefusal[] | null,
  next: EgressRefusal,
): EgressRefusal[] | null {
  const held = existing ?? [];
  const host = normalizeHost(next.host);
  if (held.some((r) => normalizeHost(r.host) === host && r.port === next.port)) return null;
  if (held.length >= MAX_EGRESS_REFUSALS) return null;
  return [...held, { ...next, host }];
}

/** One line per refused host, each naming the remedy and who can apply it. */
function remedyLines(
  refusals: readonly EgressRefusal[],
  catalogue: readonly EgressBundle[],
): string[] {
  return refusals.map((refusal) => {
    const bundle = bundleCovering(refusal.host, catalogue);
    return bundle === null
      ? `- \`${refusal.host}\` — no bundle in the catalogue covers it, so an admin would have to ` +
        `add it by name under Settings → Internet access.`
      : `- \`${refusal.host}\` — an admin can allow it with the **${bundle.name}** bundle ` +
        `under Settings → Internet access.`;
  });
}

/**
 * What a person reads on a run or a build that was refused something — markdown, and null when
 * nothing was refused.
 *
 * ADMIN, said in every branch and never softened. The allowlist is admin-gated (the egress
 * allowlist route, and the app's Settings → Internet access), so wording that read as "add the
 * bundle" would send an ordinary user, or an agent reading its own inbox, looking for a control
 * they do not have. The agent's own copy of this says so twice for that reason.
 *
 * The hosts are interpolated into prose that is not fenced, and that is safe by construction
 * rather than by luck: a reported host is a CONNECT authority, so it has already been through
 * the charset the ingest boundary enforces — letters, digits, dot, dash, underscore, at most
 * 253 of them. There is no newline and no marker to forge in it.
 */
export function egressRefusalNote(
  refusals: readonly EgressRefusal[],
  subject: "run" | "build",
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): string | null {
  if (refusals.length === 0) return null;
  const count = refusals.length === 1 ? "a connection" : `${refusals.length} connections`;
  const opening = subject === "run"
    ? `The egress proxy refused ${count} while this run was setting up, so whatever it was ` +
      `fetching did not arrive.`
    : `The egress proxy refused ${count} while this environment was building. The build may ` +
      `have finished anyway and shipped an image that is missing what they were for.`;
  return [
    opening,
    "",
    ...remedyLines(refusals, catalogue),
  ].join("\n");
}

/**
 * The same fact as one line, for a run event's `detail`.
 *
 * Per refusal rather than per run, because an event is a moment: the trail says WHEN the host
 * was refused, beside the phase the run was in, which is most of the diagnosis on its own.
 */
export function egressRefusalDetail(
  refusal: EgressRefusal,
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): string {
  const bundle = bundleCovering(refusal.host, catalogue);
  return `${refusal.host}:${refusal.port} was refused by the egress proxy — ` +
    (bundle === null
      ? "no bundle in the catalogue covers it; an admin can add it by name under " +
        "Settings → Internet access"
      : `an admin can allow it with the "${bundle.name}" bundle under Settings → Internet access`);
}

export type NetworkScopeResolution =
  | { kind: "ok"; scope: RunNetworkScope }
  | { kind: "refused"; error: string };

/**
 * The agent's policy + the operator's ceiling → what this run may reach, or a refusal naming
 * what to change.
 *
 * The narrowing check is the whole point, and it is checked HERE rather than only at the form:
 * a ceiling tightened after an agent was saved must bind the agent's next run, not the set it
 * was granted when the ceiling was wider. So a policy that no longer fits is refused at task
 * creation, naming the bundle — loudly, rather than launching a run that quietly reaches more
 * than the deployment now allows.
 */
export function resolveNetworkScope(
  policy: NetworkPolicy | null,
  ceiling: EgressPolicy,
  catalogue: readonly EgressBundle[] = EGRESS_BUNDLES,
): NetworkScopeResolution {
  // Nothing is claimed, so nothing is frozen: an "open" deployment hands its runs no proxy and
  // no allowlist, and every adapter says as much rather than implying a boundary.
  if (ceiling.mode === "open") {
    return { kind: "ok", scope: { mode: "open", bundles: [], hosts: [] } };
  }

  const ceilingBundles = expandBundles(ceiling.bundles, catalogue);
  if (ceilingBundles.kind === "refused") {
    // The operator's own variable is wrong; the composition root already refuses this at boot,
    // so reaching here is a wiring fault worth naming as one.
    return { kind: "refused", error: `RYPH_EGRESS_BUNDLES: ${ceilingBundles.error}` };
  }
  const ceilingHosts = new Set(tidy([...ceilingBundles.hosts, ...ceiling.hosts]));

  if (policy === null) {
    return {
      kind: "ok",
      scope: {
        mode: "proxy",
        bundles: [...ceiling.bundles],
        hosts: [...ceilingHosts].sort(),
      },
    };
  }

  for (const id of policy.bundles) {
    if (!ceiling.bundles.includes(id)) {
      const offered = ceiling.bundles.length === 0
        ? "none at all"
        : ceiling.bundles.slice().sort().join(", ");
      return {
        kind: "refused",
        error: `this agent's network policy names the "${id}" bundle, which this deployment ` +
          `does not allow — an agent narrows the deployment's set and cannot widen it. ` +
          `Offered here: ${offered} (RYPH_EGRESS_BUNDLES)`,
      };
    }
  }
  for (const host of policy.hosts) {
    if (!hostCovered(host, ceilingHosts)) {
      return {
        kind: "refused",
        error: `this agent's network policy names ${host}, which is not in this deployment's ` +
          `allowlist — an agent narrows it and cannot widen it. An admin adds the host, or ` +
          `the bundle covering it, to this deployment's allowlist (Settings → Internet access)`,
      };
    }
  }

  const agentBundles = expandBundles(policy.bundles, catalogue);
  if (agentBundles.kind === "refused") return agentBundles;
  return {
    kind: "ok",
    scope: {
      mode: "proxy",
      bundles: [...policy.bundles],
      hosts: tidy([...agentBundles.hosts, ...policy.hosts]),
    },
  };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * The run's proxy credential: a signed claim carrying the run id, an expiry and the allowlist.
 *
 * WHY A CLAIM AND NOT A LOOKUP. The proxy then needs no database, no control listener and no
 * link back to the control plane — which is what keeps it a thin target rather than a second
 * confused deputy. The run holds a token that states its own allowlist and cannot forge it: the
 * HMAC is over the payload, so editing the host list invalidates the signature.
 *
 * The format is `v1.<payload>.<signature>`, and images/egress-proxy/main.ts verifies exactly
 * this. The two are kept in step by hand and by the test that drives both.
 */
export async function mintEgressToken(
  key: Uint8Array,
  claim: { runId: string; expiresAt: number; hosts: readonly string[] },
): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ r: claim.runId, e: claim.expiresAt, h: [...claim.hosts] }),
    ),
  );
  const imported = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`v1.${payload}`)),
  );
  return `v1.${payload}.${b64url(signature)}`;
}

/**
 * The claim inside a token this deployment minted, or null when it is not one.
 *
 * The verifying half, here too, because a refusal REPORT arrives carrying the same token — the
 * proxy presents the subject's own claim back to the control plane rather than a credential of
 * its own (http/egress_api.ts says why at length). So the control plane reads the subject id
 * off the signature instead of believing a body, and this is the reading.
 *
 * Every failure answers null and none of them says which, exactly as the proxy's copy does:
 * telling a caller whether a token was forged, expired or malformed is an oracle for shaping
 * the next attempt. Kept in step with images/egress-proxy/main.ts by hand and by the suite that
 * drives both.
 */
export async function verifyEgressToken(
  token: string,
  key: Uint8Array,
  nowSeconds: number,
): Promise<{ runId: string; expiresAt: number; hosts: string[] } | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [version, payload, signature] = parts;
  const imported = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let presented: Uint8Array;
  try {
    const padded = signature.replaceAll("-", "+").replaceAll("_", "/");
    presented = Uint8Array.from(
      atob(padded + "=".repeat((4 - padded.length % 4) % 4)),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    imported,
    presented as unknown as ArrayBuffer,
    new TextEncoder().encode(`${version}.${payload}`),
  );
  if (!ok) return null;
  let parsed: { r?: unknown; e?: unknown; h?: unknown };
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    parsed = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(padded + "=".repeat((4 - padded.length % 4) % 4)),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
  } catch {
    return null;
  }
  if (
    typeof parsed.r !== "string" || typeof parsed.e !== "number" ||
    !Array.isArray(parsed.h) || !parsed.h.every((h) => typeof h === "string")
  ) {
    return null;
  }
  // After the signature, so an expired token is indistinguishable from a forged one.
  if (parsed.e <= nowSeconds) return null;
  return { runId: parsed.r, expiresAt: parsed.e, hosts: parsed.h as string[] };
}

/**
 * The policy, from the deployment's environment. Pure: `env` and `fail` are handed in, so both
 * composition roots read the same variables the same way — the precedent
 * `servicePolicyFromEnv` and `kubernetesOptionsFromEnv` set.
 *
 * `RYPH_EGRESS` defaults to `proxy`, and the asymmetry with `RYPH_SERVICES` is deliberate:
 * services default OFF because on means running a repo's images on the operator's machines,
 * and this defaults ON because off means the open internet. Same principle, opposite polarity —
 * the default is whichever way is safe.
 *
 * There is no spelling that reads as a promise this cannot keep. `off` is not a value: it would
 * read as "no egress" and mean "no enforcement", which is the exact inversion an operator must
 * never be able to configure by accident.
 */
export function egressPolicyFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): EgressPolicy {
  const raw = env("RYPH_EGRESS")?.trim().toLowerCase() ?? "proxy";
  if (raw !== "proxy" && raw !== "open") {
    fail(
      `RYPH_EGRESS must be "proxy" (runs reach the internet through the egress proxy, and only ` +
        `its allowlist) or "open" (no boundary, and none claimed), got ${JSON.stringify(raw)}`,
    );
  }
  const list = (name: string, fallback: readonly string[]): string[] => {
    const value = env(name);
    if (value === undefined) return [...fallback];
    return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  };

  const bundles = list("RYPH_EGRESS_BUNDLES", DEFAULT_EGRESS_BUNDLES);
  const expanded = expandBundles(bundles);
  if (expanded.kind === "refused") fail(`RYPH_EGRESS_BUNDLES: ${expanded.error}`);

  const hosts = list("RYPH_EGRESS_HOSTS", []);
  for (const host of hosts) {
    const refusal = hostRefusal(host);
    if (refusal !== null) fail(`RYPH_EGRESS_HOSTS: ${refusal}`);
  }

  const proxyUrl = env("RYPH_EGRESS_PROXY_URL")?.trim().replace(/\/+$/, "") || null;
  if (proxyUrl !== null && !URL.canParse(proxyUrl)) {
    fail(`RYPH_EGRESS_PROXY_URL must be an absolute URL, got ${JSON.stringify(proxyUrl)}`);
  }
  return { mode: raw, bundles, hosts: hosts.map(normalizeHost), proxyUrl };
}

/** Backends where a run has no default route of its own, so withholding the proxy credential
 * is the whole boundary rather than a preference. `docker` (not listed) is confining only with
 * `RYPH_DOCKER_RUN_NETWORK` set, which is why callers pass `confined` separately. */
const CONFINING_PROVISIONERS = new Set(["kubernetes"]);

/**
 * What to say at boot when `RYPH_EGRESS=proxy` is set and the wiring is not finished.
 *
 * SHARED BY BOTH COMPOSITION ROOTS, and conditional on the provisioner, because the honest
 * sentence is the opposite one on half the backends. Where a run is confined (kubernetes, and
 * docker on an internal run network) an unwired proxy really does leave it with no route out
 * and every install fails. Everywhere else — manual, unconfined docker — the container
 * keeps its default route and reaches the whole internet, so the unwired setting enforces
 * nothing at all. Telling that operator their runs reach nothing
 * leaves them holding exactly the inverted belief this design exists to make impossible.
 */
export function unwiredEgressWarning(
  provisionerKind: string,
  noKey: boolean,
  noProxyUrl: boolean,
  confined = CONFINING_PROVISIONERS.has(provisionerKind),
): string {
  const missing = [
    ...(noKey ? ["RYPH_EGRESS_KEY"] : []),
    ...(noProxyUrl ? ["RYPH_EGRESS_PROXY_URL"] : []),
  ].join(" and ");
  return `RYPH_EGRESS=proxy without ${missing} — ` +
    (confined
      ? "runs on this backend are confined, so they are handed no route to the internet at all " +
        "and anything a repo's setup.yml installs will fail."
      : `runs under the \`${provisionerKind}\` provisioner keep their own default route, so they ` +
        "reach the WHOLE internet and this setting enforces nothing — the deployment claims a " +
        "boundary it does not have.") +
    " Set both, or RYPH_EGRESS=open to claim no boundary.";
}

/**
 * The HMAC key this deployment signs run tokens with, from `RYPH_EGRESS_KEY` — the same value
 * the proxy holds. Null when unset, which is a deployment that hands no run a route out.
 *
 * Its own key, not the model-proxy's `RYPH_SECRETS_KEY` or the gateway's `RYPH_MCP_KEY`, and the
 * reason is the blast radius rather than tidiness: those two UNSEAL credentials, while this one
 * only signs a claim about hostnames. Whoever holds it can grant egress they were not given; it
 * opens nothing else, and it must not be a key that does.
 */
export function egressKeyFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): Uint8Array | null {
  const hex = env("RYPH_EGRESS_KEY")?.trim();
  if (hex === undefined || hex === "") return null;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0 || hex.length < 32) {
    // Never echoes the value.
    fail("RYPH_EGRESS_KEY must be at least 32 hex characters (the egress proxy holds the same)");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
