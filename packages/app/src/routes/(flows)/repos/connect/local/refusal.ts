import { ApiError } from "$lib/api/call";
import { LOCAL_REPO_REFUSALS, type LocalRepoRefusal } from "$lib/api/repos";

const messages: Record<LocalRepoRefusal, string> = {
  not_absolute: "Use the full path, starting with /.",
  outside_root: "Ryph is not allowed to read that folder.",
  not_found: "Nothing exists at that path.",
  not_directory: "That path points to a file. Use the repository's folder.",
  not_a_repository: "That folder is not a git repository. Use the repository's top folder.",
  linked_worktree: "That folder is a linked worktree or submodule. Use the main checkout.",
  bare_repository: "That repository has no working tree. Use a regular checkout.",
  no_default_branch: "That repository has no branch to start from. Check out a branch first.",
};

function isRefusal(value: unknown): value is LocalRepoRefusal {
  return typeof value === "string" && (LOCAL_REPO_REFUSALS as readonly string[]).includes(value);
}

/**
 * Why a path could not be added. `pinned` is true for an answer about the path itself (a 422
 * reason or a duplicate): sending the same path again would get the same answer, so the form holds
 * it until the path changes. Anything else (the check failing, the feature being off, the request
 * not arriving) leaves the form free to send it again.
 */
export interface LocalRepoFailure {
  message: string;
  pinned: boolean;
}

/** What to tell a person whose path could not be added, and whether it is the path's fault. */
export function localRepoFailure(e: unknown): LocalRepoFailure {
  if (!(e instanceof ApiError)) {
    // fetch rejects with a TypeError when the request never arrived.
    const message = e instanceof TypeError || !(e instanceof Error)
      ? "Ryph could not be reached. Try again."
      : e.message;
    return { message, pinned: false };
  }
  const body = e.body && typeof e.body === "object" ? e.body as Record<string, unknown> : null;
  if (e.status === 422) {
    const reason = body?.reason;
    if (reason === "outside_root" && typeof body?.root === "string" && body.root !== "") {
      return { message: `Ryph can only add repositories inside ${body.root}.`, pinned: true };
    }
    return { message: isRefusal(reason) ? messages[reason] : e.message, pinned: true };
  }
  if (e.status === 409) return { message: e.message, pinned: true };
  if (e.status === 403) {
    return { message: "Only an admin can add a repository from this machine.", pinned: false };
  }
  if (e.status === 502) {
    return { message: "Ryph could not check that path. Try again.", pinned: false };
  }
  if (e.status === 503) {
    return { message: "Adding repositories from this machine is turned off.", pinned: false };
  }
  return { message: e.message, pinned: false };
}

/** A path the server would refuse as not absolute, caught before the round trip. */
export function pathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return null;
  return messages.not_absolute;
}

/** A pasted folder path often ends in `/`; the server takes only the canonical spelling. Only
 * the trailing slashes go, so nothing about which folder is named changes. */
export function withoutTrailingSlash(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return stripped === "" && path.startsWith("/") ? "/" : stripped;
}
