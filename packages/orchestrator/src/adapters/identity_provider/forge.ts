// @ryph/auth's `IdentityProvider` over the forges people sign in through — GitHub's App and
// GitLab's OAuth application. The code exchange goes to the forge (which holds the client
// secrets), and "may this login sign up" is asked of the forge too: for GitHub, of every
// installation this deployment has registered; for GitLab, of the group the forge names
// (RYPH_GITLAB_GROUP), about the account id the exchange answered.
//
// OAuth codes, installations, orgs and groups are not every forge's concepts — Radicle has a key
// and no tenants at all — so this sits on `GithubConnect` and `ForgeConnect` rather than on the
// forge-agnostic port, and Radicle's way in is a signed challenge (ChallengeProvider).
//
// And only where the forge acts as an App or a bot that holds an OAuth client. A forge acting
// through one person's token (GitHub's or GitLab's "user" mode), or an App or bot without one,
// has no OAuth client to sign anyone in or link anyone through: there that forge is offered for
// neither, and a code that arrives anyway is refused before the forge is asked.

import type { IdentityProvider, OAuthCodeLeg, ProviderMembership } from "@ryph/auth";
import type { ForgeConnect, GithubConnect, GithubMode } from "../../ports/forge.ts";
import type { TaskStore } from "../../ports/task_store.ts";
import type { GithubModeSource } from "../forge/github_mode.ts";
import type { GitlabModeSource } from "../forge/gitlab_mode.ts";

export interface ForgeIdentityProviderDeps {
  githubConnect: GithubConnect;
  store: TaskStore;
  githubMode: GithubModeSource;
  /** GitLab's sign-in, by the forge's OAuth application. Both or neither: absent, GitLab is
   * never offered (a forge stand-in with no GitLab). */
  forgeConnect?: ForgeConnect | null;
  gitlabMode?: GitlabModeSource | null;
}

export function forgeIdentityProvider(deps: ForgeIdentityProviderDeps): IdentityProvider {
  const { githubConnect, store, githubMode } = deps;
  const gitlab = deps.forgeConnect && deps.gitlabMode
    ? { connect: deps.forgeConnect, mode: deps.gitlabMode }
    : null;
  /** GitHub signs people in only through an App with an OAuth client: user mode has none, nor
   * does an App without RYPH_GITHUB_CLIENT_ID, nor a deployment with no GitHub, and a forge that
   * has not said which mode it runs is not assumed to have one. */
  const githubSignsIn = (mode: GithubMode | null | undefined) =>
    mode?.mode === "app" && mode.signIn;
  const githubApp = async () => githubSignsIn(await githubMode.get().catch(() => undefined));
  const githubUserMode = async () =>
    (await githubMode.get().catch(() => undefined))?.mode === "user";
  /** GitLab signs people in only through a bot deployment's OAuth application: user mode has
   * none, nor does a bot without RYPH_GITLAB_CLIENT_ID, and a forge that has not said which mode
   * it runs is not assumed to have one. */
  const gitlabSignsIn = (mode: { mode: string; signIn: boolean } | null | undefined) =>
    mode?.mode === "bot" && mode.signIn;
  const gitlabBot = async () =>
    gitlab !== null && gitlabSignsIn(await gitlab.mode.get().catch(() => undefined));

  return {
    // Synchronous, so it reads the last answers, which the wiring asks for at boot: each forge is
    // offered once it has said it signs people in — GitHub an App with an OAuth client, GitLab a
    // bot with an OAuth application.
    providers: () => [
      ...(githubSignsIn(githubMode.current()) ? ["github"] : []),
      ...(gitlabSignsIn(gitlab?.mode.current()) ? ["gitlab"] : []),
    ],
    async exchangeCode(provider, code, leg: OAuthCodeLeg) {
      let identity;
      if (provider === "github") {
        if (!await githubApp()) throw new Error("GitHub signs nobody in here");
        identity = await githubConnect.exchangeOAuthCode(code);
      } else if (provider === "gitlab") {
        if (gitlab === null || !await gitlabBot()) {
          throw new Error("GitLab signs nobody in here");
        }
        // GitLab redeems a code only with the redirect URI it was issued for; without one there
        // is nothing to ask it that it could accept.
        if (leg.redirectUri === null) {
          throw new Error("a GitLab code is redeemed with the redirect URI it was issued for");
        }
        identity = await gitlab.connect.exchangeForgeOAuthCode("gitlab", code, {
          redirectUri: leg.redirectUri,
          codeVerifier: leg.codeVerifier,
        });
      } else {
        throw new Error(`no such provider: ${provider}`);
      }
      return {
        accountId: identity.accountId,
        login: identity.login,
        name: identity.name,
        verifiedEmails: identity.verifiedEmails,
      };
    },
    // GitHub confirms an address only by a link mailed to it. A GitLab instance confirms what its
    // operator lets it: the self-managed default auto-confirms whatever is typed at sign-up, and
    // LDAP, SAML and OmniAuth accounts arrive confirmed on the upstream's word. Its addresses
    // name an account here, never prove one.
    trustsEmails: (provider) => provider === "github",
    async isOrgMember(provider, { login, accountId }): Promise<ProviderMembership> {
      if (provider === "gitlab") {
        if (gitlab === null || !await gitlabBot()) return "no-organization";
        // The forge's group gate, asked about the account id the exchange answered — never the
        // username, which a stranger can hold by now: any membership counts, and no group
        // configured says so.
        return await gitlab.connect.checkForgeMembership("gitlab", accountId, null);
      }
      if (provider !== "github") return "not-member";
      if (await githubUserMode()) return "no-organization";
      // Any installation's org counts. With none registered there is nobody to ask, and the
      // answer says so, rather than "no" (which reads as closed) or "unknown" (which reads as
      // retry): a fresh deployment refuses with the one thing an admin can do about it.
      const installations = await store.listInstallations();
      if (installations.length === 0) return "no-organization";
      let unanswered = false;
      for (const installation of installations) {
        const verdict = await githubConnect.checkOrgMembership(installation.installationId, login);
        if (verdict === "member") return "member";
        if (verdict === "unknown") unanswered = true;
      }
      return unanswered ? "unknown" : "not-member";
    },
  };
}
