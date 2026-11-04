// The one thing a search backend must do, behind one method. Brave is the first (and today the
// only) implementation; the tool, its result rendering and every test above this line know
// nothing about which provider answered, so a second one is an adapter and a config value.
//
// The provider's KEY never crosses this port: an adapter closes over it, spends it on its own
// upstream, and hands back results. Nothing here can be logged into a credential leak.

/** How fresh a result must be. The tool's vocabulary; an adapter maps it to the provider's. */
export type Freshness = "day" | "week" | "month" | "year";

export interface SearchQuery {
  /** What the agent asked, verbatim. */
  query: string;
  /** How many results to return, 1–10. The backend may answer with fewer. */
  count: number;
  /** Only results this recent, when the provider can say. */
  freshness?: Freshness;
}

/** One result, in the shape the tool renders: everything optional beyond a title and a URL. */
export interface SearchResult {
  title: string;
  url: string;
  /** The provider's snippet, plain text — third-party content, framed as such by the tool. */
  snippet: string;
  /** How old the page is, in the provider's words ("2 days ago", "March 4, 2025"), when known. */
  age?: string;
}

export interface SearchBackend {
  /** The provider's name, for the boot log and nothing else. Never the key, never an account. */
  readonly provider: string;
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]>;
}

/**
 * A refusal the AGENT may read: the provider said no (rate limit, a query it would not take), in
 * words that name no credential and quote no response header. Anything else thrown out of a
 * backend is a bug and becomes the tool's generic failure, which says nothing at all.
 */
export class SearchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchRefusedError";
  }
}
