// The repo-file fetcher: `<repo url>@<ref>:<path>` → the file's text. The memory service holds
// no clone and no forge credential, so this reads the raw file anonymously from hosts that serve
// one — github.com, gitlab.com and the deployment's own GitLab instance — which covers public
// repositories and nothing else. A private repository's files are pasted or uploaded, or reach
// memory as an agent's proposals from inside a run, where the clone is. Adding a host is adding
// a raw-URL rule here.

import { type Fetcher, FetchRefusedError } from "../../ports/fetcher.ts";
import { canonicalRepo } from "../../core/subject.ts";
import { readDocument } from "./url.ts";

const LOCATOR = /^(.+?)@([^@:]+):(.+)$/;

/**
 * `<repo>@<ref>:<path>` parsed. Null when it is not one. `repo` is the canonical form, the
 * repository's identity; `address` is the same host and path as written, case kept, which is
 * what the raw file is fetched from. GitLab project paths are case-sensitive in URLs: it
 * answers a case mismatch with a redirect to the real spelling, which this never follows.
 */
export function parseRepoFileLocator(
  locator: string,
): { repo: string; address: string; ref: string; path: string } | null {
  const m = locator.trim().match(LOCATOR);
  if (m === null) return null;
  const path = m[3].replace(/^\/+/, "");
  if (path === "" || path.split("/").some((seg) => seg === "..")) return null;
  return { repo: canonicalRepo(m[1]), address: repoAddress(m[1]), ref: m[2], path };
}

/** `canonicalRepo`'s spelling with the path's case kept: only the host is lower-cased, as hosts
 * are case-insensitive. Lower-casing it gives `canonicalRepo`'s form exactly. */
function repoAddress(url: string): string {
  let s = url.trim();
  const scp = s.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp && !s.includes("://")) s = `${scp[1]}/${scp[2]}`;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  return slash === -1 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + s.slice(slash);
}

/** gitlab.com, the GitLab instance every deployment can read public files from. */
export const GITLAB_DOT_COM = "https://gitlab.com";

/** One GitLab project path segment: GitLab's own charset, never a dot segment, and never `-`,
 * which is the separator between a project's path and its routes (`/-/raw/…`). */
const GITLAB_SEGMENT = /^[a-z0-9_.-]+$/i;
const GITLAB_MAX_DEPTH = 20;

/**
 * The raw-file URL a host serves, or null for a host this cannot read from. `address` is a
 * repository's host and path as `parseRepoFileLocator` gives it, case kept: the host matches
 * case-insensitively, the path is fetched as written. Every segment is encoded, the owner and
 * repository included, so a locator cannot climb out of them.
 *
 * - github.com: `raw.githubusercontent.com/<owner>/<name>/<ref>/<path>`.
 * - A GitLab instance (gitlab.com and each of `gitlabInstances`, base URLs that may carry a
 *   path prefix): `<instance>/<group>/<sub…>/<project>/-/raw/<ref>/<path>`. Groups nest, so
 *   the project path is everything below the instance, 2 to 20 segments. The instance's own
 *   scheme is kept, so a self-managed one on plain http is read over http.
 */
export function rawUrlFor(
  address: string,
  ref: string,
  path: string,
  gitlabInstances: readonly string[] = [GITLAB_DOT_COM],
): string | null {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const gh = address.match(/^github\.com\/([^/]+)\/([^/]+)$/i);
  if (gh) {
    return `https://raw.githubusercontent.com/${encodeURIComponent(gh[1])}/${
      encodeURIComponent(gh[2])
    }/${encodeURIComponent(ref)}/${encodedPath}`;
  }
  for (const instance of gitlabInstances) {
    const base = gitlabBase(instance);
    if (base === null || !address.toLowerCase().startsWith(`${base.key}/`)) continue;
    const segments = address.slice(base.key.length + 1).split("/");
    if (segments.length < 2 || segments.length > GITLAB_MAX_DEPTH) return null;
    if (segments.some((seg) => !GITLAB_SEGMENT.test(seg) || /^\.+$/.test(seg) || seg === "-")) {
      return null;
    }
    // A ref holding a slash (`feature/x`) reaches /-/raw/ as `feature%2Fx`, which GitLab
    // resolves as one ref name (verified on GitLab 17.11, as is the private project's 302).
    return `${base.origin}/${segments.map(encodeURIComponent).join("/")}/-/raw/${
      encodeURIComponent(ref)
    }/${encodedPath}`;
  }
  return null;
}

/**
 * A GitLab instance's base URL as two spellings: `origin` (scheme, host and any path prefix,
 * no trailing slash) to build the raw URL from, and `key`, the same address in `canonicalRepo`'s
 * form, which a locator's repo must start with. Null for anything not an http(s) URL.
 */
function gitlabBase(instance: string): { origin: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(instance);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const prefix = url.pathname.replace(/\/+$/, "");
  return { origin: `${url.origin}${prefix}`, key: canonicalRepo(`${url.host}${prefix}`) };
}

/** The hosts a refusal names: github.com and each GitLab instance's. */
function readableHosts(gitlabInstances: readonly string[]): string {
  const hosts = ["github.com"];
  for (const instance of gitlabInstances) {
    const key = gitlabBase(instance)?.key;
    if (key !== undefined && !hosts.includes(key)) hosts.push(key);
  }
  return hosts.join(", ");
}

export interface RepoFileFetcherOptions {
  fetch?: typeof fetch;
  maxBytes?: number;
  /** The deployment's GitLab instance (`RYPH_GITLAB_URL`), read beside gitlab.com. Its base
   * URL, which may carry a path prefix. Absent or null: gitlab.com alone. */
  gitlabUrl?: string | null;
}

export function repoFileFetcher(opts: RepoFileFetcherOptions = {}): Fetcher {
  const doFetch = opts.fetch ?? fetch;
  const gitlabInstances = opts.gitlabUrl === undefined || opts.gitlabUrl === null
    ? [GITLAB_DOT_COM]
    : [GITLAB_DOT_COM, opts.gitlabUrl];
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  return {
    async fetch(locator) {
      const parsed = parseRepoFileLocator(locator);
      if (parsed === null) {
        throw new FetchRefusedError("a repo file is named as <repo url>@<ref>:<path>");
      }
      const url = rawUrlFor(parsed.address, parsed.ref, parsed.path, gitlabInstances);
      if (url === null) {
        throw new FetchRefusedError(
          `${parsed.repo} is not on a host this service can read raw files from ` +
            `(${readableHosts(gitlabInstances)}); ` +
            "paste or upload the file instead",
        );
      }
      let res: Response;
      try {
        // The host is pinned; a redirect off it is not followed, for the same reason the URL
        // fetcher refuses one. GitLab answers a private project's raw file with a redirect to
        // its sign-in page, which lands here too.
        res = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        throw new FetchRefusedError(`could not fetch: ${err instanceof Error ? err.message : err}`);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const spelling = caseOnlyRedirect(url, res.headers.get("location"));
        if (spelling !== null) {
          throw new FetchRefusedError(
            `the host names this repository ${spelling}; use that spelling, case included`,
          );
        }
        throw new FetchRefusedError(
          "the host redirected the file elsewhere, as it does for a private repository; " +
            "paste it instead",
        );
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchRefusedError(
          res.status === 404
            ? `${parsed.path} at ${parsed.ref} is not there, or the repository is private`
            : `the host answered ${res.status}`,
        );
      }
      return {
        title: `${parsed.repo}: ${parsed.path} @ ${parsed.ref}`,
        text: await readDocument(res, maxBytes),
      };
    },
  };
}

/**
 * The repository path a redirect points at when it differs from the requested raw URL only in
 * case — GitLab's answer to a project path spelt in the wrong case — or null for any other
 * redirect. Only named in the refusal, never followed: the fetch stays one request to a URL
 * built from the locator, and nothing the host answers picks the next address.
 */
function caseOnlyRedirect(requested: string, location: string | null): string | null {
  if (location === null) return null;
  try {
    const from = new URL(requested);
    const to = new URL(location, requested);
    if (to.origin !== from.origin || to.search !== "" || to.pathname === from.pathname) return null;
    if (to.pathname.toLowerCase() !== from.pathname.toLowerCase()) return null;
    const project = decodeURIComponent(to.pathname.split("/-/raw/")[0]).replace(/^\/+/, "");
    return project === "" ? null : `${to.host}/${project}`;
  } catch {
    return null;
  }
}
