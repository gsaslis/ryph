// Webhook emission: the project hooks a Maintainer registered (or the control API added), and
// deliveries of Push, Note, Merge Request and Issue events to them, shaped as GitLab's webhook
// documentation shows and carrying its headers: `X-Gitlab-Event`, `X-Gitlab-Token`,
// `X-Gitlab-Event-UUID`, `X-Gitlab-Webhook-UUID`, `X-Gitlab-Instance` and, on 17.4 and later,
// `Idempotency-Key` (stable across a redelivery, while the event UUID is new on each).
//
// Deliveries run in the background, as GitLab's do; `flush()` waits for every one in flight,
// and each is recorded with its answer so a test can assert what landed.

import { randomUUID } from "node:crypto";
import type { Commit } from "./git/repo.ts";
import {
  type Issue,
  type MergeRequest,
  type Note,
  type Noteable,
  type Project,
  type ProjectHook,
  type User,
  VISIBILITY_LEVEL,
  type World,
} from "./model.ts";
import { isDraft, type Present } from "./present.ts";

type Json = Record<string, unknown>;

export type HookKind =
  | "push"
  | "note"
  | "confidential_note"
  | "merge_request"
  | "issue"
  | "confidential_issue";

const EVENT_NAME: Record<HookKind, string> = {
  push: "Push Hook",
  note: "Note Hook",
  confidential_note: "Confidential Note Hook",
  merge_request: "Merge Request Hook",
  issue: "Issue Hook",
  confidential_issue: "Confidential Issue Hook",
};

export interface Delivery {
  id: number;
  hookId: number;
  projectId: number;
  /** The `X-Gitlab-Event` it carried. */
  event: string;
  url: string;
  headers: Record<string, string>;
  body: Json;
  /** The receiver's HTTP status, or null when the request itself failed. */
  status: number | null;
  error: string | null;
}

/** Whether a branch passes a hook's push filter: an exact name, or a `*` wildcard pattern. */
export function branchMatches(filter: string | null, branch: string): boolean {
  if (filter === null || filter === "") return true;
  const re = new RegExp(
    `^${filter.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return re.test(branch);
}

export class Hooks {
  readonly deliveries: Delivery[] = [];
  #pending = new Set<Promise<void>>();
  #seq = 0;

  constructor(
    readonly world: World,
    readonly present: Present,
    readonly version: string,
    readonly fetchImpl: typeof fetch,
  ) {}

  /** Whether this instance's version sends `Idempotency-Key` (17.4 and later, per GitLab's
   * docs; verified absent on 17.0.8 and present on 17.11.7). */
  get sendsIdempotencyKey(): boolean {
    const [major = 0, minor = 0] = this.version.split(".").map(Number);
    return major > 17 || (major === 17 && minor >= 4);
  }

  /** Sends `body` to every hook of the project subscribed to `kind`; `branch` filters push
   * events by each hook's branch filter. */
  emit(project: Project, kind: HookKind, body: Json, branch?: string) {
    for (const hook of project.hooks) {
      if (!subscribed(hook, kind)) continue;
      if (
        kind === "push" && branch !== undefined &&
        !branchMatches(hook.pushEventsBranchFilter, branch)
      ) {
        continue;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": `GitLab/${this.version}`,
        "x-gitlab-event": EVENT_NAME[kind],
        "x-gitlab-instance": this.present.url,
        "x-gitlab-webhook-uuid": hook.uuid,
        "x-gitlab-event-uuid": randomUUID(),
      };
      if (hook.token !== null) headers["x-gitlab-token"] = hook.token;
      if (this.sendsIdempotencyKey) headers["idempotency-key"] = randomUUID();
      const delivery: Delivery = {
        id: ++this.#seq,
        hookId: hook.id,
        projectId: project.id,
        event: EVENT_NAME[kind],
        url: hook.url,
        headers,
        body,
        status: null,
        error: null,
      };
      this.deliveries.push(delivery);
      this.#send(delivery);
    }
  }

  /** Sends a recorded delivery again — what GitLab's "Resend request" does: the same
   * `Idempotency-Key`, a new `X-Gitlab-Event-UUID` (verified on GitLab 17.11). Answers the new
   * delivery's record. */
  async redeliver(id: number): Promise<Delivery> {
    const old = this.deliveries.find((d) => d.id === id);
    if (!old) throw new Error(`no delivery ${id}`);
    const again: Delivery = {
      ...old,
      id: ++this.#seq,
      headers: { ...old.headers, "x-gitlab-event-uuid": randomUUID() },
      status: null,
      error: null,
    };
    this.deliveries.push(again);
    this.#send(again);
    await this.flush();
    return again;
  }

  /** Waits for every delivery in flight, including ones those trigger. */
  async flush() {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  #send(d: Delivery) {
    const p = (async () => {
      try {
        const res = await this.fetchImpl(d.url, {
          method: "POST",
          headers: d.headers,
          body: JSON.stringify(d.body),
        });
        d.status = res.status;
        await res.body?.cancel();
      } catch (e) {
        d.error = e instanceof Error ? e.message : String(e);
      }
    })();
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  // --- payloads ---------------------------------------------------------------------------

  user(u: User): Json {
    return { id: u.id, name: u.name, username: u.username, avatar_url: null, email: "[REDACTED]" };
  }

  project(p: Project): Json {
    const web = this.present.projectWebUrl(p);
    return {
      id: p.id,
      name: p.name,
      description: null,
      web_url: web,
      avatar_url: null,
      git_ssh_url: this.present.sshUrl(p),
      git_http_url: this.present.httpUrl(p),
      namespace: (this.present.namespace(p) as { name: string }).name,
      visibility_level: VISIBILITY_LEVEL[p.visibility],
      path_with_namespace: p.path,
      default_branch: p.defaultBranch,
      ci_config_path: null,
      homepage: web,
      url: this.present.sshUrl(p),
      ssh_url: this.present.sshUrl(p),
      http_url: this.present.httpUrl(p),
    };
  }

  repository(p: Project): Json {
    const web = this.present.projectWebUrl(p);
    return {
      name: p.name,
      url: this.present.sshUrl(p),
      description: null,
      homepage: web,
      git_http_url: this.present.httpUrl(p),
      git_ssh_url: this.present.sshUrl(p),
      visibility_level: VISIBILITY_LEVEL[p.visibility],
    };
  }

  labels(p: Project, names: string[]): Json[] {
    const all = this.world.labelsOf(p, true);
    return names.flatMap((n) => {
      const l = all.find((x) => x.name === n);
      return l
        ? [{
          id: l.id,
          title: l.name,
          color: l.color,
          project_id: l.groupId === null ? p.id : null,
          group_id: l.groupId,
          description: l.description,
          type: l.groupId === null ? "ProjectLabel" : "GroupLabel",
        }]
        : [];
    });
  }

  commit(c: Commit, p: Project): Json {
    return {
      id: c.id,
      message: c.message,
      title: c.message.split("\n")[0] ?? "",
      timestamp: c.committedDate,
      url: `${this.present.projectWebUrl(p)}/-/commit/${c.id}`,
      author: { name: c.authorName, email: c.authorEmail },
    };
  }

  issueAttributes(i: Issue, action?: string): Json {
    const p = this.world.projects.get(i.projectId)!;
    return {
      id: i.id,
      iid: i.iid,
      title: i.title,
      description: i.description,
      state: i.state,
      state_id: i.state === "opened" ? 1 : 2,
      author_id: i.authorId,
      project_id: i.projectId,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      closed_at: i.closedAt,
      confidential: i.confidential,
      url: this.present.issueWebUrl(i),
      labels: this.labels(p, i.labels),
      ...(action ? { action } : {}),
    };
  }

  /** A merge request's `object_attributes`. Only `author_id`, no author username anywhere in
   * the payload (verified on GitLab 17.11): the consumer looks the username up. */
  mrAttributes(m: MergeRequest, lastCommit: Commit | null, extra: Json = {}): Json {
    const target = this.world.projects.get(m.projectId)!;
    const source = this.world.projects.get(m.sourceProjectId);
    return {
      id: m.id,
      iid: m.iid,
      target_branch: m.targetBranch,
      source_branch: m.sourceBranch,
      source_project_id: source ? m.sourceProjectId : null,
      target_project_id: m.projectId,
      author_id: m.authorId,
      assignee_ids: [],
      reviewer_ids: [],
      title: m.title,
      description: m.description,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      state: m.state,
      state_id: { opened: 1, closed: 2, merged: 3, locked: 4 }[m.state],
      merge_status: m.state === "opened" ? "can_be_merged" : "unchecked",
      detailed_merge_status: m.state === "opened" ? "mergeable" : "not_open",
      merge_commit_sha: m.mergeCommitSha,
      head_pipeline_id: null,
      blocking_discussions_resolved: true,
      work_in_progress: isDraft(m.title),
      draft: isDraft(m.title),
      url: this.present.mrWebUrl(m),
      source: source ? this.project(source) : null,
      target: this.project(target),
      last_commit: lastCommit ? this.commit(lastCommit, source ?? target) : null,
      labels: this.labels(target, m.labels),
      ...extra,
    };
  }

  noteBody(
    actor: User,
    project: Project,
    on: Noteable,
    note: Note,
    discussionId: string,
    lastCommit: Commit | null,
  ): Json {
    const body: Json = {
      object_kind: "note",
      event_type: "note",
      user: this.user(actor),
      project_id: project.id,
      project: this.project(project),
      repository: this.repository(project),
      object_attributes: {
        id: note.id,
        note: note.body,
        noteable_type: on.kind === "issue" ? "Issue" : "MergeRequest",
        author_id: note.authorId,
        created_at: note.createdAt,
        updated_at: note.updatedAt,
        project_id: project.id,
        attachment: null,
        confidential: note.internal,
        internal: note.internal,
        line_code: null,
        commit_id: "",
        noteable_id: on.id,
        system: note.system,
        st_diff: null,
        type: note.type,
        position: note.position,
        original_position: note.position,
        resolved_at: note.resolvedAt,
        resolved_by_id: note.resolvedById,
        discussion_id: discussionId,
        url: `${this.present.webUrlOf(on)}#note_${note.id}`,
        action: "create",
      },
    };
    if (on.kind === "issue") body.issue = this.issueAttributes(on);
    else body.merge_request = this.mrAttributes(on, lastCommit);
    return body;
  }
}

function subscribed(hook: ProjectHook, kind: HookKind): boolean {
  switch (kind) {
    case "push":
      return hook.pushEvents;
    case "note":
      return hook.noteEvents;
    case "merge_request":
      return hook.mergeRequestsEvents;
    case "issue":
      return hook.issuesEvents;
    case "confidential_note":
      return hook.confidentialNoteEvents;
    case "confidential_issue":
      return hook.confidentialIssuesEvents;
  }
}
