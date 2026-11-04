// Where a patch shipped during the run or finalization is reported — the immediate counterpart
// of the terminal result's `branches`. The bundle already left the box through the git transport; this tells
// the control plane a branch is there to open a patch from, and hears back the patch's id and
// the state it was born into, which is what the agent is told.
//
// Not on the OrchestratorGateway on purpose: that port is report-only and answers nothing, and
// this one has to answer — the agent asked. A failure to report is NOT a failure to ship: the
// bundle is durable, and the terminal result lists the branch again, so the control plane opens
// the patch then at the latest.

import type { BranchOutcome } from "../core/types.ts";

export interface PatchReport {
  branch: BranchOutcome;
  /** True only for automatic finalization: this work needs approval regardless of repo policy. */
  requiresApproval?: boolean;
  /** The commit the bundle was cut from — the branch's base in this generation. */
  baseSha: string;
  /** The agent's title for the pull request; the task's title otherwise. */
  title?: string;
  /** The agent's description, shown above the run's report on the pull request. */
  description?: string;
}

/** What the control plane answers to a patch report. */
export interface PatchReported {
  patchId: string;
  state: string;
  /** The patch's page in Ryph, where a person approves it — null where the control plane does
   * not know its own address, or is a version behind and names none. */
  url: string | null;
  /** Existing change request identity, even when its forge has no web URL. */
  forgeRef?: string | null;
  /** Existing change request this patch targets; absent/null when none is known. */
  forgeUrl?: string | null;
}

/** What the control plane answers when it has re-targeted the run onto a change request. */
export interface ChangeRequestClaim {
  connectedRepoId: string;
  /** The forge's own thread ref, as the control plane resolved it. */
  thread: string;
  /** The branch the change request's head sits on — the repo's base ref from now on. */
  ref: string;
  /** The branch the change request merges into — the repo's target from now on. Absent when
   * the platform names none the run could fetch. */
  targetRef?: string;
  headSha: string;
  /** The change request at the forge, for the agent to name. */
  url: string;
}

/**
 * A claim the control plane REFUSED: its own words, and nothing was recorded — the task still
 * targets whatever it targeted. Every OTHER failure of `claimChangeRequest` (a timeout, a 5xx,
 * a connection that broke, an answer that made no sense) leaves the claim's fate UNKNOWN, which
 * the caller has to say out loud: the re-target may have been applied with only the answer
 * lost. The call is idempotent, so calling it again is the way out of that.
 */
export class ChangeRequestRefused extends Error {
  /** The status the control plane answered with, where there was one. */
  readonly status: number | undefined;
  constructor(reason: string, status?: number) {
    super(reason);
    this.name = "ChangeRequestRefused";
    this.status = status;
  }
}

export interface PatchReporter {
  /** Throws when the report could not land (the caller says so to the agent, and moves on). */
  reportPatch(report: PatchReport): Promise<PatchReported>;
  /**
   * Claims a change request for this run: the control plane re-targets the task onto it, so the
   * patches this run reports from here on become revisions of THAT change request rather than a
   * new one. The claim is also exclusive — one live run per change request — which is why it is
   * the control plane's to grant and not the runner's to assume.
   *
   * Throws `ChangeRequestRefused` with the reason the control plane gave (eligibility, another
   * run holding it, the run having shipped already) — nothing was recorded, and nothing on disk
   * has moved. Any other throw means the claim was not CONFIRMED, which is not the same as
   * refused: see the class above.
   */
  claimChangeRequest(
    args: { path: string; changeRequest: string },
  ): Promise<ChangeRequestClaim>;
}
