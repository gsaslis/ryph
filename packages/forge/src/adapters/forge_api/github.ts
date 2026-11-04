// `ForgeApi` on GitHub, with plain fetch — no Octokit, no SDK: a small, fixed surface and a
// hand-rolled client keep the dependency graph empty and the error mapping explicit.
//
// Invariants:
// - Permission checks treat only a DEFINITIVE 404 as "denied". A 403 (suspended installation,
//   rate limit), a 5xx, or a network death is "unknown" — a transient GitHub outage must never
//   read as a revocation.
// - PR opening treats a 422 "already exists" as find-and-adopt: the dangerous failure is a lost
//   response to a successful create. Other 4xx are terminal (retrying a permanent refusal only
//   burns the rate limit); 5xx/429/network are retryable. One more is retryable: posting checks
//   on a commit GitHub has not seen yet (a 422 "No commit found for SHA", or a 404 listing its
//   runs), which a push makes true a moment later.
// - Installation repos are paginated FULLY — a truncated listing reads as "repo not granted"
//   downstream, which is a lie.
// - The API base is injectable so tests run against a fake GitHub — never mock fetch.
//
// Two modes, one adapter (`GithubMode`): as a GitHub App, minting an installation token per
// repo's tenant; or as ONE PERSON, presenting their token (helpers/user_token.ts) for every
// repo, whose tenant is then always null. A repo whose tenant does not fit the mode is a wiring
// fault and terminal either way — an installation id in user mode names a credential this
// process does not hold, and null in App mode names none. In user mode the token is presented
// to GitHub's own origins (the API and web bases) and nowhere else — to git only for the one
// repo's own path — and a 401, from the API or from git, re-reads it from its source once
// (`UserTokenSource.refresh`) and retries the request once.

import type { OrgMembership, Permission } from "../../core/types.ts";
import {
  type ChangeCommit,
  type ChangedFile,
  type ChangeListing,
  type ChangeRequestHead,
  type ChangeRequestState,
  type CheckRun,
  checkSeverity,
  type ChecksReport,
  type ForgeApi,
  ForgeApiError,
  type ForgeRepo,
  type IssueListing,
  type ReportChecksOutcome,
  type ThreadContext,
  type ThreadEntry,
  wholeRepoVisibility,
} from "../../ports/forge_api.ts";
import {
  attachThreadImages,
  type ImageSlot,
  MAX_SLOTS_PER_ENTRY,
} from "../../core/thread_images.ts";
import { downloadImage } from "../../helpers/image_download.ts";
import {
  GITHUB_IMAGE_ORIGINS,
  githubImages,
  isPublishedUpload,
  LEGACY_IMAGE_ORIGIN,
} from "./github_images.ts";
import type {
  GithubAppApi,
  GithubDelivery,
  GithubUserApi,
  RepoListing,
  UserRepoListing,
} from "../../ports/github_app.ts";
import type { UserTokenSource } from "../../helpers/user_token.ts";
import type { AppSubscription, AppSubscriptions } from "../../core/app_subscriptions.ts";
import type { FetchAuth } from "../../ports/repo_cache.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  type AppTokenVendor,
  appTokenVendor,
  importAppKey,
  mintAppJwt,
  TokenMintError,
  type TokenScope,
} from "../../helpers/app_token.ts";

interface GithubCommonOptions {
  /** Base URLs; default to public GitHub. Override for GitHub Enterprise or tests. In user mode
   * their two origins are the only places the user token is ever presented. */
  apiBase?: string;
  oauthBase?: string;
  /** The only origins a thread's images are downloaded from. Defaults to GitHub's upload hosts
   * (`GITHUB_IMAGE_ORIGINS`); tests point it at a fake. */
  imageOrigins?: readonly string[];
  /** Where an upload is asked after by its UUID alone (`isPublishedUpload`). Defaults to
   * https://github.com; tests point it at a fake. */
  uploadBase?: string;
  diag: Diagnostics;
  now?: () => number;
}

/** A GitHub App: installations, scoped tokens, a bot of its own. */
export interface GithubAppOptions extends GithubCommonOptions {
  mode?: "app";
  appId: string;
  /** The App's private key PEM (PKCS#8 or GitHub's PKCS#1 download). */
  privateKeyPem: string;
  /** The App's OAuth client pair — for signing people in and linking their identities. Null
   * where none is configured: the App still acts, and nobody signs in through it. */
  oauth: { clientId: string; clientSecret: string } | null;
}

/** One person's token: no installations, no OAuth client, no bot — the person IS the actor. */
export interface GithubUserOptions extends GithubCommonOptions {
  mode: "user";
  token: UserTokenSource;
}

export type GithubForgeApiOptions = GithubAppOptions | GithubUserOptions;

/** The adapter as an App: every shared method, plus what only an App can answer. */
export type GithubAppForge = ForgeApi & GithubDelivery & GithubAppApi;
/** The adapter as one person: every shared method, plus who that person is and what they can
 * reach. No `GithubAppApi` method exists on it — they are not faked, they are absent. */
export type GithubUserForge = ForgeApi & GithubDelivery & GithubUserApi;

/** The OAuth scopes user mode needs from a classic or `gh` token. `repo` covers contents, pull
 * requests, issues and statuses on private repos too. `workflow` is NOT needed, and is better
 * absent: without it GitHub refuses a push that adds or changes a file under
 * `.github/workflows`. But `gh auth login` over HTTPS commonly grants it, and with it an agent's
 * commit could add or change a workflow GitHub then runs with the repo's secrets — so the boot
 * says so (`holdsWorkflowScope`). */
export const USER_TOKEN_SCOPES = ["repo"] as const;

/** Whether a classic or `gh` token may change `.github/workflows` — GitHub then accepts an
 * agent's commit that adds or changes a workflow. False for a fine-grained token (null scopes), whose
 * `Workflows` permission this header cannot say. */
export function holdsWorkflowScope(scopes: string[] | null): boolean {
  return scopes !== null && scopes.includes("workflow");
}

/** Which of `USER_TOKEN_SCOPES` a token's `X-OAuth-Scopes` lacks. Null scopes (a fine-grained
 * token, which sends no such header) lack nothing this header could say. */
export function missingUserScopes(scopes: string[] | null): string[] {
  if (scopes === null) return [];
  return USER_TOKEN_SCOPES.filter((scope) => !scopes.includes(scope));
}

const API_VERSION = "2022-11-28";

/** The prefix `sourceCommentId` carries for an inline remark: GitHub keeps review comments and
 * conversation comments in two id spaces with two reaction endpoints, and the handle is all
 * `addReaction` is ever handed. A bare id is a conversation comment. */
export const REVIEW_HANDLE = "review:";

/** Pages of 100 per thread endpoint. A thread past this is one nobody reads in full either;
 * the ceiling is REPORTED (`truncated`) rather than hidden, so the prompt can say so. */
const THREAD_PAGE_LIMIT = 5;

/** Characters of comment text a single listing may accumulate. GitHub allows ~65k per
 * comment, so the page ceiling alone bounds a listing at tens of megabytes — held here,
 * serialized to the orchestrator, and parsed again there, to render a fraction of it. */
const LISTING_BUDGET = 200_000;

/** What one entry's text may contribute. Deliberately above the composer's own per-entry
 * clamp: the prompt's shape is the orchestrator's decision, and this is only the bound that
 * keeps a hostile comment from being carried across the wire to be thrown away. */
const ENTRY_BUDGET = 16_000;

/** How many commits one page of a change request's history holds. GitHub lists at most 250
 * commits of a pull request whatever the paging, so this is a page size and not a ceiling. */
const COMMIT_PAGE = 100;

/** What one commit's subject may contribute. A subject line is a sentence; anything past this
 * is someone pasting a body into it. */
const COMMIT_SUMMARY_MAX = 200;

/**
 * What ONE forge-authored string in these sections may contribute.
 *
 * Every one of them is written by whoever pushed the commit or named the check, and a rendering
 * spends a fixed budget on a whole change request: one 200 000-character git author name is all
 * it takes for the timeline and the file list to fall off the end of the read. Clamped HERE,
 * at the boundary, so no consumer has to remember to.
 */
const AUTHOR_MAX = 80;
const CHECK_NAME_MAX = 120;
const CHECK_URL_MAX = 500;
const DATE_MAX = 40;
const SHA_MAX = 64;

/** Cut with an ellipsis, so a clamped value never reads as the whole one. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** How many checks one read REPORTS. Past this the answer is a count rather than a list — and
 * the listing is ORDERED worst first before it is cut, so the cut can never be what hides a
 * red build. */
const CHECKS_MAX = 50;

/**
 * How many checks one read ASKS FOR: GitHub's maximum page, deliberately above `CHECKS_MAX`.
 *
 * A check the forge never listed is in no order at all — it may be the failing build — so it
 * poisons the verdict in a way a check this adapter dropped after sorting does not. Fetching
 * the largest page GitHub will serve is what makes that case rare; reporting it honestly
 * (`unlisted`) is what makes it safe when it happens anyway.
 */
const CHECKS_PAGE = 100;

/** How far GitHub's pull-request commit listing reaches, from the OLDEST end, whatever the
 * paging: past this the tip of the branch is simply not in the listing. Named here because the
 * number decides whether a window may be called "the newest". */
const COMMIT_LISTING_CAP = 250;

/** How long "this installation may not read checks" is believed before it is asked again.
 * Short enough that an operator who adds the permission sees it take effect within a coffee,
 * long enough that an App without it does not pay a refused mint on every change request
 * read. The cache holds the REFUSAL only — a successful read is never cached, because CI state
 * is the one thing on a change request that changes while the agent is looking at it. */
const CHECKS_REFUSAL_TTL_MS = 10 * 60_000;

/** What ryph's own check runs are named: `ryph / <check>`. The name is the key a ruleset
 * requires, so it is fixed here and nowhere else. */
export const CHECK_RUN_PREFIX = "ryph / ";

/** GitHub's cap on a check run's `output.summary`, in characters. */
const CHECK_SUMMARY_MAX = 65_535;

/** How many pages of a commit's check runs the adoption lookup walks. One commit carrying more
 * than a thousand of this App's runs is not a commit anybody is gating a merge on. */
const CHECK_RUN_PAGES = 10;

/**
 * The last page of a paginated listing, off GitHub's `link` header — 1 when there is only one.
 *
 * GitHub is the only thing that knows how long a listing is without walking it, and it says so
 * exactly once: in `link`, as `rel="last"`. Parsing it is what lets the newest end of a long
 * history be read in a second request instead of seven.
 */
function lastPageOf(headers: Headers | undefined): number {
  const link = headers?.get("link");
  if (!link) return 1;
  for (const part of link.split(",")) {
    if (!/rel="last"/.test(part)) continue;
    const page = Number(part.match(/[?&]page=(\d+)/)?.[1]);
    if (Number.isInteger(page) && page > 0) return page;
  }
  return 1;
}

/** One paginated listing of a thread, and whether the ceiling cut it short. */
interface Listing {
  entries: ThreadEntry[];
  truncated: boolean;
}

/** What acting as an App takes: its id and key (for its own JWT), its OAuth client pair (null
 * where none is configured), and the vendor that mints installation tokens with them. */
interface AppAuth {
  id: string;
  key: CryptoKey;
  oauth: { clientId: string; clientSecret: string } | null;
  vendor: AppTokenVendor;
}

/**
 * Await all three listings and the pull request's head, but let the VERDICT win rather than
 * the race.
 *
 * `Promise.all` rejects with whichever failed first, so a deletion discovered by one listing
 * could arrive dressed as whatever transient failure another hit a millisecond earlier — and
 * then be retried until the queue gave up on a thread that no longer exists. A terminal
 * failure is the truth about the thread, so it takes precedence over a timing accident.
 */
async function settleThread(
  conversation: Promise<Listing>,
  reviews: Promise<Listing>,
  inline: Promise<Listing>,
  pull: Promise<ChangeRequestHead | null>,
): Promise<
  { conversation: Listing; reviews: Listing; inline: Listing; pull: ChangeRequestHead | null }
> {
  const [c, r, i, p] = await Promise.allSettled([conversation, reviews, inline, pull]);
  const failures = [c, r, i, p].flatMap((s) => s.status === "rejected" ? [s.reason] : []);
  const worst = failures.find((e) => e instanceof ForgeApiError && e.terminal) ?? failures.at(0);
  if (worst !== undefined) throw worst;

  // Unreachable past the throw above — every rejection is already accounted for — but the
  // narrowing is free and beats asserting it away.
  const value = <T>(s: PromiseSettledResult<T>): T => {
    if (s.status === "rejected") throw s.reason;
    return s.value;
  };
  return { conversation: value(c), reviews: value(r), inline: value(i), pull: value(p) };
}

export function githubForgeApi(opts: GithubAppOptions): Promise<GithubAppForge>;
export function githubForgeApi(opts: GithubUserOptions): Promise<GithubUserForge>;
export async function githubForgeApi(
  opts: GithubForgeApiOptions,
): Promise<GithubAppForge | GithubUserForge> {
  const { diag } = opts;
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const oauthBase = (opts.oauthBase ?? "https://github.com").replace(/\/+$/, "");
  const now = opts.now ?? Date.now;
  const imageOrigins = opts.imageOrigins ?? GITHUB_IMAGE_ORIGINS;
  /** The App's credentials — null in user mode, where nothing App-shaped exists. */
  const app: AppAuth | null = opts.mode === "user" ? null : await (async () => {
    const key = await importAppKey(opts.privateKeyPem);
    return {
      id: opts.appId,
      key,
      oauth: opts.oauth,
      vendor: appTokenVendor({ appId: opts.appId, key, apiBase, diag, now }),
    };
  })();
  /** The person's token — null in App mode. */
  const userToken = opts.mode === "user" ? opts.token : null;
  /**
   * GitHub's own origins: the REST base and the web base, which is where a clone URL points.
   * The ONLY places a user token is presented — to the API by `gh`, to git by `fetchAuth` and
   * `pushAuth`. A connected repo's URL comes from GitHub's own answer, so a URL elsewhere is a
   * row nobody should have, and it is fetched as nobody rather than handed the token.
   */
  const githubOrigins = new Set([new URL(apiBase).origin, new URL(oauthBase).origin]);
  /** Installations that answered "you may not read checks", and until when that is believed. */
  const checksRefused = new Map<string, { reason: string; untilMs: number }>();

  /**
   * One request, with the token in its header. In user mode a redirect is followed by hand and
   * only while it stays on GitHub's origins: the token is the person's whole account, and a
   * redirect is the one way a request built for GitHub could carry it somewhere else.
   */
  const send = async (
    url: string,
    init: RequestInit & { headers: Record<string, string> },
    follow: boolean,
  ): Promise<Response> => {
    if (userToken === null) {
      return await fetch(url, { ...init, redirect: follow ? "follow" : "manual" });
    }
    let at = url;
    let req = init;
    for (let hop = 0;; hop++) {
      const res = await fetch(at, { ...req, redirect: "manual" });
      const location = res.headers.get("location");
      if (!follow || res.status < 300 || res.status > 399 || location === null || hop >= 5) {
        return res;
      }
      const next = new URL(location, at);
      if (!githubOrigins.has(next.origin)) {
        diag.warn("github.redirect_refused", { origin: next.origin });
        return res;
      }
      await res.body?.cancel();
      at = next.href;
      // 303 is always a GET; 301 and 302 turn a POST into one as browsers do; 307 and 308 keep
      // the method and the body.
      if (
        res.status === 303 || ((res.status === 301 || res.status === 302) && req.method !== "GET")
      ) {
        const { "content-type": _, ...headers } = req.headers;
        req = { ...req, method: "GET", body: undefined, headers };
      }
    }
  };

  /**
   * A 401 in user mode: the token may have been rotated under us (`gh auth refresh`), so its
   * source is asked again — once, shared with every other request that hit the same 401 — and
   * the request retried once with what comes back. Null: nothing new to retry with, and the
   * 401 stands. Never a loop: the retry's own answer is final.
   */
  const refreshed = async (status: number, stale: string): Promise<string | null> =>
    status === 401 && userToken !== null ? await userToken.refresh(stale) : null;

  /** One GitHub call: returns status + parsed body, throws only on network death. */
  const gh = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
    opts: { redirect?: RequestInit["redirect"]; accept?: string } = {},
    // oxlint-disable-next-line no-explicit-any
  ): Promise<{ status: number; body: any; headers: Headers }> => {
    const once = async (bearer: string) => {
      const res = await send(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: opts.accept ?? "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }, (opts.redirect ?? "follow") === "follow");
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) ?? {},
        headers: res.headers,
      };
    };
    const first = await once(token);
    const fresh = await refreshed(first.status, token);
    return fresh === null ? first : await once(fresh);
  };

  const message = (body: { message?: unknown }): string =>
    typeof body.message === "string" ? body.message : "no detail";

  const describe = (err: unknown): string => err instanceof Error ? err.message : String(err);

  /** A GET whose failure is an ANSWER: status 0 for a network death, so a caller that degrades
   * a section rather than failing its read has one shape to read. Only for reads that are
   * garnish — everything else wants the throw. */
  const tryGet = async (
    token: string,
    path: string,
    // oxlint-disable-next-line no-explicit-any
  ): Promise<{ status: number; body: any; headers?: Headers }> => {
    try {
      return await gh(token, "GET", path);
    } catch (err) {
      return { status: 0, body: { message: describe(err) } };
    }
  };

  /** GraphQL's endpoint beside the REST base: `/graphql` on github.com, and `/api/graphql` on
   * an Enterprise server whose REST base is `/api/v3`. */
  const graphqlUrl = apiBase.endsWith("/api/v3")
    ? `${apiBase.slice(0, -"/v3".length)}/graphql`
    : `${apiBase}/graphql`;

  /**
   * One GraphQL call — only for what REST cannot do: a review thread's resolution lives nowhere
   * else. Answers `data`, and throws a `ForgeApiError` for anything else. GraphQL reports most
   * refusals as a 200 carrying `errors`; a NOT_FOUND or FORBIDDEN among them is as final as a
   * REST 404, and anything else is left retryable.
   */
  const graphql = async (
    token: string,
    what: string,
    query: string,
    variables: object,
    // oxlint-disable-next-line no-explicit-any
  ): Promise<any> => {
    const once = (bearer: string) =>
      send(graphqlUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      }, true);
    let res = await once(token);
    const fresh = await refreshed(res.status, token);
    if (fresh !== null) {
      await res.body?.cancel();
      res = await once(fresh);
    }
    const body = (await res.json().catch(() => null)) ?? {};
    if (res.status !== 200) throw refusal(what, { status: res.status, body, headers: res.headers });
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      // oxlint-disable-next-line no-explicit-any
      const errors = body.errors as any[];
      const detail = errors.map((e) => typeof e?.message === "string" ? e.message : "?").join("; ");
      const final = errors.some((e) => e?.type === "NOT_FOUND" || e?.type === "FORBIDDEN");
      throw new ForgeApiError(`${what} failed: ${detail}`, final);
    }
    if (body?.data == null) throw new ForgeApiError(`${what}: the forge answered no data`, false);
    return body.data;
  };

  /**
   * Who the user token acts as, and what a classic token may do — read ONCE, here, so a bad
   * token fails the construction (and so the boot) loudly rather than the first run quietly.
   * The scopes come from `X-OAuth-Scopes`, which only a classic or `gh` token sends.
   */
  const user = userToken === null ? null : await (async () => {
    const token = await userToken.current();
    let res: Awaited<ReturnType<typeof gh>>;
    try {
      res = await gh(token, "GET", "/user");
    } catch (err) {
      // A network death says only "fetch failed"; the operator needs to know WHERE it was
      // dialled, since a wrong `RYPH_GITHUB_API` and a machine offline read the same.
      throw new ForgeApiError(`could not reach GitHub at ${apiBase}: ${describe(err)}`, false);
    }
    if (res.status !== 200 || typeof res.body?.login !== "string" || res.body.login === "") {
      throw new ForgeApiError(
        `GitHub did not say whose token this is (GET /user answered ${res.status}: ${
          message(res.body)
        })`,
        res.status === 401 || res.status === 403,
      );
    }
    const header = res.headers.get("x-oauth-scopes");
    return {
      login: res.body.login as string,
      scopes: header === null
        ? null
        : header.split(",").map((scope) => scope.trim()).filter((scope) => scope !== ""),
    };
  })();

  /**
   * GitHub's coordinates behind an opaque `ForgeRepo`. This is the edge the port's two opaque
   * strings are spelled at: `repoRef` IS "owner/name", and the tenant is WHO acts — an App
   * installation in App mode, and null in user mode, where the one token acts on every repo.
   * A tenant that does not fit the mode is a wiring fault, and terminal: no retry turns an
   * installation id into a credential a user-mode forge holds, or conjures one in App mode.
   * `installationId` comes back null exactly in user mode.
   */
  const coords = (repo: ForgeRepo): { installationId: string | null; repoFullName: string } => {
    if (user !== null) {
      if (repo.tenantId !== null) {
        throw new ForgeApiError(
          `${repo.repoRef} names a GitHub App installation, but this forge acts as ` +
            `@${user.login} with a user token — App mode or user mode, never both`,
          true,
        );
      }
      return { installationId: null, repoFullName: repo.repoRef };
    }
    if (repo.tenantId === null) {
      throw new ForgeApiError(
        `${repo.repoRef} names no GitHub installation to act as`,
        true,
      );
    }
    return { installationId: repo.tenantId, repoFullName: repo.repoRef };
  };

  /** The whole credential a tenant acts with: its installation's token, or the user token.
   * Only ever handed what `coords` answered, so the mismatch below is that guard restated. */
  const tokenFor = (installationId: string | null): Promise<string> => {
    if (app !== null && installationId !== null) {
      return app.vendor.installationToken(installationId);
    }
    if (userToken !== null && installationId === null) return userToken.current();
    return Promise.reject(new ForgeApiError("a GitHub tenant that fits neither mode", true));
  };

  /** The other edge: a thread's ref is text on the port and an integer on GitHub. Anything
   * that is not a positive integer names no thread here, and no retry makes it one. */
  const threadNumber = (ref: string): number => {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1) {
      throw new ForgeApiError(`${JSON.stringify(ref)} is not a GitHub thread number`, true);
    }
    return n;
  };

  /**
   * A token for ONE repo and only the permissions a tool call spends — door ⑤'s every call. The
   * installation's own ceiling still applies; this only ever narrows it.
   *
   * In user mode it narrows NOTHING: GitHub cannot mint a narrower token from a person's, so
   * this answers the user token itself, with everything that person may do on every repo they
   * reach. The tool surface's grant checks — which repo, which capability, how many times — are
   * then the only fence on a tool call. That is the price of user mode, said here rather than
   * hidden behind a function whose name promises otherwise.
   */
  const scoped = (
    installationId: string | null,
    repos: string | string[],
    permissions: TokenScope["permissions"],
  ): Promise<string> => {
    // `tokenFor` refuses the pairs that fit no mode; only an App with an installation narrows.
    if (installationId === null || app === null) return tokenFor(installationId);
    const repositories = (Array.isArray(repos) ? repos : [repos]).map((fullName) => {
      const [, name] = fullName.split("/");
      // Every name here comes from a grant or a connected repo row, so this cannot happen today;
      // if it did, GitHub would answer a token request for `[null]` with an unnamed 422.
      if (!name) throw new Error(`not an owner/name repo full name: ${fullName}`);
      return name;
    });
    return app.vendor.installationToken(installationId, { repositories, permissions });
  };

  /**
   * When a rate limit lifts, as GitHub reports it two ways: `retry-after` in seconds (a secondary
   * limit) and `x-ratelimit-reset` as an epoch second (the primary one). Nothing is guessed — no
   * header, no claim — and both are clamped to an hour so a nonsense value cannot mute a run for
   * the rest of its life.
   */
  const retryAfterFrom = (headers: Headers | undefined): number | null => {
    if (headers === undefined) return null;
    const after = Number(headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return Math.min(after, 3_600) * 1_000;
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return null;
    const ms = reset * 1_000 - now();
    return ms > 0 ? Math.min(ms, 3_600_000) : null;
  };

  const inAbout = (ms: number): string => {
    const minutes = Math.ceil(ms / 60_000);
    return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
  };

  /** A refusal that says whether asking again could help: a 4xx cannot, except a rate limit
   * (429, or GitHub's 403 that says so) and a timeout; a 5xx or a malformed 2xx may. A rate
   * limit also says WHEN, where GitHub named a reset — "try again shortly" is the one piece of
   * advice that must not be given to an agent whose installation is already exhausted. */
  const refusal = (
    what: string,
    res: { status: number; body: { message?: unknown }; headers?: Headers },
  ) => {
    const text = message(res.body);
    const limited = res.status === 429 ||
      (res.status === 403 && /rate limit/i.test(text));
    const retryAfterMs = limited ? retryAfterFrom(res.headers) : null;
    return new ForgeApiError(
      `${what} failed (${res.status}): ${text}${
        retryAfterMs === null ? "" : ` — the limit resets in ${inAbout(retryAfterMs)}`
      }`,
      res.status >= 400 && res.status < 500 && res.status !== 408 && !limited,
      retryAfterMs,
    );
  };

  /** The permission a thread's conversation is written with — a pull request's is its own. */
  const threadPermission = (kind: "issue" | "change_request"): TokenScope["permissions"] =>
    kind === "change_request" ? { pull_requests: "write" } : { issues: "write" };

  /** Where a thread lives on the web, for answers the API does not carry a URL in. */
  const threadUrl = (repoFullName: string, kind: "issue" | "change_request", n: number) =>
    `${oauthBase}/${repoFullName}/${kind === "change_request" ? "pull" : "issues"}/${n}`;

  // oxlint-disable-next-line no-explicit-any
  const str = (v: any, fallback = ""): string => typeof v === "string" ? v : fallback;
  // oxlint-disable-next-line no-explicit-any
  const num = (v: any): number => typeof v === "number" ? v : 0;

  /** A pull request's head, as it stands. Shared by the thread read (what to check out) and
   * the submit path (is it still there to push onto). */
  const readPull = async (
    token: string,
    repoFullName: string,
    n: number,
  ): Promise<ChangeRequestHead> => {
    const res = await gh(token, "GET", `/repos/${repoFullName}/pulls/${n}`);
    if (res.status !== 200) {
      throw new ForgeApiError(
        `reading pull request ${repoFullName}#${n} failed (${res.status}): ${message(res.body)}`,
        res.status === 404 || res.status === 410,
      );
    }
    // Every field read here authorizes a push onto somebody's branch, so none of them is
    // defaulted. A 200 that does not say whether the pull request is open, or where its head
    // and its repo's default branch are, is a malformed answer to retry — never an open,
    // same-repo pull request by assumption.
    const body = res.body;
    const head = body?.head;
    const state = body?.state;
    const defaultBranch = body?.base?.repo?.default_branch;
    const baseRef = body?.base?.ref;
    if (
      (state !== "open" && state !== "closed") ||
      typeof body.merged !== "boolean" ||
      typeof body.html_url !== "string" ||
      typeof head?.ref !== "string" ||
      typeof head?.sha !== "string" ||
      typeof baseRef !== "string" ||
      typeof defaultBranch !== "string"
    ) {
      throw new ForgeApiError(
        `reading pull request ${repoFullName}#${n}: the forge's answer is missing fields`,
        false,
      );
    }
    return {
      ref: String(n),
      url: body.html_url,
      state,
      merged: body.merged,
      headRef: head.ref,
      headSha: head.sha,
      // A pull request has one head, moved only through its head branch.
      authorHeadSha: head.sha,
      baseRef,
      // GitHub answers `repo: null` once a fork is deleted — the branch is unreachable, and
      // saying null keeps that from reading as "same repo".
      headRepoRef: typeof head.repo?.full_name === "string" ? head.repo.full_name : null,
      // What a push onto a fork's branch needs (change_transport/github.ts); never consulted for
      // a same-repo pull request, whose branch is pushed through the connected repo's own URL.
      headRepoUrl: typeof head.repo?.clone_url === "string" ? head.repo.clone_url : null,
      headRepoDefaultBranch: typeof head.repo?.default_branch === "string"
        ? head.repo.default_branch
        : null,
      // Anything but a plain true is no: the switch is the fork author's consent.
      maintainerCanModify: body.maintainer_can_modify === true,
      // Not validated like the rest: a missing count costs a history note, never a push.
      commitCount: typeof body.commits === "number" ? body.commits : null,
      defaultBranch,
    };
  };

  /**
   * The login this App's own writes appear under — `<slug>[bot]`, the slug read once from
   * `GET /app` (an App JWT, so no installation's rate limit is spent) and kept for the life of
   * the process: a slug changes only when the App is renamed, and a rename re-deploys. A failed
   * read is forgotten, so the next caller asks again rather than inheriting the failure.
   */
  let botLogin: Promise<string> | null = null;
  const appBotLogin = (app: AppAuth): Promise<string> => {
    botLogin ??= (async () => {
      const jwt = await mintAppJwt(app.id, app.key, now());
      const res = await gh(jwt, "GET", "/app");
      if (res.status !== 200 || typeof res.body?.slug !== "string" || res.body.slug === "") {
        throw new ForgeApiError(
          `reading this App's identity failed (${res.status}): ${message(res.body)}`,
          false,
        );
      }
      return `${res.body.slug}[bot]`.toLowerCase();
    })().catch((err) => {
      botLogin = null;
      throw err;
    });
    return botLogin;
  };

  /** A pull request's head and fate in ONE read — what a push event is checked against, on the
   * delivery queue every other GitHub write waits behind. Null for a pull request that is not
   * there (404, 410). */
  const pullState = async (
    token: string,
    repoFullName: string,
    n: number,
  ): Promise<ChangeRequestState | null> => {
    const res = await gh(token, "GET", `/repos/${repoFullName}/pulls/${n}`);
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) throw refusal(`reading pull request ${repoFullName}#${n}`, res);
    const body = res.body;
    const state = body?.state;
    const headSha = body?.head?.sha;
    const baseRef = body?.base?.ref;
    const author = body?.user;
    if (
      (state !== "open" && state !== "closed") ||
      typeof body.merged !== "boolean" ||
      typeof headSha !== "string" ||
      typeof baseRef !== "string"
    ) {
      throw new ForgeApiError(
        `reading pull request ${repoFullName}#${n}: the forge's answer is missing fields`,
        false,
      );
    }
    // As an App: only a Bot account can be the App, and only the App's own bot carries its
    // slug — a person whose login happens to end in "[bot]" cannot exist (GitHub refuses the
    // brackets). As a person: whatever this token opened is ours, and so — unavoidably — is
    // anything that person opened by hand, because on GitHub the two are the same author.
    const authorLogin = typeof author?.login === "string" ? author.login.toLowerCase() : null;
    const openedByUs = authorLogin !== null && (
      user !== null
        ? authorLogin === user.login.toLowerCase()
        : app !== null && author.type === "Bot" && authorLogin === await appBotLogin(app)
    );
    return {
      ref: String(n),
      state,
      merged: body.merged,
      headSha,
      // A pull request has one head, moved only through its head branch.
      authorHeadSha: headSha,
      baseRef,
      openedByUs,
      // A merged pull request's head is frozen at the merge: a push to its branch after it moves
      // the branch, never the pull request.
      mergedHeads: body.merged ? [headSha] : [],
    };
  };

  /**
   * A pull request's review threads, keyed by the database id of the remark that opens each —
   * the id REST names a remark by, and the only key the two APIs share. Walked to the end: a
   * thread missing from a cut-short walk would read as "no such thread", which is a lie.
   * `complete` is false where the page ceiling bit first.
   */
  const reviewThreads = async (
    token: string,
    repoFullName: string,
    n: number,
  ): Promise<{ threads: Map<string, { id: string; resolved: boolean }>; complete: boolean }> => {
    const [owner, name] = repoFullName.split("/");
    const threads = new Map<string, { id: string; resolved: boolean }>();
    let after: string | null = null;
    for (let page = 1; page <= THREAD_PAGE_LIMIT; page++) {
      const data = await graphql(
        token,
        `reading the review threads of ${repoFullName}#${n}`,
        `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { id isResolved comments(first: 1) { nodes { fullDatabaseId } } }
              }
            }
          }
        }`,
        { owner, name, number: n, after },
      );
      const listing = data?.repository?.pullRequest?.reviewThreads;
      if (!Array.isArray(listing?.nodes)) {
        throw new ForgeApiError(
          `reading the review threads of ${repoFullName}#${n}: the forge's answer is missing fields`,
          false,
        );
      }
      for (const node of listing.nodes) {
        // databaseId is a deprecated GraphQL Int: newer comment IDs exceed its 32 bits.
        // BigInt is serialized as a decimal string; accept safe JSON numbers too.
        const root = node?.comments?.nodes?.[0]?.fullDatabaseId;
        if (
          typeof node?.id !== "string" ||
          !(typeof root === "string" && /^[1-9]\d*$/.test(root) ||
            typeof root === "number" && Number.isSafeInteger(root) && root > 0)
        ) continue;
        threads.set(String(root), { id: node.id, resolved: node.isResolved === true });
      }
      if (listing.pageInfo?.hasNextPage !== true) return { threads, complete: true };
      after = str(listing.pageInfo.endCursor) || null;
      if (after === null) return { threads, complete: false };
    }
    return { threads, complete: false };
  };

  /** A review comment's id as REST takes it: a positive integer, or no remark at all. */
  const remarkNumber = (id: string): number => {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) {
      throw new ForgeApiError(`${JSON.stringify(id)} is not a GitHub review comment id`, true);
    }
    return n;
  };

  /**
   * The remark that opens the review thread `commentId` belongs to — read, and checked to be ON
   * pull request `n`, before anything is written to it. Two reasons. The grant was checked
   * against the THREAD the call named, and a remark id is global to the repo, so an unchecked
   * one would let a run scoped to #12 write into #13. And GitHub replies only to the remark that
   * opens a thread — a reply to a reply is refused — so an agent naming the remark it is
   * answering, which is the natural thing to name, is followed up to its root.
   */
  const threadRoot = async (
    token: string,
    repoFullName: string,
    n: number,
    commentId: string,
  ): Promise<number> => {
    const id = remarkNumber(commentId);
    const res = await gh(token, "GET", `/repos/${repoFullName}/pulls/comments/${id}`);
    if (res.status !== 200) {
      throw res.status === 404
        ? new ForgeApiError(`${repoFullName} has no review comment ${id}`, true)
        : refusal(`reading review comment ${id} of ${repoFullName}`, res);
    }
    const onPull = str(res.body?.pull_request_url).match(/\/pulls\/(\d+)$/)?.[1];
    if (onPull !== String(n)) {
      throw new ForgeApiError(
        `review comment ${id} is not on ${repoFullName}#${n}${
          onPull === undefined ? "" : ` (it is on #${onPull})`
        }`,
        true,
      );
    }
    return typeof res.body?.in_reply_to_id === "number" ? res.body.in_reply_to_id : id;
  };

  /**
   * Whether the user token may be presented to `url` for `repoRef`: GitHub's own origin AND that
   * repo's own path — `/owner/name` or `/owner/name.git`, in any case, with nothing else on it.
   * The origin alone is not enough in user mode: the token reaches every repo the person can
   * see, so a row whose URL named another repo on GitHub would be fetched, or pushed to, as that
   * person.
   *
   * The URL must be canonical as written: git sends the RAW string, not the WHATWG-normalised
   * one, so `/other/x/%2e%2e/%2e%2e/acme/app`, `acme\app` or `acme/./app` — which normalise to
   * the right path — would reach some other path on the wire. A URL that parsing would change
   * at all (and any percent-escape, which a GitHub repo path never needs) is refused.
   */
  const isRepoUrl = (url: string, repoRef: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!githubOrigins.has(parsed.origin)) return false;
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return false;
    if (parsed.hash !== "") return false;
    if (parsed.href !== url || url.includes("%")) return false;
    const path = parsed.pathname.toLowerCase();
    const want = `/${repoRef.toLowerCase()}`;
    return path === want || path === `${want}.git`;
  };

  /**
   * The user token as a git credential for `origin`, renewable: git's 401 asks the token's
   * source once (`FetchAuth.refresh`), single-flight with every REST call's 401, and the
   * renewed credential carries no `refresh` of its own — one retry, never a loop.
   */
  const userGitAuth = async (source: UserTokenSource, origin: string): Promise<FetchAuth> => {
    const token = await source.current();
    return {
      origin,
      token,
      refresh: async () => {
        const fresh = await source.refresh(token);
        return fresh === null ? null : { origin, token: fresh };
      },
    };
  };

  const shared: ForgeApi & GithubDelivery = {
    async fetchAuth(repo, url): Promise<FetchAuth | null> {
      // Nothing to present it to: an upstream that is a path (dev and tests) has no header to
      // scope a credential to.
      if (!/^https?:\/\//.test(url)) return null;
      if (userToken !== null) {
        coords(repo); // an installation id here is a wiring fault, refused like everywhere else
        if (!isRepoUrl(url, repo.repoRef)) {
          // Fetched as nobody: a public repo still clones, and the person's token is never
          // offered to a host that is not GitHub, or for a repo this row is not.
          diag.warn("github.user_token_withheld", {
            repo: repo.repoRef,
            origin: new URL(url).origin,
          });
          return null;
        }
        return await userGitAuth(userToken, new URL(url).origin);
      }
      // Nothing to present: a repo nobody granted us.
      if (repo.tenantId === null) return null;
      return {
        origin: new URL(url).origin,
        token: await tokenFor(repo.tenantId),
      };
    },

    async pushAuth(repo, url): Promise<FetchAuth | null> {
      const { installationId } = coords(repo);
      if (!/^https?:\/\//.test(url)) return null;
      const origin = new URL(url).origin;
      if (userToken !== null) {
        if (!isRepoUrl(url, repo.repoRef)) {
          throw new ForgeApiError(
            `${repo.repoRef}'s upstream ${origin}${new URL(url).pathname} is not that repo on ` +
              "GitHub — a user token is presented to GitHub, for the repo it was asked about, " +
              "and nowhere else",
            true,
          );
        }
        return await userGitAuth(userToken, origin);
      }
      return { origin, token: await tokenFor(installationId) };
    },

    upstreamUrl(_repo, url) {
      // GitHub IS a git host: the connected repo's clone URL is already the answer, and
      // nothing here derives one.
      return url;
    },

    async describeChangeRequest(repo, ref) {
      const { installationId, repoFullName } = coords(repo);
      return await readPull(
        await tokenFor(installationId),
        repoFullName,
        threadNumber(ref),
      );
    },

    async readChangeRequestState(repo, ref) {
      const { installationId, repoFullName } = coords(repo);
      return await pullState(
        await tokenFor(installationId),
        repoFullName,
        threadNumber(ref),
      );
    },

    async classifyBranch(repo, branch) {
      // `refs/pull/<n>/head` and `/merge` are cached as `pull/<n>/…`. They are the only names
      // here that can hold somebody else's commits: every other branch the cache is asked for
      // lives in the connected repo itself, and only its writers can move it.
      const pull = /^pull\/(\d+)\/(?:head|merge)$/.exec(branch);
      if (pull === null) return "branch";
      const { installationId, repoFullName } = coords(repo);
      const head = await readPull(
        await tokenFor(installationId),
        repoFullName,
        threadNumber(pull[1]),
      );
      // GitHub spells repos case-insensitively; a deleted fork (null) is nobody's own.
      return head.headRepoRef?.toLowerCase() === repoFullName.toLowerCase() ? "branch" : "foreign";
    },

    async checkPermission(repo, subject, atLeast): Promise<Permission> {
      const { installationId, repoFullName } = coords(repo);
      // GitHub has no permissionless rung: both tiers are a grant somebody deliberately made
      // to a named account, so "may nobody in particular?" is answerable here without asking
      // GitHub anything, and the answer is no. Refused before the URL is built on purpose — a
      // null interpolated into `/collaborators/…` would ask about a user literally named
      // "null", and GitHub would answer about them.
      if (subject === null) return "denied";
      const login = subject;
      try {
        const token = await tokenFor(installationId);
        // In user mode the question is nearly always about the token's own login, and GitHub
        // answers that one on the repo itself (`permissions`, as the caller sees them) — where
        // the collaborator endpoint would refuse a person with read access a 403, which reads as
        // "unknown" rather than the "denied" it is.
        if (user !== null && login.toLowerCase() === user.login.toLowerCase()) {
          const res = await gh(token, "GET", `/repos/${repoFullName}`);
          const held = res.body?.permissions;
          if (res.status === 200 && typeof held?.push === "boolean") {
            const allowed = atLeast === "admin"
              ? held.admin === true
              : held.push || held.admin === true;
            return allowed ? "allowed" : "denied";
          }
          if (res.status === 404) return "denied"; // definitively: not a repo this person sees
          diag.warn("github.permission_unanswerable", { repo: repoFullName, status: res.status });
          return "unknown";
        }
        const res = await gh(
          token,
          "GET",
          `/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`,
        );
        if (res.status === 200) {
          const level = res.body?.permission;
          const allowed = atLeast === "admin"
            ? level === "admin"
            : level === "admin" || level === "write";
          return allowed ? "allowed" : "denied";
        }
        if (res.status === 404) return "denied"; // definitively: not a collaborator
        // 403 (suspended installation, rate limit), 5xx — unanswerable, never a revocation.
        diag.warn("github.permission_unanswerable", { repo: repoFullName, status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("github.permission_unreachable", { repo: repoFullName, err: String(err) });
        return "unknown";
      }
    },

    async openPullRequest(repo, params) {
      const { installationId, repoFullName } = coords(repo);
      const token = await tokenFor(installationId);
      const created = await gh(token, "POST", `/repos/${repoFullName}/pulls`, {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft,
        maintainer_can_modify: true,
      });
      if (created.status === 201) {
        return { number: created.body.number, url: created.body.html_url };
      }

      // 422 usually means "a pull request already exists for head" — the retry-after-lost-
      // response case this method exists to make safe. Find it and adopt it.
      if (created.status === 422) {
        const owner = repoFullName.split("/")[0];
        const open = await gh(
          token,
          "GET",
          `/repos/${repoFullName}/pulls?state=open&head=${
            encodeURIComponent(`${owner}:${params.head}`)
          }`,
        );
        // Only one opened against the SAME base: a pull request with this head into another base
        // is not the one this call would have opened, and adopting it would hand the patch to a
        // change request somebody else aimed elsewhere.
        const same = open.status === 200 && Array.isArray(open.body)
          ? (open.body as Array<{ number: number; html_url: string; base?: { ref?: unknown } }>)
            .find((pr) => pr.base?.ref === params.base)
          : undefined;
        if (same !== undefined) {
          diag.debug("github.pr_adopted", { repo: repoFullName, number: same.number });
          return { number: same.number, url: same.html_url };
        }
        // A real 422 (e.g. "no commits between base and head") — retrying cannot help.
        throw new ForgeApiError(`GitHub refused the PR (422): ${message(created.body)}`, true);
      }

      const terminal = created.status >= 400 && created.status < 500 &&
        created.status !== 429 && created.status !== 408;
      throw new ForgeApiError(
        `GitHub answered ${created.status}: ${message(created.body)}`,
        terminal,
      );
    },

    async postComment(repo, thread, body) {
      // Issues and PRs share the comments endpoint — a PR is an issue with code attached.
      const { installationId, repoFullName } = coords(repo);
      const token = await tokenFor(installationId);
      const res = await gh(
        token,
        "POST",
        `/repos/${repoFullName}/issues/${threadNumber(thread.ref)}/comments`,
        { body },
      );
      if (res.status !== 201 || res.body?.id === undefined) {
        throw new Error(`posting a comment failed (${res.status}): ${message(res.body)}`);
      }
      return { commentId: String(res.body.id) };
    },

    async updateComment(repo, commentId, body) {
      const { installationId, repoFullName } = coords(repo);
      const token = await tokenFor(installationId);
      const res = await gh(
        token,
        "PATCH",
        `/repos/${repoFullName}/issues/comments/${encodeURIComponent(commentId)}`,
        { body },
      );
      if (res.status !== 200) {
        throw new Error(
          `updating comment ${commentId} failed (${res.status}): ${message(res.body)}`,
        );
      }
    },

    async addReaction(repo, commentId, reaction) {
      const { installationId, repoFullName } = coords(repo);
      const token = await tokenFor(installationId);
      const path = commentId.startsWith(REVIEW_HANDLE)
        ? `/repos/${repoFullName}/pulls/comments/${
          encodeURIComponent(commentId.slice(REVIEW_HANDLE.length))
        }/reactions`
        : `/repos/${repoFullName}/issues/comments/${encodeURIComponent(commentId)}/reactions`;
      const res = await gh(token, "POST", path, { content: reaction });
      // 201 created it; 200 says it was already there — the retried-after-lost-response case,
      // and a success by this method's own contract.
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `reacting to comment ${commentId} failed (${res.status}): ${message(res.body)}`,
        );
      }
    },

    async fetchThread(repo, thread, readOpts): Promise<ThreadContext> {
      // Reads only: a token for this repo's issues and pull requests, whoever asks — the
      // orchestrator composing a commanded run, or an agent's get_issue.
      const { installationId, repoFullName } = coords(repo);
      const token = await scoped(installationId, repoFullName, {
        issues: "read",
        pull_requests: "read",
      });
      const n = threadNumber(thread.ref);

      // A read with images asks for every body rendered as well (`full+json` adds `body_html`
      // beside `body`): the markdown names an upload by a URL only a signed-in browser can
      // open, and the HTML is where GitHub hands out the short-lived signed one a service can.
      // Measured in github_images.ts. Only then — it triples what every listing carries.
      const wantImages = readOpts?.images !== undefined;
      const accept = wantImages ? "application/vnd.github.full+json" : undefined;
      /** Each entry's rendered body, and whether its text was cut to ENTRY_BUDGET, for a read
       * with images. Beside the entries rather than on them: it is how the images are found,
       * and never part of the thread. */
      type Rendered = { html: string; cut: boolean };
      const htmlOf = new Map<ThreadEntry, Rendered>();
      // oxlint-disable-next-line no-explicit-any
      const htmlFrom = (raw: any): Rendered => ({
        html: typeof raw?.body_html === "string" ? raw.body_html : "",
        // The body as GitHub holds it, not as kept: one of exactly ENTRY_BUDGET is whole.
        cut: typeof raw?.body === "string" && raw.body.length > ENTRY_BUDGET,
      });

      // Issues and PRs share this endpoint — a PR is an issue with code attached, and its
      // title, opening post and conversation all live on the issue side.
      // Whether the repo is private, for a read with images — beside the head, not after it.
      // On a public repo every upload is asked after anonymously before it is downloaded
      // (`isPublishedUpload`); anything but a clear "private" counts as public, so a failed
      // read costs a few images their download and never lets one through unasked.
      const isPrivate = wantImages
        ? gh(token, "GET", `/repos/${repoFullName}`)
          .then((res) => res.status === 200 && res.body?.private === true)
          .catch(() => false)
        : Promise.resolve(false);
      const head = await gh(token, "GET", `/repos/${repoFullName}/issues/${n}`, undefined, {
        accept,
      });
      if (head.status !== 200 || typeof head.body?.title !== "string") {
        throw new ForgeApiError(
          `reading ${repoFullName}#${n} failed (${head.status}): ${message(head.body)}`,
          // Gone or hidden — no retry finds it again. Everything else (403, 5xx, a rate
          // limit) is the usual "could not ask", and the caller's clock decides.
          head.status === 404 || head.status === 410,
        );
      }

      /** One paginated listing, oldest first — GitHub's order, and a reader's. */
      const pages = async (
        path: string,
        // oxlint-disable-next-line no-explicit-any
        map: (raw: any) => ThreadEntry | null,
      ): Promise<{ entries: ThreadEntry[]; truncated: boolean }> => {
        const entries: ThreadEntry[] = [];
        let held = 0;
        for (let page = 1; page <= THREAD_PAGE_LIMIT; page++) {
          const res = await gh(token, "GET", `${path}?per_page=100&page=${page}`, undefined, {
            accept,
          });
          if (res.status !== 200 || !Array.isArray(res.body)) {
            throw new ForgeApiError(
              `reading ${path} failed (${res.status}): ${message(res.body)}`,
              // The thread can be deleted or hidden BETWEEN the head request and this one.
              // Hard-coding "retryable" here would 503 forever over a thread no redelivery
              // can find — the head request's own rule applies just as much mid-listing.
              res.status === 404 || res.status === 410,
            );
          }
          for (const raw of res.body) {
            const entry = map(raw);
            if (entry === null) continue;
            // The page ceiling bounds the COUNT; this bounds the bytes. Without it a listing
            // of maximum-length comments is ~32 MiB held here, serialized to the
            // orchestrator, and parsed again there — three copies of a payload nothing will
            // ever render. Weighed BEFORE the entry is kept: a page holds 100 of them, so
            // deciding at the page boundary lets the budget overshoot by a whole page.
            if (held + entry.body.length > LISTING_BUDGET) return { entries, truncated: true };
            entries.push(entry);
            held += entry.body.length;
            if (wantImages) htmlOf.set(entry, htmlFrom(raw));
          }
          // A short page is the end of the listing. A full page on the last allowed one is
          // the ceiling biting, and the caller is told rather than quietly shortchanged.
          if (res.body.length < 100) return { entries, truncated: false };
        }
        return { entries, truncated: true };
      };

      // oxlint-disable-next-line no-explicit-any
      const login = (raw: any): string =>
        typeof raw?.user?.login === "string" ? raw.user.login : "unknown";
      // oxlint-disable-next-line no-explicit-any
      const text = (raw: any): string =>
        typeof raw?.body === "string" ? raw.body.slice(0, ENTRY_BUDGET) : "";
      // oxlint-disable-next-line no-explicit-any
      const when = (raw: any, field = "created_at"): string =>
        typeof raw?.[field] === "string" ? raw[field] : "";
      const anchor = (line: unknown): string => typeof line === "number" ? `:${line}` : "";

      const empty = () => Promise.resolve({ entries: [] as ThreadEntry[], truncated: false });
      const isPull = thread.kind === "change_request";

      const conversationPages = () =>
        pages(
          `/repos/${repoFullName}/issues/${n}/comments`,
          (raw) => ({
            kind: "comment",
            authorLogin: login(raw),
            body: text(raw),
            createdAt: when(raw),
            state: null,
            location: null,
            // The handle a command in this comment arrives with (`sourceCommentId`).
            ...(typeof raw.id === "number" ? { id: String(raw.id) } : {}),
          }),
        );

      // A PR carries two more channels a human reads as one conversation: the review
      // verdicts and the inline remarks on the diff. "Address the review feedback" is
      // unanswerable without them, so they are not an extra — they ARE the thread.
      const reviewPages = () =>
        pages(`/repos/${repoFullName}/pulls/${n}/reviews`, (raw) => {
          const state = typeof raw.state === "string" ? raw.state.toLowerCase() : null;
          if (state === "pending") return null; // someone's unsubmitted draft, not yet said
          // A wordless review is a bare approve or reject: the verdict IS the message, so
          // it stays even with an empty body.
          return {
            kind: "review",
            authorLogin: login(raw),
            body: text(raw),
            createdAt: when(raw, "submitted_at"),
            state,
            location: null,
          };
        });

      const inlinePages = () =>
        pages(`/repos/${repoFullName}/pulls/${n}/comments`, (raw) => ({
          kind: "review_comment",
          authorLogin: login(raw),
          body: text(raw),
          createdAt: when(raw),
          state: null,
          // `line` is null once a remark goes outdated — the diff moved under it — but
          // `original_line` survives, and an outdated remark is exactly the kind an agent
          // is asked to go address. Without the fallback it arrives with no anchor at all.
          location: typeof raw.path === "string"
            ? `${raw.path}${anchor(raw.line ?? raw.original_line)}`
            : null,
          // Resolution is filled in below, from GraphQL: REST does not know it.
          ...(typeof raw.id === "number"
            ? {
              id: `${REVIEW_HANDLE}${raw.id}`,
              remark: {
                id: String(raw.id),
                replyTo: typeof raw.in_reply_to_id === "number" ? String(raw.in_reply_to_id) : null,
                resolved: null,
              },
            }
            : {}),
        }));

      // Which review threads are resolved — garnish on the read, never a reason to fail it:
      // the thread is whole without it, and a command must not bounce off a GraphQL blip.
      // Unknown stays null, which the rendering leaves unsaid.
      const resolutions = () =>
        reviewThreads(token, repoFullName, n)
          .then(({ threads }) => threads)
          .catch((err) => {
            diag.warn("github.review_threads_unread", { repo: repoFullName, n, err: String(err) });
            return new Map<string, { id: string; resolved: boolean }>();
          });

      // CONCURRENTLY, and that is a deadline decision rather than a micro-optimization. Run
      // in sequence, a long PR is sixteen round trips deep (a head plus five pages for each
      // of three listings) behind one caller-side timeout — so a big or merely slow thread
      // times out on every delivery and the command never lands, however often it is retried.
      // The three listings do not depend on each other; fanning them out puts the worst case
      // at six deep instead. A PR's own head rides along: one more request, and the thing a
      // run working on the PR checks out.
      const resolved = isPull ? resolutions() : Promise.resolve(new Map());
      const { conversation, reviews, inline, pull } = await settleThread(
        conversationPages(),
        isPull ? reviewPages() : empty(),
        isPull ? inlinePages() : empty(),
        isPull ? readPull(token, repoFullName, n) : Promise.resolve(null),
      );
      const threads = await resolved;
      for (const entry of inline.entries) {
        if (entry.remark === undefined) continue;
        const thread = threads.get(entry.remark.replyTo ?? entry.remark.id);
        if (thread !== undefined) entry.remark.resolved = thread.resolved;
      }

      // Three listings, one conversation: merged back into the order things were said in.
      // A missing timestamp sorts last rather than jumping to the head of the thread.
      const key = (e: ThreadEntry) => e.createdAt || "9999";
      const merged = [...conversation.entries, ...reviews.entries, ...inline.entries]
        .sort((a, b) => key(a).localeCompare(key(b)));

      // The three listings hit their ceilings independently, and a merge of "all the reviews
      // but the first 500 comments" is not a prefix of anything — it would show a late review
      // while silently dropping the comments around it, under a note promising the thread's
      // BEGINNING. So a truncated listing sets a horizon at its last entry, the earliest such
      // horizon wins, and everything after it goes. What survives is a real chronological
      // prefix, which is the only thing the note can honestly describe.
      const truncated = conversation.truncated || reviews.truncated || inline.truncated;
      const horizon = [conversation, reviews, inline]
        .filter((listing) => listing.truncated)
        .map((listing) => listing.entries.at(-1))
        .filter((last) => last !== undefined)
        .map(key)
        .sort()
        .at(0);
      const entries = horizon === undefined ? merged : merged.filter((e) => key(e) <= horizon);

      const context: ThreadContext = {
        kind: thread.kind,
        ref: String(n),
        title: head.body.title,
        body: typeof head.body.body === "string" ? head.body.body.slice(0, ENTRY_BUDGET) : "",
        authorLogin: login(head.body),
        createdAt: when(head.body),
        state: typeof head.body.state === "string" ? head.body.state : "open",
        entries,
        truncated,
        changeRequest: pull,
      };
      if (readOpts?.images !== undefined) {
        // Placed in the body as KEPT, which is all of it unless it was longer than
        // ENTRY_BUDGET: the HTML renders the whole body, and an image of an upload the kept
        // text never names is past the cut, in no text the reader will see, so it is not an
        // image of this thread either.
        const open = !await isPrivate;
        const slotsOf = (owner: ImageSlot["owner"], markdown: string, rendered: Rendered) =>
          githubImages(markdown, rendered.html, imageOrigins, {
            truncated: rendered.cut,
          }).slice(0, MAX_SLOTS_PER_ENTRY).map((
            found,
          ): ImageSlot => ({
            owner,
            markup: found.markup,
            occurrence: found.occurrence,
            fetch: async (signal) => {
              // A signed URL on a public repo: only for an upload anyone could see anyway (see
              // `isPublishedUpload`). A legacy upload's URL is public by construction.
              if (
                open && new URL(found.url).origin !== LEGACY_IMAGE_ORIGIN &&
                !await isPublishedUpload(found.key, { uploadBase: opts.uploadBase, signal })
              ) {
                return { kind: "omitted", reason: "unavailable" };
              }
              return await downloadImage(found.url, { origins: imageOrigins, signal });
            },
          }));
        const slots = [
          ...slotsOf("body", context.body, htmlFrom(head.body)),
          ...entries.flatMap((entry, i) =>
            slotsOf(i, entry.body, htmlOf.get(entry) ?? { html: "", cut: false })
          ),
        ];
        await attachThreadImages(context, slots, readOpts.images.focus, {
          focusOnly: readOpts.images.focusOnly === true,
        });
      }
      return context;
    },

    // ---- door ⑤, the tool surface: one repo, one permission, per call ----------------------

    async repoVisibility(tenantId, repoRefs) {
      if (tenantId === null && user === null) {
        throw new ForgeApiError("a visibility check needs a GitHub installation", true);
      }
      // The tenant must fit the mode, exactly as for any one repo.
      const { installationId } = coords({ repoRef: repoRefs.join(", "), tenantId });
      const repoFullNames = repoRefs;
      const token = await scoped(installationId, repoFullNames, { metadata: "read" });
      const out = new Map<string, boolean>();
      const wanted = new Map(repoFullNames.map((n) => [n.toLowerCase(), n]));
      // The token is narrowed to exactly these repos, so the installation's own listing answers
      // them together: one request for a whole grant instead of one per repo. Anything it does
      // not name is read singly below — the listing is an optimisation, never the authority.
      // A user token has no installation to list, and every repo is read singly.
      for (
        let page = 1;
        installationId !== null && page <= 5 && wanted.size > out.size;
        page++
      ) {
        const res = await gh(
          token,
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body?.repositories)) break;
        for (const repo of res.body.repositories as Array<Record<string, unknown>>) {
          const asked = typeof repo.full_name === "string"
            ? wanted.get(repo.full_name.toLowerCase())
            : undefined;
          if (asked !== undefined && typeof repo.private === "boolean") {
            out.set(asked, repo.private);
          }
        }
        if (res.body.repositories.length < 100) break;
      }
      for (const fullName of repoFullNames) {
        if (out.has(fullName)) continue;
        const repo = await gh(token, "GET", `/repos/${fullName}`);
        // `private` authorizes writing somewhere, so it is never defaulted: a 200 without it is a
        // malformed answer to retry, not a public repo by assumption.
        if (repo.status !== 200 || typeof repo.body?.private !== "boolean") {
          throw refusal(`reading ${fullName}`, repo);
        }
        out.set(fullName, repo.body.private);
      }
      return new Map([...out].map(([ref, isPrivate]) => [ref, wholeRepoVisibility(isPrivate)]));
    },

    async repoLabels(repo) {
      const { installationId, repoFullName } = coords(repo);
      const token = await scoped(installationId, repoFullName, { issues: "read" });
      const labels: string[] = [];
      // 10 pages, 1 000 labels: past that the listing is cut short and SAYS so, because a label
      // missing from a partial listing is not a label the repo lacks.
      for (let page = 1; page <= 10; page++) {
        const res = await gh(
          token,
          "GET",
          `/repos/${repoFullName}/labels?per_page=100&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw refusal(`listing ${repoFullName}'s labels`, res);
        }
        for (const label of res.body) if (typeof label?.name === "string") labels.push(label.name);
        if (res.body.length < 100) return { labels, complete: true };
      }
      return { labels, complete: false };
    },

    async threadKind(repo, ref) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, {
        issues: "read",
        pull_requests: "read",
      });
      const res = await gh(token, "GET", `/repos/${repoFullName}/issues/${number}`);
      if (res.status !== 200 || typeof res.body?.number !== "number") {
        throw refusal(`reading ${repoFullName}#${number}`, res);
      }
      return res.body.pull_request != null ? "change_request" : "issue";
    },

    async listIssues(repo, query) {
      const { installationId, repoFullName } = coords(repo);
      const token = await scoped(installationId, repoFullName, { issues: "read" });
      const labels = query.labels.length === 0
        ? ""
        : `&labels=${encodeURIComponent(query.labels.join(","))}`;
      const res = await gh(
        token,
        "GET",
        `/repos/${repoFullName}/issues?state=${query.state}${labels}&per_page=30&page=${query.page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw refusal(`listing ${repoFullName}'s issues`, res);
      }
      const items: IssueListing[] = res.body
        // The forge lists pull requests among issues; they have their own tool.
        .filter((i: { pull_request?: unknown }) => i.pull_request == null)
        .map((i: Record<string, unknown>) => ({
          ref: String(num(i.number)),
          title: str(i.title),
          state: str(i.state, "open"),
          authorLogin: str((i.user as { login?: unknown } | null)?.login, "ghost"),
          labels: Array.isArray(i.labels)
            ? i.labels.map((l: { name?: unknown }) => str(l?.name)).filter((n: string) => n !== "")
            : [],
          comments: num(i.comments),
          updatedAt: str(i.updated_at),
        }));
      return { items, hasMore: res.body.length === 30 };
    },

    async listChangeRequests(repo, query) {
      const { installationId, repoFullName } = coords(repo);
      const token = await scoped(installationId, repoFullName, { pull_requests: "read" });
      const res = await gh(
        token,
        "GET",
        `/repos/${repoFullName}/pulls?state=${query.state}&per_page=30&page=${query.page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw refusal(`listing ${repoFullName}'s pull requests`, res);
      }
      const items: ChangeListing[] = res.body.map((p: Record<string, unknown>) => ({
        ref: String(num(p.number)),
        title: str(p.title),
        state: str(p.state, "open"),
        authorLogin: str((p.user as { login?: unknown } | null)?.login, "ghost"),
        draft: p.draft === true,
        headRef: str((p.head as { ref?: unknown } | null)?.ref),
        baseRef: str((p.base as { ref?: unknown } | null)?.ref),
        updatedAt: str(p.updated_at),
      }));
      return { items, hasMore: res.body.length === 30 };
    },

    async listChangeRequestFiles(repo, ref) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "read" });
      const res = await gh(
        token,
        "GET",
        `/repos/${repoFullName}/pulls/${number}/files?per_page=100`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw refusal(`listing the files of ${repoFullName}#${number}`, res);
      }
      const items: ChangedFile[] = res.body.map((f: Record<string, unknown>) => ({
        path: str(f.filename),
        status: str(f.status, "modified"),
        additions: num(f.additions),
        deletions: num(f.deletions),
        patch: typeof f.patch === "string" ? f.patch : null,
      }));
      return { items, hasMore: res.body.length === 100 };
    },

    async listChangeRequestCommits(repo, ref, limit, known) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "read" });
      const read = async (page: number) => {
        const res = await gh(
          token,
          "GET",
          `/repos/${repoFullName}/pulls/${number}/commits?per_page=${COMMIT_PAGE}&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw refusal(`listing the commits of ${repoFullName}#${number}`, res);
        }
        return res.body as Array<Record<string, unknown>>;
      };
      const mapOne = (raw: Record<string, unknown>): ChangeCommit => {
        // oxlint-disable-next-line no-explicit-any
        const commit = (raw.commit ?? {}) as any;
        const message = str(commit.message);
        return {
          sha: clip(str(raw.sha), SHA_MAX),
          // The GitHub account where the commit is linked to one, and the git author's name
          // where it is not: an unlinked commit still has an author, and calling them "unknown"
          // would hide a name the forge plainly shows. Clamped either way — the second is a
          // string the committer chose.
          authorLogin: clip(
            str((raw.author as { login?: unknown } | null)?.login) ||
              str(commit.author?.name, "unknown"),
            AUTHOR_MAX,
          ),
          date: clip(str(commit.author?.date) || str(commit.committer?.date), DATE_MAX),
          summary: clip(message.split("\n", 1)[0], COMMIT_SUMMARY_MAX),
        };
      };
      /**
       * The pull request's OWN commit count — the only thing that can tell a listing GitHub cut
       * at its cap from a change request that is simply that long.
       *
       * The caller usually has it already: it rides the head `fetchThread` just answered with,
       * and buying it again is a request spent on a number in hand. Asked for otherwise only
       * when the listing could be at the cap at all — a two-page listing holds at most 200
       * commits and cannot be — and leniently: a count nobody could get is a missing note,
       * never a failed read.
       */
      const declaredCount = async (couldBeCapped: boolean): Promise<number | null> => {
        if (known?.total != null) return known.total;
        if (!couldBeCapped) return null;
        const res = await tryGet(token, `/repos/${repoFullName}/pulls/${number}`);
        return res.status === 200 && typeof res.body?.commits === "number"
          ? res.body.commits
          : null;
      };

      // GitHub lists a pull request's commits OLDEST first and offers no way to reverse them,
      // so the newest end — the one a reviewer reads — is on the LAST page. One request covers
      // every change request up to COMMIT_PAGE commits, which is nearly all of them.
      const first = await gh(
        token,
        "GET",
        `/repos/${repoFullName}/pulls/${number}/commits?per_page=${COMMIT_PAGE}&page=1`,
      );
      if (first.status !== 200 || !Array.isArray(first.body)) {
        throw refusal(`listing the commits of ${repoFullName}#${number}`, first);
      }
      const firstPage = first.body as Array<Record<string, unknown>>;
      const last = lastPageOf(first.headers);
      if (last === 1) {
        const mapped = firstPage.map(mapOne);
        const items = mapped.slice(Math.max(0, mapped.length - limit));
        return {
          items,
          older: mapped.length - items.length,
          unit: "commit",
          atHead: true,
          total: mapped.length,
        };
      }

      // Past one page the last page is read — and the page BEFORE it too when the last is
      // short, because a last page can hold a single commit and "the newest 50" that answers
      // one of them is not the newest 50. Those two pages are ADJACENT, which is the whole
      // reason they may be concatenated: page 1 glued to page 7 would be a history with an
      // unmarked hole in it, which is worse than a short one.
      // A listing whose every page were full would still be under the cap: then its end IS the
      // tip, and the pull request's own count buys nothing.
      const couldBeCapped = last * COMMIT_PAGE >= COMMIT_LISTING_CAP;
      const [tail, counted] = await Promise.all([read(last), declaredCount(couldBeCapped)]);
      // Page 1 is already in hand when it IS the page before the last: re-reading it would be
      // a request spent on bytes this function is holding.
      const previous = tail.length < limit ? (last === 2 ? firstPage : await read(last - 1)) : [];
      const raw = [...previous, ...tail];
      const mapped = raw.map(mapOne);
      const items = mapped.slice(Math.max(0, mapped.length - limit));
      const listed = (last - 1) * COMMIT_PAGE + tail.length;
      const total = Math.max(counted ?? 0, listed);
      return {
        items,
        older: listed - items.length,
        unit: "commit",
        // The listing stops at its first COMMIT_LISTING_CAP commits, so on a longer change
        // request its end is NOT the tip: what was read is a window out of the middle, and
        // saying otherwise would label fifty commits from the middle of a branch "the newest".
        atHead: total <= listed,
        total: counted ?? listed,
      };
    },

    async readChecks(repo, headSha) {
      const { installationId, repoFullName } = coords(repo);
      // Keyed by installation AND repo: a permission is granted per installation, but an
      // installation's answer for one repository says nothing about another it also holds —
      // and a cached sentence from one repo's response must never be rendered under another's
      // name. Nothing forge-authored is stored here at all, only this fixed sentence.
      const cacheKey = `${installationId}/${repoFullName.toLowerCase()}`;
      const held = checksRefused.get(cacheKey);
      if (held !== undefined && held.untilMs > now()) {
        return { kind: "unavailable", reason: held.reason };
      }
      const PERMISSION_MISSING = user === null
        ? "this ryph installation may not read CI on the forge (the GitHub App needs the " +
          '"Checks: read" and "Commit statuses: read" permissions)'
        : "this ryph installation may not read CI on the forge (its GitHub token needs " +
          '"Checks: read" and "Commit statuses: read")';
      /**
       * Remembered, so an App that was never granted the permission does not pay for asking
       * again on every change request its agents read.
       *
       * ONLY for the shapes that actually mean "never granted", and only when NEITHER half is
       * readable: a scoped mint refused with 422, and a 403 whose body is GitHub's "not
       * accessible by integration". A suspended installation, a secondary rate limit and a
       * repository dropped from the selection are all 403s too, and every one of them is
       * temporary — cached as a permission gap, they would keep an agent blind to CI long
       * after the cause had gone.
       */
      const refuse = (): ChecksReport => {
        if (checksRefused.size > 500) checksRefused.clear();
        checksRefused.set(cacheKey, {
          reason: PERMISSION_MISSING,
          untilMs: now() + CHECKS_REFUSAL_TTL_MS,
        });
        return { kind: "unavailable", reason: PERMISSION_MISSING };
      };
      /** GitHub's words for a permission the App does not hold, as opposed to every other 403. */
      const notGranted = (body: { message?: unknown }): boolean =>
        /not accessible by integration|resource not accessible/i.test(message(body));
      /** A 403 that says "rate limit", or a 429: the one refusal worth DATING, so the caller
       * can stop asking. This call costs a mint and two requests of the same allowance. */
      const limitFrom = (res: { status: number; body: { message?: unknown }; headers?: Headers }) =>
        res.status === 429 || (res.status === 403 && /rate limit/i.test(message(res.body)))
          ? retryAfterFrom(res.headers)
          : null;

      /**
       * A token for the two CI permissions — and the fallback that keeps a ONE-SIDED grant
       * readable.
       *
       * GitHub refuses to mint a scoped token for anything the installation was never granted,
       * so asking for both at once turns "you have checks but not statuses" into a flat 422 and
       * a change request whose CI is perfectly readable reads as "may not read CI". Each half
       * is therefore asked for on its own after a combined refusal, and only a repo that
       * refuses BOTH has no CI to offer.
       */
      const mint = async (permissions: TokenScope["permissions"]) => {
        try {
          return { token: await scoped(installationId, repoFullName, permissions), err: null };
        } catch (err) {
          return { token: null, err };
        }
      };
      const both = await mint({ checks: "read", statuses: "read" });
      let token = both.token;
      /** Which half a one-sided grant leaves unreadable; null while both are in play. */
      let ungranted: "checks" | "statuses" | null = null;
      if (token === null) {
        if (!(both.err instanceof TokenMintError) || both.err.status !== 422) {
          // A mint 403 is a suspended or removed installation, not a permission that was never
          // granted: said, and asked again next time.
          return { kind: "unavailable", reason: `CI could not be read (${describe(both.err)})` };
        }
        const checksOnly = await mint({ checks: "read" });
        if (checksOnly.token !== null) {
          token = checksOnly.token;
          ungranted = "statuses";
        } else {
          const statusesOnly = await mint({ statuses: "read" });
          if (statusesOnly.token === null) {
            diag.warn("github.checks_permission_missing", { repo: repoFullName, status: 422 });
            return refuse();
          }
          token = statusesOnly.token;
          ungranted = "checks";
        }
      }

      const at = encodeURIComponent(headSha);
      const ask = (path: string) => tryGet(token!, path);
      const missing = (half: "checks" | "statuses") => ({
        status: 403,
        body: { message: "the App was not granted this permission" },
        headers: undefined,
        ungranted: half,
      });
      const [runs, statuses] = await Promise.all([
        ungranted === "checks" ? Promise.resolve(missing("checks")) : ask(
          `/repos/${repoFullName}/commits/${at}/check-runs?per_page=${CHECKS_PAGE}`,
        ),
        ungranted === "statuses" ? Promise.resolve(missing("statuses")) : ask(
          `/repos/${repoFullName}/commits/${at}/status?per_page=${CHECKS_PAGE}`,
        ),
      ]);

      // Both refused for the one reason worth remembering.
      if (
        ungranted === null && runs.status === 403 && statuses.status === 403 &&
        notGranted(runs.body) && notGranted(statuses.body)
      ) {
        diag.warn("github.checks_permission_missing", { repo: repoFullName, status: 403 });
        return refuse();
      }
      // Neither answered at all: say so, rather than reporting "no checks" — an empty list and
      // an unread one mean opposite things to an agent deciding whether CI is green.
      if (runs.status !== 200 && statuses.status !== 200) {
        const limited = limitFrom(runs) ?? limitFrom(statuses);
        return {
          kind: "unavailable",
          reason: `CI could not be read (${message(runs.body)} / ${message(statuses.body)})`,
          ...(limited === null ? {} : { retryAfterMs: limited }),
        };
      }

      const items: CheckRun[] = [];
      let unlisted = 0;
      if (runs.status === 200 && Array.isArray(runs.body?.check_runs)) {
        const listed = runs.body.check_runs as Array<Record<string, unknown>>;
        for (const raw of listed) {
          items.push({
            name: clip(str(raw.name, "(unnamed check)"), CHECK_NAME_MAX),
            status: clip(str(raw.status, "completed"), CHECK_NAME_MAX),
            conclusion: typeof raw.conclusion === "string"
              ? clip(raw.conclusion, CHECK_NAME_MAX)
              : null,
            detailsUrl: typeof raw.details_url === "string"
              ? clip(raw.details_url, CHECK_URL_MAX)
              : null,
          });
        }
        // What the forge holds and did not list. Unlike the cut below, these arrived in no
        // order: nothing is known about them, so they can never be counted as passes.
        unlisted += Math.max(0, num(runs.body.total_count) - listed.length);
      }
      if (statuses.status === 200 && Array.isArray(statuses.body?.statuses)) {
        const listed = statuses.body.statuses as Array<Record<string, unknown>>;
        for (const raw of listed) {
          const state = str(raw.state, "pending");
          items.push({
            name: clip(str(raw.context, "(unnamed status)"), CHECK_NAME_MAX),
            // A commit status carries no lifecycle of its own: `pending` IS its running state,
            // and everything else is a verdict it will not change without a new status.
            status: state === "pending" ? "in_progress" : "completed",
            conclusion: state === "pending" ? null : state === "success" ? "success" : "failure",
            detailsUrl: typeof raw.target_url === "string"
              ? clip(raw.target_url, CHECK_URL_MAX)
              : null,
          });
        }
        // The combined-status endpoint pages too, and counts what it did not show.
        unlisted += Math.max(0, num(statuses.body.total_count) - listed.length);
      }

      // Exactly one channel answered. That is a REPORT with a hole in it, and the hole is named
      // — rendering the half that answered as the whole of CI is how a failing commit status
      // disappears behind "all checks passed".
      const half = (which: "checks" | "statuses", rest: string) =>
        ungranted === which
          ? `the ${
            which === "checks" ? "check runs" : "commit statuses"
          } could not be read (this installation granted only the other half of the CI ` +
            `permissions), so this is only the ${rest}`
          : `the ${which === "checks" ? "check runs" : "commit statuses"} could not be read (${
            message(which === "checks" ? runs.body : statuses.body)
          }), so this is only the ${rest}`;
      const partial = runs.status === 200 && statuses.status === 200
        ? null
        : runs.status === 200
        ? half("statuses", "check runs")
        : half("checks", "commit statuses");

      // Ordered WORST FIRST before the cut, never after: the cap and the summary are computed
      // over the same list, and sorting afterwards would let 50 passing check runs push the one
      // failing commit status into the cut — where the summary would then call CI green.
      items.sort((a, b) => checkSeverity(a) - checkSeverity(b));
      const shown = items.slice(0, CHECKS_MAX);
      return {
        kind: "reported",
        headSha,
        items: shown,
        cut: items.length - shown.length,
        unlisted,
        partial,
      };
    },

    /**
     * One check run per ryph check, as the App, on a commit GitHub already has.
     *
     * Idempotent without a stored ref: every run carries its `external_id`
     * (`suite:generation:check`), so a report whose response was lost finds what it posted —
     * among THIS App's runs on the commit, never another's — and updates it rather than
     * posting a second. A new generation is a new id, so a re-run is a new check run, and
     * GitHub shows the latest one under the name a ruleset requires.
     *
     * The token is minted for this one repo and `checks: write` alone. An installation that
     * never granted that permission is an ANSWER (`unsupported`), not a failure to retry:
     * the suite still ran, and the report says the App cannot post it here.
     *
     * In user mode nothing is asked: GitHub lets only an App write check runs ("Write
     * permission for the REST API to interact with checks is only available to GitHub Apps"),
     * so no token a person holds — classic, `gh` or fine-grained — can post one. The answer is
     * `unsupported` up front, and the checks live in ryph.
     */
    async reportChecks(repo, report): Promise<ReportChecksOutcome> {
      const { installationId, repoFullName } = coords(repo);
      if (report.checks.length === 0) return { kind: "reported", refs: {} };
      if (user !== null) {
        return {
          kind: "unsupported",
          reason: "check results show in ryph but are not posted to GitHub: only a GitHub App " +
            "can post check runs, and this deployment acts as a person's token",
        };
      }
      const WRITE_MISSING =
        'the App cannot post checks on this repo (it needs the "Checks: write" permission)';
      let token: string;
      try {
        token = await scoped(installationId, repoFullName, { checks: "write" });
      } catch (err) {
        if (err instanceof TokenMintError && err.status === 422) {
          diag.warn("github.checks_write_missing", { repo: repoFullName });
          return { kind: "unsupported", reason: WRITE_MISSING };
        }
        return {
          kind: "failed",
          message: `minting a token to post checks failed: ${describe(err)}`,
          terminal: false,
        };
      }
      // The last alternative is what GitHub answers a token that is not an App's at all.
      const notGranted = (res: { status: number; body: { message?: unknown } }) =>
        res.status === 403 &&
        /not accessible by integration|resource not accessible|authenticate via a github app/i
          .test(message(res.body));
      /** GitHub's API can lag a push by a moment and answer as if the commit did not exist.
       * That passes, so it is worth asking again: a required check that is never posted blocks
       * the merge for good. */
      const commitUnseen = (res: { status: number; body: { message?: unknown } }) =>
        res.status === 422 && /no commit found for sha/i.test(message(res.body));
      const notYet = (what: string, res: { status: number; body: { message?: unknown } }) =>
        new ForgeApiError(`${what} failed (${res.status}): ${message(res.body)}`, false);

      /** This App's runs on the commit, by external id — read once, and only when a check has
       * no ref of its own to update by. */
      let adoptable: Map<string, string> | null = null;
      // An App's runs are its own by app id (user mode never gets here: it answered above).
      const appFilter = app === null ? "" : `&app_id=${encodeURIComponent(app.id)}`;
      const listOurs = async (): Promise<Map<string, string>> => {
        const found = new Map<string, string>();
        for (let page = 1; page <= CHECK_RUN_PAGES; page++) {
          const res = await gh(
            token,
            "GET",
            `/repos/${repoFullName}/commits/${encodeURIComponent(report.headSha)}/check-runs` +
              `?filter=all${appFilter}&per_page=100&page=${page}`,
          );
          if (res.status !== 200 || !Array.isArray(res.body?.check_runs)) {
            const what = `listing the check runs on ${report.headSha}`;
            // Only the named "no commit" answer is a lag. A 404 is also a deleted repo or an
            // access that was taken away, and nothing here says when the commit was pushed to
            // tell the two apart, so it is final.
            if (commitUnseen(res)) throw notYet(what, res);
            throw refusal(what, res);
          }
          const runs = res.body.check_runs as Array<Record<string, unknown>>;
          for (const run of runs) {
            // oxlint-disable-next-line no-explicit-any
            const owner = (run.app as any)?.id;
            // The query already asks for this App's runs; the answer is held to it anyway,
            // because updating another App's run is a 403 at best and adoption at worst.
            if (app !== null && owner !== undefined && String(owner) !== app.id) continue;
            if (typeof run.external_id === "string" && typeof run.id === "number") {
              found.set(run.external_id, String(run.id));
            }
          }
          if (runs.length < 100) break;
        }
        return found;
      };

      const refs: Record<string, string> = {};
      for (const check of report.checks) {
        // GitHub refuses `action_required` without somewhere to act; a deployment with no app
        // URL still has to block the merge, so it says `failure` instead.
        const conclusion = check.conclusion === "action_required" && report.detailsUrl === null
          ? "failure"
          : check.conclusion;
        const completed = check.status === "completed";
        const fields = {
          name: `${CHECK_RUN_PREFIX}${check.name}`,
          external_id: check.externalId,
          status: check.status,
          ...(report.detailsUrl === null ? {} : { details_url: report.detailsUrl }),
          ...(completed && conclusion !== null ? { conclusion } : {}),
          ...(check.startedAt === null ? {} : { started_at: check.startedAt }),
          ...(completed && check.completedAt !== null ? { completed_at: check.completedAt } : {}),
          output: {
            title: clip(check.title, 200),
            summary: clip(check.summary, CHECK_SUMMARY_MAX - 1),
          },
        };

        let id = check.forgeRef;
        if (id === null) {
          adoptable ??= await listOurs();
          id = adoptable.get(check.externalId) ?? null;
        }
        if (id !== null) {
          const res = await gh(
            token,
            "PATCH",
            `/repos/${repoFullName}/check-runs/${encodeURIComponent(id)}`,
            fields,
          );
          if (res.status === 200 && typeof res.body?.id === "number") {
            refs[check.name] = String(res.body.id);
            continue;
          }
          if (notGranted(res)) return { kind: "unsupported", reason: WRITE_MISSING };
          // A run that is no longer there (or never was ours) is posted afresh; anything else
          // is the forge's refusal to carry back.
          if (res.status !== 404) throw refusal(`updating the check run ${check.name}`, res);
        }
        const res = await gh(token, "POST", `/repos/${repoFullName}/check-runs`, {
          ...fields,
          head_sha: report.headSha,
        });
        if (res.status !== 201 || typeof res.body?.id !== "number") {
          if (notGranted(res)) return { kind: "unsupported", reason: WRITE_MISSING };
          const what = `posting the check run ${check.name}`;
          if (commitUnseen(res)) throw notYet(what, res);
          throw refusal(what, res);
        }
        refs[check.name] = String(res.body.id);
      }
      diag.debug("github.checks_reported", {
        repo: repoFullName,
        suiteId: report.suiteId,
        generation: report.generation,
        checks: report.checks.length,
      });
      return { kind: "reported", refs };
    },

    async createIssue(repo, params) {
      const { installationId, repoFullName } = coords(repo);
      const token = await scoped(installationId, repoFullName, { issues: "write" });
      const res = await gh(token, "POST", `/repos/${repoFullName}/issues`, {
        title: params.title,
        body: params.body,
        ...(params.labels.length === 0 ? {} : { labels: params.labels }),
      });
      if (
        res.status !== 201 || typeof res.body?.number !== "number" ||
        typeof res.body?.html_url !== "string"
      ) {
        throw refusal(`opening an issue in ${repoFullName}`, res);
      }
      return { ref: String(res.body.number), url: res.body.html_url };
    },

    async createComment(repo, thread, body) {
      const { installationId, repoFullName } = coords(repo);
      const n = threadNumber(thread.ref);
      const token = await scoped(installationId, repoFullName, threadPermission(thread.kind));
      const res = await gh(
        token,
        "POST",
        `/repos/${repoFullName}/issues/${n}/comments`,
        { body },
      );
      if (res.status !== 201 || typeof res.body?.html_url !== "string") {
        throw refusal(`commenting on ${repoFullName}#${n}`, res);
      }
      return { url: res.body.html_url };
    },

    async replyToReviewComment(repo, ref, commentId, body) {
      const { installationId, repoFullName } = coords(repo);
      const n = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "write" });
      const root = await threadRoot(token, repoFullName, n, commentId);
      const res = await gh(
        token,
        "POST",
        `/repos/${repoFullName}/pulls/${n}/comments/${root}/replies`,
        { body },
      );
      if (res.status !== 201 || typeof res.body?.html_url !== "string") {
        throw refusal(`replying to review comment ${root} on ${repoFullName}#${n}`, res);
      }
      return { url: res.body.html_url };
    },

    async resolveReviewThread(repo, ref, commentId) {
      const { installationId, repoFullName } = coords(repo);
      const n = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "write" });
      const root = String(await threadRoot(token, repoFullName, n, commentId));
      const { threads, complete } = await reviewThreads(token, repoFullName, n);
      const thread = threads.get(root);
      if (thread === undefined) {
        throw new ForgeApiError(
          complete
            ? `${repoFullName}#${n} has no review thread opened by comment ${root}`
            : `${repoFullName}#${n} has more review threads than could be read, and the one ` +
              `opened by comment ${root} was not among them`,
          complete,
        );
      }
      if (thread.resolved) return;
      const data = await graphql(
        token,
        `resolving the review thread of comment ${root} on ${repoFullName}#${n}`,
        `mutation($thread: ID!) {
          resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
        }`,
        { thread: thread.id },
      );
      if (data?.resolveReviewThread?.thread?.isResolved !== true) {
        throw new ForgeApiError(
          `resolving the review thread of comment ${root} on ${repoFullName}#${n}: the forge ` +
            "did not say it is resolved",
          false,
        );
      }
    },

    async addLabels(repo, thread, labels) {
      const { installationId, repoFullName } = coords(repo);
      const n = threadNumber(thread.ref);
      // Labels live under Issues, a pull request's too, and GitHub has not been seen to accept
      // pull_requests: write alone for them: a pull request's labels ask for both.
      const token = await scoped(
        installationId,
        repoFullName,
        thread.kind === "change_request"
          ? { issues: "write", pull_requests: "write" }
          : { issues: "write" },
      );
      const res = await gh(
        token,
        "POST",
        `/repos/${repoFullName}/issues/${n}/labels`,
        { labels },
      );
      if (res.status !== 200) throw refusal(`labelling ${repoFullName}#${n}`, res);
      return { url: threadUrl(repoFullName, thread.kind, n) };
    },

    async listChangeRequestPatches(repo, ref) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "read" });
      // The head the diff belongs to, read under the same token and before the pages: what the
      // caller checks its remarks against, and what it then posts them against.
      const { headSha } = await readPull(token, repoFullName, number);
      const files: Array<{ path: string; patch: string | null }> = [];
      // GitHub lists at most 3000 files of a pull request, 100 a page.
      for (let page = 1; page <= 30; page++) {
        const res = await gh(
          token,
          "GET",
          `/repos/${repoFullName}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw refusal(`listing the diff of ${repoFullName}#${number}`, res);
        }
        for (const f of res.body as Array<Record<string, unknown>>) {
          files.push({
            path: str(f.filename),
            patch: typeof f.patch === "string" ? f.patch : null,
          });
        }
        if (res.body.length < 100) return { files, complete: true, headSha };
      }
      return { files, complete: false, headSha };
    },

    async closeIssue(repo, ref, reason) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { issues: "write" });
      const res = await gh(token, "PATCH", `/repos/${repoFullName}/issues/${number}`, {
        state: "closed",
        state_reason: reason,
      });
      if (res.status !== 200 || typeof res.body?.html_url !== "string") {
        throw refusal(`closing ${repoFullName}#${number}`, res);
      }
      return { url: res.body.html_url };
    },

    async createReview(repo, ref, params) {
      const { installationId, repoFullName } = coords(repo);
      const number = threadNumber(ref);
      const token = await scoped(installationId, repoFullName, { pull_requests: "write" });
      // Anchored to the head the CALLER checked the remarks against, when it checked them: a
      // push landing between that check and this write would otherwise make validated remarks
      // unanchorable, and GitHub refuses the whole review over one of them. Only a review that
      // checked nothing reads the head here. COMMENT, always: a run's review never approves and
      // never blocks a merge.
      const commitId = params.headSha ?? (await readPull(token, repoFullName, number)).headSha;
      const res = await gh(token, "POST", `/repos/${repoFullName}/pulls/${number}/reviews`, {
        commit_id: commitId,
        body: params.body,
        event: "COMMENT",
        comments: params.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      if (res.status !== 200 || typeof res.body?.html_url !== "string") {
        throw refusal(`reviewing ${repoFullName}#${number}`, res);
      }
      return { url: res.body.html_url };
    },

    async findMarkedWrite(repo, target, marker, since) {
      const { installationId, repoFullName } = coords(repo);
      const at = encodeURIComponent(since);
      const [permissions, path] = target.kind === "issue"
        ? [
          { issues: "read" } as const,
          `/repos/${repoFullName}/issues?state=all&sort=created&direction=desc&since=${at}`,
        ]
        : target.kind === "comment"
        ? [
          { issues: "read", pull_requests: "read" } as const,
          `/repos/${repoFullName}/issues/${threadNumber(target.threadRef)}/comments?since=${at}`,
        ]
        : target.kind === "review_reply"
        ? [
          { pull_requests: "read" } as const,
          `/repos/${repoFullName}/pulls/${threadNumber(target.threadRef)}/comments?since=${at}`,
        ]
        // Reviews list oldest first and take no `since`: the newest is on the LAST page, so a
        // review is walked to the end of its listing rather than three pages in.
        : [
          { pull_requests: "read" } as const,
          `/repos/${repoFullName}/pulls/${threadNumber(target.threadRef)}/reviews?`,
        ];
      const token = await scoped(installationId, repoFullName, permissions);
      // Listings, not the search index: search lags writes by seconds to minutes, and this runs
      // the moment a write's response went missing. Three pages since the reservation is far
      // more than one run writes in a minute; a review's listing is walked whole instead.
      const maxPages = target.kind === "review" ? 30 : 3;
      for (let page = 1; page <= maxPages; page++) {
        const res = await gh(token, "GET", `${path}&per_page=100&page=${page}`);
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw refusal(`looking for a lost write in ${repoFullName}`, res);
        }
        for (const item of res.body) {
          if (typeof item?.body !== "string" || !item.body.includes(marker)) continue;
          if (typeof item.html_url !== "string") continue;
          return {
            url: item.html_url,
            createdRef: target.kind === "issue" && typeof item.number === "number"
              ? String(item.number)
              : null,
          };
        }
        if (res.body.length < 100) break;
      }
      return null;
    },
  };

  if (user !== null) {
    const userApi: GithubUserApi = {
      login: user.login,
      scopes: user.scopes,

      async listUserRepos() {
        const token = await tokenFor(null);
        const repos: UserRepoListing[] = [];
        // Everything the person reaches, as GitHub's own repo picker would list it. An empty or
        // short page is the end; the ceiling is 5 000 repos, past which a picker is not the tool.
        for (let page = 1; page <= USER_REPO_PAGES; page++) {
          const res = await gh(
            token,
            "GET",
            `/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
          );
          if (res.status !== 200 || !Array.isArray(res.body)) {
            throw refusal("listing your GitHub repositories", res);
          }
          for (const raw of res.body) {
            const listed = repoListing(raw);
            // Read as the person: `permissions` is theirs on this repo. An entry without it is
            // offered as one they cannot administer — greyed out, never wrongly enabled.
            if (listed !== null) {
              repos.push({ ...listed, admin: raw?.permissions?.admin === true });
            }
          }
          if (res.body.length < 100) return repos;
        }
        diag.warn("github.user_repos_capped", { pages: USER_REPO_PAGES, repos: repos.length });
        return repos;
      },

      async describeRepo(repoRef) {
        const res = await gh(await tokenFor(null), "GET", `/repos/${repoRef}`);
        if (res.status === 404) return null;
        if (res.status !== 200) throw refusal(`reading ${repoRef}`, res);
        const described = repoListing(res.body);
        if (described === null) {
          throw new ForgeApiError(
            `reading ${repoRef}: the forge's answer is missing fields`,
            false,
          );
        }
        return described;
      },
    };
    return { ...shared, ...userApi };
  }

  // Unreachable with `user` null — one of the two is always set — but the narrowing is free.
  if (app === null) throw new Error("a GitHub forge with neither an App nor a user token");
  /** The installation as GitHub describes it now, read with the App's JWT. Throws with GitHub's
   * own message when it does not answer. */
  const readInstallation = async (installationId: string) => {
    const jwt = await mintAppJwt(app.id, app.key, now());
    const info = await gh(jwt, "GET", `/app/installations/${encodeURIComponent(installationId)}`);
    if (info.status !== 200 || typeof info.body !== "object" || info.body === null) {
      throw new Error(
        `installation ${installationId} did not resolve (${info.status}): ${
          message(info.body ?? {})
        }`,
      );
    }
    return info.body;
  };

  /**
   * Where the installation is managed on GitHub. GitHub's own `html_url` when it points at this
   * web base and this installation; else built from the account type. Null when neither works.
   */
  const installationSettingsUrl = (
    installationId: string,
    // oxlint-disable-next-line no-explicit-any
    installation: any,
  ): string | null => {
    const id = encodeURIComponent(installationId);
    const tail = `/settings/installations/${id}`;
    if (typeof installation.html_url === "string" && URL.canParse(installation.html_url)) {
      const given = new URL(installation.html_url);
      const web = new URL(oauthBase);
      const prefix = web.pathname.replace(/\/+$/, "");
      const rest = given.pathname.startsWith(prefix) ? given.pathname.slice(prefix.length) : "";
      if (
        given.origin === web.origin && rest.endsWith(tail) &&
        /^(?:\/(?:organizations|enterprises)\/[^/]+)?\/settings\/installations\/[^/]+$/.test(rest)
      ) {
        return given.href;
      }
    }
    const account = installation.account;
    const named = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
    switch (account?.type) {
      case "User":
        return `${oauthBase}${tail}`;
      case "Organization":
        return named(account.login)
          ? `${oauthBase}/organizations/${encodeURIComponent(account.login)}${tail}`
          : null;
      case "Enterprise":
        return named(account.slug)
          ? `${oauthBase}/enterprises/${encodeURIComponent(account.slug)}${tail}`
          : null;
      default:
        return null;
    }
  };

  const appApi: GithubAppApi = {
    async getInstallationSettingsUrl(installationId) {
      // Resolved live: the account may have been renamed. No repo listing, no installation token.
      const url = installationSettingsUrl(installationId, await readInstallation(installationId));
      if (url === null) {
        throw new Error(`installation ${installationId} names no settings page GitHub serves`);
      }
      return url;
    },

    async describeInstallation(installationId) {
      // App-level: who is this installation? (App JWT, not an installation token.)
      const info = await readInstallation(installationId);
      if (typeof info.account?.login !== "string") {
        throw new Error(`installation ${installationId} names no account login`);
      }
      // Installation-level: every repo it grants, paginated fully.
      const token = await app.vendor.installationToken(installationId);
      const repos: RepoListing[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await gh(
          token,
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body?.repositories)) {
          throw new Error(`listing installation repos failed (${res.status})`);
        }
        for (const r of res.body.repositories) {
          repos.push({
            fullName: r.full_name,
            url: r.clone_url,
            defaultBranch: r.default_branch,
            private: r.private === true,
          });
        }
        // An empty page is the authoritative end. `total_count` is only the fast path: it is
        // sampled per page, so a repo removed mid-pagination leaves it permanently above what
        // any number of further pages can return.
        if (res.body.repositories.length === 0) break;
        if (repos.length >= (res.body.total_count ?? Infinity)) break;
      }
      return {
        accountLogin: info.account.login,
        settingsUrl: installationSettingsUrl(installationId, info),
        repos,
      };
    },

    async describeSubscriptions(): Promise<AppSubscriptions> {
      const jwt = await mintAppJwt(app.id, app.key, now());
      const settings = await gh(jwt, "GET", "/app");
      if (
        settings.status !== 200 || typeof settings.body !== "object" || settings.body === null
      ) {
        throw new ForgeApiError(
          `reading this App's settings failed (${settings.status}): ${message(settings.body)}`,
          false,
        );
      }
      const installations: AppSubscriptions["installations"] = [];
      // Paginated fully, with no page cap: an installation left off would read as one with
      // nothing missing. A short page is GitHub's end of the list.
      const seen = new Set<string>();
      for (let page = 1;; page++) {
        const res = await gh(jwt, "GET", `/app/installations?per_page=100&page=${page}`);
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw new ForgeApiError(
            `listing this App's installations failed (${res.status}): ${message(res.body)}`,
            false,
          );
        }
        let fresh = 0;
        for (const inst of res.body) {
          const id = String(inst.id);
          if (seen.has(id)) continue;
          seen.add(id);
          fresh++;
          installations.push({
            id,
            account: String(inst.account?.login ?? "?"),
            accountType: inst.account?.type === "User" ? "User" : "Organization",
            ...subscriptionOf(inst),
          });
        }
        if (res.body.length < 100) break;
        // A full page of installations already read means GitHub is repeating itself, not
        // listing more: without this an endpoint ignoring `page` would loop forever.
        if (fresh === 0) break;
      }
      return { app: subscriptionOf(settings.body), installations };
    },

    async checkOrgMembership(installationId, login): Promise<OrgMembership> {
      try {
        const jwt = await mintAppJwt(app.id, app.key, now());
        const info = await gh(jwt, "GET", `/app/installations/${installationId}`);
        const account = info.body?.account;
        if (info.status !== 200 || typeof account?.login !== "string") {
          diag.warn("github.membership_unanswerable", { installationId, status: info.status });
          return "unknown";
        }
        // A personal-account installation has no members to ask about: the account is the one
        // person, and a login matches it or does not.
        if (account.type === "User") {
          return account.login.toLowerCase() === login.toLowerCase() ? "member" : "not-member";
        }
        // A redirect is GitHub's way of saying the caller may not see membership: followed, it
        // lands on the public-members list, whose 404 would read as a refusal. Left unfollowed,
        // the 302 is the "could not ask" it really is.
        const token = await app.vendor.installationToken(installationId);
        const res = await gh(
          token,
          "GET",
          `/orgs/${encodeURIComponent(account.login)}/members/${encodeURIComponent(login)}`,
          undefined,
          { redirect: "manual" },
        );
        if (res.status === 204) return "member";
        if (res.status === 404) return "not-member"; // definitively: not a member
        // 302 (the App may not see membership), 403, 5xx — unanswerable, never a refusal.
        diag.warn("github.membership_unanswerable", { org: account.login, status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("github.membership_unreachable", { installationId, err: String(err) });
        return "unknown";
      }
    },

    signIn: app.oauth !== null,

    async exchangeOAuthCode(code) {
      if (app.oauth === null) {
        throw new Error(
          "this GitHub App has no OAuth client (RYPH_GITHUB_CLIENT_ID and _SECRET) — nobody " +
            "signs in through it",
        );
      }
      const res = await fetch(`${oauthBase}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: app.oauth.clientId,
          client_secret: app.oauth.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof body.access_token !== "string") {
        throw new Error(
          `the OAuth exchange failed: ${
            typeof body.error_description === "string" ? body.error_description : res.status
          }`,
        );
      }
      const user = await gh(body.access_token, "GET", "/user");
      if (
        user.status !== 200 || typeof user.body?.login !== "string" ||
        (typeof user.body.id !== "number" && typeof user.body.id !== "string")
      ) {
        throw new Error(`resolving the OAuth user failed (${user.status})`);
      }
      // The addresses need the App's "Email addresses" permission; an App that lacks it answers
      // 403, which is "no verified address", not a failed sign-in.
      const emails = await gh(body.access_token, "GET", "/user/emails");
      const verifiedEmails: string[] = emails.status === 200 && Array.isArray(emails.body)
        ? emails.body
          .filter((e: { email?: unknown; verified?: unknown }) =>
            typeof e.email === "string" && e.verified === true
          )
          .map((e: { email: string }) => e.email)
        : [];
      if (emails.status !== 200) {
        diag.warn("github.emails_unanswerable", { login: user.body.login, status: emails.status });
      }
      return {
        accountId: String(user.body.id),
        login: user.body.login,
        name: typeof user.body.name === "string" ? user.body.name : null,
        verifiedEmails,
        accessToken: body.access_token,
      };
    },
  };
  return { ...shared, ...appApi };
}

/** Pages of 100 the user-mode repo listing walks. */
const USER_REPO_PAGES = 50;

/**
 * One repo as GitHub's REST answer describes it, reduced to what the connect flow keeps — or
 * null for an entry missing any of it. Nothing is defaulted: a repo row with an invented
 * default branch or a guessed visibility is worse than one not offered.
 */
// oxlint-disable-next-line no-explicit-any
function repoListing(raw: any): RepoListing | null {
  if (
    typeof raw?.full_name !== "string" || typeof raw.clone_url !== "string" ||
    typeof raw.default_branch !== "string" || typeof raw.private !== "boolean"
  ) {
    return null;
  }
  return {
    fullName: raw.full_name,
    url: raw.clone_url,
    defaultBranch: raw.default_branch,
    private: raw.private,
  };
}

/** The events and permissions GitHub lists on an App or an installation, keeping only strings. */
function subscriptionOf(body: { events?: unknown; permissions?: unknown }): AppSubscription {
  const events = Array.isArray(body.events)
    ? body.events.filter((e): e is string => typeof e === "string")
    : [];
  const permissions: Record<string, string> = {};
  if (typeof body.permissions === "object" && body.permissions !== null) {
    for (const [name, level] of Object.entries(body.permissions)) {
      if (typeof level === "string") permissions[name] = level;
    }
  }
  return { events, permissions };
}
