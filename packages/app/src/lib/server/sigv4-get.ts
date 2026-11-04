/**
 * Signing a GET, and nothing else.
 *
 * The assets bucket cannot be read anonymously — this organisation restricts IAM to its own
 * customer, so `allUsers` may not appear in a bucket policy — so the fallback reads it as a
 * service account instead. GCS answers S3 at storage.googleapis.com when the request carries an
 * AWS Signature Version 4, which makes the credential a pair of strings rather than a token to
 * fetch and keep fresh.
 *
 * `packages/forge/src/helpers/sigv4.ts` already implements SigV4 generally, checked against AWS's
 * published vectors, and this is deliberately not that. The app imports no workspace package and
 * its image copies no package but its own, so sharing one would mean a new workspace member
 * resolving through vite — more moving parts than the twenty lines below. What is here is the
 * subset a GET of a known object needs: no body, no query, no session token, no presigning.
 * Anything beyond that belongs in the forge's, shared properly.
 */

const ENCODER = new TextEncoder();

/** SHA-256 of the empty string — every request here has an empty body, so the hash is constant. */
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(data));
  return toHex(new Uint8Array(digest));
}

// `Uint8Array<ArrayBuffer>`, not the bare alias: TypeScript parameterises Uint8Array by its buffer
// kind now, and a plain `Uint8Array` widens to `ArrayBufferLike`, which will not flow back into the
// `key` the signing chain reassigns. The forge's signer carries the same note.
async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, ENCODER.encode(data)));
}

export interface GetSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** `auto` for GCS, which is what the forge sends against the same endpoint. */
  region: string;
}

/**
 * The headers to add to a GET so the store will answer it.
 *
 * Every header returned is covered by the signature, so adding one afterwards invalidates it —
 * the failure mode worth naming, because the store reports it as a bare 403.
 */
export async function signGet(
  url: URL,
  creds: GetSigningCredentials,
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;

  // The signed host must be exactly what the socket sends, port included when it is not default.
  const signed: Record<string, string> = {
    "host": url.host,
    "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join("");
  const signedHeaders = names.join(";");

  // No query string, and the path is already encoded by URL — re-encoding would address a
  // different object than the one the bucket lists.
  const canonicalRequest = [
    "GET",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key: Uint8Array<ArrayBuffer> = ENCODER.encode(`AWS4${creds.secretAccessKey}`);
  for (const part of [dateStamp, creds.region, "s3", "aws4_request"]) {
    key = await hmac(key, part);
  }
  const signature = toHex(await hmac(key, stringToSign));

  return {
    "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
    "x-amz-date": amzDate,
    "authorization": `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
