// The CLI side of the docker ToolHost: the CLI call, the network name, and the launch posture
// its argv is built from.

import { command as spawnCommand } from "@ryph/process";
import type { ToolLaunchSpec } from "../../ports/tool_host.ts";

/** The network hosted containers and the guard join. Agent containers never do. */
export const TOOLS_NETWORK = "ryph-tools";

/** `nobody`. Whatever user an image declares, a tool container runs as this one. */
export const TOOL_USER = "65534:65534";

/**
 * The label every container this platform launches carries, value = its name. It is how the
 * backend's own list can be matched against the rows: a row says what should run, and this says
 * what IS running that we put there — the pair is what makes an orphan visible.
 */
export const TOOL_LABEL = "ryph.tool";

/**
 * Which tools network a container was launched onto, value = the network. Two deployments on one
 * daemon each have their own tools network, and this is how each one's sweep lists its own
 * containers and never the other's.
 */
export const TOOL_NETWORK_LABEL = "ryph.tool.network";

/**
 * Which deployment launched a container, value = its deployment id: the same key and value the
 * docker provisioner stamps on runs (`ryph.deployment`, its RYPH_DOCKER_NETWORK or "default").
 * Required beside the network label, so two deployments that land on one tools network (a
 * standalone launcher left on the binary's default) still never list, stop or replace each
 * other's servers.
 */
export const TOOL_DEPLOYMENT_LABEL = "ryph.deployment";

/** The deployment id of a deployment whose docker network is unset: the binary's, by default. */
export const DEFAULT_TOOL_DEPLOYMENT = "default";

/**
 * Runs a backend CLI, returning stdout; a non-zero exit throws with its stderr. `env` is added to
 * the CLI process's own environment — which is how a secret reaches a container without its value
 * ever appearing in an argv (see `envArgs`).
 */
export async function cli(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await spawnCommand(command, {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
  if (code !== 0) {
    const reason = out.stderr.trim();
    throw new Error(`${command} ${args[0]} failed: ${reason}`);
  }
  return out;
}

/**
 * The refusals every launch makes before any argv exists. `run` lifetimes are declared on the
 * port and not implemented, and an unpublished name must not be able to smuggle a flag.
 */
export function checkSpec(spec: ToolLaunchSpec): void {
  if (spec.lifetime !== "shared") {
    throw new Error("per-run tool containers are not implemented yet (lifetime: run)");
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(spec.name)) {
    throw new Error(`not a valid tool container name: ${JSON.stringify(spec.name)}`);
  }
  if (spec.image.startsWith("-")) throw new Error("an image reference cannot start with '-'");
}

/**
 * `-e K=V` for every setting — the credential is never among them; see ports/tool_host.ts — and
 * `-e NAME` alone for every secret. Both backends read a bare name from the launching process's
 * environment (docker's documented behaviour; `container run --help`: "key=value, or just key to
 * inherit from host"), and `cli` puts the values there. So a token is never a word in an argv,
 * which on Linux means never a world-readable line in `/proc/<pid>/cmdline`.
 */
export function envArgs(spec: Pick<ToolLaunchSpec, "env" | "secretEnv">): string[] {
  return [
    ...Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...Object.keys(spec.secretEnv ?? {}).flatMap((key) => ["-e", key]),
  ];
}
