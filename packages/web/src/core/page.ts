// FETCHING ONE PAGE: the redirect walk, the caps, the content-type decision, and the conversion.
// Pure given a `fetch` and a resolver, so every rule below is a test with a fake upstream and a
// fixed address table — no socket is opened by this package's suite.
//
// The invariants, each of which is a way this service could otherwise be turned against the
// cluster or the run:
// - redirect: "manual", always. Redirects are followed BY HAND so core/addresses.ts judges every
//   hop; `fetch`'s own following would carry the request to an address nothing checked.
// - at most MAX_REDIRECTS hops, then the chain is reported rather than followed further.
// - one deadline for the WHOLE call, redirects included — not one per hop, which a chain of slow
//   hosts would multiply.
// - the body is capped at MAX_BODY_BYTES as it streams, and a page past it is cut, not refused:
//   an agent asked to read something, and the first two megabytes of a giant page is an answer.
// - only text comes back. A PDF, an image or a binary is refused in words the agent can act on,
//   because the alternative is megabytes of mojibake spent from its context window.
//
// What this module does NOT do: decide what the agent sees. Framing, slicing and the untrusted-
// content notice are mcp/tools.ts's, over the whole text this returns.

import { type AddressPolicy, checkFetchUrl } from "./addresses.ts";
import { readTruncated } from "./body.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { ConversionRefusedError } from "../ports/converter.ts";

/**
 * The body cap for text that is handed over AS IT IS — plain text, markdown, JSON. Two megabytes
 * of those cost two megabytes: they are sliced, not parsed.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The body cap for HTML, which is lower because HTML is not kept — it is PARSED, twice in the
 * fallback path, scored by readability and rewritten. Measured on this machine, per megabyte of
 * adversarial HTML: link-dense soup ~1.1 s and ~240 MB resident, table soup ~0.6 s and ~170 MB,
 * and a deeply nested page **53 s** (that one never finishes — its worker is terminated at the
 * five-second budget). Two megabytes doubles all of it, for a page whose first megabyte already
 * yields more markdown than a slice can return. The cut is reported to the agent.
 */
export const MAX_HTML_BYTES = 1024 * 1024;
/** The whole call's deadline, redirects included. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** How many hops are followed by hand before the chain is reported instead. */
export const MAX_REDIRECTS = 5;

/** What kind of text came back, which decides how it was turned into what the agent reads. */
export type PageKind = "html" | "text" | "markdown" | "json";

export interface FetchedPage {
  /** The page's title when it has one. */
  title: string | null;
  /** The FINAL URL, after every redirect this followed. */
  url: string;
  /** How many hops were followed to reach it. */
  redirects: number;
  /** The upstream's content type, parameters stripped. */
  contentType: string;
  kind: PageKind;
  /** The whole page as text: markdown for HTML, the body itself for everything else. */
  text: string;
  /** Whether the body hit its cap and was cut before anything read it. */
  truncated: boolean;
  /** The cap that cut it, in bytes — null when nothing was cut. The answer quotes this rather
   * than a number written into a sentence, because HTML and text have different caps. */
  truncatedAtBytes: number | null;
}

/** A refusal written for the agent: what was not fetched, and why, in one sentence. */
export interface PageRefused {
  ok: false;
  detail: string;
}

export type PageOutcome = { ok: true; page: FetchedPage } | PageRefused;

export interface PageFetchDeps {
  /** The outbound fetch. Injected so the suite needs no network. */
  fetch: typeof fetch;
  /** Where this service may go (core/addresses.ts). */
  policy: AddressPolicy;
  /**
   * HTML → markdown, bounded and killable (ports/converter.ts). Omitted, the conversion runs
   * in-process: right for a test that is checking the markdown, wrong for the service, where one
   * hostile page would block every other run's tool calls for as long as it took.
   */
  convert?: (html: string, url: string) => Promise<{ title: string | null; markdown: string }>;
  timeoutMs?: number;
  /** Overrides MAX_BODY_BYTES (text, markdown, JSON). */
  maxBodyBytes?: number;
  /** Overrides MAX_HTML_BYTES (HTML, which is parsed rather than kept). */
  maxHtmlBytes?: number;
  /** What this service calls itself upstream. Sites answer differently to an unnamed client. */
  userAgent?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.1";

export async function fetchPage(rawUrl: string, deps: PageFetchDeps): Promise<PageOutcome> {
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxHtml = deps.maxHtmlBytes ?? MAX_HTML_BYTES;
  const convert = deps.convert ??
    ((html: string, url: string) => Promise.resolve(htmlToMarkdown(html, url)));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const verdict = await checkFetchUrl(current, deps.policy);
      if (!verdict.ok) {
        return {
          ok: false,
          detail: hop === 0
            ? `That URL cannot be fetched: ${verdict.detail}.`
            : `The page redirected to ${quote(current)}, which cannot be fetched: ` +
              `${verdict.detail}.`,
        };
      }
      let res: Response;
      try {
        res = await deps.fetch(verdict.url.href, {
          method: "GET",
          // By hand, so that every hop meets the guard above. gzip and br are handled by fetch.
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: ACCEPT,
            "accept-language": "en",
            "user-agent": deps.userAgent ?? DEFAULT_USER_AGENT,
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            detail: `${quote(current)} did not answer within the time allowed.`,
          };
        }
        return { ok: false, detail: `${quote(current)} could not be reached (${reasonOf(err)}).` };
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (location === null || location.trim() === "") {
          return {
            ok: false,
            detail: `${quote(current)} answered ${res.status} with no destination.`,
          };
        }
        const next = resolveLocation(location, verdict.url);
        if (next === null) {
          return {
            ok: false,
            detail: `${quote(current)} redirected to an address that is not a URL.`,
          };
        }
        current = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          ok: false,
          detail: `${quote(verdict.url.href)} answered ${res.status}${
            res.statusText ? ` ${quote(res.statusText, 60)}` : ""
          }.`,
        };
      }
      return await readPage(res, verdict.url.href, hop, { maxBody, maxHtml }, convert);
    }
    return {
      ok: false,
      detail: `That URL redirected more than ${MAX_REDIRECTS} times; the chain was not followed ` +
        `further (last: ${quote(current)}).`,
    };
  } finally {
    clearTimeout(deadline);
  }
}

/** What this service tells a site it is. A real contact, so an operator can ask us to stop. */
export const DEFAULT_USER_AGENT = "ryph-web/0.1 (agent tool; +https://github.com/ryph-hq/ryph)";

async function readPage(
  res: Response,
  url: string,
  redirects: number,
  caps: { maxBody: number; maxHtml: number },
  convert: (html: string, url: string) => Promise<{ title: string | null; markdown: string }>,
): Promise<PageOutcome> {
  const raw = res.headers.get("content-type") ?? "";
  const contentType = raw.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const kind = kindOf(contentType);
  if (kind === null) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      detail: `${quote(url)} is ${quote(contentType, 60)}, which this tool cannot read — it ` +
        "reads HTML, plain text, markdown and JSON. Look for an HTML or text version of the " +
        "same document.",
    };
  }
  // The cap is chosen by what the body IS, which the headers already said: HTML gets the lower
  // one because it is about to be parsed rather than kept.
  const cap = kind === "html" ? caps.maxHtml : caps.maxBody;
  let read;
  try {
    read = await readTruncated(res.body, cap);
  } catch (err) {
    return { ok: false, detail: `${quote(url)} stopped mid-answer (${reasonOf(err)}).` };
  }
  const body = decode(read.bytes, raw);
  if (kind === "html") {
    let converted;
    try {
      converted = await convert(body, url);
    } catch (err) {
      // The converter's refusals are written for the agent (a budget, a ceiling); anything else
      // is this service's business and becomes the generic one.
      return {
        ok: false,
        detail: err instanceof ConversionRefusedError
          ? `${quote(url)} could not be read: ${err.message}.`
          : `${quote(url)} could not be converted to markdown.`,
      };
    }
    return {
      ok: true,
      page: {
        title: converted.title,
        url,
        redirects,
        contentType,
        kind,
        text: converted.markdown,
        truncated: read.truncated,
        truncatedAtBytes: read.truncated ? cap : null,
      },
    };
  }
  const text = kind === "json" ? prettyJson(body) : body.trim();
  return {
    ok: true,
    page: {
      title: null,
      url,
      redirects,
      contentType,
      kind,
      text,
      truncated: read.truncated,
      truncatedAtBytes: read.truncated ? cap : null,
    },
  };
}

/**
 * The content types this tool reads, and what each becomes. Null: refuse it.
 *
 * The plain-text list is wider than it looks because so much of what an agent is sent to read is
 * served as something other than HTML: an RSS or Atom feed, a sitemap or any other XML document,
 * a CSV export. None of them needs converting — handing them over as they are is both correct
 * and cheaper than refusing and making the agent find another route to the same bytes.
 */
function kindOf(contentType: string): PageKind | null {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return "html";
  if (contentType === "text/markdown" || contentType === "text/x-markdown") return "markdown";
  if (contentType === "application/json" || contentType.endsWith("+json")) return "json";
  if (
    contentType === "text/plain" || contentType === "text/x-rst" ||
    contentType === "text/csv" || contentType === "text/tab-separated-values" ||
    contentType === "text/xml" || contentType === "application/xml" ||
    contentType === "application/rss+xml" || contentType === "application/atom+xml" ||
    contentType.endsWith("+xml")
  ) {
    return "text";
  }
  return null;
}

/** JSON as an agent can read it; a body that does not parse comes back as the text it is. */
function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.trim();
  }
}

type TextDecoderLabel = ConstructorParameters<typeof TextDecoder>[0];

/**
 * The charset the page declared, or UTF-8. Never fatal: a broken byte is a replacement char.
 *
 * Two places declare one, and the header is not always the one that does: plenty of servers send
 * a bare `text/html` for a page whose `<meta charset="windows-1252">` is the only truth about its
 * bytes, and decoding that as UTF-8 turns every quotation mark into a replacement character.
 * So when the header is silent, the first kilobyte is sniffed — which is where the spec requires
 * the declaration to be, and far enough from anything that could move it.
 */
function decode(bytes: Uint8Array, contentTypeHeader: string): string {
  const declared = contentTypeHeader.match(/charset=\s*"?([\w-]+)"?/i)?.[1] ??
    sniffCharset(bytes);
  for (const label of [declared, "utf-8"]) {
    if (label === undefined) continue;
    try {
      // The label is checked by the constructor, which throws on one it does not know.
      return new TextDecoder(label as TextDecoderLabel).decode(bytes);
    } catch {
      continue;
    }
  }
  return new TextDecoder().decode(bytes);
}

/** `<meta charset=…>` or a `content="text/html; charset=…"` http-equiv, in the first 1024 bytes. */
function sniffCharset(bytes: Uint8Array): string | undefined {
  // Latin-1 over the head, so the scan itself cannot fail on the encoding it is looking for.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1];
}

function resolveLocation(location: string, base: URL): string | null {
  try {
    return new URL(location, base).href;
  } catch {
    return null;
  }
}

/** An error's message, never its stack and never a header — this text reaches the agent. */
function reasonOf(err: unknown): string {
  return quote(err instanceof Error ? err.message : String(err));
}

/**
 * A fragment of SOMEBODY ELSE'S text inside a refusal the model reads: a URL the agent asked
 * for, the `Location` a redirect named, a `Content-Type` a server sent. Every one of them is
 * attacker-controllable, and a refusal is written in the platform's voice — so each is
 * flattened to one line, clipped hard, and wrapped in backticks, which is both a visual frame
 * and the thing that keeps a fragment from reading as the sentence around it.
 *
 * Backticks inside are dropped rather than escaped: this is a label, not content, and the whole
 * message is clipped again by the tool layer (mcp/tools.ts) as a backstop.
 */
export function quote(value: string, max = 120): string {
  const flat = value
    // The control characters are the point: a newline in a `Location` header is what writes a
    // line of its own in an answer the model reads as ours.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return `\`${clipped}\``;
}
