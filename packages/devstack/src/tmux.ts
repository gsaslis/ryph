/**
 * Tmux-backed `StackBackend`: tmux is the process-holding daemon, this adapter its controller.
 *
 * Invariants:
 * - All stack panes live in session "ryph", window "stack", tiled layout.
 * - Ownership is tracked via the pane user option `@ryph_unit`; untagged panes are never touched.
 * - Panes keep `remain-on-exit on`, so a crashed unit stays visible at its last output
 *   (reported as dead) instead of vanishing.
 * - A unit with a pane relaunches in place (`respawn-pane`), keeping its slot and scrollback.
 * - The board carries one non-unit fixture: a console shell pane tagged `@ryph_shell`,
 *   invisible to `list` and the reconcile verbs.
 * - Every pane's output is piped to its unit log file; each launch truncates it, so a log file
 *   always covers exactly the current (or last) launch.
 */

import { command } from "@ryph/process";
import { mkdir, writeFile } from "node:fs/promises";
import type { PaneState, StackBackend } from "./backend.ts";
import { taskCommand } from "./toolchain.ts";
import { logsDir, repoRoot, type Unit } from "./stack.ts";

const SESSION = "ryph";
const WINDOW = "stack";
const TARGET = `${SESSION}:${WINDOW}`;
const UNIT_TAG = "@ryph_unit";
const SHELL_TAG = "@ryph_shell";
const SHELL_SLOT = "\0shell";

async function tmux(...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await command("tmux", { args })
    .output();
  if (!success) {
    throw new Error(
      `tmux ${args[0]} failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

async function sessionExists(): Promise<boolean> {
  const { success } = await command("tmux", {
    args: ["has-session", "-t", `=${SESSION}`],
    stderr: "null",
  }).output();
  return success;
}

async function listPaneIds(): Promise<
  Map<string, { id: string; dead: boolean; index: number }>
> {
  if (!(await sessionExists())) return new Map();
  const out = await tmux(
    "list-panes",
    "-s",
    "-t",
    SESSION,
    "-F",
    `#{pane_id}\t#{pane_dead}\t#{pane_index}\t#{${UNIT_TAG}}`,
  );
  const panes = new Map<string, { id: string; dead: boolean; index: number }>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [id, dead, index, unit] = line.split("\t");
    if (unit) panes.set(unit, { id, dead: dead === "1", index: Number(index) });
  }
  return panes;
}

export class TmuxBackend implements StackBackend {
  async list(): Promise<Map<string, PaneState>> {
    const panes = await listPaneIds();
    return new Map([...panes].map(([unit, { dead }]) => [unit, { dead }]));
  }

  async start(unit: Unit): Promise<void> {
    await mkdir(logsDir, { recursive: true });
    await writeFile(this.logPath(unit.name), "");
    // Through `mise x` when mise is installed: the tmux server snapshots PATH at creation, so a
    // bare `bun` in a pane keeps whatever version that server was born with, regardless of the
    // repo's pin. See toolchain.ts for why it is not required.
    const command = await taskCommand(unit.task);
    const existing = (await listPaneIds()).get(unit.name);
    if (existing) {
      await tmux(
        "respawn-pane",
        "-k",
        "-c",
        unit.cwd,
        "-t",
        existing.id,
        command,
      );
      // Plain pipe-pane (no -o) replaces any pipe left over from the previous launch; the old
      // pipe process dies with the respawn but tmux still counts it as open, so -o would no-op.
      await tmux(
        "pipe-pane",
        "-t",
        existing.id,
        `cat >> '${this.logPath(unit.name)}'`,
      );
      return;
    }
    const spawn = ["-d", "-c", unit.cwd, "-P", "-F", "#{pane_id}", command];
    let paneId: string;
    if (!(await sessionExists())) {
      paneId = await tmux("new-session", "-s", SESSION, "-n", WINDOW, ...spawn);
      await styleWindow();
    } else if (!(await windowExists())) {
      paneId = await tmux(
        "new-window",
        "-a",
        "-t",
        SESSION,
        "-n",
        WINDOW,
        ...spawn,
      );
      await styleWindow();
    } else {
      paneId = await tmux("split-window", "-t", TARGET, ...spawn);
      await tmux("select-layout", "-t", TARGET, "tiled");
    }
    await tmux("set-option", "-p", "-t", paneId, UNIT_TAG, unit.name);
    await tmux("select-pane", "-t", paneId, "-T", unit.title);
    await tmux(
      "pipe-pane",
      "-t",
      paneId,
      "-o",
      `cat >> '${this.logPath(unit.name)}'`,
    );
  }

  async stop(name: string): Promise<void> {
    const pane = (await listPaneIds()).get(name);
    if (pane) await tmux("kill-pane", "-t", pane.id);
  }

  async arrange(order: string[]): Promise<void> {
    const panes = await listPaneIds();
    const shell = await findShellPane();
    const slots = [...panes.entries()]
      .map(([name, pane]) => ({ name, id: pane.id, index: pane.index }));
    // The console fixture takes part in the ordering as the permanent last slot; the sentinel
    // name cannot collide with a unit.
    if (shell) slots.push({ name: SHELL_SLOT, id: shell.id, index: shell.index });
    slots.sort((a, b) => a.index - b.index);
    const desired = [
      ...order.filter((name) => panes.has(name)),
      ...(shell ? [SHELL_SLOT] : []),
    ];
    let moved = false;
    for (let i = 0; i < desired.length; i++) {
      if (slots[i].name === desired[i]) continue;
      const j = slots.findIndex((slot, at) => at > i && slot.name === desired[i]);
      await tmux("swap-pane", "-d", "-s", slots[j].id, "-t", slots[i].id);
      [slots[i], slots[j]] = [slots[j], slots[i]];
      moved = true;
    }
    // Re-tiling only after an actual move keeps manual pane sizes and zoom intact across
    // idempotent reconciles.
    if (moved) await tmux("select-layout", "-t", TARGET, "tiled");
  }

  async attach(unit?: string): Promise<void> {
    if (!(await sessionExists())) {
      throw new Error("stack is not running — try `./dev up`");
    }
    if (unit) {
      const pane = (await listPaneIds()).get(unit);
      if (!pane) {
        throw new Error(`${unit} has no pane — try \`./dev up ${unit}\``);
      }
      await tmux("select-window", "-t", TARGET);
      await tmux("select-pane", "-t", pane.id);
    }
    if (process.env.TMUX) {
      await tmux("switch-client", "-t", SESSION);
      return;
    }
    const status = await (await command("tmux", {
      args: ["attach-session", "-t", SESSION],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn()).status;
    if (!status.success) throw new Error("tmux attach failed");
  }

  async ensureShell(): Promise<void> {
    if (!(await sessionExists()) || !(await windowExists())) return;
    const pane = await findShellPane();
    if (pane && !pane.dead) return;
    if (pane) {
      await tmux("respawn-pane", "-k", "-c", repoRoot, "-t", pane.id);
      return;
    }
    const paneId = await tmux(
      "split-window",
      "-d",
      "-c",
      repoRoot,
      "-t",
      `${TARGET}.{bottom-right}`,
      "-P",
      "-F",
      "#{pane_id}",
    );
    await tmux("set-option", "-p", "-t", paneId, SHELL_TAG, "1");
    await tmux("select-pane", "-t", paneId, "-T", "🐚 shell");
    await tmux("select-layout", "-t", TARGET, "tiled");
  }

  async removeShell(): Promise<void> {
    const pane = await findShellPane();
    if (pane) await tmux("kill-pane", "-t", pane.id);
  }

  logPath(name: string): string {
    return `${logsDir}/${name}.log`;
  }
}

async function findShellPane(): Promise<
  { id: string; dead: boolean; index: number } | undefined
> {
  if (!(await sessionExists())) return undefined;
  const out = await tmux(
    "list-panes",
    "-s",
    "-t",
    SESSION,
    "-F",
    `#{pane_id}\t#{pane_dead}\t#{pane_index}\t#{${SHELL_TAG}}`,
  );
  for (const line of out.split("\n").filter(Boolean)) {
    const [id, dead, index, tag] = line.split("\t");
    if (tag) return { id, dead: dead === "1", index: Number(index) };
  }
  return undefined;
}

/**
 * Applies the stack window's look: panes surviving process exit, click-to-focus, and titled
 * heavy borders in the palm-neon palette — hot pink marks the active pane, cyan the index,
 * violet the idle panes.
 */
async function styleWindow(): Promise<void> {
  await tmux("set-option", "-t", TARGET, "-w", "remain-on-exit", "on");
  await tmux("set-option", "-t", SESSION, "mouse", "on");
  await tmux("set-option", "-t", TARGET, "-w", "pane-border-status", "top");
  await tmux("set-option", "-t", TARGET, "-w", "pane-border-lines", "heavy");
  await tmux(
    "set-option",
    "-t",
    TARGET,
    "-w",
    "pane-border-style",
    "fg=colour55",
  );
  await tmux(
    "set-option",
    "-t",
    TARGET,
    "-w",
    "pane-active-border-style",
    "fg=colour198,bold",
  );
  await tmux(
    "set-option",
    "-t",
    TARGET,
    "-w",
    "pane-border-format",
    " #[fg=colour51][#{pane_index}]#[default] #{?pane_active,#[fg=colour51#,bold]▶,#[fg=colour99]·}" +
      " #[fg=colour198,bold]#{pane_title}#[fg=colour135] :~$#[default] ",
  );
}

async function windowExists(): Promise<boolean> {
  const out = await tmux("list-windows", "-t", SESSION, "-F", "#{window_name}");
  return out.split("\n").includes(WINDOW);
}
