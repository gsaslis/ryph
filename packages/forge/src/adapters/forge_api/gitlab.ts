// `ForgeApi` on GitLab — ONE instance (`RYPH_GITLAB_URL`), ONE token, REST API v4 — plus the
// change transport's half (`GitlabDelivery`) and the connect surface (`GitlabConnectApi`).
//
// Invariants:
// - permission checks treat only a DEFINITIVE 404 as "denied"; a 401, 403, 5xx or network death
//   is "unknown" — an outage must never read as a revocation
// - a project and a person are addressed by numeric id on THIS instance and never by name: every
//   call acts on the project `ForgeRepo.forgeId` names (`<id>@<url>`), refused terminally without
//   one or for one on another instance — no fallback to the path, which a rename frees for
//   anybody's new project; a permission or group membership is asked of the account id
//   (`<id>@<url>`), never a username, which a rename frees for anybody to register; the sign-up
//   group is pinned to its id at boot. Only an active membership of an active account counts —
//   one awaiting approval, or a blocked user's, holds no level
// - a public project is private here when any feature an agent reads (repository, merge
//   requests, issues, CI) is kept to its members
// - opening a merge request treats GitLab's 409 "already exists" as find-and-adopt
// - nothing is narrowed per call: GitLab cannot mint a narrower token from a personal access
//   token, so the tool surface's grant checks are the fence, as in GitHub user mode — offset by
//   the bot's Developer role, which no protected branch lets push or merge
// - the token is presented to the instance's origin and nowhere else; to git only for a
//   connected repo's own path in user mode, and only on the instance in bot mode
// - `tenantId` is always null: GitLab has no tenants here, and a repo naming one is a wiring
//   fault, refused terminally
// - every body written — note, edit, reply, draft, description — goes out inert to GitLab's quick
//   actions (`inertToQuickActions`), which would otherwise act as ryph's account past any grant:
//   escaped everywhere but a note on a diff, which is posted as written or refused
// - a confidential issue or an internal note is never read to an agent: the visibility rule is
//   per project, and they are private within one
// - the plumbing (client, spellings) is gitlab_client.ts; threads gitlab_threads.ts; diffs and
//   reviews gitlab_reviews.ts; CI gitlab_checks.ts; the connect surface gitlab_connect.ts

import type { Permission } from "../../core/types.ts";
import {
  type Audience,
  type ChangeCommit,
  type ChangeListing,
  type ForgeApi,
  ForgeApiError,
  type ForgeRepo,
  type IssueListing,
  type RepoVisibility,
} from "../../ports/forge_api.ts";
import {
  type GitlabDelivery,
  type GitlabForge,
  type GitlabImageSlots,
  type GitlabMode,
  type GitlabSelf,
} from "../../ports/gitlab.ts";
import type { FetchAuth } from "../../ports/repo_cache.ts";
import type { UserTokenSource } from "../../helpers/user_token.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { gitlabImageSlots } from "./gitlab_images.ts";
import {
  clip,
  diffNoteProblem,
  gitlabClient,
  type GitlabContext,
  type GitlabThread,
  hasMore,
  inertToQuickActions,
  messageOf,
  noteableSegment,
  noteHandle,
  parseNoteHandle,
  parseThreadSpelling,
  stateOf,
  str,
  threadOf,
  totalOf,
} from "./gitlab_client.ts";
import { fetchThread, findMarkedWrite, readHead } from "./gitlab_threads.ts";
import {
  createReview,
  listChangeRequestFiles,
  listChangeRequestPatches,
  mergeRequestOf,
  readMergeRequest,
  replyToReviewComment,
  resolveReviewThread,
} from "./gitlab_reviews.ts";
import { readChecks, reportChecks } from "./gitlab_checks.ts";
import { DEVELOPER, gitlabConnect, MAINTAINER, memberships } from "./gitlab_connect.ts";
import { gitlabAccountId, gitlabIdOn } from "../../gitlab_account.ts";

export interface GitlabForgeOptions {
  /** `bot`: a bot user's token, webhooks on. `user`: one person's token, merges polled. */
  mode: "bot" | "user";
  /** `RYPH_GITLAB_URL`, normalized (no trailing slash, any path prefix kept). The REST base is
   * `${url}/api/v4`, OAuth is `${url}/oauth/*`, and only this origin is presented the token. */
  url: string;
  /** The token, static or from `RYPH_GITLAB_TOKEN_COMMAND` (`GITLAB_TOKEN_NAMES`). */
  token: UserTokenSource;
  /** `RYPH_GITLAB_WEBHOOK_SECRET`, the master `hookToken` derives from; null in user mode. */
  webhookSecret: string | null;
  /** The sign-in OAuth application; null when none is configured (and always in user mode). */
  oauth: { clientId: string; clientSecret: string } | null;
  /** `RYPH_GITLAB_GROUP`, the sign-up gate's group — its id, or a path the boot resolves to its
   * id once and pins; null when unset. */
  group: string | null;
  /** Builds a thread's image slots (`gitlab_images.ts`); defaults to the real one. */
  imageSlots?: GitlabImageSlots;
  diag: Diagnostics;
  now?: () => number;
}

/** The oldest GitLab this adapter speaks to. */
export const MIN_GITLAB_VERSION: readonly [number, number] = [17, 0];
/**
 * The newest GitLab (major, minor) whose quick-action rule `inertToQuickActions` was checked
 * against: master at 19.5.0-pre. A newer one boots, with `gitlab.quick_action_escape_unverified`
 * — re-verify as `inertToQuickActions` says, then move this.
 */
export const QUICK_ACTION_ESCAPE_VERIFIED: readonly [number, number] = [19, 5];
/** The first GitLab whose upload route (`GET /projects/:id/uploads/:secret/:filename`) exists. */
const IMAGE_READS_VERSION: readonly [number, number] = [17, 4];

/** The scopes the token needs: the API, and git both ways. */
export const GITLAB_TOKEN_SCOPES = ["api", "read_repository", "write_repository"] as const;

/**
 * The project features whose content reaches an agent through this adapter — the repository,
 * merge requests, issues, and CI (commit statuses) — each with its own access level, which can
 * keep it to members (`private`) in a public project. Wiki, snippets and the rest are read by
 * nothing here.
 */
const MEMBER_FEATURES = ["repository", "merge_requests", "issues", "builds"] as const;
/** The levels a feature's `<feature>_access_level` can hold (`public` is Pages' alone). */
const FEATURE_ACCESS = new Set<unknown>(["disabled", "private", "enabled", "public"]);
/** Who reads a project of each `visibility`: `internal` is every account on the instance. */
const PROJECT_AUDIENCE = { private: "members", internal: "instance", public: "public" } as const;

/** How long a project's location (`locateUpstream`) is reused before it is read again. */
const LOCATE_TTL_MS = 10_000;

/** How soon an expiry is worth a warning. */
const EXPIRY_WARNING_MS = 14 * 24 * 3_600_000;

/** One commit history page; and what one forge-authored string there may contribute. */
const COMMIT_PAGE = 100;
const COMMIT_SUMMARY_MAX = 200;
const AUTHOR_MAX = 80;
const DATE_MAX = 40;
const SHA_MAX = 64;

/** `major.minor` off GitLab's `/version` (`17.4.1-ee`), or null. */
export function parseGitlabVersion(raw: unknown): [number, number] | null {
  const m = typeof raw === "string" ? /^(\d+)\.(\d+)/.exec(raw) : null;
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

const atLeast = (v: readonly [number, number], min: readonly [number, number]) =>
  v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);

/**
 * Builds the adapter and reads, at boot, what it acts as: `GET /version` (17.0 or later, else a
 * thrown error the boot fails on), `GET /personal_access_tokens/self` (scopes `api`,
 * `read_repository`, `write_repository` — missing ones fail a bot boot and warn in user mode;
 * expiry within 14 days warns), and `GET /user` (`self`). Throws with an operator-facing reason
 * that never names the token.
 */
export async function gitlabForgeApi(opts: GitlabForgeOptions): Promise<GitlabForge> {
  const { diag } = opts;
  const now = opts.now ?? Date.now;
  const url = opts.url.replace(/\/+$/, "");
  const client = gitlabClient({ url, token: opts.token, diag, now });
  const imageSlots = opts.imageSlots ?? gitlabImageSlots;

  // ---- boot: who, which GitLab, which scopes -------------------------------------------------

  const bootRead = async (path: string) => {
    try {
      return await client.call("GET", path);
    } catch (err) {
      // "fetch failed" alone does not say WHERE: a wrong RYPH_GITLAB_URL and a machine offline
      // read the same.
      throw new ForgeApiError(
        `could not reach GitLab at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }
  };

  const who = await bootRead("/user");
  if (
    who.status !== 200 || typeof who.body?.username !== "string" || who.body.username === "" ||
    typeof who.body.id !== "number"
  ) {
    throw new ForgeApiError(
      `GitLab at ${url} did not say whose token this is (GET /user answered ${who.status}: ${
        messageOf(who.body)
      })`,
      who.status === 401 || who.status === 403,
    );
  }
  const self: GitlabSelf = { id: String(who.body.id), login: who.body.username };

  const versionRes = await bootRead("/version");
  const version = versionRes.status === 200 ? parseGitlabVersion(versionRes.body?.version) : null;
  if (version === null) {
    throw new ForgeApiError(
      `GitLab at ${url} did not say its version (GET /version answered ${versionRes.status})`,
      false,
    );
  }
  if (!atLeast(version, MIN_GITLAB_VERSION)) {
    throw new ForgeApiError(
      `GitLab at ${url} is ${version.join(".")}; ryph needs ${MIN_GITLAB_VERSION.join(".")} or ` +
        "later",
      true,
    );
  }
  if (!atLeast(QUICK_ACTION_ESCAPE_VERIFIED, version)) {
    // Not refused: the escape holds against both of GitLab's detections, so only a rule that
    // changed past both could break it. Worth a line for whoever upgrades the instance.
    diag.warn("gitlab.quick_action_escape_unverified", {
      version: version.join("."),
      verified: QUICK_ACTION_ESCAPE_VERIFIED.join("."),
      note: "ryph's quick-action escape was checked against GitLab up to this version only",
    });
  }
  const imagesReadable = atLeast(version, IMAGE_READS_VERSION);
  if (!imagesReadable) {
    diag.warn("gitlab.images_unavailable", {
      version: version.join("."),
      note: "thread images need GitLab 17.4; they read as unavailable here",
    });
  }

  const pat = await bootRead("/personal_access_tokens/self");
  if (pat.status === 200 && Array.isArray(pat.body?.scopes)) {
    const scopes = (pat.body.scopes as unknown[]).filter((s) => typeof s === "string");
    const missing = GITLAB_TOKEN_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      if (opts.mode === "bot") {
        throw new ForgeApiError(
          `the GitLab token of @${self.login} lacks the scope${missing.length === 1 ? "" : "s"} ` +
            `${missing.join(", ")} (it needs ${GITLAB_TOKEN_SCOPES.join(", ")})`,
          true,
        );
      }
      diag.warn("gitlab.missing_scopes", { login: self.login, missing });
    }
    const expires = Date.parse(str(pat.body.expires_at));
    if (Number.isFinite(expires) && expires - now() < EXPIRY_WARNING_MS) {
      diag.warn("gitlab.token_expiring", { login: self.login, expiresAt: pat.body.expires_at });
    }
  } else if (opts.mode === "bot") {
    // A bot's token must be a personal access token whose scopes can be read; anything else is
    // a token whose reach nobody checked.
    throw new ForgeApiError(
      `GitLab at ${url} would not describe the bot's token (GET /personal_access_tokens/self ` +
        `answered ${pat.status}: ${messageOf(pat.body)})`,
      pat.status === 401 || pat.status === 403 || pat.status === 404,
    );
  } else {
    // A person's OAuth token (`glab` signed in through the browser) is no personal access
    // token, and says nothing here: its scopes are glab's, which cover what ryph needs.
    diag.warn("gitlab.scopes_unreadable", { login: self.login, status: pat.status });
  }

  // The sign-up group by id, from here on: a path is resolved once, now, and never again — a group
  // renamed while the forge runs, and its old path taken by a group somebody else made, gates
  // nothing for them.
  let groupId: string | null = null;
  if (opts.group !== null) {
    const g = await bootRead(`/groups/${encodeURIComponent(opts.group)}`);
    if (g.status !== 200 || typeof g.body?.id !== "number") {
      throw new ForgeApiError(
        `GitLab at ${url} has no group ${opts.group} the token can see (RYPH_GITLAB_GROUP; GET ` +
          `/groups answered ${g.status}: ${messageOf(g.body)})`,
        g.status === 404 || g.status === 403,
      );
    }
    groupId = String(g.body.id);
    if (groupId !== opts.group) {
      diag.debug("gitlab.group_pinned", { group: opts.group, id: groupId });
    }
  }

  const mode: GitlabMode = {
    mode: opts.mode,
    login: self.login,
    accountId: gitlabAccountId(url, self.id),
    url,
    signIn: opts.mode === "bot" && opts.oauth != null,
  };

  // ---- coordinates ---------------------------------------------------------------------------

  /**
   * The project's API id — its numeric id, out of `forgeId` — and nothing else. Every call goes
   * through here, and there is no path fallback: a project can be renamed or moved and its old
   * path taken by somebody else's, and a call by path would then act on that one. A repo without
   * an id, or with one on another instance (`RYPH_GITLAB_URL` changed since it was connected),
   * is refused terminally; so is a tenant (GitLab has none).
   */
  const project = (repo: ForgeRepo): string => {
    if (repo.tenantId !== null) {
      throw new ForgeApiError(
        `${repo.repoRef} names a tenant, but GitLab here acts as @${self.login} alone`,
        true,
      );
    }
    if (repo.forgeId === undefined) {
      throw new ForgeApiError(
        `${repo.repoRef} came without its GitLab project id — a GitLab project is never addressed ` +
          "by its path",
        true,
      );
    }
    const id = gitlabIdOn(repo.forgeId, url);
    if (id === null) {
      throw new ForgeApiError(
        `${repo.repoRef} is not a project of the GitLab at ${url} (it was connected on another ` +
          "instance, or its id is malformed) — connect it again",
        true,
      );
    }
    return id;
  };

  const threadUrl = (repo: ForgeRepo, thread: GitlabThread) =>
    `${url}/${repo.repoRef}/-/${noteableSegment(thread)}/${thread.iid}`;

  /** Whether `iid` exists as an issue and as a merge request: asked together. */
  const exists = async (p: string, segment: string, iid: number): Promise<boolean> => {
    const res = await client.call("GET", `/projects/${p}/${segment}/${iid}`);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw client.refusal(`reading ${segment === "issues" ? "#" : "!"}${iid}`, res);
  };

  const resolveThread = async (repo: ForgeRepo, ref: string): Promise<GitlabThread> => {
    const p = project(repo);
    const parsed = parseThreadSpelling(ref);
    if (parsed === null) {
      throw new ForgeApiError(
        `${JSON.stringify(ref)} is not a GitLab thread (!7 or mr-7, #12 or issue-12)`,
        true,
      );
    }
    if (!("bare" in parsed)) return parsed;
    const n = parsed.bare;
    const [issue, mr] = await Promise.all([
      exists(p, "issues", n),
      exists(p, "merge_requests", n),
    ]);
    if (issue && mr) {
      throw new ForgeApiError(
        `${n} names both issue #${n} and merge request !${n} in ${repo.repoRef} — say which: ` +
          `#${n} or !${n}`,
        true,
      );
    }
    if (issue) return threadOf("issue", n);
    if (mr) return threadOf("change_request", n);
    throw new ForgeApiError(`${repo.repoRef} has no issue or merge request ${n}`, true);
  };

  const ctx: GitlabContext = {
    client,
    url,
    mode: opts.mode,
    self,
    diag,
    now,
    project,
    resolveThread,
    threadUrl,
  };

  /** The image source's GET — and on an instance too old to have the route, a 404 without
   * asking, which the slot builder reads as unavailable. */
  const imageGet = (apiPath: string, signal: AbortSignal): Promise<Response> =>
    imagesReadable
      ? client.raw(apiPath, signal)
      : Promise.resolve(new Response(null, { status: 404 }));

  const { accessLevel } = memberships(ctx);

  /** Projects whose bot over-privilege has been looked at, so it is asked once per process. */
  const privilegeChecked = new Set<string>();
  /** The bot at Maintainer could push and merge protected branches: said once per project, on
   * first push, never a refusal. */
  const warnIfOverprivileged = async (repo: ForgeRepo): Promise<void> => {
    const id = project(repo);
    if (opts.mode !== "bot" || privilegeChecked.has(id)) return;
    privilegeChecked.add(id);
    try {
      const level = await accessLevel(`projects/${id}`, self.id);
      if (level !== null && level >= MAINTAINER) {
        diag.warn("gitlab.bot_overprivileged", { repo: repo.repoRef, accessLevel: level });
      }
    } catch (err) {
      privilegeChecked.delete(id);
      diag.debug("gitlab.privilege_unread", { repo: repo.repoRef, err: String(err) });
    }
  };

  // ---- git credentials -----------------------------------------------------------------------

  const instance = new URL(url);
  /** Where each project id was last found (`locateUpstream`), briefly: a clone asks on every
   * advertisement, and a rename is followed within seconds. */
  const located = new Map<string, { at: { url: string; repoRef: string }; expiresAtMs: number }>();
  /** The instance's path prefix (`/gitlab`), or "". */
  const prefix = instance.pathname.replace(/\/+$/, "");

  /**
   * Whether `target` is on the instance — and, with `repoRef`, that project's own path there:
   * `<prefix>/<path>` or `<path>.git`, in any case, nothing else. Canonical as written: git sends
   * the raw string, so a URL that parsing would change, or any percent-escape, is refused.
   */
  const onInstance = (target: string, repoRef: string | null): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return false;
    }
    if (parsed.origin !== instance.origin) return false;
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return false;
    if (parsed.hash !== "" || parsed.href !== target || target.includes("%")) return false;
    const path = parsed.pathname.toLowerCase();
    if (!path.startsWith(`${prefix.toLowerCase()}/`)) return false;
    if (repoRef === null) return true;
    const want = `${prefix}/${repoRef}`.toLowerCase();
    return path === want || path === `${want}.git`;
  };

  /** The token as a git credential for the instance: `Basic oauth2:<token>`, renewable once. */
  const gitAuth = async (): Promise<FetchAuth> => {
    const token = await opts.token.current();
    const base = { origin: instance.origin, scheme: "basic" as const, basicUser: "oauth2" };
    return {
      ...base,
      token,
      refresh: async () => {
        const fresh = await opts.token.refresh(token);
        return fresh === null ? null : { ...base, token: fresh };
      },
    };
  };

  // ---- the shared surface --------------------------------------------------------------------

  const notePath = (
    p: string,
    commentId: string,
  ): { path: string; handle: GitlabThread; discussion: boolean } => {
    const handle = parseNoteHandle(commentId);
    if (handle === null) {
      throw new ForgeApiError(`${JSON.stringify(commentId)} is not a GitLab note handle`, true);
    }
    return {
      path: `/projects/${p}/${noteableSegment(handle.thread)}/${handle.thread.iid}/notes/` +
        handle.noteId,
      handle: handle.thread,
      discussion: handle.discussionId !== null,
    };
  };

  const postNote = async (repo: ForgeRepo, ref: string, body: string) => {
    const p = project(repo);
    const thread = await resolveThread(repo, ref);
    const res = await client.call(
      "POST",
      `/projects/${p}/${noteableSegment(thread)}/${thread.iid}/notes`,
      { body: inertToQuickActions(body, { suggestions: false }) },
    );
    if (res.status === 202) {
      // GitLab took the whole note as quick actions: it carried them out and stored no note
      // (verified on GitLab 17.11). Nothing was posted, and asking again would act again.
      throw new ForgeApiError(
        `GitLab read the comment on ${thread.ref} as quick actions only and posted no note`,
        true,
      );
    }
    if (res.status !== 201 || typeof res.body?.id !== "number") {
      throw client.refusal(`commenting on ${thread.ref}`, res);
    }
    return { thread, id: res.body.id as number };
  };

  // oxlint-disable-next-line no-explicit-any
  const labelsOf = (raw: any): string[] =>
    Array.isArray(raw)
      ? raw.map((l: unknown) => typeof l === "string" ? l : str((l as { name?: unknown })?.name))
        .filter((l: string) => l !== "")
      : [];

  const shared: ForgeApi & GitlabDelivery = {
    async fetchAuth(repo, target) {
      if (!/^https?:\/\//.test(target)) return null;
      project(repo);
      // User mode: the person's token for that project's own path only. Bot mode: the bot's
      // reach is what it was added to, and it is offered to the instance alone.
      if (!onInstance(target, opts.mode === "user" ? repo.repoRef : null)) {
        diag.warn("gitlab.token_withheld", { repo: repo.repoRef, origin: new URL(target).origin });
        return null;
      }
      return await gitAuth();
    },

    async pushAuth(repo, target) {
      project(repo);
      if (!/^https?:\/\//.test(target)) return null;
      // A fork's branch is pushed in bot mode — on the same instance, under GitLab's own rule
      // (merge rights on the target branch). A person's token goes to their project alone.
      if (!onInstance(target, opts.mode === "user" ? repo.repoRef : null)) {
        const at = new URL(target);
        throw new ForgeApiError(
          `${repo.repoRef}'s upstream ${at.origin}${at.pathname} is not ${
            opts.mode === "user" ? "that project" : "a project"
          } on the GitLab at ${url} — the token is presented there and nowhere else`,
          true,
        );
      }
      await warnIfOverprivileged(repo);
      return await gitAuth();
    },

    // Never the row's URL: it is the path the project was connected under, which a rename can
    // have handed to somebody else. Every fetch locates the project by id (`locateUpstream`),
    // so a caller that reaches here without one is refused rather than pointed at that path.
    upstreamUrl: (repo) => {
      throw new ForgeApiError(
        `${repo.repoRef} is fetched where GitLab places its project id now, never by its path`,
        true,
      );
    },

    async locateUpstream(repo) {
      const id = project(repo);
      const hit = located.get(id);
      if (hit !== undefined && hit.expiresAtMs > now()) return hit.at;
      const res = await client.call("GET", `/projects/${id}`);
      if (res.status === 404) {
        throw new ForgeApiError(
          `GitLab has no project ${id} (it was deleted, or ryph lost it)`,
          true,
        );
      }
      if (res.status !== 200) throw client.refusal(`locating project ${id}`, res);
      const path = res.body?.path_with_namespace;
      // Spelled by this adapter, never taken as GitLab wrote the URL: the clone URL GitLab
      // reports follows its `external_url`, which need not be the origin the token is scoped to.
      if (
        typeof path !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(path) ||
        path.split("/").some((s) => s === "" || s === "." || s === "..")
      ) {
        throw new ForgeApiError(`GitLab named project ${id} by an unusable path`, true);
      }
      const at = { url: `${instance.origin}${prefix}/${path}.git`, repoRef: path };
      if (located.size > 500) located.clear();
      located.set(id, { at, expiresAtMs: now() + LOCATE_TTL_MS });
      return at;
    },

    async openMergeRequest(repo, params) {
      const p = project(repo);
      const created = await client.call("POST", `/projects/${p}/merge_requests`, {
        source_branch: params.head,
        target_branch: params.base,
        title: params.draft ? `Draft: ${params.title}` : params.title,
        description: inertToQuickActions(params.body, { suggestions: false }),
        allow_collaboration: false,
        remove_source_branch: true,
      });
      if (created.status === 201 && typeof created.body?.iid === "number") {
        return { ref: `mr-${created.body.iid}`, url: str(created.body.web_url) };
      }
      // "Another open merge request already exists for this source branch: !7" — the
      // lost-response retry this method exists to make safe. Verified on GitLab 17.11 as a 409
      // whose `message` is an array; 422 is still read, by its text, for older releases.
      if (
        (created.status === 409 || created.status === 422) &&
        /already exists/i.test(messageOf(created.body))
      ) {
        const open = await client.call(
          "GET",
          `/projects/${p}/merge_requests?state=opened&source_branch=${
            encodeURIComponent(params.head)
          }&target_branch=${encodeURIComponent(params.base)}`,
        );
        // Only one INTO THE SAME base, from this project's own branch.
        const same = open.status === 200 && Array.isArray(open.body)
          ? open.body.find((mr: Record<string, unknown>) =>
            mr.target_branch === params.base && mr.source_branch === params.head &&
            typeof mr.iid === "number" &&
            (mr.source_project_id === undefined || mr.source_project_id === mr.target_project_id)
          )
          : undefined;
        if (same !== undefined) {
          diag.debug("gitlab.mr_adopted", { repo: repo.repoRef, iid: same.iid });
          return { ref: `mr-${same.iid}`, url: str(same.web_url) };
        }
        throw new ForgeApiError(
          `GitLab refused the merge request (${created.status}): ${messageOf(created.body)}`,
          true,
        );
      }
      throw client.refusal("opening the merge request", created);
    },

    async postComment(repo, thread, body) {
      const { thread: t, id } = await postNote(repo, thread.ref, body);
      return { commentId: noteHandle(t, id) };
    },

    async createComment(repo, thread, body) {
      const { thread: t, id } = await postNote(repo, thread.ref, body);
      return { url: `${threadUrl(repo, t)}#note_${id}` };
    },

    async updateComment(repo, commentId, body) {
      const { path, discussion } = notePath(project(repo), commentId);
      // An edit runs quick actions as a new note does (`Notes::UpdateService`), and finds the
      // suggestions again in a note of a discussion, which may be on a line of the diff: there,
      // it is posted as written or refused, never escaped.
      const res = await client.call("PUT", path, {
        body: inertToQuickActions(body, { suggestions: discussion }),
      });
      if (res.status !== 200) throw client.refusal(`updating note ${commentId}`, res);
    },

    async addReaction(repo, commentId, reaction) {
      const { path } = notePath(project(repo), commentId);
      const res = await client.call("POST", `${path}/award_emoji`, { name: reaction });
      if (res.status === 200 || res.status === 201) return;
      // Already awarded — the retried-after-lost-response case, a success by contract. to
      // verify: which status GitLab answers it with; the text is what is read.
      if (
        res.status >= 400 && res.status < 500 && /already been taken/i.test(messageOf(res.body))
      ) {
        return;
      }
      throw client.refusal(`reacting to note ${commentId}`, res);
    },

    async checkPermission(repo, subject, atLeastLevel): Promise<Permission> {
      // No permissionless rung on GitLab: nobody in particular may do nothing. Refused before a
      // URL is built, so no null is ever looked up as a user named "null".
      if (subject === null) return "denied";
      // Only ever of the project by id and of the person by id, both on this instance. A path is
      // where a project lives now, and a username who holds it now: either can be given up and
      // taken by somebody else, who would then be answered for. Neither is ever looked up, so a
      // subject or a repo without its id is no question at all: a definitive no.
      const userId = gitlabIdOn(subject, url);
      if (userId === null) {
        diag.warn("gitlab.permission_subject_not_an_account", { repo: repo.repoRef });
        return "denied";
      }
      let p: string;
      try {
        p = project(repo);
      } catch (err) {
        diag.warn("gitlab.permission_without_project_id", { repo: repo.repoRef, err: String(err) });
        return "denied";
      }
      try {
        const level = await accessLevel(`projects/${p}`, userId);
        if (level === null) return "denied"; // definitively: no such account, or not a member
        return level >= (atLeastLevel === "admin" ? MAINTAINER : DEVELOPER) ? "allowed" : "denied";
      } catch (err) {
        diag.warn("gitlab.permission_unanswerable", { repo: repo.repoRef, err: String(err) });
        return "unknown";
      }
    },

    fetchThread: (repo, thread, readOpts) =>
      fetchThread(ctx, repo, thread, readOpts, { slots: imageSlots, get: imageGet }),

    async describeChangeRequest(repo, ref) {
      const thread = await mergeRequestOf(ctx, repo, ref);
      const mr = await readMergeRequest(ctx, project(repo), thread);
      if (mr.body?.state === "locked") {
        // A merge underway: in seconds it is merged or open again. Whether to push onto it is
        // asked again then — neither a push now nor a final refusal.
        throw new ForgeApiError(
          `${thread.ref} is being merged right now; ask again shortly`,
          false,
        );
      }
      return await readHead(ctx, repo, thread, mr.body);
    },

    async readChangeRequestState(repo, ref) {
      const p = project(repo);
      const thread = await mergeRequestOf(ctx, repo, ref);
      const res = await client.call("GET", `/projects/${p}/merge_requests/${thread.iid}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw client.refusal(`reading ${thread.ref}`, res);
      const mr = res.body;
      if (
        !["opened", "closed", "locked", "merged"].includes(mr?.state) ||
        typeof mr.sha !== "string" || typeof mr.target_branch !== "string"
      ) {
        throw new ForgeApiError(
          `reading ${thread.ref}: the forge's answer is missing fields`,
          false,
        );
      }
      const merged = mr.state === "merged";
      return {
        ref: thread.ref,
        // `locked` is a merge underway, never an end state: open until GitLab says merged.
        state: mr.state === "opened" || mr.state === "locked" ? "open" : "closed",
        merged,
        headSha: mr.sha,
        authorHeadSha: mr.sha,
        baseRef: mr.target_branch,
        // By account id, which no rename changes. In user mode: whatever the person opened,
        // by this token or by hand, which on GitLab are the same author.
        openedByUs: mr.author?.id !== undefined && String(mr.author.id) === self.id,
        // The head is frozen at the merge; a squash or merge commit never replaces it.
        mergedHeads: merged ? [mr.sha] : [],
      };
    },

    async classifyBranch(repo, branch) {
      // Everything under `refs/merge-requests/` is cached as `merge-requests/…`, and all of it
      // can hold somebody else's commits: `/merge` is a fork's head merged into the target,
      // `/train/…` a merge train's whole queue. Only a merge request's own `/head`, from a source
      // branch in this project, is something only the project's writers moved.
      if (!branch.startsWith("merge-requests/")) return "branch";
      const m = /^merge-requests\/([1-9][0-9]*)\/head$/.exec(branch);
      if (m === null) return "foreign";
      const thread = threadOf("change_request", Number(m[1]));
      const mr = (await readMergeRequest(ctx, project(repo), thread)).body;
      return typeof mr?.source_project_id === "number" &&
          mr.source_project_id === mr.target_project_id
        ? "branch"
        : "foreign";
    },

    async repoVisibility(tenantId, repoRefs) {
      const out = new Map<string, RepoVisibility>();
      for (const repoRef of repoRefs) {
        // GitLab's refs here are its project refs (`forgeId`), never paths.
        const p = project({ repoRef, tenantId, forgeId: repoRef });
        const res = await client.call("GET", `/projects/${p}`);
        const visibility = res.body?.visibility;
        const levels = MEMBER_FEATURES.map((f) => res.body?.[`${f}_access_level`]);
        // Never defaulted: a visibility that authorizes a write must be one GitLab said — the
        // project's, and each reachable feature's own.
        if (
          res.status !== 200 || !["public", "internal", "private"].includes(visibility) ||
          levels.some((l) => !FEATURE_ACCESS.has(l))
        ) {
          throw client.refusal(`reading ${repoRef}`, res);
        }
        const level = (f: string) => res.body[`${f}_access_level`];
        const whole = PROJECT_AUDIENCE[visibility as keyof typeof PROJECT_AUDIENCE];
        // A feature opened to the public (`public`) is written to for the public; any other
        // level is the project's own audience. A feature kept to members in a wider project is
        // not counted narrower as a target: when in doubt, wider.
        const written = (f: string): Audience => level(f) === "public" ? "public" : whole;
        out.set(repoRef, {
          // As a source, the narrowest of its parts: the project's own audience, or its members
          // where any feature an agent reads — its code, merge requests, issues or CI — is kept
          // to them (`private`). `internal` is every account on the instance, not the public.
          source: levels.includes("private") ? "members" : whole,
          // As a target, the audience of the feature written to. A public project's
          // members-only code makes it members-only to read, never its issues to write on; an
          // `internal` project shows what is written to every account on the instance.
          target: { issue: written("issues"), change_request: written("merge_requests") },
        });
      }
      return out;
    },

    async repoLabels(repo) {
      const p = project(repo);
      const labels: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const res = await client.call(
          "GET",
          `/projects/${p}/labels?include_ancestor_groups=true&per_page=100&page=${page}`,
        );
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw client.refusal(`listing ${repo.repoRef}'s labels`, res);
        }
        labels.push(...labelsOf(res.body));
        if (!hasMore(res, 100)) return { labels, complete: true };
      }
      return { labels, complete: false };
    },

    async threadKind(repo, ref) {
      const thread = await resolveThread(repo, ref);
      // A spelled kind is believed only once GitLab has it: a 404 is no such thread.
      if (!("bare" in (parseThreadSpelling(ref) ?? {}))) {
        const found = await exists(project(repo), noteableSegment(thread), thread.iid);
        if (!found) {
          throw new ForgeApiError(
            `${repo.repoRef} has no ${
              thread.kind === "issue" ? "issue #" : "merge request !"
            }${thread.iid}`,
            true,
          );
        }
      }
      return thread.kind;
    },

    async listIssues(repo, query) {
      const p = project(repo);
      const state = query.state === "open" ? "opened" : query.state;
      const labels = query.labels.length === 0
        ? ""
        : `&labels=${encodeURIComponent(query.labels.join(","))}`;
      const res = await client.call(
        "GET",
        `/projects/${p}/issues?state=${state}${labels}&confidential=false&per_page=30&page=${query.page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw client.refusal(`listing ${repo.repoRef}'s issues`, res);
      }
      // Confidential issues are never listed to agents, as they are never read to them
      // (`fetchThread`): asked out of the listing, and held out again here, where an answer that
      // does not say an issue is not confidential is taken to say it is. A page may then hold
      // fewer than it could, never one it should not.
      const items: IssueListing[] = res.body.filter((i: Record<string, unknown>) =>
        i?.confidential === false
      ).map((i: Record<string, unknown>) => ({
        ref: `issue-${i.iid}`,
        title: str(i.title),
        state: stateOf(i.state),
        authorLogin: str((i.author as { username?: unknown } | null)?.username, "ghost"),
        labels: labelsOf(i.labels),
        comments: typeof i.user_notes_count === "number" ? i.user_notes_count : 0,
        updatedAt: str(i.updated_at),
      }));
      return { items, hasMore: hasMore(res, 30) };
    },

    async listChangeRequests(repo, query) {
      const p = project(repo);
      // The port's `closed` is GitHub's: closed or merged. GitLab keeps them apart, so `all` is
      // asked and filtered — a page may then hold fewer than it could, never a wrong one.
      const state = query.state === "open" ? "opened" : "all";
      const res = await client.call(
        "GET",
        `/projects/${p}/merge_requests?state=${state}&per_page=30&page=${query.page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw client.refusal(`listing ${repo.repoRef}'s merge requests`, res);
      }
      const items: ChangeListing[] = res.body
        .filter((m: { state?: unknown }) =>
          query.state !== "closed" || (m.state !== "opened" && m.state !== "locked")
        )
        .map((m: Record<string, unknown>) => ({
          ref: `mr-${m.iid}`,
          title: str(m.title),
          state: stateOf(m.state),
          authorLogin: str((m.author as { username?: unknown } | null)?.username, "ghost"),
          draft: m.draft === true || m.work_in_progress === true,
          headRef: str(m.source_branch),
          baseRef: str(m.target_branch),
          updatedAt: str(m.updated_at),
        }));
      return { items, hasMore: hasMore(res, 30) };
    },

    listChangeRequestFiles: (repo, ref) => listChangeRequestFiles(ctx, repo, ref),
    listChangeRequestPatches: (repo, ref) => listChangeRequestPatches(ctx, repo, ref),

    async listChangeRequestCommits(repo, ref, limit, known) {
      const p = project(repo);
      const thread = await mergeRequestOf(ctx, repo, ref);
      // Newest first, as `git log` lists, with `x-total` (verified on GitLab 17.11) — so the
      // window a reviewer reads is page 1, and GitLab has no 250-commit cap to stop short of the
      // head.
      const perPage = Math.max(1, Math.min(limit, COMMIT_PAGE));
      const res = await client.call(
        "GET",
        `/projects/${p}/merge_requests/${thread.iid}/commits?per_page=${perPage}&page=1`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw client.refusal(`listing the commits of ${thread.ref}`, res);
      }
      const items: ChangeCommit[] = (res.body as Array<Record<string, unknown>>)
        .slice(0, limit)
        .map((c) => ({
          sha: clip(str(c.id), SHA_MAX),
          // The GitLab account where the answer names one, and the git author's name where it
          // does not, as GitHub's commit list does: a display line for the reader, never an
          // identity anything is decided on.
          authorLogin: clip(
            str((c.author as { username?: unknown } | null | undefined)?.username) ||
              str(c.author_name, "unknown"),
            AUTHOR_MAX,
          ),
          date: clip(str(c.authored_date) || str(c.created_at), DATE_MAX),
          summary: clip(str(c.title) || str(c.message).split("\n", 1)[0], COMMIT_SUMMARY_MAX),
        }))
        .reverse();
      const more = hasMore(res, perPage);
      const total = totalOf(res.headers) ?? (more ? known?.total ?? null : items.length);
      return {
        items,
        older: total === null ? 0 : Math.max(0, total - items.length),
        unit: "commit",
        atHead: true,
        total,
      };
    },

    readChecks: (repo, headSha) => readChecks(ctx, repo, headSha),
    reportChecks: (repo, report) => reportChecks(ctx, repo, report),

    async createIssue(repo, params) {
      const p = project(repo);
      const res = await client.call("POST", `/projects/${p}/issues`, {
        title: params.title,
        description: inertToQuickActions(params.body, { suggestions: false }),
        ...(params.labels.length === 0 ? {} : { labels: params.labels.join(",") }),
      });
      if (
        res.status !== 201 || typeof res.body?.iid !== "number" ||
        typeof res.body?.web_url !== "string"
      ) {
        throw client.refusal(`opening an issue in ${repo.repoRef}`, res);
      }
      return { ref: `issue-${res.body.iid}`, url: res.body.web_url };
    },

    replyToReviewComment: (repo, ref, commentId, body) =>
      replyToReviewComment(ctx, repo, ref, commentId, body),
    // Remarks and replies are diff notes: posted as written, or refused before anything is spent.
    reviewTextProblem: diffNoteProblem,
    resolveReviewThread: (repo, ref, commentId) => resolveReviewThread(ctx, repo, ref, commentId),

    async addLabels(repo, thread, labels) {
      const p = project(repo);
      const t = await resolveThread(repo, thread.ref);
      const res = await client.call(
        "PUT",
        `/projects/${p}/${noteableSegment(t)}/${t.iid}`,
        { add_labels: labels.join(",") },
      );
      if (res.status !== 200) throw client.refusal(`labelling ${t.ref}`, res);
      return { url: str(res.body?.web_url) || threadUrl(repo, t) };
    },

    async closeIssue(repo, ref, reason) {
      const p = project(repo);
      const thread = await resolveThread(repo, ref);
      if (thread.kind !== "issue") {
        throw new ForgeApiError(`!${thread.iid} is a merge request, not an issue`, true);
      }
      const path = `/projects/${p}/issues/${thread.iid}`;
      const now = await client.call("GET", path);
      if (now.status !== 200) throw client.refusal(`reading ${thread.ref}`, now);
      // Closing a closed issue changes nothing — and posts no second "not planned" note.
      if (now.body?.state === "closed") {
        return { url: str(now.body.web_url) || threadUrl(repo, thread) };
      }
      // GitLab keeps no close reason, so "not planned" is said in a note first.
      if (reason === "not_planned") await postNote(repo, thread.ref, "Closed as not planned.");
      const res = await client.call("PUT", path, { state_event: "close" });
      if (res.status !== 200) throw client.refusal(`closing ${thread.ref}`, res);
      return { url: str(res.body?.web_url) || threadUrl(repo, thread) };
    },

    createReview: (repo, ref, params) => createReview(ctx, repo, ref, params),
    findMarkedWrite: (repo, target, marker, since) =>
      findMarkedWrite(ctx, repo, target, marker, since),
  };

  const connect = gitlabConnect(ctx, {
    mode,
    webhookSecret: opts.webhookSecret,
    oauth: opts.oauth,
    groupId,
    accessLevel,
  });

  return { ...shared, ...connect };
}
