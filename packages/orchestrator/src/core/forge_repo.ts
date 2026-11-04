// A connected repo, as the forge boundary is addressed with it.
//
// One function, and it earns a file: `ConnectedRepo` is the row and `ForgeRepoRef` is the
// question the boundary answers, and every path that acts on a repo — submit, comment, react,
// read a thread, check a permission — has to make the same three-field translation. Written
// once, so a path that forgot the provider is a compile error rather than a repo acted on
// through the wrong forge.

import type { ConnectedRepo, ForgeProvider, InboundForgeEvent } from "./types.ts";
import type {
  Forge,
  ForgeProviders,
  ForgeRepoRef,
  GithubMode,
  GithubModeSource,
  GitlabMode,
} from "../ports/forge.ts";

export function forgeRepoRef(repo: ConnectedRepo): ForgeRepoRef {
  return {
    provider: repo.provider,
    repoRef: repo.repoRef,
    tenantId: repo.installationId,
    ...forgeIdOf(repo),
  };
}

/**
 * A connected repo's `forgeId` — a GitLab project's `<id>@<instance>` — spread into whatever names
 * the repo to the forge — a call, a run's git grant, its tool grant — so the forge addresses a
 * GitLab project by the id no rename changes, and refuses it once the deployment points at
 * another instance. Only GitLab's, and every GitLab repo's: the forge's schemas refuse an id on
 * any other provider's repo, and a GitLab repo without one.
 */
export function forgeIdOf(
  repo: Pick<ConnectedRepo, "provider" | "forgeId">,
): { forgeId?: string } {
  return repo.provider === "gitlab" && repo.forgeId !== undefined ? { forgeId: repo.forgeId } : {};
}

/**
 * Whether a GitHub row's tenant is one the forge can act as in `mode`: an installation in App
 * mode, none in user mode, and nothing at all when the forge runs no GitHub (null). A deployment
 * switched between the modes keeps its old rows, and the forge refuses each of them terminally,
 * so a lookup by name skips them rather than picking one up because it is newer. An unknown mode
 * (`undefined`: the forge did not answer, or nobody asked) fits everything: nothing is decided
 * on the strength of no answer. Rows of other forges always fit.
 */
export function tenantFitsMode(
  repo: Pick<ConnectedRepo, "provider" | "installationId">,
  mode: GithubMode | null | undefined,
): boolean {
  if (repo.provider !== "github" || mode === undefined) return true;
  if (mode === null) return false;
  return (repo.installationId === null) === (mode.mode === "user");
}

/**
 * Whether a GitLab row was connected on the instance the forge runs now: its `forgeId` an id on
 * `mode.url`. GitLab's ids are per instance, so a row from before `RYPH_GITLAB_URL` changed names
 * a project nobody connected here, and the forge refuses every question about it; with no
 * GitLab at all (null), no GitLab row is anybody's. `tenantFitsMode`'s twin, and like it an
 * unknown mode (`undefined`) fits everything and rows of other forges always fit.
 */
export function gitlabInstanceFits(
  repo: Pick<ConnectedRepo, "provider" | "forgeId">,
  mode: GitlabMode | null | undefined,
): boolean {
  if (repo.provider !== "gitlab" || mode === undefined) return true;
  if (mode === null || repo.forgeId === undefined) return false;
  // `<id>@<instance>`, as `@ryph/forge/gitlab-account`'s `gitlabProjectRef` spells it (which the
  // core does not import): the instance is everything after the id's `@`, compared exactly.
  const at = repo.forgeId.indexOf("@");
  return at > 0 && repo.forgeId.slice(at + 1) === mode.url;
}

/** A row the forge can act on as it runs now — `tenantFitsMode` and `gitlabInstanceFits` both:
 * one stranded by a mode switch, an instance change or its forge's removal is no connection,
 * skipped wherever repos are looked up by name or swept. */
export function fitsForge(
  repo: Pick<ConnectedRepo, "provider" | "installationId" | "forgeId">,
  github: GithubMode | null | undefined,
  gitlab: GitlabMode | null | undefined,
): boolean {
  return tenantFitsMode(repo, github) && gitlabInstanceFits(repo, gitlab);
}

/** How long the forge's GitLab answer is kept between passes (`GitlabModeSource`'s TTL). */
const PROVIDERS_TTL_MS = 60_000;
const gitlabModes = new WeakMap<object, { at: number; gitlab: ForgeProviders["gitlab"] }>();

/**
 * GitLab's mode as the forge last said it, asked at most once a `PROVIDERS_TTL_MS` per forge and
 * kept across a failed re-read; `undefined` while it never answered — the unknown every row fits
 * and nothing is polled on. For a sweep with the forge in hand and no `GitlabModeSource`.
 */
export async function gitlabModeOf(
  forge: Partial<Pick<Forge, "providers">> | null | undefined,
  now: number,
): Promise<ForgeProviders["gitlab"] | undefined> {
  if (forge?.providers === undefined) return undefined;
  const known = gitlabModes.get(forge);
  if (known !== undefined && now - known.at < PROVIDERS_TTL_MS) return known.gitlab;
  try {
    const { gitlab } = await forge.providers();
    gitlabModes.set(forge, { at: now, gitlab });
    return gitlab;
  } catch {
    if (known === undefined) return undefined;
    gitlabModes.set(forge, { at: now, gitlab: known.gitlab });
    return known.gitlab;
  }
}

/**
 * Whether the forge hears about `provider`'s repos by itself — webhooks from a GitHub App or a
 * GitLab bot, the Radicle bridge's events — or has to be polled for merges: GitHub and GitLab in
 * user mode take no webhooks. A provider not in `providers` hears nothing (nothing is connected
 * through it to poll either); `local` sends no events at all.
 */
export function providerHasEvents(
  provider: ForgeProvider,
  providers: Pick<ForgeProviders, "github" | "gitlab" | "radicle">,
): boolean {
  switch (provider) {
    case "github":
      return providers.github?.mode === "app";
    case "gitlab":
      return providers.gitlab?.mode === "bot";
    case "radicle":
      return providers.radicle !== null;
    case "local":
      return false;
  }
}

/**
 * Whether the forge writes on this repo AS ONE PERSON — a GitHub repo connected through a user
 * token (no installation), or any GitLab repo while GitLab runs in user mode — where ryph posts
 * no automatic chatter under their name. GitLab rows carry no tenant, so its answer is the
 * forge's mode; one not known (`undefined`) counts as a person, since the cost of a wrong "no"
 * is a status comment signed as somebody who never wrote it.
 */
export function actsAsPerson(
  repo: Pick<ConnectedRepo, "provider" | "installationId">,
  providers: Pick<ForgeProviders, "gitlab"> | undefined,
): boolean {
  switch (repo.provider) {
    case "github":
      return repo.installationId === null;
    case "gitlab":
      return providers?.gitlab?.mode !== "bot";
    case "radicle":
    case "local":
      return false;
  }
}

/** The mode a cached source holds, or `undefined` when there is no source or it never had an
 * answer — the "unknown" `tenantFitsMode` lets everything through on. */
export async function githubModeOf(
  source: GithubModeSource | null | undefined,
): Promise<GithubMode | null | undefined> {
  if (!source) return undefined;
  return await source.get().catch(() => undefined);
}

/**
 * Is this connected repo the one an inbound event is about?
 *
 * The pair (provider, address) is a repo's identity on its forge, and it is what the match is
 * made on — never the URL, which is one forge's spelling of an address and not the other's at
 * all. GitHub's addresses are compared case-insensitively, because GitHub is: "Acme/App" and
 * "acme/app" are one repository, and the two sides can capture different casings. A RID is
 * base58, where case is meaning, so it is compared exactly — folding it would let two distinct
 * repositories match each other.
 *
 * GitLab is never matched here: its path is a name the project can give up, and its events are
 * matched by the project id their webhook was verified for (core/event_repos.ts).
 */
export function namesRepo(
  repo: ConnectedRepo,
  event: Pick<InboundForgeEvent, "repo">,
): boolean {
  if (repo.provider !== event.repo.provider) return false;
  switch (repo.provider) {
    case "github":
      return repo.repoRef.toLowerCase() === event.repo.repoRef.toLowerCase();
    case "gitlab":
      return false;
    case "radicle":
      return repo.repoRef === event.repo.repoRef;
    case "local":
      // A local repository sends no events at all (the event schema has no `local`), and a
      // path is the forge's canonical real path, so if one ever did, exact is the only match.
      return repo.repoRef === event.repo.repoRef;
  }
}

/** A forge's name as a sentence spells it — the refusals a person reads say "GitHub", not the
 * column's value. */
export function forgeName(provider: ForgeProvider): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "radicle":
      return "Radicle";
    case "local":
      return "local";
  }
}

/**
 * The `checkPermission` threshold that means "may summon an agent on this repo", per forge.
 *
 * It is not the same tier on both, because "write" does not mean the same thing on both.
 * GitHub's write is a grant: somebody with admin on the repo added this person as a
 * collaborator, which is precisely the deliberate act this gate wants evidence of. Radicle's
 * write is not a grant at all — every peer pushes into its own namespace under its own key, so
 * a public repo answers "allowed" to any subject, and a gate asking for it would let anyone on
 * the network spend this deployment's budget by typing a comment. Delegacy is the nearest
 * Radicle equivalent of the deliberate act, so that is what is asked for there; whoever else
 * should be able to command agents is added to the repo's command allowlist by hand.
 *
 * Only the COMMAND gate uses this. "May you contribute here" — checking out a workspace
 * sibling, say — is still `"write"`, and on a public Radicle repo that is genuinely yes.
 */
export function commandTier(provider: ForgeProvider): "write" | "admin" {
  switch (provider) {
    case "github":
    case "gitlab":
      // GitLab's `write` is Developer or above: a member a Maintainer added, the same deliberate
      // act as a GitHub collaborator.
      return "write";
    case "radicle":
      return "admin";
    case "local":
      // No comment ever commands an agent on a local repository — it has no threads — so the
      // tier is never asked for. The stricter one, should that change without this.
      return "admin";
  }
}

/**
 * How a repository is named in text a RUN reads — prompts, inbox notes, tool answers. Its
 * forge address everywhere but on a `local` repository, whose address is an absolute path on
 * the deployment's own disk: that path tells the agent (and, through it, whatever it writes
 * to) where the owner keeps their code and what their home directory is called, and the run
 * has no use for it — it never sees the host. The repository's folder name stands in, the
 * name the owner gave it. Text a PERSON reads in ryph keeps the full address.
 */
export function runFacingRepoName(repo: Pick<ConnectedRepo, "provider" | "repoRef">): string {
  if (repo.provider !== "local") return repo.repoRef;
  // A local ref is the canonical absolute real path (schema.ts REPO_REF_PATTERNS): no trailing
  // slash, no empty segment, so the last segment is the folder's name and is never empty.
  return repo.repoRef.slice(repo.repoRef.lastIndexOf("/") + 1);
}

/**
 * Text written about a repository — a forge's failure message, most often — made fit for a run
 * to read: every spelling of a `local` repository's host path becomes its folder name
 * (`runFacingRepoName`). The forge words its answers for the person who reads `lastError` in
 * ryph, and the path is right there; the run's copy of the same answer must not carry it.
 * Text about any other repository passes unchanged.
 */
export function runFacingText(
  repo: Pick<ConnectedRepo, "provider" | "repoRef">,
  text: string,
): string {
  if (repo.provider !== "local") return text;
  return text.replaceAll(repo.repoRef, runFacingRepoName(repo));
}
