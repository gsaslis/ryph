import { browser } from "$app/environment";

/** The tabs of a run's details pane. */
export type RunPaneTab = "actions" | "browser" | "commands" | "subagents" | "details" | "usage";

const KEY = "ryph:run-pane-tab";
const TABS: readonly string[] = ["actions", "browser", "commands", "subagents", "details", "usage"];

function stored(): RunPaneTab {
  if (!browser) return "actions";
  try {
    const tab = localStorage.getItem(KEY);
    return tab !== null && TABS.includes(tab) ? tab as RunPaneTab : "actions";
  } catch {
    // Storage blocked: the default it is.
    return "actions";
  }
}

/**
 * The tab the reader last opened in a run's details pane. Kept from one task to the next, and
 * across visits: someone going through runs for their usage, or their browsers, stays on that tab.
 * Only ever written by a click, so only in the browser.
 */
class RunPaneTabState {
  current = $state<RunPaneTab>(stored());

  set = (tab: string) => {
    if (!TABS.includes(tab)) return;
    this.current = tab as RunPaneTab;
    try {
      localStorage.setItem(KEY, tab);
    } catch {
      // A convenience; nothing to do without it.
    }
  };
}

export const runPaneTab = new RunPaneTabState();
