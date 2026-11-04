// The steps an agent is made and edited in, and the checks on the two that have required fields.
// The policy steps have their own checks beside their bridges (tool-policy, forge-policy,
// network-policy); these are the ones nothing else owns.

export type AgentStepId =
  | "identity"
  | "model"
  | "instructions"
  | "tools"
  | "skills"
  | "permissions"
  | "limits"
  | "review";

export interface AgentStep {
  id: AgentStepId;
  label: string;
  heading: string;
  description: string;
}

/** The steps in the order they are listed; the review is the create flow's alone. */
export const AGENT_STEPS: readonly AgentStep[] = [
  {
    id: "identity",
    label: "Identity",
    heading: "Identity",
    description: "Give your agent a name and handle.",
  },
  {
    id: "model",
    label: "Model",
    heading: "Model",
    description: "Pick the model key the agent spends, and the models it may call.",
  },
  {
    id: "instructions",
    label: "Instructions",
    heading: "Instructions",
    description: "Optionally, write a custom prompt to guide the agent's behavior.",
  },
  {
    id: "tools",
    label: "Tools and memory",
    heading: "Tools and memory",
    description:
      "Configure which tools the agent may access, whether it gets a browser, and whether it retains memory between runs.",
  },
  {
    id: "skills",
    label: "Skills",
    heading: "Skills",
    description:
      "Choose which skills the agent may read. Everything this deployment offers is on by default.",
  },
  {
    id: "permissions",
    label: "Permissions",
    heading: "Permissions",
    description:
      "Allow your agent to interact with issues, change requests, and the internet as configured.",
  },
  {
    id: "limits",
    label: "Limits",
    heading: "Limits",
    description:
      "How long a run of this agent may run, how much it may spend, and how many model calls it may hold open. An administrator's call.",
  },
  {
    id: "review",
    label: "Review",
    heading: "Review",
    description: "Review the agent's configuration before creation.",
  },
];

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The handle the agent will have: the one typed, else the one the server derives from the name —
 * the name's slug, cut to 30 and trimmed of a trailing dash, as the orchestrator does it (a taken
 * one gets a numeric suffix there, which this cannot know). Null while there is nothing to derive
 * from.
 */
export function expectedHandle(name: string, handle: string): string | null {
  const typed = handle.trim();
  if (typed !== "") return typed;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = slug.slice(0, 30).replace(/-+$/, "");
  return base === "" ? null : base;
}

/**
 * The email an agent gets when none is typed: its handle at this deployment's host — the address
 * the app is served at, `ryph.example.com` say — so two deployments' agents never share
 * an address, and nothing has to be configured for it.
 */
export function defaultAgentEmail(name: string, handle: string, host: string): string | null {
  const expected = expectedHandle(name, handle);
  return expected === null ? null : `${expected}@${emailDomain(host)}`;
}

/**
 * The host as an email domain the orchestrator accepts. Its `z.email()` wants a dotted name
 * ending in a letter TLD, so `localhost`, a bare machine name or an IP literal — what a local
 * dev stack is served at — would make the default unsavable. Those get `ryph.localhost`
 * instead: `.localhost` is reserved (RFC 6761) and never routes anywhere.
 */
function emailDomain(host: string): string {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) ? host : "ryph.localhost";
}

/** The email that will be saved: the typed one, else the default. */
export function effectiveEmail(name: string, handle: string, email: string, host: string): string {
  return email.trim() || defaultAgentEmail(name, handle, host) || "";
}

/** Why the identity step cannot be saved as it stands, in the operator's words — or null. */
export function identityProblem(
  name: string,
  handle: string,
  email: string,
  host: string,
): string | null {
  if (name.trim() === "") return "Give the agent a name.";
  const trimmedHandle = handle.trim();
  if (trimmedHandle !== "" && (trimmedHandle.length > 39 || !HANDLE_PATTERN.test(trimmedHandle))) {
    return "A handle is lowercase letters, digits and dashes, up to 39 of them.";
  }
  // An empty email is the default one, which exists once there is a name; a typed one has to
  // look like an address.
  if (!/^[^\s@]+@[^\s@]+$/.test(effectiveEmail(name, handle, email, host))) {
    return "Give the agent an email address.";
  }
  return null;
}
