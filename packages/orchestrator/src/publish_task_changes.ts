// A composition helper: wraps a TaskStore so a task whose row moved announces itself on the
// task feed, which is what the list's live tails are watching. The sibling of
// conclude_on_terminal.ts, and the same argument for putting it here.
//
// THE STORE IS THE CHOKE POINT ON PURPOSE. A task appears when `createTask` lands and moves when
// `saveRunTransition`, `markRunAttended`, `claimTaskPrompt` or `retitleTask` lands — every path that changes what a list row says has to
// persist it to make it real, so one wrapper catches all of them and no path added later can
// forget to announce itself. The core stays unaware that anybody is watching.
//
// The announcement fires AFTER the write, so a tail that reads the row on hearing it reads the
// new one.

import { type GitVirtualKey, type Run, type Task, TERMINAL_STATES } from "./core/types.ts";
import { idleStateOf } from "./core/run_activity.ts";
import type { TaskFeed } from "./ports/task_feed.ts";
import type { TaskStore } from "./ports/task_store.ts";

/**
 * What a list row shows of a run. A heartbeat rewrites the run row every few seconds and almost
 * always says the same two things; announcing those would wake every open tail, which would read
 * every task, to send frames that change nothing on screen.
 */
function rowFacts(run: Run): string {
  return `${run.state}|${run.phase ?? ""}|${run.attended}|${idleStateOf(run) ?? ""}|${
    run.declaredOutcome ?? ""
  }`;
}

/**
 * How many runs' facts one process remembers for the heartbeat filter.
 *
 * It needs a cap because the obvious pruning is not enough. A run's entry is dropped when THIS
 * replica writes its terminal state — but on a deployment with peers, the replica that started
 * a run is often not the one that finishes it, and the entry it holds is then never claimed by
 * anything. Generous, because the only cost of forgetting a live run early is one extra frame
 * that says what the list already shows; the cost of remembering every run forever is a process
 * that grows for as long as it stays up.
 */
const ANNOUNCED_LIMIT = 10_000;

export function publishTaskChanges(inner: TaskStore, feed: TaskFeed): TaskStore {
  // The last facts announced per run — the heartbeat filter. Held in insertion order and capped
  // at ANNOUNCED_LIMIT, oldest evicted first; an entry is also dropped outright when this
  // process writes the run's terminal state.
  const announced = new Map<string, string>();

  /** Re-set moves the entry to the TAIL, so eviction takes the least recently written run. */
  const remember = (runId: string, facts: string): void => {
    announced.delete(runId);
    announced.set(runId, facts);
    if (announced.size > ANNOUNCED_LIMIT) {
      const oldest = announced.keys().next();
      if (!oldest.done) announced.delete(oldest.value);
    }
  };

  const announce = (run: Run, taskId: string): void => {
    const facts = rowFacts(run);
    if (announced.get(run.id) === facts) return;
    // A run that is over cannot move again, so remembering its facts would only leak — and a
    // duplicate write of a terminal run costs one extra frame that says what the list already
    // shows. This is the tidy path out of the map; the cap above is the one that catches every
    // run whose ending some other replica wrote.
    if (TERMINAL_STATES.has(run.state)) announced.delete(run.id);
    else remember(run.id, facts);
    feed.publish(taskId);
  };

  return {
    ...inner,
    async createTask(
      task: Task,
      run: Run,
      gitKey?: GitVirtualKey,
      opts?: { maxLive: number | null },
    ): Promise<"created" | "full"> {
      const created = await inner.createTask(task, run, gitKey, opts);
      if (created === "created") {
        remember(run.id, rowFacts(run));
        feed.publish(task.id);
      }
      return created;
    },
    async saveRunTransition(run, expected) {
      const landed = await inner.saveRunTransition(run, expected);
      if (landed) announce(landed, landed.taskId);
      return landed;
    },
    async saveRunResult(run) {
      const landed = await inner.saveRunResult(run);
      if (landed) announce(landed, landed.taskId);
      return landed;
    },
    async requestRunCancel(runId, at, guard) {
      const outcome = await inner.requestRunCancel(runId, at, guard);
      if (outcome.applied && outcome.run) announce(outcome.run, outcome.run.taskId);
      return outcome;
    },
    async recordRunLaunch(runId, handle, launchedAt) {
      const landed = await inner.recordRunLaunch(runId, handle, launchedAt);
      // As saveRunIfUnlaunched did before it: the facts filter decides whether it is news.
      if (landed) announce(landed, landed.taskId);
      return landed;
    },
    async saveHeartbeat(run: Run) {
      const landed = await inner.saveHeartbeat(run);
      // The first beat moves a run from `starting` to `running`, and a phase change is on screen;
      // the facts filter drops the rest, as it does for saveRun.
      if (landed) announce(run, run.taskId);
      return landed;
    },
    async saveRunIfWaiting(run: Run, environmentId: string): Promise<boolean> {
      const landed = await inner.saveRunIfWaiting(run, environmentId);
      // Only the caller whose claim landed announces. The others wrote nothing, and this write
      // moves `state` out of `starting` — refused, lost, launching — which is the single most
      // visible thing a list row says, so it must not fall through the spread silently.
      if (landed) {
        const stored = await inner.getRun(run.id);
        if (stored !== null) announce(stored, stored.taskId);
      }
      return landed;
    },
    async saveRunIfUnlaunched(run: Run): Promise<boolean> {
      const landed = await inner.saveRunIfUnlaunched(run);
      // As saveRunIfWaiting: only a write that landed is news, read as it actually persisted.
      if (landed) {
        const stored = await inner.getRun(run.id);
        if (stored !== null) announce(stored, stored.taskId);
      }
      return landed;
    },
    async retitleTask(taskId: string, from: string, to: string): Promise<boolean> {
      const moved = await inner.retitleTask(taskId, from, to);
      // A title is on every list row: the generated one replacing the fallback is the frame
      // that makes the sidebar show it without a reload.
      if (moved) feed.publish(taskId);
      return moved;
    },
    async claimTaskPrompt(
      prompt: { taskId: string; instructions: string; title: string },
      message: Parameters<TaskStore["claimTaskPrompt"]>[1],
    ) {
      const claimed = await inner.claimTaskPrompt(prompt, message);
      // The prompt gives the row its first title and ends its wait for one.
      if (claimed.kind === "claimed") feed.publish(prompt.taskId);
      return claimed;
    },
    async markRunAttended(runId: string, at: string) {
      const outcome = await inner.markRunAttended(runId, at);
      // Only the write that actually flipped it announces: a second person speaking to a run
      // already marked attended changed nothing a list shows.
      if (outcome.flipped && outcome.run !== null) announce(outcome.run, outcome.run.taskId);
      return outcome;
    },
  };
}
