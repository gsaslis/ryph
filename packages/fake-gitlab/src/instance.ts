// The fake's domain: every operation that changes the instance, shared by the REST routes and the
// control API so both behave alike and both emit the same webhooks. The HTTP layer decides who
// may; this layer does it and says what happened.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ApiError } from "./errors.ts";
import {
  cloneBare,
  type Commit,
  commitFiles,
  diff as gitDiff,
  fetchRef,
  git,
  initBare,
  log,
  mergeBase,
  refs as gitRefs,
  revParse,
  updateRef,
  ZERO_SHA,
} from "./git/repo.ts";
import { Hooks } from "./hooks.ts";
import { MergeRequests } from "./merge_requests.ts";
import {
  ACCESS,
  type DiffRefs,
  type Discussion,
  FEATURES,
  type Group,
  hex40,
  type Issue,
  type MergeRequest,
  type MergeRequestVersion,
  type Note,
  type Noteable,
  type Position,
  type Project,
  type ProjectHook,
  type Token,
  type User,
  type Visibility,
  World,
} from "./model.ts";
import { Present } from "./present.ts";
import { suggestionsOf } from "./suggestions.ts";

type Json = Record<string, unknown>;

export interface InstanceOptions {
  /** The instance's base URL, path prefix included: what `web_url`s start with. */
  url: string;
  reposDir: string;
  hooksDir: string;
  version: string;
  revision: string;
  now: () => Date;
  fetch: typeof fetch;
  countCap: number;
}

export class Instance {
  readonly world: World;
  readonly present: Present;
  readonly hooks: Hooks;
  readonly mrs: MergeRequests;
  readonly url: string;
  readonly version: string;
  readonly revision: string;
  readonly countCap: number;
  readonly #reposDir: string;
  readonly #hooksDir: string;
  #locks = new Map<number, Promise<unknown>>();

  constructor(opts: InstanceOptions) {
    this.url = opts.url;
    this.version = opts.version;
    this.revision = opts.revision;
    this.countCap = opts.countCap;
    this.#reposDir = opts.reposDir;
    this.#hooksDir = opts.hooksDir;
    this.world = new World(opts.now);
    this.present = new Present(this.world, opts.url);
    this.hooks = new Hooks(this.world, this.present, opts.version, opts.fetch);
    this.mrs = new MergeRequests(this);
  }

  get reposDir(): string {
    return this.#reposDir;
  }

  /** Runs `fn` alone for this project: pushes and merges never interleave. */
  async exclusive<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#locks.set(projectId, next.catch(() => {}));
    return await next;
  }

  // --- accounts --------------------------------------------------------------------------

  addUser(
    p: { username: string; name?: string; email?: string; bot?: boolean; admin?: boolean },
  ): User {
    if (this.world.userByUsername(p.username) || this.world.groupByPath(p.username)) {
      throw new Error(`namespace ${p.username} is taken`);
    }
    const user: User = {
      id: this.world.nextId("user"),
      username: p.username,
      name: p.name ?? p.username,
      email: p.email ?? `${p.username}@example.com`,
      bot: p.bot ?? false,
      admin: p.admin ?? false,
      state: "active",
      createdAt: this.world.stamp(),
    };
    this.world.users.set(user.id, user);
    return user;
  }

  addToken(user: User, p: {
    kind?: "personal" | "oauth";
    scopes?: string[];
    expiresAt?: string | null;
    name?: string;
    token?: string;
  } = {}): Token {
    const kind = p.kind ?? "personal";
    const token: Token = {
      id: this.world.nextId("token"),
      token: p.token ?? `${kind === "personal" ? "glpat-" : ""}${randomUUID().replaceAll("-", "")}`,
      userId: user.id,
      kind,
      name: p.name ?? (kind === "personal" ? "ryph" : "oauth"),
      scopes: p.scopes ?? ["api", "read_repository", "write_repository"],
      expiresAt: p.expiresAt === undefined ? null : p.expiresAt,
      revoked: false,
      createdAt: this.world.stamp(),
      lastUsedAt: null,
    };
    this.world.tokens.set(token.token, token);
    return token;
  }

  /** The token's user, or null for an unknown, revoked or expired one, or a blocked user's. */
  authenticate(raw: string): { user: User; token: Token } | null {
    const token = this.world.tokens.get(raw);
    if (!token || token.revoked || this.present.expired(token)) return null;
    const user = this.world.users.get(token.userId);
    if (!user || user.state !== "active") return null;
    token.lastUsedAt = this.world.stamp();
    return { user, token };
  }

  /** A group at `path`, nested under its parent path's group, which must exist. */
  addGroup(path: string, p: { visibility?: Visibility; name?: string } = {}): Group {
    if (this.world.groupByPath(path) || this.world.userByUsername(path)) {
      throw new Error(`namespace ${path} is taken`);
    }
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    const parent = parentPath === null ? null : this.world.groupByPath(parentPath);
    if (parentPath !== null && !parent) throw new Error(`no group ${parentPath}`);
    const group: Group = {
      id: this.world.nextId("group"),
      path,
      name: p.name ?? path.split("/").at(-1)!,
      parentId: parent?.id ?? null,
      visibility: p.visibility ?? "private",
      members: new Map(),
      awaiting: new Set(),
      labels: [],
      createdAt: this.world.stamp(),
    };
    this.world.groups.set(group.id, group);
    return group;
  }

  /**
   * A project at `path` (`namespace/…/name`) with a bare repository, seeded with `files` on its
   * default branch when given (an empty repository otherwise). The default branch is protected:
   * a Developer may not push it.
   */
  async addProject(path: string, p: {
    visibility?: Visibility;
    defaultBranch?: string;
    files?: Record<string, string>;
    author?: User;
    protectDefaultBranch?: boolean;
  } = {}): Promise<Project> {
    const cut = path.lastIndexOf("/");
    if (cut < 1) throw new Error(`project path ${path} needs a namespace`);
    const ns = this.world.namespace(path.slice(0, cut));
    if (!ns) throw new Error(`no namespace ${path.slice(0, cut)}`);
    // A project made at a renamed one's old path takes it over, as GitLab drops the redirect.
    this.world.redirects.delete(path.toLowerCase());
    if (this.world.project(path)) throw new Error(`project ${path} exists`);
    const id = this.world.nextId("project");
    const defaultBranch = p.defaultBranch ?? "main";
    const project: Project = {
      id,
      path,
      name: path.slice(cut + 1),
      namespace: ns.kind === "group"
        ? { kind: "group", groupId: ns.group.id }
        : { kind: "user", userId: ns.user.id },
      visibility: p.visibility ?? "private",
      features: Object.fromEntries(FEATURES.map((f) => [f, "enabled"])) as Project["features"],
      defaultBranch,
      protectedBranches: new Set(p.protectDefaultBranch === false ? [] : [defaultBranch]),
      members: new Map(),
      awaiting: new Set(),
      forkedFromId: null,
      labels: [],
      hooks: [],
      nextIssueIid: 1,
      nextMrIid: 1,
      createdAt: this.world.stamp(),
      lastActivityAt: this.world.stamp(),
      gitDir: join(this.#reposDir, `${id}.git`),
    };
    await initBare(project.gitDir, defaultBranch, this.#hooksDir);
    this.world.projects.set(id, project);
    if (p.files) {
      const author = p.author ?? (ns.kind === "user" ? ns.user : null);
      await commitFiles(project.gitDir, {
        branch: defaultBranch,
        files: p.files,
        message: "Initial commit\n",
        author: author ? { name: author.name, email: author.email } : {
          name: "Administrator",
          email: "admin@example.com",
        },
        date: this.world.stamp(),
      });
    }
    return project;
  }

  /** Forks `source` into the namespace at `namespacePath`, its repository copied whole. */
  async fork(source: Project, namespacePath: string, name?: string): Promise<Project> {
    const ns = this.world.namespace(namespacePath);
    if (!ns) throw new Error(`no namespace ${namespacePath}`);
    const path = `${namespacePath}/${name ?? source.name}`;
    this.world.redirects.delete(path.toLowerCase());
    if (this.world.project(path)) throw new Error(`project ${path} exists`);
    const id = this.world.nextId("project");
    const fork: Project = {
      ...source,
      id,
      path,
      name: name ?? source.name,
      namespace: ns.kind === "group"
        ? { kind: "group", groupId: ns.group.id }
        : { kind: "user", userId: ns.user.id },
      features: { ...source.features },
      protectedBranches: new Set([source.defaultBranch]),
      members: new Map(),
      awaiting: new Set(),
      forkedFromId: source.id,
      labels: [],
      hooks: [],
      nextIssueIid: 1,
      nextMrIid: 1,
      createdAt: this.world.stamp(),
      lastActivityAt: this.world.stamp(),
      gitDir: join(this.#reposDir, `${id}.git`),
    };
    await cloneBare(source.gitDir, fork.gitDir, this.#hooksDir);
    this.world.projects.set(id, fork);
    return fork;
  }

  /** Removes a project. A deleted fork's merge requests into other projects are closed and
   * lose their source project (`source_project_id` reads null), as GitLab does: its foreign key
   * nulls the column, and deleting a fork closes what it opened upstream. */
  deleteProject(project: Project) {
    this.world.projects.delete(project.id);
    for (const mr of this.world.mergeRequests) {
      if (mr.sourceProjectId !== project.id || mr.projectId === project.id) continue;
      if (mr.state === "opened" || mr.state === "locked") {
        mr.state = "closed";
        mr.closedAt = this.world.stamp();
        mr.updatedAt = mr.closedAt;
      }
    }
  }

  addHook(project: Project, p: {
    url: string;
    token?: string | null;
    pushEvents?: boolean;
    pushEventsBranchFilter?: string | null;
    noteEvents?: boolean;
    mergeRequestsEvents?: boolean;
    issuesEvents?: boolean;
    confidentialNoteEvents?: boolean;
    confidentialIssuesEvents?: boolean;
  }): ProjectHook {
    const hook: ProjectHook = {
      id: this.world.nextId("hook"),
      uuid: randomUUID(),
      url: p.url,
      token: p.token ?? null,
      pushEvents: p.pushEvents ?? true,
      pushEventsBranchFilter: p.pushEventsBranchFilter ?? null,
      noteEvents: p.noteEvents ?? false,
      mergeRequestsEvents: p.mergeRequestsEvents ?? false,
      issuesEvents: p.issuesEvents ?? false,
      confidentialNoteEvents: p.confidentialNoteEvents ?? false,
      confidentialIssuesEvents: p.confidentialIssuesEvents ?? false,
      createdAt: this.world.stamp(),
    };
    project.hooks.push(hook);
    return hook;
  }

  // --- repository reads ------------------------------------------------------------------

  async isEmpty(project: Project): Promise<boolean> {
    return (await gitRefs(project.gitDir)).size === 0;
  }

  async headCommit(project: Project, sha: string): Promise<Commit | null> {
    try {
      return (await log(project.gitDir, sha, true))[0] ?? null;
    } catch {
      return null;
    }
  }

  /** The merge request's `diff_refs`: frozen once merged, else the target branch's tip
   * (`start_sha`), its merge base with the head (`base_sha`) and the head. */
  async diffRefs(mr: MergeRequest): Promise<DiffRefs | null> {
    if (mr.diffRefs) return mr.diffRefs;
    const target = this.world.projects.get(mr.projectId)!;
    const start = await revParse(target.gitDir, `refs/heads/${mr.targetBranch}`);
    if (!start) return null;
    const base = await mergeBase(target.gitDir, start, mr.headSha);
    return base ? { base_sha: base, start_sha: start, head_sha: mr.headSha } : null;
  }

  // --- issues and notes ------------------------------------------------------------------

  createIssue(
    actor: User,
    project: Project,
    p: { title: string; description?: string; labels?: string[]; confidential?: boolean },
  ): Issue {
    const now = this.world.stamp();
    const issue: Issue = {
      kind: "issue",
      id: this.world.nextId("issue"),
      iid: project.nextIssueIid++,
      projectId: project.id,
      title: p.title,
      description: p.description ?? "",
      confidential: p.confidential ?? false,
      state: "opened",
      authorId: actor.id,
      labels: this.world.ensureLabels(project, p.labels ?? []),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      closedById: null,
      awards: [],
      discussions: [],
    };
    this.world.issues.push(issue);
    this.#issueHook(actor, issue, "open", {});
    return issue;
  }

  /** Applies an issue edit; `state_event` closes or reopens it. */
  updateIssue(actor: User, issue: Issue, p: {
    title?: string;
    description?: string;
    stateEvent?: "close" | "reopen";
    labels?: string[];
    addLabels?: string[];
    removeLabels?: string[];
  }) {
    const project = this.world.projects.get(issue.projectId)!;
    const changes: Json = {};
    const before = [...issue.labels];
    this.#applyLabels(project, issue, p);
    if (before.join() !== issue.labels.join()) {
      changes.labels = {
        previous: this.hooks.labels(project, before),
        current: this.hooks.labels(project, issue.labels),
      };
    }
    if (p.title !== undefined && p.title !== issue.title) {
      changes.title = { previous: issue.title, current: p.title };
      issue.title = p.title;
    }
    if (p.description !== undefined && p.description !== issue.description) {
      changes.description = { previous: issue.description, current: p.description };
      issue.description = p.description;
    }
    let action = "update";
    if (p.stateEvent === "close" && issue.state === "opened") {
      issue.state = "closed";
      issue.closedAt = this.world.stamp();
      issue.closedById = actor.id;
      action = "close";
      this.systemNote(issue, actor, "closed");
    } else if (p.stateEvent === "reopen" && issue.state === "closed") {
      issue.state = "opened";
      issue.closedAt = null;
      issue.closedById = null;
      action = "reopen";
      this.systemNote(issue, actor, "reopened");
    }
    if (action === "update" && Object.keys(changes).length === 0) return;
    issue.updatedAt = this.world.stamp();
    this.#issueHook(actor, issue, action, changes);
  }

  #applyLabels(
    project: Project,
    on: Noteable,
    p: { labels?: string[]; addLabels?: string[]; removeLabels?: string[] },
  ) {
    if (p.labels) on.labels = this.world.ensureLabels(project, p.labels);
    if (p.addLabels) {
      for (const l of this.world.ensureLabels(project, p.addLabels)) {
        if (!on.labels.includes(l)) on.labels.push(l);
      }
    }
    if (p.removeLabels) {
      const drop = p.removeLabels.map((l) => l.toLowerCase());
      on.labels = on.labels.filter((l) => !drop.includes(l.toLowerCase()));
    }
  }

  #issueHook(actor: User, issue: Issue, action: string, changes: Json) {
    const project = this.world.projects.get(issue.projectId)!;
    const kind = issue.confidential ? "confidential_issue" : "issue";
    this.hooks.emit(project, kind, {
      object_kind: "issue",
      event_type: kind,
      user: this.hooks.user(actor),
      project: this.hooks.project(project),
      repository: this.hooks.repository(project),
      object_attributes: this.hooks.issueAttributes(issue, action),
      labels: this.hooks.labels(project, issue.labels),
      changes,
    });
  }

  /** A system note: never resolvable, never a Note Hook (verified on GitLab 17.11: approvals and
   * requested changes write one and fire no Note Hook). */
  systemNote(on: Noteable, actor: User, body: string): Note {
    const now = this.world.stamp();
    const note: Note = {
      id: this.world.nextId("note"),
      type: null,
      body,
      authorId: actor.id,
      system: true,
      internal: false,
      createdAt: now,
      updatedAt: now,
      position: null,
      resolvable: false,
      resolvedById: null,
      resolvedAt: null,
      awards: [],
    };
    on.discussions.push({ id: hex40(), individual: true, notes: [note] });
    return note;
  }

  /**
   * Posts a user note: on its own (`/notes`, an individual note), as a new discussion
   * (`/discussions`, optionally anchored on the diff), or as a reply in `discussion`. Emits the
   * Note Hook.
   */
  async addNote(actor: User, on: Noteable, p: {
    body: string;
    mode: "individual" | "discussion" | "reply";
    discussion?: Discussion;
    position?: Position | null;
    /** An individual note typed "Note", as a published draft is. */
    typed?: boolean;
    internal?: boolean;
  }): Promise<{ note: Note; discussion: Discussion }> {
    const now = this.world.stamp();
    const diff = p.position != null ||
      (p.mode === "reply" && p.discussion!.notes[0]?.type === "DiffNote");
    const note: Note = {
      id: this.world.nextId("note"),
      type: p.mode === "individual"
        ? (p.typed ? "Note" : null)
        : diff
        ? "DiffNote"
        : "DiscussionNote",
      body: p.body,
      authorId: actor.id,
      system: false,
      // A reply is internal when its discussion is.
      internal: p.internal ??
        (p.mode === "reply" ? p.discussion!.notes[0]?.internal ?? false : false),
      createdAt: now,
      updatedAt: now,
      position: p.position ??
        (p.mode === "reply" ? p.discussion!.notes[0]?.position ?? null : null),
      resolvable: p.mode !== "individual",
      resolvedById: null,
      resolvedAt: null,
      awards: [],
    };
    let discussion: Discussion;
    if (p.mode === "reply") {
      discussion = p.discussion!;
      discussion.notes.push(note);
      // A reply to a resolved thread reopens it, as GitLab's does.
      for (const n of discussion.notes) {
        n.resolvedById = null;
        n.resolvedAt = null;
      }
    } else {
      discussion = { id: hex40(), individual: p.mode === "individual", notes: [note] };
      on.discussions.push(discussion);
    }
    if (on.kind === "merge_request") note.suggestions = await suggestionsOf(this, on, note);
    on.updatedAt = now;
    await this.noteHook(actor, on, note, discussion.id);
    return { note, discussion };
  }

  async noteHook(actor: User, on: Noteable, note: Note, discussionId: string) {
    const project = this.world.projects.get(on.projectId)!;
    const last = on.kind === "merge_request" ? await this.headCommit(project, on.headSha) : null;
    // An internal note, or any note on a confidential issue, goes to the hooks that asked for
    // confidential notes alone, as GitLab's "Confidential Note Hook".
    const confidential = note.internal || (on.kind === "issue" && on.confidential);
    const body = this.hooks.noteBody(actor, project, on, note, discussionId, last);
    if (confidential) body.event_type = "confidential_note";
    this.hooks.emit(project, confidential ? "confidential_note" : "note", body);
  }

  /** Resolves or unresolves every resolvable note of a discussion. */
  resolveDiscussion(actor: User, discussion: Discussion, resolved: boolean) {
    const now = this.world.stamp();
    for (const n of discussion.notes) {
      if (!n.resolvable) continue;
      n.resolvedById = resolved ? actor.id : null;
      n.resolvedAt = resolved ? now : null;
    }
  }

  // --- statuses ---------------------------------------------------------------------------

  /**
   * Posts a commit status with GitLab's state machine: a (sha, name, ref) that already holds a
   * status moves it along (pending → running → a final state), a final one starts a new job, and
   * a move the state machine has no event for is `Cannot transition status via :x from :y`.
   */
  postStatus(actor: User, project: Project, p: {
    sha: string;
    state: string;
    ref: string;
    name: string;
    targetUrl: string | null;
    description: string | null;
  }) {
    const events: Record<string, string> = {
      pending: "enqueue",
      running: "run",
      success: "succeed",
      failed: "drop",
      canceled: "cancel",
      skipped: "skip",
    };
    const event = events[p.state];
    if (!event) throw new ApiError(400, { error: "state does not have a valid value" });
    const now = this.world.stamp();
    const current = this.world.statuses.filter((s) =>
      s.projectId === project.id && s.sha === p.sha && s.name === p.name && s.ref === p.ref
    ).at(-1);
    const final = (s: string) => ["success", "failed", "canceled", "skipped"].includes(s);
    if (current && !final(current.status)) {
      const allowed: Record<string, string[]> = {
        pending: ["running", "success", "failed", "canceled", "skipped"],
        running: ["success", "failed", "canceled"],
      };
      if (!(allowed[current.status] ?? []).includes(p.state)) {
        throw new ApiError(400, {
          message: `Cannot transition status via :${event} from :${current.status} ` +
            `(Reason(s): Status cannot transition via "${event}")`,
        });
      }
      current.status = p.state as typeof current.status;
      if (p.targetUrl !== null) current.targetUrl = p.targetUrl;
      if (p.description !== null) current.description = p.description;
      if (p.state === "running") current.startedAt = now;
      if (final(p.state)) current.finishedAt = now;
      return current;
    }
    const status = {
      id: this.world.nextId("status"),
      projectId: project.id,
      sha: p.sha,
      ref: p.ref,
      name: p.name,
      status: p.state as "pending",
      targetUrl: p.targetUrl,
      description: p.description,
      allowFailure: false,
      authorId: actor.id,
      createdAt: now,
      startedAt: p.state === "running" ? now : null,
      finishedAt: final(p.state) ? now : null,
    };
    this.world.statuses.push(status);
    return status;
  }

  // --- pushes -----------------------------------------------------------------------------

  /** Commits `files` onto a branch as `actor`, as if pushed, with everything a push sets off. */
  async commit(actor: User, project: Project, p: {
    branch: string;
    files: Record<string, string | null>;
    message?: string;
    from?: string;
  }): Promise<string> {
    return await this.exclusive(project.id, async () => {
      const before = await gitRefs(project.gitDir);
      const { after } = await commitFiles(project.gitDir, {
        branch: p.branch,
        files: p.files,
        message: p.message ?? `Update ${Object.keys(p.files).join(", ")}\n`,
        author: { name: actor.name, email: actor.email },
        date: this.world.stamp(),
        from: p.from ?? `refs/heads/${project.defaultBranch}`,
      });
      await this.afterPush(actor, project, before, await gitRefs(project.gitDir), []);
      return after;
    });
  }

  /**
   * What a push sets off, given the branches before and after it: a Push Hook per branch, open
   * merge requests from a moved branch re-pointed (a Merge Request Hook `update` with `oldrev`),
   * merge requests into a moved branch that now contains their head marked merged, and
   * `merge_request.*` push options honoured.
   */
  async afterPush(
    actor: User,
    project: Project,
    before: Map<string, string>,
    after: Map<string, string>,
    pushOptions: string[],
  ) {
    const names = new Set([...before.keys(), ...after.keys()]);
    const moved: Array<{ branch: string; old: string; new: string }> = [];
    for (const ref of names) {
      if (!ref.startsWith("refs/heads/")) continue;
      const old = before.get(ref) ?? ZERO_SHA;
      const now = after.get(ref) ?? ZERO_SHA;
      if (old !== now) moved.push({ branch: ref.slice(11), old, new: now });
    }
    if (moved.length > 0) project.lastActivityAt = this.world.stamp();
    for (const m of moved) await this.#pushHook(actor, project, m, after);
    const mrs = this.mrs;
    for (const m of moved) {
      if (m.new === ZERO_SHA) continue;
      await mrs.sourceMoved(actor, project, m.branch);
      await mrs.targetMoved(actor, project, m.branch, m.new);
    }
    await mrs.pushOptions(actor, project, moved, pushOptions);
  }

  async #pushHook(
    actor: User,
    project: Project,
    m: { branch: string; old: string; new: string },
    after: Map<string, string>,
  ) {
    let commits: Commit[] = [];
    if (m.new !== ZERO_SHA) {
      if (m.old !== ZERO_SHA) commits = await log(project.gitDir, `${m.old}..${m.new}`);
      else {
        const others = [...after.entries()]
          .filter(([r]) => r.startsWith("refs/heads/") && r !== `refs/heads/${m.branch}`)
          .map(([, sha]) => `^${sha}`);
        const r = await git(project.gitDir, [
          "log",
          "--format=%H",
          m.new,
          ...others,
        ]);
        const ids = r.stdout.split("\n").filter(Boolean);
        for (const id of ids.slice(0, 20)) {
          const c = await this.headCommit(project, id);
          if (c) commits.push(c);
        }
      }
    }
    const total = commits.length;
    this.hooks.emit(project, "push", {
      object_kind: "push",
      event_name: "push",
      before: m.old,
      after: m.new,
      ref: `refs/heads/${m.branch}`,
      ref_protected: project.protectedBranches.has(m.branch),
      checkout_sha: m.new === ZERO_SHA ? null : m.new,
      message: null,
      user_id: actor.id,
      user_name: actor.name,
      user_username: actor.username,
      user_email: "",
      user_avatar: null,
      project_id: project.id,
      project: this.hooks.project(project),
      // GitLab sends the newest 20, oldest first.
      commits: commits.slice(0, 20).reverse().map((c) => ({
        ...this.hooks.commit(c, project),
        added: [],
        modified: [],
        removed: [],
      })),
      total_commits_count: total,
      push_options: {},
      repository: this.hooks.repository(project),
    }, m.branch);
  }

  /** Copies a merge request's source branch tip into the target project's
   * `refs/merge-requests/<iid>/head`; answers the tip, or null when the branch is gone. */
  async syncHeadRef(mr: MergeRequest): Promise<string | null> {
    const source = this.world.projects.get(mr.sourceProjectId);
    const target = this.world.projects.get(mr.projectId)!;
    if (!source) return null;
    const tip = await revParse(source.gitDir, `refs/heads/${mr.sourceBranch}`);
    if (!tip) return null;
    const as = `refs/merge-requests/${mr.iid}/head`;
    if (source.id === target.id) {
      await updateRef(target.gitDir, as, tip);
    } else {
      await fetchRef(target.gitDir, source.gitDir, `refs/heads/${mr.sourceBranch}`, as);
    }
    return tip;
  }

  /** Records a version of `mr` when its head is not the last one recorded: GitLab makes one per
   * push to the source branch. */
  async recordVersion(mr: MergeRequest): Promise<void> {
    if (mr.versions.at(-1)?.headSha === mr.headSha) return;
    const refs = await this.diffRefs(mr);
    if (!refs) return;
    mr.versions.push({
      id: this.world.nextId("mr_version"),
      headSha: refs.head_sha,
      baseSha: refs.base_sha,
      startSha: refs.start_sha,
      createdAt: this.world.stamp(),
    });
  }

  /** `mr`'s versions, newest first. The newest is the merge request's current diff, so its refs
   * are `diff_refs` as they stand. */
  async versionsOf(mr: MergeRequest): Promise<MergeRequestVersion[]> {
    const out = [...mr.versions].reverse();
    const refs = await this.diffRefs(mr);
    if (out[0] && refs && out[0].headSha === refs.head_sha) {
      out[0] = { ...out[0], baseSha: refs.base_sha, startSha: refs.start_sha };
    }
    return out;
  }

  /** The diff a merge request shows: base to head, per its `diff_refs`. `collapse: false` for
   * anchoring a note: collapsing is taken to be `/diffs`' display limit alone (unverified). */
  async mergeRequestDiff(mr: MergeRequest, opts: { collapse?: boolean } = {}) {
    const refs = await this.diffRefs(mr);
    if (!refs) return [];
    const target = this.world.projects.get(mr.projectId)!;
    return await gitDiff(target.gitDir, refs.base_sha, refs.head_sha, opts);
  }

  /** Whether `user` sees `on` (and so may comment on it): an issue, whoever sees its project; a
   * merge request, whoever may read the project's code. */
  canSeeNoteable(user: User | null, on: Noteable): boolean {
    const project = this.world.projects.get(on.projectId)!;
    if (
      on.kind === "issue" && on.confidential && !this.seesPrivate(user, on.projectId, on.authorId)
    ) {
      return false;
    }
    return on.kind === "issue"
      ? this.world.canSee(user, project)
      : this.world.canReadCode(user, project);
  }

  /** Whether `user` sees what a project keeps from its Guests — a confidential issue, an
   * internal note: Reporter and up, or the thing's author. */
  seesPrivate(user: User | null, projectId: number, authorId: number): boolean {
    if (user === null) return false;
    const project = this.world.projects.get(projectId)!;
    return user.id === authorId || this.world.can(user, project, ACCESS.reporter);
  }
}
