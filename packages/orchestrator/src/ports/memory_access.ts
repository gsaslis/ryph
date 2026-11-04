// Memory, as the orchestrator touches it: a few times per run, and never in a way that can fail
// one.
//
// `composeBrief` at startTask — what previous runs and people recorded about the run's repos
// and the org, under the agent's token budget, frozen into the run's snapshot as injected
// context.
// `reportPatch` whenever a patch is born (and again when it is submitted, with its pull
// request) — memory tracks a CHANGE PER PATCH, and a run's `introduced` claims bind to the
// first patch that follows them. `reportChange` once a patch's fate is known — merged, or
// closed, rejected, superseded, failed past retrying — which is what the claims bound to it
// wait on. `reportOutcome` at conclusion — the implicit signal: a memory briefed into a run
// that succeeded and was not refuted by it earns a small confirmation, and the run's claims
// still unbound bind to its last patch or are dropped. `reportStale` from the runner's preparing
// phase — the mechanical staleness check, relayed. All of them are best-effort at their call
// sites: a brief that could not be composed is a memoryless run, a signal that could not be
// reported is a signal lost, and neither is a reason to fail work.
//
// A PORT, not an HTTP-layer interface like ModelAccess and ToolAccess, because the core calls
// it: startTask composes the brief. Two adapters stand behind it — the single-process host
// builds one over @ryph/memory's service in-process, adapters/memory_access/http.ts dials a
// standalone memory service's internal surface — and the core cannot tell them apart.

export type MemoryRunOutcome = "success" | "failure" | "error" | "cancelled" | "lost";

/** What became of ONE PATCH, as memory needs to hear it: the claims bound to it hold once it
 * (or a patch that carries its work) landed, and are dropped once every one of those settled
 * without landing. A workspace run ships one patch per repo, and a run
 * several per repo; each settles on its own. */
export type MemoryChangeFate = "landed" | "dropped";

/** A patch as memory records it: the change a run's claims may bind to. Upserted — born with
 * no pull request, told its URL once submitted. */
export interface MemoryPatch {
  patchId: string;
  /** The repo as the brief request named it (the task's own URL for the entry). */
  repo: string;
  generation: number;
  headSha: string;
  forgeUrl: string | null;
  /** The run's earlier patches whose work this one carries in full (`Patch.carries`): a claim
   * bound to one of them holds once this one lands. */
  carries: string[];
}

/**
 * The brief as memory composed it, before the orchestrator freezes it onto a run: like the
 * frozen `MemoryBrief`, except that each evidence entry names the REPO the claim is about (as
 * the compose request named it) rather than a checkout path — memory knows repos, not the
 * task's directory layout. startTask maps one to the other.
 */
export interface ComposedBrief {
  text: string;
  memoryIds: string[];
  evidence: Array<{ memoryId: string; sha: string; paths: string[]; repo: string }>;
}

/** A briefed memory the runner found stale at clone time, and which of its paths changed. */
export interface StaleMemory {
  memoryId: string;
  changedPaths: string[];
  /** The commit the runner diffed to — the clone's base. Memory re-anchors the claim's
   * evidence to it if this same run goes on to confirm the claim. Null: unknown, so nothing
   * is re-anchored. */
  headSha: string | null;
}

export interface MemoryAccess {
  composeBrief(req: {
    runId: string;
    /** The run's task — memory keeps it so a proposal can point a person at the run. */
    taskId: string;
    agentId: string;
    /** The task's repos as the user named them (never the gateway's clone URLs), in checkout
     * order — every one a subject the brief spans and the run may propose under. Empty for a
     * run with no repo subject. */
    repos: string[];
    task: { title: string; instructions: string };
    budgetTokens: number;
    agentOnly?: boolean;
  }): Promise<ComposedBrief | null>;
  /** Idempotent per run, best-effort at call sites. No more patches follow a conclusion, so
   * memory binds the run's still-unbound claims to its last patch, or drops them when there
   * was none. */
  reportOutcome(runId: string, status: MemoryRunOutcome): Promise<void>;
  /** A patch the run opened — at birth, and again once submitted with its pull request. An
   * upsert on memory's side: the first call binds the run's unbound claims to it. */
  reportPatch(runId: string, patch: MemoryPatch): Promise<void>;
  /** The fate of ONE patch, once known, with what it carries (`Patch.carries`) again: this is
   * the reconciled report, so an edge is not lost with the birth reports. Settles once per patch
   * on the memory side; a repeat, or a patch memory never heard of, is absorbed. */
  reportChange(
    runId: string,
    patchId: string,
    fate: MemoryChangeFate,
    carries: string[],
  ): Promise<void>;
  /** The runner's staleness findings, relayed (decision 2 of the memory proposal: the runner
   * talks to one host and never acts as the agent). Best-effort at call sites. */
  reportStale(runId: string, stale: StaleMemory[]): Promise<void>;
}
