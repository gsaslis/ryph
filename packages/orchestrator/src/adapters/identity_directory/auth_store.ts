// `IdentityDirectory` over @ryph/auth's store — the mounted case, where auth's tables share
// the control plane's database and a read is a query, not a call.
//
// A GitLab link names one person on one instance: its account id is `<user id>@<instance URL>`
// (the forge's `gitlabAccountId`). A link made under another RYPH_GITLAB_URL names nobody on
// this one — its login may be a stranger's here — so it answers as no link at all, until the
// person links again. An inbound event's actor arrives as GitLab's bare numeric id, so the
// directory spells it on the current instance before looking it up: a link made under another
// URL never matches.
//
// And a GitLab person is that account id everywhere it decides something: it is the subject of a
// permission check (`subjectFor`), and a username is never looked up (`userIdsForLogin` answers
// nobody on GitLab). The username stored at link time is only a label, and possibly another
// person's by now — so a requester is named by the username GitLab gives the account NOW.

import { gitlabAccountId } from "@ryph/forge/gitlab-account";
import { type AuthStore, can, capsClaimOf, type ExternalIdentity } from "@ryph/auth";
import type { IdentityDirectory } from "../../ports/identity_directory.ts";
import type { GitlabConnect } from "../../ports/forge.ts";
import type { GitlabModeSource } from "../forge/gitlab_mode.ts";
import { chatDisplayName } from "../../core/thread_context.ts";

/** Whether a stored GitLab account id was linked on the instance at `url`. */
export function onGitlabInstance(accountId: string, url: string): boolean {
  return accountId.endsWith(gitlabAccountId(url, ""));
}

export function authStoreIdentityDirectory(
  store: AuthStore,
  instances: {
    gitlab: GitlabModeSource | null;
    /** Reads a GitLab account's current username, for naming a requester. Absent: GitLab
     * requesters are named by their ryph name. */
    gitlabUsers?: Pick<GitlabConnect, "gitlabLogin"> | null;
  },
): IdentityDirectory {
  /** Whether a linked row names someone on the forge this deployment talks to now. A GitLab
   * that has never said where it is, or is gone, vouches for no row. */
  const gitlabUrl = async (): Promise<string | null> =>
    (await instances.gitlab?.get().catch(() => null) ?? null)?.url ?? null;
  const current = async (identity: ExternalIdentity): Promise<boolean> => {
    if (identity.provider !== "gitlab") return true;
    const url = await gitlabUrl();
    return url !== null && onGitlabInstance(identity.providerAccountId, url);
  };
  const linked = async (userId: string, provider: string) => {
    const identity = await store.getIdentity(userId, provider);
    return identity !== null && await current(identity) ? identity : null;
  };
  /** The user's ryph name as plain text that pings nobody, or null. */
  const named = async (userId: string) => {
    const user = await store.getUserById(userId);
    return user?.status === "active" ? { name: chatDisplayName(user.name) } : null;
  };
  return {
    async subjectFor(userId, provider) {
      const identity = await linked(userId, provider);
      if (identity === null) return null;
      // GitLab's subject is the account id (on this instance, `linked` checked), never the
      // username stored with it.
      return provider === "gitlab" ? identity.providerAccountId : identity.login;
    },
    async requesterFor(userId, provider) {
      const identity = await linked(userId, provider);
      if (identity === null) return null;
      if (provider !== "gitlab") return { login: identity.login };
      // The account's username NOW, by its id: the stored one may have been renamed away and
      // registered by somebody else, whom a mention of it would name.
      const login = await instances.gitlabUsers?.gitlabLogin(identity.providerAccountId)
        .catch(() => null) ?? null;
      return login === null ? await named(userId) : { login };
    },
    async nameFor(userId) {
      const user = await store.getUserById(userId);
      return user?.status === "active" ? user.name : null;
    },
    async userIdsForLogin(provider, login) {
      // Nobody on GitLab is found by username: it may be anybody's by now.
      if (provider === "gitlab") return [];
      const out: string[] = [];
      for (const identity of await store.listIdentitiesByLogin(provider, login)) {
        if (await current(identity)) out.push(identity.userId);
      }
      return out;
    },
    async userIdsForAccount(provider, accountId) {
      let key = accountId;
      if (provider === "gitlab") {
        const url = await gitlabUrl();
        if (url === null) return [];
        key = gitlabAccountId(url, accountId);
      }
      const identity = await store.getIdentityByAccount(provider, key);
      return identity === null ? [] : [identity.userId];
    },
    async isActiveUser(userId) {
      return (await store.getUserById(userId))?.status === "active";
    },
    async mayStartTasks(userId) {
      const user = await store.getUserById(userId);
      // The role read now, not at sign-in: these doors hold no token, so a demotion counts from
      // the moment it is saved.
      return user?.status === "active" && can({ caps: capsClaimOf(user.role) }, "tasks:create");
    },
  };
}
