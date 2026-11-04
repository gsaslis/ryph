// Where artifacts are kept (core/artifacts.ts): one row per artifact, one per version with its
// document, and per version the images its document names — in the control plane's database
// beside the runs that published them.
//
// Invariants:
// - `publish` and `recordAttempt` take the publishing run's row lock first and write nothing once
//   the run is terminal ("concluded"), the background store's rule: a conclusion and a late
//   publish serialize on that row
// - every document a run hands the sanitizer is an attempt, recorded BEFORE it is sanitized,
//   whatever comes of it. A run with MAX_ARTIFACT_ATTEMPTS_PER_HOUR attempts in the hour before
//   `at` records no more until the oldest of them is an hour old ("rate_limited", with when).
//   Attempts are the run's own rows, not its versions': a delete does not purge them, so taking
//   a page down does not give its run its hour back
// - a new version is written under the artifact's own row lock, numbered one past the current,
//   only when `mayVersion` allows it ("not_found" otherwise, the same answer as an id that never
//   existed), and only below MAX_ARTIFACT_VERSIONS. A title and document equal to the current
//   version's write nothing ("unchanged")
// - a NEW artifact whose title and document equal the current version of one this same run
//   created writes nothing either: that artifact is the answer ("unchanged"), so an agent that
//   publishes twice after a lost answer does not make two pages
// - versions are never changed. A delete marks the artifact and purges every version's document
//   and image mapping: the row stays as a tombstone, so its id is never handed out again, and
//   every read treats it as absent

import type {
  Artifact,
  ArtifactAttemptResult,
  ArtifactPublish,
  ArtifactPublishResult,
  ArtifactVersionContent,
  ArtifactVersionInfo,
} from "../core/artifacts.ts";

/** Where a page of the list starts: just past this row, newest first. */
export interface ArtifactCursor {
  updatedAt: string;
  id: string;
}

export interface ArtifactStore {
  publish(input: ArtifactPublish): Promise<ArtifactPublishResult>;
  /** Counts one sanitizer attempt of `runId` at `at`, or says why it may not make one. */
  recordAttempt(runId: string, at: string): Promise<ArtifactAttemptResult>;
  /** The live artifact `runId` created whose current version has this title and document, or
   * null: what a new publish of the same page again answers, before anything is sanitized. */
  createdByRunWith(
    runId: string,
    title: string,
    html: string,
  ): Promise<{ id: string; version: number } | null>;
  /** The artifact, or null when there is none or it is deleted. */
  get(id: string): Promise<Artifact | null>;
  /** Every version of a live artifact, oldest first; empty for a deleted or unknown one. */
  versions(id: string): Promise<ArtifactVersionInfo[]>;
  /** One version's document (as published and as served) and images; null when the artifact is
   * deleted or unknown, or the version is not one of its. */
  versionContent(id: string, version: number): Promise<ArtifactVersionContent | null>;
  /** Live artifacts, most recently updated first (ties by id, descending), after `before`. */
  list(opts: { limit: number; before: ArtifactCursor | null }): Promise<Artifact[]>;
  /** Marks the artifact deleted and purges its versions and their images; false when there is
   * no live one by that id. */
  delete(id: string, at: string): Promise<boolean>;
  /** The live artifacts any of `runIds` created or versioned, each with the versions those runs
   * published, oldest first. */
  forRuns(
    runIds: readonly string[],
  ): Promise<
    Array<{
      artifact: Artifact;
      versions: Array<{ version: number; runId: string; createdAt: string }>;
    }>
  >;
}
