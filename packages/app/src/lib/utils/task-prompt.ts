import { ApiError } from "$lib/api/call";
import { type Phase, type RunState, TERMINAL_RUN_STATES } from "$lib/api/types";

/** What a list row says in place of the title of a task that has not been told what to do. */
export const AWAITING_PROMPT_LABEL = "Waiting for instructions…";

/**
 * A task's name where it must be a plain string: the breadcrumb, the document title. A task
 * waiting for its first message has no title yet, and is a new task until it gets one.
 */
export function taskName(title: string | null): string {
  return title ?? "New task";
}

/**
 * Whether a task is still waiting for its first message. The detail says so; its instructions
 * being null is the same fact, as the server stores it.
 */
export function awaitsPrompt(task: {
  awaitingPrompt?: boolean;
  spec: { instructions: string | null };
}): boolean {
  return task.awaitingPrompt ?? task.spec.instructions === null;
}

/**
 * Where a task waiting for its first message stands, as its page says it: the run is still
 * getting going, it is up and would start on a message right away, or it ended without one.
 * A message can be sent in the first two; one sent while it is getting ready is held until then.
 */
export type PromptReadiness = "getting-ready" | "ready" | "ended";

export function promptReadiness(
  run: { state: RunState; phase: Phase | null } | null,
): PromptReadiness {
  if (run === null) return "getting-ready";
  if (TERMINAL_RUN_STATES.includes(run.state)) return "ended";
  return run.state === "running" && run.phase === "running" ? "ready" : "getting-ready";
}

/**
 * Whether the task page asks for the first message instead of showing the transcript.
 *
 * The detail's `awaitingPrompt` is the record. It is held on two ways: from the moment this
 * page starts sending until the send has settled, because a poll can land in between and the
 * box that is sending must not go away under it; and dropped as soon as this page has sent it,
 * without waiting for the next read to say so.
 */
export function asksForPrompt(opts: {
  awaitingPrompt: boolean;
  /** This page is sending the first message right now. */
  sending: boolean;
  /** This page has sent the first message. */
  sent: boolean;
}): boolean {
  if (opts.sending) return true;
  return opts.awaitingPrompt && !opts.sent;
}

/** What the page says when a first message arrived after its run had already stopped. */
export const ENDED_BEFORE_PROMPT = "This task stopped before your message reached it.";

/** Whether a send was refused because the run had ended: the server's `terminal` refusal. */
export function refusedAsEnded(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  const body = e.body as { reason?: unknown } | null;
  return body?.reason === "terminal";
}

/** What a task started again takes to its new page: the draft and the files of its images. */
export type Carried = { text: string; files: readonly File[] };

/**
 * Drafts on their way to a task just started again, by the new task's id. In memory only: a
 * client-side navigation keeps it, and a reload simply finds nothing. Only the browser writes it.
 */
const handoffs = new Map<string, Carried>();

/** Leaves a draft for the task `taskId`'s page to pick up. */
export function handOff(taskId: string, carried: Carried): void {
  handoffs.set(taskId, carried);
}

/** The draft left for `taskId`, once: whoever reads it takes it, and the next read finds none. */
export function takeHandoff(taskId: string): Carried | null {
  const carried = handoffs.get(taskId) ?? null;
  handoffs.delete(taskId);
  return carried;
}

/**
 * Starts a task that stopped before it got its first message again: a re-run, waiting for its
 * instructions, with the draft handed to its page, which is opened. Nothing is sent: the person
 * sends from the new page, as they would have from this one.
 *
 * Nothing is kept between tries either. A failed one leaves nothing behind, and the next starts
 * from scratch. A press while one is under way joins it rather than starting a second.
 */
export class StartAgain {
  readonly #create: () => Promise<{ taskId: string }>;
  readonly #open: (taskId: string) => Promise<unknown>;
  #pending: Promise<void> | null = null;

  constructor(
    create: () => Promise<{ taskId: string }>,
    open: (taskId: string) => Promise<unknown>,
  ) {
    this.#create = create;
    this.#open = open;
  }

  start(carried: Carried): Promise<void> {
    this.#pending ??= this.#start(carried).finally(() => (this.#pending = null));
    return this.#pending;
  }

  async #start(carried: Carried) {
    const { taskId } = await this.#create();
    handOff(taskId, carried);
    await this.#open(taskId);
  }
}
