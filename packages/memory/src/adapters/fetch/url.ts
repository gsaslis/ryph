// The URL fetcher: one bounded GET of a public https page — this process sits inside the
// deployment's network, and a fetch it makes on a user's behalf must not become a way to read the
// metadata server or a peer's internal listener. Where it may go is web__fetch's rule, the same
// function (@ryph/web's checkFetchUrl): https only, the scheme's own port, no userinfo, and every
// address the name has globally routable — @ryph/shared/net's classification, which the MCP
// gateway's upstream guard holds too.
//
// The address check is the application's line; the deployment's egress policy is the other one.
// Both exist because each has a gap the other closes: a name can resolve one way for the check
// and another for the connection (rebinding), which only the network policy stops; and a policy
// that lets the pod reach the internet cannot tell a document from a metadata server, which only
// this check stops.
//
// An HTML page becomes text in web__fetch's conversion worker too, with its wall-clock budget and
// its ceiling: the page is somebody else's, and memory runs inside the control plane's process,
// where a conversion on the main thread stalls heartbeats, the API and webhooks with it.

import { readCappedText } from "@ryph/shared/http";
import {
  checkFetchUrl,
  ConversionRefusedError,
  type Converter,
  systemResolve,
  workerConverter,
} from "@ryph/web";
import { type Fetcher, FetchRefusedError } from "../../ports/fetcher.ts";

export interface UrlFetcherOptions {
  fetch?: typeof fetch;
  /** Resolves a hostname to its addresses, so a public name pointing at a private address is
   * refused too. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** HTML → text. Default: @ryph/web's worker converter in its text format. */
  converter?: Converter;
  maxBytes?: number;
  requestTimeoutMs?: number;
}

/** A URL fetcher and the way to free its converter at shutdown. */
export interface UrlFetcher extends Fetcher {
  close(): void;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** The response body, bounded as it streams. */
export async function readDocument(res: Response, maxBytes: number): Promise<string> {
  const read = await readCappedText(res, maxBytes);
  if (!read.ok) throw new FetchRefusedError(`the document is over ${maxBytes} bytes`);
  return read.text;
}

export function urlFetcher(opts: UrlFetcherOptions = {}): UrlFetcher {
  const doFetch = opts.fetch ?? fetch;
  const policy = { allowInsecure: false, resolve: opts.resolve ?? systemResolve };
  const converter = opts.converter ?? workerConverter({ format: "text" });
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    async fetch(locator) {
      const verdict = await checkFetchUrl(locator, policy);
      if (!verdict.ok) throw new FetchRefusedError(verdict.detail);
      const { url } = verdict;
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { accept: "text/markdown, text/plain, text/html;q=0.9, */*;q=0.1" },
          redirect: "manual",
          signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 20_000),
        });
      } catch (err) {
        throw new FetchRefusedError(`could not fetch: ${err instanceof Error ? err.message : err}`);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        // A redirect is followed by the caller re-ingesting the target it names, never here:
        // following it would let a public URL land on a private address after the check.
        throw new FetchRefusedError(
          `the URL redirects to ${res.headers.get("location") ?? "elsewhere"}; ingest that instead`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchRefusedError(`the URL answered ${res.status}`);
      }
      const body = await readDocument(res, maxBytes);
      const fallback = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") ||
        url.hostname;
      if (!(res.headers.get("content-type") ?? "").includes("html")) {
        return { title: fallback, text: body };
      }
      let page;
      try {
        page = await converter.convert(body, url.href);
      } catch (err) {
        if (err instanceof ConversionRefusedError) throw new FetchRefusedError(err.message);
        throw err;
      }
      return {
        title: page.title ?? fallback,
        text: page.title === null ? page.markdown : `${page.title}\n\n${page.markdown}`,
      };
    },
    close: () => converter.close(),
  };
}
