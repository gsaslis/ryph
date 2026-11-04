/**
 * A GitLab repo's page, from the address a connected row carries: its `http_url_to_repo`, the
 * clone URL, which ends in `.git`. The project page is the same path without it. Anything that
 * is not a web address comes back as given, for the caller's own `isWebLink` to refuse.
 */
export function gitlabProjectPage(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "");
}
