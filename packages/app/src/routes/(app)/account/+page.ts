import type { PageLoad } from "./$types";
import { listIdentities, listProviders } from "$lib/api/identities";
import { listPasskeys } from "$lib/api/passkeys";
import { listApiTokens, listSessions } from "$lib/api/account";
import { getAuthSettings, getMe } from "$lib/api/auth";
import { getForges, githubUserLogin } from "$lib/api/forge";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:settings");
  // `forges` is the forges a REPO can be connected through, which is what decides whether
  // there is a Radicle identity to prove at all; `providers` is who signs people in.
  const [identities, providers, forges, passkeys, sessions, tokens, me, settings] = await Promise
    .all([
      listIdentities(fetch),
      listProviders(fetch).catch(() => []),
      getForges(fetch).catch(() => null),
      listPasskeys(fetch),
      listSessions(fetch),
      listApiTokens(fetch),
      getMe(fetch),
      getAuthSettings(fetch).catch(() => null),
    ]);
  const githubLogin = githubUserLogin(forges);
  // The same for GitLab in user mode: one person's account, never linked by anyone else.
  const gitlabLogin = forges?.gitlab?.mode === "user" ? forges.gitlab.login : null;
  return {
    identities,
    // In GitHub (or GitLab) user mode there is one account there, the one Ryph acts as for
    // everyone, so nobody links their own.
    // Nor is either offered where the forge holds no OAuth client to link through.
    providers: providers.filter((p) =>
      !(p === "github" &&
        (githubLogin !== null ||
          (forges?.github?.mode === "app" && forges.github.signIn === false))) &&
      !(p === "gitlab" && (gitlabLogin !== null || forges?.gitlab?.signIn === false))
    ),
    forgeProviders: forges?.providers ?? [],
    githubLogin,
    gitlabLogin,
    passkeys,
    sessions,
    tokens,
    me,
    multiUser: settings?.multiUser ?? true,
  };
};
