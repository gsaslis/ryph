// The identity directory with the forges' user modes folded in, once, at wiring — rather than at
// the dozen call sites that ask `subjectFor(userId, "github")` or `subjectFor(userId, "gitlab")`.
//
// In a user mode (GitHub acting through one person's token, GitLab likewise) there is one
// identity on that forge, the token's, and every action is taken as it: so every ACTIVE user's
// subject there is the token's (its login on GitHub, its account id on GitLab), and every
// permission check asks the forge about it exactly as it asks about a linked one in App or bot
// mode. A deleted or deactivated user gets no
// login (the "link first" refusal, as an unlinked user elsewhere), and every capability, grant
// and scope check stays where it was, in front of this.
//
// Attribution is the one place that login would lie: "requested by @owner" on every change
// request, whoever asked. So `requesterFor` answers the user's ryph name there instead,
// sanitized to plain text that can @-mention nobody — never the token's login.
//
// Untouched: every other provider; `userIdsForLogin` and `userIdsForAccount`, which map an
// inbound forge event's actor back to users and have nothing to map in a user mode (no webhooks,
// and nobody links an account there); `isActiveUser`; `mayStartTasks`; `nameFor`. In App or bot
// mode — or while the forge has never said which mode it is in — `subjectFor` and `requesterFor`
// are the inner directory's, unchanged.

import type { IdentityDirectory } from "../../ports/identity_directory.ts";
import type { GithubModeSource } from "../forge/github_mode.ts";
import type { GitlabModeSource } from "../forge/gitlab_mode.ts";
import { chatDisplayName } from "../../core/thread_context.ts";

/** Each forge's cached mode; null where this deployment has no forge to ask. */
export interface ForgeModeSources {
  github: GithubModeSource | null;
  gitlab: GitlabModeSource | null;
}

export function forgeUserModeDirectory(
  inner: IdentityDirectory,
  modes: ForgeModeSources,
): IdentityDirectory {
  // A forge that has never answered cannot be in a mode we know; the linked identity (none, in
  // a user-mode deployment) is the answer, and the permission check that follows asks the same
  // unreachable forge.
  // The token's identity as a permission check names it: GitHub's login, GitLab's account id.
  const tokenSubject = async (provider: string): Promise<string | null> => {
    if (provider === "github") {
      const mode = await modes.github?.get().catch(() => undefined);
      return mode?.mode === "user" ? mode.login : null;
    }
    if (provider === "gitlab") {
      const mode = await modes.gitlab?.get().catch(() => undefined);
      return mode?.mode === "user" ? mode.accountId : null;
    }
    return null;
  };
  return {
    async subjectFor(userId, provider) {
      const shared = await tokenSubject(provider);
      if (shared === null) return await inner.subjectFor(userId, provider);
      return await inner.isActiveUser(userId) ? shared : null;
    },
    async requesterFor(userId, provider) {
      if (await tokenSubject(provider) === null) return await inner.requesterFor(userId, provider);
      const name = await inner.nameFor(userId);
      return name === null ? null : { name: chatDisplayName(name) };
    },
    userIdsForLogin: (provider, login) => inner.userIdsForLogin(provider, login),
    userIdsForAccount: (provider, accountId) => inner.userIdsForAccount(provider, accountId),
    isActiveUser: (userId) => inner.isActiveUser(userId),
    mayStartTasks: (userId) => inner.mayStartTasks(userId),
    nameFor: (userId) => inner.nameFor(userId),
  };
}
