// The images a run's tools returned, as the control plane holds them: every one is a run
// attachment the runner uploaded, named by a ref (`img-` + 12 hex of the bytes' SHA-256) that the
// model saw beside the image. An agent shows one in what it writes as `![alt](img-…)`, and this
// port is how the forge learns what that ref is before it writes anything — and, for a forge
// that keeps the image itself (a Radicle embed), its bytes.
//
// The orchestrator decides: which refs belong to the run, and which bytes a run's ref names. This
// port only asks. Its HTTP adapter is the tool grants' sibling, service-authed the same way.

/** One ref the control plane knows for the run. */
export interface ResolvedImage {
  ref: string;
  attachmentId: string;
  mime: string;
  /** Where a logged-in human sees it (`<app>/images/<runId>/<attachmentId>`); null when the
   * deployment has no app URL to point at. */
  url: string | null;
}

export interface ImageResolution {
  images: ResolvedImage[];
  /** Refs the run does not hold — never a tool image of this run. */
  unknown: string[];
}

export interface RunImages {
  /**
   * What each ref names on this run. A ref the control plane does not know is in `unknown`,
   * never dropped. Throws when the control plane could not be asked: nothing that carries an
   * image may be written on a guess about it.
   */
  resolve(runId: string, refs: string[]): Promise<ImageResolution>;
  /** One attachment's bytes, for a forge that stores the image itself. Throws when they could
   * not be had. */
  bytes(runId: string, attachmentId: string): Promise<{ bytes: Uint8Array; mime: string }>;
}
