// Sealing secrets at rest: AES-256-GCM under a key derived per CLASS of secret from a
// deployment master key (64 hex chars). WebCrypto only — no dependencies.
//
// Which master seals which class is the caller's business: the model-proxy holds
// RYPH_SECRETS_KEY and seals provider keys, the mcp-gateway holds RYPH_MCP_KEY (which the binary
// defaults to RYPH_SECRETS_KEY) and seals MCP credentials. This module never sees an env var — it
// is handed an imported master, and each class derives its own AES key from it with HKDF-SHA256
// and a label of its own, so one master shared by two classes still gives two keys, and a value
// sealed for one class never opens as another.
//
// The sealed format is versioned. `v2.<iv>.<ciphertext>` (both base64) carries associated data
// the caller supplies: the class and the row's BINDING — its identity and wherever the secret is
// sent. Change the binding (point an MCP server's url, or a provider key's endpoint, somewhere
// else) and the value no longer opens; a database writer without the key cannot redirect a
// credential.
//
// Invariants:
// - a fresh random IV per seal; GCM with a reused IV forfeits both secrecy and integrity
// - decrypt authenticates (GCM tag and associated data): a tampered row, or a row read with a
//   binding other than the one it was sealed under, throws — it never yields garbage
// - the associated data is an unambiguous encoding (JSON of a fixed array shape), never a
//   concatenation two different bindings could collide in

/** The version tag every sealed value starts with. */
export const SEALED_FORMAT = "v2";

const INNER: unique symbol = Symbol("ryph.sealed.master");

/**
 * A master key, imported. Opaque: nothing outside this module can seal under it directly — a
 * class key is derived from it (`deriveSealingKey`).
 */
export interface MasterKey {
  readonly [INNER]: { hkdf: CryptoKey };
}

/** One class's sealing key, derived from a master. */
export interface SealingKey {
  /** The class label, also folded into every value's associated data. */
  readonly secretClass: string;
  readonly key: CryptoKey;
}

/**
 * What a sealed value is bound to: its row's identity and its destination, as named fields.
 * Every field is part of the associated data; null is a value of its own ("no endpoint"), not an
 * absent field.
 */
export type SealBinding = Readonly<Record<string, string | null>>;

const CLASS_LABEL = /^[a-z][a-z0-9-]{0,63}$/;

/** Imports the 64-hex-char master key. Throws on anything else — a truncated key must not "work". */
export async function importMasterKey(hex: string): Promise<MasterKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "the master key must be 64 hex characters (32 bytes) — mint one with: " +
        "openssl rand -hex 32",
    );
  }
  const raw: Uint8Array<ArrayBuffer> = new Uint8Array(
    hex.match(/../g)!.map((b) => parseInt(b, 16)),
  );
  const hkdf = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return { [INNER]: { hkdf } };
}

/**
 * The HKDF info label a class's key is derived under. Exported for the tests that pin it: a
 * changed label is a re-key of every row of that class.
 */
export function sealingKeyInfo(secretClass: string): string {
  return `ryph sealed ${secretClass} ${SEALED_FORMAT}`;
}

/**
 * A class's own AES-256-GCM key: HKDF-SHA256 over the master, no salt, the class's label as
 * info. Deterministic, so every replica holding the master derives the same key.
 */
export async function deriveSealingKey(
  master: MasterKey,
  secretClass: string,
): Promise<SealingKey> {
  if (!CLASS_LABEL.test(secretClass)) {
    throw new Error(`not a sealed-secret class: ${JSON.stringify(secretClass)}`);
  }
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(sealingKeyInfo(secretClass)),
    },
    master[INNER].hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { secretClass, key };
}

/**
 * The associated data: `["ryph-sealed", "v2", class, [[field, value], …]]` as JSON, fields
 * sorted by name. JSON quotes and escapes every string, so no two different bindings encode the
 * same bytes, and field order in the caller's object does not matter.
 */
export function associatedData(secretClass: string, binding: SealBinding): Uint8Array<ArrayBuffer> {
  const fields = Object.keys(binding).sort().map((name) => {
    const value = binding[name];
    if (value !== null && typeof value !== "string") {
      throw new Error(`sealed binding field "${name}" must be a string or null`);
    }
    return [name, value];
  });
  return new TextEncoder().encode(
    JSON.stringify(["ryph-sealed", SEALED_FORMAT, secretClass, fields]),
  );
}

const toBase64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf));
const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...atob(b64)].map((c) => c.charCodeAt(0)));

export async function encryptSecret(
  key: SealingKey,
  plaintext: string,
  binding: SealBinding,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(key.secretClass, binding) },
    key.key,
    new TextEncoder().encode(plaintext),
  );
  return `${SEALED_FORMAT}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/** Opens a `v2` value sealed under this class with exactly this binding; anything else throws. */
export async function decryptSecret(
  key: SealingKey,
  sealed: string,
  binding: SealBinding,
): Promise<string> {
  const [format, iv, ciphertext, extra] = sealed.split(".");
  if (format !== SEALED_FORMAT || !iv || !ciphertext || extra !== undefined) {
    throw new Error(
      `unknown sealed-secret format (expected "${SEALED_FORMAT}.<iv>.<ciphertext>")`,
    );
  }
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(iv),
      additionalData: associatedData(key.secretClass, binding),
    },
    key.key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plain);
}
