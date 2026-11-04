// The ingest boundary for the management surface — every JSON payload is parsed against a
// schema here before it may travel as a core type, same doctrine as the orchestrator's.

import { z } from "@zod/zod";
import { isBlockedAddress, isLoopbackHost, parseIp } from "@ryph/shared/net";
import {
  AUTH_SCHEME_PATTERN,
  BUILTIN_PROVIDERS,
  CREDENTIAL_VALUE_PATTERN,
  HEADER_NAME_PATTERN,
  HEADER_VALUE_PATTERN,
  REFUSED_EXTRA_HEADERS_TEXT,
  refusedExtraHeader,
} from "./core/registry.ts";
import { orderedLevels, THINKING_LEVELS } from "./core/thinking.ts";

const singleLine = z.string().trim().min(1).max(200)
  .refine((s) => !/[\r\n]/.test(s), { error: "must be a single line" });

/**
 * A provider id is a SHAPE here, not a member of a set. It used to be checked against the static
 * registry, but the set is now built-ins ∪ live `custom_providers` rows — which needs the store,
 * which an ingest schema has no business holding. The existence check moved to the routes, where
 * the store is in reach (see `providerKeyRoutes.create`); an unknown id handed to the issuer is
 * a definitive refusal there. The shape still matters on its own: this value rides pi's argv as
 * `--provider <id>` and a column in every usage row.
 */
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const providerId = z.string().min(1).max(64)
  .regex(PROVIDER_SLUG, { error: "must be a lowercase slug (a-z, 0-9, -)" });

// A real API key: opaque, but never multi-line and never absurdly long. It rides a header, so
// it is visible ASCII and nothing else: whitespace (a zero-width space included) is a paste
// accident — refused now rather than a 401 on the first model call — and a character past
// Latin-1 would make the header throw at every forward (core/registry.ts).
const secret = z.string().min(8).max(4096).refine((s) => CREDENTIAL_VALUE_PATTERN.test(s), {
  error: "must be visible ASCII with no whitespace",
});

/** What POST /v1/provider-keys accepts. The secret arrives exactly once, here. */
export const CreateProviderKeySchema = z.object({
  provider: providerId,
  label: singleLine,
  secret,
});

/** What PATCH /v1/provider-keys/:id accepts: relabel, rotate the secret in place, or both. */
export const UpdateProviderKeySchema = z.object({
  label: singleLine.optional(),
  secret: secret.optional(),
}).refine((patch) => patch.label !== undefined || patch.secret !== undefined, {
  error: "nothing to update: provide label and/or secret",
});

// ── custom model endpoints ─────────────────────────────────────────────────────────────────

/** A custom endpoint's own id: a slug, and never one of the two names that ship as code —
 * a row shadowing `anthropic` would silently re-route every key registered against it. */
const customProviderId = providerId.refine(
  (id) => !Object.hasOwn(BUILTIN_PROVIDERS, id),
  { error: `reserved: ${Object.keys(BUILTIN_PROVIDERS).join(", ")} ship as code` },
);

/** RFC 9110 token characters: what may name a header at all. */
const headerName = z.string().min(1).max(128)
  .regex(HEADER_NAME_PATTERN, { error: "not a header name" });

/** The header a key rides in: a header name that does not say where the request goes. Stored
 * lower-cased by the routes. */
const authHeaderName = headerName.refine((name) => !refusedExtraHeader(name), {
  error: `the auth header may not be ${REFUSED_EXTRA_HEADERS_TEXT}`,
});

/** The scheme in front of the key (`Bearer`): one token, as `endpointHeadersProblem` holds it. */
const authScheme = singleLine.refine((s) => AUTH_SCHEME_PATTERN.test(s), {
  error: "must be one word of visible ASCII",
});

/** A header VALUE, trimmed (HTTP drops the surrounding whitespace anyway, and the stored value
 * is what an endpoint's shape is compared on), and visible ASCII with single spaces between
 * words (`HEADER_VALUE_PATTERN`): nothing that splits the forwarded request, nothing `Headers`
 * throws on. */
const headerValue = z.string().trim().min(1).max(1024)
  .refine((v) => HEADER_VALUE_PATTERN.test(v), {
    error: "must be visible ASCII, words separated by single spaces",
  });

/** Static, NON-SECRET headers. Nothing sealed goes here: the credential is the provider key, and
 * these are echoed back on every read of the provider list. None may say where the request goes
 * (`REFUSED_EXTRA_HEADERS`); the routes hold them against the endpoint's auth header as well. */
const extraHeaders = z.record(headerName, headerValue)
  .refine((h) => Object.keys(h).length <= 20, { error: "at most 20 headers" })
  .refine((h) => Object.keys(h).every((name) => !refusedExtraHeader(name)), {
    error: `extra headers may not set ${REFUSED_EXTRA_HEADERS_TEXT}`,
  })
  .refine(
    (h) => new Set(Object.keys(h).map((name) => name.toLowerCase())).size === Object.keys(h).length,
    {
      error: "a header is set twice (header names ignore case)",
    },
  );

const rate = z.number().finite().min(0).max(100_000);

/** One declared model. Required on an endpoint, because nothing else in the system can know what
 * it serves: pi has no catalogue for an unknown provider and the price list cannot guess rates.
 * `compat` is passed through verbatim — pi's OpenAI-compatibility knobs are pi's business, and
 * enumerating them here would mean editing this file every time pi grows one. */
export const DeclaredModelSchema = z.object({
  id: z.string().trim().min(1).max(200)
    .refine((s) => !/\s/.test(s), { error: "must not contain whitespace" }),
  label: singleLine.optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(100_000_000).optional(),
  reasoning: z.boolean().optional(),
  vision: z.boolean().optional(),
  /** The thinking levels it takes, a set of pi's; kept in pi's order whatever order they came
   * in. Left off, it is stored without them and takes what pi gives a model with no levels:
   * `off` alone unless it reasons, `off` through `high` if it does. */
  thinkingLevels: z.array(z.enum(THINKING_LEVELS)).min(1).max(THINKING_LEVELS.length)
    .refine((levels) => new Set(levels).size === levels.length, {
      error: "a thinking level may be listed only once",
    })
    .transform(orderedLevels)
    .optional(),
  compat: z.record(z.string().min(1).max(100), z.unknown()).optional(),
  /** USD per million tokens. Left off, the model reports as UNPRICED — never as free. */
  price: z.object({
    input: rate,
    output: rate,
    cacheRead: rate,
    cacheWrite: rate,
  }).optional(),
}).refine(
  (m) =>
    m.reasoning !== false || m.thinkingLevels === undefined ||
    m.thinkingLevels.every((level) => level === "off"),
  {
    error: "a model that does not reason takes no thinking level but off",
    path: ["thinkingLevels"],
  },
);

const models = z.array(DeclaredModelSchema).min(1).max(200)
  .refine((list) => new Set(list.map((m) => m.id)).size === list.length, {
    error: "duplicate model id",
  });

/**
 * Whether a model endpoint may point INSIDE the network. Read per parse rather than at import,
 * so a deployment's answer is the process's environment and a test can set it.
 *
 * Off (the default), an endpoint must be https and must not resolve — literally — to an address
 * inside the deployment. On, a LAN vLLM on plain http is registrable, which is the only reason
 * the knob exists: `http` still requires the host to be a private address, so the knob never
 * turns into "the sealed key may cross the public internet in cleartext".
 */
export function privateModelEndpointsAllowed(): boolean {
  return process.env.RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS === "1";
}

/**
 * Whether a URL's host is LITERALLY an address the deployment itself answers on: the name
 * `localhost`, or an IP literal @ryph/shared/net's `isBlockedAddress` refuses — loopback,
 * link-local (169.254.169.254, the cloud metadata server, above all), the private and
 * carrier-grade NAT ranges, and everything else that is not globally routable. A DNS name is not
 * judged here: it answers false.
 *
 * The ranges cover every one the model-proxy pod's NetworkPolicy excepts from its egress
 * (`$private` in deploy/helm/ryph/templates/networkpolicies.yaml), and more. A range this
 * function missed but the policy excepted would not be a hole — it would be worse in a quieter
 * way: the endpoint registers, and every run that dials it hangs until it times out, with nothing
 * anywhere saying why.
 *
 * Be honest about what this is: a check on the string an admin typed. It is NOT
 * DNS-rebinding-proof — a hostname that resolves to 10.0.0.1 passes it, and a hostname that
 * resolves differently on the second lookup passes it twice. What actually holds the boundary is
 * that NetworkPolicy. This function is the early, legible refusal that saves an admin from a
 * request that would have hung; the policy is the one that says no.
 */
export function isPrivateModelEndpointHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  // A DNS name: nothing to decide here. Anything shaped like an address is judged, and one
  // that does not parse is refused with the rest.
  const addressShaped = host.includes(":") || /^[\d.]+$/.test(host);
  return addressShaped && isBlockedAddress(host);
}

/**
 * Whether a host is LITERALLY on a private network: loopback, 10/8, 172.16/12, 192.168/16,
 * 100.64/10 (CGNAT), 169.254/16, fc00::/7 (unique-local), fe80::/10, and the `::ffff:` mapped
 * forms of the IPv4 ones — `$private` in the Helm NetworkPolicy, plus the IPv6 two. Narrower than
 * `isPrivateModelEndpointHost` on purpose: that one refuses everything not globally routable,
 * which includes ranges a packet still crosses the public internet to reach (the 6to4 relay,
 * Teredo, multicast). This one decides where plain http may go, so it names only the networks
 * that are somebody's LAN.
 */
function isPrivateNetworkHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  const ip = parseIp(host);
  if (ip === null) return false;
  const g = ip.v === 6 ? ip.groups : [];
  const mapped = ip.v === 6 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (ip.v === 6 && !mapped) {
    return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80;
  }
  const [a, b] = ip.v === 4 ? ip.octets : [g[6]! >> 8, g[6]! & 0xff];
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254);
}

/**
 * Why a base URL may not be registered, or null when it may. Pure — the env read is the caller's
 * — so every rule below is a unit test.
 *
 * A query string or a fragment is refused rather than dropped: the proxy appends the request's
 * own path and search to this URL, so either would be silently lost and the admin would debug an
 * endpoint that "ignores its own parameters". Credentials in the URL are refused because the
 * credential is the provider key, sealed, and a userinfo component would be a second one in
 * plaintext in a row that is read back to every signed-in user.
 */
export function refuseModelEndpointUrl(raw: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must be an http(s) URL";
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  if (url.search !== "") return "must not carry a query string";
  if (url.hash !== "") return "must not carry a fragment";
  const isPrivate = isPrivateModelEndpointHost(url.hostname);
  if (!allowPrivate && isPrivate) {
    return "must not be a private or loopback address " +
      "(set RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1 for a private-network endpoint)";
  }
  // `http` needs the flag AND a private-network host. The flag exists for one thing — a vLLM on
  // the LAN that has no certificate — and the two rules used to share it, so turning it on also
  // made `http://api.some-gateway.example.com/v1` registrable and put the sealed provider key on
  // the public internet in cleartext. A private host has no certificate to have; a public one
  // does. The host test is the narrow one, not `isPrivate`: a 6to4 relay or a Teredo address is
  // refused above but still reached across the public internet.
  if (url.protocol === "http:") {
    if (!allowPrivate) {
      return "must be https " +
        "(set RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1 for a private-network endpoint)";
    }
    if (!isPrivateNetworkHost(url.hostname)) {
      return "must be https: plain http is permitted only for a private-network address";
    }
  }
  return null;
}

/** Resolves a hostname to its addresses; throws, or answers [], when it does not resolve. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** The platform's own resolver: every address a name has, both families. */
export const systemResolveHost: ResolveHost = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
};

/**
 * Why a base URL's host may not be dialled, judged on what its NAME resolves to — or null.
 * `refuseModelEndpointUrl` judges the string an admin typed, and a DNS name passes it whatever it
 * points at: `169.254.169.254.nip.io` is the cloud metadata server under a public-looking name.
 * In the cluster the model proxy's NetworkPolicy refuses that dial anyway; in the binary and in
 * compose nothing does, and the sealed key would go with it. So the name is resolved — at
 * registration (a 400 the admin reads) and again before a forward — and refused when ANY address
 * it has is one `isBlockedAddress` refuses.
 *
 * Not DNS-rebinding-proof: fetch resolves the name again for itself, and Bun's fetch cannot be
 * handed an address to dial while keeping the name for TLS. A name whose answer changes between
 * this lookup and that one passes. What it does catch is every name that statically points
 * inside: the wildcard-DNS services, a typo'd internal name, a record an admin did not own.
 *
 * With RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS on there is nothing to judge, as for a literal. A name
 * that does not resolve answers `unresolvable`, which neither caller refuses: a registration made
 * while the name or the DNS is down is not a wrong one, and a forward lets fetch fail on it.
 */
export async function endpointAddressProblem(
  raw: string,
  allowPrivate: boolean,
  resolve: ResolveHost,
): Promise<{ kind: "private" | "unresolvable"; detail: string } | null> {
  if (allowPrivate) return null;
  const url = URL.parse(raw);
  if (url === null) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A literal is `refuseModelEndpointUrl`'s to judge, and has nothing to resolve.
  if (parseIp(host) !== null) return null;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    return { kind: "unresolvable", detail: `${host} does not resolve` };
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return {
        kind: "private",
        detail: `${host} resolves to ${address}, a private or local address ` +
          "(set RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1 for a private-network endpoint)",
      };
    }
  }
  return null;
}

/** The upstream, path included — `https://api.cloudflare.com/client/v4/accounts/X/ai/v1`. */
const modelEndpointUrl = z.string().trim().min(1).max(2000).superRefine((raw, ctx) => {
  const refusal = refuseModelEndpointUrl(raw, privateModelEndpointsAllowed());
  if (refusal !== null) ctx.addIssue({ code: "custom", message: refusal });
});

/**
 * What POST /v1/providers accepts: one OpenAI-compatible endpoint, how its credential travels,
 * and what it serves. The SECRET is not here — a custom endpoint's key is an ordinary provider
 * key registered against this id afterwards, sealed by the same route as any other.
 */
export const CreateCustomProviderSchema = z.object({
  id: customProviderId,
  label: singleLine,
  baseUrl: modelEndpointUrl,
  authHeader: authHeaderName.optional(),
  authScheme: authScheme.nullable().optional(),
  extraHeaders: extraHeaders.optional(),
  models,
});

/** What PATCH /v1/providers/:id accepts: any subset of the above except the id, which every
 * provider key and every agent policy references by name. */
export const UpdateCustomProviderSchema = z.object({
  label: singleLine.optional(),
  baseUrl: modelEndpointUrl.optional(),
  authHeader: authHeaderName.optional(),
  authScheme: authScheme.nullable().optional(),
  extraHeaders: extraHeaders.optional(),
  models: models.optional(),
}).refine((patch) => Object.values(patch).some((v) => v !== undefined), {
  error: "nothing to update",
});

/**
 * What POST /internal/v1/runs/:id/credentials accepts — the run's frozen model scope, handed
 * over the wire by the control plane instead of read from a shared table. The run id is the
 * path parameter, so it is deliberately absent here.
 */
export const IssueCredentialsSchema = z.object({
  /** The run's agent and task: what its usage is attributed to. */
  agentId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  providerKeyId: z.string().min(1).max(200),
  provider: providerId,
  allowedModels: z.union([z.literal("*"), z.array(z.string().min(1).max(200)).max(200)]),
  /** The run's caps, decided by the control plane; null or absent is uncapped. */
  spendUsd: z.number().positive().finite().nullable().optional(),
  callsInFlight: z.number().int().min(1).max(64).nullable().optional(),
});

/**
 * What PUT /v1/platform-model-policy accepts: the key the platform's own model calls spend, the
 * models they may name, and the one they use by default. The default must sit inside the
 * allowlist, or every call would be refused by the policy that named it.
 */
export const PlatformModelPolicySchema = z.object({
  providerKeyId: z.string().min(1).max(200),
  allowedModels: z.union([z.literal("*"), z.array(z.string().min(1).max(200)).min(1).max(200)])
    .default("*"),
  model: z.string().trim().min(1).max(200),
}).refine((p) => p.allowedModels === "*" || p.allowedModels.includes(p.model), {
  error: "model must be one of allowedModels",
});

/** What POST /internal/v1/platform/credentials accepts: who is asking, for the metering trail. */
export const IssuePlatformCredentialSchema = z.object({
  consumer: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, { error: "not a consumer name" }),
});

// ── ChatGPT plan keys ──────────────────────────────────────────────────────────────────────

/** What POST /v1/chatgpt-plan/sign-ins accepts: a label for a new key, or the key to sign in
 * again. Neither is required; a new key without a label is named after its account. */
export const StartPlanSignInSchema = z.object({
  label: singleLine.optional(),
  keyId: z.string().min(1).max(200).optional(),
});
