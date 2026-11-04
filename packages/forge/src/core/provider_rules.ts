// The small per-provider spelling rules several paths share: whether a repo's address folds
// case, and what a login looks like. One place each, so a fourth forge is taught them once.

import type { ForgeProvider } from "./types.ts";

/**
 * Whether two spellings of a repo address differing only in case are ONE repository. GitHub's
 * "acme/App" and "acme/app" are, and so are GitLab's paths; a Radicle RID is base58, where case
 * is meaning, and a local path is the filesystem's to judge — folding either would let a
 * different repository read as ours.
 */
export function foldsCase(provider: ForgeProvider): boolean {
  return provider === "github" || provider === "gitlab";
}

/** Whether `a` and `b` name one repository on `provider` — `foldsCase`'s rule applied. */
export function sameRepoAddress(provider: ForgeProvider, a: string, b: string): boolean {
  return foldsCase(provider) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether a change request's head lives in the repo `repoRef` names: the forge's own answer by
 * identity where it gave one (`ChangeRequestHead.sameRepo`, GitLab's project ids — a renamed
 * project's own merge request names its NEW path, while the connected repo keeps the old one),
 * and the addresses compared, `foldsCase`'s rule applied, where it did not. A deleted fork's head
 * (`headRepoRef` null) lives nowhere.
 */
export function headInRepo(
  head: { headRepoRef: string | null; sameRepo?: boolean },
  provider: ForgeProvider,
  repoRef: string,
): boolean {
  if (head.headRepoRef === null) return false;
  if (head.sameRepo !== undefined) return head.sameRepo;
  return sameRepoAddress(provider, head.headRepoRef, repoRef);
}

/**
 * A login as each forge spells one. GitHub: `[A-Za-z0-9-]`, up to 39. GitLab: letters, digits,
 * `_`, `.` and `-`, not starting with `-`, up to 255. Radicle and local have no logins a footer
 * could name.
 */
const LOGIN: Partial<Record<ForgeProvider, RegExp>> = {
  github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  gitlab: /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/,
};

/** Whether `login` is a login on `provider` — anything else is dropped rather than echoed, above
 * all text that would mention somebody else or restyle what it lands in. */
export function isForgeLogin(provider: ForgeProvider, login: string): boolean {
  return LOGIN[provider]?.test(login) ?? false;
}
