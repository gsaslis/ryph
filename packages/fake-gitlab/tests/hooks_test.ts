// Webhook emission: the token ryph's mailroom derives, GitLab's headers, and the Note, Merge
// Request, Push and Issue payloads the GitLab consumer routes on.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { deriveScopedSecret } from "@ryph/webhooks";
import { deriveHookToken } from "../src/mod.ts";
import { receiver, seeded, WIDGETS } from "./util.ts";

const MASTER = "hook-master-secret";

test("the hook token is the mailroom's derived secret for the project and generation", async () => {
  assertEquals(
    deriveHookToken(MASTER, 1234),
    await deriveScopedSecret(MASTER, "gitlab-hook:", "1234", "1"),
  );
  assertEquals(
    deriveHookToken(MASTER, 1234, 3),
    await deriveScopedSecret(MASTER, "gitlab-hook:", "1234", "3"),
  );
});

test("a /ryph note: Note Hook with the derived token, the project bound in the URL, GitLab's headers", async () => {
  await using fake = await seeded();
  const rx = await receiver(200, fake.deliveries);
  try {
    const hook = fake.addRyphHook(WIDGETS, { url: rx.url, master: MASTER });
    const p = fake.world.project(WIDGETS)!;
    assertEquals(new URL(hook.url).searchParams.get("project"), String(p.id));
    assertEquals(new URL(hook.url).searchParams.get("generation"), "1");
    fake.openIssue(WIDGETS, { as: "dev", title: "Broken" });
    const { noteId, discussionId } = await fake.comment(WIDGETS, "issue-1", {
      as: "dev",
      body: "/ryph fix",
    });
    await fake.flush();

    // The ryph hook subscribes to notes, MRs and default-branch pushes; not issues.
    assertEquals(rx.of("Issue Hook").length, 0);
    const [note] = rx.of("Note Hook");
    assert(note);
    assertEquals(note.headers["x-gitlab-token"], deriveHookToken(MASTER, p.id));
    assertEquals(note.headers["x-gitlab-instance"], fake.url);
    assertEquals(note.headers["x-gitlab-webhook-uuid"], hook.uuid);
    assert(/^[0-9a-f-]{36}$/.test(note.headers["x-gitlab-event-uuid"]!));
    assert(/^[0-9a-f-]{36}$/.test(note.headers["idempotency-key"]!));
    assertEquals(new URL(note.url).searchParams.get("project"), String(p.id));
    const b = note.body;
    assertEquals([b.object_kind, b.event_type, b.user.username, b.project.id], [
      "note",
      "note",
      "dev",
      p.id,
    ]);
    assertEquals(b.project.path_with_namespace, WIDGETS);
    assertEquals(b.project.git_http_url, `${fake.url}/${WIDGETS}.git`);
    assertEquals(b.object_attributes.id, noteId);
    assertEquals(b.object_attributes.discussion_id, discussionId);
    assertEquals([
      b.object_attributes.note,
      b.object_attributes.noteable_type,
      b.object_attributes.system,
      b.object_attributes.type,
    ], [
      "/ryph fix",
      "Issue",
      false,
      null,
    ]);
    assertEquals(b.object_attributes.url, `${fake.url}/${WIDGETS}/-/issues/1#note_${noteId}`);
    assertEquals(b.issue.iid, 1);

    // A redelivery keeps the Idempotency-Key, as GitLab's resend does; the event UUID too.
    const first = fake.deliveries.find((d) => d.event === "Note Hook")!;
    assertEquals(first.status, 200);
    await fake.redeliver(first.id);
    const both = rx.of("Note Hook");
    assertEquals(both.length, 2);
    assertEquals(both[1]!.headers["idempotency-key"], both[0]!.headers["idempotency-key"]);
  } finally {
    await rx.shutdown();
  }
});

test("merge request hooks: open, update with oldrev, close, merge; diff notes on an MR", async () => {
  await using fake = await seeded();
  const rx = await receiver(200, fake.deliveries);
  try {
    fake.addRyphHook(WIDGETS, { url: rx.url, master: MASTER });
    await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "f.txt": "1\n" } });
    const mr = await fake.openMergeRequest(WIDGETS, {
      as: "dev",
      sourceBranch: "feat",
      title: "Feat",
    });
    const first = mr.headSha;
    await fake.commit(WIDGETS, { as: "dev", branch: "feat", files: { "f.txt": "2\n" } });
    const bot = fake.client("ryph-bot");
    const W = encodeURIComponent(WIDGETS);
    const refs = (await (await bot("GET", `/projects/${W}/merge_requests/1`)).json()).diff_refs;
    await bot("POST", `/projects/${W}/merge_requests/1/discussions`, {
      body: "/ryph tidy this",
      position: {
        position_type: "text",
        ...refs,
        old_path: "f.txt",
        new_path: "f.txt",
        new_line: 1,
      },
    });
    await fake.closeMergeRequest(WIDGETS, 1, { as: "maya" });
    await bot("PUT", `/projects/${W}/merge_requests/1`, { state_event: "reopen" });
    await fake.merge(WIDGETS, 1, { as: "maya" });
    await fake.flush();

    const mrs = rx.of("Merge Request Hook").map((h) => h.body);
    assertEquals(mrs.map((b) => b.object_attributes.action), [
      "open",
      "update",
      "close",
      "reopen",
      "merge",
    ]);
    const [open, update, , , merge] = mrs;
    assertEquals(open!.object_attributes.last_commit.id, first);
    assertEquals(update!.object_attributes.oldrev, first);
    assertEquals(update!.object_attributes.last_commit.id, mr.headSha);
    assertEquals(open!.object_attributes.author_id, fake.world.userByUsername("dev")!.id);
    assert(!("author" in open!.object_attributes), "the MR hook names its author by id only");
    assertEquals([merge!.object_attributes.state, merge!.object_attributes.target_branch], [
      "merged",
      "main",
    ]);
    assertEquals(merge!.object_attributes.last_commit.id, mr.headSha);
    assertEquals(merge!.user.username, "maya");

    const diffNote = rx.of("Note Hook").map((h) => h.body).find((b) =>
      b.object_attributes.type === "DiffNote"
    )!;
    assertEquals(diffNote.object_attributes.noteable_type, "MergeRequest");
    assertEquals(diffNote.object_attributes.position.new_line, 1);
    assertEquals(diffNote.merge_request.iid, 1);
    assertEquals(diffNote.object_attributes.discussion_id.length, 40);

    // Pushes: the branch filter is the default branch, so only main's push arrived (the merge).
    const pushes = rx.of("Push Hook").map((h) => h.body);
    assertEquals(pushes.map((b) => b.ref), ["refs/heads/main"]);
    assertEquals([
      pushes[0]!.object_kind,
      pushes[0]!.user_username,
      pushes[0]!.project.default_branch,
    ], ["push", "maya", "main"]);
    assert(pushes[0]!.total_commits_count >= 1);
  } finally {
    await rx.shutdown();
  }
});

test("a plain hook: every branch's pushes, issue events, no token; Idempotency-Key only on 17.4+", async () => {
  await using fake = await seeded({ version: "17.2.0" });
  const rx = await receiver(500, fake.deliveries);
  try {
    fake.addHook(WIDGETS, { url: rx.url, issuesEvents: true });
    await fake.commit(WIDGETS, { as: "dev", branch: "topic", files: { "t.txt": "t\n" } });
    const issue = fake.openIssue(WIDGETS, { as: "dev", title: "Hello", labels: ["bug"] });
    fake.instance.updateIssue(fake.world.userByUsername("dev")!, issue, { stateEvent: "close" });
    await fake.flush();
    const push = rx.of("Push Hook")[0]!;
    assertEquals(push.body.ref, "refs/heads/topic");
    assertEquals(push.body.before, "0".repeat(40));
    assertEquals(push.headers["x-gitlab-token"], undefined);
    assertEquals(push.headers["idempotency-key"], undefined);
    const issues = rx.of("Issue Hook").map((h) => h.body);
    assertEquals(issues.map((b) => b.object_attributes.action), ["open", "close"]);
    assertEquals(issues[0]!.labels.map((l: { title: string }) => l.title), ["bug"]);
    // A failing receiver is recorded, not retried.
    assert(fake.deliveries.every((d) => d.status === 500));
  } finally {
    await rx.shutdown();
  }
});
