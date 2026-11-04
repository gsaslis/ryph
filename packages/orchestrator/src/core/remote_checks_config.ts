// Instance-owned credentials. Never part of a suite manifest or a check container's environment.
export interface RemoteChecksConfig {
  url: string;
  token: string;
}

/** Validate even while checks are off, so enabling them cannot reveal a latent bad pairing.
 * Self detection is deliberately syntactic: DNS aliases cannot safely be resolved here. */
export function remoteChecksConfigFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  selfUrls: readonly string[] = [],
): RemoteChecksConfig | null {
  const rawUrl = env("RYPH_CHECKS_REMOTE_URL");
  const token = env("RYPH_CHECKS_REMOTE_TOKEN");
  if (rawUrl === undefined && token === undefined) return null;
  if (!rawUrl?.trim() || !token?.trim()) {
    return fail(
      "RYPH_CHECKS_REMOTE_URL and RYPH_CHECKS_REMOTE_TOKEN must be set together and non-empty",
    );
  }
  // Reject header-invalid tokens without ever printing their contents.
  if (/[^\x21-\x7e]/.test(token)) {
    return fail("RYPH_CHECKS_REMOTE_TOKEN must contain only visible ASCII characters");
  }
  const raw = rawUrl.trim();
  const invalid = () =>
    fail(
      "RYPH_CHECKS_REMOTE_URL must be an HTTPS URL (HTTP only on loopback), without credentials, query or fragment",
    );
  if (!/^https?:\/\//i.test(raw) || /[\s\\?#]/.test(raw) || /^https?:\/\/[^/]*@/i.test(raw)) {
    return invalid();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid();
  }
  const loopback = (hostname: string) =>
    hostname === "localhost" || hostname === "localhost." ||
    hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  if (
    url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
  ) {
    return invalid();
  }
  const identity = (u: URL) =>
    `${u.protocol}//${loopback(u.hostname) ? "loopback" : u.hostname}:${u.port}`;
  for (const self of selfUrls) {
    // Invalid optional public addresses are validated by their own configuration reader.
    if (URL.canParse(self) && identity(new URL(self)) === identity(url)) {
      return fail("RYPH_CHECKS_REMOTE_URL must not point to this instance");
    }
  }
  return { url: url.href.replace(/\/+$/, ""), token };
}
