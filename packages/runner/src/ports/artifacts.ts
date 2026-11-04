// Where the agent's artifacts are published — the channel behind `publish_artifact` and
// `fetch_artifact`. An artifact is an HTML page the platform keeps and shows to every member of
// the instance; the run hands it the document the agent wrote in its workspace, and the platform
// answers the page's link. A fetch hands back the current version as published, for the agent to
// edit in a later run.
//
// The platform decides everything that matters — whether this agent may publish at all (read
// live), whether the artifact named is one it may read or update, whether every image the
// document names is one of this run's or one the version it updates already shows — and words
// each refusal for the agent. The runner only reads and writes the file and passes the words on.

export interface ArtifactPublishRequest {
  title: string;
  html: string;
  /** The artifact this is a new version of; absent for a new one. */
  artifactId?: string;
}

export type ArtifactPublishAnswer =
  | {
    kind: "published";
    id: string;
    version: number;
    /** The page every member can open; null when the platform knows no address for its app. */
    url: string | null;
    created: boolean;
    /** The title and document were the current version's: nothing new was made. */
    unchanged: boolean;
  }
  /** The platform said no, in words for the agent. */
  | { kind: "refused"; reason: string };

export type ArtifactFetchAnswer =
  | { kind: "fetched"; id: string; title: string; version: number; html: string }
  /** The platform said no, in words for the agent. */
  | { kind: "refused"; reason: string };

export interface ArtifactPublisher {
  /** Throws when the platform could not be asked; a refusal is an answer, not a throw. */
  publish(request: ArtifactPublishRequest): Promise<ArtifactPublishAnswer>;
  /** The current version of `artifactId`, as published. Throws as `publish` does. */
  fetch(artifactId: string): Promise<ArtifactFetchAnswer>;
}
