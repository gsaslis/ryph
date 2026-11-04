// What `ryph up` says, and asks, on its way down.
//
// Everything a run needs lives in this one process — the model proxy, the MCP gateway, the
// transcript, the heartbeat endpoint — so a run left behind keeps its container and loses all of
// them, and the next boot marks it lost unless that boot comes within the heartbeat timeout.
// Leaving runs going is therefore only worth it for a quick restart; the question below
// offers cancelling them when exiting, or cancelling the shutdown altogether. Hosted tool servers
// are not asked about at all: the drain always stops them, and the next boot brings them back.
//
// Asked only on Ctrl-C at a terminal. A SIGTERM, a pipe, a service manager — nobody is there to
// answer, and blocking a stop on a question nobody can see is worse than either answer.

import type { StopContext } from "@ryph/host";
import type { Prompter } from "./prompt.ts";

export interface StopIO {
  /** Someone to ask; null when there is nobody on the other end. */
  prompter: Prompter | null;
  say(text: string): void;
  now(): Date;
}

export async function onStop(ctx: StopContext, io: StopIO): Promise<void | "keep-running"> {
  const n = ctx.runs.length;
  if (n > 0) {
    const them = n === 1 ? "it" : "them";
    const leaving = `  leaving ${plural(n, "run")} running — a run left behind survives only if ` +
      `ryph is back within ${Math.round(ctx.heartbeatTimeoutMs / 1000)} s`;
    io.say("");
    io.say(`  ${plural(n, "run")} still going:`);
    for (const run of ctx.runs) {
      io.say(`    ${run.title} · ${run.agent} · ${age(io.now(), run.createdAt)}`);
    }
    if (io.prompter === null || ctx.signal !== "SIGINT") {
      io.say(leaving);
    } else {
      io.say(`  Ctrl-C again to exit and leave ${them} running`);
      const choice = await Promise.race([
        io.prompter.select(
          "  What would you like to do?",
          [
            { label: "Cancel shutdown and keep ryph running", value: "keep-running" },
            {
              label: `Cancel ${them}, then exit`,
              hint: "each wraps up as Cancel in the UI does",
              value: "cancel-runs",
            },
            {
              label: `Exit without cancelling ${them}`,
              hint: "runs survive only a brief restart",
              value: "leave-runs",
            },
          ],
          0,
          { signal: ctx.interrupted },
        ),
        aborted(ctx.interrupted).then(() => null),
      ]);
      if (choice === "keep-running" && !ctx.interrupted.aborted) {
        io.say("  Shutdown cancelled — ryph is still running");
        return "keep-running";
      }
      if (choice === "cancel-runs" && !ctx.interrupted.aborted) {
        const left = await ctx.cancelRuns((left) => {
          if (left > 0) {
            io.say(`  waiting for ${plural(left, "run")} to wrap up… (Ctrl-C to stop waiting)`);
          }
        });
        io.say(
          left === 0
            ? `  ✓ cancelled ${plural(n, "run")}`
            : `  stopped waiting — ${plural(left, "run")} still going, left behind`,
        );
      } else {
        if (choice === null) io.say("");
        io.say(leaving);
      }
    }
  }
  if (ctx.hostedServers.length > 0) {
    io.say(
      `  stopping ${plural(ctx.hostedServers.length, "hosted tool server")}: ` +
        ctx.hostedServers.join(", "),
    );
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "40 s", "4 min", "2 h 5 min" — how long a run has been going, for telling them apart. */
export function age(now: Date, since: string): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
