// A merge request's diff and its review surface on GitLab: the diff listings, reviews as batches
// of draft notes published one by one, and replies and resolution on a diff note's discussion.
//
// Invariants:
// - a review never leaves drafts behind: a failure deletes every draft it made and had not yet
//   published, so nothing lingers in the account's pending review to be published by somebody's
//   next click; a note already published stands, as on GitHub's partial failure
// - only the drafts a call made are ever published or deleted, never another pending draft of
//   the account: in bot mode another review on the same merge request may be drafting at this
//   very moment under the same token, and in user mode they are the person's own
// - a reply or a resolution names a discussion ON the merge request the grant was checked for:
//   the handle's thread must be that merge request, and the request path scopes the rest

import {
  type ChangedFile,
  ForgeApiError,
  type ForgeRepo,
  type Page,
} from "../../ports/forge_api.ts";
import {
  type GitlabContext,
  type GitlabResponse,
  type GitlabThread,
  hasMore,
  inertToQuickActions,
  parseNoteHandle,
  str,
} from "./gitlab_client.ts";

/** Pages of 100 the diff walk takes — 3 000 files, GitHub's own ceiling. */
const DIFF_PAGES = 30;

/** A merge request as GitLab answers it, or a terminal refusal for one that is not there. */
export async function readMergeRequest(
  ctx: GitlabContext,
  project: string,
  thread: GitlabThread,
): Promise<GitlabResponse> {
  const res = await ctx.client.call("GET", `/projects/${project}/merge_requests/${thread.iid}`);
  if (res.status !== 200 || typeof res.body !== "object" || res.body === null) {
    throw res.status === 404
      ? new ForgeApiError(`there is no merge request !${thread.iid} here`, true)
      : ctx.client.refusal(`reading merge request !${thread.iid}`, res);
  }
  return res;
}

/** A thread resolved and held to be a merge request — a terminal refusal for an issue. */
export async function mergeRequestOf(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
): Promise<GitlabThread> {
  const thread = await ctx.resolveThread(repo, ref);
  if (thread.kind !== "change_request") {
    throw new ForgeApiError(`#${thread.iid} is an issue, not a merge request`, true);
  }
  return thread;
}

/** One file of a merge request's diff, as GitLab lists it. */
interface DiffFile {
  oldPath: string;
  newPath: string;
  status: string;
  patch: string | null;
}

// oxlint-disable-next-line no-explicit-any
function diffFileOf(raw: any): DiffFile {
  const diff = str(raw?.diff);
  // A diff GitLab collapsed or found too large carries no hunks; a binary one carries none
  // either. Neither is a diff a remark could anchor to.
  const shown = raw?.collapsed !== true && raw?.too_large !== true && diff !== "" &&
    diff.startsWith("@@");
  return {
    oldPath: str(raw?.old_path),
    newPath: str(raw?.new_path) || str(raw?.old_path),
    status: raw?.new_file === true
      ? "added"
      : raw?.deleted_file === true
      ? "removed"
      : raw?.renamed_file === true
      ? "renamed"
      : "modified",
    patch: shown ? diff : null,
  };
}

/** Additions and deletions, counted off the hunks: GitLab's diff listing does not give them. */
function countLines(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  if (patch === null) return { additions, deletions };
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

const diffsPath = (project: string, thread: GitlabThread, page: number) =>
  `/projects/${project}/merge_requests/${thread.iid}/diffs?per_page=100&page=${page}`;

/** One page of the files a merge request changes (`/diffs`, GitLab 15.7+). */
export async function listChangeRequestFiles(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
): Promise<Page<ChangedFile>> {
  const project = ctx.project(repo);
  const thread = await mergeRequestOf(ctx, repo, ref);
  const res = await ctx.client.call("GET", diffsPath(project, thread, 1));
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw ctx.client.refusal(`listing the files of !${thread.iid}`, res);
  }
  let files: DiffFile[] = res.body.map(diffFileOf);
  if (files.some(withheld)) {
    files = await fillWithheld(
      ctx,
      project,
      thread,
      (await readMergeRequest(ctx, project, thread)).body,
      files,
    );
  }
  const items: ChangedFile[] = files.map((file) => {
    return {
      path: file.newPath,
      status: file.status,
      ...countLines(file.patch),
      patch: file.patch,
    };
  });
  return { items, hasMore: hasMore(res, 100) };
}

/** Every file of the diff, walked to GitLab's end or `DIFF_PAGES`. */
async function walkDiff(
  ctx: GitlabContext,
  project: string,
  thread: GitlabThread,
): Promise<{ files: DiffFile[]; complete: boolean }> {
  const files: DiffFile[] = [];
  for (let page = 1; page <= DIFF_PAGES; page++) {
    const res = await ctx.client.call("GET", diffsPath(project, thread, page));
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw ctx.client.refusal(`listing the diff of !${thread.iid}`, res);
    }
    for (const raw of res.body) files.push(diffFileOf(raw));
    if (!hasMore(res, 100)) return { files, complete: true };
  }
  return { files, complete: false };
}

/** The diff's head: `diff_refs.head_sha` — the commit the listed diff is OF — else the MR's
 * `sha`. */
// oxlint-disable-next-line no-explicit-any
const diffHeadOf = (mr: any): string => str(mr?.diff_refs?.head_sha) || str(mr?.sha);

export async function listChangeRequestPatches(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
): Promise<{
  files: Array<{ path: string; patch: string | null }>;
  complete: boolean;
  headSha: string;
}> {
  const project = ctx.project(repo);
  const thread = await mergeRequestOf(ctx, repo, ref);
  // The head first, under the same token: what the caller checks its remarks against, and then
  // posts them against.
  const mr = await readMergeRequest(ctx, project, thread);
  const headSha = diffHeadOf(mr.body);
  if (headSha === "") {
    throw new ForgeApiError(`reading !${thread.iid}: the forge named no head`, false);
  }
  const walked = await walkDiff(ctx, project, thread);
  const files = await fillWithheld(ctx, project, thread, mr.body, walked.files);
  const complete = walked.complete;
  return {
    files: files.map((f) => ({ path: f.newPath, patch: f.patch })),
    complete,
    headSha,
  };
}

/**
 * Where a remark sits on GitLab's two numberings. A RIGHT line that was added, or a LEFT line
 * that was deleted, has one number; a context line has both, and GitLab refuses a position on
 * one that names only one of them. Null: the line is not in the diff on that side.
 */
export function positionLines(
  patch: string,
  side: "LEFT" | "RIGHT",
  line: number,
): { old_line?: number; new_line?: number } | null {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("+")) {
      if (side === "RIGHT" && newLine === line) return { new_line: line };
      newLine++;
    } else if (text.startsWith("-")) {
      if (side === "LEFT" && oldLine === line) return { old_line: line };
      oldLine++;
    } else {
      if ((side === "RIGHT" && newLine === line) || (side === "LEFT" && oldLine === line)) {
        return { old_line: oldLine, new_line: newLine };
      }
      oldLine++;
      newLine++;
    }
  }
  return null;
}

/** The three SHAs a diff position is pinned to. */
interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/**
 * The diff a review is posted against, and its files: the merge request's current one when the
 * caller's head is still the head, else the recorded version whose head it is — a push between
 * the caller's check and this write must not turn validated remarks into a refusal.
 */
async function diffAt(
  ctx: GitlabContext,
  project: string,
  thread: GitlabThread,
  // oxlint-disable-next-line no-explicit-any
  mr: any,
  headSha: string,
): Promise<{ refs: DiffRefs; files: DiffFile[] }> {
  const current = mr?.diff_refs;
  if (
    str(current?.head_sha) === headSha && typeof current?.base_sha === "string" &&
    typeof current?.start_sha === "string"
  ) {
    return {
      refs: { base_sha: current.base_sha, start_sha: current.start_sha, head_sha: headSha },
      files: await fillWithheld(
        ctx,
        project,
        thread,
        mr,
        (await walkDiff(ctx, project, thread)).files,
      ),
    };
  }
  const version = await versionAt(ctx, project, thread, headSha);
  if (version === null) {
    throw new ForgeApiError(
      `${headSha.slice(0, 12)} is not a version of !${thread.iid}, so no remark can be pinned ` +
        "to it — read the merge request again",
      true,
    );
  }
  return version;
}

/**
 * The version of a merge request whose head is `headSha`, with its diff, or null when GitLab
 * recorded none. A version's diff carries a file up to `diff_max_patch_bytes` (200 KB by
 * default), where `/diffs` withholds one past a tenth of it (verified on GitLab 17.11).
 */
async function versionAt(
  ctx: GitlabContext,
  project: string,
  thread: GitlabThread,
  headSha: string,
): Promise<{ refs: DiffRefs; files: DiffFile[] } | null> {
  const listed = await ctx.client.call(
    "GET",
    `/projects/${project}/merge_requests/${thread.iid}/versions?per_page=100`,
  );
  if (listed.status !== 200 || !Array.isArray(listed.body)) {
    throw ctx.client.refusal(`listing the versions of !${thread.iid}`, listed);
  }
  // oxlint-disable-next-line no-explicit-any
  const version = listed.body.find((v: any) => v?.head_commit_sha === headSha);
  if (version === undefined || typeof version.id !== "number") return null;
  const one = await ctx.client.call(
    "GET",
    `/projects/${project}/merge_requests/${thread.iid}/versions/${version.id}`,
  );
  if (one.status !== 200 || !Array.isArray(one.body?.diffs)) {
    throw ctx.client.refusal(`reading version ${version.id} of !${thread.iid}`, one);
  }
  return {
    refs: {
      base_sha: str(one.body.base_commit_sha),
      start_sha: str(one.body.start_commit_sha),
      head_sha: headSha,
    },
    files: one.body.diffs.map(diffFileOf),
  };
}

/** A file `/diffs` listed without hunks: binary, mode-only, or withheld for its size. */
const withheld = (f: DiffFile): boolean => f.patch === null;

/**
 * `/diffs`' files with what it withheld for size read from the version GitLab recorded for the
 * merge request's current diff — the same base, start and head, so the hunks are the same diff's
 * and a remark pinned to one is pinned to the other. A file the version has no hunks for either
 * (binary, or past 200 KB) stays without; a version on other refs fills nothing.
 */
async function fillWithheld(
  ctx: GitlabContext,
  project: string,
  thread: GitlabThread,
  // oxlint-disable-next-line no-explicit-any
  mr: any,
  files: DiffFile[],
): Promise<DiffFile[]> {
  const refs = mr?.diff_refs;
  const headSha = str(refs?.head_sha);
  if (!files.some(withheld) || headSha === "") return files;
  const version = await versionAt(ctx, project, thread, headSha);
  if (
    version === null || version.refs.base_sha !== str(refs.base_sha) ||
    version.refs.start_sha !== str(refs.start_sha)
  ) {
    return files;
  }
  const byPath = new Map(version.files.map((f) => [f.newPath, f]));
  return files.map((f) => withheld(f) ? { ...f, patch: byPath.get(f.newPath)?.patch ?? null } : f);
}

/**
 * One comment-only review: a draft note per remark, pinned to the diff the remarks were checked
 * against, one more for the body, then each published in that order, the body last. Never an
 * approval and never a block. A failure deletes every draft this call made and had not published.
 */
export async function createReview(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
  params: {
    body: string;
    comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
    headSha: string | null;
  },
): Promise<{ url: string }> {
  const project = ctx.project(repo);
  const thread = await mergeRequestOf(ctx, repo, ref);
  const mr = (await readMergeRequest(ctx, project, thread)).body;
  const url = str(mr.web_url) || ctx.threadUrl(repo, thread);
  const drafts = `/projects/${project}/merge_requests/${thread.iid}/draft_notes`;

  // Positions first, before anything is written: a remark that cannot be pinned costs nothing.
  const positioned: Array<{ note: string; position?: Record<string, unknown> }> = [];
  if (params.comments.length > 0) {
    const headSha = params.headSha ?? diffHeadOf(mr);
    const { refs, files } = await diffAt(ctx, project, thread, mr, headSha);
    const byPath = new Map(files.map((f) => [f.newPath, f]));
    params.comments.forEach((c, i) => {
      const file = byPath.get(c.path);
      const lines = file?.patch == null ? null : positionLines(file.patch, c.side, c.line);
      if (file === undefined || lines === null) {
        throw new ForgeApiError(
          `remark ${i + 1} (${c.path}:${c.line}) is not a line of !${thread.iid}'s diff on side ` +
            c.side,
          true,
        );
      }
      let note: string;
      try {
        // A draft's quick actions run when it is published, as the account that publishes it;
        // pinned to a line, it is a diff note, posted as written (its suggestions are what "Apply
        // suggestion" commits) or refused.
        note = inertToQuickActions(c.body, { suggestions: true });
      } catch (err) {
        if (!(err instanceof ForgeApiError)) throw err;
        // Name the remark a refusal is about: a review can carry many.
        throw new ForgeApiError(`remark ${i + 1} (${c.path}:${c.line}): ${err.message}`, true);
      }
      positioned.push({
        note,
        position: {
          position_type: "text",
          ...refs,
          old_path: file.oldPath || file.newPath,
          new_path: file.newPath,
          ...lines,
        },
      });
    });
  }
  if (params.body.trim() !== "") {
    positioned.push({ note: inertToQuickActions(params.body, { suggestions: false }) });
  }
  if (positioned.length === 0) return { url };

  const made: number[] = [];
  try {
    for (const draft of positioned) {
      const res = await ctx.client.call("POST", drafts, draft);
      if ((res.status !== 200 && res.status !== 201) || typeof res.body?.id !== "number") {
        throw ctx.client.refusal(`drafting a review note on !${thread.iid}`, res);
      }
      made.push(res.body.id);
    }
    // Only what this call drafted is published, one by one, each its own note in the order
    // published (verified on GitLab 17.11, 204 each). Never `bulk_publish`: it publishes every
    // pending draft of the account on this merge request — in bot mode another review's, being
    // drafted at this moment under the same token, and in user mode the person's own.
    for (const id of made.slice()) {
      const res = await ctx.client.call("PUT", `${drafts}/${id}/publish`);
      if (res.status !== 204 && res.status !== 200) {
        throw ctx.client.refusal(`publishing the review on !${thread.iid}`, res);
      }
      made.splice(made.indexOf(id), 1);
    }
  } catch (err) {
    // Whatever this call drafted and did not publish goes; a note already published stands,
    // as it would have on GitHub's partial failure.
    await deleteDrafts(ctx, drafts, made);
    throw err;
  }
  return { url };
}

async function deleteDrafts(ctx: GitlabContext, drafts: string, ids: number[]): Promise<void> {
  for (const id of ids) {
    try {
      const res = await ctx.client.call("DELETE", `${drafts}/${id}`);
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
        ctx.diag.warn("gitlab.draft_left", { id, status: res.status });
      }
    } catch (err) {
      ctx.diag.warn("gitlab.draft_left", { id, err: String(err) });
    }
  }
}

/** A diff note's handle, held to be on merge request `thread` — terminal otherwise. */
function discussionOn(thread: GitlabThread, commentId: string): string {
  const handle = parseNoteHandle(commentId);
  if (handle === null || handle.discussionId === null) {
    throw new ForgeApiError(
      `${JSON.stringify(commentId)} is not a GitLab review comment (mr-<iid>:<discussion>:<note>)`,
      true,
    );
  }
  if (handle.thread.ref !== thread.ref) {
    throw new ForgeApiError(
      `review comment ${commentId} is not on !${thread.iid} (it is on ${
        handle.thread.kind === "issue" ? "#" : "!"
      }${handle.thread.iid})`,
      true,
    );
  }
  return handle.discussionId;
}

export async function replyToReviewComment(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
  commentId: string,
  body: string,
): Promise<{ url: string }> {
  const project = ctx.project(repo);
  const thread = await mergeRequestOf(ctx, repo, ref);
  const discussion = discussionOn(thread, commentId);
  const res = await ctx.client.call(
    "POST",
    `/projects/${project}/merge_requests/${thread.iid}/discussions/${discussion}/notes`,
    // A reply in a diff note's discussion is a diff note too: posted as written, or refused.
    { body: inertToQuickActions(body, { suggestions: true }) },
  );
  if (res.status === 202) {
    // Taken as quick actions only: carried out, no note stored. Asking again would act again.
    throw new ForgeApiError(
      `GitLab read the reply on !${thread.iid} as quick actions only and posted no note`,
      true,
    );
  }
  if (res.status !== 201 || typeof res.body?.id !== "number") {
    throw res.status === 404
      ? new ForgeApiError(`!${thread.iid} has no review thread ${discussion}`, true)
      : ctx.client.refusal(`replying to review comment ${commentId}`, res);
  }
  return { url: `${ctx.threadUrl(repo, thread)}#note_${res.body.id}` };
}

export async function resolveReviewThread(
  ctx: GitlabContext,
  repo: ForgeRepo,
  ref: string,
  commentId: string,
): Promise<void> {
  const project = ctx.project(repo);
  const thread = await mergeRequestOf(ctx, repo, ref);
  const discussion = discussionOn(thread, commentId);
  // Resolving a resolved discussion is a 200 that changes nothing: a blind retry is safe.
  const res = await ctx.client.call(
    "PUT",
    `/projects/${project}/merge_requests/${thread.iid}/discussions/${discussion}?resolved=true`,
  );
  if (res.status !== 200) {
    throw res.status === 404
      ? new ForgeApiError(`!${thread.iid} has no review thread ${discussion}`, true)
      : ctx.client.refusal(`resolving review thread ${discussion}`, res);
  }
}
