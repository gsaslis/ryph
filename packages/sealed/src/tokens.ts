// Minting the small identifiers and bearer tokens every service hands out, the two halves of
// checking one (hashing it for storage, comparing hashes in constant time), and the keyed hash a
// signature or a derived secret is made of.
//
// Invariants:
// - ids are only [0-9a-z-], so path- and slug-safe (they ride URLs, k8s and container names,
//   and branch names)
// - an id's body is a UUIDv7, so ids with the same prefix sort by when they were minted
// - a raw token is never stored; only its SHA-256 lands in a row, and comparison is
//   constant-time so a token check leaks nothing through timing

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A UUIDv7 (RFC 9562): 48 bits of unix ms, version 7, 74 random bits, variant 0b10. */
function uuidv7(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

/** 128 bits as 26 lowercase Crockford base32 chars, the TypeID encoding (first char 0-7). */
function base32(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++, n >>= 5n) out = CROCKFORD[Number(n & 31n)] + out;
  return out;
}

/**
 * Regex source for the part of an id after `<prefix>-`. Ids minted before UUIDv7 have a 10-hex
 * body, which this also matches.
 */
export const ID_BODY = "[0-9a-z]{10,26}";

/** e.g. mintId("r") → "r-01jb7k3m9x4q8zt2vw6hn5c0fe" */
export function mintId(prefix: string): string {
  return `${prefix}-${base32(uuidv7())}`;
}

/** 256 bits of bearer token, hex — URL- and header-safe. */
export function mintToken(): string {
  return randomHex(32);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HMAC-SHA256 of `payload` under `secret` (its UTF-8 bytes as the key), hex. A string payload is
 * its UTF-8 bytes; raw bytes are signed as given — a webhook signature covers the body verbatim.
 */
export async function hmacSha256Hex(secret: string, payload: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload.slice();
  const mac = await crypto.subtle.sign("HMAC", key, bytes);
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality over same-length strings; unequal lengths are simply unequal. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
