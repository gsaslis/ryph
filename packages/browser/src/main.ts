// The browser sidecar's composition root: reads the environment, owns the listening socket and
// the process' signals, and nothing else (sidecar.ts composes the rest).
//
// It starts knowing nothing — no token, no proxy, no Chromium. The runner configures it once
// (POST /configure), and Chromium launches on the first tool call. SIGTERM closes Chromium
// before the process goes, so the pod's grace period is spent on a clean shutdown rather than
// on a SIGKILL of a browser mid-write.

import { Logger, LogLevel, setupLoggerFromEnv } from "@ryph/logger";
import { refuseHostileEnvironment, serve } from "@ryph/service";
import { parseSandboxMode } from "./core/config.ts";
import { createSidecar } from "./sidecar.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

/** For local development only: the orchestrator always runs the sidecar on 7490 and dials that. */
function port(): number {
  const raw = env("RYPH_BROWSER_PORT");
  if (raw === undefined) return 7490;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    console.error(`error: RYPH_BROWSER_PORT must be a port number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
}

export async function main(): Promise<void> {
  refuseHostileEnvironment("browser");
  // stderr: the sidecar's stdout carries nothing, but its logs are what an operator reads
  // beside the run's other containers, and the sandbox fallback is promised as a stderr line.
  setupLoggerFromEnv({ level: LogLevel.INFO, stderr: true });
  const log = new Logger("browser");
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: String(reason) });
  });
  const sandbox = parseSandboxMode(env("RYPH_BROWSER_SANDBOX"));
  if (!sandbox.ok) {
    console.error(`error: ${sandbox.error}`);
    process.exit(2);
  }
  const diag = {
    info: (event: string, fields?: Record<string, unknown>) => log.info(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };
  const sidecar = createSidecar({
    diag,
    ...(env("RYPH_BROWSER_EXECUTABLE") ? { executablePath: env("RYPH_BROWSER_EXECUTABLE") } : {}),
    sandbox: sandbox.mode,
  });
  const listenPort = port();
  // Loopback only. Its one client, the runner, shares this network namespace on both platforms
  // (a native sidecar in the run's pod; `--network container:` beside the agent under docker),
  // so nothing outside the namespace has any business reaching it — and on docker's shared
  // network, 0.0.0.0 would let every other container on it knock.
  const server = await serve(
    { hostname: "127.0.0.1", port: listenPort, onListen: () => {} },
    sidecar.handler,
  );
  log.info(`listening on 127.0.0.1:${listenPort}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down");
    await sidecar.close().catch(() => {});
    await server.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) {
  await main();
}
