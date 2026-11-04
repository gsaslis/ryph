// The GitLab adapter's plumbing: ONE token, ONE instance, REST API v4 — the request, the error
// mapping, pagination headers, and the spellings only this adapter owns (thread refs `issue-<iid>`
// / `mr-<iid>`, note handles `<threadRef>:<noteId>` and `<threadRef>:<discussionId>:<noteId>`).
//
// Invariants:
// - the token is presented to `RYPH_GITLAB_URL`'s origin and nowhere else: every redirect is
//   followed by hand, and only while it stays on that origin
// - a 401 re-reads the token from its source once (`UserTokenSource.refresh`) and retries once
// - a refusal says whether asking again could help: a 4xx cannot, except 408 and 429; a 429 says
//   WHEN, where GitLab named a reset (`Retry-After`, `RateLimit-Reset`) — never a guess
// - no message carries the token

import { ForgeApiError, type ForgeRepo } from "../../ports/forge_api.ts";
import type { UserTokenSource } from "../../helpers/user_token.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { GitlabSelf } from "../../ports/gitlab.ts";
import { footerLines } from "../../core/provenance.ts";
import { fenceCloses, type FenceOpen, fenceOpen } from "@ryph/shared/markdown";

/** One GitLab answer: status, parsed body (`{}` when it was not JSON), headers. */
export interface GitlabResponse {
  status: number;
  // oxlint-disable-next-line no-explicit-any
  body: any;
  headers: Headers;
}

export interface GitlabClient {
  /** `${url}/api/v4`. */
  readonly apiBase: string;
  /** The instance's origin — the one place the token is ever presented. */
  readonly origin: string;
  /** One API call. Throws a retryable `ForgeApiError` only when GitLab could not be reached. */
  call(method: string, path: string, body?: unknown): Promise<GitlabResponse>;
  /** One API GET answered raw — the image route's, whose body is bytes. */
  raw(path: string, signal: AbortSignal): Promise<Response>;
  /** A request to a URL on the instance outside the API (OAuth) WITHOUT the forge's token —
   * the caller brings its own credential — kept on the instance's origin like every other. */
  send(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response>;
  /** The refusal for a non-success answer: terminal or not, and when a rate limit lifts. */
  refusal(what: string, res: { status: number; body: unknown; headers?: Headers }): ForgeApiError;
}

/** How long a request may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** GitLab's message, wherever its answer put it: `message` (a string, or a field → errors map),
 * or `error` / `error_description` (OAuth). */
export function messageOf(body: unknown): string {
  // oxlint-disable-next-line no-explicit-any
  const b = body as any;
  const m = b?.message ?? b?.error_description ?? b?.error;
  if (typeof m === "string") return m.slice(0, 500);
  if (m !== null && typeof m === "object") {
    try {
      return JSON.stringify(m).slice(0, 500);
    } catch {
      return "no detail";
    }
  }
  return "no detail";
}

export function gitlabClient(opts: {
  url: string;
  token: UserTokenSource;
  diag: Diagnostics;
  now: () => number;
}): GitlabClient {
  const { diag, now } = opts;
  const apiBase = `${opts.url}/api/v4`;
  const origin = new URL(opts.url).origin;

  /** A request that never leaves the instance's origin: a redirect elsewhere is answered as the
   * redirect itself, unfollowed, with the token never sent there. */
  const send = async (
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ): Promise<Response> => {
    let at = url;
    let req = init;
    for (let hop = 0;; hop++) {
      const res = await fetch(at, { ...req, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || location === null || hop >= 5) return res;
      const next = new URL(location, at);
      if (next.origin !== origin) {
        diag.warn("gitlab.redirect_refused", { origin: next.origin });
        return res;
      }
      await res.body?.cancel();
      at = next.href;
      if (
        res.status === 303 || ((res.status === 301 || res.status === 302) && req.method !== "GET")
      ) {
        const { "content-type": _, ...headers } = req.headers;
        req = { ...req, method: "GET", body: undefined, headers };
      }
    }
  };

  const describe = (err: unknown): string => err instanceof Error ? err.message : String(err);

  /** Sends with the current token; a 401 asks the token's source once for a different one and
   * retries once with it. */
  const withToken = async (
    request: (bearer: string) => Promise<Response>,
  ): Promise<Response> => {
    const token = await opts.token.current();
    let res: Response;
    try {
      res = await request(token);
      if (res.status !== 401) return res;
      const fresh = await opts.token.refresh(token);
      if (fresh === null) return res;
      await res.body?.cancel();
      return await request(fresh);
    } catch (err) {
      if (err instanceof ForgeApiError) throw err;
      throw new ForgeApiError(`could not reach GitLab at ${opts.url}: ${describe(err)}`, false);
    }
  };

  const call = async (method: string, path: string, body?: unknown): Promise<GitlabResponse> => {
    const res = await withToken((bearer) =>
      send(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    );
    const text = await res.text().catch(() => "");
    let parsed: unknown = {};
    if (text !== "") {
      try {
        parsed = JSON.parse(text) ?? {};
      } catch {
        parsed = {};
      }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  const raw = (path: string, signal: AbortSignal): Promise<Response> =>
    withToken((bearer) =>
      send(`${apiBase}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${bearer}` },
        signal,
      })
    );

  /** When a limit lifts, as GitLab says it: `Retry-After` in seconds, or `RateLimit-Reset` as an
   * epoch second. Clamped to an hour so a nonsense value cannot mute a run for good. */
  const retryAfterFrom = (headers: Headers | undefined): number | null => {
    if (headers === undefined) return null;
    const after = Number(headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return Math.min(after, 3_600) * 1_000;
    const reset = Number(headers.get("ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return null;
    const ms = reset * 1_000 - now();
    return ms > 0 ? Math.min(ms, 3_600_000) : null;
  };

  const inAbout = (ms: number): string => {
    const minutes = Math.ceil(ms / 60_000);
    return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
  };

  const refusal = (
    what: string,
    res: { status: number; body: unknown; headers?: Headers },
  ): ForgeApiError => {
    const limited = res.status === 429;
    const retryAfterMs = limited ? retryAfterFrom(res.headers) : null;
    return new ForgeApiError(
      `${what} failed (${res.status}): ${messageOf(res.body)}${
        retryAfterMs === null ? "" : ` — the limit resets in ${inAbout(retryAfterMs)}`
      }`,
      res.status >= 400 && res.status < 500 && res.status !== 408 && !limited,
      retryAfterMs,
    );
  };

  return {
    apiBase,
    origin,
    call,
    raw,
    send: async (url, init) => {
      try {
        return await send(url, init);
      } catch (err) {
        throw new ForgeApiError(`could not reach GitLab at ${opts.url}: ${describe(err)}`, false);
      }
    },
    refusal,
  };
}

// ---- pagination ------------------------------------------------------------------------------

/** GitLab's next page, off `X-Next-Page` — null at the end (an empty header). */
export function nextPageOf(headers: Headers): number | null {
  const n = Number(headers.get("x-next-page") ?? "");
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GitLab's whole count, off `X-Total` — null where it did not say (above 10 000 it never does),
 * which is never replaced by a guess. */
export function totalOf(headers: Headers): number | null {
  const raw = headers.get("x-total");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Whether a listing page has a successor: GitLab's header where it sent one, else a full page. */
export function hasMore(res: GitlabResponse, perPage: number): boolean {
  if (res.headers.has("x-next-page")) return nextPageOf(res.headers) !== null;
  return Array.isArray(res.body) && res.body.length >= perPage;
}

// ---- spellings -------------------------------------------------------------------------------

/** A thread on GitLab: an issue or a merge request, by its project-local `iid`. */
export interface GitlabThread {
  kind: "issue" | "change_request";
  iid: number;
  /** The wire spelling: `issue-<iid>` or `mr-<iid>`. */
  ref: string;
}

const IID = "([1-9][0-9]{0,18})";

export function threadOf(kind: "issue" | "change_request", iid: number): GitlabThread {
  return { kind, iid, ref: `${kind === "issue" ? "issue" : "mr"}-${iid}` };
}

/**
 * A thread as spelled — `mr-7` / `!7`, `issue-12` / `#12` — or `{bare}` for a bare number, which
 * names an issue or a merge request (two independent number spaces) and is decided by asking.
 * Null for anything that is no GitLab thread.
 */
export function parseThreadSpelling(ref: string): GitlabThread | { bare: number } | null {
  const t = ref.trim();
  const mr = new RegExp(`^(?:!|mr-)${IID}$`).exec(t);
  if (mr !== null) return threadOf("change_request", Number(mr[1]));
  const issue = new RegExp(`^(?:#|issue-)${IID}$`).exec(t);
  if (issue !== null) return threadOf("issue", Number(issue[1]));
  const bare = new RegExp(`^${IID}$`).exec(t);
  return bare === null ? null : { bare: Number(bare[1]) };
}

/** A note, by the handle this adapter gave it: the thread it hangs on, the discussion where it
 * is a diff note's, and the note's own id. */
export interface NoteHandle {
  thread: GitlabThread;
  discussionId: string | null;
  noteId: number;
}

export function noteHandle(thread: GitlabThread, noteId: number | string): string {
  return `${thread.ref}:${noteId}`;
}

export function remarkHandle(
  thread: GitlabThread,
  discussionId: string,
  noteId: number | string,
): string {
  return `${thread.ref}:${discussionId}:${noteId}`;
}

/** Parses `<threadRef>:<noteId>` and `<threadRef>:<discussionId>:<noteId>`; null otherwise. */
export function parseNoteHandle(handle: string): NoteHandle | null {
  const m = new RegExp(`^(issue|mr)-${IID}(?::([0-9a-f]{40}))?:${IID}$`).exec(handle.trim());
  if (m === null) return null;
  return {
    thread: threadOf(m[1] === "mr" ? "change_request" : "issue", Number(m[2])),
    discussionId: m[3] ?? null,
    noteId: Number(m[4]),
  };
}

/** The path segment a thread is reached under. */
export const noteableSegment = (thread: GitlabThread): string =>
  thread.kind === "issue" ? "issues" : "merge_requests";

// ---- the shared context the split files act through ------------------------------------------

/** What every part of the adapter acts through. */
export interface GitlabContext {
  client: GitlabClient;
  /** `RYPH_GITLAB_URL`, normalized. */
  url: string;
  mode: "bot" | "user";
  self: GitlabSelf;
  diag: Diagnostics;
  now: () => number;
  /** The project's API id (its URL-encoded path) — refusing, terminally, a tenant: GitLab has
   * none. */
  project(repo: ForgeRepo): string;
  /** A thread as the caller spelled it, resolved: a bare number is asked about, and refused when
   * it names both an issue and a merge request. */
  resolveThread(repo: ForgeRepo, ref: string): Promise<GitlabThread>;
  /** Where a thread lives on the web. */
  threadUrl(repo: ForgeRepo, thread: GitlabThread): string;
}

// ---- small readers ---------------------------------------------------------------------------

// oxlint-disable-next-line no-explicit-any
export const str = (v: any, fallback = ""): string => typeof v === "string" ? v : fallback;
// oxlint-disable-next-line no-explicit-any
export const num = (v: any): number => typeof v === "number" ? v : 0;

/** Cut with an ellipsis, so a clamped value never reads as the whole one. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** GitLab's `opened` is everyone else's `open`, and so is `locked`: a merge request GitLab holds
 * for the few seconds a merge is underway, which ends merged or back to opened — never an end
 * state. The rest are said as GitLab says them. */
export const stateOf = (state: unknown): string =>
  state === "opened" || state === "locked" ? "open" : str(state, "open");
// ---- quick actions ---------------------------------------------------------------------------

/** What goes in front of a line's `/`: a zero-width space (U+200B). */
const QUICK_ACTION_ESCAPE = "\u200B";

/** Byte-order marks at the very start of a body: GitLab's markdown drops one
 * (`NormalizeSourceFilter`) and reads what follows as the first line, so ryph drops them all. */
const LEADING_BOM = /^\uFEFF+/;
/** What must follow a line's `/` for GitLab to read it as a command (`Extractor#commands_regex`,
 * the same from 17.0 through master: `^\/(?<cmd>NAMES)(?:[ ](?<arg>[^\n]*))?(?:\s*\n|$)`, case
 * insensitive): a command name, then a space or the end of the line. Every name is
 * `[a-z0-9_]`, but Ruby folds case across Unicode (`/cloſe` is `/close`, `/aßign` is `/assign`),
 * so any character past ASCII counts as a name's too, and any ASCII blank ends one. `//`, `/*`,
 * `/ `, `/.`, `/usr/bin` cannot be a command, and pass. */
const COMMAND_AFTER_SLASH = /^[A-Za-z0-9_\u0080-\u{10FFFF}]+(?:[\t\v\f\r ]|$)/u;
/** A line that may be a command: its first character that shows is `/`, behind anything that
 * renders as nothing or as a blank — Unicode's spaces and controls, format characters
 * (zero-width spaces and joiners, the word joiner, a byte-order mark), combining marks,
 * default-ignorables — and what follows the `/` is shaped like a command name. GitLab runs a
 * line only where `/` is its very first character; this reads far wider, on purpose. */
const COMMAND_LINE = new RegExp(
  `^[\\s\\p{Z}\\p{Cc}\\p{Cf}\\p{M}\\p{Default_Ignorable_Code_Point}]*\\/${
    COMMAND_AFTER_SLASH.source.slice(1)
  }`,
  "u",
);
/** A suggestion's info string, decoded: `suggestion`, or with lines above and below
 * (`Gitlab::Diff::SuggestionsParser`: `-A`, `+B`, `-A+B`). Exactly that, lower case. */
const SUGGESTION_INFO = /^suggestion(?::(?:-(\d{1,6}))?(?:\+(\d{1,6}))?)?$/;
/** CommonMark's backslash escapes, and its character references, numeric and named. */
const ESCAPE_OR_REFERENCE =
  /\\([!-/:-@[-`{-~])|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});|&([A-Za-z][A-Za-z0-9]{0,31});/g;

const codePoint = (n: number): string =>
  n === 0 || n > 0x10ffff ? "\uFFFD" : String.fromCodePoint(n);

/** `text` with CommonMark's escapes and numeric references resolved and its named references
 * dropped — which this side does not decode — and whether it held one. */
function resolveReferences(text: string): { text: string; named: boolean } {
  let named = false;
  const out = text.replace(ESCAPE_OR_REFERENCE, (_, esc, hex, dec) => {
    if (esc !== undefined) return esc;
    if (hex !== undefined) return codePoint(parseInt(hex, 16));
    if (dec !== undefined) return codePoint(Number(dec));
    named = true;
    return "";
  });
  return { text: out, named };
}

/** The longest run of backticks in `lines`. */
function longestBacktickRun(lines: string[]): number {
  let longest = 0;
  for (const line of lines) {
    let run = 0;
    for (let i = 0; i < line.length; i++) {
      run = line.charCodeAt(i) === 96 ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

/** `line` with a zero-width space before its `/`, when that is its first character after any
 * blanks and a command name may follow it. */
function escapeSlash(line: string): string {
  let at = 0;
  while (at < line.length && (line[at] === " " || line[at] === "\t")) at++;
  return line[at] === "/" && COMMAND_AFTER_SLASH.test(line.slice(at + 1))
    ? `${line.slice(0, at)}${QUICK_ACTION_ESCAPE}${line.slice(at)}`
    : line;
}

/** An agent's suggestion, as ryph posts it again: lines above and below, and its text. */
interface Suggestion {
  above: number;
  below: number;
  lines: string[];
}

/** The suggestion `lines[i]` opens, when it is one ryph takes out cleanly: a fence at column 0
 * whose info string reads `suggestion` or `suggestion:-A+B` once CommonMark's escapes and
 * numeric references are resolved, closed by its own close. With the index of that close. */
function suggestionAt(lines: string[], i: number): { s: Suggestion; end: number } | null {
  const fence = fenceOpen(lines[i]!, { maxIndent: 0 });
  if (fence === null) return null;
  // The info string as GitLab reads it (`sugg&#101;stion` is `suggestion`); one holding a named
  // reference is one this side cannot vouch for.
  const info = resolveReferences(fence.info);
  const lang = info.named ? null : SUGGESTION_INFO.exec(info.text);
  if (lang === null) return null;
  let end = i + 1;
  while (end < lines.length && !fenceCloses(fence, lines[end]!)) end++;
  if (end === lines.length) return null;
  const s = { above: Number(lang[1] ?? 0), below: Number(lang[2] ?? 0) };
  return { s: { ...s, lines: lines.slice(i + 1, end) }, end };
}

/** Where a body goes: `suggestions` when GitLab finds suggestions in it — a note on a line of a
 * merge request's diff, or a reply in that note's discussion — and false everywhere else. */
export interface InertTarget {
  suggestions: boolean;
}

/**
 * Text ryph writes made inert to GitLab's quick actions. GitLab carries out a `/close`,
 * `/merge`, `/label ~x`, `/approve`, `/assign` … line of a note, a note's edit, a published draft
 * note, and an issue's or merge request's description, AS THE ACCOUNT THAT WROTE IT — ryph's, so
 * an agent's text could act past every grant the tool surface checked. Every body this adapter
 * writes goes through here; titles do not, since GitLab runs no quick action in a title. A
 * leading byte-order mark is dropped from every body, and every line break goes out as `\n` (a
 * lone `\r` is one, as it is to CommonMark; GitLab deletes `\r` before it looks for commands).
 *
 * GitLab (17.0 through master at 19.5, `Gitlab::QuickActions::Extractor#perform_regex`) runs a
 * line only where its SOURCE starts — at its very first character — with `/`, inside a top-level
 * paragraph. Which lines are in one is up to GitLab's markdown, which nothing here models.
 *
 * A line is command-shaped when a command name could follow its `/`: a word character or any
 * character past ASCII, up to an ASCII blank or the line's end (`COMMAND_AFTER_SLASH`). `//`,
 * `/*`, `/ ` and `/usr/bin` never are, so code comments and paths go out untouched.
 *
 * Everywhere but a diff note (descriptions, notes, edits of them, a review's body), EVERY
 * command-shaped line whose first character after any spaces or tabs is `/` gets a zero-width
 * space before that `/`, whatever block it sits in; nothing is refused. The zero-width space
 * renders as nothing; the cost is that a copy of such a line, in a code block too, carries it.
 *
 * A diff note — a note on a line of a merge request's diff, a reply in its discussion, an edit of
 * either (`where.suggestions`) — is where GitLab finds suggestions, whose lines "Apply
 * suggestion" commits; and every round of review found another construct (raw HTML, front
 * matter, a byte-order mark, containers) that makes one where a model of GitLab's markdown saw
 * none, so that an escape in it would be committed. So a diff note is never escaped, and two
 * invariants hold whatever GitLab's markdown makes of it:
 *  - D1: ryph posts the agent's text as written, but for two moves: a byte-order mark at its
 *    start is dropped, and each suggestion it takes out cleanly — a column-0 fence outside any
 *    other fence of the agent's, its info `suggestion` or `suggestion:-A+B` once escapes and
 *    numeric references are resolved, closed by its own close — is posted again first, in a
 *    backtick fence at column 0 of the note's first lines, longer than any backtick run in it,
 *    info `suggestion:-A+B`, its lines as written, blank lines between. At the very start of the
 *    note no container is open and no front matter can begin, so each is top-level code to any
 *    markdown, and nothing in it runs. Whatever else GitLab reads as a suggestion is the agent's
 *    own bytes, so "Apply suggestion" commits exactly what the agent wrote.
 *  - D2: no diff note can run a quick action: one with any command-shaped line outside those
 *    fences whose first character that shows is `/` — behind blanks, zero-width or format
 *    characters, combining marks — is refused, terminally, naming the line. A command line
 *    cannot then exist; `// comment` and `/*` comment lines are posted as written.
 * Everything here is one pass.
 *
 * Verified against the GitLab versions `QUICK_ACTION_ESCAPE_VERIFIED` (gitlab.ts) names; boot
 * warns on a newer one. To re-verify: read `lib/gitlab/quick_actions/extractor.rb` at the
 * release's tag — the rule here holds while a command must start its source line and be a
 * name followed by a space or the line's end — and update `@ryph/fake-gitlab`'s
 * `quick_actions.ts` if the rule moved.
 */
export function inertToQuickActions(text: string, where: InertTarget): string {
  const lines = text.replace(LEADING_BOM, "").replace(/\r\n?/g, "\n").split("\n");
  if (!where.suggestions) return lines.map(escapeSlash).join("\n");
  const suggestions: Suggestion[] = [];
  const prose: string[] = [];
  /** A signed body's footer, which leads it: a refused line is named by the agent's count. */
  const footer = footerLines(lines);
  /** A fence of the agent's own text that is open: a suggestion in it is an example. */
  let open: FenceOpen | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const taken = open === null ? suggestionAt(lines, i) : null;
    if (taken !== null) {
      suggestions.push(taken.s);
      i = taken.end;
      continue;
    }
    if (COMMAND_LINE.test(line)) throw slashLineRefused(i - footer);
    if (open !== null) {
      if (fenceCloses(open, line)) open = null;
    } else {
      open = fenceOpen(line);
    }
    prose.push(line);
  }
  const body = prose.join("\n");
  if (suggestions.length === 0) return body;
  const fenced = suggestions.map((s) => {
    const run = "`".repeat(Math.max(3, longestBacktickRun(s.lines) + 1));
    return [`${run}suggestion:-${s.above}+${s.below}`, ...s.lines, run].join("\n");
  });
  return [...fenced, ...(body.trim() === "" ? [] : [body])].join("\n\n");
}

/** How a diff note must be written on GitLab, said with its refusal. */
const GITLAB_DIFF_NOTE_SHAPE =
  "On GitLab, a line of a review remark or a reply to one may not start with `/` and a word " +
  "(a quick action such as `/merge`) outside a suggestion; `//` and `/*` lines are fine. A " +
  "suggestion must be its own fence at the start of a line (```suggestion or " +
  "```suggestion:-A+B, its lines, then ```).";

function slashLineRefused(line: number): ForgeApiError {
  return new ForgeApiError(
    `line ${line + 1} starts with "/" and a word, which GitLab could carry out as a quick ` +
      `action as ryph's account; ryph posts a note on a diff as written, so it refuses it instead. ` +
      `${GITLAB_DIFF_NOTE_SHAPE} Reword the line, or put the path or command in \`code\`.`,
    true,
  );
}

/** Why `text` cannot be posted as a note on a line of a merge request's diff, or a reply in
 * that note's discussion — null when it can. What a write would refuse, asked before it is
 * spent. */
export function diffNoteProblem(text: string): string | null {
  try {
    inertToQuickActions(text, { suggestions: true });
    return null;
  } catch (err) {
    if (err instanceof ForgeApiError) return err.message;
    throw err;
  }
}
