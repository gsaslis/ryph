// The wait for a prompt: a run whose task was started without instructions boots its sandbox
// completely — clones, setup, services, the browser — and then waits here for the first message,
// which IS its task (the control plane stored it as the task's instructions; see
// @ryph/orchestrator core/prompt.ts). Nothing starts the harness before it.
//
// Invariants:
// - the first message the inbox holds is the prompt: the control plane refuses every other
//   message to a run awaiting one, so nothing can be ahead of it. A message sent while the run was
//   still booting waits in the inbox, and is read here the moment the run is ready
// - the wait is on the attended idle clock (`lifetime.attendedIdleMs`): the person who started
//   the task is there, writing it. It is reported like a settled agent's deadline so the control
//   plane's reaper backstops it: a task nobody prompts ends
// - polling is best-effort, as the conversation's is: an inbox that cannot be asked is asked again
//   after a pause, until the deadline or a cancel
// - the prompt never reaches the agent as a message: it is the task, framed as a task is

import type { InboundMessage, TaskSpec } from "./types.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { Inbox } from "../ports/inbox.ts";
import { neutraliseImageLines } from "./images.ts";

/** How long one poll may hold — the conversation's own bound. */
const POLL_WAIT_MS = 25_000;
const POLL_RETRY_PAUSE_MS = 1_000;
/** The longest commit subject a prompt's first line becomes. */
const SUBJECT_CHARS = 72;

export interface AwaitPromptDeps {
  inbox: Inbox;
  /** How long the run waits for its prompt: the attended idle clock. */
  idleMs: number;
  signal: AbortSignal;
  diag: Diagnostics;
  /** The deadline the wait ends at, reported once as it starts. */
  onIdleDeadline(deadlineAt: string): void;
  /** Tests shrink these. */
  pollWaitMs?: number;
  retryPauseMs?: number;
  now?: () => number;
}

export type PromptWait =
  | { kind: "prompt"; message: InboundMessage }
  | { kind: "idle" }
  | { kind: "cancelled" };

/** Waits for the run's first message, until the idle deadline or a cancel. */
export async function awaitPrompt(deps: AwaitPromptDeps): Promise<PromptWait> {
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deps.idleMs;
  try {
    deps.onIdleDeadline(new Date(deadline).toISOString());
  } catch (err) {
    deps.diag.warn("prompt.deadline_report_failed", { err });
  }
  deps.diag.debug("prompt.waiting", { deadlineAt: new Date(deadline).toISOString() });
  while (!deps.signal.aborted) {
    const left = deadline - now();
    if (left <= 0) return { kind: "idle" };
    let batch: InboundMessage[];
    try {
      batch = await deps.inbox.poll(-1, {
        waitMs: Math.min(deps.pollWaitMs ?? POLL_WAIT_MS, left),
        signal: deps.signal,
      });
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.diag.warn("prompt.poll_failed", { err: String(err) });
      await pause(Math.min(deps.retryPauseMs ?? POLL_RETRY_PAUSE_MS, left), deps.signal);
      continue;
    }
    const first = [...batch].sort((a, b) => a.seq - b.seq)[0];
    if (first !== undefined) return { kind: "prompt", message: first };
  }
  return { kind: "cancelled" };
}

/**
 * The task the prompt is, as a task is handed to the harness: its words with every image it
 * carries named — `(attached: [image 1] …)` after them for any the text does not mark, the way
 * the control plane stored them as the task's instructions — and a commit subject from its first
 * line with words.
 */
export function promptSpec(message: Pick<InboundMessage, "text" | "attachments">): TaskSpec {
  const text = message.text.trim();
  const missing: string[] = [];
  for (let n = 1; n <= message.attachments.length; n++) {
    if (!text.includes(`[image ${n}]`)) missing.push(`[image ${n}]`);
  }
  const instructions = (missing.length === 0 ? text : `${text}\n\n(attached: ${missing.join(" ")})`)
    .trim();
  return { title: promptSubject(text), instructions: neutraliseImageLines(instructions) };
}

/** The first line with words, markers and leading markdown dropped, cut at a word. */
export function promptSubject(text: string): string {
  const line = text.split(/\r?\n/)
    .map((l) =>
      l.replace(/\[\s*image\s*\d+\s*\]/gi, " ").replace(/^[\s#>*+\-]+/, "").replace(/\s+/g, " ")
        .trim()
    )
    .find((l) => l !== "");
  if (line === undefined) return "Task";
  if (line.length <= SUBJECT_CHARS) return line;
  const cut = line.slice(0, SUBJECT_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space >= SUBJECT_CHARS / 2 ? cut.slice(0, space) : cut).trim();
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
