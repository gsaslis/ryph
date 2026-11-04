import { stat } from "node:fs/promises";
import type { StackBackend } from "../backend.ts";
import { probe, waitReady } from "../probe.ts";
import { selectUnits, type Unit, units } from "../stack.ts";
import { dim, green, red, yellow } from "../ui.ts";
import { wiringChecks } from "../wiring.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Converges the named units (default: all) toward running; idempotent. */
export async function up(
  backend: StackBackend,
  names: string[],
): Promise<number> {
  const desired = selectUnits(names);

  const missingEnv: Unit[] = [];
  for (const unit of desired) {
    if (unit.envFile && !(await exists(unit.envFile))) missingEnv.push(unit);
  }
  if (missingEnv.length > 0) {
    for (const unit of missingEnv) {
      console.error(red(`${unit.name}: missing ${unit.envFile}`));
    }
    console.error(dim("run `./dev init` first"));
    return 1;
  }

  // Then what those files say. The host and the forge each refuse a bad .env at boot, but from
  // here that only ever read as "not answering on 7411 after 10s", with the reason in a log the
  // caller then had to go and find — and when the knob had been RENAMED under an existing .env
  // (RYPH_IMAGE_PI → RYPH_AGENT_IMAGE), nothing anywhere said so. Asked first, it is a message
  // naming the knob. Only the checks a boot actually fails on stop the launch; the rest are
  // `doctor`'s to report.
  if (desired.some((u) => u.name === "host" || u.name === "forge")) {
    const fatal = (await wiringChecks()).filter((c) => c.status === "bad" && c.fatal);
    if (fatal.length > 0) {
      for (const check of fatal) {
        console.error(`${red("✗")} ${check.label} ${yellow(check.note)}`);
      }
      console.error(
        dim("fix the .env and `./dev up` again · `./dev doctor` for the whole picture"),
      );
      return 1;
    }
  }

  console.log(
    dim(
      `reconciling → ${desired.length} unit${desired.length === 1 ? "" : "s"} desired`,
    ),
  );
  const observed = await backend.list();
  const started: Unit[] = [];
  let allReady = true;
  for (const unit of desired) {
    const pane = observed.get(unit.name);
    if (pane && !pane.dead) {
      console.log(`  ${unit.name.padEnd(6)} already running ${dim("skipped")}`);
      continue;
    }
    if (unit.port && (await probe(unit.port))) {
      allReady = false;
      console.log(
        `  ${unit.name.padEnd(6)} ${
          yellow(`port ${unit.port} already in use outside the stack`)
        } ` +
          dim("skipped"),
      );
      continue;
    }
    console.log(
      `  ${unit.name.padEnd(6)} ${pane?.dead ? "was exited — restarting" : "starting…"}`,
    );
    await backend.start(unit);
    started.push(unit);
  }
  await backend.ensureShell();
  await backend.arrange(units.map((u) => u.name));

  for (const unit of started) {
    if (!unit.port) continue;
    const { ready, seconds } = await waitReady(unit.port);
    if (ready) {
      console.log(
        `  ${unit.name.padEnd(6)} ready in ${seconds.toFixed(1)}s ${dim(`(${unit.port})`)}`,
      );
    } else {
      allReady = false;
      console.log(
        `  ${unit.name.padEnd(6)} ${yellow(`not answering on ${unit.port} after ${seconds}s`)} ` +
          dim(`— ./dev logs ${unit.name}`),
      );
    }
  }

  console.log(
    allReady
      ? green("stack ready") + dim(" · ./dev status · ./dev logs <unit> -f")
      : yellow("stack up with warnings") + dim(" · ./dev status"),
  );
  return allReady ? 0 : 1;
}
