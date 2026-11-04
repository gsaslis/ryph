// The naming rules the orchestrator owns: agent handles in slug form, and the run's branch
// namespace (the lines under it are @ryph/shared/lines). Minting ids and tokens, hashing them,
// and comparing hashes is @ryph/sealed's job — the same kit every service uses, so a run id and
// a session id have one shape by construction.
//
// Invariants:
// - slugs and branch names are path-safe (they ride URLs, container names, and git refs)

/** A name reduced to slug form — branch segments and agent handles share this shape. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** The run's branch NAMESPACE, e.g. "ryph/ada/r-01jb7k3m9x4q8zt2vw6hn5c0fe" — collision-free per
 * run, the same in every repo of it. No branch is ever named this: each line of work ships on
 * `<namespace>/<line>` (@ryph/shared/lines). */
export function branchNameFor(agentHandle: string, runId: string): string {
  return `ryph/${slugify(agentHandle)}/${runId}`;
}
