import { describe, expect, it } from "vitest";
import type { McpServer } from "$lib/api/types";
import {
  annotationHints,
  composeToolPolicy,
  isAllowlistable,
  noToolsLabel,
  policyToGrants,
  toolPolicyProblem,
  withDefaultOff,
  withEveryTool,
  withTool,
} from "./tool-policy";

const server = (id: string, name: string, archivedAt: string | null = null): McpServer => ({
  id,
  slug: name.toLowerCase(),
  name,
  description: null,
  transport: "http",
  kind: "remote",
  url: `https://${name.toLowerCase()}.example/mcp`,
  auth: "bearer",
  authLast4: "abcd",
  catalogueId: null,
  custom: null,
  settings: null,
  host: null,
  archivedAt,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
});

describe("compose and seed round-trip", () => {
  it("no grants is no tool access", () => {
    expect(composeToolPolicy([])).toBeNull();
    expect(policyToGrants(null)).toEqual([]);
  });

  it("keeps each server's allowlist, '*' included", () => {
    const grants = [
      { serverId: "ms-1", allowedTools: ["search", "create_issue"] },
      { serverId: "ms-2", allowedTools: "*" as const },
    ];
    const policy = composeToolPolicy(grants);
    expect(policy).toEqual({ servers: grants });
    expect(policyToGrants(policy)).toEqual(grants);
  });
});

describe("toolPolicyProblem", () => {
  const servers = [server("ms-1", "Linear"), server("ms-2", "GitHub", "2026-09-09T00:00:00Z")];

  it("passes a policy the orchestrator would accept", () => {
    expect(toolPolicyProblem([{ serverId: "ms-1", allowedTools: ["search"] }], servers)).toBeNull();
    expect(toolPolicyProblem([{ serverId: "ms-1", allowedTools: "*" }], servers)).toBeNull();
  });

  // The orchestrator refuses an archived server by id; the form should say so by name first.
  it("names an archived server", () => {
    expect(toolPolicyProblem([{ serverId: "ms-2", allowedTools: "*" }], servers)).toMatch(
      /"GitHub" is archived/,
    );
  });

  // An empty explicit list would SAVE — the gateway's grammar allows it — as access that grants
  // nothing. Refusing it here keeps "the server is listed" and "the agent can call something"
  // the same fact.
  it("refuses a server with nothing ticked", () => {
    expect(toolPolicyProblem([{ serverId: "ms-1", allowedTools: [] }], servers)).toMatch(
      /Tick at least one tool on "Linear"/,
    );
  });

  // The platform's rows are granted by default, so "remove the row" does not mean "no access" —
  // it means "whatever the deployment gives everyone". An empty list is the only way to write
  // down the opt-out, and it has a real effect: the gateway denies every tool on the row and
  // hides all of them from tools/list.
  it("takes an empty list on a platform row as the opt-out it is", () => {
    const platform = { ...server("ms-platform-web", "Web"), kind: "platform" as const };
    expect(toolPolicyProblem([{ serverId: "ms-platform-web", allowedTools: [] }], [platform]))
      .toBeNull();
    expect(noToolsLabel(platform)).toBe("No tools from this server");
  });

  it("still refuses an empty list on an operator's server", () => {
    expect(toolPolicyProblem([{ serverId: "ms-1", allowedTools: [] }], servers)).toMatch(
      /Tick at least one tool on "Linear"/,
    );
    expect(noToolsLabel(servers[0])).toBeNull();
  });

  it("falls back to the id for a server the list cannot resolve", () => {
    expect(toolPolicyProblem([{ serverId: "ms-9", allowedTools: [] }], servers)).toMatch(
      /server ms-9/,
    );
  });
});

describe("editing one grant", () => {
  it("ticks and unticks a tool without reordering the rest", () => {
    const grant = { serverId: "ms-1", allowedTools: ["a", "b"] };
    expect(withTool(grant, "c", true).allowedTools).toEqual(["a", "b", "c"]);
    expect(withTool(grant, "a", false).allowedTools).toEqual(["b"]);
    // Ticking an already-ticked tool is a no-op, not a duplicate.
    expect(withTool(grant, "a", true).allowedTools).toEqual(["b", "a"]);
  });

  it("leaves an every-tool grant alone when one tool is toggled", () => {
    const grant = { serverId: "ms-1", allowedTools: "*" as const };
    expect(withTool(grant, "a", false)).toEqual(grant);
  });

  // Coming off "*" the operator should see what they now have, not an empty list that saves as
  // nothing — so the known names (the probe's) become the explicit list.
  it("switches between every tool and the visible list", () => {
    const explicit = { serverId: "ms-1", allowedTools: ["a"] };
    expect(withEveryTool(explicit, true, ["a", "b"]).allowedTools).toBe("*");
    expect(withEveryTool({ ...explicit, allowedTools: "*" }, false, ["a", "b"]).allowedTools)
      .toEqual(["a", "b"]);
    // Already explicit: the list is the operator's, and stays.
    expect(withEveryTool(explicit, false, ["a", "b"]).allowedTools).toEqual(["a"]);
  });
});

describe("what the picker can show", () => {
  it("knows the gateway's tool-name grammar", () => {
    expect(isAllowlistable("create_issue")).toBe(true);
    expect(isAllowlistable("v2.search-all")).toBe(true);
    expect(isAllowlistable("has space")).toBe(false);
    expect(isAllowlistable("")).toBe(false);
  });

  // Only explicit claims: the spec's defaults are what a server says by saying nothing.
  it("turns explicit annotations into hints and silence into none", () => {
    expect(annotationHints(null)).toEqual([]);
    expect(annotationHints({})).toEqual([]);
    expect(annotationHints({ readOnlyHint: true, destructiveHint: false })).toEqual([
      { label: "read-only", tone: "note" },
      { label: "non-destructive", tone: "note" },
    ]);
    expect(annotationHints({ destructiveHint: true, openWorldHint: true })).toEqual([
      { label: "destructive", tone: "warn" },
      { label: "open world", tone: "warn" },
    ]);
  });
});

describe("withDefaultOff", () => {
  const fresh = { serverId: "ms-1", allowedTools: "*" as const };
  const reported = ["list_issues", "create_issue", "get_issue", "list_issues", "bad name"];

  it("ticks every reported tool except the entry's write tools", () => {
    expect(withDefaultOff(fresh, reported, ["create_issue"])).toEqual({
      serverId: "ms-1",
      allowedTools: ["list_issues", "get_issue"],
    });
  });

  it("goes explicit even when no write tool is reported, so a later one stays off", () => {
    expect(withDefaultOff(fresh, ["get_issue"], ["delete_issue"]).allowedTools).toEqual([
      "get_issue",
    ]);
  });

  it("leaves a grant alone when the entry names nothing, or someone already chose", () => {
    expect(withDefaultOff(fresh, reported, [])).toEqual(fresh);
    const chosen = { serverId: "ms-1", allowedTools: ["create_issue"] };
    expect(withDefaultOff(chosen, reported, ["create_issue"])).toEqual(chosen);
  });
});

describe("a grant pending its default-off narrowing", () => {
  const linear = server("ms-1", "Linear");
  const pending = {
    serverId: "ms-1",
    allowedTools: "*" as const,
    pendingDefaultOff: true as const,
  };

  it("cannot be saved as every tool", () => {
    expect(toolPolicyProblem([pending], [linear])).toBe(
      'Check the tools on "Linear" before saving.',
    );
  });

  it("is never sent", () => {
    expect(composeToolPolicy([pending])).toEqual({
      servers: [{ serverId: "ms-1", allowedTools: "*" }],
    });
  });

  it("saves once the probe narrowed it", () => {
    const narrowed = withDefaultOff(pending, ["get_issue", "create_issue"], ["create_issue"]);
    expect(narrowed).toEqual({ serverId: "ms-1", allowedTools: ["get_issue"] });
    expect(toolPolicyProblem([narrowed], [linear])).toBeNull();
  });

  it("saves once the operator picks every tool or a tool", () => {
    const every = withEveryTool(pending, true, []);
    expect(every).toEqual({ serverId: "ms-1", allowedTools: "*" });
    expect(toolPolicyProblem([every], [linear])).toBeNull();

    const listed = withTool(withEveryTool(pending, false, []), "get_issue", true);
    expect(listed).toEqual({ serverId: "ms-1", allowedTools: ["get_issue"] });
    expect(toolPolicyProblem([listed], [linear])).toBeNull();
  });
});
