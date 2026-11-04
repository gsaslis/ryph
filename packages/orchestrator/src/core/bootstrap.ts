// The bootstrap bearer is also the encryption key: the database cannot recover the launch
// credentials from its digest. The bundle is opened BEFORE it is spent (a read, then the open,
// then a single DELETE ... RETURNING, across replicas), so one that cannot be opened is a clean
// refusal rather than a 500 after the bearer was already spent.
//
// Sealed as `v2` like every other secret at rest: the token's own key (never the deployment's
// master) stands in as the master, the `runner-bootstrap` class is derived from it, and the bundle
// is bound to the run it was sealed for — a row moved to another run opens nothing.
import {
  decryptSecret,
  deriveSealingKey,
  encryptSecret,
  importMasterKey,
  type MasterKey,
} from "@ryph/sealed";

const BOOTSTRAP_CLASS = "runner-bootstrap";

async function masterFor(token: string): Promise<MasterKey> {
  // Domain-separate from the SHA-256 authentication digest stored beside the ciphertext.
  // Using SHA-256(token) itself here would persist the encryption key as tokenHash.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`ryph:runner-bootstrap:credentials:v1\0${token}`),
    ),
  );
  return await importMasterKey([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export async function sealBootstrap(
  token: string,
  runId: string,
  env: Record<string, string>,
): Promise<string> {
  const key = await deriveSealingKey(await masterFor(token), BOOTSTRAP_CLASS);
  return encryptSecret(key, JSON.stringify(env), { runId });
}

/**
 * Opens a bundle with the token that matched it. Throws on anything it cannot open — the caller
 * answers that before the bundle is spent.
 */
export async function openBootstrap(
  token: string,
  runId: string,
  sealed: string,
): Promise<Record<string, string>> {
  const key = await deriveSealingKey(await masterFor(token), BOOTSTRAP_CLASS);
  const plain = await decryptSecret(key, sealed, { runId });
  const env: unknown = JSON.parse(plain);
  if (
    env === null || typeof env !== "object" || Array.isArray(env) ||
    !Object.values(env).every((v) => typeof v === "string")
  ) {
    throw new Error("a bootstrap bundle is a map of strings");
  }
  return env as Record<string, string>;
}
