// Which search backend a deployment got, from its two variables — shared by the standalone
// service and the single binary so both read the configuration the same way and log the same
// line. Returns the backend, or the REASON there is none: "no search" is a state this service
// serves happily (fetch still works, `search` is simply not listed), so it is reported rather
// than thrown.
//
// The key is read here and handed to one adapter. It is never returned, never logged, and never
// put in a message a tool call can read.

import { braveSearch } from "./brave.ts";
import type { SearchBackend } from "../../ports/search.ts";

export interface SearchConfig {
  /** RYPH_WEB_SEARCH_PROVIDER. Only "brave" today; unset means "brave if there is a key". */
  provider?: string | undefined;
  /** RYPH_WEB_SEARCH_KEY. */
  key?: string | undefined;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export type SearchChoice =
  | { backend: SearchBackend }
  | { backend: null; reason: string };

export function searchBackendFromEnv(config: SearchConfig): SearchChoice {
  const provider = (config.provider ?? "brave").trim().toLowerCase();
  const key = config.key?.trim() ?? "";
  if (provider !== "brave") {
    return {
      backend: null,
      reason: `RYPH_WEB_SEARCH_PROVIDER=${JSON.stringify(provider)} is not a provider this ` +
        'service knows (only "brave" today) — web__search is not offered',
    };
  }
  if (key === "") {
    return {
      backend: null,
      reason: "RYPH_WEB_SEARCH_KEY is unset — web__search is not offered to runs; web__fetch is",
    };
  }
  return { backend: braveSearch({ key, ...(config.fetch ? { fetch: config.fetch } : {}) }) };
}
