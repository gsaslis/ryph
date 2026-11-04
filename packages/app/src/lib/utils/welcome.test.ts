import { describe, expect, it } from "vitest";
import { isFreshInstance, mayBeWelcomed, welcomeFlagIn } from "./welcome";

describe("welcomeFlagIn", () => {
  it("finds the flag among other cookies", () => {
    expect(welcomeFlagIn("sidebar_state=true; ryph_welcome=done")).toBe(true);
    expect(welcomeFlagIn("ryph_welcome=done")).toBe(true);
  });

  it("does not mistake a cookie whose name only starts the same", () => {
    expect(welcomeFlagIn("ryph_welcomed=1; other=ryph_welcome")).toBe(false);
    expect(welcomeFlagIn("")).toBe(false);
  });
});

describe("mayBeWelcomed", () => {
  it("welcomes an owner and an operator, never a member", () => {
    expect(mayBeWelcomed({ caps: ["*"] })).toBe(true);
    expect(mayBeWelcomed({ caps: ["models:manage", "agents:write"] })).toBe(true);
    expect(mayBeWelcomed({ caps: ["agents:write", "models:read"] })).toBe(false);
    expect(mayBeWelcomed(null)).toBe(false);
  });
});

describe("isFreshInstance", () => {
  it("is fresh only with no key and no agent", () => {
    expect(isFreshInstance({ keys: 0, agents: 0 })).toBe(true);
    expect(isFreshInstance({ keys: 1, agents: 0 })).toBe(false);
    expect(isFreshInstance({ keys: 0, agents: 1 })).toBe(false);
  });
});
