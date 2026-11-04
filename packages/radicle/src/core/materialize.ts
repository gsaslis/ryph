// `rad cob show` JSON → the shapes in core/types.ts.
//
// Everything here is a pure function over JSON somebody else produced, so it is written
// defensively: a field that is missing or the wrong type degrades to a default rather than
// throwing. A materialization the bridge cannot fully read should still answer with the parts
// it can — a COB carrying a future action type must not 500 a `GET`.
//
// The five dialect corrections, each measured against rad 1.10.2:
// - AUTHORS come as a bare public key (`z6Mk…`) inside a thread and as `{"id":"did:key:z6Mk…"}`
//   on a patch. Both become a DID here.
// - TIMESTAMPS are epoch MILLISECONDS. They become ISO strings.
// - COMMENTS live in `{comments: {<id>: …}, timeline: [<id>…]}`, where `timeline` also lists op
//   ids that are not comments (a reaction, an edit). The order comes from `timeline`, the
//   content from `comments`, and ids in one but not the other are dropped.
// - a comment's `body` is already the latest edit; `edits` is the history, and its LAST entry's
//   timestamp is what "edited at" means.
// - REVIEWS are keyed by the author's NID inside a revision — Radicle allows exactly one review
//   per author per revision, which is why `submit_review` on a second call has to edit.

import type {
  Actor,
  ChangeState,
  ChangeView,
  CommentLocation,
  CommentView,
  EmbedView,
  IssueView,
  ReviewView,
  RevisionView,
} from "./types.ts";

type Json = Record<string, unknown>;

const obj = (
  value: unknown,
): Json => (typeof value === "object" && value !== null ? value as Json : {});
const str = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Epoch milliseconds → ISO. A timestamp we cannot read becomes the epoch, never `Invalid Date`. */
export function isoOf(value: unknown): string {
  const ms = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return new Date(ms).toISOString();
}

/** `z6Mk…` or `did:key:z6Mk…` → `did:key:z6Mk…`. */
export function toDid(value: unknown): string {
  const raw = typeof value === "string" ? value : str((obj(value) as { id?: unknown }).id, "");
  if (raw === "") return "";
  return raw.startsWith("did:key:") ? raw : `did:key:${raw}`;
}

/** `did:key:z6Mk…` → `z6Mk…`, the form storage refs and the control socket use. */
export function toNid(did: string): string {
  return did.startsWith("did:key:") ? did.slice("did:key:".length) : did;
}

function actorOf(value: unknown): Actor {
  return { did: toDid(value) };
}

function reactionsOf(value: unknown): string[] {
  // `[[nid, emoji], …]` in rad 1.10.2; an object form is tolerated for a future shape.
  const out: string[] = [];
  for (const entry of arr(value)) {
    const emoji = Array.isArray(entry)
      ? str(entry[1])
      : str((obj(entry) as { reaction?: unknown }).reaction);
    if (emoji !== "" && !out.includes(emoji)) out.push(emoji);
  }
  return out;
}

/**
 * `[{name, content: "git:<oid>"}]` → `EmbedView[]`. heartwood writes `content` as a `Uri`, and
 * `git:` + a full oid is the only kind it stores (`Embed::store`); anything else names no blob
 * this bridge could serve, and is dropped.
 */
export function embedsOf(value: unknown): EmbedView[] {
  const out: EmbedView[] = [];
  for (const raw of arr(value)) {
    const e = obj(raw);
    const oid = str(e.content).match(/^git:([0-9a-f]{40})$/)?.[1];
    if (oid === undefined) continue;
    out.push({ name: str(e.name).slice(0, 255), oid });
  }
  return out;
}

function locationOf(value: unknown): CommentLocation | undefined {
  const loc = obj(value);
  const path = str(loc.path);
  if (path === "") return undefined;
  const newRange = obj(loc.new);
  const oldRange = obj(loc.old);
  const side: "old" | "new" = loc.new === null || loc.new === undefined ? "old" : "new";
  const range = obj((side === "new" ? newRange : oldRange).range);
  const start = typeof range.start === "number" ? range.start : null;
  return {
    path,
    commit: str(loc.commit),
    // Half-open over 1-based line numbers, as git numbers a hunk: `1..2` is the first line.
    line: start,
    side,
  };
}

/** One `{comments, timeline}` thread, flattened and ordered. */
export function flattenThread(
  thread: unknown,
  extra: { revision?: string } = {},
): CommentView[] {
  const t = obj(thread);
  const comments = obj(t.comments);
  const order = arr(t.timeline).filter((id): id is string => typeof id === "string");
  // `timeline` is authoritative for ORDER but is not a superset in every version; anything in
  // the map that the timeline forgot is appended rather than dropped.
  const ids = [...order.filter((id) => id in comments)];
  for (const id of Object.keys(comments)) if (!ids.includes(id)) ids.push(id);

  return ids.map((id) => {
    const c = obj(comments[id]);
    const edits = arr(c.edits).map(obj);
    const first = edits[0] ?? {};
    const last = edits[edits.length - 1] ?? {};
    const view: CommentView = {
      id,
      author: actorOf(c.author),
      body: str(c.body, str(last.body)),
      createdAt: isoOf(first.timestamp),
      editedAt: edits.length > 1 ? isoOf(last.timestamp) : null,
      replyTo: typeof c.replyTo === "string" ? c.replyTo : null,
      reactions: reactionsOf(c.reactions),
    };
    if (extra.revision !== undefined) view.revision = extra.revision;
    const location = locationOf(c.location);
    if (location !== undefined) view.location = location;
    // The comment's own `embeds` is its latest edit's (heartwood serializes it only when
    // non-empty); the last edit's are the fallback for a shape that left it off.
    const embeds = embedsOf(c.embeds ?? last.embeds);
    if (embeds.length > 0) view.embeds = embeds;
    return view;
  });
}

/** The materialized issue COB → `IssueView`. */
export function materializeIssue(id: string, cob: unknown): IssueView {
  const c = obj(cob);
  const state = obj(c.state);
  const comments = flattenThread(c.thread);
  const root = comments[0];
  return {
    id,
    title: str(c.title),
    // An issue COB carries no author of its own: it is whoever opened the thread.
    author: root?.author ?? { did: "" },
    state: str(state.status, "open") === "closed" ? "closed" : "open",
    closeReason: str(state.status) === "closed" ? str(state.reason, "other") : null,
    labels: arr(c.labels).filter((l): l is string => typeof l === "string"),
    assignees: arr(c.assignees).map(toDid).filter((d) => d !== ""),
    createdAt: root?.createdAt ?? isoOf(0),
    updatedAt: comments[comments.length - 1]?.createdAt ?? root?.createdAt ?? isoOf(0),
    body: root?.body ?? "",
    comments,
  };
}

function reviewsOfRevision(revisionId: string, revision: Json): ReviewView[] {
  return Object.values(obj(revision.reviews)).map((raw) => {
    const r = obj(raw);
    const summaryEdits = arr(r.summary).map(obj);
    const summary = summaryEdits[summaryEdits.length - 1];
    const verdict = str(r.verdict);
    const embeds = embedsOf(summary?.embeds);
    return {
      id: str(r.id),
      author: actorOf(r.author),
      revision: revisionId,
      verdict: verdict === "accept" || verdict === "reject" ? verdict : null,
      summary: summary === undefined ? null : str(summary.body),
      ...(embeds.length > 0 ? { summaryEmbeds: embeds } : {}),
      createdAt: isoOf(r.timestamp),
      comments: flattenThread(r.comments, { revision: revisionId }),
    };
  });
}

/**
 * A change request's latest revision as heartwood means it (`Patch::latest`): the latest one BY
 * ITS AUTHOR. Anyone may add a revision to anyone's change request, so the newest overall is
 * whoever pushed last — a stranger's proposal on top, not the change request itself. Falls back
 * to the newest overall only when the author has none left (every one redacted).
 */
export function latestByAuthor<R extends { author: Actor }>(
  revisions: R[],
  authorDid: string,
): R | undefined {
  for (let i = revisions.length - 1; i >= 0; i--) {
    if (revisions[i].author.did === authorDid) return revisions[i];
  }
  return revisions[revisions.length - 1];
}

/** The latest revision of a materialized change request by the rule above — the one its
 * `authorHead` names. */
export const latestRevision = (change: ChangeView): RevisionView | undefined =>
  latestByAuthor(change.revisions, change.author.did);

/** The most merged heads one merge event names: what the forge's event schema and its
 * containment read accept. */
export const MAX_MERGED_HEADS = 20;

/**
 * What a merged change request merged: the revision and commit its state settled on, or — for a
 * state that names none, which heartwood never writes for a merge — every merge a delegate
 * recorded, each one heartwood checked is in that delegate's default branch. Deduplicated by
 * commit, newest merge first, and at most `MAX_MERGED_HEADS` of them: a reader asking whether
 * some commit merged takes ANY of them, and the newest are the likeliest to hold the most.
 * Empty unless merged.
 */
export function mergedHeadsOf(change: ChangeView): Array<{ revision: string; commit: string }> {
  if (change.state !== "merged") return [];
  if (change.mergedRevision !== null) return [change.mergedRevision];
  const heads = new Map<string, { revision: string; commit: string }>();
  const newestFirst = [...change.merges].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const m of newestFirst) {
    if (m.commit !== "" && !heads.has(m.commit)) {
      heads.set(m.commit, { revision: m.revision, commit: m.commit });
    }
  }
  return [...heads.values()].slice(0, MAX_MERGED_HEADS);
}

/** The materialized patch COB → `ChangeView`, minus `files` (which needs git; see the service). */
export function materializeChange(id: string, cob: unknown): ChangeView {
  const c = obj(cob);
  const state = obj(c.state);
  const status = str(state.status, "open");
  const changeState: ChangeState = status === "merged" || status === "archived" ||
      status === "draft"
    ? status
    : "open";

  const order = arr(c.timeline).filter((t): t is string => typeof t === "string");
  const rawRevisions = obj(c.revisions);
  // Revisions are a map; `timeline` puts them (and everything else) in order.
  const revisionIds = order.filter((t) => t in rawRevisions);
  for (const key of Object.keys(rawRevisions)) {
    if (!revisionIds.includes(key)) revisionIds.push(key);
  }

  const revisions: RevisionView[] = [];
  const reviews: ReviewView[] = [];
  const comments: CommentView[] = [];
  for (const revisionId of revisionIds) {
    const r = obj(rawRevisions[revisionId]);
    const description = arr(r.description).map(obj);
    const embeds = embedsOf(description[description.length - 1]?.embeds);
    revisions.push({
      id: revisionId,
      base: str(r.base),
      head: str(r.oid),
      description: str(description[description.length - 1]?.body),
      timestamp: isoOf(r.timestamp),
      author: actorOf(r.author),
      ...(embeds.length > 0 ? { embeds } : {}),
    });
    reviews.push(...reviewsOfRevision(revisionId, r));
    comments.push(...flattenThread(r.discussion, { revision: revisionId }));
  }

  const author = actorOf(c.author);
  const latest = revisions[revisions.length - 1];
  const authorLatest = latestByAuthor(revisions, author.did);
  const merges = Object.entries(obj(c.merges)).map(([nid, raw]) => {
    const m = obj(raw);
    return {
      did: toDid(nid),
      revision: str(m.revision),
      commit: str(m.commit),
      timestamp: isoOf(m.timestamp),
    };
  });

  const timestamps = [
    ...revisions.map((r) => r.timestamp),
    ...comments.map((c2) => c2.createdAt),
    ...reviews.map((r) => r.createdAt),
    ...merges.map((m) => m.timestamp),
  ].sort();

  return {
    id,
    title: str(c.title),
    author,
    state: changeState,
    labels: arr(c.labels).filter((l): l is string => typeof l === "string"),
    assignees: arr(c.assignees).map(toDid).filter((d) => d !== ""),
    createdAt: revisions[0]?.timestamp ?? isoOf(0),
    updatedAt: timestamps[timestamps.length - 1] ?? isoOf(0),
    target: str(c.target, "delegates"),
    base: latest?.base ?? "",
    head: latest?.head ?? "",
    authorHead: authorLatest?.head ?? "",
    description: revisions[0]?.description ?? "",
    revisions,
    reviews,
    comments,
    merges,
    mergedRevision: changeState === "merged" && str(state.revision) !== "" &&
        str(state.commit) !== ""
      ? { revision: str(state.revision), commit: str(state.commit) }
      : null,
    files: null,
  };
}

/**
 * The review this author already left on this revision, if any — read from the COB's own
 * `reviews` index (`{<reviewId>: [<revisionId>, <authorNid>]}`), which exists for exactly this
 * question. Radicle permits one review per author per revision, so a second `submit_review`
 * has to edit this one instead of creating another.
 */
export function existingReviewId(cob: unknown, revisionId: string, nid: string): string | null {
  for (const [reviewId, entry] of Object.entries(obj(obj(cob).reviews))) {
    if (!Array.isArray(entry)) continue;
    if (entry[0] === revisionId && toNid(str(entry[1])) === nid) return reviewId;
  }
  return null;
}
