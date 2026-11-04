// What the GitLab webhook consumer asks GitLab before it says anything: the ground truth a
// delivery only rings the bell for.
//
// A hook's token is shown to the project's Maintainers, so whatever a delivery's body says —
// who wrote a note, what it says, whose merge request it is, which head it carries, which
// project it is about — is a Maintainer's word, not GitLab's. The only facts this side takes
// from a delivery are the project its token was verified for and the handles it names (a note
// id, an iid, a discussion id); everything an event carries is read back here, with the bot's
// token, under that verified project — a handle that names nothing there reads as gone.
//
// Invariants:
// - every path is built from the verified project id and digits-only (or 40-hex) handles; no
//   payload text ever reaches a URL
// - GitLab's 404, 403 and 410 are a permanent "no such thing here" — `null`, which the consumer
//   consumes terminally; anything else that is not a 200 throws, and is retried
// - the client is the adapter's (`gitlab_client.ts`): `Authorization: Bearer`, which a personal
//   and an OAuth token both take, the token presented to the instance's origin only, and a 401
//   retried once on a refreshed token

import type { GitlabClient } from "./gitlab_client.ts";

/** The project as GitLab answers it now: the path it lives at, the URL it is fetched from. */
export interface GitlabHookProject {
  id: string;
  pathWithNamespace: string;
  /** `http_url_to_repo`. */
  url: string;
  /** Null for an empty project. */
  defaultBranch: string | null;
}

/** A GitLab account, as a note's author or a merge request's is answered. */
export interface GitlabHookUser {
  id: string;
  username: string;
}

/** A note on an issue or a merge request, as GitLab holds it. */
export interface GitlabHookNote {
  id: string;
  body: string;
  author: GitlabHookUser;
  system: boolean;
  /** An internal note (`internal`, formerly `confidential`): visible to project members only. */
  internal: boolean;
  /** "DiffNote" for a remark on a line of the diff; "DiscussionNote", null otherwise. */
  type: string | null;
  /** When it was written, as GitLab says (ISO 8601) — how a replay of an old note is told
   * from a fresh one. */
  createdAt: string;
}

/** A merge request, as GitLab holds it. */
export interface GitlabHookMergeRequest {
  iid: string;
  /** `opened`, `closed`, `merged` — or `locked`, a merge in progress. */
  state: string;
  /** The head as it stands — after a merge, the head that merged, never the merge commit. */
  headSha: string;
  targetBranch: string;
  author: GitlabHookUser;
  /** Who merged or closed it, where GitLab says. */
  endedBy: GitlabHookUser | null;
  webUrl: string | null;
  /** When it last changed, as GitLab says (ISO 8601): every push, retarget, close, reopen and
   * merge moves it. With the state and head, what names a delivery about it — a sender can ring
   * for a merge request as often as it likes, but cannot move this without changing it. */
  updatedAt: string;
}

/** What the consumer reads; each answer null where GitLab says there is no such thing. */
export interface GitlabHookReads {
  project(projectId: string): Promise<GitlabHookProject | null>;
  note(
    projectId: string,
    on: { kind: "issue" | "merge_request"; iid: string },
    noteId: string,
  ): Promise<GitlabHookNote | null>;
  /** Whether that discussion of the merge request holds that note — false where it does not,
   * or the discussion is gone. */
  discussionHolds(
    projectId: string,
    mrIid: string,
    discussionId: string,
    noteId: string,
  ): Promise<boolean>;
  /** Whether the issue is confidential; null when it is gone. */
  issueConfidential(projectId: string, iid: string): Promise<boolean | null>;
  mergeRequest(projectId: string, iid: string): Promise<GitlabHookMergeRequest | null>;
  /** The commit a branch points at now; null when there is no such branch. */
  branchHead(projectId: string, branch: string): Promise<string | null>;
}

const DIGITS = /^[0-9]{1,20}$/;
const DISCUSSION = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** GitLab's "there is nothing here for you": consumed, never retried. */
const GONE = new Set([403, 404, 410]);

// oxlint-disable-next-line no-explicit-any
function userOf(raw: any): GitlabHookUser | null {
  if (typeof raw?.id !== "number" || typeof raw.username !== "string" || raw.username === "") {
    return null;
  }
  return { id: String(raw.id), username: raw.username };
}

export function gitlabHookReads(client: GitlabClient): GitlabHookReads {
  /** One GET: the body on a 200, null on a permanent no, a throw for everything else. */
  const get = async (what: string, path: string) => {
    const res = await client.call("GET", path);
    if (res.status === 200) return res.body;
    if (GONE.has(res.status)) return null;
    throw client.refusal(what, res);
  };
  const malformed = (what: string): never => {
    throw new Error(`GitLab's answer for ${what} is missing fields`);
  };
  const ids = (...values: string[]) => {
    for (const v of values) {
      if (!DIGITS.test(v)) throw new Error(`not a GitLab id: ${JSON.stringify(v)}`);
    }
  };

  return {
    async project(projectId) {
      ids(projectId);
      const p = await get("reading the project", `/projects/${projectId}`);
      if (p === null) return null;
      if (
        String(p.id) !== projectId || typeof p.path_with_namespace !== "string" ||
        typeof p.http_url_to_repo !== "string"
      ) {
        return malformed(`project ${projectId}`);
      }
      return {
        id: projectId,
        pathWithNamespace: p.path_with_namespace,
        url: p.http_url_to_repo,
        defaultBranch: typeof p.default_branch === "string" && p.default_branch !== ""
          ? p.default_branch
          : null,
      };
    },

    async note(projectId, on, noteId) {
      ids(projectId, on.iid, noteId);
      const kind = on.kind === "issue" ? "issues" : "merge_requests";
      const n = await get(
        "reading the note",
        `/projects/${projectId}/${kind}/${on.iid}/notes/${noteId}`,
      );
      if (n === null) return null;
      const author = userOf(n.author);
      if (
        String(n.id) !== noteId || typeof n.body !== "string" || author === null ||
        typeof n.created_at !== "string" || Number.isNaN(Date.parse(n.created_at))
      ) {
        return malformed(`note ${noteId}`);
      }
      return {
        id: noteId,
        body: n.body,
        author,
        system: n.system === true,
        // `confidential` is the field's name before GitLab 15.0 and its alias since; either set
        // is a note the project's members alone may read.
        internal: n.internal === true || n.confidential === true,
        type: typeof n.type === "string" ? n.type : null,
        createdAt: new Date(n.created_at).toISOString(),
      };
    },

    async discussionHolds(projectId, mrIid, discussionId, noteId) {
      ids(projectId, mrIid, noteId);
      if (!DISCUSSION.test(discussionId)) return false;
      const d = await get(
        "reading the discussion",
        `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      );
      if (d === null || !Array.isArray(d.notes)) return false;
      return d.notes.some((n: { id?: unknown }) => String(n?.id) === noteId);
    },

    async issueConfidential(projectId, iid) {
      ids(projectId, iid);
      const i = await get("reading the issue", `/projects/${projectId}/issues/${iid}`);
      if (i === null) return null;
      if (typeof i.confidential !== "boolean") return malformed(`issue ${iid}`);
      return i.confidential;
    },

    async mergeRequest(projectId, iid) {
      ids(projectId, iid);
      const m = await get(
        "reading the merge request",
        `/projects/${projectId}/merge_requests/${iid}`,
      );
      if (m === null) return null;
      const author = userOf(m.author);
      if (
        String(m.iid) !== iid || typeof m.state !== "string" || typeof m.sha !== "string" ||
        !SHA.test(m.sha) || typeof m.target_branch !== "string" || author === null ||
        typeof m.updated_at !== "string" || Number.isNaN(Date.parse(m.updated_at))
      ) {
        return malformed(`merge request !${iid}`);
      }
      return {
        iid,
        state: m.state,
        headSha: m.sha,
        targetBranch: m.target_branch,
        author,
        endedBy: m.state === "merged"
          ? userOf(m.merge_user) ?? userOf(m.merged_by)
          : m.state === "closed"
          ? userOf(m.closed_by)
          : null,
        webUrl: typeof m.web_url === "string" ? m.web_url : null,
        updatedAt: new Date(m.updated_at).toISOString(),
      };
    },

    async branchHead(projectId, branch) {
      ids(projectId);
      const b = await get(
        "reading the branch",
        `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
      );
      if (b === null) return null;
      const sha = b.commit?.id;
      if (typeof sha !== "string" || !SHA.test(sha)) return malformed(`branch ${branch}`);
      return sha;
    },
  };
}

/** How many GitLab calls the bot makes a minute for webhook deliveries, across every project:
 * the consumer's reads and the control plane's handling of what it forwards. */
export const GITLAB_HOOK_READS_PER_MINUTE = 600;

/**
 * One delivery's share of the budget, set aside whole before the mailroom claims the delivery
 * (`HookBudget.reserve`): the most it can spend, of which `take` spends a call at a time and
 * `release` gives back whatever was not spent. The mailroom's `DeliveryTicket`.
 */
export class HookReservation {
  #used = 0;
  #released = false;
  constructor(
    readonly reserved: number,
    readonly onTake: (n: number) => void,
    readonly onRelease: (unused: number) => void,
  ) {}
  /** Spends `n` of what was set aside — throws past it, which only an `eventCost` or a read
   * count out of step with `hookCostAtMost` reaches, and which is retried like GitLab not
   * answering: the budget stays a cap. */
  take(n = 1): void {
    if (this.#released || this.#used + n > this.reserved) {
      throw new Error(
        `a delivery spent past its reservation of ${this.reserved} GitLab calls`,
      );
    }
    this.#used += n;
    this.onTake(n);
  }
  get used(): number {
    return this.#used;
  }
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.onRelease(this.reserved - this.#used);
  }
}

export interface HookBudget {
  /**
   * Sets aside `cost` calls for one delivery of `scope` (a project id), or answers `null`: not
   * now. Never waits.
   */
  reserve(scope: string, cost: number): HookReservation | null;
}

export interface HookBudgetOptions {
  perMinute: number;
  now(): number;
}

/** How long a project's spend counts toward its place: halved every minute. */
const USAGE_HALF_LIFE_MS = 60_000;
/** How long a refused project is held a place for without asking again. The mailroom asks a
 * refused head again at its first scan a second after (every couple of seconds), so only a queue
 * that drained, or stopped being swept, lapses. */
const WAITER_TTL_MS = 60_000;
/** How often lapsed places are looked for. */
const LAPSE_EVERY_MS = 1_000;
/** How often the spend of projects long quiet is forgotten. */
const FORGET_EVERY_MS = 5 * 60_000;
/** A spend below this (log2) is nothing: its project is forgotten. */
const FORGOTTEN = Math.log2(0.01);

/** A refused project's place in line: its rank (spend) when refused, since when it waits, what
 * its head needs, when it last asked. */
interface Waiter {
  rank: number;
  since: number;
  need: number;
  seen: number;
}

/**
 * The bot's GitLab calls on behalf of webhook deliveries, across every project: at most
 * `perMinute` a minute (a bucket that holds a minute's worth and refills evenly), shared fairly.
 * What deliveries in flight set aside and have not spent yet counts as in the bucket: in any
 * interval of length L, at most a bucket plus L's refill is spent, however long a delivery holds
 * its reservation.
 *
 * - Whole, up front. A delivery reserves the most it can spend — its reads and the control
 *   plane's handling of the event it forwards (`hookCostAtMost` in gitlab_webhooks.ts) — before
 *   the mailroom claims it, and gives back what it did not spend once it is over. Nothing is
 *   spent in pieces, so a delivery is never refused halfway, after paying for its first reads,
 *   and a cheap ring weighs what an expensive one does while it is in flight.
 * - Refused, never waited for, and no attempt spent. Past the bucket the mailroom leaves the
 *   delivery pending, as it was, and asks again at a later scan (`admitDelivery`): the consumer
 *   runs in one of the GitLab mailbox's few drains, and a wait there held every other project's
 *   deliveries behind it; a refusal counted as a failed delivery let a flood elsewhere burn a
 *   waiting command's retries away.
 * - One line, least-spent first, and nothing else. Each project's spend is remembered, halving
 *   every minute. A refused project waits in line in order of that spend (as little: refused
 *   first), and every project ahead of another holds back exactly what its head needs from the
 *   other's reservation — so tokens refilling go to the quietest project first, and a project
 *   that floods, or many one token holder floods together, only ever spends what everyone
 *   quieter leaves. Every kind of delivery waits in the same line by the same rule: a project's
 *   deliveries are one queue, in order, so a rule for one kind (a share kept for notes, once)
 *   held a quiet project's push back for good under a flood of other projects' notes, and its
 *   `/ryph` note behind the push with it. Notes are kept apart from merge request churn at the
 *   door instead, where each kind has a budget of its own per project.
 *
 * What a delivery of project Q waits for, then: the needs of the projects that had spent less
 * than Q when it was refused — each at most what it was short of Q's spend plus one delivery,
 * since spending is what moves a project back — and the refill of its own. A project that floods
 * has spent more than a quiet one and is never ahead of it.
 */
export function hookBudget(opts: HookBudgetOptions): HookBudget {
  const cap = opts.perMinute;
  const ratePerMs = cap / 60_000;
  let tokens = cap;
  // Set aside by deliveries in flight and not spent yet. The bucket refills only up to what they
  // leave of the cap: a delivery holding its reservation through a GitLab that hangs spends it
  // after the bucket refilled, and counted apart, the two together passed the cap.
  let held = 0;
  let at = opts.now();
  // A project's decayed spend as a RANK: log2(spend) + t / half-life, the same at every t. Every
  // project's spend halves at the same pace, so ranks move only when a project spends, and the
  // line stays in order as time passes. Absent (-Infinity): nothing spent.
  const ranks = new Map<string, number>();
  const waiting = new Map<string, Waiter>();
  // The line: `waiting` in order, and for each place the needs of everyone before it — summed
  // again only once someone joined, left or moved, not on every refusal, which every scan asks of
  // every waiting project.
  const line: Waiter[] = [];
  let before: number[] = [0];
  let summed = true;
  let lapsedAt = at;
  let forgotAt = at;

  const clock = (now: number) => now / USAGE_HALF_LIFE_MS;
  const rankOf = (scope: string) => ranks.get(scope) ?? -Infinity;
  const ahead = (a: Pick<Waiter, "rank" | "since">, b: Pick<Waiter, "rank" | "since">) =>
    a.rank < b.rank || (a.rank === b.rank && a.since < b.since);
  /** How many in line are ahead of `me`. */
  const placeOf = (me: Pick<Waiter, "rank" | "since">) => {
    let lo = 0;
    let hi = line.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ahead(line[mid], me)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const join = (scope: string, w: Waiter) => {
    waiting.set(scope, w);
    line.splice(placeOf(w), 0, w);
    summed = false;
  };
  const leave = (scope: string, w: Waiter) => {
    waiting.delete(scope);
    let i = placeOf(w);
    while (line[i] !== w) i++;
    line.splice(i, 1);
    summed = false;
  };
  /** What everyone in line ahead of `me` needs. */
  const heldFor = (me: Pick<Waiter, "rank" | "since">) => {
    if (!summed) {
      before = [0];
      for (const w of line) before.push(before[before.length - 1] + w.need);
      summed = true;
    }
    return before[placeOf(me)];
  };
  const charge = (scope: string, n: number) => {
    const now = opts.now();
    // Refilled up to now under what was held until now — the refill is lazy, and computed after
    // the spend it would count the whole gap as if nothing had been held.
    refill(now);
    held -= n;
    const rank = Math.log2(2 ** (rankOf(scope) - clock(now)) + n) + clock(now);
    ranks.set(scope, rank);
    const w = waiting.get(scope);
    if (w !== undefined) {
      leave(scope, w);
      join(scope, { ...w, rank });
    }
  };
  const refill = (now: number) => {
    tokens = Math.max(tokens, Math.min(cap - held, tokens + (now - at) * ratePerMs));
    at = now;
  };
  const tidy = (now: number) => {
    if (now - lapsedAt >= LAPSE_EVERY_MS) {
      lapsedAt = now;
      for (const [scope, w] of waiting) if (now - w.seen > WAITER_TTL_MS) leave(scope, w);
    }
    if (now - forgotAt >= FORGET_EVERY_MS) {
      forgotAt = now;
      for (const [scope, rank] of ranks) {
        if (!waiting.has(scope) && rank - clock(now) < FORGOTTEN) ranks.delete(scope);
      }
    }
  };

  return {
    reserve(scope, cost) {
      const now = opts.now();
      refill(now);
      tidy(now);
      const w = waiting.get(scope);
      const me = { rank: rankOf(scope), since: w?.since ?? now };
      if (tokens - heldFor(me) < cost) {
        if (w === undefined) join(scope, { ...me, need: cost, seen: now });
        else {
          w.seen = now;
          if (w.need !== cost) {
            w.need = cost;
            summed = false;
          }
        }
        return null;
      }
      if (w !== undefined) leave(scope, w);
      tokens -= cost;
      held += cost;
      return new HookReservation(
        cost,
        (n) => charge(scope, n),
        (unused) => {
          refill(opts.now());
          held -= unused;
          tokens += unused;
        },
      );
    },
  };
}

/**
 * `reads`, each spending one call of `reservation` — a delivery's share of the budget every
 * project's deliveries spend (`hookBudget`).
 *
 * Each project's door spends a delivery budget of its own (`GITLAB_HOOK_RATE_LIMIT`), and every
 * delivery stored costs reads; the budget is the cap over all of them together, so the projects
 * one token holder maintains, or many, cannot make the bot spend the API rate limit its runs, its
 * tools and every other project share, nor starve another project's deliveries of it.
 */
export function reservedHookReads(
  reads: GitlabHookReads,
  reservation: HookReservation,
): GitlabHookReads {
  /** One call of the reservation, then the read — or, past it, a rejection and no read. */
  const spend = <T>(read: () => Promise<T>): Promise<T> => {
    try {
      reservation.take(1);
    } catch (err) {
      return Promise.reject(err);
    }
    return read();
  };
  return {
    project: (...args) => spend(() => reads.project(...args)),
    note: (...args) => spend(() => reads.note(...args)),
    discussionHolds: (...args) => spend(() => reads.discussionHolds(...args)),
    issueConfidential: (...args) => spend(() => reads.issueConfidential(...args)),
    mergeRequest: (...args) => spend(() => reads.mergeRequest(...args)),
    branchHead: (...args) => spend(() => reads.branchHead(...args)),
  };
}
