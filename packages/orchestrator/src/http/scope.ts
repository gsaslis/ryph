// The scope a request reads under, and the grants a run view hands out. Both are decided here
// and nowhere else: the store takes the scope as a value, and the three services that hold a
// run's records take the grant as proof.

import { can } from "@ryph/auth";
import { mintId, mintRunGrant, RUN_GRANT_TTL_MS } from "@ryph/sealed";
import { forgeRepoRef } from "../core/forge_repo.ts";
import { REPO_ACCESS_TTL_MS, type RepoAccess, type Scope, SCOPE_ALL } from "../core/scope.ts";
import type { ConnectedRepo } from "../core/types.ts";
import type { ForgePermission } from "../ports/forge.ts";
import type { Principal, WiredDeps } from "./app.ts";
import { FORGE_CHECK_CONCURRENCY, mapWithConcurrency } from "../helpers/concurrency.ts";

/** The capability that widens a scope to everything: reading, or steering. */
export type Widening = "tasks:read-all" | "tasks:steer-all";

type ScopeDeps = Pick<WiredDeps, "store" | "forge" | "identityDirectory" | "now">;

/**
 * How long an "unknown" verdict (the forge could not say — a suspended installation, a
 * rate limit) keeps this process from asking again for the same (user, repo). Not persisted:
 * a real verdict lives in `repo_access` for `REPO_ACCESS_TTL_MS`, but "we could not ask" is
 * worth remembering for only long enough to survive a task page's poll, and a fresh replica
 * or restart is right to try again immediately. Read as not writable while it holds, same as
 * a denial — so a scoped list under an outage keeps whatever it already had, rather than
 * hammering the forge on every 3s poll for every connected repo.
 */
export const UNKNOWN_VERDICT_TTL_MS = 45_000;

/** In-process only, by design (see `UNKNOWN_VERDICT_TTL_MS`): `${userId}\0${connectedRepoId}` to
 * the ms timestamp the verdict stops being read as fresh. */
const unknownVerdicts = new Map<string, number>();

function unknownKey(userId: string, connectedRepoId: string): string {
  return `${userId}\0${connectedRepoId}`;
}

/**
 * What this caller may see: everything for break-glass and for a holder of the widening
 * capability, otherwise their own tasks plus the tasks on repos the forge lets them write.
 * The forge's answers come from the per-user cache; a live repo with no answer younger than
 * `REPO_ACCESS_TTL_MS` is asked about here, so a repo connected a minute ago is in scope on the
 * next request rather than after the cache turns over. With no forge configured nothing is
 * cached and a user sees their own.
 *
 * @example
 * const task = await store.getTask(id, await scopeFor(deps, caller, "tasks:read-all"));
 */
export async function scopeFor(
  deps: ScopeDeps,
  caller: Principal,
  widening: Widening,
): Promise<Scope> {
  if (caller.kind === "break-glass" || can(caller, widening)) return SCOPE_ALL;
  const now = deps.now();
  const cached = await deps.store.listRepoAccess(caller.userId);
  const fresh = cached.filter((row) =>
    now.getTime() - Date.parse(row.checkedAt) < REPO_ACCESS_TTL_MS
  );
  const answered = new Set(fresh.map((row) => row.connectedRepoId));
  const repos = (await deps.store.listConnectedRepos())
    .filter((repo) => repo.archivedAt === null && !answered.has(repo.id))
    .filter((repo) => {
      const key = unknownKey(caller.userId, repo.id);
      const until = unknownVerdicts.get(key);
      if (until === undefined) return true;
      if (until <= now.getTime()) {
        // Opportunistic cleanup: an expired hold is worth nothing kept, and this is the one
        // place that reads it back, so no separate sweep is needed to bound the map's size.
        unknownVerdicts.delete(key);
        return true;
      }
      return false;
    });
  const asked = repos.length === 0 ? [] : await askForge(deps, caller.userId, repos, now);
  return {
    kind: "principal",
    userId: caller.userId,
    writableRepoIds: [...fresh, ...asked].filter((row) => row.writable)
      .map((row) => row.connectedRepoId),
  };
}

/**
 * Asks the forge about these repos for one user and caches what it answered. The same question
 * every write asks live, with the same rule for an unlinked identity: a public Radicle repo is
 * writable by anyone, everywhere else nobody-in-particular is denied — and a local repository,
 * which has no identities at all, is writable by every user without the forge being asked. A verdict the forge could
 * not give is not writable for this request and is not persisted — `repo_access` holds only
 * verdicts the forge actually gave — but IS held briefly in-process (`UNKNOWN_VERDICT_TTL_MS`),
 * so one blip does not become one forge call per repo on every poll for as long as it lasts.
 */
async function askForge(
  deps: ScopeDeps,
  userId: string,
  repos: readonly ConnectedRepo[],
  now: Date,
): Promise<RepoAccess[]> {
  const forge = deps.forge ?? null;
  if (forge === null) return [];
  // One login lookup per forge, not per repo: every repo on a provider asks about the same login.
  const logins = new Map<ConnectedRepo["provider"], Promise<string | null>>();
  const loginOn = (provider: ConnectedRepo["provider"]): Promise<string | null> => {
    let login = logins.get(provider);
    if (login === undefined) {
      login = deps.identityDirectory
        ? deps.identityDirectory.subjectFor(userId, provider)
        : Promise.resolve(null);
      logins.set(provider, login);
    }
    return login;
  };
  const verdicts = await mapWithConcurrency(repos, FORGE_CHECK_CONCURRENCY, async (repo) => {
    // A local repository has no identity to ask about, and `write` on it is subjectless —
    // anyone the deployment lets act at all (`refuseRepoPermission`) — so nothing is asked.
    if (repo.provider === "local") return { repo, verdict: "allowed" as const };
    const login = await loginOn(repo.provider);
    const askable = login !== null || repo.provider === "radicle";
    const subject = { provider: repo.provider, subject: login };
    const verdict: ForgePermission = askable
      ? await forge.checkPermission(forgeRepoRef(repo), subject, "write")
      : "denied";
    return { repo, verdict };
  });
  const rows = verdicts.flatMap(({ repo, verdict }): RepoAccess[] => {
    if (verdict === "unknown") {
      unknownVerdicts.set(unknownKey(userId, repo.id), now.getTime() + UNKNOWN_VERDICT_TTL_MS);
      return [];
    }
    unknownVerdicts.delete(unknownKey(userId, repo.id));
    return [{
      id: mintId("ra"),
      userId,
      connectedRepoId: repo.id,
      writable: verdict === "allowed",
      checkedAt: now.toISOString(),
    }];
  });
  await deps.store.saveRepoAccess(rows);
  return rows;
}

/**
 * The credentials the orchestrator signs run grants with: one per service that holds a run's
 * records, each the service token that service already shares with the control plane. Null
 * for a service whose per-run reads then fall back to their own capability.
 */
export interface RunGrantKeys {
  history: string | null;
  models: string | null;
  tools: string | null;
}

/** What a run view carries so its holder may read the run on each service. */
export interface RunGrants {
  history: string | null;
  models: string | null;
  tools: string | null;
}

/**
 * Mints a run's grants, one per configured service, for the caller the view is shown to. Only
 * a view that already passed the scope check asks for them, so holding one is holding the proof
 * that the run was readable — by THAT person: the services take a grant only alongside a bearer
 * for the same subject.
 *
 * @example
 * const grants = await runGrantsFor(deps, caller, run.id);
 */
export async function runGrantsFor(
  deps: Pick<WiredDeps, "runGrantKeys" | "now">,
  caller: Principal,
  runId: string,
): Promise<RunGrants> {
  const keys = deps.runGrantKeys ?? { history: null, models: null, tools: null };
  const expiresAt = new Date(deps.now().getTime() + RUN_GRANT_TTL_MS);
  // Break-glass is auth off: nobody signs in, so the grant names nobody (and the services,
  // with auth off too, present no subject).
  const sub = caller.kind === "user" ? caller.userId : null;
  const mint = (key: string | null) =>
    key === null ? null : mintRunGrant(key, runId, sub, expiresAt);
  const [history, models, tools] = await Promise.all([
    mint(keys.history),
    mint(keys.models),
    mint(keys.tools),
  ]);
  return { history, models, tools };
}
