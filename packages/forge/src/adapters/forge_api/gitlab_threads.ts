// Reading a GitLab thread whole — an issue's or a merge request's opening post and every
// discussion on it — and finding a write whose response was lost.
//
// A merge request's three channels on GitHub (conversation, review verdicts, inline remarks) are
// one listing here: discussions. A non-system note is a `comment`, a `DiffNote` a `review_comment`
// with its discussion as its review thread, and the verdicts are rebuilt from SYSTEM notes
// ("approved this merge request", …), since GitLab keeps approvals apart from any note.

import {
  type ChangeRequestHead,
  ForgeApiError,
  type ForgeRepo,
  type ThreadContext,
  type ThreadEntry,
  type ThreadReadOptions,
  type ThreadRef,
  type WrittenTarget,
} from "../../ports/forge_api.ts";
import { attachThreadImages, type ImageSlot } from "../../core/thread_images.ts";
import type { GitlabImageSlots } from "../../ports/gitlab.ts";
import {
  type GitlabContext,
  type GitlabThread,
  hasMore,
  noteableSegment,
  noteHandle,
  remarkHandle,
  stateOf,
  str,
} from "./gitlab_client.ts";

/** Pages of 100 discussions per thread. Past it the read is REPORTED cut (`truncated`). */
const THREAD_PAGE_LIMIT = 5;

/** Characters of note text one read may hold — GitHub adapter's bound, for its reason. */
const LISTING_BUDGET = 200_000;

/** What one entry's text may contribute. */
const ENTRY_BUDGET = 16_000;

/** What a thread read with images needs beyond the context. */
export interface ThreadImages {
  slots: GitlabImageSlots;
  /** The credentialed GET of an API path (`GitlabImageSource.get`). */
  get(apiPath: string, signal: AbortSignal): Promise<Response>;
}

/** A review verdict a system note announces, or null for every other system note. Verified on
 * GitLab 17.11: "approved this merge request", "unapproved this merge request" and "requested
 * changes" (the UI's review verdict; no REST route makes it). */
export function verdictOf(body: string): string | null {
  const text = body.trim().toLowerCase();
  if (/^approved this merge request/.test(text)) return "approved";
  if (/^unapproved this merge request/.test(text)) return "unapproved";
  if (/^requested changes/.test(text)) return "changes_requested";
  return null;
}

/** An internal note (`internal`, and its older name `confidential`), or one whose answer does not
 * say it is not one. */
// oxlint-disable-next-line no-explicit-any
const privateNote = (note: any): boolean => note?.internal !== false || note?.confidential === true;

/** A merge request's head as a run working on it needs it — the submit path's last look. */
export async function readHead(
  ctx: GitlabContext,
  repo: ForgeRepo,
  thread: GitlabThread,
  // oxlint-disable-next-line no-explicit-any
  mr: any,
): Promise<ChangeRequestHead> {
  const state = mr?.state;
  const sha = mr?.sha;
  // Null once the source project is deleted: GitLab then nulls it and closes the merge request.
  const sourceId = mr?.source_project_id;
  const targetId = mr?.target_project_id;
  // Every field read here authorizes a push onto somebody's branch, so none is defaulted.
  if (
    !["opened", "closed", "locked", "merged"].includes(state) ||
    typeof sha !== "string" || sha === "" ||
    typeof mr.source_branch !== "string" || typeof mr.target_branch !== "string" ||
    typeof mr.web_url !== "string" || (typeof sourceId !== "number" && sourceId !== null) ||
    typeof targetId !== "number"
  ) {
    throw new ForgeApiError(
      `reading merge request !${thread.iid}: the forge's answer is missing fields`,
      false,
    );
  }
  const projectOf = async (id: number) => {
    const res = await ctx.client.call("GET", `/projects/${id}`);
    if (res.status === 404 || res.status === 403) return null;
    if (res.status !== 200) throw ctx.client.refusal(`reading project ${id}`, res);
    return res.body;
  };
  const [target, source] = await Promise.all([
    projectOf(targetId),
    sourceId === targetId || sourceId === null ? Promise.resolve(undefined) : projectOf(sourceId),
  ]);
  const defaultBranch = target?.default_branch;
  if (typeof defaultBranch !== "string") {
    throw new ForgeApiError(
      `reading !${thread.iid}'s project: the forge named no default branch`,
      false,
    );
  }
  // The same project, the fork as it stands, or nothing: a deleted fork (no source id left), or
  // one ryph may not see. GitLab answers a private fork the account is no member of 404, as it
  // does a missing project; its source id still stands, and so does the fork — its head is
  // served from the target project (`merge-requests/<iid>/head`) like any fork's, and only a
  // push onto it is out of reach.
  const head = sourceId === null ? null : source === undefined ? target : source;
  const hidden = sourceId !== null && sourceId !== targetId && source === null;
  return {
    ref: thread.ref,
    url: mr.web_url,
    // `locked` is a merge underway, not an end: it reads as open, and the submit path asks
    // again (`describeChangeRequest`).
    state: state === "opened" || state === "locked" ? "open" : "closed",
    merged: state === "merged",
    headRef: mr.source_branch,
    headSha: sha,
    // A merge request has one head, moved only through its source branch.
    authorHeadSha: sha,
    baseRef: mr.target_branch,
    headRepoRef: hidden
      ? `project ${sourceId}`
      : typeof head?.path_with_namespace === "string"
      ? head.path_with_namespace
      : null,
    ...(hidden ? { headRepoHidden: true } : {}),
    // By the ids, never the paths: the row's path is the one the project was connected under.
    sameRepo: sourceId === targetId,
    headRepoUrl: typeof head?.http_url_to_repo === "string" ? head.http_url_to_repo : null,
    headRepoDefaultBranch: typeof head?.default_branch === "string" ? head.default_branch : null,
    // Anything but a plain true is no: the switch is the fork author's consent.
    maintainerCanModify: mr.allow_collaboration === true,
    // Counting would cost another request; the history read counts for itself.
    commitCount: null,
    defaultBranch,
  };
}

export async function fetchThread(
  ctx: GitlabContext,
  repo: ForgeRepo,
  asked: ThreadRef,
  readOpts: ThreadReadOptions | undefined,
  images: ThreadImages,
): Promise<ThreadContext> {
  const project = ctx.project(repo);
  const thread = await ctx.resolveThread(repo, asked.ref);
  const base = `/projects/${project}/${noteableSegment(thread)}/${thread.iid}`;
  const head = await ctx.client.call("GET", base);
  if (head.status !== 200 || typeof head.body?.title !== "string") {
    throw head.status === 404
      ? new ForgeApiError(
        `there is no ${thread.kind === "issue" ? `issue #` : "merge request !"}${thread.iid} here`,
        true,
      )
      : ctx.client.refusal(`reading ${thread.ref}`, head);
  }
  if (thread.kind === "issue" && head.body.confidential !== false) {
    // A confidential issue is for the project's Reporters and the people on it, while the rule
    // that keeps private text out of public places reads the PROJECT's visibility: shown to an
    // agent, it could be repeated in any public thread of the project. So it is not shown at all
    // — and an answer that does not say it is not confidential is taken to say it is.
    throw new ForgeApiError(
      `issue #${thread.iid} is confidential, and ryph does not read confidential issues to agents`,
      true,
    );
  }

  const entries: ThreadEntry[] = [];
  let held = 0;
  let truncated = false;
  /** When the read was cut: the first note of the discussion it stopped at — every note before
   * it is in a discussion already read, so what precedes it is a true prefix. */
  let horizon: string | null = null;
  const login = (note: { author?: { username?: unknown } }) =>
    str(note?.author?.username, "unknown");

  const listing = async () => {
    for (let page = 1; page <= THREAD_PAGE_LIMIT; page++) {
      const res = await ctx.client.call("GET", `${base}/discussions?per_page=100&page=${page}`);
      if (res.status !== 200 || !Array.isArray(res.body)) {
        // Deleted or hidden between the head and here is as final as before it.
        throw res.status === 404
          ? new ForgeApiError(`${thread.ref} is gone`, true)
          : ctx.client.refusal(`reading the discussions of ${thread.ref}`, res);
      }
      for (const discussion of res.body) {
        const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
        const id = str(discussion?.id);
        const resolvable = notes.filter((n: { resolvable?: unknown }) => n?.resolvable === true);
        const resolved = resolvable.length === 0
          ? null
          : resolvable.every((n: { resolved?: unknown }) => n?.resolved === true);
        let opener: string | null = null;
        for (const note of notes) {
          // An internal note is for Reporters and up, on a thread anyone with the project may
          // read: never shown, as a confidential issue is not (above) — and a note that does not
          // say it is not internal is taken to be.
          if (privateNote(note)) continue;
          const body = str(note?.body);
          const createdAt = str(note?.created_at);
          let entry: ThreadEntry | null;
          if (note?.system === true) {
            const verdict = thread.kind === "change_request" ? verdictOf(body) : null;
            entry = verdict === null ? null : {
              kind: "review",
              authorLogin: login(note),
              body: "",
              createdAt,
              state: verdict,
              location: null,
            };
          } else if (note?.type === "DiffNote" || note?.position != null) {
            const p = note.position ?? {};
            const onNew = typeof p.new_line === "number";
            const path = onNew ? str(p.new_path) : str(p.old_path) || str(p.new_path);
            const line = onNew ? p.new_line : p.old_line;
            const handle = typeof note.id === "number" && /^[0-9a-f]{40}$/.test(id)
              ? remarkHandle(thread, id, note.id)
              : null;
            entry = {
              kind: "review_comment",
              authorLogin: login(note),
              body: body.slice(0, ENTRY_BUDGET),
              createdAt,
              state: null,
              location: path === "" ? null : `${path}${typeof line === "number" ? `:${line}` : ""}`,
              // The entry is named as the webhook names its note (`sourceCommentId`): the
              // conversation-note spelling. Its remark carries the discussion, for replies.
              ...(typeof note.id === "number" ? { id: noteHandle(thread, note.id) } : {}),
              ...(handle === null ? {} : { remark: { id: handle, replyTo: opener, resolved } }),
            };
            if (opener === null && handle !== null) opener = handle;
          } else {
            entry = {
              kind: "comment",
              authorLogin: login(note),
              body: body.slice(0, ENTRY_BUDGET),
              createdAt,
              state: null,
              location: null,
              ...(typeof note?.id === "number" ? { id: noteHandle(thread, note.id) } : {}),
            };
          }
          if (entry === null) continue;
          if (held + entry.body.length > LISTING_BUDGET) {
            truncated = true;
            horizon = str(notes[0]?.created_at) || createdAt;
            return;
          }
          entries.push(entry);
          held += entry.body.length;
        }
      }
      if (!hasMore(res, 100)) return;
      if (page === THREAD_PAGE_LIMIT) {
        truncated = true;
        const last = res.body.at(-1);
        horizon = str(last?.notes?.[0]?.created_at) || null;
      }
    }
  };

  // The listing and a merge request's head, side by side: the head is what a run checks out.
  const [, changeRequest] = await Promise.all([
    listing(),
    thread.kind === "change_request"
      ? readHead(ctx, repo, thread, head.body)
      : Promise.resolve(null),
  ]);

  const key = (e: ThreadEntry) => e.createdAt || "9999";
  const sorted = entries.sort((a, b) => key(a).localeCompare(key(b)));
  const kept = horizon === null ? sorted : sorted.filter((e) => key(e) < horizon!);

  const context: ThreadContext = {
    kind: thread.kind,
    ref: thread.ref,
    title: head.body.title,
    body: str(head.body.description).slice(0, ENTRY_BUDGET),
    authorLogin: login(head.body),
    createdAt: str(head.body.created_at),
    state: stateOf(head.body.state),
    entries: kept,
    truncated,
    changeRequest,
  };

  if (readOpts?.images !== undefined) {
    const projectId = head.body.project_id;
    const source = {
      instanceUrl: ctx.url,
      projectId: String(projectId),
      projectPath: repo.repoRef,
      get: images.get,
    };
    const slots: ImageSlot[] = typeof projectId === "number"
      ? [
        ...images.slots("body", context.body, source),
        ...kept.flatMap((entry, i) => images.slots(i, entry.body, source)),
      ]
      : [];
    await attachThreadImages(context, slots, readOpts.images.focus, {
      focusOnly: readOpts.images.focusOnly === true,
    });
  }
  return context;
}

/**
 * A write this deployment made since `since` whose body carries `marker`: an issue the account
 * opened, or a note on a thread — a comment, a review's body or remark, a reply, which are all
 * notes here. Listings, newest first, never the search index.
 */
export async function findMarkedWrite(
  ctx: GitlabContext,
  repo: ForgeRepo,
  target: WrittenTarget,
  marker: string,
  since: string,
): Promise<{ url: string; createdRef: string | null } | null> {
  const project = ctx.project(repo);
  const sinceMs = Date.parse(since);
  if (target.kind === "issue") {
    for (let page = 1; page <= 3; page++) {
      const res = await ctx.client.call(
        "GET",
        `/projects/${project}/issues?author_id=${encodeURIComponent(ctx.self.id)}` +
          `&created_after=${encodeURIComponent(since)}&order_by=created_at&sort=desc` +
          `&per_page=100&page=${page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw ctx.client.refusal(`looking for a lost write in ${repo.repoRef}`, res);
      }
      for (const issue of res.body) {
        if (!str(issue?.description).includes(marker)) continue;
        if (typeof issue.web_url !== "string" || typeof issue.iid !== "number") continue;
        return { url: issue.web_url, createdRef: `issue-${issue.iid}` };
      }
      if (!hasMore(res, 100)) break;
    }
    return null;
  }
  const thread = await ctx.resolveThread(repo, target.threadRef);
  const base = `/projects/${project}/${noteableSegment(thread)}/${thread.iid}/notes`;
  // A review is walked further: its notes are as many as its remarks.
  const maxPages = target.kind === "review" ? 30 : 3;
  for (let page = 1; page <= maxPages; page++) {
    const res = await ctx.client.call(
      "GET",
      `${base}?order_by=created_at&sort=desc&per_page=100&page=${page}`,
    );
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw ctx.client.refusal(`looking for a lost write in ${repo.repoRef}`, res);
    }
    for (const note of res.body) {
      // Newest first: a note before the reservation ends the search.
      const at = Date.parse(str(note?.created_at));
      if (Number.isFinite(at) && Number.isFinite(sinceMs) && at < sinceMs) return null;
      if (note?.system === true || String(note?.author?.id) !== ctx.self.id) continue;
      // A review's remarks carry its marker too, and are published before its body: a remark
      // found alone is a review cut short, not one that landed. Only the body (no diff note)
      // says the whole review was published.
      if (target.kind === "review" && (note?.type === "DiffNote" || note?.position != null)) {
        continue;
      }
      if (!str(note?.body).includes(marker) || typeof note.id !== "number") continue;
      return { url: `${ctx.threadUrl(repo, thread)}#note_${note.id}`, createdRef: null };
    }
    if (!hasMore(res, 100)) break;
  }
  return null;
}
