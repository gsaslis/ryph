import { describe, expect, it } from "vitest";
import { defaultAgentEmail, effectiveEmail, expectedHandle, identityProblem } from "./agent-steps";

/** The host the app is served at on one cell. */
const HOST = "ryph.example.com";

describe("identityProblem", () => {
  it("wants a name, lets the handle be derived, and lets the email default", () => {
    expect(identityProblem("", "", "ada@example.com", HOST)).toMatch(/name/);
    expect(identityProblem("Ada", "", "", HOST)).toBeNull();
    expect(identityProblem("Ada", "", "not-an-email", HOST)).toMatch(/email/);
    expect(identityProblem("Ada", "", "ada@example.com", HOST)).toBeNull();
  });

  it("holds a typed handle to the command grammar", () => {
    expect(identityProblem("Ada", "Ada Lovelace", "ada@example.com", HOST)).toMatch(/handle/);
    expect(identityProblem("Ada", "-ada", "ada@example.com", HOST)).toMatch(/handle/);
    expect(identityProblem("Ada", "a".repeat(40), "ada@example.com", HOST)).toMatch(/handle/);
    expect(identityProblem("Ada", "ada-2", "ada@example.com", HOST)).toBeNull();
  });
});

describe("the default email", () => {
  it("is the handle at the deployment's host, derived as the server derives it", () => {
    expect(expectedHandle("Ada Lovelace", "")).toBe("ada-lovelace");
    expect(expectedHandle("Ada Lovelace", "ada")).toBe("ada");
    expect(expectedHandle("A very long name that runs past thirty characters", "")).toBe(
      "a-very-long-name-that-runs-pas",
    );
    expect(expectedHandle("   ", "")).toBeNull();
    expect(defaultAgentEmail("Ada Lovelace", "", HOST)).toBe("ada-lovelace@ryph.example.com");
    expect(defaultAgentEmail("", "", HOST)).toBeNull();
  });

  it("falls back to a reserved domain where the host is not a domain name", () => {
    expect(defaultAgentEmail("Ada", "", "localhost")).toBe("ada@ryph.localhost");
    expect(defaultAgentEmail("Ada", "", "127.0.0.1")).toBe("ada@ryph.localhost");
    expect(defaultAgentEmail("Ada", "", "[::1]")).toBe("ada@ryph.localhost");
    expect(defaultAgentEmail("Ada", "", "devbox")).toBe("ada@ryph.localhost");
  });

  it("yields to a typed email", () => {
    expect(effectiveEmail("Ada", "", "", HOST)).toBe("ada@ryph.example.com");
    expect(effectiveEmail("Ada", "", " ada@example.com ", HOST)).toBe("ada@example.com");
  });
});
