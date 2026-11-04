// One run's conclusion, as everything outside the run sees it: the three revocations that must
// follow EVERY terminal verdict, memory's outcome, and — for a run that was a response's
// attempt — the response closing and its chatroom hearing the end, as the chat thread a command
// room's mention started the run from does. All in one place.
//
// A run hands its container three credentials it does not own — a virtual model key, a virtual
// MCP token the gateway resolves back to a real third-party secret, and a git virtual key — and
// each one outlives the run until something kills it. The runner's result handler used to be the
// only caller, so a run the REAPER concluded (silence, no report) kept every one of them alive
// until its TTL lapsed: up to twelve hours for the MCP token, on a run whose container the same
// sweep had just killed for being unreachable. Terminal is terminal, whoever declared it.
//
// Best-effort by construction, and deliberately so: each step is caught and warned, the TTLs are
// the backstop, and the resolve paths refuse a terminal run regardless. A failed revocation must
// never turn a delivered result — or a recorded loss — into an error the caller has to handle.

import type { Diagnostics } from "../ports/diagnostics.ts";
import type { ChatAccess } from "../ports/chat_access.ts";
import type { MemoryAccess, MemoryChangeFate, MemoryRunOutcome } from "../ports/memory_access.ts";
import type { TaskStore } from "../ports/task_store.ts";
import {
  type ForgeToolAction,
  type Patch,
  type Response,
  type Run,
  type RunState,
  TERMINAL_STATES,
} from "./types.ts";
import { summaryToSend } from "./image_refs.ts";

/**
 * The one method this needs from the model and tool access ports, structurally. Named here
 * rather than imported because those ports are declared at the HTTP layer, which core may not
 * reach — and because "kill this run's credentials" is the entire contract either side needs.
 */
export interface RunCredentialRevoker {
  revokeRunCredentials(runId: string): Promise<void>;
}

export interface ConcludeRunDeps {
  store: Pick<
    TaskStore,
    | "revokeGitKeysForRun"
    | "markRunMemoryOutcomeReported"
    | "findResponseByRun"
    | "closeResponse"
    | "patchesForTask"
    | "listForgeToolActions"
  >;
  diag: Diagnostics;
  /** Null/absent: the deployment has no model access, so there is no key to kill. */
  modelAccess?: RunCredentialRevoker | null;
  /** Null/absent: no tool access, so there is no virtual MCP token to kill. */
  toolAccess?: RunCredentialRevoker | null;
  /** Null/absent: no memory, so there is no outcome to report. */
  memoryAccess?: Pick<MemoryAccess, "reportOutcome" | "reportChange"> | null;
  /** Null/absent: no chat service, so a response's room hears nothing. */
  chatAccess?: Pick<ChatAccess, "closeBinding"> | null;
  /** The web app's origin, for the run link the room is given; null omits it. */
  appUrl?: string | null;
}

/** How a run's terminal state reads to memory. Null for a run that is not over. */
export function memoryOutcomeOf(state: RunState): MemoryRunOutcome | null {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "failure";
    case "errored":
      return "error";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
    default:
      return null;
  }
}

/** The run page as a browser reaches it, when the deployment knows its own address. */
export function runUrlOf(appUrl: string | null | undefined, taskId: string): string | null {
  return appUrl ? `${appUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}` : null;
}

/** A patch's page as a browser reaches it — where a person approves or rejects it — when the
 * deployment knows its own address. */
export function patchUrlOf(appUrl: string | null | undefined, patchId: string): string | null {
  return appUrl ? `${appUrl.replace(/\/+$/, "")}/patches/${encodeURIComponent(patchId)}` : null;
}

/**
 * Kills every credential a concluded run still holds, tells memory how it ended, and closes
 * the response the run was an attempt at. Idempotent (each revoke is, and so is the outcome;
 * a closed response stays closed), total (never throws), and keyed on the run's frozen scopes
 * — a run that called no models and no tools only ever had a git key. `run` is the run AS
 * CONCLUDED: its state is what memory and the room hear.
 */
export async function concludeRun(deps: ConcludeRunDeps, run: Run, at: string): Promise<void> {
  const { diag } = deps;
  await reportRunOutcome(deps, run, at);
  if (run.modelScope !== null && deps.modelAccess) {
    await deps.modelAccess.revokeRunCredentials(run.id).catch((err) =>
      diag.warn("credentials.revoke_failed", { runId: run.id, err: String(err) })
    );
  }
  if (run.toolScope !== null && deps.toolAccess) {
    await deps.toolAccess.revokeRunCredentials(run.id).catch((err) =>
      diag.warn("mcp_credentials.revoke_failed", { runId: run.id, err: String(err) })
    );
  }
  await deps.store.revokeGitKeysForRun(run.id, at).catch((err) =>
    diag.warn("git_keys.revoke_failed", { runId: run.id, err: String(err) })
  );
  await closeConversation(deps, run, at).catch((err) =>
    diag.warn("response.close_failed", { runId: run.id, err: String(err) })
  );
}

/**
 * The response a run was the attempt at closes with the run — the run's terminal state is the
 * reason, unless a person closed it first, in which case that reason stands — and its room, when
 * it has one, hears how it ended. So does the chat thread a command-room mention started the run
 * from, which has a binding and no response. A run with neither is every ordinary run.
 *
 * The binding closes BEFORE the response. A response sharing its automation's conversation is
 * continued by the next one, which can open the moment this row is closed: closed first, a fire
 * landing between the two writes would find the conversation still held, be refused, and run
 * unheard. In this order a fire in between finds this response still open on a run that is over,
 * and the door closes it and opens the next (http/automations_api.ts). A close the chat service
 * refused still closes the response: the binding it left is released by whoever next needs the
 * conversation (`releaseRunBinding`).
 */
async function closeConversation(deps: ConcludeRunDeps, run: Run, at: string): Promise<void> {
  const response = await deps.store.findResponseByRun(run.id);
  const bound = (response !== null && response.chatroomId !== null) ||
    run.originChatroomId !== null;
  if (bound) {
    await closeRunBinding(deps, run, run.state).catch((err) =>
      deps.diag.warn("chat.close_failed", { runId: run.id, err: String(err) })
    );
  }
  // A narrow, conditional close: the store writes only while the row is still open, so a
  // person's reason — landed first — stands, and nothing the copy above carries is put back.
  if (response !== null) await deps.store.closeResponse(response.id, at, run.state);
}

/**
 * Closes a run's chat binding with its closing line: how it went (`outcome`), its own summary,
 * the patches and issues it left, and the link. Throws when the chat service does.
 */
export async function closeRunBinding(
  deps: Pick<ConcludeRunDeps, "store" | "chatAccess" | "appUrl">,
  run: Run,
  outcome: string,
): Promise<void> {
  if (!deps.chatAccess) return;
  const patches = (await deps.store.patchesForTask(run.taskId))
    .filter((p) => p.runId === run.id)
    .map((p) => ({ path: p.path, state: p.state, forgeUrl: p.forgeUrl }));
  await deps.chatAccess.closeBinding({
    runId: run.id,
    outcome,
    summary: summaryToSend(run.result),
    patches,
    issues: openedIssues(await deps.store.listForgeToolActions(run.id)),
    runUrl: runUrlOf(deps.appUrl, run.taskId),
  });
}

/**
 * Releases the chat binding of a run that is OVER, without a closing line — the one its
 * conclusion should have closed and did not (the chat service was down then, or a sweep closed
 * the response behind it). Such a binding still holds its conversation, and a shared response
 * conversation or a topic of the same name would refuse every later run while it does; its line
 * now would only arrive out of order. Idempotent like every close, and never throws.
 */
export async function releaseRunBinding(
  deps: { chatAccess?: Pick<ChatAccess, "closeBinding"> | null; diag: Diagnostics },
  runId: string,
  outcome: string,
): Promise<void> {
  if (!deps.chatAccess) return;
  await deps.chatAccess.closeBinding({
    runId,
    outcome,
    summary: "",
    patches: [],
    issues: [],
    runUrl: null,
    silent: true,
  }).catch((err) => deps.diag.warn("chat.release_failed", { runId, err: String(err) }));
}

/** The reason a person's close writes (`POST /v1/responses/:id/close`); every other close of a
 * response writes its run's terminal state. */
export const CLOSED_BY_USER = "closed-by-user";

/**
 * Whether the run's conclusion is DONE with the response's conversation — the explicit marker
 * the release asks first. `closeConversation` closes the response only after its binding close
 * was tried (said, or refused by the chat service), and writes the run's state as the reason;
 * the reaper and the automations door, the only other writers of a run's state there, release
 * the binding before they close any response a shared conversation continues from. So a response closed with any reason but a person's has had
 * its closing line attempted, and a binding still held behind it is a leak to release at once.
 * An open response, or one a person closed (the conclusion may still be on its way: their close
 * leaves a run already over to it), is not — those wait out `CONCLUSION_GRACE_MS`.
 */
function conversationConcluded(
  response: Pick<Response, "state" | "closedReason"> | null,
): boolean {
  return response !== null && response.state === "closed" &&
    response.closedReason !== null && response.closedReason !== CLOSED_BY_USER;
}

/**
 * How long a run's conclusion is given to close its binding before anyone else may release it,
 * when nothing says it is done (`conversationConcluded`): a response still open on a run that is
 * over, or one a person closed. A run turns terminal when its result lands; from then until the
 * closing line, at the outer bound of each step's own deadline:
 * - each patch born from the result (http/runner_api.ts, before the conclusion): its lineage read
 *   (`PATCH_LINEAGE_TIMEOUT_MS`, 20 s) and memory's patch report (10 s) — 30 s a patch
 * - the conclusion: memory's outcome (10 s), the model and tool credential revocations (10 s
 *   each), and the closing line itself (the chat request, 10 s) — 40 s
 * 10 minutes is 40 s + 30 s × 18 patches: more than two repos at the 8-line cap, far past any
 * run's real count, so a slow forge or memory does not cost a run its closing line. Past this,
 * the conclusion crashed before it closed the response — rare, and the shared conversation's
 * next fires wait (the door answers them retryable) at most this long. A close the chat service
 * REFUSED does not wait at all: the conclusion closed the response behind it, and that is the
 * marker.
 */
export const CONCLUSION_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether a run's binding may be released silently: the run gone from the store, its conclusion
 * done with the conversation (`conversationConcluded`), or the run terminal for longer than
 * `CONCLUSION_GRACE_MS`. A terminal run's `updatedAt` is when it turned terminal: the writes
 * that end a run set it, and nothing moves it after (the late writes that touch a terminal row
 * keep its clock, or only push it later, which only waits longer). A live run is never overdue.
 */
export function conclusionOverdue(
  run: Run | null,
  response: Pick<Response, "state" | "closedReason"> | null,
  now: Date,
): boolean {
  if (run === null) return true;
  if (!TERMINAL_STATES.has(run.state)) return false;
  if (conversationConcluded(response)) return true;
  return Date.parse(run.updatedAt) <= now.getTime() - CONCLUSION_GRACE_MS;
}

/**
 * The issues a run opened, as its closing line lists them: the ledger's `create_issue` rows that
 * completed with a thread. The link is the one the forge settled the write with — built by the
 * forge that knows how its own issues are addressed, and null where it has no web address (a
 * Radicle deployment with no explorer). A GitHub issue is named by its number; a Radicle one has
 * none, only a 40-hex object id, which is named by the seven-character prefix Radicle itself
 * resolves — the link carries the rest.
 */
export function openedIssues(
  actions: readonly ForgeToolAction[],
): Array<{ repo: string; number: number | string; url: string | null }> {
  return actions
    .filter((a) => a.tool === "create_issue" && a.state === "done" && a.createdThreadRef !== null)
    .map((a) => {
      const ref = a.createdThreadRef!;
      const number = /^[0-9]+$/.test(ref)
        ? Number(ref)
        : /^[0-9a-f]{40}$/i.test(ref)
        ? ref.slice(0, 7)
        : ref;
      return { repo: a.repoRef, number, url: a.url };
    });
}

/**
 * Tells memory how a concluded run ended: the implicit signal (a memory briefed into a run
 * that succeeded earns a small confirmation), and the run's claims still bound to no patch
 * bind to its last one now — no more patches follow a conclusion; a run that opened none
 * settles them as no change. Every run reports, brief or not — memory decides whether it
 * briefed this one.
 *
 * RECONCILED like a patch's fate, because a lost report strands something: those claims settle
 * from this report alone, and nothing else will ever ask again. So the acknowledgement is
 * written onto the run when the report lands, and the reaper redelivers for every concluded run
 * still missing one (core/reaper.ts, sweepMemoryOutcomes). Never throws.
 */
export async function reportRunOutcome(
  deps: {
    store: Pick<TaskStore, "markRunMemoryOutcomeReported">;
    diag: Diagnostics;
    memoryAccess?: ConcludeRunDeps["memoryAccess"];
  },
  run: Run,
  at: string,
): Promise<void> {
  const outcome = memoryOutcomeOf(run.state);
  if (outcome === null || !deps.memoryAccess) return;
  try {
    await deps.memoryAccess.reportOutcome(run.id, outcome);
  } catch (err) {
    // Left unacknowledged on purpose: the reconciliation sweep is what tries again.
    deps.diag.warn("memory.outcome_failed", { runId: run.id, err: String(err) });
    return;
  }
  await deps.store.markRunMemoryOutcomeReported(run.id, at).catch((err) =>
    // The report landed; only the bookkeeping did not. Worst case the sweep reports it twice,
    // which memory absorbs — it records a run's outcome once.
    deps.diag.warn("memory.outcome_ack_unsaved", { runId: run.id, err: String(err) })
  );
}

/** What relaying a patch's fate needs: the report itself, and the row to record it on. */
export interface PatchFateDeps {
  store: Pick<TaskStore, "markPatchFateReported">;
  diag: Diagnostics;
  /** Null/absent: no memory, so there is no fate to report and nothing to record. */
  memoryAccess?: Pick<MemoryAccess, "reportChange"> | null;
  now(): Date;
}

/**
 * Tells memory what became of ONE PATCH — the pull request merged or closed, the patch
 * rejected by a person, superseded by a newer one, or failed past retrying. Per patch, because
 * memory tracks a change per patch: a run's `introduced` claims bind to the first patch after
 * them, and that patch's fate (or that of one that carries its work) is what releases them.
 * Best-effort at the call site, as every memory relay is: a failure is warned, never thrown.
 *
 * Unlike the others it is RECONCILED, because it is the relay whose loss actually strands
 * something: the claims wait on this fate and nothing will ever ask again. It repeats what the
 * patch carries (`Patch.carries`), so an edge a lost birth report named still reaches memory. So
 * the
 * acknowledgement is written onto the patch when the report lands, and the reaper redelivers
 * for every settled patch still missing one (core/reaper.ts, sweepMemoryFates). That makes a
 * lost call a delay of one tick instead of a proposal stuck in the inbox forever.
 */
export async function reportPatchFate(
  deps: PatchFateDeps,
  patch: Patch,
  fate: MemoryChangeFate,
): Promise<void> {
  if (!deps.memoryAccess) return;
  try {
    await deps.memoryAccess.reportChange(patch.runId, patch.id, fate, patch.carries);
  } catch (err) {
    // Left unacknowledged on purpose: the reconciliation sweep is what tries again.
    deps.diag.warn("memory.change_failed", {
      runId: patch.runId,
      patchId: patch.id,
      err: String(err),
    });
    return;
  }
  const at = deps.now().toISOString();
  // The acknowledgement alone, and only over the row the report was about: memory can be slow,
  // and a whole-row write of the copy read before the call would put back whatever a settle, a
  // retirement or a link wrote meanwhile.
  await deps.store.markPatchFateReported(patch, at).catch((err) =>
    // The report landed; only the bookkeeping did not. Worst case the sweep reports it twice,
    // which memory absorbs — reportChange settles a patch's change once.
    deps.diag.warn("memory.change_ack_unsaved", { patchId: patch.id, err: String(err) })
  );
}
