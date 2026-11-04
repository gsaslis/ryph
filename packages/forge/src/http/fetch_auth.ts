// Where a run's base repo is fetched from, and with what. Shared because BOTH doors fetch:
// door ① on the clone's advertisement, door ② when intake finds the cache cold and has to warm
// it. One implementation, so the two can never disagree about which upstream a run's base
// comes from, which credential it is reached with, or which host that credential may be
// offered to.
//
// Invariants:
// - the upstream is the ADAPTER's answer, never the row's alone: a forge that is not a git
//   host (Radicle) has no fetchable address in its repo reference, and deriving one is the
//   adapter's business
// - the token is offered only to the origin of that upstream. That is safe because a connected
//   repo's URL comes off the row an admin connected, never from the task's author, so the pair
//   (tenant, origin) is one the deployment approved rather than one a caller composed
// - a tenant that cannot be minted for is an answer, not a fall-through: see below
// - the credential is minted when the cache is about to fetch, not before it is asked: a mint
//   that fails is then one more failed refresh, judged where every other one is. A mint the
//   forge REFUSED (a definitive 4xx) is `UpstreamRefused`, which the cache never serves around;
//   a mint that could not be asked (network, 5xx, a rate limit) is an outage like any other

import type { RepoCoords, RunGrantRepo } from "../core/types.ts";
import {
  anonymous,
  type Credential,
  type FetchAuth,
  repoCacheCoords,
  UpstreamRefused,
} from "../ports/repo_cache.ts";
import {
  type ForgeApi,
  ForgeApiError,
  type ForgeRegistry,
  type ForgeRepo,
  forgeRepoOf,
} from "../ports/forge_api.ts";
import { TokenMintError } from "../helpers/app_token.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { json } from "@ryph/shared/http";

/**
 * Where this member's base is fetched FROM, and with what — resolved together because the two
 * answers come from the same adapter and must never disagree.
 *
 * The URL is not always the connected repo's own address. GitHub is a git host, so there it
 * is; Radicle is not, so a RID resolves to a door on this deployment's own bridge. Asking the
 * adapter (`ForgeApi.upstreamUrl`) rather than reading the row is what keeps every fetching
 * path — the clone's advertisement, the upload-pack fallback, bundle intake — pointed at the
 * same place without any of them knowing which forge they are looking at.
 *
 * Three ways to get a null credential, all meaning "fetch as nobody" (the cache then falls
 * back to the deployment-level credential, if the operator configured one): a run whose repo
 * nobody granted us; a non-http upstream (a path, in dev and tests), where there is no header
 * to scope a credential to; and a deployment that runs no adapter for this repo's forge, which
 * cannot mint anything — a wiring mismatch worth a line in the log, but not worth failing a
 * public clone over.
 *
 * That last fallback reads the row's URL, and is taken ONLY when the URL is a network address
 * on a forge whose rows hold one — and never for GitLab, whose row's URL is a path that can have
 * changed hands (`upstreamFor` refuses a GitLab member before it gets here). A `local` row's URL is a path on this disk, and the adapter's
 * re-check (still inside the allowed root, still the repository that was connected) is the only
 * thing between it and a fetch: a forge with the local provider off — no root at all — would
 * otherwise clone whatever path the grant names. Likewise any URL that is not http(s): nothing
 * but an adapter can say it is safe to read. Those are refused, terminally, with a 502.
 *
 * `event` prefixes the diagnostics so a log line says which door was asking.
 */
function upstreamUrlFor(
  runId: string,
  repo: RunGrantRepo,
  deps: { forges?: ForgeRegistry | null; diag: Diagnostics },
  event: string,
): string | Response {
  if (!deps.forges?.has(repo.provider)) {
    const fetchable = repo.provider !== "local" && /^https?:\/\//.test(repo.url);
    deps.diag.warn(`${event}.no_forge_api`, {
      runId,
      repo: repo.connectedRepoId,
      provider: repo.provider,
      refused: !fetchable,
    });
    if (!fetchable) return json(502, { error: "could not resolve the base repo's upstream" });
    return repo.url;
  }
  try {
    return deps.forges.for(repo.provider).upstreamUrl(
      forgeRepoOf(repo),
      repo.url,
    );
  } catch (err) {
    // A repo address the adapter refuses to spell — a RID that is not one. Terminal in every
    // sense, but the gateway's vocabulary for "this repo cannot be reached" is a 502.
    deps.diag.warn(`${event}.no_upstream`, {
      runId,
      repo: repo.connectedRepoId,
      err: String(err),
    });
    return json(502, { error: "could not resolve the base repo's upstream" });
  }
}

/**
 * A credential resolved the first time the cache asks for it, and the same answer every time
 * after, so a request that refreshes a target and then a base mints once. The mint is not
 * attempted here: a credential that cannot be obtained is a failed refresh, and the cache is
 * where a failed refresh is judged. Distinct from a failed fetch on purpose all the same: the
 * repo is connected, so the adapter's credential IS the intended one, and falling through to an
 * anonymous fetch would turn "GitHub would not mint a token" into git's `could not read
 * Username`, which names nothing. So a mint that fails rejects, and `warn` says so in the log.
 */
function lazyCredential(
  mint: () => Promise<FetchAuth | null>,
  warn: (err: unknown) => void,
): Credential {
  let pending: Promise<FetchAuth | null> | undefined;
  return () => {
    pending ??= mint().catch((err) => {
      warn(err);
      throw refusedOrOutage(err);
    });
    return pending;
  };
}

/**
 * Whether the forge said no or could not be asked. A definitive 4xx on the mint (a suspended or
 * removed installation, a permission it does not hold) is the repo owner's decision, and the
 * cache must not serve a copy around it. 429 is a budget, not a decision, and stays an outage.
 * A terminal `ForgeApiError` is a no as well — a repo whose tenant does not fit the forge's mode
 * (an installation id in GitHub user mode) — and no retry or stale copy makes it a yes.
 */
function refusedOrOutage(err: unknown): unknown {
  if (err instanceof ForgeApiError && err.terminal) {
    return new UpstreamRefused("repo", err.message, { cause: err });
  }
  if (!(err instanceof TokenMintError)) return err;
  if (err.status < 400 || err.status >= 500 || err.status === 429) return err;
  return new UpstreamRefused("repo", err.message, { cause: err });
}

/** The credential the forge's own adapter mints for `repo`, lazily; anonymous where there is
 * nothing to present it to (a path upstream has no origin a header can be scoped to). */
export function credentialFor(
  api: ForgeApi,
  repo: ForgeRepo,
  url: string,
  warn: (err: unknown) => void,
): Credential {
  if (!/^https?:\/\//.test(url)) return anonymous;
  return lazyCredential(() => api.fetchAuth(repo, url), warn);
}

/**
 * The URL, the cache coordinates and the credential together. The credential is minted only when
 * a fetch spends it, so the upload-pack requests after an advertisement can use this for the
 * cache key and never mint.
 *
 * A member carrying a `forgeId` (a GitLab project) is fetched from where its forge places that
 * id NOW (`ForgeApi.locateUpstream`), never from the URL the grant was minted with: the project
 * may have been renamed and its old path taken by another, which a fetch by path would clone in
 * its place. So a GitLab member with no adapter to locate it, or no id, is refused (502) rather
 * than given `upstreamUrlFor`'s anonymous fall-through. Its cache entry is keyed by the id. A location that cannot be read is that fetch's
 * failed refresh — a refusal when the forge says the project is gone, an outage otherwise — so
 * the cache judges it like any other, and serves the entry it holds for THAT id or nothing.
 */
export async function upstreamFor(
  runId: string,
  repo: RunGrantRepo,
  deps: { forges?: ForgeRegistry | null; diag: Diagnostics },
  event: string,
): Promise<{ url: string; coords: RepoCoords; credential: Credential } | Response> {
  const warn = (err: unknown) =>
    deps.diag.warn(`${event}.token_unavailable`, {
      runId,
      repo: repo.connectedRepoId,
      err: String(err),
    });
  const api = deps.forges?.has(repo.provider) ? deps.forges.for(repo.provider) : null;
  if (repo.forgeId !== undefined || repo.provider === "gitlab") {
    // Located through its adapter or not at all: with no adapter (its config went missing) or
    // no id, the only address left is the grant's path, which may be somebody else's project
    // by now. Unlike a GitHub row's URL, it is never fetched — not even anonymously.
    if (api === null || repo.forgeId === undefined) {
      deps.diag.warn(`${event}.no_forge_api`, {
        runId,
        repo: repo.connectedRepoId,
        provider: repo.provider,
        refused: true,
      });
      return json(502, { error: "could not resolve the base repo's upstream" });
    }
    return await located(api, { ...repo, forgeId: repo.forgeId }, repo.url, warn);
  }
  const url = upstreamUrlFor(runId, repo, deps, event);
  if (url instanceof Response) return url;
  const coords = { url };
  if (api === null) return { url, coords, credential: anonymous };
  const credential = credentialFor(
    api,
    forgeRepoOf(repo),
    url,
    warn,
  );
  return { url, coords, credential };
}

/**
 * `upstreamFor` for a repo named by its forge id, and the service surface's equivalent: located
 * by the id, keyed by it, and credentialed for the address it has now. A forge that cannot
 * locate by id answers nothing rather than a fetch by the stale address.
 */
export async function located(
  api: ForgeApi,
  repo: ForgeRepo & { provider: RunGrantRepo["provider"]; forgeId: string },
  url: string,
  warn: (err: unknown) => void,
): Promise<{ url: string; coords: RepoCoords; credential: Credential }> {
  const coords = repoCacheCoords(url, repo);
  const failed = (err: unknown) => ({
    url,
    coords,
    credential: () => {
      warn(err);
      return Promise.reject(refusedOrOutage(err));
    },
  });
  if (api.locateUpstream === undefined) {
    return failed(new ForgeApiError(`${repo.provider} cannot locate a repo by its id`, true));
  }
  let at;
  try {
    at = await api.locateUpstream(repo);
  } catch (err) {
    return failed(err);
  }
  const here = { ...repo, repoRef: at.repoRef };
  return {
    url: at.url,
    coords: { ...coords, url: at.url },
    credential: credentialFor(api, here, at.url, warn),
  };
}
