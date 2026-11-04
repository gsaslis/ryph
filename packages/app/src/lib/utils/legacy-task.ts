// Tasks from before every task checked out a connected repo: an entry with no connected repo.
// They still open and read as they did; anything that needs the repo is off for them.

/** Whether the task checks out a repo that was never connected. */
export function isLegacyTask(task: { repos: ReadonlyArray<{ connectedRepoId: string | null }> }) {
  return task.repos.some((repo) => repo.connectedRepoId === null);
}

/** What the re-run button says instead, for such a task. */
export const LEGACY_RERUN = "This task's repository isn't connected, so it can't be re-run.";

/** What a task that stopped before its first message says instead of offering to start again. */
export const LEGACY_START_AGAIN =
  "This task's repository isn't connected, so it can't be started again.";
