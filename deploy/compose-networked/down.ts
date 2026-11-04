/**
 * `bun run compose:down` (and, with `--volumes`, `compose:reset`): the stack's containers and
 * networks, and what the launcher started for it. `perf:down` and `perf:reset` run it too, for the
 * perf project: `-p ryph-perf -f perf/compose.perf.yaml`.
 *
 * `docker compose down` alone no longer gets there. The launcher starts containers compose does not
 * know about: the run gate (on the deployment network, for the stack's whole life), runs, check
 * suites and builds on the run network, and the tool guard, the egress relay and hosted MCP servers
 * on the tools network, which the launcher makes too. While any of them is attached, compose
 * cannot remove the network it is on. So this
 * removes compose's containers first (the launcher with them, so nothing new starts), then every
 * container that carries this deployment's labels, then the networks.
 *
 * Only ours, by label and by name, all read from the rendered compose files: the deployment is the
 * launcher's RYPH_DOCKER_NETWORK (`ryph`), which it stamps as `ryph.deployment` on everything it
 * starts and makes, the gate, the egress relay, every hosted tool container and the tools network
 * included.
 * A `ryph` binary on the same engine labels its own `default`, and its networks are `ryph-runs` and
 * `ryph-tools`, so nothing of it matches.
 *
 * A confined environment build is the one thing without a deployment label: a BuildKit container
 * (`buildx_buildkit_<builder>0`) and its state volume (`…0_state`) on a network of its own, all named
 * for the builder, `ryph-build-<deployment digest>-<environment>` (confinedBuilderName), which a
 * launcher killed mid-build leaves behind. Found by that deployment prefix, and by the gate (every
 * confined build puts it on its network) and the build network's labels. Check suites' volumes carry
 * `ryph.check` and the deployment label, and go too.
 *
 * Every step is attempted: one that fails is a warning, the final `compose down` always runs, and
 * the exit is non-zero if anything failed, so a half-done teardown never reads as done.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../packages/process/src/mod.ts";
// The one dependency-free file that names builders, so a teardown runs without `bun install`.
import { confinedBuilderPrefixFor } from "../../packages/orchestrator/src/adapters/environment_builder/local_images.ts";

function flags(name: string, short: string): string[] {
  const values: string[] = [];
  const argv = process.argv.slice(2);
  argv.forEach((arg, i) => {
    if ((arg === name || arg === short) && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  });
  return values;
}

const volumes = process.argv.includes("--volumes");
const project = flags("--project", "-p").at(-1);
const COMPOSE = [
  "compose",
  ...(project === undefined ? [] : ["-p", project]),
  "-f",
  fileURLToPath(new URL("compose.yaml", import.meta.url)),
  ...flags("--file", "-f").flatMap((file) => ["-f", resolve(file)]),
];

const decoder = new TextDecoder();
async function docker(args: string[], quiet = false): Promise<{ code: number; out: string }> {
  const result = await command("docker", {
    args,
    stdout: "piped",
    stderr: quiet ? "null" : "inherit",
  }).output();
  return { code: result.code, out: decoder.decode(result.stdout) };
}
const lines = (out: string) => out.split(/\s+/).map((l) => l.trim()).filter(Boolean);

// The names, from the files as compose merges them. Uninterpolated, so it needs no .env; every
// name below is a literal in the files.
interface Rendered {
  networks?: Record<string, { name?: string }>;
  services?: Record<string, { environment?: Record<string, string | null> | string[] }>;
}
const rendered = await docker([...COMPOSE, "config", "--no-interpolate", "--format", "json"]);
if (rendered.code !== 0) {
  // Without the files' names nothing of the launcher's can be found; compose's own still goes.
  await docker([...COMPOSE, "down", ...(volumes ? ["-v"] : [])]);
  console.error("teardown incomplete: the compose files could not be rendered");
  process.exit(1);
}
const config = JSON.parse(rendered.out) as Rendered;
// A map, or `NAME=value` lines once an overlay has merged into it.
const launcherEnv = config.services?.launcher?.environment ?? {};
const launcher: Record<string, string | null> = Array.isArray(launcherEnv)
  ? Object.fromEntries(
    launcherEnv.map((line) => [line.split("=")[0], line.split("=").slice(1).join("=")]),
  )
  : launcherEnv;
const deployment = launcher.RYPH_DOCKER_NETWORK || (config.networks?.default?.name ?? "ryph");
const runNetwork = launcher.RYPH_DOCKER_RUN_NETWORK || `ryph-runs-${deployment}`;
// The launcher's to make, never compose's (it is internal, which compose does not know to keep).
const toolNetwork = launcher.RYPH_TOOL_NETWORK || `ryph-tools-${deployment}`;
const gate = `ryph-gate-${deployment}`;
console.log(`deployment ${deployment}: ${gate}, ${runNetwork}, ${toolNetwork}`);

const failures: string[] = [];
const failed = (what: string) => {
  failures.push(what);
  console.warn(`warning: ${what}`);
};
const builder = confinedBuilderPrefixFor(deployment);

// Compose's own first. Its network removal may fail here, on a network the gate or a run still
// holds; the networks are removed below once nothing is attached.
await docker([...COMPOSE, "down", ...(volumes ? ["-v"] : [])], true);

try {
  // Build networks, found before the gate goes: the gate is how an older build network says whose
  // it is; this deployment's builder prefix and labels say it for the rest.
  const buildNetworks = new Set<string>();
  const onGate = await docker(
    ["inspect", "-f", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", gate],
    true,
  );
  if (onGate.code === 0) {
    for (const name of lines(onGate.out)) {
      if (name.startsWith("ryph-build-")) buildNetworks.add(name);
    }
  }
  const labelled = await docker([
    "network",
    "ls",
    "--filter",
    `label=ryph.deployment=${deployment}`,
    "--filter",
    "label=ryph.build",
    "--format",
    "{{.Name}}",
  ]);
  for (const name of lines(labelled.out)) buildNetworks.add(name);
  const prefixed = await docker([
    "network",
    "ls",
    "--filter",
    `name=${builder}`,
    "--format",
    "{{.Name}}",
  ]);
  for (const name of lines(prefixed.out)) if (name.startsWith(builder)) buildNetworks.add(name);

  const ids = new Set<string>();
  // Hosted servers, the tool guard and the egress relay carry the deployment label too, so this
  // one filter takes them; selecting by the tools network alone would take another deployment's
  // sharing it.
  {
    const { out } = await docker(["ps", "-aq", "--filter", `label=ryph.deployment=${deployment}`]);
    for (const id of lines(out)) ids.add(id);
  }
  for (const network of buildNetworks) {
    const { out } = await docker(
      ["network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", network],
      true,
    );
    for (const name of lines(out)) {
      if (name.startsWith("buildx_buildkit_ryph-build-")) ids.add(name);
    }
  }
  const kits = await docker([
    "ps",
    "-a",
    "--filter",
    `name=buildx_buildkit_${builder}`,
    "--format",
    "{{.Names}}",
  ]);
  for (const name of lines(kits.out)) {
    if (name.startsWith(`buildx_buildkit_${builder}`)) ids.add(name);
  }
  if (ids.size > 0) {
    const { code } = await docker(["rm", "-f", ...ids]);
    if (code !== 0) failed(`removing ${ids.size} container(s) the launcher started`);
    else console.log(`removed ${ids.size} container(s) the launcher started`);
  }

  // Volumes the launcher made: check suites' (by label) and the builders' BuildKit state (by name).
  const vols = new Set<string>();
  const checks = await docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    "label=ryph.check",
    "--filter",
    `label=ryph.deployment=${deployment}`,
  ]);
  for (const name of lines(checks.out)) vols.add(name);
  const states = await docker([
    "volume",
    "ls",
    "--filter",
    `name=buildx_buildkit_${builder}`,
    "--format",
    "{{.Name}}",
  ]);
  for (const name of lines(states.out)) {
    if (name.startsWith(`buildx_buildkit_${builder}`)) vols.add(name);
  }
  for (const network of buildNetworks) {
    const state = `buildx_buildkit_${network}0_state`;
    if ((await docker(["volume", "inspect", state], true)).code === 0) vols.add(state);
  }
  for (const volume of vols) {
    if ((await docker(["volume", "rm", "-f", volume])).code !== 0) {
      failed(`removing volume ${volume}`);
    }
  }
  if (vols.size > 0) console.log(`removed ${vols.size} volume(s) the launcher made`);

  // Any other network the launcher labelled for this deployment (per-run ones included).
  const owned = await docker([
    "network",
    "ls",
    "--filter",
    `label=ryph.deployment=${deployment}`,
    "--format",
    "{{.Name}}",
  ]);
  const networks = [
    ...buildNetworks,
    ...lines(owned.out),
    runNetwork,
    toolNetwork,
    config.networks?.default?.name ?? deployment,
  ];
  for (const network of new Set(networks)) {
    const { code } = await docker(["network", "inspect", network], true);
    if (code !== 0) continue;
    if ((await docker(["network", "rm", network])).code !== 0) {
      failed(`removing network ${network}`);
    }
  }
} finally {
  // Always, once more: the volumes, and anything compose left because a network was busy.
  const last = await docker([...COMPOSE, "down", ...(volumes ? ["-v"] : [])]);
  if (last.code !== 0) failed(`docker compose down${volumes ? " -v" : ""} exited ${last.code}`);
}
if (failures.length > 0) {
  console.error(`teardown incomplete: ${failures.join("; ")}`);
  process.exit(1);
}
