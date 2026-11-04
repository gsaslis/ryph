// The platform's own model, as the core sees it: one short completion, for the small jobs the
// control plane does off any run — today, naming a task (core/titles.ts). A port because the core
// must not know that a proxy sits in between or how the credential was minted.
//
// Invariants:
// - the control plane holds no provider key: the adapter behind this mints a PLATFORM credential
//   from the model proxy (the background model an admin set under Instance → Platform) and spends
//   it on the proxy's data plane, metered under its own consumer name — memory's pattern
// - a model that cannot be reached, is not configured, or answers nothing usable is a THROW the
//   caller degrades from; nothing that depends on it ever fails for it
// - absent (null in the deps), every model-backed step is skipped

export interface PlatformCompletion {
  system: string;
  prompt: string;
  /** A ceiling on the answer, in the provider's tokens. */
  maxTokens: number;
  /** Ends the call early; the caller bounds how long it waits. */
  signal?: AbortSignal;
}

export interface PlatformModel {
  /** The answer's text, whole. Throws on anything but a clean completion. */
  complete(req: PlatformCompletion): Promise<string>;
}
