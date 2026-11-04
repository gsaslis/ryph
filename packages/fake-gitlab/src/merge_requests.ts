// Merge requests: opening one (by API, or by `merge_request.create` push option), moving with
// its source branch, closing, merging by each of GitLab's methods, approvals, and the draft
// notes of a review, published together. Each emits the Merge Request Hook GitLab would.

import { ApiError } from "./errors.ts";
import {
  type Commit,
  deleteRef,
  isAncestor,
  land,
  log,
  type MergeMethod,
  refs as readRefs,
  revParse,
  updateRef,
  ZERO_SHA,
} from "./git/repo.ts";
import type { Instance } from "./instance.ts";
import {
  ACCESS,
  type Discussion,
  type DraftNote,
  type MergeRequest,
  type Position,
  type Project,
  type User,
} from "./model.ts";
import { carryOut } from "./quick_actions.ts";

type Json = Record<string, unknown>;

export class MergeRequests {
  constructor(readonly gl: Instance) {}

  get #world() {
    return this.gl.world;
  }

  /**
   * Opens a merge request from `source`'s branch into `target`'s; refuses a missing branch, and
   * answers GitLab's 409 when an open one already exists for the same source and target
   * branches.
   */
  async create(actor: User, source: Project, p: {
    target: Project;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
    allowCollaboration?: boolean;
    removeSourceBranch?: boolean;
    squash?: boolean;
    labels?: string[];
  }): Promise<MergeRequest> {
    const { target } = p;
    if (source.id !== target.id && source.forkedFromId !== target.id) {
      throw new ApiError(400, {
        message: ["Validate fork Source project is not a fork of the target project"],
      });
    }
    const head = await revParse(source.gitDir, `refs/heads/${p.sourceBranch}`);
    if (!head) throw new ApiError(400, { message: ["Source branch does not exist"] });
    if (!(await revParse(target.gitDir, `refs/heads/${p.targetBranch}`))) {
      throw new ApiError(400, { message: ["Target branch does not exist"] });
    }
    if (source.id === target.id && p.sourceBranch === p.targetBranch) {
      throw new ApiError(400, {
        message: ["You can't use same project/branch for source and target"],
      });
    }
    const existing = this.#world.mergeRequests.find((m) =>
      m.state === "opened" && m.sourceProjectId === source.id && m.projectId === target.id &&
      m.sourceBranch === p.sourceBranch && m.targetBranch === p.targetBranch
    );
    if (existing) {
      throw new ApiError(409, {
        message: [
          `Another open merge request already exists for this source branch: !${existing.iid}`,
        ],
      });
    }
    const now = this.#world.stamp();
    const mr: MergeRequest = {
      kind: "merge_request",
      id: this.#world.nextId("mr"),
      iid: target.nextMrIid++,
      projectId: target.id,
      sourceProjectId: source.id,
      sourceBranch: p.sourceBranch,
      targetBranch: p.targetBranch,
      title: p.title,
      description: p.description ?? "",
      state: "opened",
      authorId: actor.id,
      labels: this.#world.ensureLabels(target, p.labels ?? []),
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      mergedById: null,
      closedAt: null,
      closedById: null,
      // Only a fork's merge request can allow collaboration; GitLab ignores it otherwise.
      allowCollaboration: source.id !== target.id && (p.allowCollaboration ?? false),
      removeSourceBranch: p.removeSourceBranch ?? false,
      squash: p.squash ?? false,
      headSha: head,
      diffRefs: null,
      mergeCommitSha: null,
      squashCommitSha: null,
      approvedBy: [],
      versions: [],
      drafts: [],
      awards: [],
      discussions: [],
    };
    this.#world.mergeRequests.push(mr);
    await this.gl.syncHeadRef(mr);
    await this.gl.recordVersion(mr);
    await this.hook(actor, mr, "open");
    return mr;
  }

  /** Emits the Merge Request Hook for `mr`. */
  async hook(actor: User, mr: MergeRequest, action: string, extra: Json = {}, changes: Json = {}) {
    const target = this.#world.projects.get(mr.projectId)!;
    const last = await this.gl.headCommit(target, mr.headSha);
    this.gl.hooks.emit(target, "merge_request", {
      object_kind: "merge_request",
      event_type: "merge_request",
      user: this.gl.hooks.user(actor),
      project: this.gl.hooks.project(target),
      object_attributes: this.gl.hooks.mrAttributes(mr, last, { action, ...extra }),
      labels: this.gl.hooks.labels(target, mr.labels),
      changes,
      repository: this.gl.hooks.repository(target),
    });
  }

  /** An edit: title, description, labels, target branch, and `state_event` close/reopen. */
  async update(actor: User, mr: MergeRequest, p: {
    title?: string;
    description?: string;
    targetBranch?: string;
    stateEvent?: "close" | "reopen";
    labels?: string[];
    addLabels?: string[];
    removeLabels?: string[];
    allowCollaboration?: boolean;
  }) {
    const target = this.#world.projects.get(mr.projectId)!;
    const changes: Json = {};
    if (p.title !== undefined && p.title !== mr.title) {
      changes.title = { previous: mr.title, current: p.title };
      mr.title = p.title;
    }
    if (p.description !== undefined && p.description !== mr.description) {
      changes.description = { previous: mr.description, current: p.description };
      mr.description = p.description;
    }
    if (p.targetBranch !== undefined && p.targetBranch !== mr.targetBranch) {
      if (!(await revParse(target.gitDir, `refs/heads/${p.targetBranch}`))) {
        throw new ApiError(400, { message: ["Target branch does not exist"] });
      }
      changes.target_branch = { previous: mr.targetBranch, current: p.targetBranch };
      mr.targetBranch = p.targetBranch;
    }
    if (p.allowCollaboration !== undefined && mr.sourceProjectId !== mr.projectId) {
      mr.allowCollaboration = p.allowCollaboration;
    }
    const before = [...mr.labels];
    if (p.labels) mr.labels = this.#world.ensureLabels(target, p.labels);
    for (const l of this.#world.ensureLabels(target, p.addLabels ?? [])) {
      if (!mr.labels.includes(l)) mr.labels.push(l);
    }
    if (p.removeLabels) {
      const drop = p.removeLabels.map((l) => l.toLowerCase());
      mr.labels = mr.labels.filter((l) => !drop.includes(l.toLowerCase()));
    }
    if (before.join() !== mr.labels.join()) {
      changes.labels = {
        previous: this.gl.hooks.labels(target, before),
        current: this.gl.hooks.labels(target, mr.labels),
      };
    }
    let action = "update";
    if (p.stateEvent === "close" && mr.state === "opened") {
      mr.state = "closed";
      mr.closedAt = this.#world.stamp();
      mr.closedById = actor.id;
      action = "close";
      this.gl.systemNote(mr, actor, "closed");
    } else if (p.stateEvent === "reopen" && mr.state === "closed") {
      mr.state = "opened";
      mr.closedAt = null;
      mr.closedById = null;
      action = "reopen";
      this.gl.systemNote(mr, actor, "reopened");
      mr.headSha = (await this.gl.syncHeadRef(mr)) ?? mr.headSha;
      await this.gl.recordVersion(mr);
    }
    if (action === "update" && Object.keys(changes).length === 0) return;
    mr.updatedAt = this.#world.stamp();
    await this.hook(actor, mr, action, {}, changes);
  }

  /** A push moved `branch` of `project`: every open merge request from it follows the new tip,
   * with GitLab's "added N commits" system note and an `update` hook carrying `oldrev`. */
  async sourceMoved(actor: User, project: Project, branch: string) {
    for (const mr of this.#world.mergeRequests) {
      if (
        mr.state !== "opened" || mr.sourceProjectId !== project.id || mr.sourceBranch !== branch
      ) {
        continue;
      }
      const tip = await this.gl.syncHeadRef(mr);
      if (!tip || tip === mr.headSha) continue;
      const oldrev = mr.headSha;
      mr.headSha = tip;
      mr.updatedAt = this.#world.stamp();
      await this.gl.recordVersion(mr);
      const target = this.#world.projects.get(mr.projectId)!;
      const added = await isAncestor(target.gitDir, oldrev, tip).then((ff) =>
        ff ? log(target.gitDir, `${oldrev}..${tip}`) : log(target.gitDir, tip, true)
      ).catch((): Commit[] => []);
      this.gl.systemNote(
        mr,
        actor,
        `added ${added.length} commit${added.length === 1 ? "" : "s"}\n\n${
          added.map((c) => `<ul><li>${c.id.slice(0, 8)} - ${c.message.split("\n")[0]}</li></ul>`)
            .join("")
        }`,
      );
      await this.hook(actor, mr, "update", { oldrev });
    }
  }

  /** A push moved `branch`, a target branch: an open merge request into it whose head it now
   * contains was merged by hand, and GitLab marks it merged. */
  async targetMoved(actor: User, project: Project, branch: string, tip: string) {
    for (const mr of this.#world.mergeRequests) {
      if (mr.state !== "opened" || mr.projectId !== project.id || mr.targetBranch !== branch) {
        continue;
      }
      if (!(await isAncestor(project.gitDir, mr.headSha, tip))) continue;
      mr.diffRefs = await this.gl.diffRefs(mr);
      mr.state = "merged";
      mr.mergedAt = this.#world.stamp();
      mr.mergedById = actor.id;
      mr.updatedAt = mr.mergedAt;
      await this.hook(actor, mr, "merge");
    }
  }

  /** `git push -o merge_request.create -o merge_request.target=… -o merge_request.title=…`: one
   * merge request per pushed branch that has none open yet. */
  async pushOptions(
    actor: User,
    project: Project,
    moved: Array<{ branch: string; old: string; new: string }>,
    options: string[],
  ) {
    const opt = new Map<string, string>();
    const labels: string[] = [];
    for (const o of options) {
      const eq = o.indexOf("=");
      const k = eq === -1 ? o : o.slice(0, eq);
      const v = eq === -1 ? "" : o.slice(eq + 1);
      if (k === "merge_request.label") labels.push(v);
      else opt.set(k, v);
    }
    if (!opt.has("merge_request.create")) return;
    const targetBranch = opt.get("merge_request.target") || project.defaultBranch;
    for (const m of moved) {
      if (m.new === ZERO_SHA || m.branch === targetBranch) continue;
      const open = this.#world.mergeRequests.some((x) =>
        x.state === "opened" && x.sourceProjectId === project.id && x.sourceBranch === m.branch
      );
      if (open) continue;
      const draft = opt.has("merge_request.draft");
      const title = opt.get("merge_request.title") || m.branch;
      await this.create(actor, project, {
        target: project,
        sourceBranch: m.branch,
        targetBranch,
        title: draft ? `Draft: ${title}` : title,
        description: opt.get("merge_request.description") ?? "",
        removeSourceBranch: opt.has("merge_request.remove_source_branch"),
        labels,
      });
    }
  }

  /**
   * Merges `mr` by `method`: `merge` (a merge commit), `squash` (a squash commit, then a merge
   * commit), or `ff` (fast-forward, rebasing first when needed). The target branch moves (a Push
   * Hook), the merge request is merged (a Merge Request Hook `merge` whose `last_commit` is the
   * merge request's head), and the source branch goes when it asked to be removed.
   */
  async merge(
    actor: User,
    mr: MergeRequest,
    p: { method?: MergeMethod; squash?: boolean; message?: string; removeSourceBranch?: boolean } =
      {},
  ) {
    if (mr.state !== "opened") throw new ApiError(405, { message: "405 Method Not Allowed" });
    const target = this.#world.projects.get(mr.projectId)!;
    await this.gl.exclusive(target.id, async () => {
      const tipRef = `refs/heads/${mr.targetBranch}`;
      const tip = await revParse(target.gitDir, tipRef);
      if (!tip) throw new ApiError(422, { message: "Branch cannot be merged" });
      const refs = await this.gl.diffRefs(mr);
      const method: MergeMethod = p.method ?? (p.squash ?? mr.squash ? "squash" : "merge");
      const source = this.#world.projects.get(mr.sourceProjectId);
      let landed;
      try {
        landed = await land(target.gitDir, {
          target: tip,
          head: mr.headSha,
          method,
          message: p.message ??
            `Merge branch '${mr.sourceBranch}' into '${mr.targetBranch}'\n\n${mr.title}\n\nSee merge request ${target.path}!${mr.iid}\n`,
          squashMessage: `${mr.title}\n`,
          who: { name: actor.name, email: actor.email },
          date: this.#world.stamp(),
        });
      } catch (e) {
        throw new ApiError(422, {
          message: e instanceof Error ? e.message : "Branch cannot be merged",
        });
      }
      const before = await readRefs(target.gitDir);
      await updateRef(target.gitDir, tipRef, landed.tip, tip);
      mr.diffRefs = refs;
      mr.state = "merged";
      mr.mergedAt = this.#world.stamp();
      mr.mergedById = actor.id;
      mr.updatedAt = mr.mergedAt;
      mr.mergeCommitSha = landed.mergeCommit;
      mr.squashCommitSha = landed.squashCommit;
      await this.hook(actor, mr, "merge");
      if ((p.removeSourceBranch ?? mr.removeSourceBranch) && source) {
        const sourceBefore = source.id === target.id ? null : await readRefs(source.gitDir);
        await deleteRef(source.gitDir, `refs/heads/${mr.sourceBranch}`);
        if (sourceBefore) {
          await this.gl.afterPush(actor, source, sourceBefore, await readRefs(source.gitDir), []);
        }
      }
      await this.gl.afterPush(actor, target, before, await readRefs(target.gitDir), []);
    });
  }

  /** Approves as `actor`: a system note and the `approved` hook. The body, and the 401 for an
   * approval already given, verified on GitLab 17.11. */
  async approve(actor: User, mr: MergeRequest) {
    if (mr.approvedBy.includes(actor.id)) throw new ApiError(401, { message: "401 Unauthorized" });
    mr.approvedBy.push(actor.id);
    this.gl.systemNote(mr, actor, "approved this merge request");
    await this.hook(actor, mr, "approved");
  }

  /** Revokes `actor`'s approval: a system note and the `unapproved` hook; a 404 when there was
   * none. Verified on GitLab 17.11. */
  async unapprove(actor: User, mr: MergeRequest) {
    if (!mr.approvedBy.includes(actor.id)) throw new ApiError(404, { message: "404 Not Found" });
    mr.approvedBy = mr.approvedBy.filter((id) => id !== actor.id);
    this.gl.systemNote(mr, actor, "unapproved this merge request");
    await this.hook(actor, mr, "unapproved");
  }

  /** A reviewer requesting changes (the UI's review verdict; neither REST nor GraphQL has a
   * route for it). The system note's body verified on GitLab 17.11; it fires no hook. */
  requestChanges(actor: User, mr: MergeRequest) {
    this.gl.systemNote(mr, actor, "requested changes");
  }

  /** A diff note's anchor as given, normalised — not yet checked against the diff. */
  positionOf(raw: unknown): Position {
    if (!raw || typeof raw !== "object") throw badPosition();
    const r = raw as Record<string, unknown>;
    const num = (v: unknown) => v === undefined || v === null || v === "" ? null : Number(v);
    const pos: Position = {
      base_sha: String(r.base_sha ?? ""),
      start_sha: String(r.start_sha ?? ""),
      head_sha: String(r.head_sha ?? ""),
      position_type: "text",
      old_path: String(r.old_path ?? r.new_path ?? ""),
      new_path: String(r.new_path ?? r.old_path ?? ""),
      old_line: num(r.old_line),
      new_line: num(r.new_line),
    };
    if (r.position_type !== undefined && r.position_type !== "text") throw badPosition();
    return pos;
  }

  /** `positionOf`, its SHAs held by the target project: one it does not have is GitLab's 500. */
  async knownPosition(mr: MergeRequest, raw: unknown): Promise<Position> {
    const pos = this.positionOf(raw);
    const target = this.#world.projects.get(mr.projectId)!;
    for (const sha of [pos.base_sha, pos.start_sha, pos.head_sha]) {
      if (!/^[0-9a-f]{40}$/.test(sha) || !(await revParse(target.gitDir, sha))) {
        throw new ApiError(500, { message: "500 Internal Server Error" });
      }
    }
    return pos;
  }

  /** Checks a diff note's anchor against the merge request: the SHAs must be its current
   * `diff_refs`, and the line must be in the diff — an added line takes `new_line` alone, a
   * removed one `old_line` alone, and an unchanged line both, consistent with the hunks. The
   * refusal is GitLab's body, verified on GitLab 17.11 (which answers a SHA it does not have
   * with a 500 instead). */
  async checkPosition(mr: MergeRequest, raw: unknown): Promise<Position> {
    const pos = await this.knownPosition(mr, raw);
    const bad = badPosition;
    const refs = await this.gl.diffRefs(mr);
    if (
      !refs || refs.base_sha !== pos.base_sha || refs.start_sha !== pos.start_sha ||
      refs.head_sha !== pos.head_sha
    ) throw bad();
    if (pos.old_line === null && pos.new_line === null) throw bad();
    const file = (await this.gl.mergeRequestDiff(mr, { collapse: false })).find((f) =>
      f.new_path === pos.new_path || f.old_path === pos.old_path
    );
    if (!file) throw bad();
    if (!lineInDiff(file.diff, pos.old_line, pos.new_line)) throw bad();
    return pos;
  }

  addDraft(actor: User, mr: MergeRequest, p: {
    note: string;
    position: Position | null;
    inReplyTo: Discussion | null;
    resolveDiscussion: boolean;
  }): DraftNote {
    const draft: DraftNote = {
      id: this.#world.nextId("draft"),
      authorId: actor.id,
      note: p.note,
      position: p.position,
      inReplyToDiscussionId: p.inReplyTo?.id ?? null,
      resolveDiscussion: p.resolveDiscussion,
    };
    mr.drafts.push(draft);
    return draft;
  }

  /** Publishes `actor`'s drafts (all, or the one named): each becomes a note — a diff discussion,
   * a reply, or an individual note typed "Note" — with its Note Hook. A draft whose position is
   * not a line of the diff is dropped without a word: GitLab checks positions only here, and
   * answers the publish 204 regardless (verified on GitLab 17.11). */
  async publishDrafts(actor: User, mr: MergeRequest, only?: number) {
    const mine = mr.drafts.filter((d) =>
      d.authorId === actor.id && (only === undefined || d.id === only)
    );
    mr.drafts = mr.drafts.filter((d) => !mine.includes(d));
    for (const d of mine) {
      const into = d.inReplyToDiscussionId
        ? mr.discussions.find((x) => x.id === d.inReplyToDiscussionId)
        : undefined;
      if (!into && d.position) {
        const ok = await this.checkPosition(mr, d.position).then(() => true, () => false);
        if (!ok) continue;
      }
      // A draft's quick actions run now, as the publisher; one made only of them is no note.
      const { body } = await carryOut(this.gl, actor, mr, d.note);
      if (body === "") continue;
      const { discussion } = into
        ? await this.gl.addNote(actor, mr, { body, mode: "reply", discussion: into })
        : d.position
        ? await this.gl.addNote(actor, mr, {
          body,
          mode: "discussion",
          position: d.position,
        })
        : await this.gl.addNote(actor, mr, { body, mode: "individual", typed: true });
      if (d.resolveDiscussion) this.gl.resolveDiscussion(actor, discussion, true);
    }
  }

  /** Whether `user` may write to `mr` as a project member: Developer and above on the target. */
  canDevelop(user: User, mr: MergeRequest): boolean {
    return this.#world.can(user, this.#world.projects.get(mr.projectId)!, ACCESS.developer);
  }
}

/** GitLab's 400 for a diff note anchored off the diff (verified on GitLab 17.11). */
function badPosition(): ApiError {
  return new ApiError(400, {
    message: `400 Bad request - Note {:line_code=>["can't be blank", "must be a valid line code"]}`,
  });
}

/** Whether (old_line, new_line) names a line of a file's diff, by GitLab's anchoring rules. */
export function lineInDiff(hunks: string, oldLine: number | null, newLine: number | null): boolean {
  const added = new Set<number>();
  const removed = new Set<number>();
  const context = new Set<string>();
  const ranges: Array<{ oldStart: number; oldEnd: number; after: number }> = [];
  let o = 0;
  let n = 0;
  let delta = 0;
  for (const line of hunks.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[3]);
      const oldLen = h[2] === undefined ? 1 : Number(h[2]);
      const newLen = h[4] === undefined ? 1 : Number(h[4]);
      delta += newLen - oldLen;
      // `-3,0` inserts AFTER old line 3: an empty range starting at 4.
      const oldStart = oldLen === 0 ? o + 1 : o;
      ranges.push({ oldStart, oldEnd: oldStart + oldLen - 1, after: delta });
      continue;
    }
    if (line.startsWith("+")) added.add(n++);
    else if (line.startsWith("-")) removed.add(o++);
    else if (line.startsWith(" ")) context.add(`${o++}:${n++}`);
  }
  if (oldLine === null) return newLine !== null && added.has(newLine);
  if (newLine === null) return removed.has(oldLine);
  if (context.has(`${oldLine}:${newLine}`)) return true;
  // An unchanged line outside every hunk: its new number is its old one shifted by the hunks
  // before it.
  if (ranges.some((r) => oldLine >= r.oldStart && oldLine <= r.oldEnd)) return false;
  const shift = ranges.filter((r) => r.oldEnd < oldLine).at(-1)?.after ?? 0;
  return newLine - oldLine === shift;
}
