// Making an artifact's served document (helpers/artifact_html.ts) off the event loop: a publish
// takes a slot, hands over the author's HTML and waits for the served form, its image refs, or
// the reason there is none. Behind a port because the work is a synchronous parse of up to 2 MiB
// of untrusted markup, and the only way to bound a synchronous call is to run it where its CPU
// and memory can be taken back: a child process, killed at its deadline
// (adapters/artifact_html/process_preparer.ts); tests run it in-process.
//
// Invariants:
// - a slot is held from `reserve` until its document's work has really ended (its process has
//   exited), never only until its caller stopped waiting: what a slot counts is work that is
//   running
// - one slot per owner (a run) at a time: one run's documents are made one after another

export type ArtifactHtmlOutcome =
  /** The served document, its refs as tokens, and every distinct ref in document order. */
  | { kind: "ok"; served: string; refs: string[] }
  /** It would not settle into a document that re-parses to itself. */
  | { kind: "unsettled" }
  /** Its tree nests deeper than the serializer can walk. */
  | { kind: "too_deep" }
  /** It took longer than the time budget, or more memory than the sanitizer is given. */
  | { kind: "too_complex"; budgetMs: number }
  /** An element carries more attributes than the sanitizer reads on one (`max`). */
  | { kind: "too_many_attributes"; max: number }
  /** A browser would build more than `max` nodes from it. */
  | { kind: "too_many_nodes"; max: number }
  /** Written back, it is longer than `max` characters, the served cap. */
  | { kind: "too_large"; max: number }
  /** The preparer closed before the document was made. */
  | { kind: "busy" }
  /** The deployment's sanitizer cannot be reached or started (a permission it lacks, a
   * supervisor that is down): the platform's fault, never the document's, and nothing stored. */
  | { kind: "unavailable" };

/** A reserved slot: prepare one document in it, or give it back unused. */
export interface ArtifactHtmlSlot {
  kind: "slot";
  /** Makes the document. Once called, the slot is given back when the work ends. */
  prepare(html: string): Promise<ArtifactHtmlOutcome>;
  /** Gives the slot back if `prepare` was never called; does nothing after. */
  release(): void;
}

export type ArtifactHtmlReservation =
  | ArtifactHtmlSlot
  /** As many documents as the deployment makes at once are being made already. */
  | { kind: "busy" }
  /** This owner's previous document is still being made. */
  | { kind: "owner_busy" };

export interface ArtifactHtmlPreparer {
  /** A slot for one document of `owner`'s (a run id), or why there is none. */
  reserve(owner: string): ArtifactHtmlReservation;
  /** Stops every document still being made; each answers `busy`, and every later reserve too. */
  close(): void;
}
