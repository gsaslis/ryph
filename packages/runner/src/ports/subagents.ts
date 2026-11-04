// Where a subagent's agent process comes from — a DRIVEN port, like the harness: the core decides
// when a stretch of a subagent's work starts and ends (core/subagents.ts), and an adapter turns
// that into a process of its CLI (pi: a second `pi --mode rpc` on a session of its own,
// adapters/subagents/pi.ts) and its output into transcript chunks.
//
// Invariants an adapter keeps:
// - a stretch is ONE process, from `start` until `ended` resolves; it is never left waiting for
//   a prompt: once the agent settles it is stopped, and a continuation is a new process on the
//   same session
// - `onSettled` is called at most once per stretch, synchronously, from the moment the agent's
//   turn is over with nothing handed to it still unread — and from that moment `steer` refuses.
//   That is what makes a message either a steer or a continuation, never lost in between: the
//   core decides which on the same tick the settle is seen
// - `stop` ends the agent's whole process tree, whatever its tools started, and resolves once
//   the agent's process has exited; it never throws
// - the child holds a subset of the run's tools: never the runner's own (no loopback), never the
//   browser

import type { TranscriptChunk } from "../core/types.ts";
import type { HarnessTools } from "./harness.ts";
import type { SubagentMode } from "./run_actions.ts";

/** What every subagent of a run is started in: the run's own checkout and description of it. */
export interface SubagentContext {
  /** The checkout root: where the child starts, every stretch (its session is found there). */
  checkoutDir: string;
  /** The run's layout block, as the parent's prompt has it (ports/harness.ts), and its machine
   * block as a subagent reads it: the machine's facts without the run's standing ones. */
  layout: string;
  machine: string;
  /** Kept off the egress proxy, as for the parent (ports/harness.ts `serviceHosts`). */
  serviceHosts: string[];
  /** The run's gateway servers; the loopback and the browser are never handed on. Absent: none. */
  tools?: Pick<HarnessTools, "servers" | "tokenEnv">;
}

export interface SubagentStretchRequest {
  /** `sa-<n>`: names the child's session, so a continuation finds it. */
  id: string;
  mode: SubagentMode;
  /** The stretch's opening prompt, already framed by the core: the task, or the parent's
   * message that continues it. */
  prompt: string;
  context: SubagentContext;
}

export interface SubagentStretchEvents {
  /** The child's transcript, chunk by chunk, in its order. */
  onTranscript(chunk: TranscriptChunk): void;
  /** A steer was handed to the model, by the prompt `steer` was given. */
  onSteerDelivered(prompt: string): void;
  /** The child's turn is over: called at most once, see the header. */
  onSettled(): void;
}

/** How a stretch's process ended. */
export interface SubagentStretchEnd {
  /** The last assistant message with text: the answer. Empty when it said nothing. */
  answer: string;
  /** Whether its turn settled before the process ended. */
  settled: boolean;
  /** Why it ended without settling, when it did and nobody stopped it (pi exited, say). */
  error: string | null;
}

export interface SubagentStretch {
  /** Hands the child `prompt` while it works, delivered after its current tool call. False once
   * it has settled or is being stopped: it is then continued instead. */
  steer(prompt: string): boolean;
  /** The tool running now, by name, or null: what a stop or a timeout interrupted. */
  runningTool(): string | null;
  /** Abort first, a short wait for the agent to settle, then its whole process tree killed;
   * resolves once its process has exited. Idempotent. */
  stop(): Promise<void>;
  /** Resolves once the process has exited and its tree is gone, however it ended. */
  readonly ended: Promise<SubagentStretchEnd>;
}

export interface SubagentHost {
  /** Starts one stretch on `id`'s session, creating the session when it has none. Throws when
   * no process could be started. */
  start(request: SubagentStretchRequest, events: SubagentStretchEvents): Promise<SubagentStretch>;
  /** Whether `id`'s session is still there to continue: false once the runner's temp dir is
   * gone, or for a subagent whose first stretch never started. */
  hasSession(id: string): Promise<boolean>;
  /** Removes the sessions and every child's config. Idempotent; never throws. */
  close(): Promise<void>;
}
