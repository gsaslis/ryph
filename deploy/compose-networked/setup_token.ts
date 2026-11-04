import { command } from "../../packages/process/src/mod.ts";

/**
 * The setup token an unclaimed deployment's first registration needs, read out of the control
 * plane's log the way an operator reads it. One copy for the three scripts that claim a stack:
 * smoke.ts here and perf/load.ts read `docker compose logs`, deploy/helm/smoke.ts reads
 * `kubectl logs`.
 *
 * Null when the log has none: the deployment is claimed, and the caller signs in instead. The
 * last match wins, since each unclaimed boot prints the token again. `override` is the caller's
 * env var for a deployment whose log has scrolled past it, and is taken as given.
 */
export async function readSetupToken(
  logs: { command: string; args: string[] },
  override?: string,
): Promise<string | null> {
  if (override) return override;
  const out = await command(logs.command, {
    args: logs.args,
    stdout: "piped",
    stderr: "null",
  }).output();
  return parseSetupToken(new TextDecoder().decode(out.stdout));
}

/** The last setup token a log prints, or null when it prints none. The playground reads its own
 * host's output with it. */
export function parseSetupToken(log: string): string | null {
  return [...log.matchAll(/Setup token: ([0-9a-f]{64})/g)].at(-1)?.[1] ?? null;
}
