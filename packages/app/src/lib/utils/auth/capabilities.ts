// The capability catalogue and the roles that bundle it, as the access token spells them. The
// VALUES are the contract with @ryph/auth, which owns the list; this app does not import the server
// packages and carries its own copy.

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

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Capabilities an API token may not carry: the auth service answers them to a signed-in session
 * only, so a token holding one could never use it. The form leaves them out.
 */
export const SESSION_ONLY_CAPABILITIES: readonly Capability[] = [
  "users:manage",
  "settings:manage",
  "tokens:write",
  "tokens:manage-all",
];

export const ROLES = ["viewer", "member", "operator", "owner"] as const;

export type Role = (typeof ROLES)[number];

/** Whether the signed-in user holds a capability; `"*"` in the list is an owner and holds all. */
export function can(user: { caps: readonly string[] } | null | undefined, capability: Capability) {
  return user != null && (user.caps.includes("*") || user.caps.includes(capability));
}
