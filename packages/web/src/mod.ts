// @ryph/web — the one way a run reads the public web: `web__search` and `web__fetch`, behind the
// MCP gateway like every other tool. A page an agent asks for is fetched HERE, by a service that
// holds no credential of the run's and reaches no address inside the cluster, converted to
// markdown, framed as untrusted third-party text, and handed back one bounded slice at a time.
//
// One half only, unlike memory and chat: there is no management surface and no store, because
// nothing here belongs to anyone. What the deployment configures is a search key (optional — no
// key, no `search` tool) and whether plain http is allowed (it is not, by default).
//
// Where it runs depends on the deployment:
// - MOUNTED (the single binary, @ryph/host): setup() is called in-process and the gateway's
//   platform entry dials the handler through a `fetch` that never opens a socket, with a token
//   minted at boot.
// - STANDALONE (the networked deployment): src/main.ts serves the same handler on its own
//   listener, and the gateway dials RYPH_WEB_URL with RYPH_WEB_GATEWAY_TOKEN.
//
// The threat model is in packages/forge/docs/threat-model.md: these tools reopen a narrow,
// metered, logged exfiltration channel, which is a per-deployment and per-agent decision.

export { setup, type WebDiag, type WebSetup, type WebSetupDeps } from "./setup.ts";
export { makeWebDataHandler, MCP_PATH, RUN_ID_HEADER } from "./http/data.ts";
export {
  callTool,
  renderPage,
  renderResults,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
  toolsFor,
} from "./mcp/tools.ts";
export {
  type AddressPolicy,
  checkFetchUrl,
  type UrlRefusal,
  type UrlVerdict,
} from "./core/addresses.ts";
export {
  DEFAULT_TIMEOUT_MS,
  type FetchedPage,
  fetchPage,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  type PageFetchDeps,
  type PageKind,
  type PageOutcome,
} from "./core/page.ts";
export { type ConvertedPage, htmlToMarkdown } from "./core/markdown.ts";
export { htmlToText, type PageText } from "./core/text.ts";
export { oneLine, PAGE_NOTICE, RESULTS_NOTICE, SLICE_CHARS, sliceOf } from "./core/framing.ts";
export { makePageCache, type PageCache, type PageCacheOptions } from "./core/cache.ts";
export { ConversionRefusedError, type Converter } from "./ports/converter.ts";
export {
  type ConvertFormat,
  DEFAULT_CONVERT_BUDGET_MS,
  DEFAULT_MAX_IN_FLIGHT,
  workerConverter,
  type WorkerConverterOptions,
} from "./adapters/convert/worker_converter.ts";
export {
  type Freshness,
  type SearchBackend,
  type SearchQuery,
  SearchRefusedError,
  type SearchResult,
} from "./ports/search.ts";
export { braveSearch, type BraveSearchOptions } from "./adapters/search/brave.ts";
export { systemResolve } from "./adapters/dns.ts";
export {
  searchBackendFromEnv,
  type SearchChoice,
  type SearchConfig,
} from "./adapters/search/config.ts";
