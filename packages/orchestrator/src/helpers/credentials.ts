// How a pod is handed its two short-lived credentials — a git key for the gateway, an egress
// claim for the proxy — and how either is taken back out of anything the pod printed. One copy
// for the builds (core/environments.ts) and the check pods (core/checks.ts).
//
// Invariants:
// - a git credential rides `http.<origin>.extraheader`, never the URL, where it would land in
//   remotes, reflogs and error messages
// - a proxy claim rides the proxy URL's userinfo, which is how every HTTP client reads one; so a
//   pod that prints its environment prints it, and anything a pod printed is redacted before it
//   is stored or shown

/** `GIT_CONFIG_*` that make git send `authorization` to `origin`, and nowhere else. */
export function gitAuthEnv(origin: string, authorization: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}

/** The gateway's form of it: a minted key as the password of Basic auth. */
export function gatewayGitEnv(gatewayUrl: string, token: string): Record<string, string> {
  return gitAuthEnv(gatewayUrl, `Basic ${btoa(`x-access-token:${token}`)}`);
}

/**
 * The proxy variables for one claim: the subject's id and token as the proxy URL's userinfo.
 * Empty when the URL does not parse — the subject then has no way out, which every backend's
 * manifest already enforces or admits.
 */
export function proxyEnv(
  proxyUrl: string,
  subjectId: string,
  token: string,
): Record<string, string> {
  const url = URL.parse(proxyUrl);
  if (url === null) return {};
  url.username = encodeURIComponent(subjectId);
  url.password = encodeURIComponent(token);
  const proxy = url.href.replace(/\/$/, "");
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    // Clients differ on whether an IPv6 literal is matched with its URL brackets.
    NO_PROXY: "localhost,127.0.0.1,::1,[::1]",
    no_proxy: "localhost,127.0.0.1,::1,[::1]",
  };
}

/**
 * Text a pod printed, with every credential shape it could hold taken out: a URL's userinfo (the
 * proxy URL), an egress claim on its own (`v1.<payload>.<signature>`), and an `Authorization`
 * value (the git extraheader). A shape match, not a lookup: the replica storing a log is not the
 * one that minted the pod's credentials, and does not have them. So it is best-effort: a
 * credential the pod re-encoded (`echo $HTTPS_PROXY | base64`) has no shape left to match.
 *
 * The text is the head's, megabytes of it, so every pattern starts on a fixed literal (`://`,
 * `v1.`, `authorization:`) and each character is looked at a bounded number of times — a
 * pattern that opens on a repeatable class, like a URL scheme before `://`, is tried from every
 * position and turns `a.a.a.…` quadratic.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/:\/\/[^\s/@]+@/g, "://[redacted]@")
    .replace(/\bv1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(authorization:[ \t]*(?:basic|bearer)[ \t]+)[A-Za-z0-9+/=._~-]+/gi, "$1[redacted]");
}
