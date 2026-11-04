/**
 * dev — the local dev-stack controller.
 *
 * Verbs converge or observe on demand; nothing watches or supervises. The stack's process
 * runtime sits behind `StackBackend` (tmux today) and is an implementation detail.
 */

import { type ArgumentValue, Command, EnumType, Type } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { init } from "./commands/init.ts";
import { config } from "./commands/config.ts";
import { doctor } from "./commands/doctor.ts";
import { down } from "./commands/down.ts";
import { env } from "./commands/env.ts";
import { logs } from "./commands/logs.ts";
import { remote } from "./commands/remote.ts";
import { reset, scopes } from "./commands/reset.ts";
import { restart } from "./commands/restart.ts";
import { status } from "./commands/status.ts";
import { up } from "./commands/up.ts";
import { envPackages, units } from "./stack.ts";
import { TmuxBackend } from "./tmux.ts";
import { red } from "./ui.ts";

const backend = new TmuxBackend();
const unitType = new EnumType(units.map((u) => u.name));

/**
 * A `logs` target: a unit name, `run`, or the run id following `run`. Free-form ids rule out an
 * enum, so this stays a string type with completions; unit names are validated downstream.
 */
class LogTargetType extends Type<string> {
  parse({ value }: ArgumentValue): string {
    return value;
  }
  override complete(): string[] {
    return [...units.map((u) => u.name), "run"];
  }
}

const cli = new Command()
  .name("./dev")
  .version("0.1.0")
  .description(
    `Local dev-stack controller.\nUnits: ${units.map((u) => u.name).join(", ")}.`,
  )
  .globalType("unit", unitType)
  .action(function () {
    this.showHelp();
    process.exit(2);
  })
  .command("up [units...:unit]")
  .description("Starts what's missing and waits for readiness; idempotent.")
  .example("whole stack", "./dev up")
  .example("one unit", "./dev up forge")
  .action(async (_opts, ...names: string[]) => process.exit(await up(backend, names)))
  .command("down [units...:unit]")
  .description(
    "Stops units (default: all); a stopped unit stays down until `up`.",
  )
  .action(async (_opts, ...names: string[]) => process.exit(await down(backend, names)))
  .command("restart [units...:unit]")
  .description(
    "Relaunches units in place (default: all); pane position and scrollback survive.",
  )
  .action(async (_opts, ...names: string[]) => process.exit(await restart(backend, names)))
  .command("attach [unit:unit]")
  .description(
    "Opens the tmux stack view, focused on a unit when given. Detach with C-b d.",
  )
  .example("whole board", "./dev attach")
  .example("jump to a unit", "./dev attach forge")
  .action(async (_opts, unit?: string) => {
    await backend.attach(unit);
  })
  .command("status")
  .description(
    "Reports unit and recent-run state; observes only, never changes anything.",
  )
  .option("--json", "Emit the status model as JSON.")
  .action(async ({ json }) => process.exit(await status(backend, json === true)))
  .command("logs [targets...:target]")
  .type("target", new LogTargetType())
  .description(
    "Prints logs for the given target.\n" +
      `Targets: unit names (${units.map((u) => u.name).join(", ")}) — one for its log alone, ` +
      "several for a merged view; `run [id]` — one run container by id, the newest without one, " +
      "or with -f every run as it appears; no target — all units merged, runs interleaved " +
      "when following.",
  )
  .option("-f, --follow", "Keep streaming as new output arrives.")
  .option(
    "-n, --tail <lines:number>",
    "Show only the last N lines of the initial output.",
  )
  .example("one unit, live", "./dev logs host -f")
  .example("everything, merged", "./dev logs -f")
  .example("all runs, live", "./dev logs run -f")
  .example("one specific run", "./dev logs run r-baad976418")
  .example("recent lines only", "./dev logs host -n 50")
  .action(async ({ follow, tail }, ...target: string[]) =>
    process.exit(await logs(backend, target, follow === true, tail))
  )
  .command("init")
  .description(
    "Creates missing .env files from examples and pushes both database schemas.",
  )
  .action(async () => process.exit(await init()))
  .command("doctor")
  .description(
    "Checks tools, env files, ports, and init state; changes nothing.",
  )
  .action(async () => process.exit(await doctor(backend)))
  .command("remote")
  .description(
    "Runs the app's dev server in front of a DEPLOYMENT's services, over kubectl port-forwards, " +
      "so a frontend change can be looked at against real agents, runs and history. Foreground, " +
      "not on the board: Ctrl-C stops the forwards and the server together. Everything done in " +
      "that browser tab happens to the deployment.",
  )
  .option(
    "--context <name:string>",
    "The kube context to forward through. Required: never kubectl's current one.",
    {
      required: true,
    },
  )
  .option(
    "--namespace <name:string>",
    "The services namespace whose app Deployment is read (a Helm release's namespaces.prefix).",
    { default: "ryph" },
  )
  .option("--port <port:number>", "Vite's port (default: its own, stepping past a taken one).")
  .option("--no-app", "Hold the forwards open and print the env instead of starting Vite.")
  .example("a release", "./dev remote --context <kube context>")
  .example("another release", "./dev remote --context <kube context> --namespace acme")
  .example("forwards only", "./dev remote --context <kube context> --no-app")
  .action(async ({ context, namespace, port, app }) =>
    process.exit(await remote({ context, namespace, port, app }))
  )
  .command("config [packages...:pkg]")
  .type("pkg", new EnumType(envPackages.map((d) => d.split("/").pop()!)))
  .description(
    "Shows each unit's effective configuration — declared .env resolved against the services' " +
      "documented defaults. With --env, lists the declared vars themselves instead.",
  )
  .option(
    "--env",
    "List declared .env vars per package (default: the stack's — host, forge, app); " +
      "secrets stay redacted.",
  )
  .example("resolved mode", "./dev config")
  .example("declared vars", "./dev config --env forge")
  .action(async ({ env: envView }, ...names: string[]) => {
    if (envView === true) {
      process.exit(await env(names));
    }
    if (names.length > 0) {
      console.error(red("a package filter only applies to --env"));
      process.exit(2);
    }
    process.exit(await config());
  })
  .command("reset [scopes...:scope]")
  .type("scope", new EnumType(scopes))
  .description(
    "Wipes data by scope — db (databases), forge (forge data), runs (run containers); " +
      "no scope wipes all. Confirms first.",
  )
  .example("everything", "./dev reset")
  .example("just the databases", "./dev reset db")
  .example("forge data + run containers", "./dev reset forge runs")
  .option("-y, --yes", "Skip the confirmation prompt.")
  .action(async ({ yes }, ...names: string[]) =>
    process.exit(await reset(backend, names, yes === true))
  )
  .command("completions", new CompletionsCommand());

try {
  await cli.parse(process.argv.slice(2));
} catch (err) {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
