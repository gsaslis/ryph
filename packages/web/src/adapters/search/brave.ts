// The Brave Search API as a SearchBackend. One GET, one header, and the shape of the answer
// mapped onto the port's — nothing of Brave's vocabulary leaves this file.
//
// THE KEY. It arrives here from the environment (RYPH_WEB_SEARCH_KEY) and is spent on exactly
// one host. It is never returned, never logged, never put in an error a tool call can read: a
// provider refusal becomes a sentence about the provider, because the agent asking for search
// results is the last party that should learn anything about the credential behind them. Neither
// does the agent's query travel anywhere else — one request, one upstream.
//
// `text_decorations=0` asks Brave for snippets without its <strong> markup; residual tags are
// stripped anyway, because a snippet is rendered into a model's context and markup there is
// noise at best.

import {
  type SearchBackend,
  type SearchQuery,
  SearchRefusedError,
  type SearchResult,
} from "../../ports/search.ts";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** The tool's freshness words in Brave's spelling. */
const FRESHNESS: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

export interface BraveSearchOptions {
  /** The subscription token. Held here and nowhere else. */
  key: string;
  /** Injected for the suite; the process-wide fetch otherwise. */
  fetch?: typeof fetch;
  /** Overridden only by tests that want a fake host; the default is Brave's. */
  endpoint?: string;
  timeoutMs?: number;
}

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
      age?: unknown;
      page_age?: unknown;
    }>;
  };
}

export function braveSearch(options: BraveSearchOptions): SearchBackend {
  const dial = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    provider: "brave",
    async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
      const url = new URL(endpoint);
      url.searchParams.set("q", query.query);
      url.searchParams.set("count", String(query.count));
      url.searchParams.set("result_filter", "web");
      url.searchParams.set("text_decorations", "0");
      if (query.freshness !== undefined) {
        url.searchParams.set("freshness", FRESHNESS[query.freshness]);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await dial(url.href, {
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip",
            "x-subscription-token": options.key,
          },
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
      } catch {
        throw new SearchRefusedError("the search provider could not be reached");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SearchRefusedError(refusalFor(res.status));
      }
      let body: BraveResponse;
      try {
        body = await res.json() as BraveResponse;
      } catch {
        throw new SearchRefusedError("the search provider answered something unreadable");
      }
      return (body.web?.results ?? []).slice(0, query.count).flatMap((r) => {
        const url = typeof r.url === "string" ? r.url : null;
        if (url === null) return [];
        const age = typeof r.age === "string" && r.age !== ""
          ? r.age
          : typeof r.page_age === "string" && r.page_age !== ""
          ? r.page_age
          : undefined;
        return [{
          title: plain(r.title) || url,
          url,
          snippet: plain(r.description),
          ...(age === undefined ? {} : { age }),
        }];
      });
    },
  };
}

/**
 * What the AGENT is told when the provider says no. Deliberately about the provider and this
 * deployment's relationship with it — a status code is enough for an operator reading the logs,
 * and more than that would describe a credential to a caller who must not learn about it.
 */
function refusalFor(status: number): string {
  if (status === 401 || status === 403) {
    return "web search is not working on this deployment: the search provider refused its " +
      "credential. Tell the person who asked; they need an operator";
  }
  if (status === 429) return "the search provider is rate-limiting this deployment right now";
  if (status === 422) return "the search provider would not take that query";
  if (status >= 500) return "the search provider is having trouble right now";
  return `the search provider refused the request (${status})`;
}

/** A snippet as plain text: no markup, no runs of whitespace, no surprises. */
function plain(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
