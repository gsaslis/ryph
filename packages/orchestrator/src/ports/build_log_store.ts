// Where a build's full log goes: the object store patches live in, under an `environments/`
// prefix. The row keeps a tail for the card and
// for a refused run; the whole log is fetched only when someone opens it.
//
// Invariants:
// - keys are composed by the core from ids it minted, never from anything a repo wrote
// - a log is text, written once, whole, after its build ended — no appends, no streaming

export interface BuildLogStore {
  put(key: string, text: string): Promise<void>;
  /** Null when the key is unknown. */
  get(key: string): Promise<string | null>;
}
