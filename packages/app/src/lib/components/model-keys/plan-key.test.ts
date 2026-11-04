import { describe, expect, it } from "vitest";
import { planAccountLine, planStatusBadge, planTypeLabel } from "./plan-key";

const plan = {
  email: "ana@example.com",
  planType: "pro",
  status: "active" as const,
  limitedAt: null,
  models: [],
};

describe("planTypeLabel", () => {
  it("capitalises the plan, and is null when there is none", () => {
    expect(planTypeLabel("plus")).toBe("Plus");
    expect(planTypeLabel(" ")).toBeNull();
    expect(planTypeLabel(null)).toBeNull();
  });
});

describe("planAccountLine", () => {
  it("joins what is known", () => {
    expect(planAccountLine(plan)).toBe("ana@example.com · Pro");
    expect(planAccountLine({ ...plan, planType: null })).toBe("ana@example.com");
    expect(planAccountLine({ ...plan, email: null, planType: null })).toBeNull();
  });
  it("reads well for a member, who is not shown the account", () => {
    expect(planAccountLine({ ...plan, email: null })).toBe("Pro");
  });
});

describe("planStatusBadge", () => {
  it("names each status plainly", () => {
    expect(planStatusBadge("active").label).toBe("Active");
    expect(planStatusBadge("needs_reauth")).toEqual({
      label: "Needs sign-in",
      variant: "destructive",
    });
    expect(planStatusBadge("limited").label).toBe("Usage limit reached");
  });
});
