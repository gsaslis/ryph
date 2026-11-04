// The STANDALONE composition root — the web service as its own process, for the networked
// deployment where each service is its own socket. The default local deployment is @ryph/host,
// which instead calls setup() and holds the data handler in-process. This file reads the
// environment, decides which search backend (if any) this deployment has, owns the listening
// socket, and nothing else: there is no database to probe, no schema to apply and no background
// work to tick.
//
// ONE credential meets it: RYPH_WEB_GATEWAY_TOKEN, which only the MCP gateway holds, presented
// on the MCP data route beside a run id only the gateway can set. There is no user surface here
// at all — nothing in this service belongs to a person, so there is nothing for a person to
// manage.
//
// The search key (RYPH_WEB_SEARCH_KEY) is read once, handed to the adapter, and never logged.
// Without it the service starts anyway and says so in one line: `web__fetch` works, and
// `web__search` is not offered to runs at all.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { installDrain, makeHealth, refusePublicDevSecrets, serve } from "@ryph/service";
import { makeRouter } from "@ryph/shared/http";
import { systemResolve } from "./adapters/dns.ts";
import { searchBackendFromEnv } from "./adapters/search/config.ts";
import { setup } from "./setup.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export async function main(): Promise<void> {
  refusePublicDevSecrets("web");
  const port = intEnv("RYPH_WEB_PORT", 7480);
  setupLoggerFromEnv();
  const log = new Logger("web");
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: String(reason) });
  });
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    // Every tool call lands here, with its URL or its query: see setup.ts's WebDiag.
    info: (event: string, fields?: Record<string, unknown>) => log.info(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  const gatewayToken = env("RYPH_WEB_GATEWAY_TOKEN") ?? null;
  if (gatewayToken === null) {
    log.warn("RYPH_WEB_GATEWAY_TOKEN unset — the MCP data route refuses every call");
  }

  const choice = searchBackendFromEnv({
    provider: env("RYPH_WEB_SEARCH_PROVIDER"),
    key: env("RYPH_WEB_SEARCH_KEY"),
  });
  // One line, at boot, whichever way it went — an operator reading the logs of a run that has no
  // search tool should find the reason here rather than in a tool list they cannot see.
  if (choice.backend === null) log.warn(choice.reason);

  const allowInsecure = env("RYPH_WEB_ALLOW_INSECURE") === "1";
  if (allowInsecure) {
    log.warn("RYPH_WEB_ALLOW_INSECURE=1 — plain http pages may be fetched");
  }

  const web = setup({
    gatewayToken,
    search: choice.backend,
    policy: { allowInsecure, resolve: systemResolve },
    timeoutMs: intEnv("RYPH_WEB_FETCH_TIMEOUT_MS", 20_000),
    diag,
  });

  // Readiness converts a tiny page: the one thing this service does, end to end (setup.ts says
  // why that is both meaningful and cheap). A search provider that is down is a tool call that
  // says so, never a replica taken out of rotation.
  const health = makeHealth({ ready: () => web.ready(), log: diag });

  const router = makeRouter(health.routes);
  const server = await serve({ port }, async (req) => {
    const data = await web.dataHandler(req);
    return data ?? await router(req);
  });
  log.info(`listening on :${port}`, {
    data: gatewayToken === null ? "dark" : "on",
    search: choice.backend?.provider ?? "off",
    tools: web.tools.map((t) => t.name).join(","),
    http: allowInsecure ? "allowed" : "https-only",
  });

  installDrain({
    servers: [server],
    beginDrain: health.beginDrain,
    // Frees the converter; a conversion still running dies with its worker, which is the whole
    // point of running it in one.
    close: () => Promise.resolve(web.close()),
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
  });
}

if (import.meta.main) {
  await main();
}
