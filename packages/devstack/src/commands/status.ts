import type { StackBackend } from "../backend.ts";
import { listRuns } from "../docker.ts";
import { probe } from "../probe.ts";
import { units } from "../stack.ts";
import { bold, DEAD, dim, DOWN, LIVE, NONE, table } from "../ui.ts";

interface UnitStatus {
  name: string;
  pane: "alive" | "exited" | "absent";
  ready: boolean | null;
  port: number | null;
}

/** Reports the observed state of units and recent runs; observes only, never converges. */
export async function status(
  backend: StackBackend,
  json: boolean,
): Promise<number> {
  const observed = await backend.list();
  const unitStatuses: UnitStatus[] = await Promise.all(
    units.map(async (unit) => {
      const paneState = observed.get(unit.name);
      const pane = paneState
        ? (paneState.dead ? "exited" as const : "alive" as const)
        : "absent" as const;
      const ready = unit.port ? await probe(unit.port) : null;
      return { name: unit.name, pane, ready, port: unit.port ?? null };
    }),
  );
  const runs = await listRuns();

  if (json) {
    console.log(JSON.stringify({ units: unitStatuses, runs }, null, 2));
    return 0;
  }

  console.log(bold("UNITS"));
  table([
    ["NAME", "PANE", "READY", "PORT", "NOTE"],
    ...unitStatuses.map((u) => [
      u.name,
      u.pane === "alive" ? LIVE : u.pane === "exited" ? DEAD : DOWN,
      u.ready === null ? NONE : u.ready ? LIVE : DOWN,
      u.port?.toString() ?? "",
      note(u),
    ]),
  ]);

  console.log();
  console.log(bold("RUNS") + dim(" (docker, last 5)"));
  if (runs === null) {
    console.log(dim("  docker not available"));
  } else if (runs.length === 0) {
    console.log(dim("  none"));
  } else {
    table([
      ["RUN", "STATE", "STATUS"],
      ...runs.slice(0, 5).map((r) => [r.runId, r.state, dim(r.status)]),
    ]);
  }
  return 0;
}

function note(u: UnitStatus): string {
  if (u.pane === "exited") return "process exited — see pane or ./dev logs";
  if (u.pane === "alive" && u.ready === false) return "port not answering";
  if (u.pane === "absent" && u.ready === true) {
    return "port answering outside the stack";
  }
  return "";
}
