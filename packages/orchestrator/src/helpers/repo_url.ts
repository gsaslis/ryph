// Matching a webhook's repo URL against a connected repo's stored one. The two spell the
// same repo differently ("https://github.com/Acme/App.git" vs ".../acme/app"), so equality
// is over this normal form, applied to BOTH sides at the lookup — never at storage, where
// the user-named spelling is the truth we keep.

export function normalizeRepoUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Do two repo URLs name the same host, on a scheme a credential could travel over? Used where
 * a credential minted for one URL is about to be offered to another: an origin is exactly the
 * scope git will attach an `http.<origin>.extraheader` to, so it is exactly the question worth
 * asking. Anything unparseable, or not http(s), is not a match — a credential has no business
 * on a scheme that cannot carry a header.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a.trim());
    const right = new URL(b.trim());
    if (left.protocol !== "http:" && left.protocol !== "https:") return false;
    return left.origin === right.origin;
  } catch {
    return false;
  }
}
