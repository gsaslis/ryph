// Asking again a service that could not be connected to at all: the one failure that provably
// sent nothing, so a retry repeats nothing. Every client of the docker launcher waits it out this
// way (a compose recreate takes the launcher away for up to a minute), so they share one loop.

/**
 * The fetch failures that happen before a byte of the request leaves: Bun's and Node's codes for a
 * refused connection, a name that did not resolve, and no route to the host. Deliberately not a
 * timeout or a reset: either can come after the request was sent, when the service may well have
 * acted on it.
 */
const UNREACHED_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** Whether a fetch rejection is one that sent nothing (see `UNREACHED_CODES`). */
export function neverReached(err: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e ? String(e.code) : undefined;
  const cause = typeof err === "object" && err !== null && "cause" in err ? err.cause : undefined;
  return [code(err), code(cause)].some((c) => c !== undefined && UNREACHED_CODES.has(c));
}

/** How long `untilReached` asks again by default: past a compose recreate of the launcher. */
export const REACH_MS = 90_000;
const REACH_FIRST_WAIT_MS = 250;
const REACH_MAX_WAIT_MS = 5_000;

export interface ReachOptions {
  /** Whether a failure of `attempt` provably sent nothing (built on `neverReached`). */
  unreached: (err: unknown) => boolean;
  /** How long to keep asking; default `REACH_MS`. */
  budgetMs?: number;
  /** The error thrown for the last unreached failure past the budget; default that failure. */
  exhausted?: (err: unknown, budgetMs: number) => unknown;
  signal?: AbortSignal;
}

/**
 * `attempt`, asked again with a growing pause while it fails `unreached`, for at most the budget.
 * Every other failure is thrown at once, as is the last unreached one past the budget
 * (`exhausted`), and `signal` aborting stops the waiting with its reason.
 */
export async function untilReached<T>(attempt: () => Promise<T>, opts: ReachOptions): Promise<T> {
  const budget = opts.budgetMs ?? REACH_MS;
  const deadline = Date.now() + budget;
  const signal = opts.signal;
  let wait = REACH_FIRST_WAIT_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (!opts.unreached(err) || signal?.aborted) throw err;
      const left = deadline - Date.now();
      if (left <= 0) throw opts.exhausted ? opts.exhausted(err, budget) : err;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, Math.min(wait, left));
        function done() {
          signal?.removeEventListener("abort", aborted);
          resolve();
        }
        function aborted() {
          clearTimeout(timer);
          reject(signal?.reason ?? err);
        }
        signal?.addEventListener("abort", aborted, { once: true });
      });
      wait = Math.min(wait * 2, REACH_MAX_WAIT_MS);
    }
  }
}
