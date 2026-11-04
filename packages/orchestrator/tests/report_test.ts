// The report composer, pure — and the one property that is a security control, not a
// formatting choice: the provenance block exists on EVERY path.

import { test } from "bun:test";
import { assert, assertStringIncludes } from "@std/assert";
import { composeReport } from "../src/core/report.ts";

const BASE = {
  runId: "r-1",
  agentName: "Ada",
  summary: "Fixed the flaky test by pinning the clock.",
  branches: [{
    path: "app",
    commits: [
      { sha: "abc123def4567890", subject: "pin the clock in flaky_test" },
      { sha: "fedcba9876543210", subject: "regenerate lockfile" },
    ],
  }],
  noChanges: false,
};

test("a user-requested report carries summary, commits, and the requester's login", () => {
  const md = composeReport({
    ...BASE,
    provenance: { origin: "user", requestedByLogin: "ada-lovelace", requestedVia: null },
  });
  assertStringIncludes(md, "Fixed the flaky test");
  assertStringIncludes(md, "`abc123def4` pin the clock in flaky_test");
  assert(md.startsWith(
    "<sub>Proposed by **Ada**, a Ryph agent · requested by **@ada-lovelace**</sub>\n\n",
  ));
  assert(!md.includes("Provenance"), "no trailing provenance block");
  assert(!md.includes("unreviewed agent output"));
  assert(!md.includes("[Run]"));
});

test("attribution links the task and precedes the patch description and summary", () => {
  const md = composeReport({
    ...BASE,
    agentName: "A**da\n<bot>",
    runUrl: "https://ryph.example/tasks/t-1",
    description: "<!-- description",
    provenance: { origin: "user", requestedByLogin: null, requestedVia: null },
  });
  assert(md.startsWith(
    "<sub>Proposed by **A\\*\\*da \\<bot\\>**, a Ryph agent · " +
      "[Run](https://ryph.example/tasks/t-1) · " +
      "requested by a ryph user with no linked GitHub account</sub>\n\n<!-- description\n\nFixed the flaky test",
  ));
  assert(!md.includes("unreviewed agent output"));
});

test("break-glass is a loud positive statement, never an omission", () => {
  const md = composeReport({
    ...BASE,
    provenance: { origin: "break-glass", requestedByLogin: null, requestedVia: null },
  });
  assertStringIncludes(md, "break-glass API access");
  assertStringIncludes(md, "bypassed the normal permission gate");
});

test("the provenance block survives every degenerate input", () => {
  const md = composeReport({
    runId: "r-1",
    agentName: "Ada",
    summary: "",
    branches: [],
    noChanges: false,
    provenance: { origin: "user", requestedByLogin: null, requestedVia: null },
  });
  assert(md.startsWith("<sub>Proposed by **Ada**, a Ryph agent · requested by "));
  assertStringIncludes(md, "no linked GitHub account");
  assert(!md.includes("### Commits"), "no empty sections");
});

test("a summary the agent already posted in the thread gives way to one line pointing there", () => {
  const md = composeReport({
    ...BASE,
    summaryInThread: true,
    provenance: { origin: "forge", requestedByLogin: "grace", requestedVia: null },
  });
  assert(!md.includes("Fixed the flaky test"), "the summary is not said twice");
  assertStringIncludes(md, "_**Ada** posted what it did in this thread._");
  assertStringIncludes(md, "`abc123def4` pin the clock in flaky_test");
  assertStringIncludes(md, "requested by **@grace** via a /ryph command</sub>");
});

test("a no-changes success says so where the commits would be", () => {
  const md = composeReport({
    runId: "r-1",
    agentName: "Ada",
    summary: "Triaged the open issues and assigned the actionable ones.",
    branches: [],
    noChanges: true,
    provenance: { origin: "user", requestedByLogin: "ada-lovelace", requestedVia: null },
  });
  assertStringIncludes(md, "_No code changes were needed._");
  assert(!md.includes("### Commits"), "no empty sections");
});

test("a change across several repos lists each part under its directory, and says they land apart", () => {
  const md = composeReport({
    ...BASE,
    branches: [
      { path: "api", commits: [{ sha: "a".repeat(40), subject: "add the field" }] },
      { path: "web", commits: [{ sha: "b".repeat(40), subject: "show the field" }] },
      { path: "docs", commits: [] },
    ],
    provenance: { origin: "user", requestedByLogin: "ada-lovelace", requestedVia: null },
  });
  assertStringIncludes(md, "### Commits in `api/`");
  assertStringIncludes(md, "### Commits in `web/`");
  assert(!md.includes("`docs/`"), "a repo with no commits is not a part");
  assertStringIncludes(md, "land independently");
});

test("two lines of one repo are told apart by line, and never called several repositories", () => {
  const md = composeReport({
    ...BASE,
    branches: [
      { path: "app", line: "work", commits: [{ sha: "a".repeat(40), subject: "add the field" }] },
      { path: "app", line: "fix", commits: [{ sha: "b".repeat(40), subject: "fix the typo" }] },
    ],
    provenance: { origin: "user", requestedByLogin: "ada-lovelace", requestedVia: null },
  });
  assertStringIncludes(md, "### Commits in `app/` on line `work`");
  assertStringIncludes(md, "### Commits in `app/` on line `fix`");
  assert(!md.includes("several repositories"), "one repository is not several");
  assertStringIncludes(md, "land independently");
});

test("a repo with one line of the default name is labelled by its path alone", () => {
  const md = composeReport({
    ...BASE,
    branches: [
      { path: "api", line: "work", commits: [{ sha: "a".repeat(40), subject: "add the field" }] },
      { path: "web", line: "work", commits: [{ sha: "b".repeat(40), subject: "show the field" }] },
      { path: "web", line: "docs", commits: [{ sha: "c".repeat(40), subject: "document it" }] },
    ],
    provenance: { origin: "user", requestedByLogin: "ada-lovelace", requestedVia: null },
  });
  assertStringIncludes(md, "### Commits in `api/`\n");
  assertStringIncludes(md, "### Commits in `web/` on line `work`");
  assertStringIncludes(md, "### Commits in `web/` on line `docs`");
  assertStringIncludes(md, "several repositories");
});

const PROVENANCE = {
  origin: "user",
  requestedByLogin: "ada-lovelace",
  requestedVia: null,
} as const;

test("the other parts of a set are counted, never named", () => {
  const md = composeReport({ ...BASE, otherParts: 2, provenance: PROVENANCE });
  assertStringIncludes(md, "**Part of a set.** This run also changed 2 other repositories");
  assertStringIncludes(md, "listed on the run's task in ryph");
  assertStringIncludes(md, "· requested by **@ada-lovelace**</sub>");
  const one = composeReport({ ...BASE, otherParts: 1, provenance: PROVENANCE });
  assertStringIncludes(one, "1 other repository —");
  assert(
    !composeReport({ ...BASE, otherParts: 0, provenance: PROVENANCE }).includes("Part of a set"),
  );
});

test("a chat run's provenance names who asked, and whose command room it came through", () => {
  const md = composeReport({
    ...BASE,
    provenance: { origin: "chat", requestedByLogin: "ada-lovelace", requestedVia: "Grace" },
  });
  assertStringIncludes(
    md,
    "requested by `Grace`'s mention in **@ada-lovelace**'s command room</sub>",
  );
});

test("a requester named by their ryph name is plain text, never an @-mention", () => {
  // GitHub's user mode: every user's login is the token owner's, so the name stands instead.
  const md = composeReport({
    ...BASE,
    provenance: {
      origin: "user",
      requestedByLogin: null,
      requestedByName: "Grace Hopper",
      requestedVia: null,
    },
  });
  assertStringIncludes(md, "· requested by ryph user `Grace Hopper`</sub>");
  assert(!md.includes("@"), "nobody is mentioned");
  const automation = composeReport({
    ...BASE,
    provenance: {
      origin: "automation",
      requestedByLogin: null,
      requestedByName: "Grace Hopper",
      requestedVia: null,
    },
  });
  assertStringIncludes(automation, "requested by ryph user `Grace Hopper`'s automation</sub>");
});

test("a requester's name that reads as a domain is a code span, which GitHub never links", () => {
  // `chatDisplayName` keeps letters and dots, so a name can be a host GitHub would autolink in
  // bold text. In a code span it is only text.
  const md = composeReport({
    ...BASE,
    provenance: {
      origin: "user",
      requestedByLogin: null,
      requestedByName: "www.evil.example",
      requestedVia: null,
    },
  });
  assertStringIncludes(md, "requested by ryph user `www.evil.example`</sub>");
  assert(!md.includes("**www.evil.example**"));
  const chat = composeReport({
    ...BASE,
    provenance: {
      origin: "chat",
      requestedByLogin: "ada-lovelace",
      requestedVia: "www.evil.example",
    },
  });
  assertStringIncludes(chat, "requested by `www.evil.example`'s mention");
});
