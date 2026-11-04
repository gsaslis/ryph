// Merge requests: open and adopt (409), diffs and commits, diff-note positions, draft notes and
// their bulk publish, commit statuses, approvals, and the three merge methods.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { revParse } from "../src/git/repo.ts";
import { seeded, WIDGETS } from "./util.ts";

const W = encodeURIComponent(WIDGETS);
const APP = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

/** `feat` changes line 2, removes line 5, adds a line after 8: one hunk per change. */
async function withChange() {
  const fake = await seeded();
  const edited = APP.replace("two\n", "TWO\n").replace("five\n", "").replace(
    "eight\n",
    "eight\nadded\n",
  );
  await fake.commit(WIDGETS, {
    as: "dev",
    branch: "feat",
    files: { "src/app.ts": edited, "new.md": "hi\n" },
  });
  return fake;
}

test("open, read back with diff_refs, adopt on 409", async () => {
  await using fake = await withChange();
  const bot = fake.client("ryph-bot");
  const body = {
    source_branch: "feat",
    target_branch: "main",
    title: "Draft: Fix",
    description: "Closes #1",
    allow_collaboration: false,
    remove_source_branch: true,
  };
  const made = await bot("POST", `/projects/${W}/merge_requests`, body);
  assertEquals(made.status, 201);
  const mr = await made.json();
  assertEquals([mr.iid, mr.state, mr.draft, mr.source_project_id, mr.target_project_id], [
    1,
    "opened",
    true,
    mr.project_id,
    mr.project_id,
  ]);
  const p = fake.world.project(WIDGETS)!;
  assertEquals(mr.sha, await revParse(p.gitDir, "refs/heads/feat"));
  assertEquals(mr.diff_refs.head_sha, mr.sha);
  assertEquals(mr.diff_refs.start_sha, await revParse(p.gitDir, "refs/heads/main"));
  assertEquals(mr.diff_refs.base_sha, mr.diff_refs.start_sha);
  // The head ref GitLab keeps for every merge request.
  assertEquals(await revParse(p.gitDir, "refs/merge-requests/1/head"), mr.sha);

  const dup = await bot("POST", `/projects/${W}/merge_requests`, body);
  assertEquals(dup.status, 409);
  assertEquals(await dup.json(), {
    message: ["Another open merge request already exists for this source branch: !1"],
  });
  const found = await (await bot(
    "GET",
    `/projects/${W}/merge_requests?state=opened&source_branch=feat&target_branch=main`,
  )).json();
  assertEquals(found.map((m: { iid: number }) => m.iid), [1]);
  assertEquals(
    (await (await bot("GET", `/projects/${W}/merge_requests?state=merged`)).json()).length,
    0,
  );

  // A Guest may not open one; a missing branch is a 400.
  const guest = fake.client("guest");
  assertEquals(
    (await guest("POST", `/projects/${W}/merge_requests`, { ...body, source_branch: "x" })).status,
    403,
  );
  const missing = await bot("POST", `/projects/${W}/merge_requests`, {
    ...body,
    source_branch: "nope",
  });
  assertEquals(missing.status, 400);
});

test("diffs: per file, with status flags and hunk text; commits newest first with X-Total", async () => {
  await using fake = await withChange();
  await fake.commit(WIDGETS, {
    as: "dev",
    branch: "feat",
    files: { "new.md": "hello\n" },
    message: "second\n",
  });
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const diffs = await (await bot("GET", `/projects/${W}/merge_requests/1/diffs`)).json();
  const byPath = Object.fromEntries(diffs.map((d: { new_path: string }) => [d.new_path, d]));
  assertEquals(byPath["new.md"].new_file, true);
  assertEquals(byPath["new.md"].diff, "@@ -0,0 +1 @@\n+hello\n");
  assertEquals(byPath["src/app.ts"].new_file, false);
  assert(byPath["src/app.ts"].diff.startsWith("@@ -1,"));
  assert(byPath["src/app.ts"].diff.includes("+TWO\n"));
  const commits = await bot("GET", `/projects/${W}/merge_requests/1/commits`);
  assertEquals(commits.headers.get("x-total"), "2");
  const list = await commits.json();
  assertEquals(list.map((c: { title: string }) => c.title), [
    "second",
    "Update src/app.ts, new.md",
  ]);
});

test("versions: one per head, newest first, the newest on diff_refs; a version carries a diff /diffs withholds", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const big = Array.from({ length: 1_000 }, (_, i) => `line ${i} of a file past twenty KB`)
    .join("\n");
  await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "big.txt": `${big}\n` } });
  const bot = fake.client("ryph-bot");
  const mr = await (await bot("GET", `/projects/${W}/merge_requests/1`)).json();
  const versions = await (await bot("GET", `/projects/${W}/merge_requests/1/versions`)).json();
  assertEquals(versions.length, 2);
  assertEquals(
    [versions[0].head_commit_sha, versions[0].base_commit_sha, versions[0].start_commit_sha],
    [mr.diff_refs.head_sha, mr.diff_refs.base_sha, mr.diff_refs.start_sha],
  );
  assert(versions[1].head_commit_sha !== mr.sha);
  const diffs = await (await bot("GET", `/projects/${W}/merge_requests/1/diffs`)).json();
  assertEquals(diffs.find((d: { new_path: string }) => d.new_path === "big.txt").diff, "");
  const one = await (await bot("GET", `/projects/${W}/merge_requests/1/versions/${versions[0].id}`))
    .json();
  const carried = one.diffs.find((d: { new_path: string }) => d.new_path === "big.txt").diff;
  assert(carried.length > 20 * 1024 && carried.startsWith("@@ -0,0 +1,1000 @@"));
  assertEquals((await bot("GET", `/projects/${W}/merge_requests/1/versions/999999`)).status, 404);
});

test("diff notes: added lines take new_line, removed old_line, unchanged both; stale refs refused", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const refs = (await (await bot("GET", `/projects/${W}/merge_requests/1`)).json()).diff_refs;
  const at = (
    lines: { old_line?: number; new_line?: number },
    extra: Record<string, unknown> = {},
  ) => ({
    body: "here",
    position: {
      position_type: "text",
      ...refs,
      old_path: "src/app.ts",
      new_path: "src/app.ts",
      ...lines,
      ...extra,
    },
  });
  const post = (b: unknown) => bot("POST", `/projects/${W}/merge_requests/1/discussions`, b);
  // Line 2 became "TWO": new line 2 is added, old line 2 removed.
  assertEquals((await post(at({ new_line: 2 }))).status, 201);
  assertEquals((await post(at({ old_line: 2 }))).status, 201);
  // Old 5 was removed.
  assertEquals((await post(at({ old_line: 5 }))).status, 201);
  // "three": old 3, new 3, a context line.
  assertEquals((await post(at({ old_line: 3, new_line: 3 }))).status, 201);
  // "nine" sits after a removal and an addition: old 9, new 9 — inside the second hunk's
  // context or past it, the shift is the same.
  assertEquals((await post(at({ old_line: 9, new_line: 9 }))).status, 201);
  // Wrong: a context line with only new_line, an unchanged line with a wrong pairing (GitLab's
  // 400), and a SHA the project does not have (its 500).
  assertEquals((await post(at({ new_line: 3 }))).status, 400);
  assertEquals((await post(at({ old_line: 3, new_line: 4 }))).status, 400);
  assertEquals((await post(at({ new_line: 2 }, { head_sha: "0".repeat(40) }))).status, 500);
  const d = await (await post(at({ new_line: 9, old_line: 9 }))).json();
  assertEquals([d.notes[0].type, d.notes[0].position.new_line, d.notes[0].position.new_path], [
    "DiffNote",
    9,
    "src/app.ts",
  ]);
  // A reply in a diff discussion is a DiffNote too.
  const reply =
    await (await bot("POST", `/projects/${W}/merge_requests/1/discussions/${d.id}/notes`, {
      body: "ok",
    })).json();
  assertEquals(reply.type, "DiffNote");
});

test("draft notes: create, list own, delete, bulk publish — a bad position dropped there", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const refs = (await (await bot("GET", `/projects/${W}/merge_requests/1`)).json()).diff_refs;
  const position = {
    position_type: "text",
    ...refs,
    old_path: "src/app.ts",
    new_path: "src/app.ts",
    new_line: 2,
  };
  const draft = await (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes`, {
    note: "rename?",
    position,
  })).json();
  assertEquals([draft.note, draft.position.new_line], ["rename?", 2]);
  const body = await (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes`, {
    note: "Review summary",
  })).json();
  const doomed =
    await (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes`, { note: "oops" }))
      .json();
  // A line off the diff is taken now and dropped at the publish, as GitLab 17.11 does; a SHA the
  // project does not have is its 500.
  const offDiff = await (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes`, {
    note: "x",
    position: { ...position, new_line: 3 },
  })).json();
  assertEquals(
    (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes`, {
      note: "x",
      position: { ...position, head_sha: "b".repeat(40) },
    })).status,
    500,
  );
  assertEquals(
    (await bot("DELETE", `/projects/${W}/merge_requests/1/draft_notes/${doomed.id}`)).status,
    204,
  );
  const listed = await (await bot("GET", `/projects/${W}/merge_requests/1/draft_notes`)).json();
  assertEquals(listed.map((d: { id: number }) => d.id), [draft.id, body.id, offDiff.id]);
  // Drafts are private to their author until published.
  assertEquals(
    (await (await fake.client("dev")("GET", `/projects/${W}/merge_requests/1/draft_notes`)).json())
      .length,
    0,
  );
  assertEquals(
    (await (await bot("GET", `/projects/${W}/merge_requests/1/discussions`)).json()).length,
    0,
  );

  assertEquals(
    (await bot("POST", `/projects/${W}/merge_requests/1/draft_notes/bulk_publish`)).status,
    204,
  );
  const ds = await (await bot("GET", `/projects/${W}/merge_requests/1/discussions`)).json();
  assertEquals(
    ds.map((
      d: { notes: Array<{ body: string; type: string }> },
    ) => [d.notes[0]!.body, d.notes[0]!.type]),
    [
      ["rename?", "DiffNote"],
      ["Review summary", "Note"],
    ],
  );
  assertEquals(
    (await (await bot("GET", `/projects/${W}/merge_requests/1/draft_notes`)).json()).length,
    0,
  );
});

test("commit statuses: the state machine, latest per name, ids, refusals", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const p = fake.world.project(WIDGETS)!;
  const sha = (await revParse(p.gitDir, "refs/heads/feat"))!;
  const bot = fake.client("ryph-bot");
  const post = (b: Record<string, unknown>) => bot("POST", `/projects/${W}/statuses/${sha}`, b);
  const base = { name: "ryph / test", ref: "feat", target_url: "https://ryph.example/c/1" };
  const pending = await (await post({ ...base, state: "pending", description: "queued" })).json();
  assertEquals([pending.status, pending.name, pending.target_url], [
    "pending",
    "ryph / test",
    "https://ryph.example/c/1",
  ]);
  const again = await post({ ...base, state: "pending" });
  assertEquals([again.status, (await again.json()).message], [
    400,
    'Cannot transition status via :enqueue from :pending (Reason(s): Status cannot transition via "enqueue")',
  ]);
  const running = await (await post({ ...base, state: "running" })).json();
  assertEquals(running.id, pending.id);
  assertEquals((await (await post({ ...base, state: "success" })).json()).status, "success");
  // A final status takes a new job.
  const rerun = await (await post({ ...base, state: "pending" })).json();
  assertNotEquals(rerun.id, pending.id);
  await post({ name: "ryph / lint", ref: "feat", state: "failed" });
  const latest = await (await bot("GET", `/projects/${W}/repository/commits/${sha}/statuses`))
    .json();
  assertEquals(latest.map((s: { name: string; status: string }) => [s.name, s.status]), [
    ["ryph / lint", "failed"],
    ["ryph / test", "pending"],
  ]);
  const all = await (await bot("GET", `/projects/${W}/repository/commits/${sha}/statuses?all=true`))
    .json();
  assertEquals(all.length, 3);
  // Developer and above only; an unknown commit is 404; a long description is refused.
  assertEquals(
    (await fake.client("guest")("POST", `/projects/${W}/statuses/${sha}`, { state: "pending" }))
      .status,
    403,
  );
  assertEquals(
    (await bot("POST", `/projects/${W}/statuses/${"a".repeat(40)}`, { state: "pending" })).status,
    404,
  );
  assertEquals(
    (await post({ ...base, name: "x", state: "pending", description: "d".repeat(256) })).status,
    400,
  );
  // No ref: the first branch holding the commit; none holds a fork's head in the parent; a
  // protected branch's pipeline is not a Developer's to start (all as GitLab 17.11 answers).
  const noRef = await (await post({ name: "ryph / ref", state: "pending" })).json();
  assertEquals(noRef.ref, "feat");
  const mainSha = await fake.commit(WIDGETS, {
    as: "maya",
    branch: "main",
    files: { "only-main.txt": "m\n" },
  });
  assertEquals(
    (await bot("POST", `/projects/${W}/statuses/${mainSha}`, { name: "m", state: "pending" }))
      .status,
    403,
  );
});

test("approvals: system notes a reader rebuilds reviews from", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  await fake.approve(WIDGETS, 1, { as: "maya" });
  fake.requestChanges(WIDGETS, 1, { as: "ryph-bot" });
  const bot = fake.client("ryph-bot");
  const notes = await (await bot("GET", `/projects/${W}/merge_requests/1/notes?sort=asc`)).json();
  assertEquals(
    notes.map((
      n: { body: string; system: boolean; author: { username: string } },
    ) => [n.body, n.system, n.author.username]),
    [
      ["approved this merge request", true, "maya"],
      ["requested changes", true, "ryph-bot"],
    ],
  );
  const approvals = await (await bot("GET", `/projects/${W}/merge_requests/1/approvals`)).json();
  assertEquals(approvals.approved_by.map((a: { user: { username: string } }) => a.user.username), [
    "maya",
  ]);
});

test("merge: merge commit, squash, fast-forward; the head stays the merge request's", async () => {
  for (const method of ["merge", "squash", "ff"] as const) {
    await using fake = await withChange();
    const p = fake.world.project(WIDGETS)!;
    // Move main on so ff has to rebase.
    await fake.commit(WIDGETS, { as: "maya", branch: "main", files: { "other.md": "x\n" } });
    const mr = await fake.openMergeRequest(WIDGETS, {
      as: "dev",
      sourceBranch: "feat",
      title: "Fix",
      removeSourceBranch: true,
    });
    const head = mr.headSha;
    await fake.merge(WIDGETS, 1, { as: "maya", method });
    const tip = (await revParse(p.gitDir, "refs/heads/main"))!;
    const read = await (await fake.client("ryph-bot")("GET", `/projects/${W}/merge_requests/1`))
      .json();
    assertEquals([read.state, read.sha, read.merged_by.username], ["merged", head, "maya"], method);
    assertEquals(read.diff_refs.head_sha, head, method);
    if (method === "merge") assertEquals(read.merge_commit_sha, tip);
    if (method === "squash") {
      assert(read.squash_commit_sha && read.merge_commit_sha === tip, method);
    }
    if (method === "ff") assertNotEquals(tip, head, "ff rebased onto the moved main");
    // The source branch is gone; the merge request's head ref stays.
    assertEquals(await revParse(p.gitDir, "refs/heads/feat"), null, method);
    assertEquals(await revParse(p.gitDir, "refs/merge-requests/1/head"), head, method);
  }
});

test("REST merge: Maintainer only into a protected branch; a stale sha is 409", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  assertEquals(
    (await fake.client("dev")("PUT", `/projects/${W}/merge_requests/1/merge`)).status,
    401,
  );
  const maya = fake.client("maya");
  assertEquals(
    (await maya("PUT", `/projects/${W}/merge_requests/1/merge`, { sha: "0".repeat(40) })).status,
    409,
  );
  const merged = await (await maya("PUT", `/projects/${W}/merge_requests/1/merge`)).json();
  assertEquals(merged.state, "merged");
  assertEquals((await maya("PUT", `/projects/${W}/merge_requests/1/merge`)).status, 405);
});

test("fork merge requests: opened from the fork into the parent; the head ref lands in the parent", async () => {
  await using fake = await seeded();
  const fork = await fake.fork(WIDGETS, "outsider");
  await fake.commit(fork.path, { as: "outsider", branch: "patch", files: { "fix.txt": "fix\n" } });
  const out = fake.client("outsider");
  const parent = fake.world.project(WIDGETS)!;
  // The outsider needs to read the target: make it internal.
  parent.visibility = "internal";
  const made = await out("POST", `/projects/${fork.id}/merge_requests`, {
    source_branch: "patch",
    target_branch: "main",
    target_project_id: parent.id,
    title: "From a fork",
    allow_collaboration: true,
  });
  assertEquals(made.status, 201);
  const mr = await made.json();
  // A private fork cannot allow collaboration: GitLab 17.11 takes the setting and answers false.
  assertEquals([mr.source_project_id, mr.target_project_id, mr.allow_collaboration], [
    fork.id,
    parent.id,
    false,
  ]);
  assertEquals(await revParse(parent.gitDir, "refs/merge-requests/1/head"), mr.sha);
  const src = await (await out("GET", `/projects/${fork.id}`)).json();
  assertEquals(src.forked_from_project.id, parent.id);
  // A private fork is the fork owner's alone.
  assertEquals((await fake.client("ryph-bot")("GET", `/projects/${fork.id}`)).status, 404);
  // A deleted fork answers 404 to its owner too; its merge request stays, closed, its source
  // project nulled (GitLab's foreign key), so a deleted fork reads apart from a hidden one.
  fake.deleteProject(fork.path);
  assertEquals((await out("GET", `/projects/${fork.id}`)).status, 404);
  const after = await fake.client("ryph-bot")("GET", `/projects/${W}/merge_requests/1`);
  assertEquals(after.status, 200);
  const left = await after.json();
  assertEquals([left.state, left.source_project_id, left.target_project_id], [
    "closed",
    null,
    parent.id,
  ]);
});

test("suggestions: listed on the diff note, applied onto the source branch as written", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const refs = (await (await bot("GET", `/projects/${W}/merge_requests/1`)).json()).diff_refs;
  const suggest = async (body: string) =>
    (await (await bot("POST", `/projects/${W}/merge_requests/1/discussions`, {
      body,
      position: {
        position_type: "text",
        ...refs,
        new_path: "src/app.ts",
        old_path: "src/app.ts",
        new_line: 2,
      },
    })).json()).notes[0].suggestions[0];
  // Anywhere in the note: here in a list item, a tab in it kept.
  const s = await suggest("Rather:\n- ```suggestion:-1+1\n  one\n  \t2 // two\n  three!\n  ```");
  const other = await suggest("```suggestion\nfour\n```");
  assertEquals([s.from_line, s.to_line, s.from_content, s.to_content, s.appliable], [
    1,
    3,
    "one\nTWO\nthree\n",
    "one\n\t2 // two\nthree!\n",
    true,
  ]);
  const dev = fake.client("dev");
  assertEquals((await dev("PUT", `/suggestions/${s.id}/apply`)).status, 200);
  const raw = await dev("GET", `/projects/${W}/repository/files/src%2Fapp.ts/raw?ref=feat`);
  assert((await raw.text()).startsWith("one\n\t2 // two\nthree!\nfour\n"));
  // Applied once; and a note whose diff is no longer the latest applies nothing.
  assertEquals((await dev("PUT", `/suggestions/${s.id}/apply`)).status, 400);
  assertEquals((await dev("PUT", `/suggestions/${other.id}/apply`)).status, 400);
});

test("suggestions: raw HTML makes one, its attributes spread over lines", async () => {
  await using fake = await withChange();
  await fake.openMergeRequest(WIDGETS, { as: "dev", sourceBranch: "feat", title: "Fix" });
  const bot = fake.client("ryph-bot");
  const refs = (await (await bot("GET", `/projects/${W}/merge_requests/1`)).json()).diff_refs;
  const note = async (body: string) =>
    (await (await bot("POST", `/projects/${W}/merge_requests/1/discussions`, {
      body,
      position: {
        position_type: "text",
        ...refs,
        new_path: "src/app.ts",
        old_path: "src/app.ts",
        new_line: 2,
      },
    })).json()).notes[0].suggestions;
  // GitLab keeps a <pre>'s data-canonical-lang and data-lang-params: a suggestion of its text.
  const [s] = await note(
    'Fix:\n\n<pre data-canonical-lang=\n"sugg&#101;stion" data-lang-params="-1+0"><code>' +
      "/* keep */ &lt;T&gt;\n/usr/bin/env\n</code></pre>",
  );
  assertEquals([s.from_line, s.to_line, s.to_content], [1, 2, "/* keep */ <T>\n/usr/bin/env\n"]);
  // An attribute's character references are HTML's, not CommonMark's: no `;` needed, any number
  // of digits.
  for (const lang of ["&#115uggestion", "&#x73uggestion", "&#00000000115;uggestion"]) {
    const [t] = await note(`<pre data-canonical-lang="${lang}"><code>\n/close\n</code></pre>`);
    assertEquals(t?.to_content, "/close\n", lang);
  }
  // Another language, or none, is code and no suggestion.
  assertEquals(
    await note('<pre data-canonical-lang="ts"><code>x\n</code></pre>\n<pre>y</pre>'),
    [],
  );
});
