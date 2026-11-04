// The capability catalogue and the roles that bundle it.
//
// A capability is one permission with one spelling, `<resource>:<verb>`. A `-all` suffix widens a
// verb from "own and in scope" to everything of that resource. The list is closed: a gate names a
// member of `CAPABILITIES` and nothing else, so a stray string is a type error rather than a
// silent deny.
//
// A role is a named bundle of capabilities. Each built-in role is a superset of the one before it,
// and a user holds exactly one. Auth expands the role once, at sign-in, into the `caps` claim of
// the access token; every service decides from that list and never learns what a role is.

export const CAPABILITIES = [
  "tasks:create",
  "tasks:read",
  "tasks:read-all",
  "tasks:steer",
  "tasks:steer-all",
  "patches:read",
  "patches:review",
  "checks:request",
  "agents:read",
  "agents:write",
  "agents:policy",
  "repos:read",
  "repos:connect",
  "repos:manage",
  "repos:manage-all",
  "workspaces:read",
  "workspaces:manage",
  "artifacts:read",
  "artifacts:manage",
  "resources:manage",
  "egress:manage",
  "models:read",
  "models:manage",
  "tools:read",
  "tools:manage",
  "skills:read",
  "skills:manage",
  "memory:read",
  "memory:manage",
  "automations:manage",
  "automations:manage-all",
  "chat:read",
  "chat:write",
  "chat:manage",
  "usage:read-all",
  "users:manage",
  "settings:manage",
  "tokens:write",
  "tokens:manage-all",
] as const;

export type Capability = typeof CAPABILITIES[number];

/**
 * The capabilities an API token may not carry. Auth answers them to a signed-in session only:
 * managing people, settings and tokens is how an instance is governed, and a token that could
 * do it would be a way to mint sessions without a password. A token holding one could never
 * use it, so minting refuses it and the form leaves it out.
 */
export const SESSION_ONLY_CAPABILITIES: readonly Capability[] = [
  "users:manage",
  "settings:manage",
  "tokens:write",
  "tokens:manage-all",
];

/** The wildcard an owner's token carries in place of the whole list. */
export const EVERY_CAPABILITY = "*";

/** One entry of a token's `caps` claim. */
export type CapabilityClaim = Capability | typeof EVERY_CAPABILITY;

export const ROLES = ["viewer", "member", "operator", "owner"] as const;

export type Role = typeof ROLES[number];

const VIEWER: readonly Capability[] = [
  "tasks:read",
  "patches:read",
  "agents:read",
  "repos:read",
  "workspaces:read",
  "artifacts:read",
];

const MEMBER: readonly Capability[] = [
  ...VIEWER,
  "tasks:create",
  "tasks:steer",
  "patches:review",
  "checks:request",
  "agents:write",
  "repos:connect",
  "repos:manage",
  "workspaces:manage",
  "models:read",
  "tools:read",
  "skills:read",
  "memory:read",
  "automations:manage",
  "chat:read",
  "chat:write",
  "tokens:write",
];

const OPERATOR: readonly Capability[] = [
  ...MEMBER,
  "tasks:read-all",
  "tasks:steer-all",
  "agents:policy",
  "repos:manage-all",
  "artifacts:manage",
  "resources:manage",
  "egress:manage",
  "models:manage",
  "tools:manage",
  "skills:manage",
  "memory:manage",
  "automations:manage-all",
  "chat:manage",
  "usage:read-all",
];

/** What each role expands to. An owner holds every capability, including ones added later. */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  viewer: VIEWER,
  member: MEMBER,
  operator: OPERATOR,
  owner: CAPABILITIES,
};

/**
 * The `caps` claim a role's access token carries: the role expanded, or the wildcard for an owner.
 * The role comes from a stored row, so a value outside `ROLES` (a database the roles migration
 * never ran on) throws here, naming it, rather than signing a token with no `caps` claim that
 * every verifier then refuses without a word.
 *
 * @example
 * capsClaimOf("owner"); // ["*"]
 * capsClaimOf("viewer"); // ["tasks:read", "patches:read", ...]
 *
 * @throws {Error} when `role` is not one of `ROLES`.
 */
export function capsClaimOf(role: Role): readonly CapabilityClaim[] {
  if (role === "owner") return [EVERY_CAPABILITY];
  const caps = ROLE_CAPABILITIES[role];
  if (caps === undefined) {
    throw new Error(`unknown role "${role}": expected one of ${ROLES.join(", ")}`);
  }
  return caps;
}

/**
 * Whether a value is one entry of a `caps` claim, for a verifier reading an untyped payload.
 *
 * @example
 * Array.isArray(payload.caps) && payload.caps.every(isCapabilityClaim);
 */
export function isCapabilityClaim(value: unknown): value is CapabilityClaim {
  return value === EVERY_CAPABILITY ||
    (typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value));
}

/**
 * Whether a caller holds a capability. The one question every gate asks.
 *
 * @example
 * if (!can(claims, "tools:manage")) return json(403, forbidden("tools:manage"));
 */
export function can(
  caller: { caps: readonly CapabilityClaim[] },
  capability: Capability,
): boolean {
  return caller.caps.includes(EVERY_CAPABILITY) || caller.caps.includes(capability);
}

/**
 * Whether a caller may hand out a role: only a role whose capabilities are a subset of the
 * caller's own, so nobody grants more than they hold. Only an owner grants `owner`.
 *
 * @example
 * if (!mayGrant(claims, body.role)) return json(403, forbidden("users:manage", "granting owner"));
 */
export function mayGrant(caller: { caps: readonly CapabilityClaim[] }, role: Role): boolean {
  if (role === "owner") return caller.caps.includes(EVERY_CAPABILITY);
  return ROLE_CAPABILITIES[role].every((capability) => can(caller, capability));
}

/** The code on every "you may not" refusal, as distinct from "who are you?". */
export const FORBIDDEN = "forbidden";

/**
 * The body of a 403 that names the capability the caller lacks, so a client can tell which
 * control to hide and a person knows which role to ask for.
 *
 * @example
 * return json(403, forbidden("egress:manage", "changing the allowlist"));
 */
export function forbidden(
  capability: Capability,
  what?: string,
): { error: string; code: typeof FORBIDDEN; capability: Capability } {
  return {
    error: what === undefined ? `requires ${capability}` : `${what} requires ${capability}`,
    code: FORBIDDEN,
    capability,
  };
}
