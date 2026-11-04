// AWS Signature Version 4, the small subset an S3 PUT/GET needs.
//
// Hand-rolled rather than pulled from an SDK for the reason every other credential path here is
// (the GitHub App JWT, the sealed-secret format): @aws-sdk/client-s3 is tens of megabytes of
// transitive npm for two verbs, and it would ride into every image that ships the forge. The
// algorithm is public, fixed, and covered below by AWS's own published test vectors.
//
// Deliberately NOT general: no chunked signing, no presigned URLs, no STS. What is here is what
// `put` and `get` send, and anything else should be added with its own vectors.

const ENCODER = new TextEncoder();

// `Uint8Array<ArrayBuffer>` throughout, not the bare alias: TypeScript's lib now parameterises
// Uint8Array by its buffer kind, and a plain `Uint8Array` widens to `ArrayBufferLike`, which
// will not flow back into the `key` the signing chain reassigns.
async function sha256(data: Uint8Array | string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === "string" ? ENCODER.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex sha256, which is what both the canonical request and the `x-amz-content-sha256` want. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, ENCODER.encode(data)));
}

/**
 * Percent-encodes one path segment per SigV4's rules, which are NOT `encodeURIComponent`'s:
 * the unreserved set is exactly A-Za-z0-9-._~ and everything else is encoded, uppercase hex.
 * Getting this wrong produces a signature mismatch on keys nobody tested with, which is the
 * kind of bug that only shows up on someone else's branch name.
 */
export function encodeSegment(segment: string): string {
  return [...ENCODER.encode(segment)]
    .map((byte) => {
      const c = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export interface SigV4Request {
  method: string;
  /** Already-encoded absolute path, starting with "/". */
  path: string;
  /** Canonical (sorted, encoded) query string, or "". */
  query?: string;
  /** Header names are lowercased and sorted here; values are trimmed. */
  headers: Record<string, string>;
  /** Hex sha256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

/**
 * Returns the headers to add: `authorization`, `x-amz-date`, and `x-amz-security-token` when the
 * credentials are temporary. The caller sends its own headers plus these; EVERY header passed in
 * is signed, so adding one afterwards breaks the signature — which is the failure mode worth
 * naming, because the service answers it as a generic 403.
 */
export async function signRequest(
  req: SigV4Request,
  creds: SigV4Credentials,
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  // `x-amz-date` and the session token are SigV4's own; `x-amz-content-sha256` is S3's, so the
  // caller adds it to `headers` and it gets signed like anything else. Keeping the signer free
  // of one service's requirements is what lets it be checked against generic vectors.
  headers["x-amz-date"] = amzDate;
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    req.method,
    req.path,
    req.query ?? "",
    canonicalHeaders,
    signedHeaders,
    req.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key: Uint8Array<ArrayBuffer> = ENCODER.encode(`AWS4${creds.secretAccessKey}`);
  for (const part of [dateStamp, creds.region, creds.service, "aws4_request"]) {
    key = await hmac(key, part);
  }
  const signature = toHex(await hmac(key, stringToSign));

  return {
    ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}),
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
