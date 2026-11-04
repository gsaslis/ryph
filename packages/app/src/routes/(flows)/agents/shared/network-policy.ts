// The bridge between the form's internet-access fields and the API's NetworkPolicy, shared by
// the create and edit flows so both compose, seed and validate identically — the tool-policy
// bridge, one policy family over.
//
// The asymmetry to keep in mind while reading: for every other policy, "no policy" means no
// access. Here it means the DEPLOYMENT'S OWN ceiling, because an agent with no internet cannot
// run `npm ci` and almost nobody wants that as the unstated default. So the form's two modes are
// "whatever this deployment allows" (null) and "only these" (a narrowing), and the second can be
// narrowed all the way to nothing — which is a real, expressible answer rather than a null.

import type { EgressCeiling, NetworkPolicy } from "$lib/api/types";
import { hostGrammarProblem, parseHosts } from "$lib/utils/egress-hosts";

/** The orchestrator's ceilings on a policy's two lists. */
export const MAX_NETWORK_BUNDLES = 32;
export const MAX_NETWORK_HOSTS = 100;

export interface NetworkFields {
  /** "deployment": no policy at all — the agent gets the ceiling. "narrowed": the lists below. */
  mode: "deployment" | "narrowed";
  /** Bundle ids ticked; a subset of the deployment's. */
  bundles: string[];
  /** Comma-separated hostnames, each of which the deployment must already allow. */
  hosts: string;
}

/** Builds the policy from the fields; "deployment" is no policy at all (null). */
export function composeNetworkPolicy(fields: NetworkFields): NetworkPolicy | null {
  if (fields.mode === "deployment") return null;
  return { bundles: [...new Set(fields.bundles)], hosts: parseHosts(fields.hosts) };
}

/** Seeds the fields from an existing policy (the edit flow). */
export function networkPolicyToFields(policy: NetworkPolicy | null): NetworkFields {
  if (policy === null) return { mode: "deployment", bundles: [], hosts: "" };
  return {
    mode: "narrowed",
    bundles: [...policy.bundles],
    hosts: policy.hosts.join(", "),
  };
}

/**
 * Whether the deployment's ceiling already covers a host the form names.
 *
 * Not set membership, because a ceiling entry can be a wildcard. A deployment vouching for
 * `*.githubusercontent.com` has ALREADY granted `release-assets.githubusercontent.com`, so an
 * agent naming that one host is narrowing — and a literal comparison would refuse it, then tell
 * the operator to widen the deployment in order to narrow an agent.
 *
 * The same three rules as the orchestrator's `hostCovered` and the proxy's `hostAllowed`: a
 * literal entry covers only itself; `*.suffix` covers any name under it, one label or more and
 * never the bare domain; and `*.suffix` covers a narrower wildcard. Three copies kept in step by
 * hand, because this form cannot import the orchestrator — and a form that judged narrowing
 * differently from the API would refuse what the API would have accepted, which is the failure
 * this whole bridge exists to prevent.
 */
export function hostCovered(entry: string, ceiling: Iterable<string>): boolean {
  const name = entry.trim().toLowerCase().replace(/\.$/, "");
  if (name === "") return false;
  for (const raw of ceiling) {
    const allowed = raw.trim().toLowerCase().replace(/\.$/, "");
    if (name === allowed) return true;
    if (!allowed.startsWith("*.")) continue;
    const suffix = allowed.slice(1); // ".example.com"
    const body = name.startsWith("*.") ? name.slice(1) : name;
    if (body.endsWith(suffix) && body.length > suffix.length) return true;
  }
  return false;
}

/**
 * Why the fields cannot be saved as they stand, in the operator's words — or null when they can.
 *
 * Every one of these is a refusal the orchestrator would make anyway (it re-checks at save AND
 * at every launch); catching it here means the form names the bundle or the host instead of a
 * 400. With the ceiling unreadable nothing is claimed: the form cannot know what narrowing means
 * there, so it does not pretend to.
 */
export function networkPolicyProblem(
  fields: NetworkFields,
  ceiling: EgressCeiling | null,
): string | null {
  if (fields.mode === "deployment" || ceiling === null) return null;

  if (fields.bundles.length > MAX_NETWORK_BUNDLES) {
    return `An agent's internet access can name at most ${MAX_NETWORK_BUNDLES} bundles.`;
  }
  const offered = new Set(ceiling.bundles.map((b) => b.id));
  for (const id of fields.bundles) {
    if (!offered.has(id)) {
      return `This deployment does not allow the "${id}" bundle, so this agent cannot be given ` +
        `it — an agent narrows what the deployment allows and cannot widen it.`;
    }
  }

  const hosts = parseHosts(fields.hosts);
  if (hosts.length > MAX_NETWORK_HOSTS) {
    return `An agent's internet access can name at most ${MAX_NETWORK_HOSTS} hosts.`;
  }
  // Every host the ceiling permits — the bundles it vouches for plus its raw list. Wildcards are
  // left exactly as written; reading them is `hostCovered`'s job, not this list's.
  const allowed = [...ceiling.bundles.flatMap((b) => b.hosts), ...ceiling.hosts];
  for (const host of hosts) {
    // Grammar first: an entry the server's schema would reject never reaches the question of
    // whether the ceiling covers it, and `foo_bar.githubusercontent.com` would otherwise pass
    // `hostCovered` under a `*.githubusercontent.com` ceiling and submit.
    const grammar = hostGrammarProblem(host);
    if (grammar !== null) return grammar;
    if (!hostCovered(host, allowed)) {
      return `This deployment does not allow ${host}, so this agent cannot be given it. Add it ` +
        `to the deployment's allowlist first (RYPH_EGRESS_HOSTS).`;
    }
  }
  return null;
}

/** Every host the fields grant, for the summary the form shows under the picker. */
export function grantedHosts(fields: NetworkFields, ceiling: EgressCeiling | null): string[] {
  if (ceiling === null) return [];
  const bundles = fields.mode === "deployment"
    ? ceiling.bundles
    : ceiling.bundles.filter((b) => fields.bundles.includes(b.id));
  const hosts = fields.mode === "deployment" ? ceiling.hosts : parseHosts(fields.hosts);
  return [...new Set([...bundles.flatMap((b) => b.hosts), ...hosts])].sort();
}
