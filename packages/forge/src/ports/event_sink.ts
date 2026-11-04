// Where normalized forge events go — the orchestrator's intake, behind a port so the
// consumer composition (and its tests) never dial anything real.

import type { ForgeEvent } from "../core/types.ts";

/** Same shape as the webhook queue's ConsumeOutcome on purpose: a consumer can return a
 * delivery verdict unchanged, and the queue's retry clock reads it directly. */
export type DeliverOutcome =
  | { kind: "ok" }
  | { kind: "failed"; message: string; terminal: boolean };

export interface EventSink {
  /** Never throws: the caller's retry clock needs terminality, not exception shapes. */
  deliver(event: ForgeEvent): Promise<DeliverOutcome>;
}

/**
 * What the control plane says of a verified GitLab webhook — the project its token was derived
 * for and the token's generation (`@ryph/webhooks` `generationParam`):
 * - `current`: a live connected repo is that project, and the generation is the one it hands
 *   out now; `connectedAt` is when that connection was made
 * - `stale`: the project's token was rotated since; this one is refused
 * - `unconnected`: no live connected repo is that project
 */
export type GitlabHookAdmission =
  | { admission: "current"; connectedAt: string }
  | { admission: "stale" | "unconnected" };

/** Which kind of delivery the consumer is admitting: a Merge Request Hook is the only one a
 * merge arrives as, and the control plane records it apart (its merge poll's silence check). */
export type GitlabHookHeard = "merge_request" | "other";

/** Which of a project's delivery budgets a GitLab delivery spends at the door
 * (`gitlabHookLane`): Note Hooks — the `/ryph` commands, which nothing else recovers — apart from
 * every other event, whose merges and pushes the control plane also polls for. */
export type GitlabHookLane = "comments" | "other";

export interface GitlabHookGate {
  /**
   * Asked twice per delivery, so a stale or unwanted one costs no row and no API read. The
   * mailroom's door asks with no `heard` before it stores the delivery, and nothing is recorded.
   * The consumer asks again with `heard` before it reads GitLab — a rotation may have happened
   * in between — and a current arrival is recorded, for the repo page. Throws when the control
   * plane could not be asked.
   */
  admit(
    projectId: string,
    generation: string,
    heard?: GitlabHookHeard,
  ): Promise<GitlabHookAdmission>;
  /**
   * Tells the control plane how many deliveries of a project, at a generation, the door dropped
   * over one of the project's budgets (`lane`) since it last said — acknowledged to GitLab, never
   * stored — so the repo page can say which events were lost. Batched (`gitlabDropReporter`).
   * Throws when the control plane could not be told; the count is then only in the log.
   */
  dropped(
    projectId: string,
    generation: string,
    lane: GitlabHookLane,
    count: number,
  ): Promise<void>;
}
