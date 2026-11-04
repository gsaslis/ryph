import type { Run } from "./types.ts";

/** Settled activity is meaningful only while the agent is alive, in its running phase. */
export function idleStateOf(run: Pick<Run, "state" | "phase" | "idleState">) {
  return run.state === "running" && run.phase === "running" ? run.idleState ?? null : null;
}
