/** What the new-task page last started with, remembered per browser to start there next time. */
export type LastPicks = {
  agentId: string | null;
  source: "repo" | "workspace" | null;
  connectedRepoId: string | null;
  workspaceId: string | null;
};

const KEY = "ryph:new-task:last-picks";

const NONE: LastPicks = { agentId: null, source: null, connectedRepoId: null, workspaceId: null };

/** Reads what was stored, taking only what has the right shape. Anything else is nothing. */
export function parseLastPicks(raw: string | null): LastPicks {
  if (raw === null) return NONE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (typeof value !== "object" || value === null) return NONE;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" ? record[key] as string : null;
  const source = record.source === "repo" || record.source === "workspace" ? record.source : null;
  return {
    agentId: text("agentId"),
    source,
    connectedRepoId: text("connectedRepoId"),
    workspaceId: text("workspaceId"),
  };
}

/** Storage can be missing or refuse (a private window, blocked site data): then nothing is known. */
export function readLastPicks(): LastPicks {
  try {
    return parseLastPicks(localStorage.getItem(KEY));
  } catch {
    return NONE;
  }
}

export function rememberLastPicks(picks: LastPicks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(picks));
  } catch {
    // Not remembered; next time starts from scratch.
  }
}
