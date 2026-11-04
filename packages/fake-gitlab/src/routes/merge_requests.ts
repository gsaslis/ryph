// Merge requests over REST: listing, reading (with live `diff_refs`), opening (fork merge
// requests through `target_project_id`), editing, merging, diffs and commits, approvals, and
// draft notes with their bulk publish.

import { ApiError } from "../errors.ts";
import { diff as gitDiff, log, VERSION_LIMIT_BYTES } from "../git/repo.ts";
import {
  bool,
  type Ctx,
  forbidden,
  int,
  json,
  list,
  missing,
  notFound,
  ordered,
  paginate,
  type Router,
  str,
} from "../http.ts";
import { ACCESS, type DraftNote, type MergeRequest } from "../model.ts";
import { carryOut, onCreate } from "../quick_actions.ts";
import { codeProjectOf, mrOf, signedIn } from "./common.ts";
import { commonFilter } from "./issues.ts";

function draftOf(ctx: Ctx, mr: MergeRequest): DraftNote {
  const user = signedIn(ctx);
  const d = mr.drafts.find((x) => x.id === Number(ctx.params.draft_id) && x.authorId === user.id);
  if (!d) throw new ApiError(404, { message: "404 Draft Note Not Found" });
  return d;
}

export function mergeRequestRoutes(r: Router) {
  const base = "/projects/:id/merge_requests/:iid";

  r.add("GET", "/projects/:id/merge_requests", (ctx) => {
    const p = codeProjectOf(ctx);
    const state = str(ctx.input.state) ?? "all";
    const source = str(ctx.input.source_branch);
    const target = str(ctx.input.target_branch);
    const draft = bool(ctx.input.draft) ??
      (str(ctx.input.wip) === null ? null : str(ctx.input.wip) === "yes");
    const keep = commonFilter(ctx);
    const hits = ctx.gl.world.mergeRequests.filter((m) =>
      m.projectId === p.id && (state === "all" || m.state === state) &&
      (source === null || m.sourceBranch === source) &&
      (target === null || m.targetBranch === target) &&
      (draft === null || ctx.gl.present.mergeRequest(m).draft === draft) && keep(m)
    );
    return paginate(ctx, ordered(ctx, hits), (m) => ctx.gl.present.mergeRequest(m));
  });

  r.add("GET", base, async (ctx) => {
    const { mr } = mrOf(ctx);
    return json(ctx.gl.present.mergeRequest(mr, await ctx.gl.diffRefs(mr)));
  });

  r.add("POST", "/projects/:id/merge_requests", async (ctx) => {
    const source = codeProjectOf(ctx);
    const user = signedIn(ctx);
    if (!ctx.gl.world.can(user, source, ACCESS.developer)) return forbidden();
    const sourceBranch = str(ctx.input.source_branch);
    if (!sourceBranch) return missing("source_branch");
    const targetBranch = str(ctx.input.target_branch);
    if (!targetBranch) return missing("target_branch");
    const title = str(ctx.input.title);
    if (!title) return missing("title");
    const targetId = int(ctx.input.target_project_id);
    const target = targetId === null ? source : ctx.gl.world.projects.get(targetId);
    if (!target || !ctx.gl.world.canReadCode(user, target)) return notFound("Project");
    const { description, addLabels, removeLabels } = onCreate(
      ctx.gl,
      user,
      target,
      str(ctx.input.description) ?? "",
    );
    const drop = removeLabels.map((l) => l.toLowerCase());
    const mr = await ctx.gl.mrs.create(user, source, {
      target,
      sourceBranch,
      targetBranch,
      title,
      description,
      allowCollaboration: bool(ctx.input.allow_collaboration) ??
        bool(ctx.input.allow_maintainer_to_push) ?? false,
      removeSourceBranch: bool(ctx.input.remove_source_branch) ?? false,
      squash: bool(ctx.input.squash) ?? false,
      labels: [...(list(ctx.input.labels) ?? []), ...addLabels].filter((l) =>
        !drop.includes(l.toLowerCase())
      ),
    });
    return json(ctx.gl.present.mergeRequest(mr, await ctx.gl.diffRefs(mr)), 201);
  });

  r.add("PUT", base, async (ctx) => {
    const { mr } = mrOf(ctx);
    const user = signedIn(ctx);
    if (mr.authorId !== user.id && !ctx.gl.mrs.canDevelop(user, mr)) return forbidden();
    const stateEvent = str(ctx.input.state_event);
    if (stateEvent !== null && stateEvent !== "close" && stateEvent !== "reopen") {
      return json({ error: "state_event does not have a valid value" }, 400);
    }
    // A description's quick actions run on an edit, and leave it.
    const raw = str(ctx.input.description);
    const description = raw === null ? undefined : (await carryOut(ctx.gl, user, mr, raw)).body;
    await ctx.gl.mrs.update(user, mr, {
      title: str(ctx.input.title) ?? undefined,
      description,
      targetBranch: str(ctx.input.target_branch) ?? undefined,
      stateEvent: stateEvent ?? undefined,
      labels: list(ctx.input.labels) ?? undefined,
      addLabels: list(ctx.input.add_labels) ?? undefined,
      removeLabels: list(ctx.input.remove_labels) ?? undefined,
      allowCollaboration: bool(ctx.input.allow_collaboration) ?? undefined,
    });
    return json(ctx.gl.present.mergeRequest(mr, await ctx.gl.diffRefs(mr)));
  });

  r.add("PUT", `${base}/merge`, async (ctx) => {
    const { project, mr } = mrOf(ctx);
    const user = signedIn(ctx);
    if (!ctx.gl.world.canMergeInto(user, project, mr.targetBranch)) {
      return json({ message: "401 Unauthorized" }, 401);
    }
    const sha = str(ctx.input.sha);
    if (sha !== null && sha !== mr.headSha) {
      return json({ message: "SHA does not match HEAD of source branch" }, 409);
    }
    await ctx.gl.mrs.merge(user, mr, {
      squash: bool(ctx.input.squash) ?? undefined,
      message: str(ctx.input.merge_commit_message) ?? undefined,
      removeSourceBranch: bool(ctx.input.should_remove_source_branch) ?? undefined,
    });
    return json(ctx.gl.present.mergeRequest(mr, await ctx.gl.diffRefs(mr)));
  });

  r.add("GET", `${base}/diffs`, async (ctx) => {
    const { mr } = mrOf(ctx);
    return paginate(ctx, await ctx.gl.mergeRequestDiff(mr), (f) => f);
  });

  r.add("GET", `${base}/versions`, async (ctx) => {
    const { mr } = mrOf(ctx);
    return paginate(ctx, await ctx.gl.versionsOf(mr), (v) => ctx.gl.present.version(v, mr));
  });

  r.add("GET", `${base}/versions/:version_id`, async (ctx) => {
    const { project, mr } = mrOf(ctx);
    const v = (await ctx.gl.versionsOf(mr)).find((x) => x.id === Number(ctx.params.version_id));
    if (!v) return notFound("Merge Request Diff");
    const diffs = await gitDiff(project.gitDir, v.baseSha, v.headSha, {
      limit: VERSION_LIMIT_BYTES,
    });
    return json({ ...ctx.gl.present.version(v, mr), commits: [], diffs });
  });

  r.add("GET", `${base}/commits`, async (ctx) => {
    const { project, mr } = mrOf(ctx);
    const refs = await ctx.gl.diffRefs(mr);
    const commits = refs ? await log(project.gitDir, `${refs.base_sha}..${refs.head_sha}`) : [];
    return paginate(ctx, commits, (c) => ctx.gl.present.commit(c, project));
  });

  r.add("GET", `${base}/approvals`, (ctx) => {
    const { mr } = mrOf(ctx);
    return json({
      id: mr.id,
      iid: mr.iid,
      project_id: mr.projectId,
      approved: mr.approvedBy.length > 0,
      approved_by: mr.approvedBy.map((id) => ({ user: ctx.gl.present.userById(id) })),
    });
  });

  r.add("POST", `${base}/approve`, async (ctx) => {
    const { mr } = mrOf(ctx);
    const user = signedIn(ctx);
    if (!ctx.gl.mrs.canDevelop(user, mr)) return forbidden();
    await ctx.gl.mrs.approve(user, mr);
    return json({
      approved: true,
      approved_by: mr.approvedBy.map((id) => ({ user: ctx.gl.present.userById(id) })),
    }, 201);
  });

  r.add("POST", `${base}/unapprove`, async (ctx) => {
    const { mr } = mrOf(ctx);
    const user = signedIn(ctx);
    await ctx.gl.mrs.unapprove(user, mr);
    return json({ approved: mr.approvedBy.length > 0 }, 201);
  });

  r.add("GET", `${base}/draft_notes`, (ctx) => {
    const { mr } = mrOf(ctx);
    const user = signedIn(ctx);
    return paginate(
      ctx,
      mr.drafts.filter((d) => d.authorId === user.id),
      (d) => ctx.gl.present.draft(d, mr),
    );
  });

  r.add("GET", `${base}/draft_notes/:draft_id`, (ctx) => {
    const { mr } = mrOf(ctx);
    return json(ctx.gl.present.draft(draftOf(ctx, mr), mr));
  });

  r.add("POST", `${base}/draft_notes`, async (ctx) => {
    const { mr } = mrOf(ctx);
    const user = signedIn(ctx);
    const note = str(ctx.input.note);
    if (!note) return missing("note");
    const replyTo = str(ctx.input.in_reply_to_discussion_id);
    const inReplyTo = replyTo === null
      ? null
      : mr.discussions.find((d) => d.id === replyTo) ?? null;
    if (replyTo !== null && !inReplyTo) return notFound("Discussion");
    // GitLab checks a draft's position only when it is published, where a bad one is dropped;
    // here only its SHAs must exist (verified on GitLab 17.11).
    const position = ctx.input.position === undefined
      ? null
      : await ctx.gl.mrs.knownPosition(mr, ctx.input.position);
    const draft = ctx.gl.mrs.addDraft(user, mr, {
      note,
      position,
      inReplyTo,
      resolveDiscussion: bool(ctx.input.resolve_discussion) ?? false,
    });
    return json(ctx.gl.present.draft(draft, mr), 201);
  });

  r.add("PUT", `${base}/draft_notes/:draft_id`, (ctx) => {
    const { mr } = mrOf(ctx);
    const d = draftOf(ctx, mr);
    const note = str(ctx.input.note);
    if (note !== null) d.note = note;
    return json(ctx.gl.present.draft(d, mr));
  });

  r.add("DELETE", `${base}/draft_notes/:draft_id`, (ctx) => {
    const { mr } = mrOf(ctx);
    const d = draftOf(ctx, mr);
    mr.drafts = mr.drafts.filter((x) => x !== d);
    return new Response(null, { status: 204 });
  });

  r.add("PUT", `${base}/draft_notes/:draft_id/publish`, async (ctx) => {
    const { mr } = mrOf(ctx);
    const d = draftOf(ctx, mr);
    await ctx.gl.mrs.publishDrafts(signedIn(ctx), mr, d.id);
    return new Response(null, { status: 204 });
  });

  r.add("POST", `${base}/draft_notes/bulk_publish`, async (ctx) => {
    const { mr } = mrOf(ctx);
    await ctx.gl.mrs.publishDrafts(signedIn(ctx), mr);
    return new Response(null, { status: 204 });
  });
}
