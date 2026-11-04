// The fake's state: everything a GitLab instance remembers, in memory, and the rules that read it
// (who sees a project, what level a user holds on it). The git objects themselves live in real
// bare repositories on disk (git/repo.ts); everything else lives here.
//
// Ids follow GitLab's shape: one global id per kind of record, and per project an `iid` space for
// issues and another for merge requests, which is the ambiguity ryph's `issue-<iid>`/`mr-<iid>`
// refs exist to resolve.

import { randomBytes } from "node:crypto";
import type { Suggestion } from "./suggestions.ts";

/** GitLab's member access levels. */
export const ACCESS = {
  none: 0,
  minimal: 5,
  guest: 10,
  reporter: 20,
  developer: 30,
  maintainer: 40,
  owner: 50,
} as const;

export type Visibility = "public" | "internal" | "private";

/** A project feature's own access level (`<feature>_access_level`): `private` is "only project
 * members" even in a public project. */
export type FeatureAccess = "disabled" | "private" | "enabled";

/** The features whose access levels the fake keeps. */
export const FEATURES = [
  "repository",
  "merge_requests",
  "issues",
  "builds",
  "wiki",
  "snippets",
] as const;
export type Feature = (typeof FEATURES)[number];

/** `visibility_level` as webhook payloads spell it. */
export const VISIBILITY_LEVEL: Record<Visibility, number> = {
  private: 0,
  internal: 10,
  public: 20,
};

export interface User {
  id: number;
  username: string;
  name: string;
  email: string;
  bot: boolean;
  admin: boolean;
  /** `blocked`: an administrator blocked the account — it signs in nowhere, and its tokens
   * answer 401 — while its memberships stay listed. */
  state: "active" | "blocked";
  createdAt: string;
}

export interface Token {
  id: number;
  token: string;
  userId: number;
  kind: "personal" | "oauth";
  name: string;
  scopes: string[];
  /** `YYYY-MM-DD`, as GitLab stores a personal access token's expiry; null never expires. */
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Group {
  id: number;
  /** The full path: `top/sub`. */
  path: string;
  name: string;
  parentId: number | null;
  visibility: Visibility;
  members: Map<number, number>;
  /** Members whose membership is `awaiting` (a seat or user cap holds it): listed with their
   * level, holding none of it. */
  awaiting: Set<number>;
  labels: Label[];
  createdAt: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  /** Set on a group label, null on a project's own. */
  groupId: number | null;
}

export interface ProjectHook {
  id: number;
  uuid: string;
  url: string;
  token: string | null;
  pushEvents: boolean;
  /** GitLab's branch filter: an exact name or a wildcard pattern; null takes every branch. */
  pushEventsBranchFilter: string | null;
  noteEvents: boolean;
  mergeRequestsEvents: boolean;
  issuesEvents: boolean;
  /** Internal notes, and notes on a confidential issue: GitLab's "Confidential Note Hook". */
  confidentialNoteEvents: boolean;
  /** Confidential issues' events: GitLab's "Confidential Issue Hook". */
  confidentialIssuesEvents: boolean;
  createdAt: string;
}

export interface Project {
  id: number;
  /** `path_with_namespace`, as created; lookups fold case, as GitLab's do. */
  path: string;
  name: string;
  namespace: { kind: "group"; groupId: number } | { kind: "user"; userId: number };
  visibility: Visibility;
  /** Each feature's own access level; `enabled` for all unless set. */
  features: Record<Feature, FeatureAccess>;
  defaultBranch: string;
  /** Branches only a Maintainer may push, and nobody may force-push or delete. */
  protectedBranches: Set<string>;
  members: Map<number, number>;
  /** As `Group.awaiting`. */
  awaiting: Set<number>;
  forkedFromId: number | null;
  labels: Label[];
  hooks: ProjectHook[];
  nextIssueIid: number;
  nextMrIid: number;
  createdAt: string;
  lastActivityAt: string;
  /** The bare repository: `<root>/<id>.git`. */
  gitDir: string;
}

export interface Award {
  id: number;
  name: string;
  userId: number;
  createdAt: string;
}

/** A diff note's anchor, as the API takes and returns it. */
export interface Position {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: "text";
  old_path: string;
  new_path: string;
  old_line: number | null;
  new_line: number | null;
}

export interface Note {
  id: number;
  /** "Note": an individual note published from a draft (verified on GitLab 17.11). */
  type: null | "Note" | "DiscussionNote" | "DiffNote";
  body: string;
  authorId: number;
  system: boolean;
  /** An internal note: for the project's Reporters and up, and its author. */
  internal: boolean;
  createdAt: string;
  updatedAt: string;
  position: Position | null;
  resolvable: boolean;
  resolvedById: number | null;
  resolvedAt: string | null;
  awards: Award[];
  /** A diff note's suggestions (`suggestions.ts`). */
  suggestions?: Suggestion[];
}

export interface Discussion {
  /** 40 hex, as GitLab's. */
  id: string;
  individual: boolean;
  notes: Note[];
}

export interface Issue {
  kind: "issue";
  id: number;
  iid: number;
  projectId: number;
  title: string;
  description: string;
  /** For the project's Reporters and up, and its author. */
  confidential: boolean;
  state: "opened" | "closed";
  authorId: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedById: number | null;
  awards: Award[];
  discussions: Discussion[];
}

export interface DraftNote {
  id: number;
  authorId: number;
  note: string;
  position: Position | null;
  inReplyToDiscussionId: string | null;
  resolveDiscussion: boolean;
}

export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/** One recorded diff of a merge request: a version, made each time its head moves. */
export interface MergeRequestVersion {
  id: number;
  headSha: string;
  baseSha: string;
  startSha: string;
  createdAt: string;
}

export interface MergeRequest {
  kind: "merge_request";
  id: number;
  iid: number;
  /** The TARGET project: where the merge request lives. */
  projectId: number;
  sourceProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  state: "opened" | "closed" | "locked" | "merged";
  authorId: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergedById: number | null;
  closedAt: string | null;
  closedById: number | null;
  allowCollaboration: boolean;
  removeSourceBranch: boolean;
  squash: boolean;
  /** The source branch's head, as the target project's `refs/merge-requests/<iid>/head`. */
  headSha: string;
  /** Frozen at the merge; live (computed on read) while open. */
  diffRefs: DiffRefs | null;
  mergeCommitSha: string | null;
  squashCommitSha: string | null;
  approvedBy: number[];
  /** Oldest first. */
  versions: MergeRequestVersion[];
  drafts: DraftNote[];
  awards: Award[];
  discussions: Discussion[];
}

export type Noteable = Issue | MergeRequest;

export type CommitStatusState =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "skipped";

export interface CommitStatus {
  id: number;
  projectId: number;
  sha: string;
  ref: string;
  name: string;
  status: CommitStatusState;
  targetUrl: string | null;
  description: string | null;
  allowFailure: boolean;
  authorId: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Upload {
  id: number;
  projectId: number;
  secret: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  /** Exact match, as GitLab's; empty takes any. */
  redirectUris: string[];
  scopes: string[];
}

export interface OAuthGrant {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: number;
  scopes: string[];
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAtMs: number;
}

/** 40 hex: a discussion id. */
export const hex40 = (): string => randomBytes(20).toString("hex");
/** 32 hex: an upload secret. */
export const hex32 = (): string => randomBytes(16).toString("hex");

const fold = (s: string) => s.toLowerCase();

/** The level a member record grants: none while it is awaiting. */
const held = (on: { members: Map<number, number>; awaiting: Set<number> }, userId: number) =>
  on.awaiting.has(userId) ? ACCESS.none : on.members.get(userId) ?? ACCESS.none;

/** The whole instance's records, and the rules that read them. */
export class World {
  readonly users = new Map<number, User>();
  readonly tokens = new Map<string, Token>();
  readonly groups = new Map<number, Group>();
  readonly projects = new Map<number, Project>();
  /** Where renamed projects' old paths point (folded), as GitLab's redirect routes: until a
   * project is created at one, which takes the path over. */
  readonly redirects = new Map<string, number>();
  readonly issues: Issue[] = [];
  readonly mergeRequests: MergeRequest[] = [];
  readonly statuses: CommitStatus[] = [];
  readonly uploads: Upload[] = [];
  readonly oauthApps: OAuthApp[] = [];
  readonly oauthGrants = new Map<string, OAuthGrant>();
  /** Whom `GET /oauth/authorize` signs in, without asking: the fake's browser session. */
  oauthUserId: number | null = null;

  #seq = new Map<string, number>();

  constructor(readonly now: () => Date) {}

  /** The next id of a kind of record: global per kind, as GitLab's primary keys are. */
  nextId(kind: string): number {
    const start: Record<string, number> = {
      user: 1,
      group: 100,
      project: 1000,
      issue: 5000,
      mr: 8000,
      note: 90000,
    };
    const n = (this.#seq.get(kind) ?? start[kind] ?? 1) + 1;
    this.#seq.set(kind, n);
    return n;
  }

  stamp(): string {
    return this.now().toISOString();
  }

  userByUsername(username: string): User | null {
    for (const u of this.users.values()) if (fold(u.username) === fold(username)) return u;
    return null;
  }

  groupByPath(path: string): Group | null {
    for (const g of this.groups.values()) if (fold(g.path) === fold(path)) return g;
    return null;
  }

  /** A project by numeric id or `path_with_namespace` (any case), as `:id` in the API takes it. */
  project(ref: string | number): Project | null {
    if (typeof ref === "number" || /^\d+$/.test(ref)) return this.projects.get(Number(ref)) ?? null;
    for (const p of this.projects.values()) if (fold(p.path) === fold(ref)) return p;
    const moved = this.redirects.get(fold(ref));
    return moved === undefined ? null : this.projects.get(moved) ?? null;
  }

  /** A namespace path's owner: a group, or a user's personal namespace. */
  namespace(path: string): { kind: "group"; group: Group } | { kind: "user"; user: User } | null {
    const group = this.groupByPath(path);
    if (group) return { kind: "group", group };
    const user = this.userByUsername(path);
    return user ? { kind: "user", user } : null;
  }

  /** A group and every group above it, nearest first. */
  groupChain(groupId: number | null): Group[] {
    const out: Group[] = [];
    let id = groupId;
    while (id !== null) {
      const g = this.groups.get(id);
      if (!g) break;
      out.push(g);
      id = g.parentId;
    }
    return out;
  }

  projectGroups(project: Project): Group[] {
    return project.namespace.kind === "group" ? this.groupChain(project.namespace.groupId) : [];
  }

  /** The level `user` holds on a project: the highest of its own membership and every ancestor
   * group's, and Owner of a personal project. What `members/all/:user_id` answers. */
  accessLevel(user: User | null, project: Project): number {
    if (!user) return ACCESS.none;
    if (project.namespace.kind === "user" && project.namespace.userId === user.id) {
      return ACCESS.owner;
    }
    let level = held(project, user.id);
    for (const g of this.projectGroups(project)) level = Math.max(level, held(g, user.id));
    return level;
  }

  groupAccessLevel(user: User | null, group: Group): number {
    if (!user) return ACCESS.none;
    let level = 0;
    for (const g of this.groupChain(group.id)) level = Math.max(level, held(g, user.id));
    return level;
  }

  /** What `members/all/:user_id` answers for a project or a group: the highest level `user`
   * holds, `active`; else the highest it is awaiting, as `awaiting`; null for neither. */
  memberRecord(
    user: User,
    on: { kind: "project"; project: Project } | { kind: "group"; group: Group },
  ): { level: number; state: "active" | "awaiting" } | null {
    const active = on.kind === "project"
      ? this.accessLevel(user, on.project)
      : this.groupAccessLevel(user, on.group);
    if (active >= ACCESS.minimal) return { level: active, state: "active" };
    const chain = on.kind === "project"
      ? [on.project, ...this.projectGroups(on.project)]
      : this.groupChain(on.group.id);
    const awaiting = Math.max(
      0,
      ...chain.map((m) => m.awaiting.has(user.id) ? m.members.get(user.id) ?? 0 : 0),
    );
    return awaiting >= ACCESS.minimal ? { level: awaiting, state: "awaiting" } : null;
  }

  /** Whether `user` (null: anonymous) may see the project at all; a project it may not see
   * answers 404, never 403, as GitLab's do. */
  canSee(user: User | null, project: Project): boolean {
    if (project.visibility === "public") return true;
    if (!user) return false;
    if (user.admin || project.visibility === "internal") return true;
    return this.accessLevel(user, project) >= ACCESS.guest;
  }

  canSeeGroup(user: User | null, group: Group): boolean {
    if (group.visibility === "public") return true;
    if (!user) return false;
    if (user.admin || group.visibility === "internal") return true;
    if (this.groupAccessLevel(user, group) >= ACCESS.guest) return true;
    // A member of a project or subgroup below sees the group too.
    for (const p of this.projects.values()) {
      if (this.projectGroups(p).some((g) => g.id === group.id) && this.accessLevel(user, p) > 0) {
        return true;
      }
    }
    return false;
  }

  /** Whether `user` holds `level` on the project, an admin always does. */
  can(user: User | null, project: Project, level: number): boolean {
    if (!user) return false;
    return user.admin || this.accessLevel(user, project) >= level;
  }

  /** Whether `user` may read the project's code and merge requests: a public project's are
   * anyone's unless its repository is members-only (`repository_access_level: private`);
   * otherwise Reporter and above (a Guest of a private project sees issues only). */
  canReadCode(user: User | null, project: Project): boolean {
    if (!this.canSee(user, project)) return false;
    if (project.features.repository === "disabled") return false;
    if (project.visibility !== "private" && project.features.repository === "enabled") return true;
    return this.can(user, project, ACCESS.reporter);
  }

  /** Whether `user` may push `branch` of `project` — by its own role, or through an open fork
   * merge request that allows collaboration and targets a branch `user` may merge into. */
  canPushBranch(user: User, project: Project, branch: string): boolean {
    if (project.protectedBranches.has(branch)) return this.can(user, project, ACCESS.maintainer);
    if (this.can(user, project, ACCESS.developer)) return true;
    return this.collaborationGrants(user, project).has(branch);
  }

  /** Whether a merge request's `allow_collaboration` can hold at all — GitLab's
   * `collaborative_push_possible?`: a fork's merge request, neither project private, its source
   * branch unprotected. Verified on GitLab 17.11: on a private fork the setting is answered 200
   * and stays false. */
  collaborationPossible(mr: MergeRequest): boolean {
    const target = this.projects.get(mr.projectId);
    const source = this.projects.get(mr.sourceProjectId);
    return !!target && !!source && source.id !== target.id && target.visibility !== "private" &&
      source.visibility !== "private" && !source.protectedBranches.has(mr.sourceBranch);
  }

  /** The branches of a fork that `user` may push through `allow_collaboration`: the source
   * branches of open merge requests out of `fork` whose target branch `user` may merge into. */
  collaborationGrants(user: User, fork: Project): Set<string> {
    const out = new Set<string>();
    for (const mr of this.mergeRequests) {
      if (mr.state !== "opened" || !mr.allowCollaboration) continue;
      if (!this.collaborationPossible(mr)) continue;
      if (mr.sourceProjectId !== fork.id || mr.projectId === fork.id) continue;
      const target = this.projects.get(mr.projectId);
      if (target && this.canMergeInto(user, target, mr.targetBranch)) out.add(mr.sourceBranch);
    }
    return out;
  }

  /** Merging into a protected branch takes Maintainer; any other branch, Developer. */
  canMergeInto(user: User, project: Project, branch: string): boolean {
    const level = project.protectedBranches.has(branch) ? ACCESS.maintainer : ACCESS.developer;
    return this.can(user, project, level);
  }

  issue(project: Project, iid: number): Issue | null {
    return this.issues.find((i) => i.projectId === project.id && i.iid === iid) ?? null;
  }

  mergeRequest(project: Project, iid: number): MergeRequest | null {
    return this.mergeRequests.find((m) => m.projectId === project.id && m.iid === iid) ?? null;
  }

  /** Every label a project sees: its own, then its groups', nearest first, by name. */
  labelsOf(project: Project, withGroups: boolean): Label[] {
    const out = [...project.labels];
    if (withGroups) {
      for (const g of this.projectGroups(project)) {
        for (const l of g.labels) {
          if (!out.some((o) => fold(o.name) === fold(l.name))) out.push(l);
        }
      }
    }
    return out;
  }

  /** Makes sure each label exists, creating a project label for a new name, as GitLab does on
   * `add_labels`; answers the names as the existing labels spell them. */
  ensureLabels(project: Project, names: string[]): string[] {
    const known = this.labelsOf(project, true);
    return names.map((name) => {
      const hit = known.find((l) => fold(l.name) === fold(name));
      if (hit) return hit.name;
      const label: Label = {
        id: this.nextId("label"),
        name,
        color: "#6699cc",
        description: null,
        groupId: null,
      };
      project.labels.push(label);
      known.push(label);
      return name;
    });
  }

  /** The discussion holding a note, and the note. */
  findNote(noteable: Noteable, noteId: number): { discussion: Discussion; note: Note } | null {
    for (const discussion of noteable.discussions) {
      const note = discussion.notes.find((n) => n.id === noteId);
      if (note) return { discussion, note };
    }
    return null;
  }
}
