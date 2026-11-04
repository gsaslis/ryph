// Downloading a file whole, with a byte cap that bites WHILE it streams: a chunked body announces
// no length, and buffering first to measure after is exactly the unbounded allocation the cap
// exists to prevent.

import { readCappedBytes } from "@ryph/shared/http";
import type { ImageDownload } from "../ports/transport.ts";

/**
 * One file downloaded whole, capped as it streams: a `content-length` over the cap is refused
 * before a byte is read, and a body that keeps coming past it is cancelled. Never throws — a
 * refusal, a reset, a deadline (`timeoutMs`, or the caller's `signal`) are each a `failed`
 * naming `label` and the status, never the URL: a Telegram file URL carries the bot's token. A
 * fetch error's own text is passed on only with the URL and every request header value taken out
 * (`redactSecrets`): Bun quotes a header it refuses whole, a bearer token with it.
 */
export async function downloadCapped(
  dial: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { label: string; maxBytes: number; timeoutMs: number; signal: AbortSignal },
): Promise<ImageDownload> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  const secrets = [url, ...headerValues(init.headers)];
  let res: Response;
  try {
    res = await dial(url, { ...init, signal });
  } catch (err) {
    return { kind: "failed", error: `${opts.label}: ${redactSecrets(errorText(err), secrets)}` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { kind: "failed", error: `${opts.label} answered ${res.status}` };
  }
  // A web page where a file was asked for is a sign-in page: Slack answers a token without
  // `files:read` with its login page and a 200. Said as what it is, not sniffed into "not an
  // image".
  if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
    await res.body?.cancel().catch(() => {});
    return { kind: "failed", error: `${opts.label} answered a web page, not the file` };
  }
  try {
    const read = await readCappedBytes(res, opts.maxBytes);
    return read.ok ? { kind: "bytes", bytes: read.bytes } : { kind: "too_large" };
  } catch (err) {
    return { kind: "failed", error: `${opts.label}: ${redactSecrets(errorText(err), secrets)}` };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every value a request's headers carry, and each one's credential after its scheme. Read
 * without `Headers`, which throws on the very values this is for. */
function headerValues(headers: RequestInit["headers"]): string[] {
  const entries: Array<[string, string]> = headers === undefined
    ? []
    : headers instanceof Headers
    ? [...headers]
    : Array.isArray(headers)
    ? headers.map(([name, value]) => [String(name), String(value)])
    : Object.entries(headers as Record<string, string>);
  const values: string[] = [];
  for (const [, value] of entries) {
    values.push(value);
    const space = value.indexOf(" ");
    if (space !== -1) values.push(value.slice(space + 1).trim());
  }
  return values;
}

/**
 * `text` with every secret in it replaced by `***`, longest first so a token inside a header
 * value is not left half-shown. For an error a request carrying a credential threw, before its
 * message is logged or answered: fetch and `Headers` quote what they refuse.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) out = out.split(secret).join("***");
  }
  return out;
}
