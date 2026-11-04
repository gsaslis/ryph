// Embeddings, as the core sees them: texts in, unit vectors out, and the name of the model that
// made them — because vectors from different models are incompatible, and a memory's stored
// vector is only comparable to a query embedded by the same model.
//
// Absent (null in the service deps), or present but given up (`available()` false: its runtime
// could not load), search and the brief rank by full-text alone. Present, the store
// ranks hybrid: full-text and cosine similarity, each normalised, the better of the two. The
// canon is small by construction, so the vectors are compared in-process over the candidate
// rows rather than through a vector index the database would have to provide.

export interface Embedder {
  /** The model's name, as stored beside every vector it makes ("bge-small-en-v1.5"). */
  readonly model: string;
  /** One unit vector per text, in order. Throws on a runtime failure. `urgent` marks a search
   * someone is waiting on, which an embedder with a queue may serve ahead of background work;
   * `signal` says the caller stopped waiting, so work not yet started may be dropped (and the
   * call rejects). */
  embed(texts: string[], opts?: { urgent?: boolean; signal?: AbortSignal }): Promise<number[][]>;
  /** False once the embedder has given up for good (its runtime or weights could not load):
   * the service then works as if it had none, rather than failing every write and search on it.
   * Absent: always available. */
  available?(): boolean;
}
