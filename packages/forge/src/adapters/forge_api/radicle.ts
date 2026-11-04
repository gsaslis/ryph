// `ForgeApi` on Radicle, over this deployment's own bridge (@ryph/radicle) — plain fetch, one
// shared bearer, no SDK, exactly as the GitHub adapter does it.
//
// The shape of the difference, in one paragraph. Radicle has no API and no tokens: every write
// is a signed git object made by a node that runs beside us, and `RYPH_RADICLE_URL` is where
// that node's bridge listens. So there is no tenant — `ForgeRepo.tenantId` is null for every
// Radicle repo and this file never reads it — and no credential to mint per call: the one
// bearer is the deployment's, and the network is the boundary.
//
// Invariants:
// - a repo's address is a RID and nothing else. `rad:z…`, checked here, because every path
//   below interpolates it into a URL
// - the two permission tiers are DIFFERENT questions, both read live from the identity
//   document: `admin` is delegacy, `write` is visibility — permissionless on a public repo,
//   the `allow` set on a private one. Who may COMMAND agents here is neither, and is the
//   ORCHESTRATOR's to decide, never this file's business
// - a capability the deployment's key does not hold (labels, closing somebody else's issue)
//   comes back as a TERMINAL, agent-readable refusal — the bridge types it as a 403
//   `forge_capability_unavailable` for exactly this — and never as a 500 to retry
// - `findMarkedWrite` reads the object the write hangs on: see the note on it
// - a body's images travel WITH the write, as bytes the bridge stores as the COB's embeds; the
//   body already links each by its blob id (core/images.ts), so a write and its files are one op
// - the bridge base is injectable so tests run against a fake bridge — never mock fetch

import type { Permission } from "../../core/types.ts";
import {
  type BodyEmbed,
  type ChangeCommit,
  type ChangedFile,
  type ChangeListing,
  type ChangeRequestHead,
  type CheckReport,
  type CheckRun,
  checkSeverity,
  type ChecksReport,
  type ForgeApi,
  ForgeApiError,
  type ForgeRepo,
  type IssueListing,
  type ReportChecksOutcome,
  type RepoVisibility,
  type ThreadContext,
  type ThreadEntry,
  type ThreadRef,
  wholeRepoVisibility,
} from "../../ports/forge_api.ts";
import type {
  RadicleBridgeApi,
  RadicleBridgeMode,
  RadicleIdentity,
  RadicleRepoInfo,
  RadicleSeedOutcome,
} from "../../ports/radicle_bridge.ts";
import type { FetchAuth } from "../../ports/repo_cache.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  attachThreadImages,
  type ImageSlot,
  MAX_ENTRY_ID,
  MAX_SLOTS_PER_ENTRY,
} from "../../core/thread_images.ts";
import {
  IMAGE_TIMEOUT_MS,
  imageOf,
  type ImageOutcome,
  MAX_THREAD_IMAGE_BYTES,
} from "../../helpers/image_download.ts";

/** A full commit id — SHA-1, or SHA-256 for a repository that uses it. */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The most merged heads a read names — `MergeContainmentRequestSchema`'s bound. */
const MAX_MERGED_HEADS = 20;

export interface RadicleForgeApiOptions {
  /** `RYPH_RADICLE_URL` — where the bridge beside our node listens. */
  baseUrl: string;
  /** `RYPH_RADICLE_TOKEN` — the one credential the whole bridge surface takes. */
  token: string;
  /**
   * `RYPH_RADICLE_EXPLORER_URL` — a template with `{rid}`, `{kind}` and `{id}`, for the web
   * address of an issue or a change request. Null (the default) is a real answer: a private
   * Radicle network has no explorer, and then a thread's address is its id and there is no URL
   * to invent. Answers are `""` in that case, never a fabricated link.
   *
   * A template naming NONE of the placeholders is treated as unset, exactly as the bridge
   * treats it: a bare origin like `https://app.radicle.xyz` renders the explorer's home page
   * for every patch and every issue, and a link that is the same for everything is worse than
   * no link, because nobody can tell it apart from a real one.
   */
  explorerUrl?: string | null;
  /** `RYPH_RADICLE_MODE` as the bridge has it; `deployment` unless said. */
  mode?: RadicleBridgeMode;
  diag: Diagnostics;
  requestTimeoutMs?: number;
}

/**
 * The bound on one bridge call — the MIDDLE link of the fetch timeout chain.
 *
 * Seeding a repository is the slow call behind this client: the bridge runs `rad sync --fetch`
 * with a 20s budget and gives the subprocess 5s of grace on top, so 25s is the longest honest
 * answer. This has to sit above that, and the orchestrator's own deadline for the seed call
 * (45s) above this, or the layer that gives up first turns a refusal the user could act on
 * into "the Radicle node did not answer". See `@ryph/radicle`'s README, "The fetch timeout
 * chain".
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The bound on opening an issue that carries files. The bridge opens it, then attaches the files
 * in a second op (tried twice), and closes the issue if they never attach: up to four `rad`
 * calls of 60s each under the repository's lock. Giving up before that ends would have the forge
 * look for the issue, find it still open, and report it written, just before the bridge closes
 * it. So this waits for the bridge's own answer.
 */
const ISSUE_WITH_FILES_TIMEOUT_MS = 300_000;

/**
 * The bound on the one bridge call a check report makes. The bridge records and finishes the
 * run under one lock with up to three `rad-job list`s, each reading every job in the repository,
 * so it needs more than an ordinary call. It stays under the orchestrator's 120 s for the whole
 * report, so this layer answers first; a report cut short converges on the same run next time.
 */
const JOB_REPORT_TIMEOUT_MS = 110_000;

/** The placeholders `RYPH_RADICLE_EXPLORER_URL` may name — the same three the bridge renders
 * (`@ryph/radicle`'s `renderExplorerUrl`), spelled again here rather than imported, because the
 * forge does not depend on the bridge's package and this is three characters of contract. */
const EXPLORER_PLACEHOLDERS = /\{(?:rid|kind|id)\}/;

/** A listing page, matching the GitHub adapter's so a tool's paging reads the same on both. */
const PAGE = 30;

/** How many change requests one listing walks before it stops. The bridge filters by exactly
 * one state and "closed" is two of Radicle's four (`archived` and `merged`), so a closed
 * listing is filtered here — over a window, because a repo with more open change requests
 * than this has other problems. */
const CHANGE_SCAN = 200;

/** What one entry's text may contribute to a thread read — the GitHub adapter's bound, kept. */
const ENTRY_BUDGET = 16_000;

/** What one revision's subject may contribute to a history — the GitHub adapter's bound on a
 * commit subject, kept, for the same reason: a subject is a sentence. */
const REVISION_SUMMARY_MAX = 200;

/** And the same clamps it puts on the rest of a history line. Every one of these strings was
 * written by whoever pushed the revision, and the rendering spends a fixed budget on a whole
 * change request: one enormous author string is all it takes for the timeline to fall off the
 * end of the read. */
const AUTHOR_MAX = 80;
const DATE_MAX = 40;
const SHA_MAX = 64;

/** Cut with an ellipsis, so a clamped value never reads as the whole one. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** How long a change request read by `fetchThread` may be reused by the history read that
 * follows it. Seconds, because the two are one tool call and nothing else may reuse it at
 * all: a stale change request would be a push this deployment cannot see, and the submit
 * path's `describeChangeRequest` exists precisely to look again. */
const THREAD_CHANGE_REUSE_MS = 5_000;

/** How many job runs a checks read hands back — the GitHub adapter's cap, for the same reason:
 * the rendering spends a fixed budget, and the list is ordered worst first before it is cut. */
const CHECKS_MAX = 50;

/** A job run's `log` is written by whichever node recorded it; a URL is a line, not an essay. */
const CHECK_URL_MAX = 500;

/** Suite states after which the verdict can no longer change (the orchestrator's
 * TERMINAL_SUITE_STATES, spelled again: this package cannot import it). */
const SETTLED_SUITE = new Set(["passed", "failed", "error", "cancelled"]);

/**
 * The log URL a suite generation's job run carries — and the key the bridge finds the run by
 * again, because `rad-job` mints the run's uuid itself and no caller can choose one. One per
 * GENERATION: a re-run is a new run on the same job, as a re-run is a new verdict.
 *
 * The suite's page when the deployment has a web address (Desktop and the explorer link it);
 * otherwise a `urn:` naming the suite, which the job's URL type accepts (measured) and which at
 * least says whose run it is.
 */
export function jobRunLog(report: Pick<CheckReport, "detailsUrl" | "suiteId" | "generation">) {
  if (report.detailsUrl !== null) {
    try {
      const url = new URL(report.detailsUrl);
      if (url.protocol === "https:" || url.protocol === "http:") {
        url.searchParams.set("generation", String(report.generation));
        return url.toString();
      }
    } catch {
      // Not a URL after all; fall through to the one that always is.
    }
  }
  return `urn:ryph:check-suite:${encodeURIComponent(report.suiteId)}:${report.generation}`;
}

/**
 * Which suite a log URL of ours names, and which generation: `jobRunLog` read backwards. The
 * suite is the URL without its generation. Null for a log this deployment did not write.
 */
export function suiteOfLog(log: string): { suite: string; generation: number } | null {
  const urn = /^(urn:ryph:check-suite:[^:]+):(\d+)$/.exec(log);
  if (urn !== null) return { suite: urn[1], generation: Number(urn[2]) };
  try {
    const url = new URL(log);
    const generation = Number(url.searchParams.get("generation"));
    if (!Number.isInteger(generation) || generation < 1) return null;
    url.searchParams.delete("generation");
    return { suite: url.toString(), generation };
  } catch {
    return null;
  }
}

/** How many older generations one report may finish — the bridge's own bound on `supersedes`. */
const MAX_SUPERSEDED = 100;

/** Radicle's four change-request states, as the two the port speaks. */
function changeState(state: string): "open" | "closed" {
  return state === "merged" || state === "archived" ? "closed" : "open";
}

/** A review verdict as the port spells one — GitHub's vocabulary, which is the one every
 * consumer of `ThreadEntry.state` already reads. */
function verdictOf(verdict: string | null): string {
  return verdict === "accept"
    ? "approved"
    : verdict === "reject"
    ? "changes_requested"
    : "commented";
}

/**
 * A comment's handle: the port hands `updateComment` and `addReaction` nothing but this
 * string, and Radicle — unlike GitHub, where a comment is addressable repo-wide — can only
 * reach a comment THROUGH the object it hangs on. So the thread rides inside the handle.
 * Opaque by contract ("the handle `updateComment` edits by"), and the only place the three
 * parts are ever joined or split.
 */
function commentHandle(thread: ThreadRef, commentId: string): string {
  return `${thread.kind}:${thread.ref}:${commentId}`;
}

function parseCommentHandle(handle: string): { thread: ThreadRef; commentId: string } {
  const parts = handle.split(":");
  if (parts.length !== 3 || (parts[0] !== "issue" && parts[0] !== "change_request")) {
    throw new ForgeApiError(
      `${JSON.stringify(handle)} is not a Radicle comment handle`,
      true,
    );
  }
  return { thread: { kind: parts[0], ref: parts[1] }, commentId: parts[2] };
}

/** The bridge's path segment for a thread kind. */
const segmentOf = (kind: "issue" | "change_request") =>
  kind === "change_request" ? "changes" : "issues";

/** A body's embeds as the bridge takes them: `{name, data}`, the bytes base64. Absent rather
 * than empty, so a write without images is the request it always was. */
function embedsField(embeds: BodyEmbed[] | undefined): { embeds?: WireEmbed[] } {
  return embeds === undefined || embeds.length === 0
    ? {}
    : { embeds: embeds.map((e) => ({ name: e.name, data: e.bytes.toBase64() })) };
}

export interface WireEmbed {
  name: string;
  data: string;
}

/** The comment view the bridge answers with, as much of it as this file reads. */
interface BridgeComment {
  id: string;
  author: { did: string; alias?: string };
  body: string;
  createdAt: string;
  revision?: string;
  location?: { path: string; line: number | null; side: "old" | "new" };
  /** The files it embeds — git blobs in the repository, by oid. Absent when none. */
  embeds?: BridgeEmbed[];
}

interface BridgeEmbed {
  name: string;
  oid: string;
}

/**
 * Where a body links an embed: `[name](<oid>)`, which is what Radicle Desktop writes, or the
 * same as an image (`![name](<oid>)`) or with heartwood's `git:` prefix. "" when the body does not
 * link it at all — the file is still the comment's, and is shown after its text.
 *
 * No `occurrence` is carried, which reads as the first exact match of the markup: the leftmost
 * match of this pattern is that, since any earlier copy of the same text would match it too.
 */
function embedMarkup(body: string, oid: string): string {
  const link = new RegExp(`!?\\[[^\\]\\n]*\\]\\(\\s*<?(?:git:)?${oid}>?\\s*\\)`);
  return body.match(link)?.[0] ?? "";
}

export function radicleForgeApi(
  opts: RadicleForgeApiOptions,
): ForgeApi & RadicleBridgeApi {
  const { diag } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const explorerRaw = opts.explorerUrl?.trim() || null;
  const explorer = explorerRaw !== null && EXPLORER_PLACEHOLDERS.test(explorerRaw)
    ? explorerRaw
    : null;
  if (explorerRaw !== null && explorer === null) {
    diag.warn("radicle.explorer_template_ignored", { template: explorerRaw });
  }

  /** One bridge call: status + parsed body. Throws only when the socket dies, and then as a
   * RETRYABLE refusal — the bridge is a pod beside us, and a restart is not a verdict. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    callTimeoutMs = timeoutMs,
    // oxlint-disable-next-line no-explicit-any
  ): Promise<{ status: number; body: any }> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`,
          // The mode this forge was told, which a user-mode bridge checks before it seeds: a
          // forge that thinks it stands beside a deployment's bridge would let the control plane
          // skip the bar connecting to one person's identity is held to.
          "x-ryph-radicle-mode": opts.mode ?? "deployment",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(callTimeoutMs),
      });
    } catch (err) {
      throw new ForgeApiError(`the Radicle bridge is unreachable: ${err}`, false);
    }
    return { status: res.status, body: (await res.json().catch(() => null)) ?? {} };
  };

  const detail = (body: { error?: unknown; reason?: unknown }): string =>
    typeof body?.reason === "string"
      ? body.reason
      : typeof body?.error === "string"
      ? body.error
      : "no detail";

  /**
   * A refusal that says whether asking again could help — and, for the one refusal an AGENT is
   * meant to read rather than an operator, says what it would take.
   *
   * Radicle reserves labelling, assignment and the lifecycle of somebody else's object for a
   * repository's delegates. ryph is normally not one, and that is the posture this design
   * recommends: making it a delegate would also let it push the default branch. So the answer
   * has to be a sentence a model can act on — "choose something else" — rather than a 500 it
   * retries until its cap is gone.
   */
  const refusal = (
    what: string,
    res: { status: number; body: { error?: unknown; capability?: unknown; reason?: unknown } },
  ): ForgeApiError => {
    if (res.status === 403 && res.body?.error === "forge_capability_unavailable") {
      return new ForgeApiError(
        `${what} is not something ryph can do on this repository: ${detail(res.body)}. ` +
          "Radicle reserves labels, assignment, and closing or reopening somebody else's " +
          "issue for a repository's delegates, and ryph is not one here — adding a label or " +
          "closing this issue would need the repository to make ryph's key a delegate. " +
          "Nothing was written; do the rest of the work without it.",
        true,
      );
    }
    return new ForgeApiError(
      `${what} failed (${res.status}): ${detail(res.body)}`,
      res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429,
    );
  };

  /** The edge where the port's opaque `repoRef` is spelled: a RID, and never anything else. */
  const rid = (repo: ForgeRepo): string => {
    if (!/^rad:z[1-9A-HJ-NP-Za-km-z]+$/.test(repo.repoRef)) {
      throw new ForgeApiError(
        `${JSON.stringify(repo.repoRef)} is not a Radicle repository id`,
        true,
      );
    }
    return repo.repoRef;
  };

  /** The RID as a path segment. `rad:` carries a colon, which a URL path takes verbatim —
   * encoded all the same, because a repo address must never be able to walk a path. */
  const seg = (canonical: string) => encodeURIComponent(canonical);

  /** Where a human reads this thread, or "" — see `explorerUrl`. */
  const webUrl = (canonical: string, kind: "issue" | "change_request", id: string): string => {
    if (explorer === null) return "";
    return explorer
      .replaceAll("{rid}", canonical)
      .replaceAll("{kind}", kind === "change_request" ? "patches" : "issues")
      .replaceAll("{id}", id);
  };

  const getRepo = async (canonical: string): Promise<RadicleRepoInfo> => {
    const res = await call("GET", `/v1/repos/${seg(canonical)}`);
    if (res.status !== 200 || typeof res.body?.rid !== "string") {
      throw refusal(`reading ${canonical}'s identity document`, res);
    }
    return res.body as RadicleRepoInfo;
  };

  /**
   * The LAST change request `fetchThread` materialized, for the history read that follows it in
   * the same tool call — one bridge round trip instead of two for the same object.
   *
   * Deliberately not a cache on `getChange`: `describeChangeRequest` and `classifyBranch` are
   * the submit path's last look before it pushes onto somebody's branch, and a look that can
   * answer from five seconds ago is not a last look. Written by exactly one method and read by
   * exactly one other.
   */
  let threadChange: { key: string; atMs: number; change: Record<string, unknown> } | null = null;

  const getChange = async (canonical: string, ref: string) => {
    const res = await call("GET", `/v1/repos/${seg(canonical)}/changes/${encodeURIComponent(ref)}`);
    if (res.status !== 200 || typeof res.body?.change?.id !== "string") {
      throw refusal(`reading change request ${ref} of ${canonical}`, res);
    }
    return res.body.change;
  };

  /** The hunks of a change request's latest revision — `git diff base..head` against storage,
   * split per file by the bridge. Read by the file listing (so a change request read shows
   * where a remark may anchor) and by the review check (so a remark that cannot is refused). */
  const readDiff = async (canonical: string, ref: string) => {
    const res = await call(
      "GET",
      `/v1/repos/${seg(canonical)}/changes/${encodeURIComponent(ref)}/diff`,
    );
    if (res.status !== 200 || !Array.isArray(res.body?.files)) {
      throw refusal(`reading the diff of ${ref} in ${canonical}`, res);
    }
    return {
      // oxlint-disable-next-line no-explicit-any
      files: res.body.files.map((f: any) => ({
        path: String(f.path),
        patch: typeof f.patch === "string" ? f.patch : null,
      })) as Array<{ path: string; patch: string | null }>,
      // False when the commits are not in storage — the object arrived and the pack did not.
      // A path missing from an incomplete listing is not a file the change request leaves
      // alone, and the review check must not read it as one.
      complete: res.body.complete === true,
      headSha: typeof res.body.head === "string" ? res.body.head : "",
    };
  };

  /**
   * One embedded file's bytes, from the bridge — which serves only a file the object itself
   * embeds, read from storage, and refuses one over the cap with a 413. Never throws: an embed
   * that cannot be had is an omission, as a GitHub download is.
   */
  const readEmbed = async (
    canonical: string,
    thread: ThreadRef,
    oid: string,
    signal: AbortSignal,
  ): Promise<ImageOutcome> => {
    try {
      const res = await fetch(
        `${base}/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/embeds/${oid}`,
        {
          headers: { authorization: `Bearer ${opts.token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
        },
      );
      const body = (await res.json().catch(() => null)) ?? {};
      if (res.status === 413) return { kind: "omitted", reason: "too_large" };
      if (res.status !== 200 || typeof body?.embed?.data !== "string") {
        return { kind: "omitted", reason: "unavailable" };
      }
      const bytes = Uint8Array.fromBase64(body.embed.data);
      return imageOf(
        bytes.length > MAX_THREAD_IMAGE_BYTES ? { ok: false } : { ok: true, bytes },
      );
    } catch {
      return { kind: "omitted", reason: "unavailable" };
    }
  };

  const getIssue = async (canonical: string, ref: string) => {
    const res = await call("GET", `/v1/repos/${seg(canonical)}/issues/${encodeURIComponent(ref)}`);
    if (res.status !== 200 || typeof res.body?.issue?.id !== "string") {
      throw refusal(`reading issue ${ref} of ${canonical}`, res);
    }
    return res.body.issue;
  };

  /**
   * A change request's head, as a run working on it needs it.
   *
   * `headRef` is `patches/<id>` — the name the bridge's git door exports a change request's
   * head under, flattened out of the namespace it is signed in. There is no fork: a Radicle
   * change request lives in the repository it is against, so `headRepoRef` is always the RID
   * and the fork checks every caller makes simply pass.
   */
  /** The change request's own head off a bridge read. A bridge too old to send one answers "",
   * which the orchestrator's head read refuses as no commit: the read is then unavailable, and
   * every push to the repo 503s, holding the Radicle queue, until the bridge is upgraded — said
   * out loud for that reason. */
  const authorHeadOf = (canonical: string, change: { id: string; authorHead?: unknown }) => {
    if (typeof change.authorHead === "string" && change.authorHead !== "") return change.authorHead;
    diag.warn("radicle.author_head_missing", { rid: canonical, change: change.id });
    return "";
  };

  /**
   * What a merged change request merged, by commit, as the bridge's own event names it: the
   * merge its state settled on, or — for a state that names none — every merge a delegate
   * recorded, newest first and at most `MAX_MERGED_HEADS` (what the containment read accepts).
   * Empty unless merged.
   */
  const mergedHeadsOf = (
    change: { state?: unknown; mergedRevision?: unknown; merges?: unknown },
  ): string[] => {
    if (change.state !== "merged") return [];
    const named = (change.mergedRevision as { commit?: unknown } | null | undefined)?.commit;
    if (typeof named === "string" && COMMIT_ID.test(named)) return [named];
    const recorded = (Array.isArray(change.merges) ? change.merges : [])
      .map((m) => m as { commit?: unknown; timestamp?: unknown } | null)
      .map((m) => ({
        commit: m?.commit,
        at: typeof m?.timestamp === "string" ? m.timestamp : "",
      }))
      .filter((m): m is { commit: string; at: string } =>
        typeof m.commit === "string" && COMMIT_ID.test(m.commit)
      )
      .sort((a, b) => b.at.localeCompare(a.at));
    return [...new Set(recorded.map((m) => m.commit))].slice(0, MAX_MERGED_HEADS);
  };

  const headOf = (
    canonical: string,
    change: { id: string; state: string; head?: unknown; authorHead?: unknown },
    identity: RadicleRepoInfo,
  ): ChangeRequestHead => ({
    ref: change.id,
    url: webUrl(canonical, "change_request", change.id),
    state: changeState(change.state),
    merged: change.state === "merged",
    headRef: `patches/${change.id}`,
    headSha: typeof change.head === "string" ? change.head : "",
    // The author's latest revision: anybody may revise anybody's patch, and the newest one —
    // `headSha`, what a run builds on — may be a run's own or a stranger's proposal on top.
    authorHeadSha: authorHeadOf(canonical, change),
    // A patch targets the delegates' canonical branch, which is the default branch; Radicle has
    // no other merge target to name.
    baseRef: identity.defaultBranch,
    headRepoRef: canonical,
    // A patch's history is its revisions, and the bridge hands them over whole with the
    // object: there is no count to read ahead, and nothing would be saved by one.
    commitCount: null,
    defaultBranch: identity.defaultBranch,
  });

  /** One bridge comment as a thread entry, named by the handle a command in it arrives with. */
  const entryOf = (
    comment: BridgeComment,
    kind: ThreadEntry["kind"],
    thread: ThreadRef,
  ): ThreadEntry => ({
    ...(typeof comment.id === "string" &&
        commentHandle(thread, comment.id).length <= MAX_ENTRY_ID
      ? { id: commentHandle(thread, comment.id) }
      : {}),
    kind,
    authorLogin: comment.author?.did ?? "unknown",
    body: typeof comment.body === "string" ? comment.body.slice(0, ENTRY_BUDGET) : "",
    createdAt: comment.createdAt ?? "",
    state: null,
    location: comment.location
      ? `${comment.location.path}${
        comment.location.line === null ? "" : `:${comment.location.line}`
      }`
      : null,
  });

  /**
   * Issue or change request? Two collaborative-object types over ONE id space, so the only way
   * to tell them apart is to ask. Change requests first: a `/ryph` in one is the busier path.
   */
  const resolveThreadKind = async (
    canonical: string,
    ref: string,
  ): Promise<"issue" | "change_request"> => {
    const change = await call(
      "GET",
      `/v1/repos/${seg(canonical)}/changes/${encodeURIComponent(ref)}`,
    );
    if (change.status === 200) return "change_request";
    const issue = await call(
      "GET",
      `/v1/repos/${seg(canonical)}/issues/${encodeURIComponent(ref)}`,
    );
    if (issue.status === 200) return "issue";
    // Whichever answer is less ambiguous: a 5xx is worth retrying, two 404s are not.
    throw refusal(`resolving ${ref} in ${canonical}`, change.status === 404 ? issue : change);
  };

  const bridge: RadicleBridgeApi = {
    mode: opts.mode ?? "deployment",
    async identity(): Promise<RadicleIdentity> {
      const res = await call("GET", "/v1/identity");
      if (res.status !== 200 || typeof res.body?.did !== "string") {
        throw refusal("reading this node's identity", res);
      }
      return {
        did: res.body.did,
        nid: res.body.nid,
        alias: res.body.alias ?? null,
        node: res.body.node ?? null,
        mode: res.body.mode === "user" ? "user" : "deployment",
      };
    },

    describeRepo: (repoRef) => getRepo(repoRef),

    async seedRepo(repoRef): Promise<RadicleSeedOutcome> {
      const res = await call("POST", `/v1/repos/${seg(repoRef)}/seed`);
      // The one refusal that is not a failure: the policy was written, the node was asked, and
      // the network handed back nothing. A VALUE rather than a throw, because the connect flow
      // has something to say about it and every other caller of this has not.
      if (res.status === 409 && res.body?.error === "repo_unavailable") {
        return {
          kind: "unavailable",
          rid: repoRef,
          did: String(res.body.did ?? ""),
          command: String(res.body.command ?? ""),
          seeds: typeof res.body.seeds === "number" ? res.body.seeds : null,
          triedSeeds: typeof res.body.triedSeeds === "number" ? res.body.triedSeeds : 0,
          reason: String(res.body.reason ?? "the bridge gave no reason"),
        };
      }
      // A user-mode bridge's other value: the owner's node blocks it, and only they lift that.
      if (res.status === 409 && res.body?.error === "repo_blocked") {
        return {
          kind: "blocked",
          rid: repoRef,
          command: String(res.body.command ?? `rad unblock ${repoRef}`),
          reason: String(res.body.reason ?? `your Radicle node blocks ${repoRef}`),
        };
      }
      if (res.status === 409 && res.body?.error === "bridge_mode_mismatch") {
        diag.warn("radicle.bridge_mode_mismatch", { configured: opts.mode ?? "deployment" });
      }
      if (res.status !== 200 || typeof res.body?.rid !== "string") {
        throw refusal(`seeding ${repoRef}`, res);
      }
      return { kind: "seeded", repo: res.body as RadicleRepoInfo };
    },

    async unseedRepo(repoRef) {
      const res = await call("DELETE", `/v1/repos/${seg(repoRef)}/seed`);
      // 404 is a success here: unseeding what this node never held is the state asked for.
      if (res.status !== 200 && res.status !== 404) throw refusal(`unseeding ${repoRef}`, res);
    },
  };

  return {
    ...bridge,

    // ---- the credential seam ---------------------------------------------------------------

    fetchAuth(_repo, _url): Promise<FetchAuth | null> {
      // Not a repo credential — there is no such thing here. The bridge's git door is a door
      // on this deployment's own service, behind the one shared bearer, and `bearer` rather
      // than Basic because that is what the door takes.
      return Promise.resolve({
        origin: new URL(base).origin,
        token: opts.token,
        scheme: "bearer",
      });
    },

    upstreamUrl(repo, _url) {
      // A RID is not fetchable; the bridge's read-only git door is. Derived rather than stored,
      // so the address of the bridge stays this package's deployment detail.
      return `${base}/v1/repos/${seg(rid(repo))}/git`;
    },

    // ---- permission ------------------------------------------------------------------------

    async checkPermission(repo, subject, atLeast): Promise<Permission> {
      // The two thresholds are genuinely different questions here, and the identity document
      // answers both.
      //
      // ADMIN is delegacy. The delegates are the keys the canonical refs and the identity
      // document itself are signed against: changing what the repo IS, or what its `main`
      // says, is exactly what they hold and nobody else can take.
      //
      // WRITE is not a grant on Radicle, because there is nothing to grant. Every peer pushes
      // into its own namespace under its own key, so opening a patch, pushing a revision,
      // commenting and reviewing need no permission from anyone — they need only the ability
      // to fetch the repo. So for a PUBLIC repo the answer is "allowed" and the SUBJECT IS
      // NEVER CONSULTED: a caller with no linked Radicle identity passes NULL, and "may they
      // contribute to a public repo" is still yes for that caller. Callers depend on that —
      // do not reintroduce a subject test on this branch.
      //
      // A PRIVATE repo is the one place the ability to fetch is itself gated: `allow` is the
      // set of DIDs the node will serve it to, so it is the set that can contribute at all.
      // Delegates are in by construction, whether or not the document lists them there. A null
      // subject there is nobody, so it is in neither set: denied. Same for ADMIN, which is
      // delegacy — nobody holds that anonymously. Both are expressed as an explicit null test
      // rather than left to `includes(null)` happening to be false, so the rule is legible and
      // a widened `delegates` type can never make it accidentally true.
      //
      // Who may COMMAND agents here is a different question again, and a louder one: it is not
      // "may you contribute" but "may you spend this deployment's budget". The orchestrator
      // asks for "admin" on Radicle for that, plus its own per-repo allowlist — decided there.
      try {
        const identity = await getRepo(rid(repo));
        if (atLeast === "admin") {
          if (subject === null) return "denied";
          return identity.delegates.includes(subject) ? "allowed" : "denied";
        }
        if (identity.visibility === "public") return "allowed";
        if (subject === null) return "denied";
        return identity.delegates.includes(subject) || identity.allow.includes(subject)
          ? "allowed"
          : "denied";
      } catch (err) {
        // Even a definitive 404 is "unknown": a repository this node does not hold says
        // nothing about who may write to it, and reading it as a revocation would take a
        // deployment's commands down the moment a seed lapsed.
        diag.warn("radicle.permission_unanswerable", {
          repo: repo.repoRef,
          err: String(err),
        });
        return "unknown";
      }
    },

    // ---- progress comments -----------------------------------------------------------------

    async postComment(repo, thread, body, embeds) {
      const canonical = rid(repo);
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/comments`,
        { body, ...embedsField(embeds) },
      );
      if (res.status !== 201 || typeof res.body?.comment?.id !== "string") {
        throw refusal(`commenting on ${thread.ref} of ${canonical}`, res);
      }
      return { commentId: commentHandle(thread, res.body.comment.id) };
    },

    async updateComment(repo, commentId, body, embeds) {
      const canonical = rid(repo);
      const { thread, commentId: id } = parseCommentHandle(commentId);
      const res = await call(
        "PATCH",
        `/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/comments/${encodeURIComponent(id)}`,
        { body, ...embedsField(embeds) },
      );
      if (res.status !== 200) throw refusal(`editing comment ${id} of ${canonical}`, res);
    },

    async addReaction(repo, commentId, reaction) {
      const canonical = rid(repo);
      const { thread, commentId: id } = parseCommentHandle(commentId);
      // Radicle stores the grapheme, not a `:name:`. "eyes" is the only reaction this system
      // speaks, and 👀 is what it is.
      const emoji = reaction === "eyes" ? "👀" : reaction;
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/comments/${encodeURIComponent(id)}/reactions`,
        { reaction: emoji },
      );
      // Reacting twice with the same emoji is a success by the port's contract — the bridge
      // writes the same op, which is what makes a blind retry safe.
      if (res.status !== 201 && res.status !== 200) {
        throw refusal(`reacting to comment ${id} of ${canonical}`, res);
      }
    },

    // ---- reads ------------------------------------------------------------------------------

    async describeChangeRequest(repo, ref) {
      const canonical = rid(repo);
      const [change, identity] = await Promise.all([
        getChange(canonical, ref),
        getRepo(canonical),
      ]);
      return headOf(canonical, change, identity);
    },

    async readChangeRequestState(repo, ref) {
      const canonical = rid(repo);
      const res = await call(
        "GET",
        `/v1/repos/${seg(canonical)}/changes/${encodeURIComponent(ref)}`,
      );
      if (res.status === 404) return null;
      if (res.status !== 200 || typeof res.body?.change?.id !== "string") {
        throw refusal(`reading change request ${ref} of ${canonical}`, res);
      }
      const change = res.body.change;
      // The identity document says what a patch targets (the default branch, always) and who
      // we are; the bridge holds it locally, so this is no second trip to the network.
      const identity = await getRepo(canonical);
      const author = typeof change.author?.did === "string" ? change.author.did : "";
      return {
        ref: change.id,
        state: changeState(String(change.state)),
        merged: change.state === "merged",
        headSha: typeof change.head === "string" ? change.head : "",
        authorHeadSha: authorHeadOf(canonical, change),
        baseRef: identity.defaultBranch,
        openedByUs: author !== "" && author === identity.self.did,
        // Never `head`: a delegate may merge an older revision than the latest.
        mergedHeads: mergedHeadsOf(change),
      };
    },

    async classifyBranch(repo, branch) {
      // The bridge's git door exports canonical `refs/heads/*` — what the delegates agreed on —
      // plus one head per change request as `patches/<id>`. Only the second can carry a
      // stranger's commits.
      const patch = /^patches\/([0-9a-f]{40})$/.exec(branch);
      if (patch === null) return "branch";
      const canonical = rid(repo);
      const [change, identity] = await Promise.all([
        getChange(canonical, patch[1]),
        getRepo(canonical),
      ]);
      // A delegate's namespace is the repo's own, and so is a change request our node published
      // (decided on review: that is what lets a self-setup run's branch build without making
      // the node a delegate). Every revision counts, not just the first: the exported head is
      // one peer's, and a revision from anyone else could be the one it points at.
      const trusted = new Set([...identity.delegates, identity.self.did]);
      const authors: unknown[] = [
        change.author?.did,
        ...(Array.isArray(change.revisions) ? change.revisions : [])
          .map((r: { author?: { did?: unknown } }) => r?.author?.did),
      ];
      return authors.every((did) => typeof did === "string" && trusted.has(did))
        ? "branch"
        : "foreign";
    },

    async fetchThread(repo, thread, readOpts): Promise<ThreadContext> {
      const canonical = rid(repo);
      /** Each entry's embeds, for a read with images — beside the entries, as GitHub keeps its
       * rendered bodies: how the images are found, never part of the thread. */
      const embedsOf = new Map<ThreadEntry, BridgeEmbed[]>();
      const kept = (embeds: unknown): BridgeEmbed[] =>
        (Array.isArray(embeds) ? embeds : []).filter((e): e is BridgeEmbed =>
          typeof e?.oid === "string" && /^[0-9a-f]{40}$/.test(e.oid) && typeof e?.name === "string"
        );
      const withImages = async (context: ThreadContext, bodyEmbeds: unknown) => {
        if (readOpts?.images === undefined) return context;
        const at = { kind: context.kind, ref: context.ref };
        const slotsOf = (owner: ImageSlot["owner"], body: string, embeds: BridgeEmbed[]) =>
          embeds.slice(0, MAX_SLOTS_PER_ENTRY).map((embed): ImageSlot => ({
            owner,
            markup: embedMarkup(body, embed.oid),
            // Cut to MAX_IMAGE_NAME where the image is written, as every bound is.
            name: embed.name,
            fetch: (signal) => readEmbed(canonical, at, embed.oid, signal),
          }));
        await attachThreadImages(
          context,
          [
            ...slotsOf("body", context.body, kept(bodyEmbeds)),
            ...context.entries.flatMap((e, i) => slotsOf(i, e.body, embedsOf.get(e) ?? [])),
          ],
          readOpts.images.focus,
          { focusOnly: readOpts.images.focusOnly === true },
        );
        return context;
      };
      const entry = (c: BridgeComment, kind: ThreadEntry["kind"], at: ThreadRef) => {
        const made = entryOf(c, kind, at);
        embedsOf.set(made, kept(c.embeds));
        return made;
      };

      if (thread.kind === "issue") {
        const issue = await getIssue(canonical, thread.ref);
        const comments: BridgeComment[] = issue.comments ?? [];
        const at: ThreadRef = { kind: "issue", ref: issue.id };
        return await withImages({
          kind: "issue",
          ref: issue.id,
          title: issue.title,
          body: typeof issue.body === "string" ? issue.body.slice(0, ENTRY_BUDGET) : "",
          authorLogin: issue.author?.did ?? "unknown",
          createdAt: issue.createdAt ?? "",
          state: issue.state === "closed" ? "closed" : "open",
          // The first comment IS the opening post (it is where a Radicle issue keeps its body),
          // so carrying it again as an entry would show the issue's text twice.
          entries: comments.slice(1).map((c) => entry(c, "comment", at)),
          truncated: false,
          changeRequest: null,
        }, comments[0]?.embeds);
      }

      const [change, identity] = await Promise.all([
        getChange(canonical, thread.ref),
        getRepo(canonical),
      ]);
      // Kept for the history read that follows this one in the same tool call; see
      // `threadChange`. The bridge materializes the whole object, revisions included, so
      // asking for it twice is one round trip spent on bytes already in hand.
      threadChange = { key: `${canonical}/${thread.ref}`, atMs: Date.now(), change };
      const at: ThreadRef = { kind: "change_request", ref: change.id };
      const entries: ThreadEntry[] = [
        ...(change.comments ?? []).map((c: BridgeComment) => entry(c, "comment", at)),
      ];
      // A change request's reviews and its inline remarks are the same conversation a human
      // reads — "address the review feedback" is unanswerable without them.
      for (const review of change.reviews ?? []) {
        const summary: ThreadEntry = {
          kind: "review",
          authorLogin: review.author?.did ?? "unknown",
          body: typeof review.summary === "string" ? review.summary.slice(0, ENTRY_BUDGET) : "",
          createdAt: review.createdAt ?? "",
          state: verdictOf(review.verdict ?? null),
          location: null,
        };
        embedsOf.set(summary, kept(review.summaryEmbeds));
        entries.push(summary);
        for (const remark of review.comments ?? []) {
          entries.push(entry(remark, "review_comment", at));
        }
      }
      const key = (e: ThreadEntry) => e.createdAt || "9999";
      entries.sort((a, b) => key(a).localeCompare(key(b)));
      return await withImages({
        kind: "change_request",
        ref: change.id,
        title: change.title,
        body: typeof change.description === "string"
          ? change.description.slice(0, ENTRY_BUDGET)
          : "",
        authorLogin: change.author?.did ?? "unknown",
        createdAt: change.createdAt ?? "",
        state: changeState(change.state),
        entries,
        // The bridge materializes the whole object — there is no page to be cut short by.
        truncated: false,
        changeRequest: headOf(canonical, change, identity),
        // The description is the FIRST revision's (the bridge's `description`), so are its
        // embeds.
      }, change.revisions?.[0]?.embeds);
    },

    async repoVisibility(_tenantId, repoRefs) {
      const out = new Map<string, RepoVisibility>();
      for (const repoRef of repoRefs) {
        const identity = await getRepo(rid({ repoRef, tenantId: null }));
        out.set(repoRef, wholeRepoVisibility(identity.visibility === "private"));
      }
      return out;
    },

    async repoLabels(repo) {
      const canonical = rid(repo);
      // Radicle has no label REGISTRY: a label is a string an object carries, so the only
      // truthful answer is "the ones seen on the objects walked" — and `complete: false`
      // always, because a label missing from that set says nothing about the repository.
      const labels = new Set<string>();
      for (const kind of ["issues", "changes"] as const) {
        const res = await call("GET", `/v1/repos/${seg(canonical)}/${kind}?limit=${CHANGE_SCAN}`);
        if (res.status !== 200) throw refusal(`listing ${canonical}'s ${kind}`, res);
        const items = kind === "issues" ? res.body?.issues : res.body?.changes;
        for (const item of Array.isArray(items) ? items : []) {
          for (const label of item?.labels ?? []) {
            if (typeof label === "string") labels.add(label);
          }
        }
      }
      return { labels: [...labels].sort(), complete: false };
    },

    threadKind: (repo, ref) => resolveThreadKind(rid(repo), ref),

    async listIssues(repo, query) {
      const canonical = rid(repo);
      const offset = (query.page - 1) * PAGE;
      const labels = query.labels.map((l) => `&label=${encodeURIComponent(l)}`).join("");
      // "all" is the absence of a filter — the bridge matches one state exactly.
      const state = query.state === "all" ? "" : `&state=${query.state}`;
      const res = await call(
        "GET",
        `/v1/repos/${seg(canonical)}/issues?limit=${PAGE}&offset=${offset}${state}${labels}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body?.issues)) {
        throw refusal(`listing ${canonical}'s issues`, res);
      }
      // oxlint-disable-next-line no-explicit-any
      const items: IssueListing[] = res.body.issues.map((i: any) => ({
        ref: i.id,
        title: i.title ?? "",
        state: i.state ?? "open",
        authorLogin: i.author?.did ?? "unknown",
        labels: Array.isArray(i.labels) ? i.labels : [],
        // The root comment is the issue's body, not a reply.
        comments: Math.max(0, (i.comments?.length ?? 1) - 1),
        updatedAt: i.updatedAt ?? "",
      }));
      return { items, hasMore: offset + items.length < (res.body.total ?? 0) };
    },

    async listChangeRequests(repo, query) {
      const canonical = rid(repo);
      // "closed" is two of Radicle's four states, and the bridge filters by exactly one — so
      // the window is walked and filtered here. `open` and `all` pass straight through, which
      // is the case that matters; `closed` is bounded by CHANGE_SCAN and says so by paging
      // out rather than by pretending the window is the repository.
      const filtered = query.state === "closed";
      const state = query.state === "open" ? "&state=open" : "";
      const offset = filtered ? 0 : (query.page - 1) * PAGE;
      const limit = filtered ? CHANGE_SCAN : PAGE;
      const res = await call(
        "GET",
        `/v1/repos/${seg(canonical)}/changes?limit=${limit}&offset=${offset}${state}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body?.changes)) {
        throw refusal(`listing ${canonical}'s change requests`, res);
      }
      // oxlint-disable-next-line no-explicit-any
      const all = (res.body.changes as any[])
        .filter((c) => !filtered || changeState(c.state) === "closed");
      const window = filtered ? all.slice((query.page - 1) * PAGE, query.page * PAGE) : all;
      // oxlint-disable-next-line no-explicit-any
      const items: ChangeListing[] = window.map((c: any) => ({
        ref: c.id,
        title: c.title ?? "",
        state: c.state ?? "open",
        authorLogin: c.author?.did ?? "unknown",
        draft: c.state === "draft",
        headRef: `patches/${c.id}`,
        baseRef: c.target ?? "",
        updatedAt: c.updatedAt ?? "",
      }));
      const seen = filtered ? all.length : offset + items.length;
      return {
        items,
        hasMore: filtered ? query.page * PAGE < all.length : seen < (res.body.total ?? 0),
      };
    },

    async listChangeRequestFiles(repo, ref) {
      const canonical = rid(repo);
      // The stat and the hunks are two bridge reads, because `rad` gives only the stat and the
      // hunks are `git diff` against storage: read together, since a change request read is
      // what a whole run waits on, and merged here so the agent learns which lines a remark
      // may anchor to — exactly what GitHub's file listing tells it in one call.
      const [change, diff] = await Promise.all([
        getChange(canonical, ref),
        readDiff(canonical, ref),
      ]);
      const patches = new Map(diff.files.map((f) => [f.path, f.patch]));
      // The stat is the authority on WHICH files changed and by how much; the diff fills in
      // the hunks where there are any. A path the diff shows and the stat does not is still a
      // changed file, counted from its own hunk.
      const items: ChangedFile[] = (change.files?.files ?? []).map(
        // oxlint-disable-next-line no-explicit-any
        (f: any) => ({
          path: f.path,
          status: f.status ?? "changed",
          additions: f.insertions ?? 0,
          deletions: f.deletions ?? 0,
          patch: patches.get(f.path) ?? null,
        }),
      );
      for (const [path, patch] of patches) {
        if (items.some((f) => f.path === path)) continue;
        const lines = (patch ?? "").split("\n");
        items.push({
          path,
          status: "changed",
          additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
          deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
          patch,
        });
      }
      return { items, hasMore: false };
    },

    async listChangeRequestCommits(repo, ref, limit) {
      const canonical = rid(repo);
      const held = threadChange;
      const change = held !== null && held.key === `${canonical}/${ref}` &&
          Date.now() - held.atMs < THREAD_CHANGE_REUSE_MS
        ? held.change
        : await getChange(canonical, ref);
      // A Radicle patch has no commit list of its own. What it HAS — and what the COB records
      // as its history — is one revision per push: an author, a time, and the head that
      // revision pointed at. Walking the commits behind each head would mean walking git in
      // storage for every read, which is not what a change request read should cost, so the
      // revisions are answered as what they are and the rendering says "revisions" rather than
      // calling a revision a commit.
      const revisions: Array<Record<string, unknown>> = Array.isArray(change.revisions)
        ? change.revisions as Array<Record<string, unknown>>
        : [];
      const mapped: ChangeCommit[] = revisions.map((r) => {
        const id = typeof r.id === "string" ? r.id : "";
        const description = typeof r.description === "string" ? r.description : "";
        return {
          sha: clip(typeof r.head === "string" ? r.head : "", SHA_MAX),
          revision: {
            id: clip(id, SHA_MAX),
            base: clip(typeof r.base === "string" ? r.base : "", SHA_MAX),
          },
          authorLogin: clip(
            typeof (r.author as { did?: unknown } | null)?.did === "string"
              ? (r.author as { did: string }).did
              : "unknown",
            AUTHOR_MAX,
          ),
          date: clip(typeof r.timestamp === "string" ? r.timestamp : "", DATE_MAX),
          // A revision's description is the patch's text on the first one and often empty
          // after it; "" would render a line with a hole in it, so the revision names itself.
          summary: description.split("\n", 1)[0].slice(0, REVISION_SUMMARY_MAX) ||
            `revision ${id.slice(0, 12)}`,
        };
      });
      const items = mapped.slice(Math.max(0, mapped.length - limit));
      return {
        items,
        older: mapped.length - items.length,
        unit: "revision",
        // The bridge materializes every revision of the object at once: there is no listing to
        // be cut short by, so the window always ends at the latest revision.
        atHead: true,
        total: mapped.length,
      };
    },

    /**
     * CI on Radicle is the job COB (`xyz.radworks.job`): per commit, every node that ran
     * something records a run under its own key — ryph's check suites among them. So the answer
     * is one check per NODE, its latest run over every job for the commit (two nodes racing can
     * create two jobs for one commit, and radicle-httpd unions them too), named by the node that
     * signed it. Our own node is the exception: one check per SUITE, named `ryph`, its newest
     * generation's run, so a failed suite never hides behind a passed one on the same commit.
     *
     * No jobs is a real answer — "nothing has reported on this commit" — and never "none": a
     * node CAN report here now. A bridge that cannot be asked is `unavailable`, never an empty
     * list, for the reason the port gives.
     */
    async readChecks(repo, headSha): Promise<ChecksReport> {
      // oxlint-disable-next-line no-explicit-any
      let res: { status: number; body: any };
      try {
        res = await call(
          "GET",
          `/v1/repos/${seg(rid(repo))}/jobs?commit=${encodeURIComponent(headSha)}`,
        );
      } catch (err) {
        return { kind: "unavailable", reason: String(err instanceof Error ? err.message : err) };
      }
      if (res.status !== 200 || !Array.isArray(res.body?.jobs)) {
        return {
          kind: "unavailable",
          reason: `the Radicle bridge did not list jobs (${res.status}): ${detail(res.body)}`,
        };
      }
      const self = typeof res.body.node === "string" ? res.body.node : null;
      type Held = { node: string; status: string; log: unknown; at: string; generation: number };
      const latest = new Map<string, Held>();
      for (const job of res.body.jobs as Array<{ commit?: unknown; runs?: unknown }>) {
        if (job?.commit !== headSha || !Array.isArray(job.runs)) continue;
        for (const run of job.runs as Array<Record<string, unknown>>) {
          if (typeof run?.node !== "string" || typeof run.status !== "string") continue;
          const at = typeof run.at === "string" ? run.at : "";
          const ours = run.node === self && typeof run.log === "string"
            ? suiteOfLog(run.log)
            : null;
          const key = ours === null ? `node:${run.node}` : `suite:${ours.suite}`;
          const generation = ours?.generation ?? 0;
          const held = latest.get(key);
          // Newest generation first; then latest by time, and on a tie (COB time is seconds) a
          // run that is still going wins, so a re-run is never hidden behind the verdict it
          // replaces.
          if (
            held === undefined || generation > held.generation ||
            (generation === held.generation &&
              (at > held.at ||
                (at === held.at && run.status === "started" && held.status !== "started")))
          ) {
            latest.set(key, { node: run.node, status: run.status, log: run.log, at, generation });
          }
        }
      }
      const items: CheckRun[] = [...latest.values()].map((run) => ({
        name: run.node === self ? "ryph" : `radicle job ${run.node.slice(0, 12)}`,
        status: run.status === "started" ? "in_progress" : "completed",
        conclusion: run.status === "succeeded"
          ? "success"
          : run.status === "failed"
          ? "failure"
          : null,
        detailsUrl: typeof run.log === "string" && run.log.length <= CHECK_URL_MAX ? run.log : null,
      }));
      // Worst first before the cut, never after — the port's contract, and GitHub's order.
      items.sort((a, b) => checkSeverity(a) - checkSeverity(b) || a.name.localeCompare(b.name));
      const shown = items.slice(0, CHECKS_MAX);
      return {
        kind: "reported",
        headSha,
        items: shown,
        cut: items.length - shown.length,
        unlisted: 0,
        partial: null,
      };
    },

    /**
     * A suite is ONE run on the commit's job, signed by this node: Desktop and the explorer show
     * a node's runs as a flat list with no names, so a run per check would be a row of
     * indistinguishable entries. `Succeeded` only when every check passed; a failed suite, and
     * one that ended in error, are `Failed`. A cancelled suite is not finished at all: neither
     * verdict is true of it, so its run is left started, and none is recorded for a suite that
     * had none. The `log` is the suite's page, which lists the checks.
     *
     * The older generations the report names (`suite.previousGenerations`) were reported while
     * going, or as cancelled, never settled, and are known not to have passed; their runs are
     * finished as `Failed` in the same bridge call, since no later report will mention them.
     *
     * Stateless on purpose: the run is found again by its log URL (`jobRunLog`), so every report
     * records-or-finds the run and, once the suite has settled, finishes it in the same bridge
     * call. A retry after any failure converges on the same run. A 409 is final: the run already
     * holds the other verdict, or a duplicate job keeps `rad-job` from reaching it.
     */
    async reportChecks(repo, report): Promise<ReportChecksOutcome> {
      const canonical = rid(repo);
      if (!/^[0-9a-f]{40}$/.test(report.headSha)) {
        throw new ForgeApiError(
          `${JSON.stringify(report.headSha)} is not a commit Radicle can hold (SHA-1, 40 hex)`,
          true,
        );
      }
      const cancelled = report.suite.state === "cancelled";
      const finish = SETTLED_SUITE.has(report.suite.state) && !cancelled
        ? report.suite.state === "passed" ? "succeeded" : "failed"
        : undefined;
      const supersedes = [...new Set(report.suite.previousGenerations ?? [])]
        .filter((g) => g < report.generation)
        .sort((a, b) => b - a)
        .slice(0, MAX_SUPERSEDED)
        .map((generation) => jobRunLog({ ...report, generation }));
      const what = `reporting check suite ${report.suiteId} on ${canonical}`;
      const recorded = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/jobs/runs`,
        {
          commit: report.headSha,
          log: jobRunLog(report),
          ...(finish ? { finish } : {}),
          ...(supersedes.length > 0 ? { supersedes } : {}),
          ...(cancelled ? { existingOnly: true } : {}),
        },
        JOB_REPORT_TIMEOUT_MS,
      );
      if (cancelled && recorded.status === 200 && recorded.body?.recorded === false) {
        return { kind: "reported", refs: {} };
      }
      if (recorded.status !== 200 || typeof recorded.body?.uuid !== "string") {
        // A 404 here is "the commit (or the repo) has not reached this node yet" — the push
        // gossips in after it lands elsewhere — and worth asking again, unlike other 4xx.
        const err = refusal(what, recorded);
        throw recorded.status === 404 ? new ForgeApiError(err.message, false) : err;
      }
      if (finish !== undefined && recorded.body.status !== finish) {
        // The bridge confirms a finish by reading it back; a 200 that says otherwise is a bridge
        // that did not do what it was asked, and asking again would not change it.
        throw new ForgeApiError(
          `${what}: the bridge answered run ${recorded.body.uuid} as ${
            JSON.stringify(recorded.body.status)
          }, not ${finish}`,
          true,
        );
      }
      return { kind: "reported", refs: {} };
    },

    async compareChangeRequest(repo, ref, input) {
      const query = new URLSearchParams({ from: input.from, mode: input.mode });
      if (input.to !== undefined) query.set("to", input.to);
      const res = await call(
        "GET",
        `/v1/repos/${seg(rid(repo))}/changes/${seg(ref)}/compare?${query}`,
      );
      if (res.status !== 200) throw refusal(`comparing revisions of ${ref}`, res);
      return res.body;
    },

    listChangeRequestPatches: (repo, ref) => readDiff(rid(repo), ref),

    // ---- writes ------------------------------------------------------------------------------

    async createIssue(repo, params) {
      const canonical = rid(repo);
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/issues`,
        {
          title: params.title,
          body: params.body,
          ...(params.labels.length === 0 ? {} : { labels: params.labels }),
          ...embedsField(params.embeds),
        },
        (params.embeds?.length ?? 0) > 0 ? ISSUE_WITH_FILES_TIMEOUT_MS : timeoutMs,
      );
      if (res.status !== 201 || typeof res.body?.issue?.id !== "string") {
        // A labelled issue on a repository ryph is not a delegate of is refused BEFORE
        // anything is written, so this leaves no half-opened issue behind.
        throw refusal(`opening an issue in ${canonical}`, res);
      }
      return { ref: res.body.issue.id, url: webUrl(canonical, "issue", res.body.issue.id) };
    },

    async createComment(repo, thread, body, embeds) {
      const canonical = rid(repo);
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/comments`,
        { body, ...embedsField(embeds) },
      );
      if (res.status !== 201 || typeof res.body?.comment?.id !== "string") {
        throw refusal(`commenting on ${thread.ref} of ${canonical}`, res);
      }
      return { url: webUrl(canonical, thread.kind, thread.ref) };
    },

    // Replies inside a review thread, and resolving one, are GitHub's for now. Terminal, so the
    // agent reads a refusal to act on rather than an outage to retry: answer on the patch's
    // conversation instead.
    replyToReviewComment() {
      return Promise.reject(
        new ForgeApiError(
          "replying inside a review thread is not supported on Radicle yet — comment on the " +
            "patch without replyTo",
          true,
        ),
      );
    },

    resolveReviewThread() {
      return Promise.reject(
        new ForgeApiError("resolving a review thread is not supported on Radicle yet", true),
      );
    },

    async addLabels(repo, thread, labels) {
      const canonical = rid(repo);
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/${segmentOf(thread.kind)}/${
          encodeURIComponent(thread.ref)
        }/labels`,
        { labels },
      );
      if (res.status !== 200) throw refusal(`labelling ${thread.ref} of ${canonical}`, res);
      return { url: webUrl(canonical, thread.kind, thread.ref) };
    },

    async closeIssue(repo, ref, reason) {
      const canonical = rid(repo);
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/issues/${encodeURIComponent(ref)}/close`,
        // Radicle records two reasons, and "not planned" is the one that is not "solved".
        { reason: reason === "completed" ? "solved" : "other" },
      );
      if (res.status !== 200) throw refusal(`closing issue ${ref} of ${canonical}`, res);
      return { url: webUrl(canonical, "issue", ref) };
    },

    async createReview(repo, ref, params) {
      const canonical = rid(repo);
      // `headSha` is what the caller checked its remarks against. Radicle anchors a review to
      // a REVISION rather than to a commit, and the bridge always reviews the latest one, so
      // the head is checked rather than sent: a revision pushed between the check and this
      // write would move the lines under every remark, and the bridge would anchor them to a
      // diff nobody looked at.
      if (params.headSha !== null) {
        const change = await getChange(canonical, ref);
        if (change.head !== params.headSha) {
          throw new ForgeApiError(
            `change request ${ref} is now at ${change.head}, not the ${params.headSha} the ` +
              "remarks were checked against — read the diff again and re-submit the review",
            true,
          );
        }
      }
      const res = await call(
        "POST",
        `/v1/repos/${seg(canonical)}/changes/${encodeURIComponent(ref)}/reviews`,
        {
          ...(params.body === "" ? {} : { summary: params.body }),
          // The summary's files: the bridge's review schema names them for what they hang on.
          ...(params.embeds === undefined || params.embeds.length === 0
            ? {}
            : { summaryEmbeds: embedsField(params.embeds).embeds }),
          // No verdict, ever: a run's review never approves and never blocks a merge — the
          // same stance as the GitHub adapter's unconditional COMMENT.
          remarks: params.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side === "LEFT" ? "old" : "new",
            body: c.body,
          })),
        },
      );
      if (res.status !== 201) throw refusal(`reviewing ${ref} of ${canonical}`, res);
      return { url: webUrl(canonical, "change_request", ref) };
    },

    /**
     * "The response to my write was lost — did the write land?", asked of the objects
     * themselves.
     *
     * There is no search index here, and none is needed: a Radicle write hangs on ONE object
     * and the caller names it, so the answer is a materialized read and a scan of the bodies
     * for the provenance marker. `since` bounds that scan the way it bounds GitHub's.
     *
     * NULL HAS TO MEAN "we looked, and it is not there": `core/tool_service.ts` reads it as
     * permission to write again, and a write duplicated on a repository is not a retry, it is
     * a second comment somebody has to clean up. So every way of failing to LOOK throws
     * instead, and the caller's `catch (lookErr)` turns that into the honest "could not check".
     */
    async findMarkedWrite(repo, target, marker, since) {
      const canonical = rid(repo);
      // A materialization with no timestamp is included rather than skipped: the bound is a
      // cheap way to ignore old objects, never the thing that decides a match.
      const after = (createdAt: unknown): boolean =>
        typeof createdAt !== "string" || createdAt === "" || createdAt >= since;

      // Never written here (see `replyToReviewComment`), so there is nothing to find.
      if (target.kind === "review_reply") return null;

      if (target.kind === "issue") {
        // A created issue carries the marker in its body — which on Radicle is its root comment.
        const res = await call(
          "GET",
          `/v1/repos/${seg(canonical)}/issues?state=open&limit=${CHANGE_SCAN}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body?.issues)) {
          throw refusal(`looking for a lost write in ${canonical}`, res);
        }
        for (const issue of res.body.issues as Array<Record<string, unknown>>) {
          if (typeof issue.id !== "string" || !after(issue.createdAt)) continue;
          if (typeof issue.body !== "string" || !issue.body.includes(marker)) continue;
          return { url: webUrl(canonical, "issue", issue.id), createdRef: issue.id };
        }
        return null;
      }

      // A comment or a review hangs on the thread the caller named, so there is exactly one
      // object to read. WHICH KIND it is has to be asked: a Radicle issue and a change request
      // share one id space.
      const kind = target.kind === "review"
        ? "change_request" as const
        : await resolveThreadKind(canonical, target.threadRef);
      const thread = kind === "issue"
        ? await getIssue(canonical, target.threadRef)
        : await getChange(canonical, target.threadRef);
      const url = webUrl(canonical, kind, thread.id);

      if (target.kind === "review") {
        for (const review of thread.reviews ?? []) {
          if (!after(review.createdAt)) continue;
          if (typeof review.summary === "string" && review.summary.includes(marker)) {
            return { url, createdRef: null };
          }
        }
        return null;
      }
      // The first comment on an ISSUE is its body, and a write of ours is never that.
      const comments: BridgeComment[] = kind === "issue"
        ? (thread.comments ?? []).slice(1)
        : (thread.comments ?? []);
      for (const comment of comments) {
        if (!after(comment.createdAt)) continue;
        if (typeof comment.body === "string" && comment.body.includes(marker)) {
          return { url, createdRef: null };
        }
      }
      return null;
    },
  };
}
