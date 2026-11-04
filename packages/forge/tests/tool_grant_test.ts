// Door ⑤'s grant check and provenance footer, as tables: every rule a grant can refuse by, and
// the footer no agent text can restyle.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkToolCall,
  gitlabThreadRef,
  isOriginThread,
  type ToolCall,
  visibilityRefusal,
} from "../src/core/tool_grant.ts";
import { actionMarker, carriesMarker, withSignature } from "../src/core/provenance.ts";
import type { ToolGrant } from "../src/core/types.ts";
import { type RepoVisibility, wholeRepoVisibility } from "../src/ports/forge_api.ts";

function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
    runId: "r-1",
    repos: [
      { connectedRepoId: "cr-api", provider: "github", repoRef: "acme/api", tenantId: "7" },
      { connectedRepoId: "cr-infra", provider: "github", repoRef: "acme/infra", tenantId: "7" },
    ],
    sourceRepos: [],
    origin: { connectedRepoId: "cr-api", kind: "issue", ref: "12" },
    opened: [],
    capabilities: {
      read: true,
      createIssues: { max: 5 },
      comment: { where: "origin", max: 20 },
      review: { where: "origin", max: 20 },
      closeIssues: { where: "origin", max: 10 },
      labels: ["bug", "Needs Triage"],
    },
    provenance: {
      agentName: "Ada",
      runUrl: "https://ryph.test/tasks/t-1",
      requestedBy: "maintainer",
      requestedVia: null,
    },
    ...overrides,
  };
}

/** Every repo of a grant as its forge would answer it, one switch each, private where named. */
function seen(g: ToolGrant, ...privateIds: string[]): Map<string, RepoVisibility> {
  return new Map(
    [...g.repos, ...g.sourceRepos].map((r) => [
      r.connectedRepoId,
      wholeRepoVisibility(privateIds.includes(r.connectedRepoId)),
    ]),
  );
}

test("a repo outside the grant is refused, naming the ones inside it", () => {
  const checked = checkToolCall(grant(), { tool: "get_issue", repo: "acme/secret" });
  assert(!checked.ok);
  assertStringIncludes(checked.reason, "acme/api, acme/infra");
});

test("repos match case-insensitively and answer with the grant's spelling", () => {
  const checked = checkToolCall(grant(), { tool: "list_issues", repo: "ACME/Api" });
  assert(checked.ok);
  assertEquals(checked.repo.repoRef, "acme/api");
});

test("each capability refuses when absent", () => {
  const none = grant({
    capabilities: {
      read: false,
      createIssues: null,
      comment: null,
      review: null,
      closeIssues: null,
      labels: [],
    },
  });
  const calls: ToolCall[] = [
    { tool: "get_change_request", repo: "acme/api" },
    { tool: "create_issue", repo: "acme/api", labels: [] },
    { tool: "add_comment", repo: "acme/api", thread: "12" },
    { tool: "add_labels", repo: "acme/api", thread: "12", labels: ["bug"] },
    { tool: "submit_review", repo: "acme/api", thread: "12" },
    { tool: "close_issue", repo: "acme/api", thread: "12", comment: false },
  ];
  for (const call of calls) {
    assertEquals(checkToolCall(none, call).ok, false, call.tool);
  }
});

test("an origin comment rule allows the origin thread and issues the run opened, only", () => {
  const g = grant({ opened: [{ connectedRepoId: "cr-infra", ref: "3" }] });
  assert(checkToolCall(g, { tool: "add_comment", repo: "acme/api", thread: "12" }).ok);
  assert(checkToolCall(g, { tool: "add_comment", repo: "acme/infra", thread: "3" }).ok);
  // The same number in the other repo is another thread.
  assertEquals(
    checkToolCall(g, { tool: "add_comment", repo: "acme/infra", thread: "12" }).ok,
    false,
  );
  const elsewhere = checkToolCall(g, { tool: "add_comment", repo: "acme/api", thread: "99" });
  assert(!elsewhere.ok);
  assertStringIncludes(elsewhere.reason, "acme/api#12, acme/infra#3");
});

test("a pull request the run opened is its own to comment on, not to review", () => {
  // The orchestrator lists the change requests a run's patches opened in `opened`
  // beside its issues, so a run waiting on feedback can answer on its own pull request.
  const g = grant({ opened: [{ connectedRepoId: "cr-api", ref: "41" }] });
  assert(checkToolCall(g, { tool: "add_comment", repo: "acme/api", thread: "41" }).ok);
  assertEquals(
    checkToolCall(g, { tool: "submit_review", repo: "acme/api", thread: "41" }).ok,
    false,
    "reviewing its own pull request stays origin-only",
  );
});

test("worked change requests grant comments only, preserving repo and visibility boundaries", () => {
  const g = grant({ workedChangeRequests: [{ connectedRepoId: "cr-api", ref: "41" }] });
  assert(checkToolCall(g, { tool: "add_comment", repo: "ACME/api", thread: "41" }).ok);
  assert(!checkToolCall(g, { tool: "add_comment", repo: "acme/infra", thread: "41" }).ok);
  assert(!checkToolCall(g, { tool: "add_comment", repo: "acme/api", thread: "42" }).ok);
  assert(!checkToolCall(g, { tool: "submit_review", repo: "acme/api", thread: "41" }).ok);
  assert(
    !checkToolCall(g, {
      tool: "close_issue",
      repo: "acme/api",
      thread: "41",
      comment: false,
    }).ok,
  );
  assert(
    !checkToolCall({ ...g, capabilities: { ...g.capabilities, comment: null } }, {
      tool: "add_comment",
      repo: "acme/api",
      thread: "41",
    }).ok,
  );
  assert(visibilityRefusal(g, seen(g, "cr-infra"), g.repos[0], "issue", "41") !== null);
  assert(!isOriginThread(g, g.repos[0], "41"));
});

test("a refused close note lists worked change requests as comment destinations", () => {
  const g = grant({
    workedChangeRequests: [{ connectedRepoId: "cr-api", ref: "41" }],
    capabilities: { ...grant().capabilities, closeIssues: { where: "any", max: 10 } },
  });
  const refused = checkToolCall(g, {
    tool: "close_issue",
    repo: "acme/api",
    thread: "42",
    comment: true,
  });
  assert(!refused.ok);
  assertStringIncludes(refused.reason, "acme/api#12, acme/api#41");
});

test("an any comment rule allows every thread of a repo in scope", () => {
  const g = grant({
    capabilities: { ...grant().capabilities, comment: { where: "any", max: 20 } },
  });
  assert(checkToolCall(g, { tool: "add_comment", repo: "acme/infra", thread: "99" }).ok);
});

test("an origin review rule needs the run to have come from that pull request", () => {
  assertEquals(
    checkToolCall(grant(), { tool: "submit_review", repo: "acme/api", thread: "12" }).ok,
    false,
    "an issue origin has no pull request to review",
  );
  const fromPr = grant({
    origin: { connectedRepoId: "cr-api", kind: "change_request", ref: "40" },
  });
  assert(checkToolCall(fromPr, { tool: "submit_review", repo: "acme/api", thread: "40" }).ok);
  assertEquals(
    checkToolCall(fromPr, { tool: "submit_review", repo: "acme/api", thread: "41" }).ok,
    false,
  );
});

test("labels are checked against the allowlist and applied as it spells them", () => {
  const ok = checkToolCall(grant(), {
    tool: "create_issue",
    repo: "acme/api",
    labels: ["BUG", "needs triage", "bug"],
  });
  assert(ok.ok);
  assertEquals(ok.labels, ["bug", "Needs Triage"]);
  const refused = checkToolCall(grant(), {
    tool: "add_labels",
    repo: "acme/api",
    thread: "12",
    labels: ["wontfix"],
  });
  assert(!refused.ok);
  assertStringIncludes(refused.reason, "bug, Needs Triage");
});

test("visibility: a run holding a private repo writes to a public one only on its origin", () => {
  const g = grant();
  const api = g.repos[0];
  const infra = g.repos[1];
  const privateInfra = seen(g, "cr-infra");
  assertEquals(
    visibilityRefusal(g, seen(g), api, "issue", null),
    null,
    "all public: anything goes",
  );
  assertEquals(
    visibilityRefusal(g, privateInfra, infra, "issue", null),
    null,
    "writing INTO private is fine",
  );
  assertEquals(
    visibilityRefusal(g, privateInfra, api, "issue", "12"),
    null,
    "the origin thread is excepted",
  );
  assert(
    visibilityRefusal(g, privateInfra, api, "issue", "13") !== null,
    "another public thread is not",
  );
  assert(
    visibilityRefusal(g, privateInfra, api, "issue", null) !== null,
    "nor is a new public issue",
  );
});

test("visibility: each repo is read in its role — the target for the thread written on", () => {
  // A GitLab project can keep its code from the public (private to READ) and still publish its
  // issues (public to WRITE on). The run holds it, so it holds a private repo; an issue there is
  // public all the same, and so is one on any repo the rule has no answer for.
  const g = grant({ origin: null });
  const [api, infra] = g.repos;
  const split = new Map<string, RepoVisibility>([
    ["cr-api", { source: "members", target: { issue: "public", change_request: "members" } }],
    ["cr-infra", wholeRepoVisibility(false)],
  ]);
  assert(visibilityRefusal(g, split, api, "issue", null) !== null, "a public issue tracker");
  assert(visibilityRefusal(g, split, api, "issue", "5") !== null, "a public issue's thread");
  assertEquals(visibilityRefusal(g, split, api, "change_request", "6"), null, "members-only MRs");
  assert(visibilityRefusal(g, split, infra, "issue", null) !== null, "a public repo");
  assert(
    visibilityRefusal(g, new Map([["cr-api", wholeRepoVisibility(true)]]), infra, "issue", null) !==
      null,
    "a target the rule has no answer for is public",
  );
});

test("the footer signs the text and carries the marker; the name cannot restyle it", () => {
  const body = withSignature(
    "Found it.\n\n",
    {
      agentName: "**Ada**](http://evil)",
      runUrl: "https://ryph.test/tasks/t-1",
      requestedBy: "maintainer",
      requestedVia: null,
    },
    "fa-abc",
    "github",
  );
  assert(body.startsWith("<sub>Written by "));
  assertStringIncludes(body, "\\*\\*Ada\\*\\*\\]");
  assertStringIncludes(body, "[Run](https://ryph.test/tasks/t-1)");
  assertStringIncludes(body, "asked by @maintainer");
  assert(carriesMarker(body, "fa-abc"));
  assert(body.endsWith(`${actionMarker("fa-abc")}\n\nFound it.`));
  assertEquals(carriesMarker(body, "fa-abd"), false);
  assertEquals(
    withSignature(
      "  \n",
      { agentName: "Ada", runUrl: null, requestedBy: null, requestedVia: null },
      "fa-1",
      "github",
    ),
    `<sub>Written by **Ada**, a Ryph agent</sub>\n${actionMarker("fa-1")}`,
    "no text, no blank lines after the marker",
  );
});

/**
 * Bodies that hid or held the footer while it came after the agent's text, each with what
 * GitLab's renderer (comrak 0.56 with GLFM's options, then GitLab's sanitizer) made of it then.
 * Rendered again with the footer leading, every one shows it first, as its own paragraph.
 */
const FOOTER_ATTACKS: Array<[body: string, then: string]> = [
  // An unterminated `<!--` opens a comment the marker's `-->` closes: the footer renders as
  // nothing, while the marker keeps the write reconcilable.
  ["Nothing to see here.\n\n<!--", "commented out"],
  // Round 11, F1: GitLab's `>>>` quote closes the fence inside it, so the fence's `<!--` is
  // prose: commented out.
  [">>>\n```\n>>>\n<!--\n```", "commented out"],
  [">>> [!note]\n```\n>>>\n<!--\n```", "commented out"],
  [">>>>\n~~~\n>>>>\n<!--\n~~~", "commented out"],
  // Round 11, F2: an unclosed `<details>` collapses the footer under the agent's `<summary>`.
  ["Done.\n\n<details><summary>Reviewed and signed off by @alice</summary>", "collapsed"],
  ["<details>\n\n```\nlog", "collapsed, as code"],
  // An unclosed `<rp>` is not displayed at all; an unclosed `<script>` is dropped by GitLab's
  // sanitizer with everything in it.
  ["x\n<ruby>a<rp>(", "hidden"],
  ["x\n\n<script>", "dropped"],
  // Restyled rather than hidden: struck through, a link to anywhere, raw text, a quote, code.
  ["x\n<s>struck", "struck through"],
  ['<a href="https://evil.example">x', "a link"],
  ["x\n\n<textarea>", "raw text"],
  [">>> [!caution]\nx", "a caution box"],
  ["```\nx", "code"],
  // Front matter, which GitLab reads only at a body's start.
  ["---\ntitle: x\n---\nbody", "front matter"],
];

test("nothing the agent writes can hide or restyle the footer: it leads the body", () => {
  const prov = { agentName: "Ada", runUrl: null, requestedBy: "maintainer", requestedVia: null };
  const footer = `<sub>Written by **Ada**, a Ryph agent · asked by @maintainer</sub>\n${
    actionMarker("fa-abc")
  }\n\n`;
  for (const provider of ["github", "gitlab"] as const) {
    for (const [body, then] of FOOTER_ATTACKS) {
      // A blank line ends the footer's paragraph, so no line of the agent's can make it a
      // heading, a table's header row or front matter, and no element it opens can hold it.
      assertEquals(
        withSignature(body, prov, "fa-abc", provider),
        `${footer}${body}`,
        `${provider}, once ${then}: ${JSON.stringify(body)}`,
      );
    }
  }
});

test("the agent's text is posted byte for byte, on every forge: a suggestion applies as written", () => {
  // Round 10: every `<!--` was neutralized, a suggestion's too, so "Apply suggestion" committed
  // `&lt;!--` into an HTML, XML, Vue or Markdown file. Round 11, F3: the exemption that followed
  // stopped at the first fence run anywhere or at an HTML block, so every suggestion after one
  // still did.
  const sign = (body: string, provider: "github" | "gitlab") =>
    withSignature(
      body,
      { agentName: "Ada", runUrl: null, requestedBy: null, requestedVia: null },
      "fa-1",
      provider,
    );
  const suggestion = "```suggestion\n<!-- keep in sync -->\n<p>x</p>\n```";
  for (const provider of ["github", "gitlab"] as const) {
    for (
      const body of [
        suggestion,
        `Rather:\n${suggestion}`,
        `Two:\n\n${suggestion}\n~~~suggestion:-1+0\n<!--\n~~~\nok`,
        "````html\n```\n<!-- still code -->\n````",
        `<!-- a stray opener first\n${suggestion}`,
        "\r\n```suggestion\r\n<!-- crlf -->\r\n```",
        `Wrap it in a ~~~ block, not inline:\n\n${suggestion}`,
        `<details><summary>why</summary>long</details>\n\n${suggestion}`,
        `\`\`\`js\nx\n\`\`\`\n<span>\n${suggestion}`,
        `<div>\n${suggestion}`,
      ]
    ) {
      const signed = sign(body, provider);
      assert(signed.endsWith(`-->\n\n${body}`), `${provider}: ${JSON.stringify(body)}`);
      assertEquals(signed.split("&lt;").length, 1, "nothing is escaped");
    }
  }
});

test("a requester that is not a login is left out rather than echoed", () => {
  const body = withSignature(
    "x",
    {
      agentName: "Ada",
      runUrl: null,
      requestedBy: "a b @all",
      requestedVia: null,
    },
    "fa-1",
    "github",
  );
  assertEquals(body.includes("asked by"), false);
  assertEquals(body.includes("[Run]"), false);
});

test("a requester is named by the login rule of the forge the body lands on", () => {
  const sign = (provider: "github" | "gitlab" | "radicle", requestedBy: string) =>
    withSignature(
      "x",
      { agentName: "Ada", runUrl: null, requestedBy, requestedVia: null },
      "fa-1",
      provider,
    );
  // A GitLab username may hold `.` and `_`, which GitHub's rule drops.
  assertStringIncludes(sign("gitlab", "grace.hopper_1"), "asked by @grace.hopper_1");
  assertEquals(sign("github", "grace.hopper_1").includes("asked by"), false);
  assertEquals(sign("gitlab", "-dash").includes("asked by"), false);
  assertEquals(sign("gitlab", "a b").includes("asked by"), false);
  // Radicle has no logins a footer could mention.
  assertEquals(sign("radicle", "maintainer").includes("asked by"), false);
});

test("a GitLab thread is named by its ref, its sigil spelling, or not at all", () => {
  assertEquals(gitlabThreadRef("!7"), "mr-7");
  assertEquals(gitlabThreadRef("mr-7"), "mr-7");
  assertEquals(gitlabThreadRef("#12"), "issue-12");
  assertEquals(gitlabThreadRef("issue-12"), "issue-12");
  // A bare number is two possible threads; only the adapter can tell which.
  assertEquals(gitlabThreadRef("7"), "7");
  assertEquals(gitlabThreadRef("!0"), null);
  assertEquals(gitlabThreadRef("!7a"), null);
  assertEquals(gitlabThreadRef("pr-7"), null);
});

test("an origin close rule closes only the origin thread and issues the run opened", () => {
  const g = grant({ opened: [{ connectedRepoId: "cr-infra", ref: "3" }] });
  const closing = (repo: string, thread: string) =>
    ({ tool: "close_issue", repo, thread, comment: false }) as const;
  assert(checkToolCall(g, closing("acme/api", "12")).ok);
  assert(checkToolCall(g, closing("acme/infra", "3")).ok);
  const elsewhere = checkToolCall(g, closing("acme/api", "99"));
  assert(!elsewhere.ok);
  assertStringIncludes(elsewhere.reason, "acme/api#12, acme/infra#3");
  const any = grant({
    capabilities: { ...grant().capabilities, closeIssues: { where: "any", max: 10 } },
  });
  assert(checkToolCall(any, closing("acme/infra", "99")).ok);
});

test("a closing note is checked as the comment it is, not waved through with the close", () => {
  const anywhere = { where: "any", max: 10 } as const;
  const noting = (repo: string, thread: string) =>
    ({ tool: "close_issue", repo, thread, comment: true }) as const;

  // May close anything, may not comment at all: the note is the capability the operator withheld.
  const mute = grant({
    capabilities: { ...grant().capabilities, closeIssues: anywhere, comment: null },
  });
  const refused = checkToolCall(mute, noting("acme/infra", "99"));
  assert(!refused.ok);
  assertStringIncludes(refused.reason, "may not comment");
  assert(
    checkToolCall(mute, { ...noting("acme/infra", "99"), comment: false }).ok,
    "the close is fine",
  );

  // May close anywhere, may comment only on its own thread: the note obeys the comment rule.
  const scoped = grant({
    capabilities: { ...grant().capabilities, closeIssues: anywhere },
  });
  const offThread = checkToolCall(scoped, noting("acme/infra", "99"));
  assert(!offThread.ok);
  assertStringIncludes(offThread.reason, "not a thread this run may comment on");
  assert(checkToolCall(scoped, noting("acme/api", "12")).ok, "its own thread takes a note");
});

test("the ORIGIN thread is narrower than the run's own threads", () => {
  // Only the origin carries the status comment the platform keeps for the run, so a write on a
  // thread the run merely opened is not something that comment would repeat.
  const g = grant({ opened: [{ connectedRepoId: "cr-infra", ref: "3" }] });
  assert(isOriginThread(g, g.repos[0], "12"));
  assertEquals(isOriginThread(g, g.repos[1], "3"), false, "opened, but not the origin");
  assertEquals(isOriginThread(g, g.repos[1], "12"), false, "the same number, another repo");
  assertEquals(isOriginThread(grant({ origin: null }), g.repos[0], "12"), false);
});

// ---- the second forge: RIDs are case-sensitive, COB ids resolve by prefix -------------------

const RID = "rad:zAbCdEfGhIjKlMnOpQrStUvWxYz12";
const CHANGE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function radicleGrant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return grant({
    repos: [{ connectedRepoId: "cr-rad", provider: "radicle", repoRef: RID, tenantId: null }],
    origin: { connectedRepoId: "cr-rad", kind: "change_request", ref: CHANGE },
    ...overrides,
  });
}

test("a RID is matched exactly — base58 case is meaning, not spelling", () => {
  const g = radicleGrant();
  assert(checkToolCall(g, { tool: "list_issues", repo: RID }).ok);
  // The same characters in another case are another repository, not this one.
  assertEquals(checkToolCall(g, { tool: "list_issues", repo: RID.toLowerCase() }).ok, false);
  assertEquals(checkToolCall(g, { tool: "list_issues", repo: RID.toUpperCase() }).ok, false);
  // Surrounding whitespace is still just whitespace.
  assert(checkToolCall(g, { tool: "list_issues", repo: `  ${RID} ` }).ok);
});

test("a unique COB prefix names the run's own thread, on Radicle only", () => {
  const g = radicleGrant({
    capabilities: { ...grant().capabilities, comment: { where: "origin", max: 20 } },
  });
  assert(checkToolCall(g, { tool: "add_comment", repo: RID, thread: CHANGE }).ok);
  assert(checkToolCall(g, { tool: "add_comment", repo: RID, thread: CHANGE.slice(0, 7) }).ok);
  assert(checkToolCall(g, { tool: "add_comment", repo: RID, thread: CHANGE.slice(0, 12) }).ok);
  // A review of the origin change request, by prefix, is the same thread.
  assert(checkToolCall(g, { tool: "submit_review", repo: RID, thread: CHANGE.slice(0, 9) }).ok);
  // Too short to be a prefix anywhere, and a prefix of something else, are both refused.
  assertEquals(
    checkToolCall(g, { tool: "add_comment", repo: RID, thread: CHANGE.slice(0, 6) }).ok,
    false,
  );
  assertEquals(
    checkToolCall(g, { tool: "add_comment", repo: RID, thread: "beef1234" }).ok,
    false,
  );
  // An issue the run opened resolves by prefix too.
  const opened = "0123456789abcdef0123456789abcdef01234567";
  const withOpened = radicleGrant({ opened: [{ connectedRepoId: "cr-rad", ref: opened }] });
  assert(
    checkToolCall(withOpened, { tool: "add_comment", repo: RID, thread: opened.slice(0, 7) }).ok,
  );
});

test("the origin check resolves a COB prefix the same way", () => {
  const g = radicleGrant();
  assert(isOriginThread(g, g.repos[0], CHANGE));
  assert(isOriginThread(g, g.repos[0], CHANGE.slice(0, 7)));
  assertEquals(isOriginThread(g, g.repos[0], CHANGE.slice(0, 6)), false);
});

test("a prefix names nothing on GitHub — an issue number is not a git object", () => {
  // "12" is the origin; "1" is a different issue that happens to start the same way.
  const refused = checkToolCall(grant(), { tool: "add_comment", repo: "acme/api", thread: "1" });
  assertEquals(refused.ok, false);
});

test("the visibility exemption follows a Radicle origin named by prefix", () => {
  const g = radicleGrant({
    repos: [
      { connectedRepoId: "cr-rad", provider: "radicle", repoRef: RID, tenantId: null },
      { connectedRepoId: "cr-priv", provider: "radicle", repoRef: `${RID}zz`, tenantId: null },
    ],
  });
  const target = g.repos[0];
  const privateRepos = seen(g, "cr-priv");
  assertEquals(
    visibilityRefusal(g, privateRepos, target, "change_request", CHANGE.slice(0, 7)),
    null,
  );
  assert(visibilityRefusal(g, privateRepos, target, "change_request", "beef1234567") !== null);
});

test("a chat-started run is signed with its commander's chat name, never as a mention", () => {
  const body = withSignature(
    "x",
    {
      agentName: "Ada",
      runUrl: null,
      requestedBy: null,
      requestedVia: "Grace Hopper",
    },
    "fa-1",
    "github",
  );
  assertStringIncludes(body, "asked by `Grace Hopper` in chat");
  assert(!body.includes("@"), "no @ anywhere a forge could read as a mention");

  // A name that reads as a host is a code span, which a forge never autolinks.
  const host = withSignature(
    "x",
    {
      agentName: "Ada",
      runUrl: null,
      requestedBy: null,
      requestedVia: "www.evil.example",
    },
    "fa-3",
    "github",
  );
  assertStringIncludes(host, "asked by `www.evil.example` in chat");

  // A name the orchestrator would never produce is dropped rather than echoed.
  const forged = withSignature(
    "x",
    {
      agentName: "Ada",
      runUrl: null,
      requestedBy: null,
      requestedVia: "@all",
    },
    "fa-2",
    "github",
  );
  assert(!forged.includes("asked by"));
});
