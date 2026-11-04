import { describe, expect, it } from "vitest";
import { parseLastPicks } from "./last-picks";

const none = { agentId: null, source: null, connectedRepoId: null, workspaceId: null };

describe("parseLastPicks", () => {
  it("reads what was stored", () => {
    const picks = { agentId: "a", source: "workspace", connectedRepoId: "r", workspaceId: "w" };
    expect(parseLastPicks(JSON.stringify(picks))).toEqual(picks);
  });

  it("knows nothing from nothing, or from what is not JSON", () => {
    expect(parseLastPicks(null)).toEqual(none);
    expect(parseLastPicks("{nope")).toEqual(none);
    expect(parseLastPicks("null")).toEqual(none);
    expect(parseLastPicks("42")).toEqual(none);
  });

  it("drops fields of the wrong shape", () => {
    expect(parseLastPicks(JSON.stringify({ agentId: 7, source: "url", workspaceId: "w" })))
      .toEqual({ ...none, workspaceId: "w" });
  });
});
