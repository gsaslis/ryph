/**
 * How a unit's task gets launched — through `mise x` when mise is there, plainly when it is not.
 *
 * `mise x -- bun run <task>` resolves the toolchain from the repo's mise.toml pin rather than
 * from the ambient PATH. That matters most inside tmux, which snapshots PATH when its SERVER
 * starts: a pane launched hours later inherits whatever that shell was born with, so a bare
 * `bun` there can be a different version than the repo asks for. It broke vite once already.
 *
 * But mise is a nicety, not a dependency. The repo's own requirements are bun, docker and tmux;
 * mise.toml is a version PIN, and plenty of checkouts get bun some other way. Hard-requiring it
 * would mean this tool refuses to start for someone whose stack would otherwise run perfectly —
 * so it is used when present and skipped when not, and `doctor` reports which.
 */

import { command } from "@ryph/process";

let cached: boolean | undefined;

/** Whether `mise` can be executed. Probed once; the answer cannot change mid-command. */
export async function hasMise(): Promise<boolean> {
  if (cached !== undefined) return cached;
  try {
    const { success } = await command("mise", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    cached = success;
  } catch {
    cached = false;
  }
  return cached;
}

/** The argv that runs `bun run <task>`, pinned through mise when it is available. */
export async function taskArgv(task: string): Promise<string[]> {
  return await hasMise() ? ["mise", "x", "--", "bun", "run", task] : ["bun", "run", task];
}

/** The same, as a shell string — what tmux needs, since a pane runs a command line. */
export async function taskCommand(task: string): Promise<string> {
  return (await taskArgv(task)).join(" ");
}
