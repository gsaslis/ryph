// The lookups every route makes, with GitLab's answers when they fail: a project the caller may
// not see is `404 Project Not Found` (never 403), and so is a missing one.

import { ApiError } from "../errors.ts";
import type { Ctx } from "../http.ts";
import type { Issue, MergeRequest, Noteable, Project, User } from "../model.ts";

export function signedIn(ctx: Ctx): User {
  if (!ctx.user) throw new ApiError(401, { message: "401 Unauthorized" });
  return ctx.user;
}

export function projectOf(ctx: Ctx): Project {
  const p = ctx.gl.world.project(ctx.params.id!);
  if (!p || !ctx.gl.world.canSee(ctx.user, p)) {
    throw new ApiError(404, { message: "404 Project Not Found" });
  }
  return p;
}

/** The project, when the caller may read its code and merge requests; a Guest of a private
 * project gets 403, as GitLab answers there. */
export function codeProjectOf(ctx: Ctx): Project {
  const p = projectOf(ctx);
  if (!ctx.gl.world.canReadCode(ctx.user, p)) throw new ApiError(403, { message: "403 Forbidden" });
  return p;
}

/** Refuses unless the caller holds `level` on the project. */
export function need(ctx: Ctx, project: Project, level: number): User {
  const user = signedIn(ctx);
  if (!ctx.gl.world.can(user, project, level)) {
    throw new ApiError(403, { message: "403 Forbidden" });
  }
  return user;
}

function iidOf(ctx: Ctx, what: string): number {
  const raw = ctx.params.iid!;
  if (!/^\d+$/.test(raw)) throw new ApiError(404, { message: `404 ${what} Not Found` });
  return Number(raw);
}

export function issueOf(ctx: Ctx): { project: Project; issue: Issue } {
  const project = projectOf(ctx);
  const issue = ctx.gl.world.issue(project, iidOf(ctx, "Issue"));
  // A confidential issue is not there for whoever may not see it.
  if (!issue || (issue.confidential && !ctx.gl.seesPrivate(ctx.user, project.id, issue.authorId))) {
    throw new ApiError(404, { message: "404 Issue Not Found" });
  }
  return { project, issue };
}

export function mrOf(ctx: Ctx): { project: Project; mr: MergeRequest } {
  const project = codeProjectOf(ctx);
  const mr = ctx.gl.world.mergeRequest(project, iidOf(ctx, "Merge Request"));
  if (!mr) throw new ApiError(404, { message: "404 Merge Request Not Found" });
  return { project, mr };
}

/** The issue or merge request a `/{issues,merge_requests}/:iid/…` route names. */
export function noteableOf(
  ctx: Ctx,
  kind: "issues" | "merge_requests",
): { project: Project; on: Noteable } {
  if (kind === "issues") {
    const { project, issue } = issueOf(ctx);
    return { project, on: issue };
  }
  const { project, mr } = mrOf(ctx);
  return { project, on: mr };
}
