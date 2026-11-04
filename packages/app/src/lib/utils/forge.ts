/**
 * How the forges spell the same three things — a repository, a thread, and the identity of a
 * person — and how each of them is said in the UI. Every screen that names a repo or a thread
 * goes through here rather than testing `provider === "radicle"` on its own, because the rules
 * are not obvious: a GitHub thread is "#12", a GitLab one is "#12" or "!7" by its kind, a Radicle
 * one is the first seven characters of a 40-hex object id, and a RID is too long to print whole
 * anywhere but a tooltip.
 */
import type { ForgeProvider, ThreadKind } from "$lib/api/types";

/** A Radicle repository id: `rad:` plus a base58btc multibase string. */
const RID_PATTERN = /^rad:z[1-9A-HJ-NP-Za-km-z]+$/;

/** A Radicle identity, as `rad self` prints it. */
const DID_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

export function isRid(value: string): boolean {
  return RID_PATTERN.test(value.trim());
}

export function isDid(value: string): boolean {
  return DID_PATTERN.test(value.trim());
}

/**
 * Which forge an address belongs to, when only the address is at hand. A LAST RESORT: every row
 * that can carry a provider now does — a connected repo, a patch, a forge-tool ledger entry —
 * and those must be read rather than sniffed. What is left is the inbox's `forge` message
 * sender, which names a login, a repo address and a thread and nothing else. The spellings
 * cannot be confused there: a GitHub `owner/name` has no `rad:` prefix, and a local repo's
 * address is an absolute path, which neither of the others ever starts with. It never answers
 * GitLab: a `group/project` path is spelled exactly like an `owner/name`, so a GitLab row must
 * carry its provider.
 */
export function providerOfRepoRef(repoRef: string): ForgeProvider {
  if (repoRef.startsWith("rad:")) return "radicle";
  if (repoRef.startsWith("/")) return "local";
  return "github";
}

/**
 * Which forge a THREAD id belongs to, where neither a provider nor a repo address is at hand —
 * a task's `targetChangeRequest`, which names a connected repo by id and a thread by string.
 * GitHub numbers its issues and pull requests and Radicle hashes its objects (a 40-hex object id,
 * or a prefix of one). A local repo has no threads at all: the only ref it gives back is the
 * branch an approved patch landed on, and a branch name is whatever else is left. Like the
 * above: a fallback, never a default, and never GitLab, whose rows always carry their provider.
 */
export function providerOfThread(thread: string): ForgeProvider {
  if (/^\d+$/.test(thread)) return "github";
  if (/^[0-9a-f]{7,40}$/.test(thread)) return "radicle";
  return "local";
}

/**
 * A RID as it fits on a line: the first eight characters and the last four. The middle is the
 * part nobody reads, and the whole thing is always a hover or a copy away.
 */
export function shortenRid(rid: string): string {
  return rid.length <= 16 ? rid : `${rid.slice(0, 8)}…${rid.slice(-4)}`;
}

/** The same trick for a DID, which is longer still and just as unreadable. */
export function shortenDid(did: string): string {
  return did.length <= 22 ? did : `${did.slice(0, 16)}…${did.slice(-4)}`;
}

/** A forge identity as a row names it: a GitHub or GitLab login with its @, a DID shortened. A
 * local repo has no identities, so whatever is asked of it comes back as given. */
export function subjectLabel(provider: ForgeProvider, subject: string): string {
  switch (provider) {
    case "github":
    case "gitlab":
      return `@${subject}`;
    case "radicle":
      return shortenDid(subject);
    case "local":
      return subject;
  }
}

/** What the label helpers need of a repository: where it lives, how it is addressed, and the
 * name the forge gives it when it gives one at all (Radicle does; GitHub's and GitLab's are in
 * the address). */
export type ForgeRepoLike = {
  provider: ForgeProvider;
  repoRef: string;
  name?: string | null;
};

/**
 * A repository's human name. GitHub's `owner/name` IS its name, as is GitLab's
 * `group/sub/project` path and a local repo's path; a Radicle repo has a name in its identity
 * document and an address nobody can read, so it gets both when the name is known.
 */
export function forgeRepoLabel(repo: ForgeRepoLike): string {
  if (repo.provider !== "radicle") return repo.repoRef;
  const short = shortenRid(repo.repoRef);
  return repo.name ? `${repo.name} (${short})` : short;
}

/** The last segment of a local repo's path: the folder name, which is what a person calls it. */
export function localRepoName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/**
 * A GitLab thread ref's sigil and number: `issue-12` is `#12` and `mr-7` is `!7`, GitLab keeping
 * issues and merge requests in two separate number spaces. The ref spells its own kind; `kind` is
 * the fallback for a bare number, and a ref of neither shape comes back as given.
 */
function gitlabThread(kind: ThreadKind | null, thread: string): string {
  const issue = /^issue-(\d+)$/.exec(thread);
  if (issue) return `#${issue[1]}`;
  const mr = /^mr-(\d+)$/.exec(thread);
  if (mr) return `!${mr[1]}`;
  if (/^\d+$/.test(thread) && kind !== null) return `${kind === "issue" ? "#" : "!"}${thread}`;
  return thread;
}

/**
 * One thread — an issue or a change request — as it is referred to on its own forge: `#12` on
 * GitHub, `#12` for an issue and `!7` for a merge request on GitLab, the seven-character prefix
 * of the object id on Radicle, which is what `rad` itself prints and what a person would type
 * back at it. A local repo has no threads; the one ref it hands back is the branch an approved
 * patch landed on, and it is named as one. `kind` is null where the caller does not know it.
 */
export function threadLabel(
  provider: ForgeProvider,
  kind: ThreadKind | null,
  thread: string,
): string {
  switch (provider) {
    case "github":
      return `#${thread}`;
    case "gitlab":
      return gitlabThread(kind, thread);
    case "radicle":
      return thread.slice(0, 7);
    case "local":
      return `branch ${thread}`;
  }
}

/** A repository and a thread on one line: `acme/app#12`, `acme/web/app!7`, `my-repo abc1234`, or
 * `/home/ada/app branch ryph/fix`. GitHub and GitLab write the two together without a space,
 * the way their own cross-references do. */
export function repoThreadLabel(
  repo: ForgeRepoLike,
  kind: ThreadKind | null,
  thread: string,
): string {
  const label = forgeRepoLabel(repo);
  const name = threadLabel(repo.provider, kind, thread);
  return repo.provider === "github" || repo.provider === "gitlab"
    ? `${label}${name}`
    : `${label} ${name}`;
}

/** What a change request is called on each forge, singular. */
const CHANGE_REQUEST_NOUNS: Record<ForgeProvider, string> = {
  github: "pull request",
  gitlab: "merge request",
  radicle: "patch",
  local: "branch",
};

/** A change request in its own forge's word: "pull request", "merge request", "patch", or —
 * for a local repo, where one lands as a branch — "branch". */
export function changeRequestNoun(provider: ForgeProvider): string {
  return CHANGE_REQUEST_NOUNS[provider];
}

/** Joins words the way a sentence lists them: `a`, `a or b`, `a, b or c`. */
function listOf(words: string[], conjunction: string): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words.at(-1)}`;
}

/**
 * How a deployment's repos reach agents, for the line under the Repos title: "through the
 * GitHub App, GitLab or Ryph's Radicle node", "on this machine", or both kinds together. In
 * GitHub user mode there is no App to name, only GitHub; whose account it is gets a sentence of
 * its own, as does the account a GitLab deployment acts as. In Radicle user mode the node is this
 * machine's, not Ryph's own.
 */
export function reposReach(
  providers: ForgeProvider[],
  githubUserMode: boolean,
  radicleUserMode = false,
): string {
  const ways: Record<ForgeProvider, string | null> = {
    github: githubUserMode ? "GitHub" : "the GitHub App",
    gitlab: "GitLab",
    radicle: radicleUserMode ? "this machine's Radicle node" : "Ryph's Radicle node",
    local: null,
  };
  const through = listOf(
    (["github", "gitlab", "radicle"] as const)
      .filter((p) => providers.includes(p))
      .map((p) => ways[p])
      .filter((w) => w !== null),
    "or",
  );
  const parts = [
    through ? `through ${through}` : null,
    providers.includes("local") ? "on this machine" : null,
  ].filter((w) => w !== null);
  return parts.length === 2 ? `${parts[0]}, or ${parts[1]}` : (parts[0] ?? "");
}

/**
 * What an agent's work becomes on each provider, said together: "pull requests and branches".
 * With no provider known it is just "changes", so a sentence built on it still reads.
 */
export function deliveredAs(providers: ForgeProvider[]): string {
  if (providers.length === 0) return "changes";
  const nouns: Record<ForgeProvider, string> = {
    github: "pull requests",
    gitlab: "merge requests",
    radicle: "patches",
    local: "branches",
  };
  return listOf(providers.map((p) => nouns[p]), "and");
}
