// The master key that seals every provider secret — and, since the host defaults RYPH_MCP_KEY
// to it, every MCP server credential — this deployment stores. Minted on first launch rather
// than demanded from the operator.
//
// It used to be RYPH_SECRETS_KEY or nothing, and nothing was the default. So a fresh binary
// started, told you agents with a model policy would be refused, and left you to find out that
// the fix was 64 hex characters from `openssl rand`. Everything else about this binary
// provisions itself; there was no reason this could not.
//
// WHERE IT LIVES, and why not in the database: `ryph backup` snapshots the data directory, so
// a key inside it would turn every backup into a file containing both the sealed provider
// secrets and the thing that opens them. Beside the database instead — `<data>/../secrets.key`,
// owner-only — which keeps the property a backup already had: it is safe to copy, because on its
// own it opens nothing.
//
// The pairing is per-database, not per-machine. Two data directories get two keys, because a key
// is only meaningful against the ciphertext it sealed; one shared key would mean a database
// restored from elsewhere silently appearing to work.
//
// RYPH_SECRETS_KEY still wins when set. A postgres:// deployment gets no generated key by
// default: there is no local directory to pair one with, and a key minted per machine is exactly
// wrong for a database several machines share. RYPH_SECRETS_KEY_FILE names the file instead, for
// any database: the key is read from it, or minted into it on first launch. That is the
// single-machine postgres:// case (deploy/compose), where one process owns both the database and
// a volume to keep the key in, and a self-hoster should not have to run `openssl` first.

import { hkdfSync } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { writeSecretFile } from "@ryph/service";
import { dirname, isAbsolute, join } from "@std/path";
import { parseDbUrl } from "@ryph/db";

/** The variable naming the key's file outright, whatever the database. */
export const SECRETS_KEY_FILE_ENV = "RYPH_SECRETS_KEY_FILE";

/**
 * Where the key for this database lives, or null when there is nowhere to put one: the file
 * RYPH_SECRETS_KEY_FILE names, else beside a PGlite data directory. A relative file is refused,
 * since it would name a different file from every working directory.
 */
export function secretsKeyPath(
  dbUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const named = env[SECRETS_KEY_FILE_ENV]?.trim();
  if (named) {
    if (!isAbsolute(named)) {
      throw new Error(
        `${SECRETS_KEY_FILE_ENV} must be an absolute path, got ${JSON.stringify(named)}`,
      );
    }
    return named;
  }
  const target = parseDbUrl(dbUrl);
  if (target.kind !== "pglite" || target.dataDir === null) return null;
  return join(dirname(target.dataDir), "secrets.key");
}

/**
 * `bytes` bytes of CSPRNG as hex. Shared because this deployment mints more than one key and
 * they all want the same shape — `openssl rand -hex <bytes>` is the thing being replaced each
 * time, and a second hand-rolled version of it is a second place to get the padding wrong.
 */
/**
 * The egress proxy's claim key, derived from the master key (HKDF-SHA256, its own label) for a
 * deployment that wires a proxy address and supplies no key of its own. Both ends of every claim
 * are this process, so there is no second holder to hand it to, and deriving it keeps it stable
 * across restarts (a live run's claim outlives one) with nothing more to back up. One-way: the
 * claim key never gives the master key away.
 */
export function deriveEgressKey(masterHex: string): string {
  const key = hkdfSync(
    "sha256",
    Buffer.from(masterHex, "hex"),
    new Uint8Array(0),
    "ryph egress claims v1",
    32,
  );
  return Buffer.from(key).toString("hex");
}

export function mintHexKey(bytes = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 bytes of CSPRNG as 64 hex characters — the same thing `openssl rand -hex 32` produces. */
export function mintSecretsKey(): string {
  return mintHexKey(32);
}

/** The only shape a master key may have. Anything else is refused rather than padded or hashed. */
export function isSecretsKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

export interface SecretsKey {
  hex: string;
  /** Where it is stored, or null for a key that exists only for this process. */
  path: string | null;
  /** True when this launch created it — the caller says so once, and never again. */
  created: boolean;
}

/**
 * The key for this database: the environment's if set, the stored one if there is one, otherwise
 * a fresh one written owner-only.
 *
 * An in-memory database gets an ephemeral key that is never written. It dies with the process,
 * which is right — so does everything it sealed.
 *
 * Returns null only for a database with nowhere to keep a key (postgres:// without
 * RYPH_SECRETS_KEY_FILE), where the operator supplies RYPH_SECRETS_KEY or model access stays off.
 */
export async function loadOrCreateSecretsKey(dbUrl: string): Promise<SecretsKey | null> {
  const stored = await readSecretsKey(dbUrl);
  if (stored) return stored;

  const path = secretsKeyPath(dbUrl);
  if (path === null) {
    // pglite:memory:// has nowhere to keep one and needs no continuity, so it gets a key that
    // dies with the process — which is right, so does everything it sealed. Every other
    // pathless database (postgres:// without RYPH_SECRETS_KEY_FILE) is the operator's to supply
    // a key for.
    return parseDbUrl(dbUrl).kind === "pglite"
      ? { hex: mintSecretsKey(), path: null, created: true }
      : null;
  }
  return { hex: await writeSecretsKey(path, mintSecretsKey()), path, created: true };
}

/**
 * The key already in force for this database — the environment's, or the stored one — WITHOUT
 * minting anything. `ryph setup` needs to know whether there is one before it offers to make
 * one; `loadOrCreateSecretsKey` above is the same question asked by something willing to answer
 * it itself.
 */
export async function readSecretsKey(dbUrl: string): Promise<SecretsKey | null> {
  const fromEnv = process.env.RYPH_SECRETS_KEY;
  if (fromEnv) return { hex: fromEnv, path: null, created: false };

  const path = secretsKeyPath(dbUrl);
  if (path === null) return null;
  let stored: string;
  try {
    stored = (await readFile(path, "utf8")).trim();
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) return null;
    throw err;
  }
  // A truncated or hand-edited key is refused rather than "fixed": overwriting it would silently
  // orphan every provider secret it sealed, which is worse than failing to start.
  if (!isSecretsKey(stored)) {
    throw new Error(
      `${path} is not a 64-character hex key. It seals this database's provider secrets, so ` +
        "it is not replaced automatically — restore it, or delete it and re-add the keys.",
    );
  }
  return { hex: stored, path, created: false };
}

/**
 * Stores a key for this database, owner-only. Returns where it went, or null when this database
 * has nowhere to keep one — the caller (setup) then puts it in the settings file instead, which
 * is the only place left for a `postgres://` deployment that wants one.
 */
export async function storeSecretsKey(dbUrl: string, hex: string): Promise<string | null> {
  if (!isSecretsKey(hex)) throw new Error("a master key is 64 hex characters (32 bytes)");
  const path = secretsKeyPath(dbUrl);
  if (path === null) return null;
  await writeSecretsKey(path, hex.trim().toLowerCase());
  return path;
}

async function writeSecretsKey(path: string, hex: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  // Owner-only from its first byte, even over an older, wider file.
  await writeSecretFile(path, `${hex}\n`);
  return hex;
}
