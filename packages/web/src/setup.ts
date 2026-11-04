// The package's startup contract for the mounted deployment: one call builds the MCP data
// handler the gateway forwards to, over the search backend, the outbound fetch and the converter
// the root provides. No env reads and no sockets — the root owns those — and the only state it
// keeps is a short-lived cache of pages it just converted.
//
// Three knobs decide what a run can do, and all three are the DEPLOYMENT's:
// - `search`: null leaves `web__search` off the tool list entirely (mcp/tools.ts says why).
// - `allowInsecure`: plain http, off by default.
// - `converter`: the budget and the ceiling one page may cost (ports/converter.ts).

import { makeServiceGate } from "@ryph/sealed";
import { json } from "@ryph/shared/http";
import type { AddressPolicy } from "./core/addresses.ts";
import { makePageCache } from "./core/cache.ts";
import { fetchPage, type PageOutcome } from "./core/page.ts";
import { makeWebDataHandler } from "./http/data.ts";
import type { ToolDefinition } from "./mcp/tools.ts";
import { toolsFor } from "./mcp/tools.ts";
import type { Converter } from "./ports/converter.ts";
import { workerConverter } from "./adapters/convert/worker_converter.ts";
import type { SearchBackend } from "./ports/search.ts";

export interface WebDiag {
  debug(event: string, fields?: Record<string, unknown>): void;
  /**
   * The level the two tool calls are recorded at, and the reason this channel exists: the
   * gateway's usage trail counts and times a call but keeps no arguments, so THIS log is the only
   * place that names the URL a run fetched and the query it searched for (see http/data.ts).
   */
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface WebSetupDeps {
  /**
   * The credential the MCP gateway presents on the data route (RYPH_WEB_GATEWAY_TOKEN).
   * Null: the route refuses everything — no gateway can reach the tools.
   */
  gatewayToken: string | null;
  /** The deployment's search backend, or null: `web__search` is then not listed at all. */
  search: SearchBackend | null;
  /** Where a fetch may go. The root injects the platform's resolver and the insecure flag. */
  policy: AddressPolicy;
  /** The outbound fetch. Injected for tests; the process-wide one otherwise. */
  fetch?: typeof fetch;
  /** The whole of one fetch, redirects included (default 20s). */
  timeoutMs?: number;
  /**
   * HTML → markdown. Omitted, a worker-backed converter with its own budget and ceiling — which
   * is what the service wants; a test that cares about the markdown injects an in-process one.
   */
  converter?: Converter;
  /** How long a converted page stays cached for the next offset (default 120s, 4 pages). */
  cacheTtlMs?: number;
  diag: WebDiag;
}

export interface WebSetup {
  /**
   * The MCP data handler: answers the web MCP path, null for any other. The gateway's platform
   * entry dials this — in-process under the single binary, over HTTP standalone.
   */
  dataHandler: (req: Request) => Promise<Response | null>;
  /** What `tools/list` will answer, for the root's boot log. */
  tools: ToolDefinition[];
  /**
   * Readiness: converts a tiny page, so what is checked is the thing this service exists to do —
   * the worker spawns, the libraries load, markdown comes back. Memoised for 30s, and on a
   * converter of its own, so a probe every 5s costs one conversion a half-minute and a saturated
   * service still reads ready (with one replica, routing traffic away from a busy pod only moves
   * the queue somewhere there is nobody to serve it).
   */
  ready(): Promise<void>;
  /** At shutdown: frees the converter. In-flight conversions are terminated with their workers. */
  close(): void;
}

/** The probe page, and how long its verdict stands. */
const READY_HTML = "<html><head><title>ready</title></head><body><p>ready</p></body></html>";
const READY_TTL_MS = 30_000;

export function setup(deps: WebSetupDeps): WebSetup {
  const dial = deps.fetch ?? globalThis.fetch;
  const converter = deps.converter ?? workerConverter();
  // Readiness gets a converter of its OWN (one slot), so the probe never competes with tool
  // calls for the slots the service has: a saturated service is a working service, and answering
  // "unready" because every slot is busy would take a replica out of rotation for working. A
  // converter the caller INJECTED is used for both — a test counts conversions — and `close()`
  // then closes it once, not twice.
  const probeConverter = deps.converter ?? workerConverter({ maxInFlight: 1 });
  const ownsProbeConverter = deps.converter === undefined;
  // Keyed on the url the agent asked for, which is what its next offset call will carry again.
  const cache = makePageCache<PageOutcome>(
    deps.cacheTtlMs === undefined ? {} : { ttlMs: deps.cacheTtlMs },
  );
  const page = async (url: string): Promise<PageOutcome> => {
    const cached = cache.get(url);
    if (cached !== null) {
      deps.diag.debug("web.page_cached", { url });
      return cached;
    }
    const outcome = await fetchPage(url, {
      fetch: dial,
      policy: deps.policy,
      convert: (html, pageUrl) => converter.convert(html, pageUrl),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    // Refusals are not cached: they are about this moment (a timeout, a busy converter, a 503),
    // and an agent that tries again deserves a fresh answer.
    if (outcome.ok) cache.set(url, outcome, outcome.page.text.length);
    return outcome;
  };
  const gate = deps.gatewayToken === null
    ? () => Promise.resolve(json(503, { error: "the web data route has no gateway token" }))
    : makeServiceGate(deps.gatewayToken);

  let readyAt = 0;
  let readyCheck: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (Date.now() - readyAt < READY_TTL_MS) return Promise.resolve();
    readyCheck ??= probeConverter.convert(READY_HTML, "https://readiness.invalid/")
      .then(() => {
        readyAt = Date.now();
      })
      .finally(() => {
        readyCheck = null;
      });
    return readyCheck;
  };

  return {
    dataHandler: makeWebDataHandler({
      context: { search: deps.search, fetchPage: page, diag: deps.diag },
      authenticate: gate,
      diag: deps.diag,
    }),
    tools: toolsFor(deps.search),
    ready,
    close: () => {
      converter.close();
      if (ownsProbeConverter) probeConverter.close();
    },
  };
}
