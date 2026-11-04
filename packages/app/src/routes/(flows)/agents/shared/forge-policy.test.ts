import { describe, expect, it } from "vitest";
import type { ConnectedRepo, McpServer } from "$lib/api/types";
import {
  composeForgePolicy,
  type ForgeFields,
  forgePolicyProblem,
  forgePolicyToFields,
  forgeToolsOffered,
  forgeToolsState,
  parseLabels,
} from "./forge-policy";

const repo = (id: string, repoRef: string, archivedAt: string | null = null): ConnectedRepo => ({
  id,
  provider: "github",
  installationId: "inst-1",
  repoRef,
  url: `https://github.com/${repoRef}`,
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
});

const forgeRow = (archivedAt: string | null = null): McpServer => ({
  id: "ms-platform-forge",
  slug: "forge",
  name: "Issues & change requests",
  description: null,
  transport: "http",
  kind: "platform",
  url: "platform://forge",
  auth: "none",
  authLast4: null,
  catalogueId: null,
  custom: null,
  settings: null,
  host: null,
  archivedAt,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
});

/** A new agent's fields with `patch` on top. */
const fields = (patch: Partial<ForgeFields> = {}): ForgeFields => ({
  ...forgePolicyToFields(null),
  ...patch,
});

describe("compose and seed round-trip", () => {
  // The orchestrator refuses a policy granting nothing: null is the only way to say "none".
  it("granting nothing is no forge tools", () => {
    expect(composeForgePolicy(fields())).toBeNull();
    // Settings on an unticked capability grant nothing either.
    expect(composeForgePolicy(fields({ repoMode: "list", commentWhere: "any", labels: " , " })))
      .toBeNull();
  });

  it("pre-fills the default caps and 'origin', so ticking shows what will be saved", () => {
    expect(forgePolicyToFields(null)).toEqual({
      repoMode: "run",
      connectedRepoIds: [],
      read: false,
      createIssues: false,
      createIssuesMax: "5",
      comment: false,
      commentWhere: "origin",
      commentMax: "20",
      review: false,
      reviewWhere: "origin",
      reviewMax: "5",
      closeIssues: false,
      closeIssuesWhere: "origin",
      closeIssuesMax: "10",
      labels: "",
    });
    expect(composeForgePolicy(fields({ createIssues: true, comment: true, review: true })))
      .toEqual({
        repos: "run",
        read: false,
        createIssues: { max: 5 },
        comment: { where: "origin", max: 20 },
        review: { where: "origin", max: 5 },
        closeIssues: null,
        labels: [],
      });
    expect(composeForgePolicy(fields({ closeIssues: true }))?.closeIssues).toEqual({
      where: "origin",
      max: 10,
    });
  });

  it("keeps a full policy through seed and compose", () => {
    const policy = {
      repos: { connectedRepoIds: ["cr-1", "cr-2"] },
      read: true,
      createIssues: { max: 3 },
      comment: { where: "any" as const, max: 7 },
      review: null,
      closeIssues: { where: "any" as const, max: 30 },
      labels: ["bug", "needs triage"],
    };
    expect(composeForgePolicy(forgePolicyToFields(policy))).toEqual(policy);
  });

  // Labels alone are a grant: they allow add_labels.
  it("counts labels alone as a grant, and a blank cap as the default", () => {
    expect(composeForgePolicy(fields({ labels: "bug" }))?.labels).toEqual(["bug"]);
    expect(composeForgePolicy(fields({ comment: true, commentMax: " " }))?.comment).toEqual({
      where: "origin",
      max: 20,
    });
  });

  it("drops repeated repo ids", () => {
    expect(
      composeForgePolicy(fields({ read: true, repoMode: "list", connectedRepoIds: ["a", "a"] }))
        ?.repos,
    ).toEqual({ connectedRepoIds: ["a"] });
  });
});

describe("parseLabels", () => {
  // The orchestrator refuses the same label twice in any case; the first spelling is kept.
  it("trims, drops blanks and repeats regardless of case", () => {
    expect(parseLabels(" bug, Bug ,, needs triage ,BUG")).toEqual(["bug", "needs triage"]);
    expect(parseLabels("")).toEqual([]);
  });
});

describe("forgePolicyProblem", () => {
  const repos = [repo("cr-1", "acme/api"), repo("cr-2", "acme/web", "2026-09-09T00:00:00Z")];

  it("passes fields the orchestrator would accept, and fields granting nothing", () => {
    expect(forgePolicyProblem(fields({ read: true }), repos)).toBeNull();
    expect(
      forgePolicyProblem(
        fields({ comment: true, commentMax: "50", repoMode: "list", connectedRepoIds: ["cr-1"] }),
        repos,
      ),
    ).toBeNull();
    // Nothing granted saves as null, whatever the unticked settings say.
    expect(forgePolicyProblem(fields({ repoMode: "list", commentMax: "900" }), repos)).toBeNull();
  });

  it("asks for a repo when the list is chosen and empty", () => {
    expect(forgePolicyProblem(fields({ read: true, repoMode: "list" }), repos)).toMatch(
      /Pick at least one repository/,
    );
  });

  it("names a disconnected repo, and falls back to the id for one the list cannot resolve", () => {
    const list = (id: string) => fields({ read: true, repoMode: "list", connectedRepoIds: [id] });
    expect(forgePolicyProblem(list("cr-2"), repos)).toMatch(/"acme\/web" is disconnected/);
    expect(forgePolicyProblem(list("cr-9"), repos)).toMatch(/Repository cr-9 is not connected/);
  });

  it("names a disconnected Radicle repo by the same label the rest of the app shows", () => {
    const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
    const radicle: ConnectedRepo = {
      ...repo("cr-3", rid, "2026-09-09T00:00:00Z"),
      provider: "radicle",
      installationId: null,
      url: "",
    };
    const problem = forgePolicyProblem(
      fields({ read: true, repoMode: "list", connectedRepoIds: ["cr-3"] }),
      [radicle],
    );
    // Shortened, never the whole 30-odd characters of a RID in the middle of a sentence.
    expect(problem).toMatch(/"rad:z3gq…azv5" is disconnected/);
  });

  it("refuses a repo on this machine, which has no issues or change requests", () => {
    const local: ConnectedRepo = {
      ...repo("cr-4", "/home/ada/app"),
      provider: "local",
      installationId: null,
      url: "/home/ada/app",
    };
    const problem = forgePolicyProblem(
      fields({ read: true, repoMode: "list", connectedRepoIds: ["cr-4"] }),
      [local],
    );
    expect(problem).toMatch(/"\/home\/ada\/app" is on this machine/);
  });

  it("refuses more than twenty repos", () => {
    const many = Array.from({ length: 21 }, (_, i) => `cr-${i}`);
    const all = many.map((id) => repo(id, `acme/${id}`));
    expect(
      forgePolicyProblem(fields({ read: true, repoMode: "list", connectedRepoIds: many }), all),
    ).toMatch(/at most 20 repositories/);
  });

  // Caps are required and bounded: "unlimited" is exactly what a looping model would spend.
  it("refuses a cap outside 1 to 50 on a ticked capability only", () => {
    expect(forgePolicyProblem(fields({ createIssues: true, createIssuesMax: "0" }), repos))
      .toMatch(/cap on issues opened/);
    expect(forgePolicyProblem(fields({ comment: true, commentMax: "51" }), repos)).toMatch(
      /cap on comments/,
    );
    expect(forgePolicyProblem(fields({ review: true, reviewMax: "2.5" }), repos))
      .toMatch(/cap on reviews/);
    expect(forgePolicyProblem(fields({ closeIssues: true, closeIssuesMax: "51" }), repos))
      .toMatch(/cap on issues closed/);
    expect(forgePolicyProblem(fields({ read: true, commentMax: "abc" }), repos)).toBeNull();
  });

  it("refuses a label longer than GitHub allows, and too many labels", () => {
    expect(forgePolicyProblem(fields({ labels: "x".repeat(51) }), repos)).toMatch(
      /longer than 50 characters/,
    );
    const many = Array.from({ length: 51 }, (_, i) => `l${i}`).join(",");
    expect(forgePolicyProblem(fields({ labels: many }), repos)).toMatch(/at most 50 labels/);
  });
});

describe("forgeToolsState", () => {
  it("is on only when the gateway answered with a live forge row", () => {
    expect(forgeToolsState("on", [forgeRow()])).toBe("on");
    expect(forgeToolsState("on", [])).toBe("off");
    expect(forgeToolsState("on", [forgeRow("2026-09-09T00:00:00Z")])).toBe("off");
  });

  // A gateway that did not answer says nothing about the forge — never read it as "off".
  it("is unknown whenever the tool surface did not answer", () => {
    expect(forgeToolsState("forbidden", [])).toBe("unknown");
    expect(forgeToolsState("unavailable", [])).toBe("unknown");
    expect(forgeToolsState("off", [])).toBe("unknown");
  });
});

describe("forgeToolsOffered", () => {
  it("is off where every way in is a repository on this machine", () => {
    expect(forgeToolsOffered(["local"])).toBe(false);
    expect(forgeToolsOffered([])).toBe(false);
  });

  it("is on where any provider has issues or change requests", () => {
    expect(forgeToolsOffered(["github", "local"])).toBe(true);
    expect(forgeToolsOffered(["radicle"])).toBe(true);
  });

  it("stays on when the providers could not be read", () => {
    expect(forgeToolsOffered(null)).toBe(true);
  });
});
