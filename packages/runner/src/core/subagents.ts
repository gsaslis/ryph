// The agent's subagents (`ryph__subagent_start`): a piece of work handed to a second agent in the
// same container, with a fresh context, a narrower set of tools and a bounded answer
// People watch each one in a lane of the run's history of its own.
//
// A subagent never idles. Its process lives only while it works — a STRETCH of its work — and
// between stretches it is a session on disk, not a process: its turn settling is the end of the
// stretch (its last message is its answer), and the agent's next message to it starts a new
// process on the same session, which picks up with everything it had read and said. The agent
// waits for one by ending its turn: each stretch's end reaches it as a platform message.
//
// Invariants:
// - nothing here can fail the run: a subagent that cannot start is a refusal the agent reads,
//   and every later failure is that subagent's end (`failed`) or a diag line
// - ids are minted here (`sa-<n>`, n from 1), and are the lane names; nothing the agent passes
//   names a path or a lane
// - at most SUBAGENT_MAX_RUNNING stretches run at once and SUBAGENT_MAX_STARTED subagents start
//   in a run; a continuation counts toward the first, never the second, and is refused like a
//   start when there is no room. A stretch takes its slot on the tick its cap is checked
//   (`reserve`), before any await, so no two asks can both see the last slot free
// - one stretch is one process, and a subagent has at most one at a time: a message is either a
//   steer handed to the stretch that runs, or — once that stretch's process has exited — the
//   opening of the next; never lost between the two, never a second process on one session.
//   The adapter's settle flips `steer` to refusing on the very tick it is seen, and every
//   message and start of one subagent runs under its lock (`withLock`), so which one it is is
//   decided once, in order
// - every stretch ends with its process tree gone, and is told in the lane exactly once
//   (`subagent.end`), after its `subagent.start` or `subagent.resume`
// - a stretch ends at its wall clock at the latest (`timeout`); a running one holds the idle
//   deadline until it can no longer be running (its wall clock plus the stop's own bound)
// - the agent is told of every stretch's end once, as a platform message carrying how it ended
//   and its answer — an answer, a timeout, a failure — but for a stretch the agent asked to stop:
//   the stop's own answer tells of it (with the answer, when it had answered just before), and
//   nothing follows. The run's own end tells nobody
// - the runner continues any subagent it started: when its session is not on disk (its first
//   process died before pi took the task), the continuation starts a fresh one from the task
// - once `stopAll` has begun nothing new starts or continues, and it resolves once every
//   stretch has ended (bounded)

import type { SubagentNoticeMessage, TranscriptChunk } from "./types.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type {
  SubagentContext,
  SubagentHost,
  SubagentStretch,
  SubagentStretchEnd,
} from "../ports/subagents.ts";
import {
  SUBAGENT_ANSWER_MAX_BYTES,
  SUBAGENT_LABEL_MAX,
  SUBAGENT_MAX_RUNNING,
  SUBAGENT_MAX_STARTED,
  SUBAGENT_TEXT_MAX_BYTES,
  SUBAGENT_TIMEOUT_DEFAULT_MINUTES,
  SUBAGENT_TIMEOUT_MAX_MINUTES,
  SUBAGENT_TIMEOUT_MIN_MINUTES,
  type SubagentAnswer,
  type SubagentEndReason,
  type SubagentMessageOutcome,
  type SubagentMode,
  type SubagentStartArgs,
  type SubagentStartOutcome,
  type SubagentStopOutcome,
  type SubagentView,
} from "../ports/run_actions.ts";
import { errorMessage } from "../helpers/errors.ts";
import { clip, clipBytes, utf8Bytes, within } from "../helpers/bounds.ts";
import { shownText } from "./output_stream.ts";
import { formatDuration } from "./background.ts";

const MINUTE_MS = 60_000;
/** How long past its wall clock a stretch can still be running: the adapter's abort wait and
 * its kill, with room to reap. */
const HOLD_SLACK_MS = 30_000;
/** How long `stopAll` waits for every stretch to end. */
const STOP_ALL_BOUND_MS = 30_000;
/** The most of a task or a message a lane's payload carries, in characters: well under the
 * emitter's payload cap, so the row is never reduced to a stub that drops it. The child is
 * handed the whole of it either way. */
const LANE_TEXT_CHARS = 12_000;
/** What the emitter takes as one payload, serialized; a lane row is fitted under it. */
const LANE_PAYLOAD_CHARS = 30_000;

const SUBAGENT_ID = /^sa-[1-9][0-9]{0,3}$/;
/** What a label may not hold: line breaks, control characters, runs of space. */
// oxlint-disable-next-line no-control-regex
const LABEL_BREAKS = /[\x00-\x1f\x7f\s]+/g;

/** Who a subagent hears from, in its own prompts: the agent that started it. */
const FROM_PARENT = "A message from the agent that handed you your task:";

export interface SubagentsDeps {
  diag: Diagnostics;
  /** Where the child processes come from. Absent: this run's agent cannot start subagents (a
   * harness with no child of its own), and every tool says so. */
  host?: SubagentHost;
  /** What every child starts in, once the harness has been given it; null before. */
  context(): SubagentContext | null;
  /** One chunk of a subagent's lane: the lane is its id. */
  narrate(lane: string, chunk: TranscriptChunk): void;
  /** A stretch's end the agent did not stop: the agent is told. False if not delivered. */
  notice(message: SubagentNoticeMessage): boolean;
  /** What `holdUntil` answers changed. */
  holdChanged(): void;
  now?: () => number;
  /** Tests shrink these. */
  minuteMs?: number;
  stopAllBoundMs?: number;
}

export interface Subagents {
  start(args: SubagentStartArgs): Promise<SubagentStartOutcome>;
  message(args: { id: string; text: string }): Promise<SubagentMessageOutcome>;
  stop(id: string): Promise<SubagentStopOutcome>;
  /** How many stretches are running now. */
  running(): number;
  /** The latest a running stretch can still be running, or null: the idle deadline is never
   * earlier. */
  holdUntil(): number | null;
  /** Stops every running stretch (`run_ended`) and refuses new ones; resolves once all have
   * ended (bounded). Idempotent. */
  stopAll(): Promise<void>;
  /** `stopAll`, then the host's sessions removed. Idempotent. */
  close(): Promise<void>;
}

interface Stretch {
  startedAt: number;
  timeoutAt: number;
  /** The process, once the host has started it. */
  process: SubagentStretch | null;
  /** The ending asked for, once one was: the settle's `answered` or a stop's reason. The first
   * one asked for is the one recorded. */
  ending: SubagentEndReason | null;
  /** The tool a stop or a timeout interrupted. */
  tool: string | null;
  /** Steers handed over and not yet delivered, by the prompt they went as: the agent's text. */
  steers: Map<string, string[]>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The agent asked to stop it: its end is told by that stop's answer, never a notice. */
  stopAsked: boolean;
  /** Resolves once the stretch's end is recorded and told. */
  done: Promise<void>;
  resolve: () => void;
}

interface Ended {
  at: number;
  reason: SubagentEndReason;
  /** All of its last message: the lane has it whole, the agent gets it capped. */
  answer: string;
  tool: string | null;
  error: string | null;
  startedAt: number;
}

interface Subagent {
  id: string;
  label: string;
  mode: SubagentMode;
  /** As the agent gave it: what a fresh session starts from again. */
  task: string;
  timeoutMinutes: number;
  stretches: number;
  stretch: Stretch | null;
  last: Ended | null;
  /** Every message and start of this subagent, each after the one before. */
  lock: Promise<unknown>;
}

export function startSubagents(deps: SubagentsDeps): Subagents {
  const now = deps.now ?? (() => Date.now());
  const minuteMs = deps.minuteMs ?? MINUTE_MS;
  const stopAllBoundMs = deps.stopAllBoundMs ?? STOP_ALL_BOUND_MS;
  const subagents: Subagent[] = [];
  let stopping: Promise<void> | null = null;

  const iso = (ms: number) => new Date(ms).toISOString();
  const runningOnes = () => subagents.filter((sa) => sa.stretch !== null);

  const narrate = (sa: Subagent, chunk: TranscriptChunk) => {
    try {
      deps.narrate(sa.id, chunk);
    } catch (err) {
      deps.diag.warn("subagents.narrate_failed", { id: sa.id, err });
    }
  };
  const holdChanged = () => {
    try {
      deps.holdChanged();
    } catch (err) {
      deps.diag.warn("subagents.hold_changed_failed", { err });
    }
  };
  /** `step` after every earlier step of this subagent; a failure is the step's caller's. */
  const withLock = <T>(sa: Subagent, step: () => Promise<T>): Promise<T> => {
    const next = sa.lock.then(step);
    sa.lock = next.catch(() => {});
    return next;
  };

  const view = (sa: Subagent): SubagentView => {
    const stretch = sa.stretch;
    const startedAt = stretch?.startedAt ?? sa.last?.startedAt ?? now();
    return {
      id: sa.id,
      label: sa.label,
      mode: sa.mode,
      stretches: sa.stretches,
      startedAt: iso(startedAt),
      ended: stretch !== null || sa.last === null ? null : {
        at: iso(sa.last.at),
        reason: sa.last.reason,
        tool: sa.last.tool,
        error: sa.last.error,
      },
      timeoutMinutes: sa.timeoutMinutes,
      durationMs: (stretch === null ? sa.last?.at ?? now() : now()) - startedAt,
    };
  };

  const find = (id: unknown): Subagent | { reason: string } => {
    const sa = typeof id === "string" && SUBAGENT_ID.test(id)
      ? subagents.find((s) => s.id === id)
      : undefined;
    if (sa !== undefined) return sa;
    const known = subagents.map((s) => s.id).join(", ");
    return {
      reason: `There is no subagent ${JSON.stringify(clip(String(id), 40))} in this run; ${
        known === "" ? "none has been started" : `it has ${known}`
      }.`,
    };
  };

  /** A stretch's slot, taken on the tick its cap was checked: it counts as running from here. */
  const reserve = (sa: Subagent): Stretch => {
    const startedAt = now();
    let resolve!: () => void;
    const stretch: Stretch = {
      startedAt,
      timeoutAt: startedAt + sa.timeoutMinutes * minuteMs,
      process: null,
      ending: null,
      tool: null,
      steers: new Map(),
      timer: undefined,
      stopAsked: false,
      done: new Promise<void>((r) => (resolve = r)),
      resolve: () => resolve(),
    };
    sa.stretch = stretch;
    sa.stretches++;
    holdChanged();
    return stretch;
  };

  /**
   * A reserved stretch, from its process's start to its end told. Throws when the host could not
   * start a process; the stretch is then already ended (`failed`), told in the lane.
   */
  const launch = async (sa: Subagent, stretch: Stretch, prompt: string): Promise<void> => {
    const startedAt = stretch.startedAt;
    let process: SubagentStretch;
    try {
      process = await deps.host!.start({
        id: sa.id,
        mode: sa.mode,
        prompt,
        context: deps.context()!,
      }, {
        onTranscript: (chunk) => narrate(sa, chunk),
        onSteerDelivered: (handed) => {
          const queued = stretch.steers.get(handed);
          const message = queued?.shift();
          if (queued !== undefined && queued.length === 0) stretch.steers.delete(handed);
          if (message === undefined) return;
          narrate(sa, {
            kind: "subagent.message",
            text: message,
            raw: lanePayload({ id: sa.id, message: shownText(message) }, "message"),
          });
        },
        onSettled: () => {
          // A settle is an end: its answer is in, and its process is stopped.
          stretch.ending ??= "answered";
          void stretch.process?.stop();
        },
      });
    } catch (err) {
      deps.diag.warn("subagents.start_failed", { id: sa.id, err: errorMessage(err) });
      // The tool's answer says so: no notice besides.
      close(sa, stretch, { answer: "", settled: false, error: errorMessage(err) }, false);
      throw err;
    }
    stretch.process = process;
    // A stop or a settle asked for while the process was starting.
    if (stretch.ending !== null) void process.stop();
    stretch.timer = setTimeout(() => {
      stretch.timer = undefined;
      if (stretch.ending !== null) return;
      deps.diag.debug("subagents.timed_out", { id: sa.id });
      stretch.ending = "timeout";
      stretch.tool = process.runningTool();
      void process.stop();
    }, stretch.timeoutAt - startedAt);
    void process.ended
      .catch((err): SubagentStretchEnd => ({
        answer: "",
        settled: false,
        error: errorMessage(err),
      }))
      .then((end) => close(sa, stretch, end));
  };

  /** A stretch's end: recorded, told in the lane, told to the waits, and to the agent when it
   * asked for none of it (and `tell`). */
  const close = (sa: Subagent, stretch: Stretch, end: SubagentStretchEnd, tell = true) => {
    if (stretch.timer !== undefined) clearTimeout(stretch.timer);
    stretch.timer = undefined;
    const reason = stretch.ending ?? (end.settled ? "answered" : "failed");
    const at = now();
    sa.last = {
      at,
      reason,
      answer: end.answer.trim(),
      tool: stretch.tool,
      error: reason === "failed" ? end.error ?? "its process ended without an answer" : null,
      startedAt: stretch.startedAt,
    };
    sa.stretch = null;
    deps.diag.debug("subagents.ended", { id: sa.id, reason, ms: at - stretch.startedAt });
    narrate(sa, {
      kind: "subagent.end",
      raw: {
        id: sa.id,
        reason,
        answerChars: sa.last.answer.length,
        durationMs: at - stretch.startedAt,
      },
    });
    holdChanged();
    stretch.resolve();
    // Told of every end but one it asked to stop, which that stop answers; and only while the
    // run goes on.
    const told = reason === "answered" || reason === "timeout" || reason === "failed";
    if (tell && told && !stretch.stopAsked && stopping === null) {
      try {
        const delivered = deps.notice(noticeOf(sa, view(sa), sa.last));
        if (!delivered) deps.diag.debug("subagents.notice_dropped", { id: sa.id });
      } catch (err) {
        deps.diag.warn("subagents.notice_failed", { id: sa.id, err });
      }
    }
  };

  /** Why a subagent cannot be started or continued now, or null. */
  const unavailable = (): string | null => {
    if (stopping !== null) return ENDING;
    if (deps.host === undefined) return "This run's agent cannot start subagents.";
    if (deps.context() === null) return "The run has not started its agent yet.";
    return null;
  };

  /** Asks a running stretch to end, and resolves once it has. */
  const end = (stretch: Stretch, reason: SubagentEndReason): Promise<void> => {
    if (stretch.ending === null) {
      stretch.ending = reason;
      stretch.tool = stretch.process?.runningTool() ?? null;
    }
    void stretch.process?.stop();
    return stretch.done;
  };

  const stopAll = (): Promise<void> => {
    stopping ??= (async () => {
      const left = runningOnes();
      if (left.length === 0) return;
      deps.diag.debug("subagents.stopping_all", { ids: left.map((sa) => sa.id) });
      const ended = Promise.all(left.map((sa) => end(sa.stretch!, "run_ended")));
      if (!(await within(ended, stopAllBoundMs))) {
        deps.diag.warn("subagents.stop_all_unfinished", { ids: runningOnes().map((s) => s.id) });
      }
    })();
    return stopping;
  };

  return {
    async start(args) {
      const blocked = unavailable();
      if (blocked !== null) return refused(blocked);
      if (typeof args.task !== "string" || args.task.trim() === "") {
        return refused("task must be the whole brief for the subagent, as text.");
      }
      if (utf8Bytes(args.task) > SUBAGENT_TEXT_MAX_BYTES) {
        return refused(
          `task is over ${SUBAGENT_TEXT_MAX_BYTES / 1024} KiB; put the long part in a file and ` +
            "name it in the task.",
        );
      }
      const label = typeof args.label === "string"
        ? shownText(args.label).replace(LABEL_BREAKS, " ").trim()
        : "";
      if (label === "" || label.length > SUBAGENT_LABEL_MAX) {
        return refused(
          `label must say what the subagent is doing, for the people watching the run, in 1 to ` +
            `${SUBAGENT_LABEL_MAX} characters (an emoji counts as two).`,
        );
      }
      if (args.mode !== "explore" && args.mode !== "work") {
        return refused('mode must be "explore" or "work".');
      }
      const minutes = args.timeoutMinutes ?? SUBAGENT_TIMEOUT_DEFAULT_MINUTES;
      if (
        !Number.isInteger(minutes) || minutes < SUBAGENT_TIMEOUT_MIN_MINUTES ||
        minutes > SUBAGENT_TIMEOUT_MAX_MINUTES
      ) {
        return refused(
          `timeoutMinutes must be a whole number of minutes from ` +
            `${SUBAGENT_TIMEOUT_MIN_MINUTES} to ${SUBAGENT_TIMEOUT_MAX_MINUTES}.`,
        );
      }
      const live = runningOnes().length;
      if (live >= SUBAGENT_MAX_RUNNING) return refused(full(live));
      if (subagents.length >= SUBAGENT_MAX_STARTED) {
        return refused(
          `This run has started ${subagents.length} subagents, the most a run may start. ` +
            "Continue one of them with ryph__subagent_message instead.",
        );
      }
      const sa: Subagent = {
        id: `sa-${subagents.length + 1}`,
        label,
        mode: args.mode,
        task: args.task,
        timeoutMinutes: minutes,
        stretches: 0,
        stretch: null,
        last: null,
        lock: Promise.resolve(),
      };
      subagents.push(sa);
      // Its slot now, on the tick the cap was checked.
      const stretch = reserve(sa);
      narrate(sa, {
        kind: "subagent.start",
        text: label,
        raw: lanePayload({ id: sa.id, label, mode: sa.mode, task: shownText(args.task) }, "task"),
      });
      deps.diag.debug("subagents.starting", { id: sa.id, mode: sa.mode, timeoutMinutes: minutes });
      try {
        await withLock(sa, () => launch(sa, stretch, args.task));
      } catch (err) {
        return refused(`Subagent ${sa.id} could not be started: ${errorMessage(err)}`);
      }
      return { kind: "started", subagent: view(sa) };
    },

    async message(args) {
      const sa = find(args.id);
      if ("reason" in sa) return refused(sa.reason);
      if (typeof args.text !== "string" || args.text.trim() === "") {
        return refused("text must be what you have to say to the subagent.");
      }
      if (utf8Bytes(args.text) > SUBAGENT_TEXT_MAX_BYTES) {
        return refused(
          `text is over ${SUBAGENT_TEXT_MAX_BYTES / 1024} KiB; put the long part in a file and ` +
            "name it.",
        );
      }
      const text = args.text;
      try {
        return await withLock(sa, async (): Promise<SubagentMessageOutcome> => {
          if (stopping !== null) return refused(ENDING);
          const current = sa.stretch;
          if (current !== null && current.process !== null && current.ending === null) {
            const prompt = `${FROM_PARENT}\n\n${text}`;
            if (current.process.steer(prompt)) {
              const queued = current.steers.get(prompt) ?? [];
              queued.push(text);
              current.steers.set(prompt, queued);
              deps.diag.debug("subagents.steered", { id: sa.id });
              return { kind: "steered", subagent: view(sa) };
            }
          }
          // It settled, or is being stopped: its process goes first, then the next stretch.
          if (sa.stretch !== null) await sa.stretch.done;
          const blocked = unavailable();
          if (blocked !== null) return refused(blocked);
          // No session on disk: its first process died before pi took the task. The runner
          // knows the task, so a fresh session starts from it.
          const fresh = !(await deps.host!.hasSession(sa.id));
          if (stopping !== null) return refused(ENDING);
          const live = runningOnes().length;
          if (live >= SUBAGENT_MAX_RUNNING) return refused(full(live));
          const stretch = reserve(sa);
          narrate(sa, {
            kind: "subagent.resume",
            text,
            raw: lanePayload({ id: sa.id, message: shownText(text) }, "message"),
          });
          deps.diag.debug("subagents.continuing", { id: sa.id, after: sa.last?.reason, fresh });
          const prompt = continuePrompt(sa.last, sa.timeoutMinutes, text);
          try {
            await launch(sa, stretch, fresh ? freshPrompt(sa.task, prompt) : prompt);
          } catch (err) {
            return refused(`${sa.id} could not be continued: ${errorMessage(err)}`);
          }
          return { kind: "continued", subagent: view(sa) };
        });
      } catch (err) {
        deps.diag.warn("subagents.message_failed", { id: sa.id, err });
        return refused(`The message could not be handed to ${sa.id}; try again.`);
      }
    },

    async stop(id) {
      const sa = find(id);
      if ("reason" in sa) return refused(sa.reason);
      // Marked on this tick: whatever ended the stretch, from here its end is this answer's.
      const stretch = sa.stretch;
      if (stretch === null) {
        return { kind: "stopped", subagent: view(sa), already: true, answer: null };
      }
      stretch.stopAsked = true;
      // One that settled or timed out a moment ago is ending already, on its own.
      const already = stretch.ending !== null && stretch.ending !== "stopped";
      await end(stretch, "stopped");
      return {
        kind: "stopped",
        subagent: view(sa),
        already,
        answer: already && sa.last !== null ? capped(sa.last.answer) : null,
      };
    },

    running: () => runningOnes().length,

    holdUntil() {
      let until: number | null = null;
      for (const sa of runningOnes()) {
        until = Math.max(until ?? 0, sa.stretch!.timeoutAt + HOLD_SLACK_MS);
      }
      return until;
    },

    stopAll,

    async close() {
      await stopAll();
      await deps.host?.close().catch((err) =>
        deps.diag.debug("subagents.host_close_failed", { err: errorMessage(err) })
      );
    },
  };
}

const refused = (reason: string) => ({ kind: "refused", reason }) as const;

const ENDING = "The run is ending, so no subagent can start or be continued.";

const full = (live: number) =>
  `${live} subagents are already running, the most a run may have at once. Wait for one to ` +
  "end — end your turn, and its answer arrives as a message — or stop one with " +
  "ryph__subagent_stop.";

/**
 * The opening of a continuation: the agent's message, framed as the agent's word, and before it
 * why the last stretch ended where it did not end on an answer — otherwise all the subagent sees
 * of a stop is a tool call that failed.
 */
/** A continuation's opening on a fresh session: the task again, then the continuation's own. */
export function freshPrompt(task: string, continuation: string): string {
  return `${task}\n\nYou were working on this task before, but nothing of that work was kept.` +
    `\n\n${continuation}`;
}

export function continuePrompt(
  last: Pick<Ended, "reason" | "tool"> | null,
  timeoutMinutes: number,
  text: string,
): string {
  const running = last?.tool ? ` while running \`${last.tool}\`` : "";
  const why = last?.reason === "timeout"
    ? `You were stopped at the ${timeoutMinutes}-minute limit${running}.`
    : last?.reason === "stopped"
    ? `You were stopped by the agent that handed you your task${running}.`
    : last?.reason === "failed"
    ? "Your last stretch of work ended when your process failed."
    : null;
  return `${why === null ? "" : `${why}\n\n`}${FROM_PARENT}\n\n${text}`;
}

/** The answer as the agent is handed it: at most SUBAGENT_ANSWER_MAX_BYTES, with a note past it. */
export function capped(answer: string): SubagentAnswer {
  const bytes = utf8Bytes(answer);
  if (bytes <= SUBAGENT_ANSWER_MAX_BYTES) {
    return { text: answer, chars: answer.length, truncated: false };
  }
  const note = `\n\n[ryph: answer truncated to its first ${SUBAGENT_ANSWER_MAX_BYTES / 1024} KiB ` +
    `of ${Math.ceil(bytes / 1024)} KiB. Ask the subagent with ryph__subagent_message for the ` +
    "part you need.]";
  const text = clipBytes(answer, SUBAGENT_ANSWER_MAX_BYTES - utf8Bytes(note)) + note;
  return { text, chars: answer.length, truncated: true };
}

/** The agent's notice of a stretch's end it did not stop: how it ended, and its answer. */
function noticeOf(sa: Subagent, seen: SubagentView, last: Ended): SubagentNoticeMessage {
  const answer = capped(last.answer);
  const said = answer.text === ""
    ? " It said nothing."
    : `\n\n${last.reason === "answered" ? "Its answer" : "Its last message"}:\n\n${answer.text}`;
  return {
    kind: "system",
    sender: { kind: "platform" },
    text: `Subagent ${sa.id} (${JSON.stringify(sa.label)}) ${describeSubagent(seen)}.${said}` +
      "\n\nContinue it with ryph__subagent_message if you need more from it.",
    payload: null,
    createdAt: new Date(last.at).toISOString(),
    subagent: {
      id: sa.id,
      label: sa.label,
      reason: last.reason === "answered"
        ? "answered"
        : last.reason === "timeout"
        ? "timeout"
        : "failed",
      durationMs: seen.durationMs,
    },
  };
}

/** How a subagent stands, in words: "running for 3m 2s", "answered after 4m 12s". */
export function describeSubagent(sa: SubagentView): string {
  const took = formatDuration(sa.durationMs);
  if (sa.ended === null) return `running for ${took}`;
  const running = sa.ended.tool ? ` while running \`${sa.ended.tool}\`` : "";
  switch (sa.ended.reason) {
    case "answered":
      return `answered after ${took}`;
    case "timeout":
      return `was stopped at its ${sa.timeoutMinutes}-minute limit${running}, after ${took}`;
    case "stopped":
      return `was stopped${running} after ${took}`;
    case "failed":
      return `failed after ${took}: ${sa.ended.error ?? "its process ended without an answer"}`;
    case "run_ended":
      return `was stopped when the run ended, after ${took}`;
  }
}

/** A lane row's payload, with `field` clipped until the whole fits the emitter's payload cap. */
function lanePayload<T extends Record<string, string>>(payload: T, field: keyof T): T {
  let value = clip(payload[field], LANE_TEXT_CHARS);
  let fitted = { ...payload, [field]: value };
  while (JSON.stringify(fitted).length > LANE_PAYLOAD_CHARS && value.length > 0) {
    value = clip(value, value.length >> 1);
    fitted = { ...payload, [field]: value };
  }
  return fitted;
}
