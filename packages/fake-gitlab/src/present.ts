// The fake's records as GitLab's REST API v4 spells them: field names, nesting and nulls as the
// API documentation shows them, so an adapter that parses these parses the real thing.

import {
  ACCESS,
  type Award,
  type CommitStatus,
  type DiffRefs,
  type Discussion,
  type DraftNote,
  FEATURES,
  type Group,
  type Issue,
  type Label,
  type MergeRequest,
  type MergeRequestVersion,
  type Note,
  type Noteable,
  type Project,
  type ProjectHook,
  type Token,
  type User,
  World,
} from "./model.ts";
import type { Commit } from "./git/repo.ts";
import { presentSuggestion } from "./suggestions.ts";

type Json = Record<string, unknown>;

export class Present {
  constructor(readonly world: World, readonly url: string) {}

  /** `UserBasic`: what lists, authors and members carry. */
  user(u: User): Json {
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      state: u.state,
      locked: false,
      avatar_url: null,
      web_url: `${this.url}/${u.username}`,
    };
  }

  userById(id: number | null): Json | null {
    if (id === null) return null;
    const u = this.world.users.get(id);
    return u ? this.user(u) : null;
  }

  /** `GET /user`: the token's own account, with its private fields. */
  currentUser(u: User): Json {
    return {
      ...this.user(u),
      created_at: u.createdAt,
      bio: "",
      public_email: null,
      email: u.email,
      commit_email: u.email,
      bot: u.bot,
      is_admin: u.admin,
      two_factor_enabled: false,
      external: false,
      private_profile: false,
    };
  }

  member(u: User, level: number, state: "active" | "awaiting" = "active"): Json {
    return { ...this.user(u), access_level: level, expires_at: null, membership_state: state };
  }

  token(t: Token): Json {
    return {
      id: t.id,
      name: t.name,
      revoked: t.revoked,
      created_at: t.createdAt,
      description: null,
      scopes: t.scopes,
      user_id: t.userId,
      last_used_at: t.lastUsedAt,
      active: !t.revoked && !this.expired(t),
      expires_at: t.expiresAt,
    };
  }

  expired(t: Token): boolean {
    return t.expiresAt !== null && t.expiresAt < this.world.stamp().slice(0, 10);
  }

  group(g: Group): Json {
    return {
      id: g.id,
      name: g.name,
      path: g.path.split("/").at(-1),
      full_path: g.path,
      full_name: g.path.split("/").join(" / "),
      parent_id: g.parentId,
      visibility: g.visibility,
      web_url: `${this.url}/groups/${g.path}`,
    };
  }

  namespace(p: Project): Json {
    if (p.namespace.kind === "group") {
      const g = this.world.groups.get(p.namespace.groupId)!;
      return {
        id: g.id,
        name: g.name,
        path: g.path.split("/").at(-1),
        kind: "group",
        full_path: g.path,
        parent_id: g.parentId,
        avatar_url: null,
        web_url: `${this.url}/groups/${g.path}`,
      };
    }
    const u = this.world.users.get(p.namespace.userId)!;
    return {
      id: u.id,
      name: u.name,
      path: u.username,
      kind: "user",
      full_path: u.username,
      parent_id: null,
      avatar_url: null,
      web_url: `${this.url}/${u.username}`,
    };
  }

  projectWebUrl(p: Project): string {
    return `${this.url}/${p.path}`;
  }

  httpUrl(p: Project): string {
    return `${this.url}/${p.path}.git`;
  }

  sshUrl(p: Project): string {
    return `git@${new URL(this.url).hostname}:${p.path}.git`;
  }

  /** `simple=true`'s shape. */
  projectSimple(p: Project): Json {
    const parts = p.path.split("/");
    return {
      id: p.id,
      description: null,
      name: p.name,
      name_with_namespace: parts.join(" / "),
      path: parts.at(-1),
      path_with_namespace: p.path,
      created_at: p.createdAt,
      default_branch: p.defaultBranch,
      tag_list: [],
      topics: [],
      ssh_url_to_repo: this.sshUrl(p),
      http_url_to_repo: this.httpUrl(p),
      web_url: this.projectWebUrl(p),
      readme_url: null,
      forks_count: [...this.world.projects.values()].filter((f) => f.forkedFromId === p.id).length,
      avatar_url: null,
      star_count: 0,
      last_activity_at: p.lastActivityAt,
      namespace: this.namespace(p),
    };
  }

  /** The full project, with the viewer's `permissions` when there is one. `empty` is the
   * repository's state, which only git knows. */
  project(p: Project, viewer: User | null, empty: boolean): Json {
    const out: Json = {
      ...this.projectSimple(p),
      visibility: p.visibility,
      empty_repo: empty,
      archived: false,
      merge_method: "merge",
      squash_option: "default_off",
      only_allow_merge_if_pipeline_succeeds: false,
      only_allow_merge_if_all_discussions_are_resolved: false,
      remove_source_branch_after_merge: true,
      issues_enabled: p.features.issues !== "disabled",
      merge_requests_enabled: p.features.merge_requests !== "disabled",
      ...Object.fromEntries(
        FEATURES.map((f) => [`${f}_access_level`, p.features[f]]),
      ),
      creator_id: p.namespace.kind === "user" ? p.namespace.userId : null,
      _links: {
        self: `${this.url}/api/v4/projects/${p.id}`,
        issues: `${this.url}/api/v4/projects/${p.id}/issues`,
        merge_requests: `${this.url}/api/v4/projects/${p.id}/merge_requests`,
        labels: `${this.url}/api/v4/projects/${p.id}/labels`,
        members: `${this.url}/api/v4/projects/${p.id}/members`,
      },
    };
    if (p.forkedFromId !== null) {
      const parent = this.world.projects.get(p.forkedFromId);
      if (parent) out.forked_from_project = this.projectSimple(parent);
    }
    if (viewer) {
      const own = p.members.get(viewer.id);
      const groupLevel = Math.max(
        0,
        ...this.world.projectGroups(p).map((g) => g.members.get(viewer.id) ?? 0),
      );
      const personal = p.namespace.kind === "user" && p.namespace.userId === viewer.id;
      out.permissions = {
        project_access: own !== undefined || personal
          ? { access_level: personal ? ACCESS.owner : own, notification_level: 3 }
          : null,
        group_access: groupLevel > 0 ? { access_level: groupLevel, notification_level: 3 } : null,
      };
    }
    return out;
  }

  label(l: Label, p: Project): Json {
    const issues = this.world.issues.filter((i) =>
      i.projectId === p.id && i.labels.includes(l.name)
    );
    const mrs = this.world.mergeRequests.filter((m) =>
      m.projectId === p.id && m.labels.includes(l.name)
    );
    return {
      id: l.id,
      name: l.name,
      color: l.color,
      text_color: "#FFFFFF",
      description: l.description,
      description_html: l.description ?? "",
      open_issues_count: issues.filter((i) => i.state === "opened").length,
      closed_issues_count: issues.filter((i) => i.state === "closed").length,
      open_merge_requests_count: mrs.filter((m) => m.state === "opened").length,
      subscribed: false,
      priority: null,
      is_project_label: l.groupId === null,
    };
  }

  issueWebUrl(i: Issue): string {
    return `${this.projectWebUrl(this.world.projects.get(i.projectId)!)}/-/issues/${i.iid}`;
  }

  mrWebUrl(m: MergeRequest): string {
    return `${this.projectWebUrl(this.world.projects.get(m.projectId)!)}/-/merge_requests/${m.iid}`;
  }

  webUrlOf(n: Noteable): string {
    return n.kind === "issue" ? this.issueWebUrl(n) : this.mrWebUrl(n);
  }

  private userNotes(n: Noteable): number {
    return n.discussions.flatMap((d) => d.notes).filter((x) => !x.system).length;
  }

  private votes(awards: Award[]) {
    return {
      upvotes: awards.filter((a) => a.name === "thumbsup").length,
      downvotes: awards.filter((a) => a.name === "thumbsdown").length,
    };
  }

  issue(i: Issue): Json {
    const p = this.world.projects.get(i.projectId)!;
    return {
      id: i.id,
      iid: i.iid,
      project_id: i.projectId,
      title: i.title,
      description: i.description,
      state: i.state,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      closed_at: i.closedAt,
      closed_by: this.userById(i.closedById),
      labels: i.labels,
      milestone: null,
      assignees: [],
      assignee: null,
      author: this.userById(i.authorId),
      type: "ISSUE",
      issue_type: "issue",
      user_notes_count: this.userNotes(i),
      merge_requests_count: 0,
      ...this.votes(i.awards),
      due_date: null,
      confidential: i.confidential,
      discussion_locked: null,
      web_url: this.issueWebUrl(i),
      references: { short: `#${i.iid}`, relative: `#${i.iid}`, full: `${p.path}#${i.iid}` },
      _links: {
        self: `${this.url}/api/v4/projects/${p.id}/issues/${i.iid}`,
        notes: `${this.url}/api/v4/projects/${p.id}/issues/${i.iid}/notes`,
        project: `${this.url}/api/v4/projects/${p.id}`,
      },
    };
  }

  /** The merge request; `diffRefs` (live while open) only on the single read, as GitLab's. */
  mergeRequest(m: MergeRequest, diffRefs?: DiffRefs | null): Json {
    const p = this.world.projects.get(m.projectId)!;
    const out: Json = {
      id: m.id,
      iid: m.iid,
      project_id: m.projectId,
      title: m.title,
      description: m.description,
      state: m.state,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      merged_by: this.userById(m.mergedById),
      merge_user: this.userById(m.mergedById),
      merged_at: m.mergedAt,
      closed_by: this.userById(m.closedById),
      closed_at: m.closedAt,
      target_branch: m.targetBranch,
      source_branch: m.sourceBranch,
      user_notes_count: this.userNotes(m),
      ...this.votes(m.awards),
      author: this.userById(m.authorId),
      assignees: [],
      assignee: null,
      reviewers: [],
      // Null once the source project is deleted (`deleteProject`).
      source_project_id: this.world.projects.has(m.sourceProjectId) ? m.sourceProjectId : null,
      target_project_id: m.projectId,
      labels: m.labels,
      draft: isDraft(m.title),
      work_in_progress: isDraft(m.title),
      milestone: null,
      merge_when_pipeline_succeeds: false,
      merge_status: m.state === "opened" ? "can_be_merged" : "unchecked",
      detailed_merge_status: m.state === "opened" ? "mergeable" : "not_open",
      sha: m.headSha,
      merge_commit_sha: m.mergeCommitSha,
      squash_commit_sha: m.squashCommitSha,
      discussion_locked: null,
      should_remove_source_branch: null,
      force_remove_source_branch: m.removeSourceBranch,
      allow_collaboration: m.allowCollaboration && this.world.collaborationPossible(m),
      allow_maintainer_to_push: m.allowCollaboration && this.world.collaborationPossible(m),
      reference: `!${m.iid}`,
      references: { short: `!${m.iid}`, relative: `!${m.iid}`, full: `${p.path}!${m.iid}` },
      web_url: this.mrWebUrl(m),
      squash: m.squash,
      squash_on_merge: m.squash,
      has_conflicts: false,
      blocking_discussions_resolved: true,
    };
    if (diffRefs !== undefined) out.diff_refs = diffRefs;
    return out;
  }

  noteable(n: Noteable): Json {
    return n.kind === "issue" ? this.issue(n) : this.mergeRequest(n);
  }

  note(n: Note, on: Noteable): Json {
    return {
      id: n.id,
      type: n.type,
      body: n.body,
      attachment: null,
      author: this.userById(n.authorId),
      created_at: n.createdAt,
      updated_at: n.updatedAt,
      system: n.system,
      noteable_id: on.id,
      noteable_type: on.kind === "issue" ? "Issue" : "MergeRequest",
      noteable_iid: on.iid,
      project_id: on.projectId,
      commit_id: null,
      position: n.position,
      resolvable: n.resolvable,
      resolved: n.resolvable ? n.resolvedById !== null : false,
      resolved_by: n.resolvable ? this.userById(n.resolvedById) : null,
      resolved_at: n.resolvable ? n.resolvedAt : null,
      confidential: n.internal,
      internal: n.internal,
      imported: false,
      imported_from: "none",
      ...(n.suggestions === undefined ? {} : {
        // Appliable while the note's diff is the merge request's latest and it is open.
        suggestions: n.suggestions.map((s) =>
          presentSuggestion(
            s,
            on.kind === "merge_request" && on.state === "opened" &&
              n.position?.head_sha === on.headSha,
          )
        ),
      }),
    };
  }

  discussion(d: Discussion, on: Noteable): Json {
    return {
      id: d.id,
      individual_note: d.individual,
      notes: d.notes.map((n) => this.note(n, on)),
    };
  }

  draft(d: DraftNote, m: MergeRequest): Json {
    return {
      id: d.id,
      author_id: d.authorId,
      merge_request_id: m.id,
      resolve_discussion: d.resolveDiscussion,
      discussion_id: d.inReplyToDiscussionId,
      note: d.note,
      commit_id: null,
      line_code: null,
      position: d.position,
    };
  }

  version(v: MergeRequestVersion, m: MergeRequest): Json {
    return {
      id: v.id,
      head_commit_sha: v.headSha,
      base_commit_sha: v.baseSha,
      start_commit_sha: v.startSha,
      created_at: v.createdAt,
      merge_request_id: m.id,
      state: "collected",
      real_size: null,
    };
  }

  award(a: Award, awardableId: number, type: string): Json {
    return {
      id: a.id,
      name: a.name,
      user: this.userById(a.userId),
      created_at: a.createdAt,
      updated_at: a.createdAt,
      awardable_id: awardableId,
      awardable_type: type,
    };
  }

  status(s: CommitStatus): Json {
    return {
      id: s.id,
      sha: s.sha,
      ref: s.ref,
      status: s.status,
      name: s.name,
      target_url: s.targetUrl,
      description: s.description,
      created_at: s.createdAt,
      started_at: s.startedAt,
      finished_at: s.finishedAt,
      allow_failure: s.allowFailure,
      coverage: null,
      pipeline_id: null,
      author: this.userById(s.authorId),
    };
  }

  commit(c: Commit, p: Project): Json {
    const title = c.message.split("\n")[0] ?? "";
    return {
      id: c.id,
      short_id: c.id.slice(0, 8),
      created_at: c.committedDate,
      parent_ids: c.parentIds,
      title,
      message: c.message,
      author_name: c.authorName,
      author_email: c.authorEmail,
      authored_date: c.authoredDate,
      committer_name: c.committerName,
      committer_email: c.committerEmail,
      committed_date: c.committedDate,
      trailers: {},
      web_url: `${this.projectWebUrl(p)}/-/commit/${c.id}`,
    };
  }

  hook(h: ProjectHook, p: Project): Json {
    return {
      id: h.id,
      url: h.url,
      project_id: p.id,
      push_events: h.pushEvents,
      push_events_branch_filter: h.pushEventsBranchFilter,
      issues_events: h.issuesEvents,
      confidential_issues_events: h.confidentialIssuesEvents,
      confidential_note_events: h.confidentialNoteEvents,
      merge_requests_events: h.mergeRequestsEvents,
      note_events: h.noteEvents,
      enable_ssl_verification: true,
      created_at: h.createdAt,
    };
  }
}

/** GitLab's draft rule: a `Draft:`, `[Draft]` or `(Draft)` title prefix, any case. */
export function isDraft(title: string): boolean {
  return /^\s*(\[draft\]|\(draft\)|draft:)/i.test(title);
}
