import type { ConnectedRepo } from "../../core/types.ts";
import { findRunSize } from "../../core/run_sizes.ts";
import { actsAsPerson, forgeName, forgeRepoRef } from "../../core/forge_repo.ts";
import type { ForgeProviders } from "../../ports/forge.ts";
import { can } from "@ryph/auth";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json } from "@ryph/shared/http";

/**
 * The live forge gate, at the moment of the action. A user must have linked their forge
 * account and hold at least `atLeast` on the repo; break-glass passes without a check
 * (recorded as break-glass wherever it acts). "unknown" — the forge did not answer — is
 * DENIED.
 *
 * Radicle bends both halves of that, because on Radicle the two tiers do not mean what
 * GitHub's mean.
 *
 * `admin` here is never a Radicle capability — Radicle has no such tier to check. It is
 * RYPH's own bar for changing how ryph behaves toward a repo: the submission policy (`auto`
 * puts patches on the forge with no human in between), the per-repo command allowlist, and
 * workspace membership. Radicle has no opinion about any of that, so gating it on delegacy
 * alone is arbitrary — and it would make it impossible to attach a repo whose delegates are
 * a different team, though seeding and reading someone else's public repository is entirely
 * permissionless and spends only this deployment's resources. So `repos:manage-all`
 * is a second way through, ALONGSIDE delegacy: a team still administers its own repos
 * without anybody handing them the platform.
 *
 * `write` on Radicle does not depend on who is asking at all for a public repository —
 * contribution is permissionless, and everybody writes to their own namespace — so the
 * adapter answers it on visibility, ignoring the subject. Demanding a linked DID before
 * asking a question the answer does not turn on would be pure friction, and would undo the
 * rule above. The check is handed a NULL subject instead — "there is no identity", which is
 * a spelling every layer down to the service's schema takes — and its verdict decides; a
 * private repository, where the allow list IS the answer, then correctly refuses the
 * unlinked caller. GitHub keeps the plain rule at both tiers: it has real permission tiers
 * and they mean what they say.
 *
 * A `local` repository has no forge identity at all — it is a directory on the forge's disk —
 * so neither tier is ever asked of the forge. `admin` is `repos:manage-all`, full stop: what
 * the deployment may read off its own machine is the deployment's admins' to decide, and
 * there is nobody else who could vouch for it. `write` is subjectless: anyone the deployment
 * already lets take the action (create a task, approve a patch) may take it here, which on a
 * local install is its owner. No linked login is looked up, because none could mean anything.
 *
 * A GitHub repo connected in user mode (no installation), and any GitLab repo while GitLab runs
 * in user mode, sit between the two: the forge is asked at both tiers, but always about the
 * token's login, whoever is calling. So `admin` there needs `repos:manage-all` AND the token's
 * live admin (Maintainer, on GitLab); `write` is the token's alone.
 *
 * GitLab in bot mode keeps GitHub's plain rule: `write` is Developer or above and `admin`
 * Maintainer or above, both asked live by the bot about the caller's linked ACCOUNT ID — never
 * the username stored with the link, which its holder can give up and a stranger register, who
 * would then pass every check asked about it.
 */
export async function refuseRepoPermission(
  deps: Pick<WiredDeps, "forge" | "identityDirectory">,
  caller: Principal,
  repo: ConnectedRepo,
  atLeast: "write" | "admin",
): Promise<Response | null> {
  if (caller.kind === "break-glass") return null;
  if (!deps.forge) {
    return json(503, { error: "the forge is not configured; connected repos are unavailable" });
  }
  // A local repository answers both tiers here, with no forge question — see the doc comment.
  if (repo.provider === "local") {
    if (atLeast === "write" || can(caller, "repos:manage-all")) return null;
    return json(403, {
      error: `${repo.repoRef} is a repository on this machine — managing it needs ` +
        "repos:manage-all",
    });
  }
  // A GitHub repo with no installation is one connected in user mode, where every user's login
  // is the token's (adapters/identity_directory/github_user_mode.ts): the live check below can
  // only say what the token's OWNER may do, so at `admin` it cannot tell one ryph user from
  // another. The same collapse as a local repository, the same answer: `admin` also needs
  // repos:manage-all, and the token must still hold admin, asked live below. `write` stays
  // the token's answer alone, as `local`'s is subjectless.
  // GitLab rows carry no tenant in either mode, so whether GitLab is one person's token here is
  // the forge's answer, asked live (administering is rare); a forge that did not say is no
  // answer, refused as an unverifiable check is.
  if (
    atLeast === "admin" && (repo.provider === "github" || repo.provider === "gitlab") &&
    !can(caller, "repos:manage-all")
  ) {
    let providers: Pick<ForgeProviders, "gitlab"> | undefined;
    if (repo.provider === "gitlab") {
      try {
        providers = await deps.forge.providers();
      } catch {
        return json(403, {
          error: `could not verify GitLab access to ${repo.repoRef} — treated as denied`,
        });
      }
    }
    if (actsAsPerson(repo, providers)) {
      return json(403, {
        error: `everyone here acts on ${forgeName(repo.provider)} as one account — ` +
          `administering ${repo.repoRef} needs repos:manage-all`,
      });
    }
  }
  // Before the identity is even looked up: what a ryph admin clears on a Radicle repo is
  // ryph's own administration, which no DID of theirs is about.
  if (atLeast === "admin" && repo.provider === "radicle" && can(caller, "repos:manage-all")) {
    return null;
  }
  // The identity on the repo's OWN forge: access is per forge, and a link made on another
  // one answers nothing here. Linked identities are auth's rows, read through the directory —
  // the subject a permission is asked about (a GitLab account id, never a username).
  const login = deps.identityDirectory
    ? await deps.identityDirectory.subjectFor(caller.userId, repo.provider)
    : null;
  // The one case a missing link does not settle by itself — see the doc comment. Everywhere
  // else (GitHub at either tier, Radicle `admin` a platform admin did not already clear)
  // the subject is the whole question, and asking it of nobody could only answer wrongly.
  const subjectless = repo.provider === "radicle" && atLeast === "write";
  if (login === null && !subjectless) {
    return json(403, {
      error: `link your ${forgeName(repo.provider)} account first — permissions are ` +
        "checked live",
    });
  }
  const permission = await deps.forge.checkPermission(
    forgeRepoRef(repo),
    // `login` may be null here, and is passed as null: the port spells "there is no identity"
    // that way all the way to the adapter, so the subjectless Radicle `write` above is a real
    // question rather than one about a user named "".
    { provider: repo.provider, subject: login },
    atLeast,
  );
  if (permission === "allowed") return null;
  if (permission === "unknown") {
    return json(403, {
      error: `could not verify ${forgeName(repo.provider)} access to ${repo.repoRef} — ` +
        "treated as denied",
    });
  }
  return json(403, {
    error: login === null
      // Only reachable for a private Radicle repo, where the allow list decides and we had
      // no DID to weigh against it. Say the thing the caller can act on.
      ? `${repo.repoRef} is not open to everyone — link your ${forgeName(repo.provider)} ` +
        "account so there is an identity to check"
      : repo.provider === "gitlab"
      // A GitLab subject is an account id, which names nobody a person would recognize.
      ? `your linked GitLab account does not have ${atLeast} access to ${repo.repoRef}`
      : `@${login} does not have ${atLeast} access to ${repo.repoRef}`,
  });
}

export function repoAccess(deps: WiredDeps) {
  const { config } = deps;

  /** `refuseRepoPermission` above, with this surface's deps. */
  const refuseRepoPermissionHere = (
    caller: Principal,
    repo: ConnectedRepo,
    atLeast: "write" | "admin",
  ) => refuseRepoPermission(deps, caller, repo, atLeast);

  /**
   * A size class change: an ADMIN's call (it spends the operator's money, like the egress
   * allowlist), and only to a class the configuration defines. Null (the deployment default) is
   * as privileged as any other value — moving a repo back to the default is still a cost
   * decision. Null here means proceed.
   */
  const refuseSizeClass = (caller: Principal, sizeClass: string | null): Response | null => {
    const refused = refuseUnless(caller, "resources:manage", "changing a size class");
    if (refused) return refused;
    if (sizeClass !== null && findRunSize(config.runSizes, sizeClass) === null) {
      return json(400, {
        error: `no size class "${sizeClass}" is configured (RYPH_RUN_SIZES)`,
        knownClasses: config.runSizes.classes.map((c) => c.name),
      });
    }
    return null;
  };

  return { refuseRepoPermissionHere, refuseSizeClass };
}
