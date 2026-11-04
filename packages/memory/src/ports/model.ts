// The model, as the core sees it: one completion at a time, for the consolidator's judgement
// calls and the ingest extractor. A port rather than a client because the core must not know
// which provider answers, how the credential was minted, or that a proxy sits in between —
// every one of those is the composition root's business.
//
// Invariants:
// - the core holds no credential: the adapter behind this mints a PLATFORM credential from the
//   model proxy and re-mints when it lapses
// - a model that cannot be reached, or that answers nonsense, is a THROW the caller catches and
//   degrades from — the trivial consolidator path, an ingest that extracts nothing — never a
//   failed pass
// - absent (null in the service deps), every model-backed step is skipped and says so

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** A ceiling on the answer, in the provider's tokens. */
  maxTokens: number;
}

export interface ModelClient {
  /** The answer's text, whole. Throws on anything but a clean completion. */
  complete(req: CompletionRequest): Promise<string>;
}

/**
 * A platform credential as the model proxy issues it — the same shape @ryph/model-proxy's
 * `PlatformCredential` has, declared here so this package depends on the proxy's WIRE contract
 * and not on its package.
 */
export interface PlatformCredential {
  token: string;
  /** Which provider answers — a built-in's id, or an admin-registered endpoint's slug. Carried
   * for the metering trail and the logs; what this side has to SPEAK is the dialect below. */
  provider: string;
  /** The wire dialect that provider speaks. It travels with the credential precisely so a
   * provider nobody here has heard of — a custom OpenAI-compatible endpoint — needs no entry in
   * any table on this side. */
  dialect: "anthropic-messages" | "openai-responses" | "openai-completions";
  model: string;
  allowedModels: string[] | "*";
  expiresAt: string;
  /** The provider SDK's base path on the proxy: "/v1" for an OpenAI-compatible endpoint,
   * "" for Anthropic. */
  basePath: string;
}

/** Where a platform credential comes from: the proxy's issuer in-process, or its internal
 * route over HTTP. Called lazily and again whenever the credential it gave has lapsed. */
export type PlatformCredentialSource = () => Promise<PlatformCredential>;
