// Waiting for a PLATFORM MCP SERVER ROW to exist, with a deadline.
//
// The control plane is told which platform tool surfaces this deployment serves (RYPH_WEB_TOOLS,
// RYPH_FORGE_TOOLS) and checks the claim against the gateway rather than believing it — a row
// scoped into every run when the gateway holds no such row fails those runs at their boot credential
// mint, which is far worse than no tools.
//
// But at BOOT that check races the gateway's seed. On a fresh cluster, after a `compose:reset`,
// or on any rollout where both come up together, the gateway may be answering requests seconds
// before it has written its platform rows — and a single shot at t=0 then reads "no such server"
// and turns the tools off for the whole life of the process, silently. So it is a poll with a
// bounded wait: doubling backoff, one log line at the end, and a verdict.
//
// An ARCHIVED row is an answer, not a race: somebody archived it, and waiting for it to come back
// would be waiting for a person. It returns at once.

/**
 * WHICH PLATFORM TOOL SERVERS THIS DEPLOYMENT SERVES, as a holder every task start reads rather
 * than a pair of values frozen at boot. Two reasons it is mutable:
 *
 * - The answer is not known at boot. It comes from the gateway, over the network, and asking for
 *   it before the listener is up cost this process its liveness probe: two 60s waits in front of
 *   `serve` is a container that answers nothing for two minutes and is killed at one, which
 *   turned "the gateway has a slug conflict" into a CrashLoopBackOff — the exact outcome the
 *   "off rather than fatal" rule exists to avoid. So the listener comes up first and this is
 *   filled in behind it.
 * - `webServerId` is known ALWAYS, served or not, because an agent's tool policy may name the web
 *   row even where the tools are off — and a platform row cannot be archived, so nothing else
 *   would stop that entry reaching a run's frozen scope. Knowing the id is what lets
 *   composeToolScope drop it.
 */
export interface PlatformToolServers {
  /** The web platform row's fixed id. Not a statement that it is served — `web` is. */
  readonly webServerId: string;
  /** Whether web tools are served: false while the lookup is pending, and false when off. */
  web: boolean;
  /** The forge platform row's id when served; null while pending, and null when off. */
  forge: string | null;
  /**
   * True while a background lookup is still running. A run started in that window gets no web or
   * forge tools — the alternative is holding every task start behind a network call — and
   * start_task says so in one line rather than leaving it to be noticed.
   */
  pending: boolean;
}

/** The holder as it stands before anything is resolved: nothing served, nothing pending. */
export function platformToolServers(webServerId: string): PlatformToolServers {
  return { webServerId, web: false, forge: null, pending: false };
}

export interface PlatformServerLookup {
  /** The gateway's metadata read: the row, or null when it has none. May throw (it is a call). */
  getServer(id: string): Promise<{ archivedAt: string | null } | null>;
}

export interface AwaitPlatformServerOptions {
  lookup: PlatformServerLookup;
  id: string;
  /** How long to keep asking (default 60s). Zero: exactly one attempt. */
  timeoutMs?: number;
  /** The first gap between attempts; it doubles up to `maxDelayMs`. */
  delayMs?: number;
  maxDelayMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export type PlatformServerVerdict =
  | { served: true; attempts: number; waitedMs: number }
  | {
    served: false;
    attempts: number;
    waitedMs: number;
    /** `archived`, `absent` (never appeared), or the last error the lookup threw. */
    reason: "archived" | "absent" | string;
  };

export async function awaitPlatformServer(
  options: AwaitPlatformServerOptions,
): Promise<PlatformServerVerdict> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let delay = options.delayMs ?? 250;
  let attempts = 0;
  let reason: string = "absent";
  for (;;) {
    attempts++;
    try {
      const server = await options.lookup.getServer(options.id);
      if (server !== null) {
        return server.archivedAt === null
          ? { served: true, attempts, waitedMs: now() - started }
          : { served: false, attempts, waitedMs: now() - started, reason: "archived" };
      }
      reason = "absent";
    } catch (err) {
      // A gateway that is not listening yet throws here, and that is the commonest shape of this
      // race: keep the reason for the one line at the end, and try again.
      reason = err instanceof Error ? err.message : String(err);
    }
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) return { served: false, attempts, waitedMs: elapsed, reason };
    await sleep(Math.min(delay, Math.max(0, timeoutMs - elapsed)));
    delay = Math.min(delay * 2, maxDelayMs);
  }
}
