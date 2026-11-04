// Verifying an OpenSSH `SSHSIG` signature — how a person proves they hold the Radicle key a
// DID names, because Radicle has no OAuth and never will.
//
// The flow it serves: ryph mints a nonce, the person runs
//
//     echo -n '<nonce>' | ssh-keygen -Y sign -n ryph -f ~/.radicle/keys/radicle
//
// and pastes the armored block back. `ssh-keygen -Y verify` would want an allowed-signers file
// and a subprocess; this is forty lines of parsing and one WebCrypto call, and it lets the key
// come from the DID rather than from a file on the server.
//
// The format (PROTOCOL.sshsig in OpenSSH):
//
//     MAGIC "SSHSIG" · uint32 version(1) · string publickey · string namespace
//                    · string reserved   · string hash_algorithm · string signature
//
// and what the signature is OVER is a different blob, built the same way:
//
//     MAGIC "SSHSIG" · string namespace · string reserved · string hash_algorithm
//                    · string H(message)
//
// Two things make this security-relevant rather than a parsing exercise, and both are checked
// below rather than assumed:
//
// - THE NAMESPACE. A signature is only valid for the namespace it was made in, and checking it
//   is what stops a signature the person made for some other tool (`git`, `file`) from being
//   replayed here. It is bound into the signed bytes, so an attacker cannot re-label one.
// - THE KEY. The key inside the armor is the signer's CLAIM. It is checked against the key the
//   DID encodes, so a valid signature by some other key proves nothing about this DID.

/** A DID's key, and the two facts a verification needs from the armor. */
export interface SshSig {
  /** The ed25519 public key the signature claims, raw (32 bytes). */
  publicKey: Uint8Array;
  namespace: string;
  hashAlgorithm: string;
  /** The ed25519 signature, raw (64 bytes). */
  signature: Uint8Array;
}

const MAGIC = new TextEncoder().encode("SSHSIG");
const ED25519_KEY_TYPE = "ssh-ed25519";

/** The multicodec prefix an ed25519 public key carries inside a `did:key`. */
const ED25519_MULTICODEC = [0xed, 0x01];

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc, as multibase's `z` prefix means it. Throws on a character outside the alphabet. */
export function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`${JSON.stringify(char)} is not base58`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes — base58's own encoding of them.
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * The ed25519 public key a `did:key:z6Mk…` encodes: multibase base58btc of the multicodec
 * prefix 0xed 0x01 followed by the 32 raw key bytes. Throws on anything that is not one — a
 * DID for another curve included, because a key this function cannot read is one no signature
 * here could be checked against.
 */
export function publicKeyFromDid(did: string): Uint8Array {
  const prefix = "did:key:z";
  if (!did.startsWith(prefix)) throw new Error("not a did:key in base58btc");
  const decoded = base58Decode(did.slice(prefix.length));
  if (
    decoded.length !== 2 + 32 ||
    decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new Error("not an ed25519 did:key");
  }
  return decoded.slice(2);
}

/** A reader over SSH wire format: length-prefixed strings, big-endian. */
class SshReader {
  #at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  uint32(): number {
    if (this.#at + 4 > this.bytes.length) throw new Error("truncated");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.#at, 4);
    this.#at += 4;
    return view.getUint32(0);
  }

  string(): Uint8Array {
    const length = this.uint32();
    if (this.#at + length > this.bytes.length) throw new Error("truncated");
    const out = this.bytes.slice(this.#at, this.#at + length);
    this.#at += length;
    return out;
  }

  text(): string {
    return new TextDecoder().decode(this.string());
  }

  get done(): boolean {
    return this.#at >= this.bytes.length;
  }
}

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * Parses the armored block `ssh-keygen -Y sign` writes — the PEM-shaped
 * `-----BEGIN SSH SIGNATURE-----` envelope and the binary inside it.
 *
 * Throws on anything malformed, and on a key or hash this cannot check, because "we could not
 * read it" and "it does not verify" must reach the caller as the same refusal: a link that is
 * not proven is not a link.
 */
export function parseSshSig(armored: string): SshSig {
  const body = armored
    .replace(/-----BEGIN SSH SIGNATURE-----/, "")
    .replace(/-----END SSH SIGNATURE-----/, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("not an SSH signature");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("the signature is not base64");
  }
  if (!startsWith(bytes, MAGIC)) throw new Error("not an SSHSIG signature");

  const reader = new SshReader(bytes.slice(MAGIC.length));
  const version = reader.uint32();
  if (version !== 1) throw new Error(`unsupported SSHSIG version ${version}`);

  // The public key blob is itself SSH wire format: a type string, then the key.
  const keyBlob = new SshReader(reader.string());
  const keyType = keyBlob.text();
  if (keyType !== ED25519_KEY_TYPE) {
    throw new Error(`${keyType} keys are not used on Radicle; expected ${ED25519_KEY_TYPE}`);
  }
  const publicKey = keyBlob.string();
  if (publicKey.length !== 32) throw new Error("not an ed25519 public key");

  const namespace = reader.text();
  reader.string(); // reserved, empty today and ignored by every implementation
  const hashAlgorithm = reader.text();

  // The signature blob, likewise: a type string, then the 64 raw bytes.
  const sigBlob = new SshReader(reader.string());
  const sigType = sigBlob.text();
  if (sigType !== ED25519_KEY_TYPE) throw new Error(`unexpected signature type ${sigType}`);
  const signature = sigBlob.string();
  if (signature.length !== 64) throw new Error("not an ed25519 signature");

  return { publicKey, namespace, hashAlgorithm, signature };
}

async function digest(algorithm: string, message: Uint8Array): Promise<Uint8Array> {
  const name = algorithm === "sha512" ? "SHA-512" : algorithm === "sha256" ? "SHA-256" : null;
  if (name === null) throw new Error(`unsupported hash algorithm ${algorithm}`);
  return new Uint8Array(await crypto.subtle.digest(name, message));
}

/**
 * Does `armored` prove that the holder of `did`'s key signed `message` in `namespace`?
 *
 * Returns a value rather than throwing, because every way of failing means the same thing to
 * the caller — the link is not proven — and a route that had to tell an unparseable signature
 * from a wrong one would be inviting itself to say which.
 */
export async function verifySshSig(
  armored: string,
  params: { did: string; namespace: string; message: string },
): Promise<boolean> {
  let sig: SshSig;
  let expectedKey: Uint8Array;
  try {
    sig = parseSshSig(armored);
    expectedKey = publicKeyFromDid(params.did);
  } catch {
    return false;
  }
  // The key in the armor is the signer's CLAIM. A valid signature by any other key proves
  // nothing about this DID, so the two are compared before anything is verified.
  if (sig.publicKey.length !== expectedKey.length) return false;
  if (!sig.publicKey.every((b, i) => b === expectedKey[i])) return false;
  // A signature is only valid for the namespace it was made in — what stops one the person
  // made for `git` or `file` from being replayed here.
  if (sig.namespace !== params.namespace) return false;

  try {
    const hashed = await digest(
      sig.hashAlgorithm,
      new TextEncoder().encode(params.message),
    );
    const signed = concat([
      MAGIC,
      sshString(params.namespace),
      sshString(new Uint8Array(0)), // reserved
      sshString(sig.hashAlgorithm),
      sshString(hashed),
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      sig.publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sig.signature,
      signed,
    );
  } catch {
    return false;
  }
}
