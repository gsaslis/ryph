import { getContext, setContext } from "svelte";
import type { Subagent } from "$lib/utils/subagents";

// The run's subagents as the page holds them, for the transcript: a subagent call, or the notice
// of one's end, names the subagent as the Subagents tab lists it, and opens it there. A page
// without a Subagents tab sets nothing, and those rows read on their own.

const KEY = Symbol("subagents");

export interface SubagentsContext {
  /** The subagent by id, as the tab lists it; undefined for one the page does not hold. */
  subagent(id: string): Subagent | undefined;
  /** Opens the subagent in the Subagents tab, opening the pane (or its sheet) too. */
  open(id: string): void;
}

export function setSubagentsContext(context: SubagentsContext): void {
  setContext(KEY, context);
}

export function getSubagentsContext(): SubagentsContext | undefined {
  return getContext<SubagentsContext | undefined>(KEY);
}
