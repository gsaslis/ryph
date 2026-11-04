// The images a run's tools returned, as the control plane holds them: what a ref in the run's
// text names, and the bytes behind it. Over HTTP standalone (adapters/run_images/http.ts), the
// orchestrator in-process under the single binary — the service cannot tell which.
//
// Invariants:
// - a ref is resolved against ONE run, the one whose words carry it: the run id the gateway
//   named for `post`, the binding's run for the closing line. A ref from another run is unknown
// - only images a tool returned in the run resolve (`source: "agent"` at the control plane); a
//   person's upload to the run does not
// - both calls throw when the control plane could not answer: the caller decides whether that
//   fails a post (before anything was sent) or costs only the images (after)

/** One ref the control plane knows, for this run. */
export interface ResolvedImage {
  ref: string;
  attachmentId: string;
  /** What the control plane stored it as; it sniffed the bytes when the runner uploaded them. */
  mime: string;
  /** The image behind a ryph login — `${appUrl}/images/<runId>/<attachmentId>` — or null when
   * the deployment has no app URL. What a platform that cannot take the file links to. */
  url: string | null;
}

export interface ImageResolution {
  images: ResolvedImage[];
  /** The refs asked for that this run has no image under. */
  unknown: string[];
}

export interface RunImages {
  /** What each ref names in this run. A ref still uploading is waited on there, briefly. */
  resolve(runId: string, refs: string[]): Promise<ImageResolution>;
  /** One image's bytes. */
  fetch(runId: string, attachmentId: string): Promise<Uint8Array<ArrayBuffer>>;
}
