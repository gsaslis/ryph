/**
 * The seam between the verbs and whatever holds the stack's processes.
 * Verbs only speak this interface; the process runtime behind it is an implementation detail.
 */

import type { Unit } from "./stack.ts";

export interface PaneState {
  /** True when the unit's process has exited but its output is still on display. */
  dead: boolean;
}

export interface StackBackend {
  /** Gets the observed state of every unit the backend currently holds. */
  list(): Promise<Map<string, PaneState>>;
  /**
   * Launches a unit's task and wires its output to `logPath(unit.name)`, starting a fresh log.
   * A unit that already has a display slot is relaunched in place (its slot and scrollback
   * survive); any process still running there is killed first.
   */
  start(unit: Unit): Promise<void>;
  /** Stops a unit, tearing down its process and display. */
  stop(name: string): Promise<void>;
  /** Opens the interactive stack view, focused on a unit when given; throws when nothing runs. */
  attach(unit?: string): Promise<void>;
  /**
   * Ensures the board's console fixture — an interactive shell pane for driving the CLI from
   * inside the view. Not a unit: `list` never reports it. No-op when the board doesn't exist.
   */
  ensureShell(): Promise<void>;
  /** Removes the console fixture, if present. */
  removeShell(): Promise<void>;
  /**
   * Reorders the display to the given unit order; units not present are ignored and the
   * console fixture always takes the last slot.
   */
  arrange(order: string[]): Promise<void>;
  /** Gets the absolute path of a unit's log file. */
  logPath(name: string): string;
}
