// Environment variables a ryph process refuses to start under. Each changes what the runtime does
// before or around the program's code, in ways no caller of ours means to:
//
// - BUN_OPTIONS: extra Bun flags on every start, `--preload=<file>` among them, honoured even by
//   a compiled binary (measured on Bun 1.4.2). The preload has already run by the time this
//   check does, so the refusal cannot undo it; what it does is stop the program going on in a
//   process changed that way, and stop the variable reaching every bun program it starts.
// - BUN_BE_BUN: makes a compiled binary the `bun` CLI itself, which then reads the working
//   directory's bunfig.toml. Its entry never runs, so this check only sees it set where it took
//   no effect; refused so it is never passed on to a binary it would.
// - BUN_INSPECT, and every other name starting with it (BUN_INSPECT_CONNECT_TO,
//   BUN_INSPECT_PRELOAD, BUN_INSPECT_NOTIFY): opens a debugger listener, or dials one, in a
//   compiled binary too (measured on Bun 1.4.2). Whoever reaches it runs code in this process.
// - BUN_CONFIG_VERBOSE_FETCH: prints every fetch's request headers to stderr, compiled or not;
//   only an Authorization header is redacted, so an `x-api-key` or `PRIVATE-TOKEN` lands in the
//   logs as is.
// - NODE_TLS_REJECT_UNAUTHORIZED (any value but `1`): Bun's global fetch honours `0` and stops
//   verifying certificates (Deno did not). Nothing here is meant to run that way.
//
// Whoever sets a process's environment could equally set LD_PRELOAD: this is a guard against a
// variable inherited by accident, or passed on by something that trusted it, not a boundary.
//
// This file only judges an environment it is handed; reading `process.env`, printing and exiting
// stay with the caller, so the rule is the same for the runner, the CLI and every service.

/** The rule, as data: what `hostileEnvironment` refuses. */
export const HOSTILE_ENV = {
  /** Refused when set at all, even empty. */
  set: ["BUN_OPTIONS", "BUN_BE_BUN", "BUN_CONFIG_VERBOSE_FETCH"],
  /** Every name starting with this is refused when set. */
  prefix: "BUN_INSPECT",
  /** Refused when set to anything but `1`. */
  tls: "NODE_TLS_REJECT_UNAUTHORIZED",
} as const;

/** One variable a process refuses to run under, and the line saying why. */
export interface HostileVariable {
  name: string;
  message: string;
}

/**
 * Every variable in `env` a process refuses to run under, in the order the rule lists them.
 * `fromImage` adds how to fix it in an environment image, where they are set by an `ENV` more
 * often than anywhere else.
 */
export function hostileVariables(
  env: Record<string, string | undefined>,
  opts: { fromImage?: boolean } = {},
): HostileVariable[] {
  const unset = (name: string): HostileVariable => ({
    name,
    message: opts.fromImage
      ? `${name} is set; unset it (from an environment image: remove its ENV ${name}) to run this`
      : `${name} is set; unset it to run this`,
  });
  const found: HostileVariable[] = [];
  for (const name of HOSTILE_ENV.set) {
    if (env[name] !== undefined) found.push(unset(name));
  }
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith(HOSTILE_ENV.prefix) && env[name] !== undefined) found.push(unset(name));
  }
  const tls = env[HOSTILE_ENV.tls];
  if (tls !== undefined && tls !== "1") {
    const what = `${HOSTILE_ENV.tls}=${tls}`;
    found.push({
      name: HOSTILE_ENV.tls,
      message: opts.fromImage
        ? `${what} would turn off certificate checks; unset it: remove ENV ${what} from the ` +
          `environment image, and add your proxy's CA instead via NODE_EXTRA_CA_CERTS`
        : `${what} would turn off certificate checks; unset it`,
    });
  }
  return found;
}

/** The first variable `env` is refused for, or null when a process may run under it. */
export function hostileEnvironment(
  env: Record<string, string | undefined>,
  opts: { fromImage?: boolean } = {},
): HostileVariable | null {
  return hostileVariables(env, opts)[0] ?? null;
}
