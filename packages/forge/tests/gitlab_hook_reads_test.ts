// The webhook consumer's reads of GitLab: under the verified project only, with the bot's token
// as a Bearer (what a personal and an OAuth token both take), GitLab's 404/403/410 a permanent
// null, anything else a throw.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { serve } from "@ryph/service";
import { gitlabClient } from "../src/adapters/forge_api/gitlab_client.ts";
import {
  type GitlabHookReads,
  gitlabHookReads,
  hookBudget,
  HookReservation,
  reservedHookReads,
} from "../src/adapters/forge_api/gitlab_hook_reads.ts";
import { GITLAB_TOKEN_NAMES, staticUserToken } from "../src/helpers/user_token.ts";
import { silentDiagnostics } from "./util.ts";

const SHA = "da1560886d4f094c3e6c9ef40349f7d38b5d27d7";
const ADA = { id: 31, username: "ada.lovelace" };

async function gitlab(answers: Record<string, [number, unknown]>) {
  const asked: Array<{ path: string; auth: string | null; privateToken: string | null }> = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const path = new URL(req.url).pathname.replace(/^\/api\/v4/, "");
    asked.push({
      path,
      auth: req.headers.get("authorization"),
      privateToken: req.headers.get("private-token"),
    });
    const [status, body] = answers[path] ?? [404, { message: "404 Not found" }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  const reads = gitlabHookReads(gitlabClient({
    url,
    token: staticUserToken("glpat-bot-token-0000", GITLAB_TOKEN_NAMES),
    diag: silentDiagnostics(),
    now: Date.now,
  }));
  return { reads, asked, shutdown: () => server.shutdown() };
}

test("every read is a Bearer request under the verified project, the answer reduced to its facts", async () => {
  const gl = await gitlab({
    "/projects/42": [200, {
      id: 42,
      path_with_namespace: "acme/app",
      http_url_to_repo: "https://gl/acme/app.git",
      default_branch: "main",
    }],
    "/projects/42/issues/12/notes/7": [200, {
      id: 7,
      body: "/ryph ada go",
      author: ADA,
      system: false,
      internal: false,
      confidential: true,
      type: null,
      created_at: "2026-10-14T11:20:00.000+02:00",
    }],
    "/projects/42/merge_requests/3": [200, {
      iid: 3,
      state: "merged",
      sha: SHA,
      target_branch: "main",
      author: ADA,
      merge_user: { id: 57, username: "grace_h" },
      web_url: "https://gl/acme/app/-/merge_requests/3",
      updated_at: "2026-10-14T11:21:00.000+02:00",
    }],
    "/projects/42/merge_requests/3/discussions/6a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7be1": [200, {
      notes: [{ id: 8 }],
    }],
    "/projects/42/issues/12": [200, { confidential: false }],
    "/projects/42/repository/branches/main": [200, { commit: { id: SHA } }],
  });
  try {
    assertEquals(await gl.reads.project("42"), {
      id: "42",
      pathWithNamespace: "acme/app",
      url: "https://gl/acme/app.git",
      defaultBranch: "main",
    });
    // `confidential` is the older name of `internal`: either one makes a note internal.
    assertEquals(await gl.reads.note("42", { kind: "issue", iid: "12" }, "7"), {
      id: "7",
      body: "/ryph ada go",
      author: { id: "31", username: "ada.lovelace" },
      system: false,
      internal: true,
      type: null,
      // GitLab answers in the instance's zone; the read keeps the instant, in UTC.
      createdAt: "2026-10-14T09:20:00.000Z",
    });
    const mr = await gl.reads.mergeRequest("42", "3");
    assertEquals([mr?.state, mr?.headSha, mr?.author.username, mr?.endedBy?.username], [
      "merged",
      SHA,
      "ada.lovelace",
      "grace_h",
    ]);
    // When it last changed, in UTC: with its state and head, what names a delivery about it.
    assertEquals(mr?.updatedAt, "2026-10-14T09:21:00.000Z");
    const discussion = "6a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7be1";
    assertEquals(await gl.reads.discussionHolds("42", "3", discussion, "8"), true);
    assertEquals(await gl.reads.discussionHolds("42", "3", discussion, "9"), false);
    assertEquals(await gl.reads.issueConfidential("42", "12"), false);
    assertEquals(await gl.reads.branchHead("42", "main"), SHA);
    for (const a of gl.asked) {
      assertEquals(a.auth, "Bearer glpat-bot-token-0000", a.path);
      assertEquals(a.privateToken, null, "PRIVATE-TOKEN would refuse an OAuth token");
    }
  } finally {
    await gl.shutdown();
  }
});

test("GitLab's 404, 403 and 410 are null — gone for good; anything else throws, to be retried", async () => {
  const gl = await gitlab({
    "/projects/43": [403, { message: "403 Forbidden" }],
    "/projects/44": [410, { message: "410 Gone" }],
    "/projects/45": [502, { message: "bad gateway" }],
    "/projects/46/merge_requests/1": [200, { iid: 1, state: "opened", sha: "main" }],
  });
  try {
    assertEquals(await gl.reads.project("42"), null);
    assertEquals(await gl.reads.project("43"), null);
    assertEquals(await gl.reads.project("44"), null);
    assertEquals(await gl.reads.note("42", { kind: "merge_request", iid: "1" }, "1"), null);
    assertEquals(await gl.reads.issueConfidential("42", "1"), null);
    assertEquals(await gl.reads.branchHead("42", "main"), null);
    await assertRejects(() => gl.reads.project("45"));
    // An answer missing what an event needs is no answer.
    await assertRejects(() => gl.reads.mergeRequest("46", "1"));
    // A handle that is not GitLab's shape never reaches a URL.
    await assertRejects(() => gl.reads.project("4/2"));
    assertEquals(await gl.reads.discussionHolds("42", "1", "../../x", "1"), false);
    assert(!gl.asked.some((a) => a.path.includes("..")));
  } finally {
    await gl.shutdown();
  }
});

test("every project's deliveries together spend one budget, reserved whole and refused at once, never waited for", async () => {
  let now = 0;
  let reads = 0;
  const counted = (): GitlabHookReads => {
    const read = () => (reads++, Promise.resolve(null));
    return {
      project: read,
      note: read,
      discussionHolds: () => (reads++, Promise.resolve(false)),
      issueConfidential: read,
      mergeRequest: read,
      branchHead: read,
    };
  };
  const budget = hookBudget({ perMinute: 60, now: () => now }); // one a second

  // A minute's worth is there at once, whichever project reserves it.
  const held: HookReservation[] = [];
  for (let i = 0; i < 6; i++) held.push(budget.reserve(String(i), 10)!);
  // Past it, a reservation is refused on the spot: nothing to await, nothing spent.
  assertEquals(budget.reserve("6", 1), null);
  // What a reservation set aside is spent a read at a time, and never past it.
  const budgeted = reservedHookReads(counted(), held[0]);
  for (let i = 0; i < 10; i++) await budgeted.project("1");
  assertEquals(reads, 10);
  await assertRejects(() => budgeted.note("1", { kind: "issue", iid: "1" }, "2"), Error, "past");
  assertEquals(reads, 10, "a read past the reservation never reaches GitLab");
  held[0].release();
  assertEquals(budget.reserve("6", 1), null, "all of it was spent: nothing back");

  // Unspent, it comes back when the delivery is over — once, however often it is released.
  held[1].take(3);
  held[1].release();
  held[1].release();
  assertThrows(() => held[1].take(1), Error, "past its reservation");
  const back = budget.reserve("6", 7);
  assert(back !== null && back.reserved === 7);
  assertEquals(budget.reserve("7", 1), null);
  // A second later the bucket holds one more, and only one.
  now += 1_000;
  assert(budget.reserve("7", 1) !== null);
  assertEquals(budget.reserve("7", 1), null);
});

test("the budget never lets more than a minute's worth plus its refill be spent, however many projects reserve", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 600, now: () => now });
  let spent = 0;
  for (let ms = 0; ms <= 10 * 60_000; ms += 250) {
    now = ms;
    for (let scope = 0; scope < 40; scope++) {
      const cost = 1 + (scope % 10);
      const r = budget.reserve(String(scope), cost);
      if (r === null) continue;
      r.take(cost);
      spent += cost;
      r.release();
    }
  }
  // The bucket's minute plus ten minutes of refill at ten a second.
  assert(spent <= 600 + 6_000, `spent ${spent}`);
  assert(spent >= 6_000, `the budget is used, not hoarded: spent ${spent}`);
});

test("a reservation held through a hang counts as in the bucket: spent late, it never passes the cap beside the refill", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 600, now: () => now });
  // GitLab hangs: deliveries reserve the whole bucket and hold it, unspent, for a minute.
  const held = [];
  for (let i = 0; i < 60; i++) held.push(budget.reserve(String(i), 10)!);
  assert(held.every((r) => r !== null));
  now = 60_000;
  // GitLab answers again: the held deliveries spend what they set aside, all at once…
  for (const r of held) {
    r.take(10);
    r.release();
  }
  // …and nothing more is reservable in that same instant. Refilled beside them, the bucket let
  // another minute's worth go too: 1 200 calls in one instant against a cap of 600.
  assertEquals(budget.reserve("late", 1), null);
  now = 61_000;
  assert(budget.reserve("late", 10) !== null, "the refill comes back as the minute runs");
});

test("refused projects are served least-spent first: a flood holds back for a quiet project's note", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 60, now: () => now });
  // A flooder spends the bucket down, one cheap reservation after another.
  let flooded = 0;
  for (let r = budget.reserve("flood", 7); r !== null;) {
    r.take(1); // a ring for a note that is not there: one read
    r.release();
    flooded++;
    r = budget.reserve("flood", 7);
  }
  assertEquals(flooded, 54);
  // Down to under seven. A quiet project's note is refused — and waits in line, ahead of the
  // flooder, which has spent the more.
  now += 500;
  assertEquals(budget.reserve("quiet", 7), null);
  // The bucket refills to enough for one; the flooder, asking first, is held back for the quiet
  // project, which is served though it asks last.
  now += 1_000;
  assertEquals(budget.reserve("flood", 7), null);
  assert(budget.reserve("quiet", 7) !== null);
  // Once served it holds nothing back, and the flooder goes on with what is left.
  now += 7_000;
  assert(budget.reserve("flood", 7) !== null);
});

test("a project refused and never back holds its place for a minute at most", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 60, now: () => now });
  const all = budget.reserve("busy", 60)!;
  all.take(60);
  all.release();
  assertEquals(budget.reserve("quiet", 40), null); // refused, and in line
  // The busier project is held back for it while its place is fresh…
  now += 30_000;
  assertEquals(budget.reserve("busy", 1), null);
  now += 30_000;
  assertEquals(budget.reserve("busy", 30), null);
  // …and not once the place lapsed: "quiet" never asked again.
  now += 1_000;
  assert(budget.reserve("busy", 30) !== null);
});

test("a quiet project's push is served at once under two busier projects' flood of real notes", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 600, now: () => now });
  // Two projects ring real notes (7 calls each, all spent) as fast as they are let in, every
  // 100 ms; a quiet project's head is a push (6), asked once a pass (2 s) from the first minute.
  let served = -1;
  let noisy = 0;
  for (let step = 0; step < 6_000; step++) {
    now = step * 100;
    if (now >= 60_000 && step % 20 === 0 && served < 0) {
      const r = budget.reserve("quiet", 6);
      if (r !== null) {
        served = now;
        r.take(6);
        r.release();
      }
    }
    for (const p of ["noisy-1", "noisy-2"]) {
      const r = budget.reserve(p, 7);
      if (r === null) continue;
      noisy++;
      r.take(7);
      r.release();
    }
  }
  assert(served !== -1, `never served, while ${noisy} notes were`);
  assert(served - 60_000 <= 2_000, `served ${served - 60_000} ms after it first asked`);
  assert(noisy * 7 >= 600 * 9, `the flood has the rest: ${noisy} notes`);
});

test("a waiting project holds back exactly what its head needs, and nothing is kept back for a kind of delivery", () => {
  let now = 0;
  const budget = hookBudget({ perMinute: 60, now: () => now }); // one a second
  const all = budget.reserve("busy", 60)!;
  all.take(60);
  all.release();
  // A quiet project's push (6) is refused, and waits in line ahead of the busier project.
  assertEquals(budget.reserve("quiet", 6), null);
  // Twelve in the bucket: the busier project's note (7) would leave the push short.
  now += 12_000;
  assertEquals(budget.reserve("busy", 7), null);
  // Thirteen: the note fits beside what the push needs, and is served.
  now += 1_000;
  const note = budget.reserve("busy", 7)!;
  note.take(7);
  note.release();
  // Six left, all of it the push's: served — a push may spend the bucket's last token as a note may.
  assert(budget.reserve("quiet", 6) !== null);
  assertEquals(budget.reserve("busy", 1), null);
});
