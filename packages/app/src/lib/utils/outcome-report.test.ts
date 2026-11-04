import { describe, expect, it } from "vitest";
import { outcomeCallLabel, reportedOutcome, reportedOutcomeLabel } from "./outcome-report";

const ok = { done: true, isError: false };
const refused = { done: true, isError: true };
const inFlight = { done: false, isError: false };

describe("reportedOutcomeLabel", () => {
  it("says which outcome the agent reported", () => {
    expect(reportedOutcomeLabel({ outcome: "in-progress", summary: "waiting" }, ok)).toBe(
      "Reported progress",
    );
    expect(reportedOutcomeLabel({ outcome: "success" }, ok)).toBe("Reported done");
    expect(reportedOutcomeLabel({ outcome: "no-changes" })).toBe(
      "Reported done, no changes needed",
    );
    expect(reportedOutcomeLabel({ outcome: "failed" }, inFlight)).toBe(
      "Reported it can't be done",
    );
  });

  it("reads an outcome it does not know, or none at all, as an outcome", () => {
    expect(reportedOutcomeLabel({ outcome: "partial" })).toBe("Reported an outcome");
    expect(reportedOutcomeLabel({})).toBe("Reported an outcome");
    expect(reportedOutcomeLabel(null)).toBe("Reported an outcome");
    expect(reportedOutcomeLabel("success")).toBe("Reported an outcome");
  });

  it("claims nothing for a call the runner refused", () => {
    expect(reportedOutcomeLabel({ outcome: "success" }, refused)).toBe(
      "Tried to report an outcome",
    );
    expect(reportedOutcomeLabel({ outcome: "partial" }, refused)).toBe(
      "Tried to report an outcome",
    );
  });
});

describe("outcomeCallLabel for finish", () => {
  it("says the outcome the agent finished on", () => {
    expect(outcomeCallLabel("finish", { outcome: "success" }, ok)).toBe("Finished");
    expect(outcomeCallLabel("finish", { outcome: "no-changes" }, ok)).toBe(
      "Finished, no changes needed",
    );
    expect(outcomeCallLabel("finish", { outcome: "failed" }, ok)).toBe("Finished: can't be done");
    expect(outcomeCallLabel("finish", { outcome: "partial" }, ok)).toBe("Finished");
    expect(outcomeCallLabel("finish", null)).toBe("Finished");
  });

  it("says it only tried when the runner refused it", () => {
    expect(outcomeCallLabel("finish", { outcome: "in-progress" }, refused)).toBe(
      "Tried to finish",
    );
    expect(outcomeCallLabel("finish", { outcome: "success" }, refused)).toBe("Tried to finish");
  });
});

describe("reportedOutcome", () => {
  it("folds success into done, and keeps the rest apart", () => {
    expect(reportedOutcome({ outcome: "success" })).toBe("done");
    expect(reportedOutcome({ outcome: "in-progress" })).toBe("in-progress");
    expect(reportedOutcome({ outcome: 3 })).toBe("unknown");
  });

  it("is refused only once a refusal arrived", () => {
    expect(reportedOutcome({ outcome: "success" }, refused)).toBe("refused");
    expect(reportedOutcome({ outcome: "success" }, { done: false, isError: true })).toBe("done");
  });
});
