import { describe, expect, it } from "vitest";
import { approvalReturnTo, approvalStateLabel } from "./check-approval";

describe("approvalReturnTo", () => {
  it("sends back to the change request's web address", () => {
    expect(approvalReturnTo("https://github.com/acme/api/pull/42"))
      .toBe("https://github.com/acme/api/pull/42");
  });

  it("stays on the page for anything that is not a web address", () => {
    expect(approvalReturnTo(null)).toBeNull();
    expect(approvalReturnTo("javascript:alert(1)")).toBeNull();
    expect(approvalReturnTo("/checks")).toBeNull();
  });
});

describe("approvalStateLabel", () => {
  it("names every state", () => {
    expect(approvalStateLabel({ state: "pending" })).toBe("Waiting for approval");
    expect(approvalStateLabel({ state: "approved" })).toBe("Approved");
    expect(approvalStateLabel({ state: "superseded" })).toBe("Replaced by a newer commit");
    expect(approvalStateLabel({ state: "closed" })).toBe("Change request closed");
  });
});
