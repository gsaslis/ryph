// The forge policy resolved against a run: which repos, which thread, which tools the gateway
// lists — and that the platform forge row joins a run's tool scope only through the policy.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  composeForgeScope,
  forgeAllowedTools,
  forgeCapFor,
  LABEL_ACTIONS_MAX,
} from "../src/core/forge_tools.ts";
import { composeToolScope } from "../src/core/start_task.ts";
import type { ConnectedRepo, ForgePolicy } from "../src/core/types.ts";
import { ForgePolicySchema } from "../src/schema.ts";

const POLICY: ForgePolicy = {
  repos: "run",
  read: true,
  createIssues: { max: 5 },
  comment: { where: "origin", max: 20 },
  review: null,
  closeIssues: { where: "any", max: 10 },
  labels: ["bug"],
};

/** The half of a connected repo the forge scope is composed from; the rest is beside the point
 * here. */
const REPO: ConnectedRepo = {
  id: "",
  provider: "github" as const,
  installationId: "7",
  repoRef: "",
  url: "",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const API: ConnectedRepo = { ...REPO, id: "cr-api", repoRef: "acme/api" };
const INFRA: ConnectedRepo = { ...REPO, id: "cr-infra", repoRef: "acme/infra" };
const PROVENANCE = { agentName: "Ada", runUrl: null, requestedBy: "grace", requestedVia: null };

test("the allowlist is derived from the capabilities, never chosen", () => {
  assertEquals(forgeAllowedTools(POLICY), [
    "get_issue",
    "list_issues",
    "get_change_request",
    "compare_change_request",
    "list_change_requests",
    "create_issue",
    "add_comment",
    "add_labels",
    "close_issue",
  ]);
  assertEquals(
    forgeAllowedTools({
      ...POLICY,
      read: false,
      labels: [],
      createIssues: null,
      closeIssues: null,
    }),
    ["add_comment"],
  );
});

test("each write counts against its own cap; labelling against the fixed ceiling", () => {
  assertEquals(forgeCapFor(POLICY, "create_issue"), 5);
  assertEquals(forgeCapFor(POLICY, "add_comment"), 20);
  assertEquals(forgeCapFor(POLICY, "submit_review"), null);
  assertEquals(forgeCapFor(POLICY, "close_issue"), 10);
  assertEquals(forgeCapFor(POLICY, "add_labels"), LABEL_ACTIONS_MAX);
  assertEquals(forgeCapFor({ ...POLICY, labels: [] }, "add_labels"), null);
});

test("a run policy scopes the run's own connected repos; a list scopes the list", () => {
  const origin = { connectedRepoId: "cr-api", kind: "issue" as const, ref: "12" };
  const run = composeForgeScope({
    policy: POLICY,
    runRepos: [API, API],
    listedRepos: [INFRA],
    origin,
    provenance: PROVENANCE,
  });
  assertEquals(run?.repos, [{
    connectedRepoId: "cr-api",
    provider: "github" as const,
    repoRef: "acme/api",
    tenantId: "7",
  }]);
  assertEquals(run?.origin, origin);
  assertEquals(run?.sourceRepos.map((r) => r.repoRef), ["acme/api"]);

  const listed = composeForgeScope({
    policy: { ...POLICY, repos: { connectedRepoIds: ["cr-infra"] } },
    runRepos: [API],
    listedRepos: [INFRA],
    origin,
    provenance: PROVENANCE,
  });
  assertEquals(listed?.repos.map((r) => r.repoRef), ["acme/infra"]);
  // The origin's repo is outside the list, so the run has no thread there to call its own.
  assertEquals(listed?.origin, null);
  // ...but the checkout still rides the scope: a list policy replaces what the run may write to,
  // never what it has read, and the forge's visibility rule is decided on both.
  assertEquals(listed?.sourceRepos.map((r) => r.repoRef), ["acme/api"]);
});

test("a checked-out target grants comments independently of origin, only inside scope", () => {
  const origin = { connectedRepoId: API.id, kind: "issue" as const, ref: "12" };
  for (const connectedRepoId of [API.id, INFRA.id]) {
    const scope = composeForgeScope({
      policy: POLICY,
      runRepos: [API],
      listedRepos: [],
      origin,
      targetChangeRequest: { connectedRepoId, thread: "40" },
      provenance: PROVENANCE,
    });
    assertEquals(scope?.origin, origin);
    assertEquals(
      scope?.workedChangeRequests ?? [],
      connectedRepoId === API.id ? [{ connectedRepoId, ref: "40" }] : [],
    );
  }
});

test("a policy with no repo left to act on grants nothing", () => {
  assertEquals(
    composeForgeScope({
      policy: POLICY,
      runRepos: [],
      listedRepos: [],
      origin: null,
      provenance: PROVENANCE,
    }),
    null,
  );
});

test("the scope is a copy: editing the policy afterwards changes nothing", () => {
  const policy = structuredClone(POLICY);
  const scope = composeForgeScope({
    policy,
    runRepos: [API],
    listedRepos: [],
    origin: null,
    provenance: PROVENANCE,
  })!;
  policy.labels.push("security");
  policy.createIssues!.max = 50;
  assertEquals(scope.capabilities.labels, ["bug"]);
  assertEquals(scope.capabilities.createIssues, { max: 5 });
});

test("the forge row joins the tool scope with the derived allowlist, replacing any other", () => {
  const scope = composeToolScope(
    {
      toolPolicy: { servers: [{ serverId: "ms-platform-forge", allowedTools: "*" }] },
      memoryPolicy: null,
      harnessKind: "pi",
    },
    null,
    false,
    null,
    { serverId: "ms-platform-forge", allowedTools: ["get_issue"] },
  );
  assertEquals(scope, {
    servers: [{ serverId: "ms-platform-forge", allowedTools: ["get_issue"] }],
  });
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: null, harnessKind: "echo" },
      null,
      false,
      null,
      { serverId: "ms-platform-forge", allowedTools: ["get_issue"] },
    ),
    null,
    "a harness that cannot drive tools gets none",
  );
});

test("the policy schema refuses a policy that grants nothing, and caps past the ceiling", () => {
  assert(ForgePolicySchema.safeParse(POLICY).success);
  assertEquals(
    ForgePolicySchema.safeParse({
      ...POLICY,
      read: false,
      createIssues: null,
      comment: null,
      closeIssues: null,
      labels: [],
    }).success,
    false,
  );
  // closing alone is a grant
  assert(
    ForgePolicySchema.safeParse({
      ...POLICY,
      read: false,
      createIssues: null,
      comment: null,
      labels: [],
    }).success,
  );
  assertEquals(
    ForgePolicySchema.safeParse({ ...POLICY, createIssues: { max: 51 } }).success,
    false,
  );
  assertEquals(ForgePolicySchema.safeParse({ ...POLICY, createIssues: { max: 0 } }).success, false);
  assertEquals(ForgePolicySchema.safeParse({ ...POLICY, labels: ["Bug", "bug"] }).success, false);
});

test("a fork-head run reads its own repo and writes only in its own thread, whatever the policy", () => {
  const origin = { connectedRepoId: "cr-api", kind: "change_request" as const, ref: "7" };
  const scope = composeForgeScope({
    policy: {
      ...POLICY,
      repos: { connectedRepoIds: ["cr-infra"] },
      comment: { where: "any", max: 20 },
      review: { where: "any", max: 3 },
    },
    runRepos: [API],
    listedRepos: [INFRA],
    origin,
    confined: true,
    provenance: PROVENANCE,
  });
  assertEquals(scope?.repos.map((r) => r.repoRef), ["acme/api"]);
  assertEquals(scope?.origin, origin);
  assertEquals(scope?.capabilities, {
    read: true,
    createIssues: null,
    comment: { where: "origin", max: 20 },
    review: { where: "origin", max: 3 },
    closeIssues: null,
    labels: [],
  });
  assertEquals(forgeAllowedTools(scope!.capabilities).toSorted(), [
    "add_comment",
    "compare_change_request",
    "get_change_request",
    "get_issue",
    "list_change_requests",
    "list_issues",
    "submit_review",
  ]);
});

test("a fork-head run's tool scope is the confined forge row and the web row, never the agent's own servers", () => {
  const agent = {
    toolPolicy: {
      servers: [
        { serverId: "ms-github-pat", allowedTools: "*" as const },
        { serverId: "ms-slack", allowedTools: ["post_message"] },
        { serverId: "ms-platform-web", allowedTools: ["fetch"] },
        { serverId: "ms-platform-memory", allowedTools: "*" as const },
      ],
    },
    memoryPolicy: { budgetTokens: 1000 },
    harnessKind: "pi" as const,
  };
  const forge = { serverId: "ms-platform-forge", allowedTools: ["get_issue", "add_comment"] };
  const web = { serverId: "ms-platform-web", served: true };
  assertEquals(
    composeToolScope(agent, "ms-platform-memory", true, "ms-platform-chat", forge, web, true),
    {
      servers: [
        { serverId: "ms-platform-web", allowedTools: ["fetch"] },
        { serverId: "ms-platform-forge", allowedTools: ["get_issue", "add_comment"] },
      ],
    },
    "the policy's entry narrowing the web row is kept; nothing else of the agent's is",
  );
  // The same agent on its own repo keeps every server its policy names.
  const ordinary = composeToolScope(
    agent,
    "ms-platform-memory",
    true,
    "ms-platform-chat",
    forge,
    web,
  );
  assertEquals(
    ordinary?.servers.map((s) => s.serverId),
    [
      "ms-github-pat",
      "ms-slack",
      "ms-platform-web",
      "ms-platform-memory",
      "ms-platform-chat",
      "ms-platform-forge",
    ],
  );
});
