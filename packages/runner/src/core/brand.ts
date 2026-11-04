// The single source of truth for the project name.
//
// "ryph" is a codename — a stand-in until the production name exists.
// To rebrand: change `CODENAME` here, update `name` in package.json, and grep the docs
// for the old name. Nothing else in the code spells the name out.
//
// Invariants:
// - No brand-derived identifier is written out anywhere else under src/ or tests/;
//   everything derives from `CODENAME`.

/** The project codename, lowercase. */
export const CODENAME = "ryph";

/** The commit trailer key that stamps every commit made during a run with the run id. */
export const RUN_TRAILER = `${CODENAME[0].toUpperCase()}${CODENAME.slice(1)}-Run`;

/** Uppercase prefix for the runner's brand-scoped env vars, e.g. `RYPH` in `RYPH_PORT`. */
export const ENV_PREFIX = CODENAME.toUpperCase();

/** The config dir a repo may carry to describe its run environment — dotted, beside `.github`. */
export const REPO_CONFIG_DIR = `.${CODENAME}`;

/**
 * The three brand-scoped variables the CREDENTIALS channel provisions a custom model endpoint
 * with: the run's virtual key, the proxy address its OpenAI-compatible client dials, and the
 * endpoint's own description (id, dialect, declared models) as one JSON blob.
 *
 * Declared here, in the one file that owns brand-derived names, because two places must agree
 * on them and neither may derive its own: `src/schema.ts` allows exactly these three past the
 * refusal that keeps the credentials channel from reconfiguring the runner, and
 * `src/adapters/harness/pi.ts` reads them to build pi's provider entry. A name spelled twice is
 * a name that can drift once, and the drift would be a boot failure on every custom-endpoint run.
 *
 * Brand-scoped on purpose rather than under a neutral name: `runChildEnv`'s scrub removes every
 * `${ENV_PREFIX}_*` key from a setup step's environment, so the virtual key for a custom
 * endpoint is hidden from a repo's own code the way a built-in's ANTHROPIC_API_KEY is not.
 */
export const MODEL_ENDPOINT_ENV = {
  /** The virtual key; `models.json` names this variable and pi resolves it from the spawn env. */
  key: `${ENV_PREFIX}_MODEL_API_KEY`,
  /** The proxy's `/v1` — never the upstream's own base URL, which only the proxy ever sees. */
  baseUrl: `${ENV_PREFIX}_MODEL_BASE_URL`,
  /** The endpoint's id, dialect and declared models, serialized by the credential issuer. */
  config: `${ENV_PREFIX}_MODEL_PROVIDER_CONFIG`,
} as const;
