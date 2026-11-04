// Notes, discussions and award emoji, for issues and merge requests alike (`/issues/:iid/…` and
// `/merge_requests/:iid/…` take the same routes). A note posted through `/notes` is an individual
// note; through `/discussions` it starts a thread (a diff note when it carries a `position`);
// replies and resolution act on the discussion id.

import { ApiError } from "../errors.ts";
import {
  bool,
  type Ctx,
  forbidden,
  json,
  missing,
  notFound,
  paginate,
  type Router,
  str,
} from "../http.ts";
import {
  ACCESS,
  type Award,
  type Discussion,
  type Note,
  type Noteable,
  type User,
} from "../model.ts";
import { carryOut, summaryOf } from "../quick_actions.ts";
import { suggestionsOf } from "../suggestions.ts";
import { need, noteableOf, signedIn } from "./common.ts";

const KINDS = ["issues", "merge_requests"] as const;

/** A write made only of quick actions stores no note: 202 with what they changed and GitLab's
 * sentences for it (verified on GitLab 17.11 for `/notes`; taken to hold for every note route). */
const commandsOnly = (applied: Record<string, unknown>): Response =>
  json({ commands_changes: applied, summary: summaryOf(applied) }, 202);

/** Whether the caller sees a note: an internal one is for Reporters and up, and its author. */
const seen = (ctx: Ctx, on: Noteable, n: Note): boolean =>
  !n.internal || ctx.gl.seesPrivate(ctx.user, on.projectId, n.authorId);

function discussionOf(ctx: Ctx, on: Noteable): Discussion {
  const d = on.discussions.find((x) => x.id === ctx.params.discussion_id);
  if (!d) throw new ApiError(404, { message: "404 Discussion Not Found" });
  return d;
}

function noteOf(ctx: Ctx, on: Noteable) {
  const hit = ctx.gl.world.findNote(on, Number(ctx.params.note_id));
  if (!hit) throw new ApiError(404, { message: "404 Note Not Found" });
  return hit;
}

function mayComment(ctx: Ctx, on: Noteable): User {
  const user = signedIn(ctx);
  if (!ctx.gl.canSeeNoteable(user, on)) throw new ApiError(403, { message: "403 Forbidden" });
  return user;
}

function award(ctx: Ctx, awards: Award[], awardableId: number, type: string): Response {
  const user = signedIn(ctx);
  const name = str(ctx.input.name);
  if (!name) return missing("name");
  if (!/^[a-z0-9_+-]+$/.test(name)) {
    return json({ message: "404 Award Emoji Name is not a valid emoji name Not Found" }, 404);
  }
  // GitLab's answer for a duplicate award, verified on 17.0 and 17.11: a 404 carrying the
  // validation text.
  if (awards.some((a) => a.userId === user.id && a.name === name)) {
    return json({ message: "404 Award Emoji Name has already been taken Not Found" }, 404);
  }
  const a: Award = {
    id: ctx.gl.world.nextId("award"),
    name,
    userId: user.id,
    createdAt: ctx.gl.world.stamp(),
  };
  awards.push(a);
  return json(ctx.gl.present.award(a, awardableId, type), 201);
}

function dropAward(ctx: Ctx, awards: Award[]): Response {
  const user = signedIn(ctx);
  const at = awards.findIndex((a) => a.id === Number(ctx.params.award_id));
  if (at === -1) return notFound("Award Emoji");
  if (awards[at]!.userId !== user.id && !user.admin) return forbidden();
  awards.splice(at, 1);
  return new Response(null, { status: 204 });
}

export function noteRoutes(r: Router) {
  for (const kind of KINDS) {
    const base = `/projects/:id/${kind}/:iid`;
    const typeName = kind === "issues" ? "Issue" : "MergeRequest";

    r.add("GET", `${base}/notes`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const notes = on.discussions.flatMap((d) => d.notes).filter((n) => seen(ctx, on, n));
      const by = str(ctx.input.order_by) === "updated_at" ? "updatedAt" : "createdAt";
      const asc = str(ctx.input.sort) === "asc";
      notes.sort((a, b) => {
        const c = a[by] < b[by] ? -1 : a[by] > b[by] ? 1 : a.id - b.id;
        return asc ? c : -c;
      });
      return paginate(ctx, notes, (n) => ctx.gl.present.note(n, on));
    });

    r.add("GET", `${base}/notes/:note_id`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const { note } = noteOf(ctx, on);
      if (!seen(ctx, on, note)) return notFound("Note");
      return json(ctx.gl.present.note(note, on));
    });

    r.add("POST", `${base}/notes`, async (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const user = mayComment(ctx, on);
      const raw = str(ctx.input.body);
      if (!raw) return missing("body");
      const { body, applied } = await carryOut(ctx.gl, user, on, raw);
      if (body === "") return commandsOnly(applied);
      const { note } = await ctx.gl.addNote(user, on, {
        body,
        mode: "individual",
        internal: bool(ctx.input.internal) ?? bool(ctx.input.confidential) ?? false,
      });
      return json(ctx.gl.present.note(note, on), 201);
    });

    r.add("PUT", `${base}/notes/:note_id`, async (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const user = signedIn(ctx);
      const { note } = noteOf(ctx, on);
      if (note.system || note.authorId !== user.id) return forbidden();
      const raw = str(ctx.input.body);
      if (!raw) return missing("body");
      // An edit runs quick actions as a new note does (`Notes::UpdateService`).
      const { body } = await carryOut(ctx.gl, user, on, raw);
      if (body !== "") note.body = body;
      if (on.kind === "merge_request") note.suggestions = await suggestionsOf(ctx.gl, on, note);
      note.updatedAt = ctx.gl.world.stamp();
      return json(ctx.gl.present.note(note, on));
    });

    r.add("DELETE", `${base}/notes/:note_id`, (ctx) => {
      const { project, on } = noteableOf(ctx, kind);
      const user = signedIn(ctx);
      const { discussion, note } = noteOf(ctx, on);
      if (note.authorId !== user.id && !ctx.gl.world.can(user, project, ACCESS.maintainer)) {
        return forbidden();
      }
      discussion.notes = discussion.notes.filter((n) => n.id !== note.id);
      if (discussion.notes.length === 0) {
        on.discussions = on.discussions.filter((d) => d !== discussion);
      }
      return new Response(null, { status: 204 });
    });

    r.add("GET", `${base}/discussions`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const shown = on.discussions
        .map((d) => ({ ...d, notes: d.notes.filter((n) => seen(ctx, on, n)) }))
        .filter((d) => d.notes.length > 0);
      return paginate(ctx, shown, (d) => ctx.gl.present.discussion(d, on));
    });

    r.add("GET", `${base}/discussions/:discussion_id`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      return json(ctx.gl.present.discussion(discussionOf(ctx, on), on));
    });

    r.add("POST", `${base}/discussions`, async (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const user = mayComment(ctx, on);
      const raw = str(ctx.input.body);
      if (!raw) return missing("body");
      const position = ctx.input.position;
      if (position !== undefined && on.kind !== "merge_request") {
        return json({ message: "400 Bad request - position is only valid on merge requests" }, 400);
      }
      const checked = position !== undefined && on.kind === "merge_request"
        ? await ctx.gl.mrs.checkPosition(on, position)
        : null;
      const { body, applied } = await carryOut(ctx.gl, user, on, raw);
      if (body === "") return commandsOnly(applied);
      const { discussion } = await ctx.gl.addNote(user, on, {
        body,
        mode: "discussion",
        position: checked,
        internal: bool(ctx.input.internal) ?? bool(ctx.input.confidential) ?? false,
      });
      return json(ctx.gl.present.discussion(discussion, on), 201);
    });

    r.add("POST", `${base}/discussions/:discussion_id/notes`, async (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const user = mayComment(ctx, on);
      const discussion = discussionOf(ctx, on);
      const raw = str(ctx.input.body);
      if (!raw) return missing("body");
      const { body, applied } = await carryOut(ctx.gl, user, on, raw);
      if (body === "") return commandsOnly(applied);
      if (discussion.individual) {
        // GitLab turns an individual note into a thread when someone replies to it.
        discussion.individual = false;
        for (const n of discussion.notes) {
          n.type = "DiscussionNote";
          n.resolvable = true;
        }
      }
      const { note } = await ctx.gl.addNote(user, on, { body, mode: "reply", discussion });
      return json(ctx.gl.present.note(note, on), 201);
    });

    r.add("PUT", `${base}/discussions/:discussion_id`, (ctx) => {
      const { project, on } = noteableOf(ctx, kind);
      const discussion = discussionOf(ctx, on);
      const user = signedIn(ctx);
      const resolved = str(ctx.input.resolved);
      if (resolved === null) return missing("resolved");
      const author = on.authorId === user.id;
      if (!author) need(ctx, project, ACCESS.developer);
      if (!discussion.notes.some((n) => n.resolvable)) return forbidden();
      ctx.gl.resolveDiscussion(user, discussion, resolved === "true");
      return json(ctx.gl.present.discussion(discussion, on));
    });

    r.add("PUT", `${base}/discussions/:discussion_id/notes/:note_id`, async (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const discussion = discussionOf(ctx, on);
      const user = signedIn(ctx);
      const note = discussion.notes.find((n) => n.id === Number(ctx.params.note_id));
      if (!note) return notFound("Note");
      const body = str(ctx.input.body);
      const resolved = str(ctx.input.resolved);
      if (body !== null) {
        if (note.authorId !== user.id) return forbidden();
        const { body: kept } = await carryOut(ctx.gl, user, on, body);
        if (kept !== "") note.body = kept;
        note.updatedAt = ctx.gl.world.stamp();
      } else if (resolved !== null) {
        ctx.gl.resolveDiscussion(user, discussion, resolved === "true");
      } else return missing("body");
      return json(ctx.gl.present.note(note, on));
    });

    r.add("GET", `${base}/award_emoji`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      return paginate(ctx, on.awards, (a) => ctx.gl.present.award(a, on.id, typeName));
    });

    r.add("POST", `${base}/award_emoji`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      mayComment(ctx, on);
      return award(ctx, on.awards, on.id, typeName);
    });

    r.add("DELETE", `${base}/award_emoji/:award_id`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      return dropAward(ctx, on.awards);
    });

    r.add("GET", `${base}/notes/:note_id/award_emoji`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      const { note } = noteOf(ctx, on);
      return paginate(ctx, note.awards, (a) => ctx.gl.present.award(a, note.id, "Note"));
    });

    r.add("POST", `${base}/notes/:note_id/award_emoji`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      mayComment(ctx, on);
      const { note } = noteOf(ctx, on);
      return award(ctx, note.awards, note.id, "Note");
    });

    r.add("DELETE", `${base}/notes/:note_id/award_emoji/:award_id`, (ctx) => {
      const { on } = noteableOf(ctx, kind);
      return dropAward(ctx, noteOf(ctx, on).note.awards);
    });
  }
}
