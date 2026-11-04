// Where a document comes from, as the core sees it: a locator in, a title and text out. The
// registry keyed by source kind is the connector seam — a URL fetcher and a repo-file fetcher
// ship; Notion, Confluence, Google Docs and Slack are different fetchers in front of the same
// pipeline, added here when someone has the credentials to wire one.
//
// Invariants:
// - a fetcher REFUSES with a reason a person can act on (private address, unsupported host,
//   too large) rather than answering something else; the service turns it into a 400
// - text only: whatever the document's format, what lands in a source is text the extractor
//   and `doc` can serve

export interface FetchedDocument {
  title: string;
  text: string;
}

export interface Fetcher {
  fetch(locator: string): Promise<FetchedDocument>;
}

/** A refusal the caller should show as the reason it is: a bad locator, never a fault of ours. */
export class FetchRefusedError extends Error {
  override readonly name = "FetchRefusedError";
}

/** Fetchers by source kind; a kind with no fetcher takes text in the request and nothing else. */
export type Fetchers = Partial<Record<"url" | "repo-file", Fetcher>>;
