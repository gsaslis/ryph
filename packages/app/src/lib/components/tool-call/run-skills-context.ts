import { getContext, setContext } from "svelte";
import type { RunSkillsView } from "$lib/utils/skills";

// The skills a page's run holds, so a read of one in the transcript can say it loaded that skill
// rather than show a temp path. A page that holds no run sets nothing, and those reads stay reads.

const KEY = Symbol("run-skills");

export function setRunSkillsContext(held: () => RunSkillsView | null): void {
  setContext(KEY, held);
}

export function getRunSkillsContext(): (() => RunSkillsView | null) | undefined {
  return getContext<(() => RunSkillsView | null) | undefined>(KEY);
}
