// Moving one repo of a checkout onto another branch, in whichever list holds it: the task's
// entries and the run's frozen spec are separate lists, written in their own spellings, and the
// two moves that change where a repo stands — a mid-run re-target onto a change request
// (core/retarget.ts) and the landing of one that merged (core/landing.ts) — must touch
// the same field the same way in both. Pure.

/** `entry` on `ref`, its `targetRef` replaced, or dropped when `targetRef` is undefined. Every
 * other field as it was — `forkHead` too: a run that started on a fork's head has run the
 * contributor's code, and landing on a branch of the repo afterwards does not undo that
 * (`worksForkHead`). */
export function rebased<T extends { ref: string; targetRef?: string }>(
  entry: T,
  ref: string,
  targetRef: string | undefined,
): T {
  const { targetRef: _old, ...rest } = entry;
  return { ...rest, ref, ...(targetRef === undefined ? {} : { targetRef }) } as T;
}

/**
 * Whether a task's checkout holds a fork pull request's head (`RepoEntry.forkHead`) — the one
 * question every rule confining such a run asks: what the run does is as much the contributor's
 * as the agent's, so it reads the commanded repo, writes in its own thread, and delivers onto
 * that pull request or nowhere (core/reaper.ts, core/forge_tools.ts, core/artifacts.ts, the
 * runner API's re-target).
 */
export function worksForkHead(repos: ReadonlyArray<{ forkHead?: boolean }>): boolean {
  return repos.some((r) => r.forkHead === true);
}

/** `entries` with the one at `path` moved by `move`; every other entry as it was. */
export function movedAt<T extends { path: string }>(
  entries: T[],
  path: string,
  move: (entry: T) => T,
): T[] {
  return entries.map((entry) => (entry.path === path ? move(entry) : entry));
}
