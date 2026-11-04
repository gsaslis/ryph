// An image digest: `sha256:` and 64 hex. What a run freezes, what a row records, what retention
// deletes — the places that decide whether a value is one, or which digest a reference pins, ask
// here, so they cannot disagree about what counts as pinned. (A scan for every digest a blob
// names, as docker's cache trimming does, is a different question and keeps its own pattern.)

/** The digest, as a pattern to embed (a SQL regex, a larger expression). */
export const DIGEST_PATTERN = "sha256:[0-9a-f]{64}";

const DIGEST = new RegExp(`^${DIGEST_PATTERN}$`);
const PINNED = new RegExp(`@(${DIGEST_PATTERN})$`);

/** Whether `value` is a digest itself. */
export function isDigest(value: string | null | undefined): value is string {
  return value != null && DIGEST.test(value);
}

/** The digest a reference is pinned to (`…@sha256:…`), or null — a bare image id pins nothing. */
export function digestOf(ref: string | null | undefined): string | null {
  return ref ? PINNED.exec(ref)?.[1] ?? null : null;
}
