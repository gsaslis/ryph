// How an agent's outcome calls — `report_outcome` and `finish` — read in a run's transcript. The
// agent reports at every turn's end, and the reports mean different things: work still going on is
// not the work being done, so the row says which it was rather than one label for all of them.
// A call the runner refused recorded nothing, so its row claims nothing either.

/** What an outcome call said, as the transcript tells them apart; "refused" when the runner
 * answered it with an error and recorded nothing. */
export type ReportedOutcome =
  | "in-progress"
  | "done"
  | "no-changes"
  | "failed"
  | "unknown"
  | "refused";

/** The tools that carry the agent's outcome. */
export type OutcomeTool = "report_outcome" | "finish";

/** Whether the runner answered the call with an error: done, and refused. */
export interface CallAnswer {
  done: boolean;
  isError: boolean;
}

/** The `outcome` argument of an outcome call; "unknown" for anything this page does not know,
 * including a call whose arguments did not parse, and "refused" for a call that was refused. */
export function reportedOutcome(args: unknown, answer?: CallAnswer): ReportedOutcome {
  if (answer?.done === true && answer.isError) return "refused";
  if (typeof args !== "object" || args === null) return "unknown";
  switch ((args as Record<string, unknown>).outcome) {
    case "in-progress":
      return "in-progress";
    case "success":
      return "done";
    case "no-changes":
      return "no-changes";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

const LABELS: Record<OutcomeTool, Record<ReportedOutcome, string>> = {
  report_outcome: {
    "in-progress": "Reported progress",
    done: "Reported done",
    "no-changes": "Reported done, no changes needed",
    failed: "Reported it can't be done",
    unknown: "Reported an outcome",
    refused: "Tried to report an outcome",
  },
  // `finish` never takes in-progress: the runner refuses it, so such a call reads as refused once
  // answered, and as a plain finish while in flight.
  finish: {
    "in-progress": "Finished",
    done: "Finished",
    "no-changes": "Finished, no changes needed",
    failed: "Finished: can't be done",
    unknown: "Finished",
    refused: "Tried to finish",
  },
};

/** The phrase an outcome call's row says, from the call's arguments and its answer. */
export function outcomeCallLabel(tool: OutcomeTool, args: unknown, answer?: CallAnswer): string {
  return LABELS[tool][reportedOutcome(args, answer)];
}

/** The phrase a `report_outcome` row says. */
export function reportedOutcomeLabel(args: unknown, answer?: CallAnswer): string {
  return outcomeCallLabel("report_outcome", args, answer);
}
