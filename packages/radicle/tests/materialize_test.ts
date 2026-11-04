// The dialect translation, against REAL `rad cob show` output captured from rad 1.10.2 — not a
// hand-written idea of the shape. Every field these assertions depend on was observed.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  existingReviewId,
  latestRevision,
  materializeChange,
  materializeIssue,
  mergedHeadsOf,
  toDid,
  toNid,
} from "../src/core/materialize.ts";

const ALICE = "z6MkrZSV9qadiiEtb9UadbAbMRZgtPxxzprBoTgvqiZqq1gG";
const BOB = "z6MkfXhFkWz9gZmWjooYpZtNrS9CHkYrH7GUcSersJh2vJUy";
const PATCH = "146df3b60c9d76dd331971cc94c06b16cf596407";
const REV2 = "bdf106346d5f2d5714bfbd67b7f9d82c00a69024";
const ISSUE = "e4102ee4e38368d239b96adb151bffe9da56b2ea";

/** Captured verbatim: a two-revision patch with a comment, an edit, and a review with a remark. */
const PATCH_COB = {
  title: "My patch title",
  author: { id: `did:key:${ALICE}` },
  state: { status: "open" },
  target: "delegates",
  labels: [],
  merges: {},
  revisions: {
    [PATCH]: {
      id: PATCH,
      author: { id: `did:key:${ALICE}` },
      description: [{
        author: ALICE,
        timestamp: 1789649224000,
        body: "The description.",
        embeds: [],
      }],
      base: "d7cae529d1ed5ad059e3ab862ba55d670dd9bddb",
      oid: "234f56bb529d492b157c72d05e2d1e0d31234bb7",
      discussion: { comments: {}, timeline: [] },
      reviews: {},
      timestamp: 1789649224000,
      resolves: [],
      reactions: [],
    },
    [REV2]: {
      id: REV2,
      author: { id: `did:key:${ALICE}` },
      description: [{
        author: ALICE,
        timestamp: 1789649240000,
        body: "Second revision notes",
        embeds: [],
      }],
      base: "d7cae529d1ed5ad059e3ab862ba55d670dd9bddb",
      oid: "99f8c94c48e13f33259db2f29135b2720de67445",
      discussion: {
        comments: {
          "061318ea7130ab76134d7822f483333218e91789": {
            author: BOB,
            reactions: [],
            resolved: false,
            body: "edited body",
            edits: [
              { author: BOB, timestamp: 1789649325000, body: "hello from bob", embeds: [] },
              { author: BOB, timestamp: 1789649370000, body: "edited body", embeds: [] },
            ],
          },
        },
        // The timeline also lists the EDIT's op id, which is not a comment.
        timeline: [
          "061318ea7130ab76134d7822f483333218e91789",
          "e81a60c593ebedbca2d8507c4a7a586bf1f9d6c0",
        ],
      },
      reviews: {
        [BOB]: {
          id: "8cee72dd29ba419f15a0e0ab78465491774f9252",
          author: { id: `did:key:${BOB}` },
          verdict: "accept",
          summary: [{ author: BOB, timestamp: 1789649370000, body: "Looks good", embeds: [] }],
          comments: {
            comments: {
              f4c91a43dd20b6d59a10d415327ef777cfeedaed: {
                author: BOB,
                reactions: [],
                resolved: false,
                body: "nit here",
                edits: [{ author: BOB, timestamp: 1789649370000, body: "nit here", embeds: [] }],
                location: {
                  commit: "99f8c94c48e13f33259db2f29135b2720de67445",
                  path: "README.md",
                  old: null,
                  new: { type: "lines", range: { start: 1, end: 2 } },
                },
              },
            },
            timeline: ["f4c91a43dd20b6d59a10d415327ef777cfeedaed"],
          },
          labels: [],
          timestamp: 1789649370000,
        },
      },
      timestamp: 1789649240000,
      resolves: [],
      reactions: [],
    },
  },
  assignees: [],
  timeline: [PATCH, REV2],
  reviews: { "8cee72dd29ba419f15a0e0ab78465491774f9252": [REV2, BOB] },
};

const ISSUE_COB = {
  assignees: [],
  title: "Bob issue",
  state: { status: "open" },
  labels: [],
  thread: {
    comments: {
      "21e7ed3df27d76be155b97da42523bed88792e22": {
        author: BOB,
        replyTo: ISSUE,
        reactions: [[BOB, "👍"]],
        resolved: false,
        body: "a reply",
        edits: [{ author: BOB, timestamp: 1789649942000, body: "a reply", embeds: [] }],
      },
      [ISSUE]: {
        author: BOB,
        reactions: [],
        resolved: false,
        body: "body from bob",
        edits: [{ author: BOB, timestamp: 1789649446000, body: "body from bob", embeds: [] }],
      },
    },
    timeline: [
      ISSUE,
      "21e7ed3df27d76be155b97da42523bed88792e22",
      "e3d19344d42cda6fa56219516094ce06c06cf18c",
    ],
  },
};

test("a bare public key and a did:key both become a DID", () => {
  assertEquals(toDid(ALICE), `did:key:${ALICE}`);
  assertEquals(toDid(`did:key:${ALICE}`), `did:key:${ALICE}`);
  assertEquals(toDid({ id: `did:key:${ALICE}` }), `did:key:${ALICE}`);
  assertEquals(toNid(`did:key:${ALICE}`), ALICE);
  assertEquals(toDid(undefined), "");
});

test("an issue's author is whoever opened the thread, and the root is its body", () => {
  const issue = materializeIssue(ISSUE, ISSUE_COB);
  assertEquals(issue.id, ISSUE);
  assertEquals(issue.title, "Bob issue");
  assertEquals(issue.author.did, `did:key:${BOB}`);
  assertEquals(issue.state, "open");
  assertEquals(issue.closeReason, null);
  assertEquals(issue.body, "body from bob");
  assertEquals(issue.createdAt, "2026-09-17T12:50:46.000Z");
});

test("the timeline orders comments, and its non-comment ops are dropped", () => {
  const issue = materializeIssue(ISSUE, ISSUE_COB);
  // Three timeline entries, two of which are comments; the third is the reaction's op.
  assertEquals(issue.comments.map((c) => c.id), [
    ISSUE,
    "21e7ed3df27d76be155b97da42523bed88792e22",
  ]);
  assertEquals(issue.comments[1].replyTo, ISSUE);
  assertEquals(issue.comments[1].reactions, ["👍"]);
});

test("a closed issue carries its reason", () => {
  const issue = materializeIssue(ISSUE, {
    ...ISSUE_COB,
    state: { status: "closed", reason: "solved" },
  });
  assertEquals(issue.state, "closed");
  assertEquals(issue.closeReason, "solved");
});

test("a change request flattens to revisions, comments and reviews", () => {
  const change = materializeChange(PATCH, PATCH_COB);
  assertEquals(change.title, "My patch title");
  assertEquals(change.author.did, `did:key:${ALICE}`);
  assertEquals(change.state, "open");
  assertEquals(change.revisions.map((r) => r.id), [PATCH, REV2]);
  // base and head are the LATEST revision's — the two shas a caller actually wants.
  assertEquals(change.head, "99f8c94c48e13f33259db2f29135b2720de67445");
  assertEquals(change.base, "d7cae529d1ed5ad059e3ab862ba55d670dd9bddb");
  assertEquals(change.description, "The description.");
  assertEquals(change.revisions[1].description, "Second revision notes");
});

test("an edited comment shows the latest body and when it was edited", () => {
  const change = materializeChange(PATCH, PATCH_COB);
  assertEquals(change.comments.length, 1);
  const comment = change.comments[0];
  assertEquals(comment.body, "edited body");
  assertEquals(comment.createdAt, "2026-09-17T12:48:45.000Z");
  assertEquals(comment.editedAt, "2026-09-17T12:49:30.000Z");
  assertEquals(comment.revision, REV2);
});

test("a review's inline remark keeps its file and becomes a 1-based line", () => {
  const change = materializeChange(PATCH, PATCH_COB);
  assertEquals(change.reviews.length, 1);
  const review = change.reviews[0];
  assertEquals(review.verdict, "accept");
  assertEquals(review.summary, "Looks good");
  assertEquals(review.revision, REV2);
  assertEquals(review.comments.length, 1);
  assertEquals(review.comments[0].location, {
    path: "README.md",
    commit: "99f8c94c48e13f33259db2f29135b2720de67445",
    // Half-open over 1-based line numbers: {start: 1, end: 2} is the first line.
    line: 1,
    side: "new",
  });
});

test("a merged patch reports the merge and the state", () => {
  const change = materializeChange(PATCH, {
    ...PATCH_COB,
    state: { status: "merged", revision: REV2, commit: "99f8c94c48e13f33259db2f29135b2720de67445" },
    merges: {
      [ALICE]: {
        revision: REV2,
        commit: "99f8c94c48e13f33259db2f29135b2720de67445",
        timestamp: 1789649512000,
      },
    },
  });
  assertEquals(change.state, "merged");
  assertEquals(change.merges, [{
    did: `did:key:${ALICE}`,
    revision: REV2,
    commit: "99f8c94c48e13f33259db2f29135b2720de67445",
    timestamp: "2026-09-17T12:51:52.000Z",
  }]);
  assertEquals(change.mergedRevision, {
    revision: REV2,
    commit: "99f8c94c48e13f33259db2f29135b2720de67445",
  });
  assertEquals(mergedHeadsOf(change), [change.mergedRevision]);
});

test("what merged: the state's merge, else every recorded one, and nothing while open", () => {
  const commit = "99f8c94c48e13f33259db2f29135b2720de67445";
  const merges = {
    [ALICE]: { revision: REV2, commit, timestamp: 1789649512000 },
    [BOB]: { revision: REV2, commit, timestamp: 1789649513000 },
  };
  // A merged state that names no merge: every recorded one, once per commit.
  const unnamed = materializeChange(PATCH, { ...PATCH_COB, state: { status: "merged" }, merges });
  assertEquals(unnamed.mergedRevision, null);
  assertEquals(mergedHeadsOf(unnamed), [{ revision: REV2, commit }]);
  // An open change request with a delegate's merge short of the threshold merged nothing.
  const open = materializeChange(PATCH, { ...PATCH_COB, state: { status: "open" }, merges });
  assertEquals(open.mergedRevision, null);
  assertEquals(mergedHeadsOf(open), []);
});

test("what merged names at most twenty merges, the newest first", () => {
  const merges: Record<string, unknown> = {};
  const commits: string[] = [];
  for (let i = 0; i < 25; i++) {
    const commit = i.toString(16).padStart(2, "0").repeat(20);
    commits.push(commit);
    // Keyed by node id; any key will do for the materializer.
    merges[`z6Mk${String(i).padStart(44, "x")}`] = {
      revision: REV2,
      commit,
      timestamp: 1789649512000 + i * 1000,
    };
  }
  const change = materializeChange(PATCH, { ...PATCH_COB, state: { status: "merged" }, merges });
  assertEquals(
    mergedHeadsOf(change).map((m) => m.commit),
    commits.slice(5).reverse(),
  );
});

test("the review index answers 'have I already reviewed this revision'", () => {
  assertEquals(
    existingReviewId(PATCH_COB, REV2, BOB),
    "8cee72dd29ba419f15a0e0ab78465491774f9252",
  );
  assertEquals(existingReviewId(PATCH_COB, REV2, ALICE), null);
  assertEquals(existingReviewId(PATCH_COB, PATCH, BOB), null);
});

test("a COB carrying fields this bridge has never seen still materializes", () => {
  const change = materializeChange(PATCH, {
    ...PATCH_COB,
    state: { status: "some-future-state" },
    somethingNew: { invented: "later" },
  });
  // An unknown lifecycle degrades to `open` rather than throwing a read into a 500.
  assertEquals(change.state, "open");
  assertEquals(change.revisions.length, 2);
  assertEquals(materializeIssue(ISSUE, {}).comments, []);
  assertEquals(materializeChange(PATCH, "not an object").revisions, []);
});

test("the latest revision is the author's latest: a stranger's revision on top is not it", () => {
  const STRANGER_REV = "c".repeat(40);
  const cob = structuredClone(PATCH_COB) as typeof PATCH_COB & {
    revisions: Record<string, unknown>;
    timeline: string[];
  };
  cob.revisions[STRANGER_REV] = {
    ...structuredClone(cob.revisions[REV2] as Record<string, unknown>),
    id: STRANGER_REV,
    author: { id: `did:key:${BOB}` },
    oid: "d".repeat(40),
    timestamp: 1789649300000,
  };
  cob.timeline = [...(cob.timeline ?? []), STRANGER_REV];
  const change = materializeChange(PATCH, cob);
  assertEquals(change.revisions.map((r) => r.id), [PATCH, REV2, STRANGER_REV]);
  // heartwood's `Patch::latest`: anybody may add a revision, and the patch is still its author's.
  // The newest overall is still the head a reader sees; the author's is named beside it.
  assertEquals(change.head, "d".repeat(40));
  assertEquals(change.authorHead, "99f8c94c48e13f33259db2f29135b2720de67445");
  assertEquals(latestRevision(change)?.id, REV2);
});

test("embeds come through on comments, revision descriptions and review summaries", () => {
  const SHOT = "1".repeat(40);
  const LOG = "2".repeat(40);
  const embed = (name: string, oid: string) => ({ name, content: `git:${oid}` });
  const issue = materializeIssue(ISSUE, {
    title: "t",
    state: { status: "open" },
    thread: {
      comments: {
        [ISSUE]: {
          author: ALICE,
          body: `see [shot.png](${SHOT})`,
          edits: [{ author: ALICE, timestamp: 1, body: "x", embeds: [embed("shot.png", SHOT)] }],
          embeds: [embed("shot.png", SHOT), { name: "odd", content: "https://x" }],
        },
      },
      timeline: [ISSUE],
    },
  });
  // Only `git:<oid>` names a blob; anything else is dropped rather than served.
  assertEquals(issue.comments[0].embeds, [{ name: "shot.png", oid: SHOT }]);

  const change = materializeChange(PATCH, {
    ...PATCH_COB,
    revisions: {
      [PATCH]: {
        ...PATCH_COB.revisions[PATCH],
        description: [{ author: ALICE, timestamp: 1, body: "d", embeds: [embed("log.txt", LOG)] }],
        reviews: {
          r1: {
            id: "r1",
            author: { id: `did:key:${BOB}` },
            verdict: "accept",
            summary: [{ author: BOB, timestamp: 2, body: "ok", embeds: [embed("shot.png", SHOT)] }],
            comments: { comments: {}, timeline: [] },
            timestamp: 2,
          },
        },
      },
    },
  });
  assertEquals(change.revisions[0].embeds, [{ name: "log.txt", oid: LOG }]);
  assertEquals(change.reviews[0].summaryEmbeds, [{ name: "shot.png", oid: SHOT }]);
});
