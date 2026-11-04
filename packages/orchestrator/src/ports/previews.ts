// The previews service, as the control plane touches it:
// register a port a run exposes, list a run's open previews, find a preview's run, mint a viewer's
// one-time entry, and close a run's previews when it ends. The previews service holds no database credentials, so
// every decision about runs and people is made here before one of these is called; the service
// only keeps tunnels and tickets.
//
// One adapter stands behind it: adapters/previews/http.ts over a standalone previews service's
// API listener (RYPH_PREVIEWS_URL, RYPH_PREVIEWS_TOKEN). The local binary does not use this
// port: it serves its own loopback previews (packages/host/src/previews.ts).
//
// Every method answers a VALUE and never throws: "the service said no" (a refusal to pass on)
// and "the service did not answer" (a 502) are different facts, and only the route knows what
// each means for the request in front of it.

/** A preview id exactly as the service mints one: 32 lowercase hex, what a preview's host starts
 * with. What an open by the preview alone takes. */
export const HOSTED_PREVIEW_ID = /^[a-f0-9]{32}$/;

/** A preview as people see it. */
export interface PreviewView {
  id: string;
  port: number;
  label: string;
  url: string;
}

export type PreviewRegistration =
  /** `tunnel` is the WebSocket URL the runner dials with its single-use ticket. */
  | { kind: "registered"; id: string; url: string; tunnel: string }
  /** The service's own 400 or 429, its body as it sent it, for the runner to read. */
  | { kind: "refused"; status: 400 | 429; body: unknown }
  | { kind: "failed"; error: string };

export type PreviewList =
  | { kind: "previews"; previews: PreviewView[] }
  | { kind: "failed"; error: string };

export type PreviewViewer =
  | { kind: "url"; url: string }
  /** No such preview for that run, or its tunnel is not open. */
  | { kind: "missing" }
  | { kind: "failed"; error: string };

export type PreviewOwner =
  /** The run the preview belongs to. Says nothing of who may see it: the route decides that. */
  | { kind: "run"; runId: string }
  /** No such preview: never registered, or its run is over, or its replica restarted and its
   * runner has not registered it again yet. */
  | { kind: "missing" }
  | { kind: "failed"; error: string };

export interface PreviewsService {
  register(input: {
    runId: string;
    port: number;
    label: string;
    /** The run's egress allowlist, for the preview's CSP; null when egress is open. */
    hosts: string[] | null;
  }): Promise<PreviewRegistration>;
  list(runId: string): Promise<PreviewList>;
  /** `path` is where the viewer lands once in; the service decides whether it may, else `/`. */
  openViewer(runId: string, previewId: string, path?: string): Promise<PreviewViewer>;
  /** Which run a preview belongs to: for opening it by its id alone, as a link to it does. */
  findRun(previewId: string): Promise<PreviewOwner>;
  /** Closes every preview of a run. Fire and forget: never throws, never delays the caller. */
  closeRun(runId: string): void;
}
