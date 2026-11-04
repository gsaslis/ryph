// Door ④'s consumer: a raw GitHub delivery (as the mailroom hands it over) is trimmed to a
// ForgeEvent and forwarded — or consumed, or failed terminally — with a fake sink and no
// network anywhere.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { Hook } from "@ryph/webhooks";
import { githubWebhookConsumer } from "../src/adapters/forge_api/github_webhooks.ts";
import type { DeliverOutcome } from "../src/ports/event_sink.ts";
import type { ForgeEvent } from "../src/core/types.ts";

const silent = { debug: () => {}, warn: () => {} };

function makeConsumer(sinkOutcome: DeliverOutcome = { kind: "ok" }) {
  const delivered: ForgeEvent[] = [];
  const consumer = githubWebhookConsumer({
    sink: {
      deliver(event) {
        delivered.push(event);
        return Promise.resolve(sinkOutcome);
      },
    },
    diag: silent,
  });
  return { consumer, delivered };
}

/**
 * A GitHub `user` as GitHub actually sends it. Every key here is one this file must ignore, and
 * a fixture that carried only `login` is what let a strict schema pass the whole suite and then
 * refuse the first real delivery.
 */
const USER = {
  login: "ada",
  id: 1234567,
  node_id: "U_kgDOABCDEF",
  avatar_url: "https://avatars.githubusercontent.com/u/1234567?v=4",
  gravatar_id: "",
  url: "https://api.github.com/users/ada",
  html_url: "https://github.com/ada",
  followers_url: "https://api.github.com/users/ada/followers",
  following_url: "https://api.github.com/users/ada/following{/other_user}",
  gists_url: "https://api.github.com/users/ada/gists{/gist_id}",
  starred_url: "https://api.github.com/users/ada/starred{/owner}{/repo}",
  subscriptions_url: "https://api.github.com/users/ada/subscriptions",
  organizations_url: "https://api.github.com/users/ada/orgs",
  repos_url: "https://api.github.com/users/ada/repos",
  events_url: "https://api.github.com/users/ada/events{/privacy}",
  received_events_url: "https://api.github.com/users/ada/received_events",
  type: "User",
  user_view_type: "public",
  site_admin: false,
};

function hook(over: Partial<Hook> = {}): Hook {
  return {
    id: "wh-0000000001",
    registrationId: "github",
    scope: null,
    seq: 1,
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "gh-uuid-1",
    },
    body: JSON.stringify({
      action: "created",
      issue: { number: 7 },
      comment: { id: 999, body: "/ryph ada fix it", user: USER },
      repository: { clone_url: "https://github.com/acme/app.git", full_name: "acme/app" },
      sender: USER,
      extra_github_noise: { deeply: { nested: true } },
    }),
    state: "delivering",
    attempts: 1,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    dedupeKey: null,
    ...over,
  };
}

test("an issue_comment.created is trimmed to a ForgeEvent and forwarded", async () => {
  const { consumer, delivered } = makeConsumer();
  const outcome = await consumer(hook());
  assertEquals(outcome, { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: "gh-uuid-1",
    kind: "issue_comment.created",
    repo: {
      provider: "github",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
    },
    actorLogin: "ada",
    thread: { kind: "issue", ref: "7" },
    body: "/ryph ada fix it",
    sourceCommentId: "999",
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a comment on a pull request is a pull_request thread", async () => {
  const { consumer, delivered } = makeConsumer();
  const payload = JSON.parse(hook().body);
  payload.issue.pull_request = { url: "https://api.github.com/..." };
  await consumer(hook({ body: JSON.stringify(payload) }));
  assertEquals(delivered[0].thread, { kind: "change_request", ref: "7" });
});

test("uninteresting deliveries are consumed, never failed: other events, other actions", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(
    await consumer(hook({ headers: { "x-github-event": "installation" } })),
    { kind: "ok" },
  );
  const edited = JSON.parse(hook().body);
  edited.action = "edited";
  assertEquals(await consumer(hook({ body: JSON.stringify(edited) })), { kind: "ok" });
  assertEquals(delivered.length, 0);
});

const HEAD = "a".repeat(40);
const BEFORE = "c".repeat(40);

/** A pull_request delivery, carrying the keys GitHub always sends that this file reads, and
 * some it must ignore. */
function pr(
  action: string,
  over: { merged?: boolean; changes?: unknown; head?: Record<string, unknown> } = {},
): Hook {
  return hook({
    headers: { "x-github-event": "pull_request", "x-github-delivery": `gh-pr-${action}` },
    body: JSON.stringify({
      action,
      number: 42,
      pull_request: {
        number: 42,
        merged: over.merged ?? false,
        state: "open",
        user: { ...USER, login: "grace" },
        title: "Retry once",
        html_url: "https://github.com/acme/app/pull/42",
        head: {
          sha: HEAD,
          ref: "retry-once",
          label: "ada:retry-once",
          repo: { full_name: "acme/app" },
          ...over.head,
        },
        base: { sha: "b".repeat(40), ref: "main", label: "acme:main" },
      },
      ...(over.changes === undefined ? {} : { changes: over.changes }),
      // Only `synchronize` means it; sent on every fixture so the others are seen to ignore it.
      before: BEFORE,
      repository: { clone_url: "https://github.com/acme/app.git", full_name: "acme/app" },
      sender: USER,
    }),
  });
}

test("a pull request closing is merged or closed", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(pr("closed", { merged: true })), { kind: "ok" });
  assertEquals(await consumer(pr("closed", { merged: false })), { kind: "ok" });
  assertEquals(delivered.map((e) => [e.kind, e.deliveryId, e.thread, e.body, e.actorLogin]), [
    ["change_request.merged", "gh-pr-closed", { kind: "change_request", ref: "42" }, null, "ada"],
    ["change_request.closed", "gh-pr-closed", { kind: "change_request", ref: "42" }, null, "ada"],
  ]);
  assertEquals(delivered.map((e) => e.changeRequest), [undefined, undefined]);
  // A merge says where it merged: the base at the merge, which a stacked pull request's
  // retarget has moved since it was opened — and what merged, the head as it stood then, never
  // the merge commit. A close merged nothing anywhere.
  assertEquals(delivered.map((e) => e.merged), [
    { baseRef: "main", heads: [HEAD] },
    undefined,
  ]);
  const malformed = hook({
    headers: { "x-github-event": "pull_request" },
    body: JSON.stringify({ action: "closed", sender: USER }),
  });
  assert((await consumer(malformed)).kind === "failed");
});

test("a pull request opened, reopened or pushed to is a change_request.pushed naming its head and base", async () => {
  const { consumer, delivered } = makeConsumer();
  for (const action of ["opened", "reopened", "synchronize"]) {
    assertEquals(await consumer(pr(action)), { kind: "ok" });
  }
  assertEquals(delivered.length, 3);
  assertEquals(delivered[2], {
    deliveryId: "gh-pr-synchronize",
    kind: "change_request.pushed",
    repo: { provider: "github", repoRef: "acme/app", url: "https://github.com/acme/app.git" },
    actorLogin: "ada",
    thread: { kind: "change_request", ref: "42" },
    body: null,
    sourceCommentId: null,
    changeRequest: {
      ref: "42",
      headSha: HEAD,
      before: BEFORE,
      baseRef: "main",
      // Who opened it, where the actor is who pushed.
      author: "grace",
      fetchRef: "refs/pull/42/head",
      url: "https://github.com/acme/app/pull/42",
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(delivered.map((e) => e.kind), Array(3).fill("change_request.pushed"));
  // The head a push moved from is `synchronize`'s alone.
  assertEquals(delivered.map((e) => e.changeRequest?.before), [null, null, BEFORE]);
});

test("an edit is a push only when it retargeted the base; other actions are consumed", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(pr("edited", { changes: { title: { from: "Old" } } })), {
    kind: "ok",
  });
  assertEquals(await consumer(pr("edited")), { kind: "ok" });
  for (const action of ["labeled", "assigned", "review_requested", "converted_to_draft"]) {
    assertEquals(await consumer(pr(action)), { kind: "ok" });
  }
  assertEquals(delivered.length, 0);

  await consumer(pr("edited", { changes: { base: { ref: { from: "develop" } } } }));
  assertEquals(delivered.map((e) => [e.kind, e.changeRequest?.baseRef]), [
    ["change_request.pushed", "main"],
  ]);
});

test("a fork's pull request is forwarded too: whether its head runs is the control plane's call", async () => {
  const { consumer, delivered } = makeConsumer();
  await consumer(pr("opened", {
    head: { repo: { full_name: "mallory/app", fork: true }, label: "mallory:main" },
  }));
  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].changeRequest?.headSha, HEAD);
  assertEquals(delivered[0].changeRequest?.fetchRef, "refs/pull/42/head");
});

test("a pull request push whose head is not a commit id is terminal", async () => {
  const { consumer, delivered } = makeConsumer();
  const outcome = await consumer(pr("synchronize", { head: { sha: "main" } }));
  assert(outcome.kind === "failed" && outcome.terminal);
  assertEquals(delivered.length, 0);
});

test("a payload that can never parse fails terminally — retrying reshapes nothing", async () => {
  const { consumer, delivered } = makeConsumer();
  const notJson = await consumer(hook({ body: "certainly not json" }));
  assert(notJson.kind === "failed" && notJson.terminal);
  const wrongShape = await consumer(hook({ body: JSON.stringify({ action: "created" }) }));
  assert(wrongShape.kind === "failed" && wrongShape.terminal);
  assertEquals(delivered.length, 0);
});

test("the sink's verdict travels through unchanged", async () => {
  const { consumer } = makeConsumer({
    kind: "failed",
    message: "orchestrator unreachable",
    terminal: false,
  });
  const outcome = await consumer(hook());
  assert(outcome.kind === "failed" && !outcome.terminal);
});

test("a missing delivery header falls back to the hook's own id", async () => {
  const { consumer, delivered } = makeConsumer();
  await consumer(hook({ headers: { "x-github-event": "issue_comment" } }));
  assertEquals(delivered[0].deliveryId, "wh-0000000001");
});

test("a bot's comment is never a command: the App's own writes cannot start runs", async () => {
  const { consumer, delivered } = makeConsumer();
  const payload = JSON.parse(hook().body);
  payload.comment.user = { ...USER, login: "ryph[bot]", type: "Bot" };
  payload.comment.body = "/ryph ada fix this";
  assertEquals(await consumer(hook({ body: JSON.stringify(payload) })), { kind: "ok" });
  assertEquals(delivered.length, 0);
});

/** A pull_request_review_comment delivery, trimmed of nothing GitHub would send. */
function reviewCommentHook(comment: Record<string, unknown> = {}, action = "created"): Hook {
  return hook({
    headers: {
      "x-github-event": "pull_request_review_comment",
      "x-github-delivery": "gh-uuid-rc",
    },
    body: JSON.stringify({
      action,
      pull_request: { number: 9, title: "Rework the scheduler", user: USER },
      comment: {
        id: 500,
        body: "/ryph ada fix this line",
        user: USER,
        path: "src/scheduler.ts",
        line: 88,
        original_line: 80,
        diff_hunk: "@@ -1,3 +1,4 @@",
        pull_request_review_id: 42,
        ...comment,
      },
      repository: { clone_url: "https://github.com/acme/app.git", full_name: "acme/app" },
      sender: USER,
    }),
  });
}

test("an inline review comment is a command on its pull request, naming the remark", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(reviewCommentHook()), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: "gh-uuid-rc",
    kind: "review_comment.created",
    repo: { provider: "github", repoRef: "acme/app", url: "https://github.com/acme/app.git" },
    actorLogin: "ada",
    thread: { kind: "change_request", ref: "9" },
    body: "/ryph ada fix this line",
    // The 👀 handle: a review comment reacts through another endpoint than a conversation one.
    sourceCommentId: "review:500",
    inline: { commentId: "500" },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a review comment edited, deleted, or written by a bot is consumed, never a command", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(reviewCommentHook({}, "edited")), { kind: "ok" });
  assertEquals(await consumer(reviewCommentHook({}, "deleted")), { kind: "ok" });
  // The agent's own reply in a review thread is written as the App's bot, and may quote one.
  assertEquals(
    await consumer(reviewCommentHook({ user: { ...USER, login: "ryph[bot]", type: "Bot" } })),
    { kind: "ok" },
  );
  assertEquals(delivered.length, 0);
});

/** A push as GitHub sends it, trimmed of the commit list nobody here reads. */
function push(over: Record<string, unknown> = {}, repo: Record<string, unknown> = {}): Hook {
  return hook({
    headers: { "x-github-event": "push", "x-github-delivery": "gh-push-1" },
    body: JSON.stringify({
      ref: "refs/heads/main",
      before: "1".repeat(40),
      after: "2".repeat(40),
      created: false,
      deleted: false,
      forced: false,
      commits: [{ id: "2".repeat(40), message: "ship it", author: { name: "Ada" } }],
      head_commit: { id: "2".repeat(40) },
      pusher: { name: "ada", email: "ada@example.com" },
      repository: {
        clone_url: "https://github.com/acme/app.git",
        full_name: "acme/app",
        default_branch: "main",
        owner: USER,
        ...repo,
      },
      sender: USER,
      ...over,
    }),
  });
}

test("a push to the default branch is a branch.updated naming the branch and its new commit", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(push()), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: "gh-push-1",
    kind: "branch.updated",
    repo: { provider: "github", repoRef: "acme/app", url: "https://github.com/acme/app.git" },
    actorLogin: "ada",
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: "main", commit: "2".repeat(40) },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a renamed default branch arrives as a branch.updated naming the new one", async () => {
  const { consumer, delivered } = makeConsumer();
  await consumer(push({ ref: "refs/heads/trunk" }, { default_branch: "trunk" }));
  assertEquals(delivered.map((e) => e.branch), [{ ref: "trunk", commit: "2".repeat(40) }]);
});

test("pushes that move no default branch are consumed: other branches, tags, deletions", async () => {
  const { consumer, delivered } = makeConsumer();
  assertEquals(await consumer(push({ ref: "refs/heads/feat/x" })), { kind: "ok" });
  assertEquals(await consumer(push({ ref: "refs/tags/main" })), { kind: "ok" });
  // A branch NAMED like the default but under another prefix is not it either.
  assertEquals(await consumer(push({ ref: "refs/remotes/origin/main" })), { kind: "ok" });
  assertEquals(
    await consumer(push({ deleted: true, after: "0".repeat(40) })),
    { kind: "ok" },
  );
  assertEquals(delivered.length, 0);
});

test("a bot's push is still news — a merge queue landing a pull request moves the default", async () => {
  const { consumer, delivered } = makeConsumer();
  await consumer(push({ sender: { ...USER, login: "merge-queue[bot]", type: "Bot" } }));
  assertEquals(delivered.map((e) => [e.kind, e.actorLogin]), [
    ["branch.updated", "merge-queue[bot]"],
  ]);
});

test("a push this version cannot read is terminal", async () => {
  const { consumer, delivered } = makeConsumer();
  const noDefault = await consumer(push({}, { default_branch: undefined }));
  assert(noDefault.kind === "failed" && noDefault.terminal);
  const badSha = await consumer(push({ after: "not-a-sha" }));
  assert(badSha.kind === "failed" && badSha.terminal);
  assertEquals(delivered.length, 0);
});

/** A check_run delivery as GitHub sends it for a run ryph posted, trimmed of what nobody reads. */
function checkRun(over: Record<string, unknown> = {}, run: Record<string, unknown> = {}): Hook {
  return hook({
    headers: { "x-github-event": "check_run", "x-github-delivery": "gh-check-1" },
    body: JSON.stringify({
      action: "rerequested",
      check_run: {
        id: 77,
        name: "ryph / test",
        head_sha: "c".repeat(40),
        external_id: "cs-0123456789:1:test",
        status: "completed",
        conclusion: "failure",
        app: { id: 999, slug: "ryph", owner: USER },
        check_suite: { id: 5, head_branch: "ryph/ada/r-a" },
        ...run,
      },
      repository: { clone_url: "https://github.com/acme/app.git", full_name: "acme/app" },
      sender: USER,
      ...over,
    }),
  });
}

function checkConsumer(appId: string | null) {
  const delivered: ForgeEvent[] = [];
  const consumer = githubWebhookConsumer({
    sink: {
      deliver(event) {
        delivered.push(event);
        return Promise.resolve({ kind: "ok" as const });
      },
    },
    diag: silent,
    appId,
  });
  return { consumer, delivered };
}

test("a re-requested ryph check run is a check_run.rerequested naming the run it echoes", async () => {
  const { consumer, delivered } = checkConsumer("999");
  assertEquals(await consumer(checkRun()), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: "gh-check-1",
    kind: "check_run.rerequested",
    repo: {
      provider: "github",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
    },
    actorLogin: "ada",
    thread: null,
    body: null,
    sourceCommentId: null,
    checkRun: {
      externalId: "cs-0123456789:1:test",
      headSha: "c".repeat(40),
      name: "ryph / test",
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("a re-requested run on a suite id of the sortable shape is forwarded", async () => {
  const { consumer, delivered } = checkConsumer("999");
  const externalId = "cs-01jb7k3m9x4q8zt2vw6hn5c0fe:2:test";
  await consumer(checkRun({}, { external_id: externalId }));
  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].checkRun?.externalId, externalId);
});

test("a bot re-requesting is forwarded: the control plane's write check decides", async () => {
  const { consumer, delivered } = checkConsumer("999");
  await consumer(checkRun({ sender: { ...USER, login: "merge-bot[bot]", type: "Bot" } }));
  assertEquals(delivered.length, 1);
});

test("check_run events ryph does not act on are consumed at the door", async () => {
  const { consumer, delivered } = checkConsumer("999");
  // ryph's own writes coming back.
  assertEquals(await consumer(checkRun({ action: "created" })), { kind: "ok" });
  assertEquals(await consumer(checkRun({ action: "completed" })), { kind: "ok" });
  // Another App's run, or no App named where one is expected to be ours.
  await consumer(checkRun({}, { app: { id: 1 } }));
  // Not an id ryph posts: absent, somebody else's shape, or a check name out of bounds.
  await consumer(checkRun({}, { external_id: null }));
  await consumer(checkRun({}, { external_id: "build-42" }));
  await consumer(checkRun({}, { external_id: "cs-0123456789:1:Not_A_Name" }));
  assertEquals(delivered.length, 0);
});

test("another App's run, or a run completing, is consumed before it is parsed", async () => {
  const { consumer, delivered } = checkConsumer("999");
  const long = "x".repeat(500);
  // Other CI's run with a name past the schema's bound: none of ours, so never a failed row.
  assertEquals(
    await consumer(checkRun({ action: "completed" }, { name: long, app: { id: 1 } })),
    { kind: "ok" },
  );
  assertEquals(await consumer(checkRun({}, { name: long, app: { id: 1 } })), { kind: "ok" });
  assertEquals(await consumer(checkRun({ action: "created" }, { head_sha: "x" })), { kind: "ok" });
  assertEquals(delivered.length, 0);
});

test("a check_run payload that cannot parse is terminal", async () => {
  const { consumer } = checkConsumer("999");
  const out = await consumer(checkRun({}, { head_sha: "not-a-sha" }));
  assertEquals(out.kind, "failed");
  assert(out.kind === "failed" && out.terminal);
});

/** A check_suite delivery as GitHub sends it for "Re-run all checks" on ryph's runs. */
function checkSuite(over: Record<string, unknown> = {}, suite: Record<string, unknown> = {}): Hook {
  return hook({
    headers: { "x-github-event": "check_suite", "x-github-delivery": "gh-suite-1" },
    body: JSON.stringify({
      action: "rerequested",
      check_suite: {
        id: 5,
        head_branch: "ryph/ada/r-a",
        head_sha: "c".repeat(40),
        status: "completed",
        conclusion: "success",
        app: { id: 999, slug: "ryph", owner: USER },
        ...suite,
      },
      repository: { clone_url: "https://github.com/acme/app.git", full_name: "acme/app" },
      sender: USER,
      ...over,
    }),
  });
}

test("re-run all on ryph's suite is a check_suite.rerequested naming only the head", async () => {
  const { consumer, delivered } = checkConsumer("999");
  assertEquals(await consumer(checkSuite()), { kind: "ok" });
  assertEquals(delivered, [{
    deliveryId: "gh-suite-1",
    kind: "check_suite.rerequested",
    repo: {
      provider: "github",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
    },
    actorLogin: "ada",
    thread: null,
    body: null,
    sourceCommentId: null,
    checkSuite: { headSha: "c".repeat(40) },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }]);
});

test("check_suite events ryph does not act on are consumed before they are parsed", async () => {
  const { consumer, delivered } = checkConsumer("999");
  // GitHub's bookkeeping on every push, for every App with checks.
  assertEquals(await consumer(checkSuite({ action: "requested" }, { head_sha: "x" })), {
    kind: "ok",
  });
  assertEquals(await consumer(checkSuite({ action: "completed" })), { kind: "ok" });
  // Another App's suite, even one that would not parse.
  assertEquals(await consumer(checkSuite({}, { app: { id: 1 }, head_sha: "x" })), { kind: "ok" });
  assertEquals(delivered.length, 0);
  const bad = await consumer(checkSuite({}, { head_sha: "not-a-sha" }));
  assert(bad.kind === "failed" && bad.terminal);
});
