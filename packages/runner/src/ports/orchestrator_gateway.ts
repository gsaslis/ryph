import type {
  Progress,
  Result,
  SetupFailureReport,
  SkillReport,
  StaleBase,
  StaleMemory,
} from "../core/types.ts";

/**
 * The runner's entire view of whatever drives the run — a report-only channel.
 * The runner reports outcomes without knowing how they are handled upstream.
 */
export interface OrchestratorGateway {
  /**
   * Sends a progress update upstream.
   * Best-effort and one-way; adapters must not let this throw into the core.
   */
  reportProgress(p: Progress): void;

  /**
   * The staleness check's findings: briefed memories whose evidence changed since they were
   * observed. Best-effort and one-way like progress; adapters must not let this throw into the
   * core. The orchestrator relays it to memory — the runner never talks to memory itself.
   */
  reportStaleMemories(stale: StaleMemory[]): void;

  /**
   * The repos whose base came from a copy the origin could not refresh, as the clone found
   * them. Best-effort and one-way like progress; adapters must not let this throw into the
   * core. The orchestrator writes each into the run's history, so a reader of the run learns
   * it started behind the upstream without opening the transcript.
   */
  reportStaleBases(bases: StaleBase[]): void;

  /**
   * What setup warned of, once, after every repo's setup has run: the repos whose setup did not
   * finish (a step failed, or setup.yml was invalid; the run goes on without the rest of their
   * steps), a sibling's changes discarded after one did, and a tree a finished setup left dirty
   * (put back). Awaited, so it lands before anything the run reports after setup (a result that
   * landed first would close the run to it), but bounded by the adapter's request timeout and
   * never rejecting: a report that did not land is a warning missing from the history, never a
   * run held up. The orchestrator writes each into the run's history, where the run page shows
   * it.
   */
  reportSetupFailures(failures: SetupFailureReport[]): Promise<void>;

  /**
   * The skills trail: the working-repo skills the run loaded and the skills it could not give
   * the agent, once, just before the harness starts. Best-effort and one-way like progress;
   * adapters must not let this throw into the core.
   */
  reportSkills(report: SkillReport): void;

  /**
   * Terminal: called exactly once per run, last.
   * Fire-and-confirm: the resolved promise IS the confirmation the report was delivered;
   * there is nothing to answer, so the caller cannot reject or redirect the run's outcome.
   * A failure to deliver rejects the promise — and a report that cannot be delivered
   * is no phase: the runner exits abnormally.
   */
  reportResult(r: Result): Promise<void>;
}
