// GitHub App credentials: the App's private key signs a short-lived JWT, and that JWT mints
// per-installation access tokens — the only GitHub credentials this system ever holds, and
// they live HERE, in the boundary package, and nowhere else.
//
// Invariants:
// - the private key is imported once and never re-exported; only signatures leave
// - installation tokens are cached WELL short of their 1-hour expiry (10 minutes of margin),
//   so a token handed to a long git push cannot expire mid-operation
// - both PEM encodings GitHub hands out are accepted: the download button gives PKCS#1
//   ("BEGIN RSA PRIVATE KEY"), which WebCrypto cannot import — it is wrapped into PKCS#8
//   here rather than making every operator run openssl

/** The slice of Diagnostics this helper needs, declared locally (helpers never reach ports). */
export interface TokenTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Imports a GitHub App private key PEM (PKCS#8 or GitHub's PKCS#1) as an RS256 signer. */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replaceAll("\\n", "\n").trim();
  const body = (label: string): Uint8Array | null => {
    const match = normalized.match(
      new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`),
    );
    if (!match) return null;
    return new Uint8Array([...atob(match[1].replace(/\s+/g, ""))].map((c) => c.charCodeAt(0)));
  };

  let pkcs8 = body("PRIVATE KEY");
  const pkcs1 = body("RSA PRIVATE KEY");
  if (pkcs8 === null && pkcs1 !== null) pkcs8 = wrapPkcs1InPkcs8(pkcs1);
  if (pkcs8 === null) {
    throw new Error("not a private key PEM (expected BEGIN [RSA] PRIVATE KEY)");
  }
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as Uint8Array<ArrayBuffer>,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// PKCS#8 is a thin envelope: SEQUENCE { version 0, rsaEncryption AlgorithmIdentifier,
// OCTET STRING <the PKCS#1 bytes> }. Twenty lines of DER beats an openssl prerequisite.
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const derLen = (n: number): number[] => {
    if (n < 0x80) return [n];
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return [0x80 | bytes.length, ...bytes];
  };
  const tlv = (tag: number, content: number[] | Uint8Array): number[] => [
    tag,
    ...derLen(content.length),
    ...content,
  ];
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier: OID 1.2.840.113549.1.1.1 (rsaEncryption) + NULL params.
  const algorithm = tlv(0x30, [
    ...tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
    0x05,
    0x00,
  ]);
  const keyOctets = tlv(0x04, pkcs1);
  return new Uint8Array(tlv(0x30, [...version, ...algorithm, ...keyOctets]));
}

/** The App JWT GitHub authenticates App-level calls with: 10 minutes max, clock-skewed back. */
export async function mintAppJwt(
  appId: string,
  key: CryptoKey,
  nowMs: number,
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(utf8(JSON.stringify({
    iat: nowSec - 60, // a minute back: GitHub rejects tokens from "the future" on skew
    exp: nowSec + 9 * 60,
    iss: appId,
  })));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    utf8(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

export interface AppTokenVendorOptions {
  appId: string;
  key: CryptoKey;
  /** GitHub's API base — overridable so tests run against a fake. */
  apiBase: string;
  diag: TokenTracer;
  now?: () => number;
  /** How long one mint may wait on GitHub before it counts as failed; 15 seconds by default,
   * the budget every other REST call in this package gets. A GitHub that hangs rather than
   * refuses must fail like one that refuses, or the caller waiting on the token hangs with it. */
  timeoutMs?: number;
}

/**
 * A narrowed installation token: only these repositories (names, without the owner), only these
 * permissions. GitHub mints it from the same installation and refuses to widen it past what the
 * installation holds — so a token asked for with one repo and one permission can do exactly that.
 */
export interface TokenScope {
  repositories: string[];
  permissions: Record<string, "read" | "write">;
}

/**
 * A mint GitHub refused, carrying the status it refused with.
 *
 * The status is on the error rather than only in its message because ONE status is a fact a
 * caller acts on: a scoped mint asking for a permission the installation does not hold comes
 * back 422 (and a suspended installation 403), and that is "the App was never granted this",
 * not an outage. A caller that has to parse it back out of a sentence is one rewording away
 * from treating a permission gap as a failure to retry.
 */
export class TokenMintError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TokenMintError";
    this.status = status;
  }
}

/** Mints (and caches) installation access tokens. One vendor per process. */
export interface AppTokenVendor {
  /** Without a scope, everything the installation holds; with one, only that. Cached per scope. */
  installationToken(installationId: string, scope?: TokenScope): Promise<string>;
}

/** The cache key a scope mints under: the same scope in any order is the same token. */
function scopeKey(installationId: string, scope: TokenScope | undefined): string {
  if (scope === undefined) return installationId;
  const repositories = [...scope.repositories].sort();
  const permissions = Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b));
  return `${installationId}|${JSON.stringify([repositories, permissions])}`;
}

// Installation tokens live 1 hour; reuse until 10 minutes remain.
const REUSE_MARGIN_MS = 10 * 60 * 1000;

export function appTokenVendor(opts: AppTokenVendorOptions): AppTokenVendor {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cache = new Map<string, { token: string; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<string>>();

  const mint = async (
    installationId: string,
    scope: TokenScope | undefined,
    key: string,
  ): Promise<string> => {
    const jwt = await mintAppJwt(opts.appId, opts.key, now());
    const res = await fetch(
      `${opts.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(scope === undefined ? {} : { "content-type": "application/json" }),
        },
        body: scope === undefined ? undefined : JSON.stringify(scope),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const body = (await res.json().catch(() => null)) ?? {};
    if (res.status !== 201 || typeof body.token !== "string") {
      throw new TokenMintError(
        `minting an installation token failed (${res.status}): ${
          typeof body.message === "string" ? body.message : "no detail"
        }`,
        res.status,
      );
    }
    const expiresAtMs = typeof body.expires_at === "string"
      ? Date.parse(body.expires_at)
      : now() + 60 * 60 * 1000;
    if (cache.size > 1_000) {
      for (const [k, entry] of cache) {
        if (entry.expiresAtMs - REUSE_MARGIN_MS <= now()) cache.delete(k);
      }
    }
    cache.set(key, { token: body.token, expiresAtMs });
    opts.diag.debug("app_token.minted", { installationId, scoped: scope !== undefined });
    return body.token;
  };

  return {
    installationToken(installationId: string, scope?: TokenScope): Promise<string> {
      const key = scopeKey(installationId, scope);
      const hit = cache.get(key);
      if (hit && hit.expiresAtMs - REUSE_MARGIN_MS > now()) return Promise.resolve(hit.token);

      // Concurrent submissions against one installation share the mint rather than each
      // spending a round trip; the entry clears either way, so a failure never sticks.
      const pending = inFlight.get(key);
      if (pending) return pending;
      const minting = mint(installationId, scope, key).finally(() => inFlight.delete(key));
      inFlight.set(key, minting);
      return minting;
    },
  };
}
