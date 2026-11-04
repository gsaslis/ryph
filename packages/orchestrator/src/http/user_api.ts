// The user surface: create and edit agents, assign tasks to them, watch and cancel runs,
// connect repos, link GitHub identities, and shepherd patches to the forge.
//
// Invariants:
// - Run rows are never serialized raw: `toPublicRun` strips the credentials (tokenHash,
//   controlToken) — the redaction lives in exactly one place. `toPublicPatch` exists for the
//   same reason even though patches carry no secret today: the chokepoint is cheap now and
//   a retrofit later is how a leak ships
// - ids, tokens, and the branch name are minted here, never accepted from the caller
// - the work item is composed exactly once, at provision time, and frozen onto the run —
//   editing an agent never changes what an in-flight run was asked to do
// - the task and run rows are persisted before the container is launched; if the launch fails,
//   that failure is recorded by setting the run's state to "errored" — accepted work is never
//   silently dropped
// - agents are soft-deleted (archived): historical tasks and runs keep resolving them
// - GitHub is the authorization source of truth for connected repos: permissions are checked
//   LIVE at the moment of the action, never mirrored into rows. Actions that reach the repo's
//   code need write (launch a task, approve or retry a patch — each one ends in a branch and a
//   PR on the upstream); actions that change the connection itself need admin (connect, change
//   the submission policy, disconnect), because relaxing a policy to "auto" removes the human
//   gate from every patch that follows. "The forge did not answer" is treated as denied — the
//   resilience deferral, applied at this call site and nowhere in the port's shape
// - every route names the capability it takes, checked first thing after the token; the
//   forge checks below come on top of it
// - a repo's or workspace's SIZE CLASS takes `resources:manage`, not the repo admin's word: it
//   spends the operator's money, like the egress allowlist, and the forge has no opinion on who
//   pays
// - binding a credential to an agent takes `agents:policy`: setting or changing a non-null
//   `modelPolicy` or `toolPolicy` points an agent anyone may launch at a secret the operator
//   holds. `forgePolicy` is gated the same way: it lends an agent the GitHub App's hand to write
//   with. Clearing one (`null`) and every other agent edit stay with `agents:write`; taking
//   access away needs no further privilege
// - break-glass acts without a permission check (the token is already a total auth bypass —
//   consistency, not escalation) but is recorded as a POSITIVE fact everywhere it acts

import type { WiredDeps } from "./app.ts";
import type { Route } from "@ryph/shared/http";
import { agentRoutes } from "./user/agents.ts";
import { taskStartRoutes } from "./user/task_start.ts";
import { taskRoutes } from "./user/tasks.ts";
import { responseRoutes } from "./user/responses.ts";
import { patchRoutes } from "./user/patches.ts";
import { repoRoutes } from "./user/repos.ts";
import { gitlabHookRoutes } from "./user/gitlab_hook.ts";
import { workspaceRoutes } from "./user/workspaces.ts";
import { commandAllowlistRoutes } from "./user/command_allowlist.ts";
import { deploymentRoutes } from "./user/deployment.ts";
import { mcpServerRoutes } from "./user/mcp_servers.ts";
export {
  PATCH_CHANGED_ERROR,
  type PatchChecksSummary,
  type PublicPatch,
  type PublicRun,
  TOO_MANY_HOOK_FILES_ERROR,
  toPublicPatch,
  toPublicRun,
} from "./user/public_views.ts";
export { refuseRepoPermission } from "./user/repo_access.ts";

export function userRoutes(deps: WiredDeps): Route[] {
  return [
    ...agentRoutes(deps),
    ...taskStartRoutes(deps),
    ...taskRoutes(deps),
    ...responseRoutes(deps),
    ...patchRoutes(deps),
    ...repoRoutes(deps),
    ...gitlabHookRoutes(deps),
    ...workspaceRoutes(deps),
    ...commandAllowlistRoutes(deps),
    ...deploymentRoutes(deps),
    ...mcpServerRoutes(deps),
  ];
}
