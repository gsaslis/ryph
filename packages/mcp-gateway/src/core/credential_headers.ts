// Which header names a server's sealed credential may set. The credential's header map rides
// every forward and probe beside the headers the gateway sets itself, so a name that says where
// the request goes or how it is framed (Bun's fetch sends a caller-set `Host` as given) would let
// whoever typed it steer the request rather than authenticate it.
//
// Held at the API (src/schema.ts, `auth: "headers"`) AND at every use (http/proxy.ts,
// http/probe.ts): a row written straight into the database meets the same rule, and a name
// `Headers` would throw on (`" Host"`) is a coded refusal rather than a 500.

import { TOOL_GUARD_TOKEN_HEADER } from "./tool_guard.ts";

/** An RFC 9110 token: what a header name may be. */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/**
 * What a credential header's value may be: visible ASCII, words separated by single spaces
 * (`Bearer …`, `Token token=…`). Narrower than RFC 9110 allows on purpose — anything else
 * (a U+200B pasted with a key, an ideographic space) is a value `Headers` throws on with the
 * whole value in its message, or one a server reads differently from what was typed.
 */
export const HEADER_VALUE = /^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/;

/** The longest credential header value. */
export const MAX_HEADER_VALUE = 4096;

/** Names a credential may never set, lower-cased. */
export const REFUSED_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "content-length",
  "transfer-encoding",
  "connection",
  "te",
  "upgrade",
  "keep-alive",
  // Set last on a hosted forward anyway, so it could never shadow it; refused so nobody thinks so.
  TOOL_GUARD_TOKEN_HEADER.toLowerCase(),
]);

/** The prefix of the names a proxy reads for itself (`proxy-authorization`, `proxy-connection`). */
export const REFUSED_CREDENTIAL_HEADER_PREFIX = "proxy-";

/** Whether a credential may never set this header name (the model proxy holds the same set). */
export function refusedCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return REFUSED_CREDENTIAL_HEADERS.has(lower) ||
    lower.startsWith(REFUSED_CREDENTIAL_HEADER_PREFIX);
}

/** The refused names as one line, for an error message. */
export const REFUSED_CREDENTIAL_HEADERS_TEXT = `${
  [...REFUSED_CREDENTIAL_HEADERS].join(", ")
}, ${REFUSED_CREDENTIAL_HEADER_PREFIX}*`;

/** The marker on a forward or probe refused because the stored credential names a header it may not. */
export const CREDENTIAL_HEADER_REFUSED = "credential_header_refused";

/** Why `name` cannot be a credential header, or null. Never quotes a value. */
export function credentialHeaderProblem(name: string): string | null {
  if (!HEADER_NAME.test(name)) return "not a valid header name";
  if (refusedCredentialHeader(name)) {
    return `"${name}" is not allowed: it would change where or how the request goes`;
  }
  return null;
}

/**
 * Why a credential's header map cannot ride a request, or null when all of it may: a refused or
 * malformed name, or a value that is not `HEADER_VALUE`. Names a header, never a value.
 */
export function credentialHeadersProblem(headers: unknown): string | null {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return "it is not a header map";
  }
  for (const [name, value] of Object.entries(headers)) {
    const problem = credentialHeaderProblem(name);
    if (problem !== null) return problem;
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE || !HEADER_VALUE.test(value)) {
      return `the value of "${name}" is not visible ASCII text with single spaces between words`;
    }
  }
  return null;
}

/**
 * `text` with every header value that carried a secret — and each one's part after a scheme
 * (`Bearer <token>`) — replaced by `***`, longest first so a token inside a value is not left
 * half-shown. For a fetch error from a request that carried them, before it is logged or stored:
 * fetch and `Headers` can quote what they sent or refused.
 */
export function redactSent(text: string, values: readonly string[]): string {
  const secrets = values.flatMap((value) => {
    const space = value.indexOf(" ");
    return space === -1 ? [value] : [value, value.slice(space + 1).trim()];
  });
  let out = text;
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) out = out.split(secret).join("***");
  }
  return out;
}
