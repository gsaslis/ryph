// Issues: listing with GitLab's filters, reading, opening and editing (`state_event`, labels).

import { ACCESS, type Issue, type MergeRequest } from "../model.ts";
import {
  bool,
  type Ctx,
  forbidden,
  int,
  json,
  list,
  missing,
  ordered,
  paginate,
  type Router,
  str,
} from "../http.ts";
import { carryOut, onCreate } from "../quick_actions.ts";
import { issueOf, projectOf, signedIn } from "./common.ts";

/** GitLab's `labels` filter: every named label must be on it; `None` means no label, `Any` at
 * least one. */
export function labelFilter(ctx: Ctx): (labels: string[]) => boolean {
  const want = list(ctx.input.labels);
  if (want === null || want.length === 0) return () => true;
  if (want.length === 1 && want[0]!.toLowerCase() === "none") return (l) => l.length === 0;
  if (want.length === 1 && want[0]!.toLowerCase() === "any") return (l) => l.length > 0;
  const lower = want.map((w) => w.toLowerCase());
  return (l) => lower.every((w) => l.some((x) => x.toLowerCase() === w));
}

/** The filters issues and merge requests share: author, creation and update windows, iids. */
export function commonFilter(ctx: Ctx): (x: Issue | MergeRequest) => boolean {
  const authorId = int(ctx.input.author_id);
  const authorName = str(ctx.input.author_username);
  const author = authorName === null ? null : ctx.gl.world.userByUsername(authorName);
  const createdAfter = str(ctx.input.created_after);
  const createdBefore = str(ctx.input.created_before);
  const updatedAfter = str(ctx.input.updated_after);
  const iids = list(ctx.input.iids)?.map(Number) ?? null;
  const labels = labelFilter(ctx);
  const search = str(ctx.input.search)?.toLowerCase() ?? null;
  return (x) =>
    (authorId === null || x.authorId === authorId) &&
    (authorName === null || x.authorId === author?.id) &&
    (createdAfter === null || x.createdAt >= new Date(createdAfter).toISOString()) &&
    (createdBefore === null || x.createdAt <= new Date(createdBefore).toISOString()) &&
    (updatedAfter === null || x.updatedAt >= new Date(updatedAfter).toISOString()) &&
    (iids === null || iids.includes(x.iid)) &&
    labels(x.labels) &&
    (search === null || x.title.toLowerCase().includes(search) ||
      x.description.toLowerCase().includes(search));
}

export function issueRoutes(r: Router) {
  r.add("GET", "/projects/:id/issues", (ctx) => {
    const p = projectOf(ctx);
    const state = str(ctx.input.state) ?? "all";
    const keep = commonFilter(ctx);
    const confidential = bool(ctx.input.confidential);
    const hits = ctx.gl.world.issues.filter((i) =>
      i.projectId === p.id && (state === "all" || i.state === state) && keep(i) &&
      (confidential === null || i.confidential === confidential) &&
      (!i.confidential || ctx.gl.seesPrivate(ctx.user, p.id, i.authorId))
    );
    return paginate(ctx, ordered(ctx, hits), (i) => ctx.gl.present.issue(i));
  });

  r.add(
    "GET",
    "/projects/:id/issues/:iid",
    (ctx) => json(ctx.gl.present.issue(issueOf(ctx).issue)),
  );

  r.add("POST", "/projects/:id/issues", (ctx) => {
    const p = projectOf(ctx);
    const user = signedIn(ctx);
    const title = str(ctx.input.title);
    if (!title) return missing("title");
    const { description, addLabels, removeLabels } = onCreate(
      ctx.gl,
      user,
      p,
      str(ctx.input.description) ?? "",
    );
    const drop = removeLabels.map((l) => l.toLowerCase());
    const issue = ctx.gl.createIssue(user, p, {
      title,
      description,
      labels: [...(list(ctx.input.labels) ?? []), ...addLabels].filter((l) =>
        !drop.includes(l.toLowerCase())
      ),
      confidential: bool(ctx.input.confidential) ?? false,
    });
    return json(ctx.gl.present.issue(issue), 201);
  });

  r.add("PUT", "/projects/:id/issues/:iid", async (ctx) => {
    const { project, issue } = issueOf(ctx);
    const user = signedIn(ctx);
    // The author edits and closes their own; changing someone else's takes Reporter.
    if (issue.authorId !== user.id && !ctx.gl.world.can(user, project, ACCESS.reporter)) {
      return forbidden();
    }
    const stateEvent = str(ctx.input.state_event);
    if (stateEvent !== null && stateEvent !== "close" && stateEvent !== "reopen") {
      return json({ error: "state_event does not have a valid value" }, 400);
    }
    // A description's quick actions run on an edit, and leave it.
    const raw = str(ctx.input.description);
    const description = raw === null ? undefined : (await carryOut(ctx.gl, user, issue, raw)).body;
    ctx.gl.updateIssue(user, issue, {
      title: str(ctx.input.title) ?? undefined,
      description,
      stateEvent: stateEvent ?? undefined,
      labels: list(ctx.input.labels) ?? undefined,
      addLabels: list(ctx.input.add_labels) ?? undefined,
      removeLabels: list(ctx.input.remove_labels) ?? undefined,
    });
    return json(ctx.gl.present.issue(issue));
  });
}
