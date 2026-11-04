import type { StackBackend } from "../backend.ts";
import { probe, waitReady } from "../probe.ts";
import { selectUnits, type Unit, units } from "../stack.ts";
import { dim, green, yellow } from "../ui.ts";

/**
 * Relaunches the named units (default: all) in place: a unit with a display slot keeps it —
 * position and scrollback survive — and a unit without one is started fresh.
 */
export async function restart(
  backend: StackBackend,
  names: string[],
): Promise<number> {
  const desired = selectUnits(names);
  const observed = await backend.list();

  const started: Unit[] = [];
  let allReady = true;
  for (const unit of desired) {
    const pane = observed.get(unit.name);
    if (!pane && unit.port && (await probe(unit.port))) {
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
      `  ${unit.name.padEnd(6)} ${pane ? "restarting in place…" : "starting…"}`,
    );
    await backend.start(unit);
    started.push(unit);
  }
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
    allReady ? green("restart complete") : yellow("restarted with warnings"),
  );
  return allReady ? 0 : 1;
}
