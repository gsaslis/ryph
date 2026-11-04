import type { SkillBundle } from "../core/types.ts";

/**
 * Where a frozen skill's files come from: the control plane that froze it, by its digest. A read,
 * so it is not on the report-only `OrchestratorGateway`; a run with no control plane has no
 * frozen skills, and so no use for one.
 *
 * Answers null when the control plane holds no such bundle for this run, and throws when it could
 * not be asked. Either way the core drops that one skill and the run goes on: a run never fails
 * for a skill.
 */
export interface SkillBundles {
  fetch(digest: string, signal: AbortSignal): Promise<SkillBundle | null>;
}
