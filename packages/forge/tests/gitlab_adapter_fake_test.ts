// The GitLab adapter (bot mode) against @ryph/fake-gitlab, where what is asserted is what GitLab
// ends up holding rather than which requests were made: that no text ryph writes carries out a
// quick action, that a note on a diff is posted as written or refused, that internal notes and confidential issues never reach an agent, that two
// reviews on one merge request at once leave each other alone, that a merge underway is never
// an end, and that a remark can land on a file whose diff `/diffs` withholds.
//
// Reaching into `../../fake-gitlab` is deliberate, as gitlab_e2e_test.ts does.

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  extractQuickActions,
  type FakeGitlab,
  renderedLine,
  startFakeGitlab,
} from "../../fake-gitlab/src/mod.ts";
import { blocksOf } from "../../fake-gitlab/src/markdown.ts";
import { suggestionsIn } from "../../fake-gitlab/src/suggestions.ts";
import { MARKDOWN_VECTORS } from "../../fake-gitlab/tests/markdown_vectors.ts";
import { inertToQuickActions } from "../src/adapters/forge_api/gitlab_client.ts";
import { gitlabForgeApi } from "../src/adapters/forge_api/gitlab.ts";
import { ForgeApiError } from "../src/ports/forge_api.ts";
import { actionMarker, withSignature } from "../src/core/provenance.ts";
import { gitlabAccountId, gitlabProjectRef } from "../src/gitlab_account.ts";
import { GITLAB_TOKEN_NAMES, staticUserToken } from "../src/helpers/user_token.ts";
import type { GitlabImageSlots } from "../src/ports/gitlab.ts";
import { visibilityRefusal } from "../src/core/tool_grant.ts";
import type { ToolGrant } from "../src/core/types.ts";
import { silentDiagnostics } from "./util.ts";

const PROJECT = "acme/widgets";
/** A note on a line of the diff: where GitLab finds suggestions, never escaped. */
const DIFF_NOTE = { suggestions: true };
/** The project every call names: by its id on the fake's instance, which `world` sets. */
const repo = { repoRef: PROJECT, tenantId: null, forgeId: "" };

/** Text an agent might write to make ryph's account act: every spelling GitLab 17.x would run
 * were it sent as written. */
const EVIL = [
  "Looks good.",
  "/close",
  "/label ~pwned",
  "/merge",
  "/approve",
  "/reopen",
].join("\n") + "\r\n/label ~crlf\n```\n/close\n```\n /unlabel ~keep";

async function world(opts: { imageSlots?: GitlabImageSlots; group?: string } = {}) {
  const fake = await startFakeGitlab();
  fake.addUser({ username: "ryph-bot", bot: true });
  fake.addUser({ username: "maya" });
  fake.addUser({ username: "dev" });
  fake.addGroup("acme");
  const created = await fake.addProject(PROJECT, {
    files: { "README.md": "# hi\n", "src/app.ts": "one\ntwo\nthree\n" },
  });
  repo.forgeId = gitlabProjectRef(fake.url, String(created.id));
  fake.addMember(PROJECT, "ryph-bot", "developer");
  fake.addMember(PROJECT, "maya", "maintainer");
  fake.addMember(PROJECT, "dev", "developer");
  const api = await gitlabForgeApi({
    mode: "bot",
    url: fake.url,
    token: staticUserToken(fake.token("ryph-bot"), GITLAB_TOKEN_NAMES),
    webhookSecret: "master",
    oauth: null,
    group: opts.group ?? null,
    diag: silentDiagnostics(),
    ...(opts.imageSlots === undefined ? {} : { imageSlots: opts.imageSlots }),
  });
  return {
    fake,
    api,
    [Symbol.asyncDispose]: () => fake.shutdown(),
  };
}

/** A merge request from `feat`, opened by maya, labelled `keep`. */
async function mergeRequest(fake: FakeGitlab, files: Record<string, string> = {}) {
  await fake.commit(PROJECT, {
    as: "dev",
    branch: "feat",
    files: { "src/app.ts": "one\nTWO\nthree\n", ...files },
  });
  const mr = await fake.openMergeRequest(PROJECT, {
    as: "maya",
    sourceBranch: "feat",
    title: "Fix",
  });
  mr.labels = ["keep"];
  return mr;
}

test("no body ryph writes carries out a quick action, on any write path", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const issue = fake.openIssue(PROJECT, { as: "maya", title: "Broken", labels: ["keep"] });
  const mrThread = { kind: "change_request" as const, ref: `mr-${mr.iid}` };
  const issueThread = { kind: "issue" as const, ref: `issue-${issue.iid}` };

  const { commentId } = await api.postComment(repo, mrThread, EVIL);
  await api.createComment(repo, issueThread, EVIL);
  await api.updateComment(repo, commentId, `${EVIL}\nedited`);
  // A remark, or a reply to one, is a diff note: never escaped, refused with nothing written.
  await assertRejects(
    () =>
      api.createReview(repo, mrThread.ref, {
        body: EVIL,
        comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: EVIL }],
        headSha: null,
      }),
    ForgeApiError,
    'remark 1 (src/app.ts:2): line 2 starts with "/"',
  );
  assertEquals(mr.drafts, []);
  await api.createReview(repo, mrThread.ref, {
    body: EVIL,
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "Why?" }],
    headSha: null,
  });
  const remark = mr.discussions.find((d) => d.notes[0]?.type === "DiffNote")!;
  await assertRejects(
    () =>
      api.replyToReviewComment(
        repo,
        mrThread.ref,
        `${mrThread.ref}:${remark.id}:${remark.notes[0]!.id}`,
        EVIL,
      ),
    ForgeApiError,
    'line 2 starts with "/"',
  );
  assertEquals(remark.notes.length, 1);
  const opened = await api.createIssue(repo, { title: "New", body: EVIL, labels: [] });
  await fake.commit(PROJECT, { as: "dev", branch: "ryph/x", files: { "y.txt": "y\n" } });
  const delivered = await api.openMergeRequest(repo, {
    title: "Agent change",
    body: EVIL,
    head: "ryph/x",
    base: "main",
    draft: false,
  });

  // Nothing acted: every thread as it was.
  assertEquals([mr.state, mr.labels, mr.approvedBy], ["opened", ["keep"], []]);
  assertEquals([issue.state, issue.labels], ["opened", ["keep"]]);
  const newIssue = fake.world.issues.find((i) => `issue-${i.iid}` === opened.ref)!;
  const newMr = fake.world.mergeRequests.find((m) => `mr-${m.iid}` === delivered.ref)!;
  assertEquals([newIssue.state, newIssue.labels], ["opened", []]);
  assertEquals([newMr.state, newMr.labels], ["opened", []]);
  // And every word kept: the command lines are there, escaped, rendering as written.
  const written = [
    ...mr.discussions.flatMap((d) => d.notes).filter((n) => !n.system && n.type !== "DiffNote")
      .map((n) => n.body),
    ...issue.discussions.flatMap((d) => d.notes).filter((n) => !n.system).map((n) => n.body),
    newIssue.description,
    newMr.description,
  ];
  assertEquals(written.length, 5);
  for (const body of written) {
    assertStringIncludes(body, "\u200B/close");
    assertStringIncludes(body, "\u200B/label ~crlf");
    // No line starts with `/`, in code too.
    assert(body.split("\n").every((l) => !/^[ \t]*\//.test(l)), body);
    assertStringIncludes(body, "```\n\u200B/close\n```");
  }
});

test("what ryph writes is inert to both of GitLab's detections, the rendered one included", () => {
  // GitLab finds a candidate paragraph by its RENDERED text, then runs a command by its SOURCE
  // line. An escape that holds only against the source (`\/close` renders as `/close`) is one
  // parser change from running; the one written must hold against either.
  {
    const escaped = inertToQuickActions(`${EVIL}\n\n\t/close\n\`\`\`\n/close\n\`\`\``, {
      suggestions: false,
    });
    for (const matchRendered of [false, true]) {
      assertEquals(
        extractQuickActions(escaped, undefined, { matchRendered }).actions,
        [],
        `${matchRendered}`,
      );
    }
    const lines = escaped.split("\n");
    blocksOf(escaped).topParagraph.forEach((top, i) => {
      if (top) assert(!renderedLine(lines[i]!).startsWith("/"), lines[i]);
    });
  }
});

/** The suggestion fences the escape puts first — `{run}suggestion:-A+B` … `{run}` — and the rest. */
function splitLeadingSuggestions(inert: string): { fences: string[]; rest: string[] } {
  const lines = inert.split("\n");
  const fences: string[] = [];
  let i = 0;
  for (;;) {
    const open = /^(`{3,})suggestion:-\d+\+\d+$/.exec(lines[i] ?? "");
    if (open === null) break;
    const close = lines.indexOf(open[1]!, i + 1);
    if (close === -1) break;
    fences.push(lines.slice(i + 1, close).join("\n"));
    i = close + 1;
    if (lines[i] === "") i++;
  }
  return { fences, rest: lines.slice(i) };
}

/** A line whose first character that shows is `/` (skipping anything that renders as nothing)
 * and a command name could follow it. */
const COMMAND_LINE =
  /^[\s\p{Z}\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]*\/[A-Za-z0-9_\u0080-\u{10FFFF}]+(?:[\t\v\f\r ]|$)/u;

/** What the rule promises of `inert`, the diff note sent for `text`: nothing the fake runs under
 * either detection; no line outside the leading suggestions whose first character that shows
 * is `/`; no zero-width space the agent did not write; the rest the agent's own lines, in order
 * (D1: only the clean suggestions moved, a leading byte-order mark dropped); and every
 * suggestion GitLab finds either one of the leading ones or made of the agent's bytes. Answers
 * the leading suggestions' text. */
function holdsTheRule(text: string, inert: string, what: string, opts = { rendered: true }) {
  for (const matchRendered of opts.rendered ? [false, true] : [false]) {
    assertEquals(extractQuickActions(inert, undefined, { matchRendered }).actions, [], what);
  }
  const { fences, rest } = splitLeadingSuggestions(inert);
  for (const line of rest) assert(!COMMAND_LINE.test(line), `${what}: ${JSON.stringify(line)}`);
  assert(!inert.includes("\u200B") || text.includes("\u200B"), what);
  const own = text.replace(/^\uFEFF+/, "").replace(/\r\n?/g, "\n").split("\n");
  let at = 0;
  for (const line of rest) {
    while (at < own.length && own[at] !== line) at++;
    assert(at < own.length, `${what}: ${JSON.stringify(line)} is not the agent's`);
    at++;
  }
  const found = suggestionsIn(inert).map((s) => s.text.replace(/\n$/, ""));
  assertEquals(found.slice(0, fences.length), fences, what);
  return fences;
}

test("the rule and the fake's block model agree on every shared vector", () => {
  for (const v of MARKDOWN_VECTORS) {
    if (v.inert === "refused") {
      const err = assertThrows(
        () => inertToQuickActions(v.text, DIFF_NOTE),
        ForgeApiError,
        'starts with "/"',
      );
      assert(err.terminal, v.name);
      continue;
    }
    const inert = inertToQuickActions(v.text, DIFF_NOTE);
    assertEquals(inert, v.inert, v.name);
    holdsTheRule(v.text, inert, v.name);
    assertEquals(
      suggestionsIn(inert).map((s) => s.text.replace(/\n$/, "")),
      v.suggestions ?? [],
      v.name,
    );
  }
});

test("a seeded sweep of tricky lines: nothing runs, and every suggestion is the agent's", () => {
  // Lines that open, close, nest and interrupt blocks — the round-6 review's fuzz pool among
  // them, the round-9 front matter and byte-order mark too — mixed at random. Run against comrak
  // with GitLab's options as well; here the fake and the rule's
  // own promise are the judges.
  const POOL = [
    ...["/close", " /close", "   /close", "\t/close", "    /label ~x", "a\r/close", "text", ""],
    ...["```", "~~~", "````", "   ```", "    ```", "```js", "``` a`b", "  ~~~ x", "``` ```"],
    ...[
      "- a",
      "1. a",
      "2. b",
      "10. ten",
      "1.",
      "-",
      "  - b",
      "   1. x",
      "- ```",
      "  - ```",
      "1. ```",
    ],
    ...["-     ```", "*\t```", "> a", "> ```", " > ```", "> - ```", "  > b", "> /close"],
    ...[">>>", ">>> x", "  >>>", "> >>>", "> [!note]", "> [!NOTE] t", "Term", ": def", ":   ```"],
    ...["<div>", "</div>", "<span>", "<pre>", "</pre>", "<!--", "-->", "<!-- x -->", "<?php", "?>"],
    ...['<a href="x">', "<textarea>", "<x-y>", "<del>", '<pre lang="suggestion">'],
    ...["# h", "---", "===", "* * *", "| a |", "|---|", "[^1]: n", "[ref]: /url", "+++", ";;;"],
    ...["$$", "```math", "&#47;close x", "\\/close", "`", "`x", "x`", "- [ ] task"],
    ...["\u200B/close", "\uFEFF/close", "\u00A0/close", "\u2060 /close", "# coding: x", "..."],
    ...["---suggestion", "+++ suggestion", ";;;suggestion:-1+0", "\uFEFF```suggestion"],
  ];
  /** Drawn one time in twelve: a suggestion fence, clean or not. */
  const SUGGESTIONS = [
    ...["```suggestion:-0+0", "~~~suggestion", "```sugg&#101;stion:-1+0", "````suggestion"],
    ...[
      "   ```suggestion",
      "~~~ suggestion",
      "- ```suggestion",
      "> ```suggestion",
      "x ```suggestion",
    ],
  ];
  let seed = 7;
  const rnd = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let refused = 0;
  let suggested = 0;
  for (let n = 0; n < 20_000; n++) {
    const drawn = Array.from(
      { length: 1 + Math.floor(rnd() * 16) },
      () => {
        const pool = rnd() < 1 / 12 ? SUGGESTIONS : POOL;
        return pool[Math.floor(rnd() * pool.length)];
      },
    ).join(rnd() < 0.05 ? "\r\n" : "\n");
    const text = rnd() < 0.05 ? `\uFEFF${drawn}` : drawn;
    let inert: string;
    try {
      inert = inertToQuickActions(text, DIFF_NOTE);
    } catch (err) {
      assert(err instanceof ForgeApiError && err.terminal, text);
      refused++;
      continue;
    }
    // The pool spells `/` behind a backslash and a reference too: GitLab's source rule never runs
    // those, while a reading of the rendered text alone would — so that reading is held on the
    // vectors, not here.
    const what = JSON.stringify(text);
    if (holdsTheRule(text, inert, what, { rendered: false }).length > 0) suggested++;
  }
  // Both paths taken, plenty of each.
  assert(refused > 1_000 && suggested > 200, `${refused} refused, ${suggested} with suggestions`);
});

test("the escape is one pass: a megabyte of anything is quick", () => {
  // A fence regex that backtracked over long runs once held the event loop for seconds on a
  // 65 536-backtick description.
  const M = 1_000_000;
  for (
    const [name, text] of Object.entries({
      backticks: "`".repeat(M),
      tildes: "~".repeat(M),
      fenceRuns: "```a".repeat(M / 4),
      slashLines: "/close\n".repeat(M / 7),
      suggestion: `\`\`\`suggestion\n${"`".repeat(M)}\n\`\`\``,
      longInfo: `\`\`\`suggestion${" ".repeat(M)}`,
      references: `\`\`\`${"&#101;".repeat(M / 6)}`,
      backslashes: `\`\`\`${"\\".repeat(M)}`,
      closers: `\`\`\`suggestion\n${"```x\n".repeat(M / 5)}`,
      suggestions: "```suggestion\nx\n```\n".repeat(M / 20),
      containers: `${"- > 1. [ ] ".repeat(M / 11)}\`\`x`,
      footnotes: `${"[^".repeat(M / 2)}\`\`\`suggestion`,
      blanks: `${" \t".repeat(M / 2)}\`\`x`,
      html: `<pre ${"data-x=suggestion ".repeat(M / 19)}`,
    })
  ) {
    const started = performance.now();
    try {
      inertToQuickActions(text, DIFF_NOTE);
    } catch (err) {
      assert(err instanceof ForgeApiError, name);
    }
    const ms = performance.now() - started;
    assert(ms < 1_000, `${name}: ${ms.toFixed(0)} ms`);
  }
});

/** A remark's suggestions as GitLab lists them on its note, and the merge request. */
async function suggestionsOf(fake: FakeGitlab, iid: number, line: number) {
  const listed = await (await fake.client("maya")(
    "GET",
    `/projects/${encodeURIComponent(PROJECT)}/merge_requests/${iid}/discussions`,
  )).json();
  return listed.flatMap((d: { notes: unknown[] }) => d.notes)
    .find((n: { type: string; position: { new_line: number } }) =>
      n.type === "DiffNote" && n.position.new_line === line
    ).suggestions as Array<{ id: number; to_content: string; from_line: number; to_line: number }>;
}

/** `src/app.ts` on the merge request's source branch, as the fake holds it. */
async function appOnFeat(fake: FakeGitlab): Promise<string> {
  const raw = await fake.client("maya")(
    "GET",
    `/projects/${encodeURIComponent(PROJECT)}/repository/files/${
      encodeURIComponent("src/app.ts")
    }/raw?ref=feat`,
  );
  return await raw.text();
}

test("a suggestion posted through the adapter applies as the agent wrote it", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  const suggested = "// Package app counts.\n/* two */ TWO\n/approve";
  await api.createReview(repo, ref, {
    body: "",
    comments: [{
      path: "src/app.ts",
      line: 2,
      side: "RIGHT",
      body: `Say what it is:\n\`\`\`suggestion:-0+0\n${suggested}\n\`\`\``,
    }],
    headSha: null,
  });
  assertEquals([mr.state, mr.approvedBy], ["opened", []]);
  const note = mr.discussions.flatMap((d) => d.notes).find((n) => n.type === "DiffNote")!;
  assert(!note.body.includes("\u200B"), note.body);
  const [suggestion] = await suggestionsOf(fake, mr.iid, 2);
  assertEquals(suggestion!.to_content, `${suggested}\n`);
  const applied = await fake.client("maya")("PUT", `/suggestions/${suggestion!.id}/apply`);
  assertEquals(applied.status, 200);
  assertEquals(await appOnFeat(fake), `one\n${suggested}\nthree\n`);
});

test("a diff note's code comments and paths are posted byte for byte, and run nothing", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  // No command name can follow these `/`s: GitLab's extractor never matches them, so the note
  // is not refused, and goes out exactly as written.
  const body = "This reads better:\n```ts\n// count the lines\n/* block */\nconst n = 2;\n```\n" +
    "// and prose\n/usr/bin/env is fine too";
  await api.createReview(repo, ref, {
    body: "",
    comments: [{ path: "src/app.ts", line: 3, side: "RIGHT", body }],
    headSha: null,
  });
  const remark = mr.discussions.find((d) => d.notes[0]?.type === "DiffNote")!;
  assertEquals(remark.notes[0]!.body, body);
  await api.replyToReviewComment(repo, ref, `${ref}:${remark.id}:${remark.notes[0]!.id}`, body);
  assertEquals(remark.notes[1]!.body, body);
  // A suggestion GitLab finds where ryph takes none (front matter) applies its `//` lines as
  // written.
  const fm = "---suggestion\n// TWO\n---";
  await api.createReview(repo, ref, {
    body: "",
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: fm }],
    headSha: null,
  });
  const [suggestion] = await suggestionsOf(fake, mr.iid, 2);
  assertEquals(suggestion!.to_content, "// TWO\n");
  assertEquals(
    (await fake.client("maya")("PUT", `/suggestions/${suggestion!.id}/apply`)).status,
    200,
  );
  assertEquals(await appOnFeat(fake), "one\n// TWO\nthree\n");
  assertEquals([mr.state, mr.labels, mr.approvedBy], ["opened", ["keep"], []]);
});

test("a suggestion GitLab finds where ryph takes none — front matter, raw HTML, a container — applies the agent's bytes", async () => {
  // Round 9: GitLab's front matter filter makes `---suggestion` … `---` a suggestion, and its
  // markdown drops a leading byte-order mark that hid a column-0 fence. Such a note was escaped
  // (or not read at all) and "Apply suggestion" committed the zero-width space; now each is
  // posted as written, or has its byte-order mark dropped and its fence taken.
  for (
    const [body, content] of [
      ["---suggestion\nconst two = 2;\n---\nPlease apply.", "const two = 2;\n"],
      ["# -*- coding: utf-8 -*-\n\n;;;suggestion\n  TWO\n;;;", "  TWO\n"],
      ["\uFEFF```suggestion:-0+0\n/usr/bin/env node\n```", "/usr/bin/env node\n"],
      ["\uFEFF+++ suggestion\nTwo = 2\n...\n", "Two = 2\n"],
      [
        'Fix:\n\n<pre data-canonical-lang=\n"suggestion" data-lang-params="-0+0">' +
        "<code>/usr/bin/env node\n</code></pre>",
        "/usr/bin/env node\n",
      ],
      ["> ```suggestion:-0+0\n> two = 2\n> ```", "two = 2\n"],
    ] as const
  ) {
    await using w = await world();
    const { fake, api } = w;
    const mr = await mergeRequest(fake);
    await api.createReview(repo, `mr-${mr.iid}`, {
      body: "",
      comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body }],
      headSha: null,
    });
    const note = mr.discussions.flatMap((d) => d.notes).find((n) => n.type === "DiffNote")!;
    assert(!note.body.includes("\u200B"), note.body);
    const [suggestion, ...more] = await suggestionsOf(fake, mr.iid, 2);
    assertEquals([suggestion?.to_content, more.length], [content, 0], body);
    assertEquals(
      (await fake.client("maya")("PUT", `/suggestions/${suggestion!.id}/apply`)).status,
      200,
    );
    assertEquals(await appOnFeat(fake), `one\n${content}three\n`, body);
  }
});

test("entity-spelled and several suggestions in one remark: each as written, in order", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  // GitLab reads `sugg&#101;stion` as `suggestion`: a suggestion, posted again as written —
  // after a lone tag too, where no markdown model here could say whether it is code.
  const first = "/usr/bin/env node\n// ```` four";
  const second = "  \t/* indented */ TWO  ";
  await api.createReview(repo, `mr-${mr.iid}`, {
    body: "",
    comments: [{
      path: "src/app.ts",
      line: 2,
      side: "RIGHT",
      body:
        `<span>\n\`\`\`sugg&#101;stion:-1+0\n${first}\n\`\`\`\nor:\n~~~suggestion\n${second}\n~~~`,
    }],
    headSha: null,
  });
  const listed = await suggestionsOf(fake, mr.iid, 2);
  assertEquals(
    listed.map((s) => [s.from_line, s.to_line, s.to_content]),
    [[1, 2, `${first}\n`], [2, 2, `${second}\n`]],
  );
  assertEquals(
    (await fake.client("maya")("PUT", `/suggestions/${listed[1]!.id}/apply`)).status,
    200,
  );
  assertEquals(await appOnFeat(fake), `one\n${second}\nthree\n`);
});

test("a diff note with a `/` line outside its suggestions is refused before anything is written", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  // Behind any blank or zero-width character, in any block — a suggestion GitLab finds where
  // ryph takes none included (front matter, raw HTML, a container, a fence never closed).
  for (
    const body of [
      "Rather:\n```suggestion:-0+0\ntwo\n```\n/close",
      "ok\n\u200B/approve",
      "ok\n\u00A0\u2060/merge",
      "\uFEFF\uFEFF/close",
      "---suggestion\n/close\n---",
      "\n\n+++ suggestion\n/close\n...\n",
      "# -*- coding: utf-8 -*-\n;;;suggestion:-2+0\n  /x\n;;;",
      "\uFEFF```suggestion\n/merge",
      '<pre data-canonical-lang="&#115uggestion"><code>\n/close\n</code></pre>',
      "> ```suggestion:-0+0\n/two\n> ```",
      "Term\n: def\n  ```suggestion:-0+0\n  /two\n  ```",
      "```sh\n/approve\n```",
      "```ts\n/Label ~x\n```",
      "ok\n/MERGE\t",
    ]
  ) {
    const err = await assertRejects(
      () =>
        api.createReview(repo, ref, {
          body: "",
          comments: [
            { path: "src/app.ts", line: 1, side: "RIGHT", body: "fine" },
            { path: "src/app.ts", line: 2, side: "RIGHT", body },
          ],
          headSha: null,
        }),
      ForgeApiError,
      'starts with "/"',
    );
    assert(err.terminal);
    assert(err.message.startsWith("remark 2 (src/app.ts:2): line "), err.message);
  }
  assertEquals([mr.drafts, mr.discussions.filter((d) => !d.notes[0]!.system)], [[], []]);
  // A reply in the diff note's discussion is a diff note too.
  await api.createReview(repo, ref, {
    body: "",
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "Why?" }],
    headSha: null,
  });
  const remark = mr.discussions.find((d) => d.notes[0]?.type === "DiffNote")!;
  await assertRejects(
    () =>
      api.replyToReviewComment(
        repo,
        ref,
        `${ref}:${remark.id}:${remark.notes[0]!.id}`,
        "---suggestion\n/close\n---",
      ),
    ForgeApiError,
    'line 2 starts with "/"',
  );
  assertEquals(remark.notes.length, 1);
  assertEquals(mr.state, "opened");
});

test("prose about suggestions is posted on every write path, a diff note's included", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const issue = fake.openIssue(PROJECT, { as: "maya", title: "Broken" });
  const mrThread = { kind: "change_request" as const, ref: `mr-${mr.iid}` };
  // The kind of text a run's merge request and its status comment carry: refused once, it kept
  // the merge request from opening and left the status comment saying "working".
  const PROSE = 'Replaced the `<ul class="suggestions">` list.\n```html\n' +
    '<li class="suggestion" lang="en">\n<pre>x</pre>\n```\nTake `lang=suggestion` out too.';
  const sent = PROSE;

  const { commentId } = await api.postComment(repo, mrThread, PROSE);
  await api.updateComment(repo, commentId, `${PROSE}\nedited`);
  await api.createComment(repo, { kind: "issue", ref: `issue-${issue.iid}` }, PROSE);
  await api.createReview(repo, mrThread.ref, {
    body: PROSE,
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: PROSE }],
    headSha: null,
  });
  const remark = mr.discussions.find((d) => d.notes[0]?.type === "DiffNote")!;
  await api.replyToReviewComment(
    repo,
    mrThread.ref,
    `${mrThread.ref}:${remark.id}:${remark.notes[0]!.id}`,
    PROSE,
  );
  const opened = await api.createIssue(repo, { title: "New", body: PROSE, labels: [] });
  await fake.commit(PROJECT, { as: "dev", branch: "ryph/x", files: { "y.txt": "y\n" } });
  const delivered = await api.openMergeRequest(repo, {
    title: "Agent change",
    body: PROSE,
    head: "ryph/x",
    base: "main",
    draft: false,
  });

  const written = [
    ...mr.discussions.flatMap((d) => d.notes).filter((n) => !n.system).map((n) => n.body),
    ...issue.discussions.flatMap((d) => d.notes).filter((n) => !n.system).map((n) => n.body),
    fake.world.issues.find((i) => `issue-${i.iid}` === opened.ref)!.description,
    fake.world.mergeRequests.find((m) => `mr-${m.iid}` === delivered.ref)!.description,
  ];
  // Every one as written: nothing in it to escape, and nothing refused.
  assertEquals(written.toSorted(), [...Array(6).fill(sent), `${sent}\nedited`].toSorted());
  assertEquals(mr.state, "opened");
});

test("internal notes and confidential issues never reach an agent", async () => {
  const bodies: string[] = [];
  await using w = await world({
    imageSlots: (_owner, body) => {
      bodies.push(body);
      return [];
    },
  });
  const { fake, api } = w;
  const open = fake.openIssue(PROJECT, { as: "dev", title: "Open" });
  const secret = fake.openIssue(PROJECT, {
    as: "dev",
    title: "Secret",
    description: "the leaked key",
    confidential: true,
  });
  await fake.comment(PROJECT, `issue-${open.iid}`, { as: "dev", body: "public" });
  await fake.comment(PROJECT, `issue-${open.iid}`, {
    as: "maya",
    body: "staff only ![x](/uploads/0123/x.png)",
    internal: true,
  });
  const mr = await mergeRequest(fake);
  await fake.comment(PROJECT, `mr-${mr.iid}`, {
    as: "maya",
    body: "internal on MR",
    internal: true,
  });

  const thread = await api.fetchThread(repo, { kind: "issue", ref: `issue-${open.iid}` }, {
    images: { focus: null },
  });
  assertEquals(thread.entries.map((e) => e.body), ["public"]);
  assert(!bodies.some((b) => b.includes("staff only")));
  const onMr = await api.fetchThread(repo, { kind: "change_request", ref: `mr-${mr.iid}` });
  assert(!onMr.entries.some((e) => e.body.includes("internal")));

  const err = await assertRejects(
    () => api.fetchThread(repo, { kind: "issue", ref: `issue-${secret.iid}` }),
    ForgeApiError,
  );
  assert(err.terminal);
  assert(!err.message.includes("leaked"));
  const listed = await api.listIssues(repo, { state: "open", labels: [], page: 1 });
  assertEquals(listed.items.map((i) => i.ref), [`issue-${open.iid}`]);
});

test("two reviews on one merge request at once: each publishes its own, neither touches the other's", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  // Review A is paused at its first publish while review B runs start to finish: B sees A's
  // drafts pending under the same token. (Before, B cleared them as stale, or bulk-published
  // them as its own.)
  let paused = false;
  let b: Promise<unknown> | null = null;
  fake.intercept(async (req, path) => {
    if (!paused && /\/draft_notes\/(?:\d+\/publish|bulk_publish)$/.test(path)) {
      paused = true;
      b = api.createReview(repo, ref, {
        body: "Review B",
        comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "B remark" }],
        headSha: null,
      });
      await b;
    }
    return null;
  });
  await api.createReview(repo, ref, {
    body: "Review A",
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "A remark" }],
    headSha: null,
  });
  assert(paused);
  await b;
  const published = mr.discussions.flatMap((d) => d.notes).filter((n) => !n.system)
    .map((n) => n.body.split("\n")[0]).sort();
  assertEquals(published, ["A remark", "B remark", "Review A", "Review B"]);
  assertEquals(mr.drafts, []);

  // A draft of the bot's that is no call's (a crashed attempt, or one in flight) stays pending,
  // unpublished and undeleted.
  const bot = fake.client("ryph-bot");
  const other = await (await bot(
    "POST",
    `/projects/${encodeURIComponent(PROJECT)}/merge_requests/${mr.iid}/draft_notes`,
    {
      note: "someone else's",
    },
  )).json();
  await api.createReview(repo, ref, { body: "Review C", comments: [], headSha: null });
  assertEquals(mr.drafts.map((d) => d.id), [other.id]);
});

test("a merge underway (locked) is never an end state", async () => {
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  mr.state = "locked";
  const err = await assertRejects(() => api.describeChangeRequest(repo, ref), ForgeApiError);
  assert(!err.terminal);
  const state = await api.readChangeRequestState(repo, ref);
  assertEquals([state?.state, state?.merged], ["open", false]);
  const thread = await api.fetchThread(repo, { kind: "change_request", ref });
  assertEquals([thread.state, thread.changeRequest?.state], ["open", "open"]);
  const closed = await api.listChangeRequests(repo, { state: "closed", page: 1 });
  assertEquals(closed.items, []);
});

test("a remark lands on a file whose diff /diffs withholds, read from the head's version", async () => {
  await using w = await world();
  const { fake, api } = w;
  const big = Array.from({ length: 1_000 }, (_, i) => `line ${i} of a file past twenty KB`)
    .join("\n");
  const mr = await mergeRequest(fake, { "big.txt": `${big}\n` });
  const ref = `mr-${mr.iid}`;
  const patches = await api.listChangeRequestPatches(repo, ref);
  const file = patches.files.find((f) => f.path === "big.txt");
  assert(file?.patch?.startsWith("@@ -0,0 +1,1000 @@"));
  const files = await api.listChangeRequestFiles(repo, ref);
  assertEquals(files.items.find((f) => f.path === "big.txt")?.additions, 1_000);
  await api.createReview(repo, ref, {
    body: "",
    comments: [{ path: "big.txt", line: 900, side: "RIGHT", body: "this one" }],
    headSha: patches.headSha,
  });
  const remark = mr.discussions.flatMap((d) => d.notes).find((n) => n.body === "this one");
  assertEquals([remark?.type, remark?.position?.new_path, remark?.position?.new_line], [
    "DiffNote",
    "big.txt",
    900,
  ]);
});

test("a public project with a members-only repository, merge requests, issues or CI is private to read", async () => {
  await using w = await world();
  const { fake, api } = w;
  const created = await fake.addProject("acme/open", {
    visibility: "public",
    files: { "a": "a\n" },
  });
  // Read by its id: the ref a GitLab project is asked about is its `forgeId`.
  const open = gitlabProjectRef(fake.url, String(created.id));
  const readsPrivate = async () =>
    (await api.repoVisibility(null, [open])).get(open)?.source === "members";
  assertEquals(await readsPrivate(), false);
  // A feature nobody can reach holds nothing to leak.
  fake.setFeatureAccess("acme/open", "issues", "disabled");
  assertEquals(await readsPrivate(), false);
  for (const feature of ["repository", "merge_requests", "issues", "builds"] as const) {
    fake.setFeatureAccess("acme/open", feature, "private");
    assertEquals(await readsPrivate(), true, feature);
    fake.setFeatureAccess("acme/open", feature, "enabled");
  }
});

test("a run reading a private project may not open an issue on a public one whose code is members-only", async () => {
  // Read as one boolean, acme/tracker's members-only code made it "private", and the visibility
  // rule let a run that read private acme/widgets publish an issue on the tracker's public
  // issue list. As a target, only a private project's own features are members-only.
  await using w = await world();
  const { fake, api } = w;
  const tracker = await fake.addProject("acme/tracker", {
    visibility: "public",
    files: { "a": "a\n" },
  });
  fake.setFeatureAccess("acme/tracker", "repository", "private");
  const lobby = await fake.addProject("acme/lobby", {
    visibility: "internal",
    files: { "a": "a\n" },
  });
  const refs = [
    repo.forgeId,
    ...[tracker, lobby].map((p) => gitlabProjectRef(fake.url, String(p.id))),
  ];
  const repos = refs.map((repoRef, i) => ({
    connectedRepoId: `cr-${i}`,
    provider: "gitlab" as const,
    repoRef,
    tenantId: null,
  }));
  const grant = { repos, sourceRepos: [], origin: null } as unknown as ToolGrant;
  const answered = await api.repoVisibility(null, repos.map((r) => r.repoRef));
  const seen = new Map(repos.map((r) => [r.connectedRepoId, answered.get(r.repoRef)!]));
  assertEquals(seen.get("cr-0")!.source, "members", "acme/widgets is private");
  for (const target of repos.slice(1)) {
    for (const kind of ["issue", "change_request"] as const) {
      assert(visibilityRefusal(grant, seen, target, kind, null) !== null, target.repoRef);
    }
  }
  assertEquals(visibilityRefusal(grant, seen, repos[0], "issue", null), null);
});

test("visibility is an audience: a write may reach whoever could already read every held source", async () => {
  // An internal project is read by every account on the instance — no wider. A run holding only
  // one may write on its own threads and on other internal projects (the same audience), never
  // on a public one; a run holding a private project may write on neither.
  await using w = await world();
  const { fake, api } = w;
  const at = async (path: string, visibility: "public" | "internal" | "private", i: number) => ({
    connectedRepoId: `cr-${i}`,
    provider: "gitlab" as const,
    repoRef: gitlabProjectRef(
      fake.url,
      String((await fake.addProject(path, { visibility, files: { "a": "a\n" } })).id),
    ),
    tenantId: null,
  });
  const lobby = await at("acme/lobby", "internal", 1);
  const hall = await at("acme/hall", "internal", 2);
  const square = await at("acme/square", "public", 3);
  const widgets = { ...lobby, connectedRepoId: "cr-0", repoRef: repo.forgeId };
  const all = [widgets, lobby, hall, square];
  const answered = await api.repoVisibility(null, all.map((r) => r.repoRef));
  const seen = new Map(all.map((r) => [r.connectedRepoId, answered.get(r.repoRef)!]));
  const refusal = (held: typeof all, target: typeof lobby, kind: "issue" | "change_request") =>
    visibilityRefusal(
      { repos: held, sourceRepos: [], origin: null } as unknown as ToolGrant,
      new Map(held.map((r) => [r.connectedRepoId, seen.get(r.connectedRepoId)!])),
      target,
      kind,
      null,
    );
  for (const kind of ["issue", "change_request"] as const) {
    assertEquals(refusal([lobby], lobby, kind), null, `internal → itself (${kind})`);
    assertEquals(refusal([lobby, hall], hall, kind), null, `internal → internal (${kind})`);
    assert(refusal([lobby, square], square, kind) !== null, `internal → public (${kind})`);
    assert(refusal([widgets, lobby], lobby, kind) !== null, `private → internal (${kind})`);
    assertEquals(refusal([widgets], widgets, kind), null, `private → itself (${kind})`);
  }
});

test("an awaiting membership or a blocked account is no member: no permission, no sign-up", async () => {
  await using w = await world({ group: "acme" });
  const { fake, api } = w;
  fake.addUser({ username: "queued" });
  fake.addMember(PROJECT, "queued", "maintainer", { awaiting: true });
  fake.addMember("acme", "queued", "developer", { awaiting: true });
  fake.addMember("acme", "maya", "developer");
  const target = repo;
  const who = (username: string) =>
    gitlabAccountId(fake.url, String(fake.world.userByUsername(username)!.id));
  assertEquals(await api.checkPermission(target, who("queued"), "write"), "denied");
  assertEquals(await api.checkPermission(target, who("queued"), "admin"), "denied");
  assertEquals(await api.checkGroupMembership(who("queued")), "not-member");
  assertEquals(await api.checkPermission(target, who("maya"), "admin"), "allowed");
  assertEquals(await api.checkGroupMembership(who("maya")), "member");
  fake.blockUser("maya");
  assertEquals(await api.checkPermission(target, who("maya"), "admin"), "denied");
  assertEquals(await api.checkGroupMembership(who("maya")), "not-member");
});

test("permission is asked of the project by id: a renamed project's old path, re-created, answers nothing", async () => {
  await using w = await world();
  const { fake, api } = w;
  fake.addUser({ username: "mallory" });
  const id = String(fake.world.project(PROJECT)!.id);
  fake.renameProject(PROJECT, "acme/gadgets");
  // mallory makes a project at the path the real one was connected under, and maintains it.
  await fake.addProject(PROJECT);
  fake.addMember(PROJECT, "mallory", "maintainer");
  const stale = { repoRef: PROJECT, tenantId: null, forgeId: gitlabProjectRef(fake.url, id) };
  const who = (username: string) =>
    gitlabAccountId(fake.url, String(fake.world.userByUsername(username)!.id));
  assertEquals(await api.checkPermission(stale, who("mallory"), "admin"), "denied");
  assertEquals(await api.checkPermission(stale, who("maya"), "admin"), "allowed");
  // Without the id there is no project to ask about: never answered by the path.
  const unaddressed = { repoRef: PROJECT, tenantId: null };
  assertEquals(await api.checkPermission(unaddressed, who("mallory"), "admin"), "denied");
});

test("a signed reply's suggestion with an HTML comment applies byte-exact, after anything; the footer leads", async () => {
  // Round 10: the footer's comment neutralizing rewrote `<!--` inside the suggestion too, so
  // "Apply suggestion" committed `&lt;!--` into the file. Round 11: its exemption stopped at the
  // first fence run anywhere, even in prose, so this one still did. The footer now leads the
  // body and nothing in the agent's text is rewritten.
  await using w = await world();
  const { fake, api } = w;
  const mr = await mergeRequest(fake);
  const ref = `mr-${mr.iid}`;
  await api.createReview(repo, ref, {
    body: "",
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "Why?" }],
    headSha: null,
  });
  const remark = mr.discussions.find((d) => d.notes[0]?.type === "DiffNote")!;
  const suggested = "<!-- keep in sync with docs -->\nTWO";
  const prose = "Wrap it in a ~~~ block, not inline:\n\n<details><summary>why</summary>";
  const signed = withSignature(
    `${prose}\n\n\`\`\`suggestion\n${suggested}\n\`\`\`\n\nAnd mind <!-- this`,
    { agentName: "Ada", runUrl: null, requestedBy: "maya", requestedVia: null },
    "fa-1",
    "gitlab",
  );
  await api.replyToReviewComment(repo, ref, `${ref}:${remark.id}:${remark.notes[0]!.id}`, signed);
  const reply = remark.notes[1]!;
  // The suggestion first, at the very start where it is code to any markdown; then the footer,
  // ahead of every byte of the agent's own; then the rest as written.
  assertEquals(
    reply.body,
    `\`\`\`suggestion:-0+0\n${suggested}\n\`\`\`\n\n` +
      `<sub>Written by **Ada**, a Ryph agent · asked by @maya</sub>\n${actionMarker("fa-1")}\n\n` +
      `${prose}\n\n\nAnd mind <!-- this`,
  );
  const listed = await (await fake.client("maya")(
    "GET",
    `/projects/${encodeURIComponent(PROJECT)}/merge_requests/${mr.iid}/discussions`,
  )).json();
  const [suggestion] = listed.flatMap((d: { notes: unknown[] }) => d.notes)
    .find((n: { id: number }) => n.id === reply.id).suggestions;
  assertEquals(suggestion!.to_content, `${suggested}\n`);
  const applied = await fake.client("maya")("PUT", `/suggestions/${suggestion!.id}/apply`);
  assertEquals(applied.status, 200);
  assertEquals(await appOnFeat(fake), `one\n${suggested}\nthree\n`);
});

test("a merge request from a private fork ryph cannot see is a fork, not a deleted one; a deleted fork's is closed with no source", async () => {
  // Round 10: GitLab answers 404 for a private fork the bot is no member of, as for any project
  // it may not see; read as a deleted fork, every `/ryph` on such a merge request was refused.
  await using w = await world();
  const { fake, api } = w;
  const fork = await fake.fork(PROJECT, "dev");
  fork.visibility = "private";
  await fake.commit("dev/widgets", {
    as: "dev",
    branch: "feature",
    from: "main",
    files: { "src/app.ts": "one\nfork\nthree\n" },
  });
  const mr = await fake.openMergeRequest(PROJECT, {
    as: "dev",
    sourceProject: "dev/widgets",
    sourceBranch: "feature",
    title: "From a private fork",
  });
  const seen = (await fake.client("ryph-bot")("GET", `/projects/${fork.id}`)).status;
  assertEquals(seen, 404, "the bot cannot see the fork");
  const hidden = await api.describeChangeRequest(repo, `mr-${mr.iid}`);
  assertEquals(
    [hidden.state, hidden.sameRepo, hidden.headRepoHidden, hidden.headRepoUrl],
    ["open", false, true, null],
  );
  assert(hidden.headRepoRef !== null, "a fork, not a deleted one");
  const thread = await api.fetchThread(repo, { kind: "change_request", ref: `mr-${mr.iid}` });
  assertEquals(thread.changeRequest?.headRepoRef, hidden.headRepoRef);
  assertEquals(thread.changeRequest?.headRepoHidden, true);

  // A deleted fork: GitLab closes its merge requests and nulls their source project.
  fake.deleteProject("dev/widgets");
  const gone = await api.describeChangeRequest(repo, `mr-${mr.iid}`);
  assertEquals([gone.state, gone.headRepoRef, gone.sameRepo], ["closed", null, false]);
  assertEquals(gone.headRepoHidden, undefined);
});
