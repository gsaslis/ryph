// What only GitLab can answer, kept OFF the shared `ForgeApi` for `github_app.ts`'s reason: a
// bot's identity, the projects it reaches, OAuth and per-project webhook tokens are GitLab's
// concepts, not a forge's.
//
// A deployment's GitLab is ONE instance (`RYPH_GITLAB_URL`) in ONE mode: `bot` — a bot user's
// personal access token, added to projects at Developer — or `user` — one person's own token
// (the binary). Both modes hold one token and no tenants (`tenantId` is always null), so unlike
// GitHub the two modes share one adapter shape; what differs is answered at runtime (a user-mode
// forge refuses `hookToken`, and its OAuth and membership calls).
//
// The contract the adapter keeps: thread refs `issue-<iid>` and
// `mr-<iid>`, conversation-note handles `<threadRef>:<noteId>`, diff-note handles
// `<threadRef>:<discussionId>:<noteId>`, repo refs `path_with_namespace` — a label only.
//
// Projects and people are ADDRESSED by numeric id on the configured instance, never by name:
// a project by `ForgeRepo.forgeId` (`<id>@<url>`, `gitlabProjectRef`), a person by their account
// id (`<id>@<url>`, `gitlabAccountId`), the sign-up group by its id. A call that lacks the id, or
// names another instance, is refused terminally — there is no fallback to a path or a username,
// which a rename frees for anybody to take.

import type { OrgMembership } from "../core/types.ts";
import type { ImageSlot } from "../core/thread_images.ts";
import type { ForgeApi, GitlabRepo } from "./forge_api.ts";
import type { OAuthIdentity } from "./github_app.ts";
import type { FetchAuth } from "./repo_cache.ts";

/** How this deployment acts on GitLab, for the control plane (`GET /v1/service/providers`): the
 * mode, the account every write appears as, and the instance's base URL. Null where no GitLab is
 * configured at all. */
export interface GitlabMode {
  mode: "bot" | "user";
  /** The token's username, as `GET /user` spelled it at boot — for display: nothing is decided
   * on it. */
  login: string;
  /** The token's account, `<id>@<url>` (`gitlabAccountId`): what a user-mode deployment asks
   * permissions about. */
  accountId: string;
  /** `RYPH_GITLAB_URL`, normalized: no trailing slash, any path prefix kept. */
  url: string;
  /** Whether people can sign in through GitLab here: a bot with an OAuth application
   * (RYPH_GITLAB_CLIENT_ID and _SECRET). False in user mode, and for a bot without one. */
  signIn: boolean;
}

/** The token's own account, read once at boot. */
export interface GitlabSelf {
  /** GitLab's numeric user id, as text — stable where the username is not. */
  id: string;
  login: string;
}

/** One project as the connect flow needs it. */
export interface GitlabProjectListing {
  /** GitLab's numeric project id, as text — what the webhook URL and token are bound to. */
  id: string;
  /** `path_with_namespace`, GitLab's own spelling: the connected repo's `repo_ref`. */
  pathWithNamespace: string;
  /** `http_url_to_repo`: the connected repo's `url`. */
  url: string;
  /** `web_url`, for a person to open. */
  webUrl: string;
  /** Null for an empty project, which has no branch yet. */
  defaultBranch: string | null;
  visibility: "public" | "internal" | "private";
  /** Whether the token's account holds Maintainer or above on it — in user mode, whether the
   * person may connect it. */
  admin: boolean;
}

/** What delivering a change to GitLab takes — the change transport's half of the adapter. */
export interface GitlabDelivery {
  /**
   * The credential a push to `url` is made with: `{origin, token, scheme: "basic", basicUser:
   * "oauth2"}`, offered to `RYPH_GITLAB_URL`'s origin and nowhere else — or null for a path
   * upstream (dev, tests). Throws a terminal `ForgeApiError` for a URL that is not on the
   * instance's origin, or a tenant (GitLab has none).
   */
  pushAuth(repo: GitlabRepo, url: string): Promise<FetchAuth | null>;
  /**
   * Opens the merge request — or ADOPTS the open one that already exists for this source branch
   * (GitLab's 409, then a listing by source and target branch). Idempotent by contract, as
   * `GithubDelivery.openPullRequest` is. `draft` becomes a `Draft: ` title prefix. Answers the
   * merge request's thread ref (`mr-<iid>`) and its `web_url`.
   */
  openMergeRequest(
    repo: GitlabRepo,
    params: { title: string; body: string; head: string; base: string; draft: boolean },
  ): Promise<{ ref: string; url: string }>;
}

/** GitLab's connect surface: who ryph is there, what it reaches, sign-in, and webhook tokens. */
export interface GitlabConnectApi {
  /** How this forge acts on GitLab — what the providers route answers. */
  readonly mode: GitlabMode;
  /** The token's own account, read at boot. Its id is how the webhook consumer drops the bot's
   * own notes, and how `openedByUs` is decided; its login is display only, and never compared. */
  readonly self: GitlabSelf;
  /**
   * Every project the token's account reaches at Developer or above (bot mode:
   * `membership=true&min_access_level=30`), or — user mode — every project the person reaches,
   * with `admin` set where they hold Maintainer. Paginated in full up to a ceiling.
   */
  listProjects(): Promise<GitlabProjectListing[]>;
  /** One project, by its bare numeric id on this instance — or, for the connect flow alone,
   * binding the path a person just chose to the id everything after is addressed by — read
   * live. Null on GitLab's 404 (no such project, or none this token can see); throws
   * `ForgeApiError` for anything else. */
  describeProject(project: string): Promise<GitlabProjectListing | null>;
  /** An account's username as GitLab spells it NOW, by its account id (`<id>@<url>`) — for
   * display only, such as naming who asked for a run. Null where GitLab has no such user;
   * throws `ForgeApiError` for an account on another instance and for anything unanswerable. */
  describeUser(accountId: string): Promise<{ login: string } | null>;
  /**
   * Redeems a sign-in's code with the OAuth application (`RYPH_GITLAB_CLIENT_ID`/`_SECRET`) at
   * `${RYPH_GITLAB_URL}/oauth/token`, with the authorize leg's `redirectUri` (GitLab requires it
   * on both legs) and PKCE verifier, then reads `GET /user` and the confirmed `/user/emails`.
   * `accountId` is `<user id>@<RYPH_GITLAB_URL>` (`gitlabAccountId` in src/gitlab_account.ts): an
   * id means one person on one instance only. The addresses are GitLab's "confirmed", which a self-managed instance may
   * grant on nobody's proof — the control plane does not take them as proof (see
   * `IdentityProvider.trustsEmails` in @ryph/auth). The user token is discarded: `accessToken`
   * is null. Throws a terminal `ForgeApiError` where no OAuth application is configured, or in
   * user mode.
   */
  exchangeOAuthCode(
    code: string,
    redirectUri: string,
    codeVerifier: string | null,
  ): Promise<OAuthIdentity>;
  /**
   * Whether the account `accountId` (`<id>@<url>`) is an active member (any access level) of the
   * group `RYPH_GITLAB_GROUP` names by id, read by the bot. Three-valued as
   * `GithubAppApi.checkOrgMembership`; an account on another instance is "not-member". Null where
   * no group is configured — the sign-up gate's "no organization", which is not a membership
   * answer at all.
   */
  checkGroupMembership(accountId: string): Promise<OrgMembership | null>;
  /**
   * The `X-Gitlab-Token` a project's webhook must carry at one generation:
   * `hex(HMAC-SHA256(RYPH_GITLAB_WEBHOOK_SECRET, "gitlab-hook:" + projectId + ":" + generation))`,
   * exactly what the mailroom's `derived-secret-header` check expects for a URL naming that
   * project and generation (`@ryph/webhooks` `deriveScopedSecret`). The generation is the
   * control plane's: rotating a project's token is bumping it, and the consumer refuses a
   * delivery at any other than the current one. Throws a terminal `ForgeApiError` where there is
   * no webhook secret (user mode).
   */
  hookToken(projectId: string, generation: number): Promise<string>;
}

/** The adapter whole: every shared method, the transport's half, and the connect surface. */
export type GitlabForge = ForgeApi & GitlabDelivery & GitlabConnectApi;

/** The label every webhook token derivation is prefixed with — one spelling for the mailroom's
 * registration and for `hookToken`. */
export const GITLAB_HOOK_LABEL = "gitlab-hook:";

/** The query parameter a webhook URL names its project in:
 * `/v1/hooks/gitlab?project=<id>&generation=<n>`. */
export const GITLAB_HOOK_SCOPE_PARAM = "project";

/** The query parameter a webhook URL names its token's generation in. */
export const GITLAB_HOOK_GENERATION_PARAM = "generation";

/** Where a thread's images are read from, for `GitlabImageSlots`: one project on the instance,
 * and a credentialed GET the adapter already holds. */
export interface GitlabImageSource {
  /** `RYPH_GITLAB_URL`, normalized. Only uploads on this instance are recognized. */
  instanceUrl: string;
  /** The project's numeric id, as text — the upload route is `/projects/:id/uploads/…`. */
  projectId: string;
  /** Its `path_with_namespace`, for recognizing `<instance>/<path>/uploads/…` links. */
  projectPath: string;
  /**
   * A GET of an API path (relative to `${instanceUrl}/api/v4`, e.g.
   * `/projects/42/uploads/<secret>/<name>`) with the forge's token, never following redirects
   * off the instance. The adapter owns the token; the slot builder never sees it.
   */
  get(apiPath: string, signal: AbortSignal): Promise<Response>;
}

/**
 * Finds the images in one body (an issue's or MR's description, or one note) and turns each into
 * an `ImageSlot` whose fetch is the credentialed upload read — Phase 1's `gitlab_images.ts`
 * exports `gitlabImageSlots` of this type, and the adapter calls it per body while reading a
 * thread with images.
 */
export type GitlabImageSlots = (
  owner: ImageSlot["owner"],
  body: string,
  source: GitlabImageSource,
) => ImageSlot[];
