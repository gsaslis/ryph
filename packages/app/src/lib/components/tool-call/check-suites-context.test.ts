import { describe, expect, it } from "vitest";
import { checkSuiteViewSchema } from "$lib/api/types";
import { suite as raw } from "$lib/api/checks.test-fixture";
import { suitesInReply } from "./check-suites-context";

const base = checkSuiteViewSchema.parse(raw);
const other = { ...base, id: "cs-abcdefabcd", commit: "e".repeat(40) };
const later = { ...base, id: "cs-1111111111", createdAt: "2026-09-30T11:00:00.000Z" };
// Asked for on the same commit by a patch, not by the run's own call.
const patchs = {
  ...base,
  id: "cs-3333333333",
  requestedBy: [{ kind: "patch" as const, runId: null, patchId: "p-1" }],
};
// The run's own later request for only some of the checks, on the same commit.
const lintOnly = {
  ...base,
  id: "cs-4444444444",
  createdAt: "2026-09-30T11:30:00.000Z",
  partial: true,
  checks: base.checks.filter((c) => c.name === "lint"),
};

const reading = "Checks requested for aaaaaaaaaa on x. Reading .ryph/checks.yml is taking a while";

describe("suitesInReply", () => {
  it("finds the suites a reply names, once each", () => {
    const reply = `Checks requested for aaaaaaaaaa on x: suite ${base.id} (lint), queued. ` +
      `Again: ${base.id}.`;
    expect(suitesInReply(reply, [other, base], "run-1", [])).toEqual([base]);
  });

  it("finds a suite id of the sortable shape, and only whole ids", () => {
    const sortable = { ...base, id: "cs-01jb7k3m9x4q8zt2vw6hn5c0fe" };
    const reply = `suite ${sortable.id} (lint), queued; not cs-01jb7k3m9x4q8zt2vw6hn5c0fe0.`;
    expect(suitesInReply(reply, [base, sortable], "run-1", [])).toEqual([sortable]);
  });

  it("names nothing for a suite the page does not hold", () => {
    expect(suitesInReply("suite cs-9999999999 (lint), queued.", [base], "run-1", []))
      .toEqual([]);
  });

  it("finds a request still reading its base by its commit and this run's request", () => {
    expect(suitesInReply(reading, [patchs, later, other], "run-1", [])).toEqual([later]);
  });

  it("takes an older suite the request reused over a later partial one on the same head", () => {
    expect(suitesInReply(reading, [lintOnly, base], "run-1", [])).toEqual([base]);
  });

  it("takes the suite of exactly the checks a call named", () => {
    expect(suitesInReply(reading, [base, lintOnly], "run-1", ["lint"])).toEqual([lintOnly]);
  });

  it("takes the first of this run's suites on the head", () => {
    expect(suitesInReply(reading, [later, base], "run-1", [])).toEqual([base]);
  });

  it("ignores suites on that commit another run asked for", () => {
    expect(suitesInReply(reading, [base, patchs], "run-2", [])).toEqual([]);
  });

  it("finds nothing in a refusal", () => {
    expect(suitesInReply("No checks run for aaaaaaaaaa: no checks file.", [base], "run-1", []))
      .toEqual([]);
  });
});
