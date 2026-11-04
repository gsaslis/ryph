// Identifier shapes, validated at the door.
//
// Every one of these values reaches a subprocess argument or a filesystem path, so "looks like a
// RID" is a security check and not a nicety: a RID is what names the storage directory the git
// gateway serves, and a COB id is what names the object `rad cob show` reads. Neither may
// contain a slash, a dot-dot or a dash that a CLI would read as a flag.

/** `rad:` + a multibase-btc identifier. Bare (no prefix) is accepted and normalized. */
const RID_BODY = /^z[1-9A-HJ-NP-Za-km-z]{20,64}$/;
/** A COB object id, or a unique prefix of one. Humans use 7 characters. */
const OID_PREFIX = /^[0-9a-f]{7,40}$/;
/** A full 40-character object id — what a sha resolves to. */
const FULL_OID = /^[0-9a-f]{40}$/;
/** A node id: the bare public key. */
const NID = /^z[1-9A-HJ-NP-Za-km-z]{40,64}$/;

export function isRid(value: string): boolean {
  return RID_BODY.test(value.startsWith("rad:") ? value.slice("rad:".length) : value);
}

/** Canonical `rad:z…` form. Throws for anything that is not a RID. */
export function normalizeRid(value: string): string {
  const body = value.startsWith("rad:") ? value.slice("rad:".length) : value;
  if (!RID_BODY.test(body)) throw new Error(`not a repository id: ${JSON.stringify(value)}`);
  return `rad:${body}`;
}

export function isOidPrefix(value: string): boolean {
  return OID_PREFIX.test(value);
}

export function isFullOid(value: string): boolean {
  return FULL_OID.test(value);
}

export function isNid(value: string): boolean {
  return NID.test(value);
}

/** Every 40-hex run in a blob of text, in order — how a patch id is scraped out of git's
 * stderr before it is confirmed against the COB itself. */
export function fullOidsIn(text: string): string[] {
  return [...text.matchAll(/\b[0-9a-f]{40}\b/g)].map((m) => m[0]);
}

/**
 * The only placeholders an explorer template may be written with. Every occurrence of each is
 * substituted:
 * - `{rid}` — the canonical `rad:z…` repository id
 * - `{kind}` — `patches` or `issues`
 * - `{id}` — the 40-hex object id of the change request or issue
 *
 * There is no other syntax: `${id}`, `:id` and `{patch}` are ordinary text and stay put.
 */
export const EXPLORER_PLACEHOLDERS = ["{rid}", "{kind}", "{id}"] as const;

/**
 * Whether a template would actually produce a per-object address.
 *
 * A template naming NONE of the placeholders is not "just link the seed" — it is a bare origin
 * like `https://app.radicle.xyz`, and rendering it gives every patch and every issue in every
 * repository the same URL: the explorer's home page. A link that is the same for everything is
 * worse than no link, because a caller cannot tell it apart from a real one. So it is invalid,
 * and a caller treats it as unset.
 */
export function isExplorerTemplate(template: string | null | undefined): boolean {
  if (!template) return false;
  return EXPLORER_PLACEHOLDERS.some((placeholder) => template.includes(placeholder));
}

/** Renders an explorer URL template. Unset — or naming no placeholder at all — is null. */
export function renderExplorerUrl(
  template: string | null | undefined,
  vars: { rid: string; id: string; kind: "patches" | "issues" },
): string | null {
  if (!template || !isExplorerTemplate(template)) return null;
  return template
    .replaceAll("{rid}", vars.rid)
    .replaceAll("{id}", vars.id)
    .replaceAll("{kind}", vars.kind);
}
