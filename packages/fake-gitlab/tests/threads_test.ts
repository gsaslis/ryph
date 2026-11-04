// Issues, notes, discussions, award emoji and labels: the conversation surface ryph's forge
// tools and `/ryph` commands read and write.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { seeded, WIDGETS } from "./util.ts";
import { extractQuickActions } from "../src/quick_actions.ts";

const W = encodeURIComponent(WIDGETS);

test("issues and merge requests number apart: #1 and !1 coexist", async () => {
  await using fake = await seeded();
  await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "x.txt": "x\n" } });
  const issue = fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const mr = await fake.openMergeRequest(WIDGETS, {
    as: "dev",
    sourceBranch: "feat",
    title: "Fix",
  });
  assertEquals([issue.iid, mr.iid], [1, 1]);
  const bot = fake.client("ryph-bot");
  const i = await (await bot("GET", `/projects/${W}/issues/1`)).json();
  const m = await (await bot("GET", `/projects/${W}/merge_requests/1`)).json();
  assertEquals([i.title, i.references.short, m.title, m.reference], ["Broken", "#1", "Fix", "!1"]);
  assertEquals(i.web_url, `${fake.url}/${WIDGETS}/-/issues/1`);
  assertEquals(m.web_url, `${fake.url}/${WIDGETS}/-/merge_requests/1`);
  // The issues list never carries merge requests.
  const list = await (await bot("GET", `/projects/${W}/issues`)).json();
  assertEquals(list.map((x: { title: string }) => x.title), ["Broken"]);
});

test("issues: create with labels, filter, close with state_event, labels added on PUT", async () => {
  await using fake = await seeded();
  const bot = fake.client("ryph-bot");
  const made = await bot("POST", `/projects/${W}/issues`, {
    title: "Flaky test",
    description: "it flakes",
    labels: "bug,ci",
  });
  assertEquals(made.status, 201);
  const issue = await made.json();
  assertEquals([issue.iid, issue.state, issue.labels, issue.author.username], [1, "opened", [
    "bug",
    "ci",
  ], "ryph-bot"]);
  fake.openIssue(WIDGETS, { as: "dev", title: "Other" });

  const bugs = await (await bot("GET", `/projects/${W}/issues?labels=bug&state=opened`)).json();
  assertEquals(bugs.map((x: { iid: number }) => x.iid), [1]);
  const byAuthor = await (await bot(
    "GET",
    `/projects/${W}/issues?author_id=${fake.world.userByUsername("dev")!.id}`,
  )).json();
  assertEquals(byAuthor.map((x: { iid: number }) => x.iid), [2]);

  const put = await bot("PUT", `/projects/${W}/issues/1`, {
    add_labels: "triaged",
    state_event: "close",
  });
  const closed = await put.json();
  assertEquals([closed.state, closed.labels, closed.closed_by.username], ["closed", [
    "bug",
    "ci",
    "triaged",
  ], "ryph-bot"]);
  const open = await (await bot("GET", `/projects/${W}/issues?state=opened`)).json();
  assertEquals(open.map((x: { iid: number }) => x.iid), [2]);
  // Labels created on the fly are project labels; group labels show with ancestors on.
  fake.world.groupByPath("acme")!.labels.push({
    id: 1,
    name: "org-wide",
    color: "#000000",
    description: null,
    groupId: 1,
  });
  const labels = await (await bot("GET", `/projects/${W}/labels?per_page=100`)).json();
  const names = labels.map((l: { name: string }) => l.name);
  assert(["bug", "ci", "triaged", "org-wide"].every((n) => names.includes(n)), names.join());
  const own = await (await bot("GET", `/projects/${W}/labels?include_ancestor_groups=false`))
    .json();
  assert(!own.some((l: { name: string }) => l.name === "org-wide"));
  // A Guest may not relabel someone else's issue.
  const guest = fake.client("guest");
  assertEquals((await guest("PUT", `/projects/${W}/issues/2`, { add_labels: "x" })).status, 403);
});

test("notes: post, edit, list newest first by default; system notes listed but flagged", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const bot = fake.client("ryph-bot");
  const dev = fake.client("dev");
  const posted =
    await (await dev("POST", `/projects/${W}/issues/1/notes`, { body: "/ryph fix it" })).json();
  assertEquals([posted.body, posted.type, posted.system, posted.noteable_iid], [
    "/ryph fix it",
    null,
    false,
    1,
  ]);
  const progress = await (await bot("POST", `/projects/${W}/issues/1/notes`, { body: "working…" }))
    .json();
  const edited = await bot("PUT", `/projects/${W}/issues/1/notes/${progress.id}`, { body: "done" });
  assertEquals((await edited.json()).body, "done");
  // Only the author edits a note.
  assertEquals(
    (await dev("PUT", `/projects/${W}/issues/1/notes/${progress.id}`, { body: "mine" })).status,
    403,
  );
  await bot("PUT", `/projects/${W}/issues/1`, { state_event: "close" });
  const notes = await (await bot("GET", `/projects/${W}/issues/1/notes`)).json();
  assertEquals(notes.map((n: { body: string; system: boolean }) => [n.body, n.system]), [
    ["closed", true],
    ["done", false],
    ["/ryph fix it", false],
  ]);
  const asc = await (await bot("GET", `/projects/${W}/issues/1/notes?sort=asc&order_by=created_at`))
    .json();
  assertEquals(asc[0].body, "/ryph fix it");
  const one = await (await bot("GET", `/projects/${W}/issues/1/notes/${posted.id}`)).json();
  assertEquals(one.id, posted.id);
  assertEquals((await bot("GET", `/projects/${W}/issues/1/notes/999999`)).status, 404);
});

test("quick actions: known ones applied and stripped, /ryph left as written", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const maya = fake.client("maya");
  const n = await (await maya("POST", `/projects/${W}/issues/1/notes`, {
    body: '/label ~bug ~"needs triage"\n/ryph look at this',
  })).json();
  assertEquals(n.body, "/ryph look at this");
  const issue = await (await maya("GET", `/projects/${W}/issues/1`)).json();
  assertEquals(issue.labels, ["bug", "needs triage"]);
  const only = await maya("POST", `/projects/${W}/issues/1/notes`, { body: "/close" });
  assertEquals(only.status, 202);
  assertEquals((await (await maya("GET", `/projects/${W}/issues/1`)).json()).state, "closed");
});

test("quick actions run only from column 0 of a top-level paragraph, \r deleted first", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const maya = fake.client("maya");
  const post = async (body: string) =>
    await maya("POST", `/projects/${W}/issues/1/notes`, { body });
  const labels = async () =>
    (await (await maya("GET", `/projects/${W}/issues/1`)).json()).labels as string[];
  // None of these runs: indented, escaped, in a fence, in a quote or a list, or not a name.
  for (
    const body of [
      " /label ~indented",
      "\\/label ~escaped",
      "```\n/label ~fenced\n```",
      "~~~\n/label ~tilde\n~~~",
      "> quoted\n/label ~lazy",
      "- item\n/label ~listed",
      "/labelled ~x",
    ]
  ) {
    const res = await post(body);
    assertEquals(res.status, 201, body);
    assertEquals((await res.json()).body, body);
  }
  assertEquals(await labels(), []);
  // These do: after text in the same paragraph, after CRLF, and in any case.
  const res = await post("look\r\n/LABEL ~crlf\r\n/label ~two");
  assertEquals((await res.json()).body, "look");
  assertEquals(await labels(), ["crlf", "two"]);
});

test("a quick action needs both detections: the rendered paragraph and the raw line", () => {
  // `\/label` renders as `/label`, so its paragraph is a candidate; its source line does not
  // start with `/`, so nothing runs — unless the line were matched as rendered.
  assertEquals(extractQuickActions("\\/label ~x").actions, []);
  assertEquals(extractQuickActions("\\/label ~x", undefined, { matchRendered: true }).actions, [
    { name: "label", arg: "~x" },
  ]);
  // A zero-width space is text to both: nothing to detect either way.
  for (const matchRendered of [false, true]) {
    assertEquals(extractQuickActions("\u200B/label ~x", undefined, { matchRendered }).actions, []);
  }
  // An indented line renders without its blanks — a candidate — but its source starts with one.
  assertEquals(extractQuickActions("text\n /close").actions, []);
});

test("quick actions run in a note's edit, a reply, a published draft, and a description", async () => {
  await using fake = await seeded();
  await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "x.txt": "x\n" } });
  fake.openIssue(WIDGETS, { as: "maya", title: "Broken" });
  await fake.openMergeRequest(WIDGETS, { as: "maya", sourceBranch: "feat", title: "Fix" });
  const maya = fake.client("maya");
  const issue = async () => await (await maya("GET", `/projects/${W}/issues/1`)).json();
  const mr = async () => await (await maya("GET", `/projects/${W}/merge_requests/1`)).json();

  const note = await (await maya("POST", `/projects/${W}/issues/1/notes`, { body: "hi" })).json();
  const edited = await (await maya("PUT", `/projects/${W}/issues/1/notes/${note.id}`, {
    body: "hi\n/label ~edited",
  })).json();
  assertEquals(edited.body, "hi");
  assertEquals((await issue()).labels, ["edited"]);

  const d = await (await maya("POST", `/projects/${W}/merge_requests/1/discussions`, {
    body: "thread",
  })).json();
  const reply = await maya("POST", `/projects/${W}/merge_requests/1/discussions/${d.id}/notes`, {
    body: "/label ~replied",
  });
  assertEquals(reply.status, 202);
  assertEquals((await mr()).labels, ["replied"]);

  const draft = await (await maya("POST", `/projects/${W}/merge_requests/1/draft_notes`, {
    note: "done\n/close",
  })).json();
  assertEquals(draft.note, "done\n/close");
  assertEquals((await mr()).state, "opened");
  await maya("PUT", `/projects/${W}/merge_requests/1/draft_notes/${draft.id}/publish`);
  assertEquals((await mr()).state, "closed");

  const made = await (await maya("POST", `/projects/${W}/issues`, {
    title: "New",
    description: "body\n/label ~from-description\n/close",
  })).json();
  // Nothing to close yet when it is being created: that line stays.
  assertEquals([made.description, made.labels, made.state], [
    "body\n/close",
    ["from-description"],
    "opened",
  ]);
  const put = await (await maya("PUT", `/projects/${W}/issues/1`, {
    description: "edited\n/close",
  })).json();
  assertEquals([put.description, put.state], ["edited", "closed"]);
});

test("internal notes and confidential issues: Reporters and the author see them, a Guest does not", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Open" });
  fake.openIssue(WIDGETS, { as: "dev", title: "Secret", confidential: true });
  await fake.comment(WIDGETS, "issue-1", { as: "dev", body: "public" });
  await fake.comment(WIDGETS, "issue-1", { as: "dev", body: "staff only", internal: true });
  const bot = fake.client("ryph-bot");
  const guest = fake.client("guest");
  const notes = await (await bot("GET", `/projects/${W}/issues/1/notes?sort=asc`)).json();
  assertEquals(
    notes.map((n: { body: string; internal: boolean; confidential: boolean }) => [
      n.body,
      n.internal,
      n.confidential,
    ]),
    [["public", false, false], ["staff only", true, true]],
  );
  const seen = await (await guest("GET", `/projects/${W}/issues/1/discussions`)).json();
  assertEquals(
    seen.flatMap((d: { notes: Array<{ body: string }> }) => d.notes.map((n) => n.body)),
    [
      "public",
    ],
  );
  const secret = await (await bot("GET", `/projects/${W}/issues/2`)).json();
  assertEquals(secret.confidential, true);
  assertEquals((await guest("GET", `/projects/${W}/issues/2`)).status, 404);
  const open = await (await bot("GET", `/projects/${W}/issues?confidential=false`)).json();
  assertEquals(open.map((i: { iid: number }) => i.iid), [1]);
  const asGuest = await (await guest("GET", `/projects/${W}/issues`)).json();
  assertEquals(asGuest.map((i: { iid: number }) => i.iid), [1]);
});

test("discussions: start, reply, resolve; an individual note becomes a thread when replied to", async () => {
  await using fake = await seeded();
  await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "x.txt": "x\n" } });
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const dev = fake.client("dev");
  const d =
    await (await dev("POST", `/projects/${W}/merge_requests/1/discussions`, { body: "why?" }))
      .json();
  assertEquals([d.id.length, d.individual_note, d.notes[0].type, d.notes[0].resolvable], [
    40,
    false,
    "DiscussionNote",
    true,
  ]);
  const reply = await bot("POST", `/projects/${W}/merge_requests/1/discussions/${d.id}/notes`, {
    body: "because",
  });
  assertEquals(reply.status, 201);
  const resolved =
    await (await bot("PUT", `/projects/${W}/merge_requests/1/discussions/${d.id}?resolved=true`))
      .json();
  assert(resolved.notes.every((n: { resolved: boolean }) => n.resolved));
  assertEquals(resolved.notes[0].resolved_by.username, "ryph-bot");
  // Idempotent.
  assertEquals(
    (await bot("PUT", `/projects/${W}/merge_requests/1/discussions/${d.id}?resolved=true`)).status,
    200,
  );
  // A Guest may not resolve.
  const guest = fake.client("guest");
  assertEquals(
    (await guest("PUT", `/projects/${W}/merge_requests/1/discussions/${d.id}?resolved=false`))
      .status,
    403,
  );

  const plain = await (await dev("POST", `/projects/${W}/merge_requests/1/notes`, { body: "lgtm" }))
    .json();
  const all = await (await bot("GET", `/projects/${W}/merge_requests/1/discussions`)).json();
  const holder = all.find((x: { notes: Array<{ id: number }> }) => x.notes[0]!.id === plain.id);
  assertEquals(holder.individual_note, true);
  await bot("POST", `/projects/${W}/merge_requests/1/discussions/${holder.id}/notes`, {
    body: "thanks",
  });
  const again = await (await bot("GET", `/projects/${W}/merge_requests/1/discussions/${holder.id}`))
    .json();
  assertEquals([again.individual_note, again.notes.length], [false, 2]);
  assertEquals(
    (await bot("GET", `/projects/${W}/merge_requests/1/discussions/${"f".repeat(40)}`)).status,
    404,
  );
});

test("award emoji: on notes and on the issuable; a repeat is refused", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const { noteId } = await fake.comment(WIDGETS, "issue-1", { as: "dev", body: "/ryph go" });
  const bot = fake.client("ryph-bot");
  const first = await bot("POST", `/projects/${W}/issues/1/notes/${noteId}/award_emoji`, {
    name: "eyes",
  });
  assertEquals(first.status, 201);
  const a = await first.json();
  assertEquals([a.name, a.awardable_type, a.awardable_id, a.user.username], [
    "eyes",
    "Note",
    noteId,
    "ryph-bot",
  ]);
  const again = await bot("POST", `/projects/${W}/issues/1/notes/${noteId}/award_emoji`, {
    name: "eyes",
  });
  assertEquals(again.status, 404);
  assert((await again.json()).message.includes("has already been taken"));
  const listed = await (await bot("GET", `/projects/${W}/issues/1/notes/${noteId}/award_emoji`))
    .json();
  assertEquals(listed.length, 1);
  assertEquals(
    (await bot("POST", `/projects/${W}/issues/1/award_emoji`, { name: "thumbsup" })).status,
    201,
  );
  assertEquals((await (await bot("GET", `/projects/${W}/issues/1`)).json()).upvotes, 1);
  assertEquals(
    (await bot("DELETE", `/projects/${W}/issues/1/notes/${noteId}/award_emoji/${a.id}`)).status,
    204,
  );
});

test("an outsider cannot comment on a private project; a missing iid is 404", async () => {
  await using fake = await seeded();
  fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
  const outsider = fake.client("outsider");
  const r = await outsider("POST", `/projects/${W}/issues/1/notes`, { body: "hi" });
  assertEquals([r.status, await r.json()], [404, { message: "404 Project Not Found" }]);
  const bot = fake.client("ryph-bot");
  assertEquals(await (await bot("GET", `/projects/${W}/issues/9`)).json(), {
    message: "404 Issue Not Found",
  });
  assertEquals((await bot("GET", `/projects/${W}/merge_requests/9`)).status, 404);
  assertEquals(await (await bot("POST", `/projects/${W}/issues`, {})).json(), {
    error: "title is missing",
  });
});
