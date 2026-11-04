// The run's half of service containers: wait for them, then say they are there.
//
// The runner starts nothing. The platform launched these before this process existed — it had
// to, because on Kubernetes a Pod's containers are fixed at creation — so everything here is
// about the gap between "the container was created" and "the port answers", and about making
// sure the agent knows what it has.
//
// Invariants:
// - a service that never answers FAILS the run, naming itself. The measured failure this whole
//   feature exists to remove is a suite that hangs rather than fails; a health gate that gave
//   up quietly would put it straight back
// - the wait is bounded well under the orchestrator's startup grace, so the run reports an
//   error the user can read instead of being marked `lost` with "no heartbeat for 600000ms"
// - the generated description is UNSUPPRESSABLE. `environment.md` is read from the checkout
//   while services are resolved through the forge, so the repo's prose can confidently
//   describe a database that is not there. The repo may describe its services; it may not
//   remove the true list

import { connect } from "node:net";
import { REPO_CONFIG_DIR } from "../core/brand.ts";
import type { RunService } from "../core/types.ts";

/**
 * How long EACH service gets to answer. Deliberately far below `RYPH_STARTUP_GRACE_MS`
 * (600 s by default), because whoever loses that race decides what the user reads: this
 * timeout produces `{status: "error", during: "setting-up"}` naming the service and its
 * address, and the reaper produces "no heartbeat for 600000ms", which names nothing.
 */
export const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;
const PROBE_INTERVAL_MS = 500;
/** One dial's own budget: a black-holed address must not eat the whole window silently.
 * Enforced by a timer that gives up on the dial — see `tcpProbe`. */
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * The slice of the `Diagnostics` port this helper needs, declared locally so helpers stay
 * inside the dependency fence (helpers never reach ports). Structural: any real `Diagnostics`
 * satisfies it.
 */
export interface ServiceTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
}

export interface WaitForServicesOpts {
  /** Aborting stops the wait and returns normally — cancellation is the caller's outcome. */
  signal: AbortSignal;
  diag: ServiceTracer;
  timeoutMs?: number;
  /** Called about once a second per service still being waited on; drives narration. */
  onWait?: (service: RunService, waitedMs: number) => void;
  /** Injected by the test. Resolves when the address accepts a connection. */
  probe?: (service: RunService, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Waits for every service to accept a TCP connection, in declaration order.
 *
 * TCP-open is the v1 check and it is honest about being one. It is exactly right for the
 * motivating case — the Postgres entrypoint bootstraps with `listen_addresses=''`, so an open
 * port genuinely means ready — and it is NOT right for MySQL, whose port opens well before the
 * server will answer a query. The catalogue says so per entry, and a `readyWhen` command is the
 * obvious next step.
 */
export async function waitForServices(
  services: readonly RunService[],
  opts: WaitForServicesOpts,
): Promise<void> {
  if (services.length === 0) return;
  const probe = opts.probe ?? tcpProbe;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;

  for (const service of services) {
    const started = now();
    // PER SERVICE, not shared across them. A single budget for the whole list made the error
    // message a lie — "redis never answered within 120s" when postgres had spent 110 of them
    // — and made a slow first service silently steal the second's chance to come up.
    const deadline = started + timeoutMs;
    let narrated = -1;
    while (!opts.signal.aborted) {
      if (await probe(service, opts.signal)) {
        opts.diag.debug("services.ready", {
          service: service.name,
          port: service.port,
          ms: Math.round(now() - started),
        });
        break;
      }
      if (opts.signal.aborted) return;
      if (now() >= deadline) {
        throw new Error(
          `service "${service.name}" never accepted a connection on ${service.name}:` +
            `${service.port} within ${Math.round(timeoutMs / 1000)}s (image ${service.image})`,
        );
      }
      // Once a second at most: this rides the heartbeat to the forge's progress comment.
      const waited = now() - started;
      if (Math.floor(waited / 1000) > narrated) {
        narrated = Math.floor(waited / 1000);
        opts.onWait?.(service, waited);
      }
      await sleep(PROBE_INTERVAL_MS, opts.signal);
    }
  }
}

/**
 * One dial, closed immediately. A refused connection is a normal answer, not an error.
 *
 * Bounded by its own timer and the caller's signal, either of which abandons the dial. That
 * matters more than it sounds. A refused connection comes back in microseconds, but a BLACK
 * HOLE — the name resolves, the SYNs are dropped, which is exactly a sidecar whose pod is up and
 * whose process is wedged — hangs for the OS connect timeout, 75 to 130 seconds on Linux.
 * Without the bound the caller's own deadline is not consulted until after that returns, and an
 * abort arriving mid-dial is ignored for just as long.
 *
 * An abandoned dial is destroyed at once, so it gives its file descriptor back rather than
 * holding it until the OS gives up; one that connects is closed immediately.
 *
 * Exported for the test: the bound is the behaviour, and it is not observable through
 * `waitForServices`, whose injected probe replaces this entirely.
 */
export function tcpProbe(
  service: Pick<RunService, "name" | "port">,
  signal: AbortSignal,
): Promise<boolean> {
  let settled = false;
  const socket = connect({ host: service.name, port: service.port });

  return new Promise<boolean>((resolve) => {
    const finish = (answer: boolean) => {
      // Connected or abandoned, the socket goes either way.
      socket.destroy();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish(true));
    // Refused, unresolvable — "not yet", and the caller's deadline is what ends the waiting.
    socket.once("error", () => finish(false));
  });
}

/**
 * Why this run must not start, when a service is named after the host of an address the run
 * reaches the platform at; null when none is.
 *
 * A service's name becomes a hostname by beating DNS — `hostAliases` onto the pod's loopback on
 * Kubernetes, a network alias under docker — so a service called `orchestrator`, in a deployment
 * whose runners dial `http://orchestrator:7411`, answers in the platform's place and receives
 * the run's credentials. The control plane refuses the hosts of the addresses it hands out
 * before launch. This is the other half: the addresses only the runner sees, the model proxy's
 * from the credentials fetch typically, checked before the harness is given a key to send.
 */
export function shadowedAddress(
  services: readonly RunService[],
  addresses: Record<string, string | undefined>,
): string | null {
  if (services.length === 0) return null;
  const names = new Set(services.map((s) => s.name));
  for (const [variable, address] of Object.entries(addresses)) {
    // Most credentials are keys, not addresses; only something that parses as a URL has a host.
    if (address === undefined || !URL.canParse(address)) continue;
    const host = new URL(address).hostname;
    if (!names.has(host)) continue;
    return `service "${host}" in ${REPO_CONFIG_DIR}/services.yml is named after the host this ` +
      `run reaches ${variable} at (${address}), so it would answer in the platform's place and ` +
      "receive the run's credentials. Rename the service.";
  }
  return null;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The machine-generated block that goes AHEAD of the repo's own `environment.md`, always.
 *
 * Two things it must get across, because both are things an agent will otherwise get wrong:
 * the addresses are names and not `localhost` (half the ecosystem's `.env.example` files say
 * localhost, and the agent has read plenty of them), and a stale declaration is a real
 * possibility worth mentioning rather than hiding.
 */
export function describeServices(services: readonly RunService[], stale: boolean): string {
  const rows = services
    .map((s) => `| \`${s.name}\` | \`${s.name}:${s.port}\` | \`${s.image}\` |`)
    .join("\n");
  const staleNote = stale
    ? `\n\n> This list was resolved from a cached copy of \`${REPO_CONFIG_DIR}/services.yml\` that could not ` +
      "be refreshed, so it may be older than the code in this checkout. If a service you " +
      "expected is missing, that is why."
    : "";
  return [
    "## Services running for this run",
    "",
    "The platform started these alongside the agent. They are reachable **by name** — not on " +
    "`localhost`, on any backend — and they live and die with this run.",
    "",
    "| Service | Address | Image |",
    "| ------- | ------- | ----- |",
    rows,
    "",
    "Point the test configuration at these addresses. Committed config that says `localhost` " +
    "will not reach them.",
  ].join("\n") + staleNote;
}

/**
 * The agent's environment description: the platform's true list of services first, the repos'
 * prose after. The machine itself is not in here — it is the appendix's own block, ahead of
 * this one (helpers/machine.ts), because it is true of every run and not only of a run whose
 * repos described something.
 *
 * The order is the point, and it is the report's provenance block one more time — composed by
 * a pure function, so no path can render without it.
 */
export function composeEnvironment(
  services: readonly RunService[],
  stale: boolean,
  repoProse: string | null,
): string | undefined {
  if (services.length === 0) return repoProse ?? undefined;
  const generated = describeServices(services, stale);
  return [generated, ...(repoProse === null ? [] : [repoProse])].join("\n\n---\n\n");
}
