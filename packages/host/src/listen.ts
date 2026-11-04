// Listeners on a configured bind address, failing as a named configuration error rather than an
// unhandled exception when the address is not there to bind.

import {
  type HttpServer,
  serve as serveHttp,
  type ServeHandler,
  type ServeOptions,
} from "@ryph/service";
import { isLoopbackHost } from "@ryph/shared/net";
import { isIPv4 } from "./local_surface.ts";

/**
 * What a bind error says, the one reading of it every bind decision here makes. `missing`: no
 * interface has the address (yet); node reports that as EADDRNOTAVAIL, and some runtimes'
 * node:http as EINVAL ("invalid argument", Deno's on macOS). Bun's node:http says EADDRINUSE for
 * it, which @ryph/service's `serve` and `listenNode` correct before anything here reads it.
 * `in-use`: something holds the port.
 * `unsupported`: the address family is not there at all (::1 with no IPv6). Pure and exported
 * for the test.
 */
export function bindErrorKind(err: unknown): "missing" | "in-use" | "unsupported" | "other" {
  const detail = err instanceof Error ? err.message : String(err);
  // oxlint-disable-next-line no-explicit-any
  const code = String((err as any)?.code ?? (err as any)?.name ?? "");
  const said = `${code} ${detail}`;
  if (/EADDRNOTAVAIL|AddrNotAvailable|EINVAL|assign requested address/.test(said)) return "missing";
  if (/EADDRINUSE|AddrInUse/.test(said)) return "in-use";
  if (/EAFNOSUPPORT/.test(said)) return "unsupported";
  return "other";
}

/**
 * Why a listener could not start, naming the setting behind its address. Pure and exported for
 * the test. An address no interface has is the case worth a hint: on a native Linux engine the
 * host binds the docker bridge's address, and that address exists only while dockerd is up.
 */
export function bindFailure(
  what: string,
  variable: string,
  host: string,
  port: number,
  err: unknown,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  const kind = bindErrorKind(err);
  let hint = "";
  if (kind === "missing") {
    hint = ` — no interface on this machine has that address. If it is the docker bridge's ` +
      `(a native Linux engine's), it exists only while dockerd is up: ` +
      `start ryph after docker. Otherwise set ${variable} to an address this machine has.`;
  } else if (kind === "in-use") {
    hint = ` — something else is already listening there.`;
  }
  return `${what} cannot listen on ${host}:${port} (${variable}=${host}): ${detail}${hint}`;
}

/**
 * Whether a bind that failed is already answered by the `::` listener on the same port: an IPv4
 * address taken while `::` is bound there means a dual-stack socket holds it (`bindAddresses`).
 * Something else holding the IPv4 port on a v6-only machine reads the same and goes unreported;
 * on a dual-stack one it would have kept `::` from binding at all. Pure and exported for the test.
 */
export function coveredByWildcard(hostname: string, err: unknown, bound: string[]): boolean {
  return isIPv4(hostname) && bound.includes("::") && bindErrorKind(err) === "in-use";
}

/**
 * The order a listener set binds in: the required addresses as given, then the optional ones
 * not already among them. Shared by `serveOn` and the app's node:http `listenAll`, so the two
 * bind policies cannot drift. Pure and exported for the test.
 */
export function bindOrder(required: string[], optional: string[] = []): string[] {
  return [...required, ...optional.filter((a) => !required.includes(a))];
}

/**
 * What a failed bind means, given the addresses already bound. `covered`: an IPv4 address `::`
 * already answers (`coveredByWildcard`). `skip`: an optional address this machine does not have,
 * ::1 with no IPv6 above all. `wait`: a waitable address not there yet, where the caller retries
 * (serveOn's late run address; never loopback). Anything else, loopback or an address the
 * operator listed missing, or a port taken, is `fatal`: the named configuration error
 * (`bindFailure`). Pure and exported for the test.
 */
export function classifyBind(
  hostname: string,
  err: unknown,
  o: { bound: string[]; optional?: boolean; waitable?: boolean },
): "covered" | "skip" | "wait" | "fatal" {
  if (coveredByWildcard(hostname, err, o.bound)) return "covered";
  const kind = bindErrorKind(err);
  if (o.optional && (kind === "missing" || kind === "unsupported")) return "skip";
  if (o.waitable && !isLoopbackHost(hostname) && kind === "missing") return "wait";
  return "fatal";
}

/** How often a bind address that is not there yet is tried again, and first looked for. */
export const BIND_RETRY_MS = 5_000;

/** The longest `lateRunAddress` waits between looks. */
export const LOOK_MAX_MS = 60_000;

/**
 * The run address that was not there at boot, once it is: `detect` asked after `retryMs`, then
 * after twice as long each time up to `maxMs`, until it gives an answer (non-null), whose address
 * this resolves to, or `signal` aborts (null). Each look spawns the docker CLI, which a machine
 * whose docker never comes up should not pay for every few seconds forever. A Linux docker bridge
 * exists only while dockerd is up, so a ryph started first finds none, and without this its runs
 * could not call home until a restart. `detect` answers null while it cannot tell yet (no
 * daemon), and `{ address: null }` once it can and there is nothing to bind.
 */
export function lateRunAddress(o: {
  detect: () => Promise<{ address: string | null } | null>;
  signal: AbortSignal;
  retryMs?: number;
  maxMs?: number;
  /** For the test: setTimeout, unref'd — never what keeps the process up. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}): Promise<string | null> {
  const found = Promise.withResolvers<string | null>();
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    id.unref();
    return id;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    clearTimeout(timer);
    found.resolve(null);
  };
  if (o.signal.aborted) abort();
  o.signal.addEventListener("abort", abort, { once: true });
  const look = (wait: number) => {
    timer = setTimer(async () => {
      const answer = await o.detect().catch(() => null);
      if (o.signal.aborted) return;
      if (answer === null) return look(Math.min(wait * 2, o.maxMs ?? LOOK_MAX_MS));
      o.signal.removeEventListener("abort", abort);
      found.resolve(answer.address);
    }, wait);
  };
  if (!o.signal.aborted) look(o.retryMs ?? BIND_RETRY_MS);
  return found.promise;
}

/**
 * One listener per bind address, drained as one. Any failure at boot throws the named
 * configuration error (`bindFailure`), after shutting down whatever had bound before it.
 *
 * `later` is the run address found after boot (`lateRunAddress`): bound once it resolves, unless
 * already bound. Missing, it is tried again every `retryMs` until it binds or the server shuts
 * down. A retry can also fail for another reason: the port taken by something else, say. That is
 * reported once through `onWaiting`, as the named error, and still retried — a port held by a
 * process on its way out frees up, and stopping would leave the address unbound until a restart
 * for a condition that often clears itself.
 *
 * An IPv4 address found taken while `::` listens on the same port is skipped as covered, at boot
 * or later: the dual-stack socket already answers it (`coveredByWildcard`). It never says so;
 * the boot line counts it as listening, which it is.
 *
 * The set answers as one server: a listener bound late takes the last `ref`/`unref`, and
 * `finished` waits for `later` to settle and its address to bind (or a shutdown), and then for
 * every listener, the late one included.
 */
export async function serveOn(opts: {
  binds: string[];
  /** The run address found after boot, bound once it resolves (`lateRunAddress`). */
  later?: Promise<string | null>;
  port: number;
  variable: string;
  what: string;
  options: Omit<ServeOptions, "port" | "hostname" | "onListen">;
  handler: ServeHandler;
  onWaiting: (message: string, hostname: string) => void;
  onBound: (hostname: string) => void;
  /** For the test. */
  serve?: (options: ServeOptions, handler: ServeHandler) => Promise<HttpServer>;
  retryMs?: number;
}): Promise<HttpServer> {
  const { binds, port, variable, what } = opts;
  const serve = opts.serve ?? serveHttp;
  const listen = (hostname: string) =>
    serve({ ...opts.options, port, hostname, onListen: () => {} }, opts.handler);
  const servers: HttpServer[] = [];
  const bound: string[] = [];
  for (const hostname of bindOrder(binds)) {
    try {
      servers.push(await listen(hostname));
      bound.push(hostname);
    } catch (err) {
      if (classifyBind(hostname, err, { bound }) === "covered") continue;
      // What did bind is let go, or a caller that reports the error and carries on would keep
      // those ports.
      await Promise.all(servers.map((server) => server.shutdown().catch(() => {})));
      throw new Error(bindFailure(what, variable, hostname, port, err));
    }
  }
  if (opts.later === undefined && servers.length === 1) return servers[0];
  // Settled once no listener can be added any more: `later` settled and bound, or shut down.
  const settled = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let done = false;
  let refed = true;
  // One bind attempt at a time: binding is async, and a retry that fired while the previous one
  // was still out would bind the address twice.
  let trying = false;
  // Said once: a retry that failed for a reason other than a missing address.
  let reported = false;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    done = true;
    settled.resolve();
  };
  const tryBind = async (hostname: string) => {
    if (trying || done) return;
    trying = true;
    let server: HttpServer;
    try {
      server = await listen(hostname);
    } catch (err) {
      const outcome = classifyBind(hostname, err, { bound, waitable: true });
      if (outcome === "covered") return stop();
      if (outcome !== "wait" && !reported) {
        reported = true;
        opts.onWaiting(
          `${bindFailure(what, variable, hostname, port, err)} Still trying every few seconds.`,
          hostname,
        );
      }
      return;
    } finally {
      trying = false;
    }
    // Shut down while this bind was out: let it go rather than leave it listening unowned.
    if (closed) {
      await server.shutdown().catch(() => {});
      return;
    }
    if (!refed) server.unref();
    servers.push(server);
    bound.push(hostname);
    stop();
    opts.onBound(hostname);
  };
  if (opts.later === undefined) stop();
  else {
    opts.later.then(async (hostname) => {
      if (closed || hostname === null || bound.includes(hostname)) return stop();
      await tryBind(hostname);
      if (done) return;
      timer = setInterval(() => void tryBind(hostname), opts.retryMs ?? BIND_RETRY_MS);
      timer.unref();
    }, stop);
  }
  const shutdown = async () => {
    closed = true;
    stop();
    await Promise.all(servers.map((s) => s.shutdown()));
  };
  let finished: Promise<void> | null = null;
  // The drain and the summary only ever shut a listener down, so the set answers as one.
  return {
    get finished() {
      return finished ??= settled.promise.then(() =>
        Promise.all(servers.map((s) => s.finished)).then(() => {})
      );
    },
    addr: servers[0].addr,
    shutdown,
    ref: () => {
      refed = true;
      servers.forEach((s) => s.ref());
    },
    unref: () => {
      refed = false;
      servers.forEach((s) => s.unref());
    },
    [Symbol.asyncDispose]: shutdown,
  };
}
