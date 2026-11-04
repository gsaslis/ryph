// What only GitHub can answer, kept OFF the shared `ForgeApi` on purpose.
//
// Installations, OAuth codes and installation tokens are not a forge's concepts, they are
// GitHub's: Radicle has a key and no tenants at all. Putting them on the port every provider
// implements would make every second adapter a pile of "not applicable" throws. They live here
// instead, wired only where GitHub is configured — the connect flow (door ③'s installation,
// OAuth and repo-listing routes) and the GitHub `ChangeTransport`.
//
// A deployment's GitHub is an App or one person's token, never both (`GithubMode`). What only
// an App can answer is `GithubAppApi`; what only user mode answers is `GithubUserApi`; what the
// transport needs in either is `GithubDelivery`. A user-mode adapter has no `GithubAppApi`
// methods at all, so the routes that need one answer 501 there as they do with no GitHub.

import type { AppSubscriptions } from "../core/app_subscriptions.ts";
import type { OrgMembership } from "../core/types.ts";
import type { ForgeRepo } from "./forge_api.ts";
import type { FetchAuth } from "./repo_cache.ts";

/** How this deployment acts on GitHub: as an App's installations, or as the one person whose
 * token it holds. The control plane reads it to know which connect flow and identity rules
 * apply; null where no GitHub is configured at all. `signIn` says whether people can sign in
 * through the App: only where its OAuth client (RYPH_GITHUB_CLIENT_ID and _SECRET) is set. */
export type GithubMode = { mode: "app"; signIn: boolean } | { mode: "user"; login: string };

/** The human behind an OAuth code, as GitHub describes them. */
export interface OAuthIdentity {
  /** GitHub's stable id for the account — logins rename, this does not. */
  accountId: string;
  login: string;
  name: string | null;
  /** Every address GitHub itself has verified for the account. */
  verifiedEmails: string[];
  /** The raw user token, returned once for the caller to use now or store deliberately. */
  accessToken: string | null;
}

/** One repo an installation grants, reduced to the fields the connect flow needs. */
export interface RepoListing {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

/** One repo in a user-mode forge's picker: a `RepoListing`, plus whether the token's person
 * administers it — GitHub's own `permissions.admin` for them, false when GitHub said nothing —
 * so the picker can tell a repo they may connect from one they can only read. */
export interface UserRepoListing extends RepoListing {
  admin: boolean;
}

export interface GithubAppApi {
  /** Whether the App holds an OAuth client pair, so `exchangeOAuthCode` can redeem a code. */
  readonly signIn: boolean;
  /** Where the installation is managed on GitHub, read live. Throws if GitHub cannot say. */
  getInstallationSettingsUrl(installationId: string): Promise<string>;
  /**
   * Resolves an installation to the account it sits on and the repos it can reach — the
   * owning org or user (never the human who clicked Install; that identity comes from
   * OAuth), plus every granted repo (paginated fully, never truncated, because a missing
   * repo reads downstream as "not granted"). `settingsUrl` is where it is managed on GitHub,
   * null when GitHub's answer names no page for it.
   */
  describeInstallation(
    installationId: string,
  ): Promise<{ accountLogin: string; settingsUrl: string | null; repos: RepoListing[] }>;
  /**
   * Redeems a one-time OAuth code for the human behind it — where `describeInstallation`
   * gives the account an installation sits on, this gives the person currently acting. The
   * raw user token comes back once, for the caller to use now or store deliberately. Throws
   * where the App has no OAuth client (`signIn` false).
   */
  exchangeOAuthCode(code: string): Promise<OAuthIdentity>;
  /**
   * Whether `login` belongs to the account an installation sits on: a member of the org, or
   * the user themself when the App is installed on a personal account. Three-valued like
   * `checkPermission`, and for the same reason — a sign-up gate must tell "not a member" from
   * "could not ask".
   */
  checkOrgMembership(installationId: string, login: string): Promise<OrgMembership>;
  /**
   * The App's own event subscriptions and permissions, and every installation's: what the owner
   * ticked and what each account accepted. Read with the App's JWT, so no installation's rate
   * limit is spent. Throws when GitHub does not answer; the caller decides what that means.
   */
  describeSubscriptions(): Promise<AppSubscriptions>;
}

/** What delivering a change to GitHub takes, in either mode. */
export interface GithubDelivery {
  /**
   * The credential a push to this repo's upstream is made with — the installation's token in
   * App mode, the user token in user mode — or null for an upstream that is a path (dev,
   * tests), which has no origin to scope a header to. Throws a terminal `ForgeApiError` when
   * this forge cannot act on the repo at all (a tenant that does not fit the mode, or, in user
   * mode, an upstream that is not on GitHub's own origin: the person's token is presented to
   * GitHub and nowhere else).
   */
  pushAuth(repo: ForgeRepo, url: string): Promise<FetchAuth | null>;
  /**
   * Opens the pull request — or ADOPTS the open one that already exists for this head branch.
   * The dangerous failure is "the PR was opened and the response was lost"; a naive retry
   * double-opens on every blip, so idempotency is this method's contract, not the caller's.
   */
  openPullRequest(
    repo: ForgeRepo,
    params: { title: string; body: string; head: string; base: string; draft: boolean },
  ): Promise<{ number: number; url: string }>;
}

/** What only a user-mode forge answers: who it is, and what that person can reach. */
export interface GithubUserApi {
  /** The token's login, as GitHub spells it — read once, at construction. */
  readonly login: string;
  /** The token's OAuth scopes (`X-OAuth-Scopes`) for a classic or `gh` token; null for a
   * fine-grained token, which sends no such header and is limited by its own permissions. */
  readonly scopes: string[] | null;
  /**
   * Every repo the person owns, collaborates on, or reaches through an org — the connect
   * flow's picker. Paginated in full up to a ceiling no person reaches.
   */
  listUserRepos(): Promise<UserRepoListing[]>;
  /** One repo as GitHub describes it to this person — its own spelling of the name, its clone
   * URL and default branch. Null when GitHub says 404 (no such repo, or not one this token can
   * see); throws `ForgeApiError` for anything else. */
  describeRepo(repoRef: string): Promise<RepoListing | null>;
}
