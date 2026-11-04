// The event consumer, against real COBs written by a real second identity.
//
// The assertions here are the bridge's delivery contract, and each one is a rule the design
// depends on:
// - first sight of a repository emits NOTHING (seeding an old repo must not replay its history)
// - a stranger's comment emits exactly ONE event
// - running the same pass again emits NOTHING (the cursor did its job)
// - OUR OWN ops emit nothing, however they arrive
// - a stream that DIES loses nothing: reconcile catches what the socket missed
// - a merge emits `change_request.merged` and an archive `change_request.closed`, both read
//   from the MATERIALIZED state rather than from any single op

import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { lifecycleDeliveryId, makeEventConsumer } from "../src/core/events.ts";
import { makeRadicleService } from "../src/core/service.ts";
import { memoryCursorStore } from "../src/adapters/cursor_store/memory.ts";
import { recordingEventSink } from "../src/adapters/event_sink/recording.ts";
import { socketNodeControl } from "../src/adapters/node/socket.ts";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import type { NodeEvent } from "../src/ports/node.ts";
import {
  commit,
  initRepo,
  makeBundle,
  makePeer,
  type Peer,
  pullRefs,
  RAD_MISSING,
  seedFrom,
  socketPath,
  tempDir,
  type TestRepo,
} from "./util.ts";

const radTest = test.skipIf(RAD_MISSING);

test("a merge's delivery id holds every merged head: an older merge synced late is a new delivery", () => {
  const [a, b] = ["a".repeat(40), "b".repeat(40)];
  const newest = lifecycleDeliveryId("rad:z1", "c".repeat(40), [{ commit: b }]);
  // The second delegate's merge of an OLDER revision arrives after: the newest head is the same.
  const both = lifecycleDeliveryId("rad:z1", "c".repeat(40), [{ commit: b }, { commit: a }]);
  assertEquals(newest === both, false);
  // The same set, in any order, is the same delivery: a redelivery, never a second merge.
  assertEquals(
    lifecycleDeliveryId("rad:z1", "c".repeat(40), [{ commit: a }, { commit: b }, { commit: a }]),
    both,
  );
  assertEquals(both.startsWith(`rad:z1:${"c".repeat(40)}:merged:`), true);
  assertEquals(both.length <= 200, true, "the forge's schema bounds a delivery id at 200");
  assertEquals(lifecycleDeliveryId("rad:z1", "c", []), "rad:z1:c:merged");
  assertEquals(lifecycleDeliveryId("rad:z1", "c", null), "rad:z1:c:closed");
});

interface World {
  maintainer: Peer;
  bot: Peer;
  repo: TestRepo;
  /** The bot's own service — the bridge's. */
  service: ReturnType<typeof makeRadicleService>;
  /** The maintainer's, so a second identity can really write COBs. */
  theirs: ReturnType<typeof makeRadicleService>;
  sink: ReturnType<typeof recordingEventSink>;
  consumer: ReturnType<typeof makeEventConsumer>;
  fake: ReturnType<typeof startFakeNode>;
  node: ReturnType<typeof socketNodeControl>;
  changeId: string;
  headSha: string;
  /** Moves every reference from the maintainer's storage into the bot's. */
  theyPush(): Promise<void>;
  /** …and the other way, so the maintainer can see what the bot wrote. */
  theyPull(): Promise<void>;
  dispose(): Promise<void>;
}

/** A seeded repository with one change request the BOT submitted, and a live consumer. */
async function world(opts: { explorerUrl?: string } = {}): Promise<World> {
  const maintainer = await makePeer("maintainer");
  const bot = await makePeer("ryph");
  const repo = await initRepo(maintainer, { name: "widget" });
  await seedFrom(maintainer, bot, repo.rid);

  const data = await tempDir("events-data");
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, nid: bot.nid });
  const node = socketNodeControl({ socket: sock.path });

  const service = makeRadicleService({
    exec: bot.exec,
    node,
    diag: SILENT_DIAGNOSTICS,
    scratchDir: data.path,
  });
  const theirs = makeRadicleService({
    exec: maintainer.exec,
    node,
    diag: SILENT_DIAGNOSTICS,
    scratchDir: data.path,
  });
  const sink = recordingEventSink();
  const consumer = makeEventConsumer({
    service,
    exec: bot.exec,
    node,
    cursors: memoryCursorStore(),
    sink,
    diag: SILENT_DIAGNOSTICS,
    reconcileIntervalMs: 3_600_000,
    reconnectDelayMs: 10,
    explorerUrl: opts.explorerUrl,
  });

  // The bot submits a change request, so there is something for the other side to talk about.
  const headSha = await commit(maintainer, repo.workDir, "F.md", "one\n", "the work");
  const bundlePath = `${data.path}/out.bundle`;
  await makeBundle(maintainer, repo.workDir, repo.head, headSha, bundlePath);
  const submitted = await service.submitChange(repo.rid, {
    bundlePath,
    title: "The work",
    description: "Please look at this.",
    baseSha: repo.head,
    headSha,
  });

  const theyPull = async () => {
    await pullRefs(bot, maintainer, repo.rid);
    await maintainer.exec.rad(["patch", "cache", "--repo", repo.rid, "--no-announce", "-q"]);
    await maintainer.exec.rad(["issue", "cache", "-r", repo.rid, "--no-announce", "-q"]);
  };

  return {
    maintainer,
    bot,
    repo,
    service,
    theirs,
    sink,
    consumer,
    fake,
    node,
    changeId: submitted.ref,
    headSha,
    theyPush: () => pullRefs(maintainer, bot, repo.rid),
    theyPull,
    async dispose() {
      await consumer.stop();
      await fake.close();
      await sock.dispose();
      await data.dispose();
      await maintainer.dispose();
      await bot.dispose();
      await rm(repo.workDir, { recursive: true }).catch(() => {});
    },
  };
}

/** The COB reference a peer's ops for one object live under. */
function cobRef(nid: string, cob: string, type = "xyz.radicle.patch"): string {
  return `refs/namespaces/${nid}/refs/cobs/${type}/${cob}`;
}

radTest("first sight of a repository sets cursors and emits nothing", async () => {
  const w = await world();
  try {
    // There is already a change request, a revision and a description edit in storage. None
    // of it is news: nobody asked to be told about the past.
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(w.sink.events, []);
  } finally {
    await w.dispose();
  }
});

radTest("a stranger's comment emits exactly one event, and a replay emits none", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile(); // first sight

    await w.theyPull();
    await w.theirs.addComment(w.repo.rid, "change", w.changeId, {
      body: "/ryph please rebase this",
    });
    await w.theyPush();

    assertEquals(await w.consumer.reconcile(), 1);
    assertEquals(w.sink.events.length, 1);
    const event = w.sink.threadEvents()[0];
    assertEquals(event.kind, "comment.created");
    assertEquals(event.repoRef, w.repo.rid);
    assertEquals(event.actor.did, w.maintainer.did);
    assertEquals(event.thread, { kind: "change_request", ref: w.changeId });
    assertEquals(event.body, "/ryph please rebase this");
    assertEquals(event.sourceCommentId?.length, 40);
    // The delivery id is derived, so a redelivery is idempotent downstream.
    assertStringIncludes(event.deliveryId, `${w.repo.rid}:${w.changeId}:`);
    assertEquals(event.deliveryId.endsWith(":0"), true);

    // Nothing moved, so nothing is minted — however many times it is asked.
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(w.sink.events.length, 1);
  } finally {
    await w.dispose();
  }
});

radTest("our own ops are never news", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    // The bot comments on its own change request, and reacts to its own comment.
    const own = await w.service.addComment(w.repo.rid, "change", w.changeId, {
      body: "a progress note from ryph",
    });
    await w.service.reactToComment(w.repo.rid, "change", w.changeId, own.id, {
      reaction: "👍",
    });
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(w.sink.events, []);
  } finally {
    await w.dispose();
  }
});

radTest("an issue comment from a stranger is an issue-threaded event", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await w.theyPull();
    const issue = await w.theirs.createIssue(w.repo.rid, {
      title: "It squeaks",
      body: "/ryph have a look",
    });
    await w.theyPush();

    assertEquals(await w.consumer.reconcile(), 1);
    const event = w.sink.threadEvents()[0];
    assertEquals(event.kind, "comment.created");
    assertEquals(event.thread, { kind: "issue", ref: issue.id });
    assertEquals(event.body, "/ryph have a look");
    assertEquals(event.actor.did, w.maintainer.did);
    assertEquals(event.revision, undefined);
  } finally {
    await w.dispose();
  }
});

radTest("a refsFetched event mints the same thing the reconcile would", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await w.theyPull();
    await w.theirs.addComment(w.repo.rid, "change", w.changeId, { body: "over here" });
    await w.theyPush();

    // What the node would have sent us. The oid in the event is deliberately NOT trusted:
    // the consumer reads storage for the current value, because by the time we look the
    // reference may already have moved again.
    const event: NodeEvent = {
      type: "refsFetched",
      rid: w.repo.rid,
      remote: w.maintainer.nid,
      updated: [{
        updated: {
          name: cobRef(w.maintainer.nid, w.changeId),
          old: "0".repeat(40),
          new: "0".repeat(40),
        },
      }],
    };
    assertEquals(await w.consumer.handle(event), 1);
    assertEquals(w.sink.events.length, 1);
    assertEquals(w.sink.threadEvents()[0].body, "over here");

    // An event about a repository or a ref we know nothing about is ignored, not an error.
    assertEquals(
      await w.consumer.handle({
        type: "refsFetched",
        rid: w.repo.rid,
        remote: w.maintainer.nid,
        updated: [{ created: { name: "refs/namespaces/z6Mkelsewhere/refs/cobs/x/y", oid: "a" } }],
      }),
      0,
    );
    // And an event type this bridge has never heard of is simply not a fetch.
    assertEquals(await w.consumer.handle({ type: "somethingNew", rid: w.repo.rid }), 0);
    assertEquals(
      await w.consumer.handle({ type: "localRefsAnnounced", rid: w.repo.rid, refs: {} }),
      0,
    );
  } finally {
    await w.dispose();
  }
});

radTest(
  "a stream that dies loses nothing: the reconnect's reconcile catches the miss",
  async () => {
    const w = await world();
    try {
      // The consumer is live on the fake node. Its FIRST act is a reconcile, which is the
      // first-sight pass, so nothing is emitted yet.
      w.consumer.start();
      while (w.fake.subscribers() === 0) await new Promise((r) => setTimeout(r, 5));
      await w.consumer.idle();
      assertEquals(w.sink.events, []);

      // Now the comment arrives while nobody is listening — the node's channel dropped us, or
      // it restarted, and heartwood replays nothing.
      await w.theyPull();
      await w.theirs.addComment(w.repo.rid, "change", w.changeId, { body: "did you get this?" });
      await w.theyPush();

      // The socket dies. The loop's answer to an EOF is to reconnect AND reconcile.
      w.fake.hangUp();
      const deadline = Date.now() + 20_000;
      while (w.sink.events.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assertEquals(w.sink.events.length, 1, "the reconcile after the EOF must catch the comment");
      assertEquals(w.sink.threadEvents()[0].body, "did you get this?");
      // And it resubscribed, so the fast path is back.
      while (w.fake.subscribers() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assertEquals(w.fake.subscribers() > 0, true);
    } finally {
      await w.dispose();
    }
  },
);

radTest("a merged change request emits change_request.merged", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await w.theyPull();

    // The delegate merges by pushing the change's head onto the default branch — Radicle's
    // whole merge button. `rad` notices and writes the merge op.
    const pushed = await w.maintainer.exec.git(w.repo.workDir, [
      "push",
      "-o",
      "no-sync",
      "rad",
      `${w.headSha}:refs/heads/${w.repo.defaultBranch}`,
    ]);
    assertEquals(pushed.code, 0, `merge push failed: ${pushed.stderr}`);
    assertStringIncludes(pushed.stderr, "merged");
    await w.theyPush();

    const minted = await w.consumer.reconcile();
    assertEquals(minted >= 1, true);
    const merged = w.sink.threadEvents().find((e) => e.kind === "change_request.merged");
    assertEquals(merged?.thread, { kind: "change_request", ref: w.changeId });
    assertEquals(
      merged?.deliveryId,
      lifecycleDeliveryId(w.repo.rid, w.changeId, [{ commit: w.headSha }]),
    );
    assertEquals(merged?.actor.did, w.maintainer.did);

    // The change request itself now reads as merged.
    const change = await w.service.getChange(w.repo.rid, w.changeId);
    assertEquals(change.state, "merged");
    assertEquals(change.merges.length, 1);
    // And the event names what merged: the one revision, by its head.
    assertEquals(merged?.merged, [{ revision: w.changeId, commit: w.headSha }]);
    assertEquals(change.mergedRevision, { revision: w.changeId, commit: w.headSha });
  } finally {
    await w.dispose();
  }
});

radTest(
  "a merge of an OLDER revision names that revision's head, not the latest",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile();
      // ryph pushes a second revision onto its own change request, on top of the first.
      const r2 = await submits(w, w.service, "two.md", w.changeId);
      const second = await w.service.getChange(w.repo.rid, w.changeId);
      assertEquals(second.revisions.length, 2);
      assertEquals(second.head, r2.headSha);
      const r2Revision = second.revisions[1].id;
      await w.theyPull();

      // The delegate merges the FIRST revision's head: `rad` merges the revision whose head is
      // in the pushed range, and the second's is not.
      const pushed = await w.maintainer.exec.git(w.repo.workDir, [
        "push",
        "-o",
        "no-sync",
        "rad",
        `${w.headSha}:refs/heads/${w.repo.defaultBranch}`,
      ]);
      assertEquals(pushed.code, 0, `merge push failed: ${pushed.stderr}`);
      assertStringIncludes(pushed.stderr, "merged at revision");
      await w.theyPush();

      await w.consumer.reconcile();
      const merged = w.sink.threadEvents().find((e) => e.kind === "change_request.merged");
      // The first revision's id is the change request's own id: it is the op that opened it.
      assertEquals(merged?.merged, [{ revision: w.changeId, commit: w.headSha }]);
      // Its delivery is that merge's: a later one at the second revision's head would be another.
      assertEquals(
        merged?.deliveryId,
        lifecycleDeliveryId(w.repo.rid, w.changeId, [{ commit: w.headSha }]),
      );
      assertEquals(
        lifecycleDeliveryId(w.repo.rid, w.changeId, [{ commit: r2.headSha }]) ===
          merged?.deliveryId,
        false,
      );
      const change = await w.service.getChange(w.repo.rid, w.changeId);
      assertEquals(change.head, r2.headSha, "the latest revision is still the second");
      assertEquals(change.mergedRevision?.revision === r2Revision, false);
    } finally {
      await w.dispose();
    }
  },
);

radTest("an archived change request emits change_request.closed", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await w.theyPull();

    // Archiving somebody else's patch is a delegate's to do — which the maintainer is.
    const archived = await w.maintainer.exec.rad([
      "patch",
      "archive",
      w.changeId,
      "--repo",
      w.repo.rid,
      "--no-announce",
    ]);
    assertEquals(archived.code, 0, `rad patch archive failed: ${archived.stderr}`);
    await w.theyPush();

    assertEquals(await w.consumer.reconcile() >= 1, true);
    const closed = w.sink.threadEvents().find((e) => e.kind === "change_request.closed");
    assertEquals(closed?.deliveryId, `${w.repo.rid}:${w.changeId}:closed`);
    assertEquals(closed?.thread, { kind: "change_request", ref: w.changeId });
    assertEquals((await w.service.getChange(w.repo.rid, w.changeId)).state, "archived");
  } finally {
    await w.dispose();
  }
});

radTest("a delivery the mailroom refuses holds the cursor until it is taken", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile(); // first sight
    await w.theyPull();
    await w.theirs.addComment(w.repo.rid, "change", w.changeId, {
      body: "did the mailroom hear this?",
    });
    await w.theyPush();

    // The forge is restarting: the POST fails with something an operator can fix. Storage is
    // the only copy of this comment, so the cursor must NOT move past it.
    w.sink.refuse({ kind: "failed", message: "connection refused", terminal: false });
    assertEquals(await w.consumer.reconcile(), 1);
    assertEquals(w.sink.events.length, 1);

    // Still down, and the same range is walked again rather than skipped.
    assertEquals(await w.consumer.reconcile(), 1);
    assertEquals(w.sink.events.length, 2);
    assertEquals(
      w.sink.events[1].deliveryId,
      w.sink.events[0].deliveryId,
      "the id is derived, so a retry is the consumer's primary key doing its job",
    );

    // It comes back, and the comment that would have been lost arrives.
    w.sink.refuse(null);
    assertEquals(await w.consumer.reconcile(), 1);
    assertEquals(w.sink.events.length, 3);
    assertEquals(w.sink.threadEvents()[2].body, "did the mailroom hear this?");

    // Only now does the cursor advance: nothing is sent a fourth time.
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(w.sink.events.length, 3);
  } finally {
    await w.dispose();
  }
});

radTest(
  "a terminal refusal advances the cursor instead of wedging the reference forever",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile(); // first sight
      await w.theyPull();
      await w.theirs.addComment(w.repo.rid, "change", w.changeId, { body: "unsendable" });
      await w.theyPush();

      // 400 / 422: THIS PAYLOAD will never be accepted, however long we keep offering it.
      w.sink.refuse({ kind: "failed", message: "unprocessable", terminal: true });
      assertEquals(await w.consumer.reconcile(), 1);
      assertEquals(w.sink.events.length, 1);

      w.sink.refuse(null);
      assertEquals(await w.consumer.reconcile(), 0, "a terminal refusal is not retried");
      assertEquals(w.sink.events.length, 1);

      // And the reference is not stuck behind it: what is said NEXT still arrives.
      await w.theyPull();
      await w.theirs.addComment(w.repo.rid, "change", w.changeId, { body: "and this one?" });
      await w.theyPush();
      assertEquals(await w.consumer.reconcile(), 1);
      assertEquals(w.sink.events.length, 2);
      assertEquals(w.sink.threadEvents()[1].body, "and this one?");
    } finally {
      await w.dispose();
    }
  },
);

/** The maintainer (the repo's one delegate, threshold 1) moves a branch the way a person does:
 * a commit, pushed to `rad`. Answers the commit. */
async function delegatePushes(w: World, branch: string, file: string): Promise<string> {
  const sha = await commit(w.maintainer, w.repo.workDir, file, `${file}\n`, `add ${file}`);
  const pushed = await w.maintainer.exec.git(w.repo.workDir, [
    "push",
    "-o",
    "no-sync",
    "rad",
    `${sha}:refs/heads/${branch}`,
  ]);
  assertEquals(pushed.code, 0, `push failed: ${pushed.stderr}`);
  return sha;
}

radTest(
  "the canonical default branch moving is one branch.updated, and first sight and replays are none",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile(); // first sight: the head it was seeded at is not news
      assertEquals(w.sink.branchEvents(), []);

      const sha = await delegatePushes(w, w.repo.defaultBranch, "moved.md");
      await w.theyPush();

      assertEquals(await w.consumer.reconcile(), 1);
      assertEquals(w.sink.branchEvents(), [{
        deliveryId: `${w.repo.rid}:heads/${w.repo.defaultBranch}:${sha}`,
        kind: "branch.updated",
        repoRef: w.repo.rid,
        // Who saw it: our node. A canonical ref moves by quorum, which is nobody's single act.
        actor: { did: w.bot.did },
        branch: { ref: w.repo.defaultBranch, commit: sha },
      }]);

      assertEquals(await w.consumer.reconcile(), 0);
      assertEquals(w.sink.branchEvents().length, 1);
    } finally {
      await w.dispose();
    }
  },
);

radTest("a delegate's other branch is not the default, and moves nothing", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await delegatePushes(w, "feature", "feature.md");
    await w.theyPush();
    assertEquals(await w.consumer.reconcile(), 0);
    assertEquals(w.sink.events, []);
  } finally {
    await w.dispose();
  }
});

radTest(
  "a refsFetched that touched a delegate's branch reads the canonical head back",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile();
      const sha = await delegatePushes(w, w.repo.defaultBranch, "moved.md");
      await w.theyPush();

      // What a fetch from the delegate reports: THEIR namespaced copy. The canonical ref is read
      // out of storage, not off the event.
      const fetched = (name: string): NodeEvent => ({
        type: "refsFetched",
        rid: w.repo.rid,
        remote: w.maintainer.nid,
        updated: [{ updated: { name, old: "0".repeat(40), new: sha } }],
      });
      // A fetch that wrote no branch at all does not go looking.
      assertEquals(await w.consumer.handle(fetched(cobRef(w.maintainer.nid, "e".repeat(40)))), 0);
      assertEquals(
        await w.consumer.handle(
          fetched(`refs/namespaces/${w.maintainer.nid}/refs/heads/${w.repo.defaultBranch}`),
        ),
        1,
      );
      assertEquals(w.sink.branchEvents().map((e) => e.branch), [
        { ref: w.repo.defaultBranch, commit: sha },
      ]);
      // The reconcile that follows agrees it was already delivered.
      assertEquals(await w.consumer.reconcile(), 0);
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "a held branch.updated holds the head's cursor, and is sent again once the mailroom is back",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile();
      const sha = await delegatePushes(w, w.repo.defaultBranch, "moved.md");
      await w.theyPush();

      w.sink.refuse({ kind: "failed", message: "503", terminal: false });
      await w.consumer.reconcile();
      assertEquals(w.sink.branchEvents().length, 1, "it was handed over, and refused");

      w.sink.refuse(null);
      await w.consumer.reconcile();
      const sent = w.sink.branchEvents();
      assertEquals(sent.length, 2);
      assertEquals(sent[0].deliveryId, sent[1].deliveryId, "the same event, not a new one");
      assertEquals(sent[1].branch.commit, sha);

      await w.consumer.reconcile();
      assertEquals(w.sink.branchEvents().length, 2);
    } finally {
      await w.dispose();
    }
  },
);

/** Somebody submits a change request — or a new revision of one — the way `submit_change`
 * does: a commit, bundled against the repo's head, pushed through their own service. */
async function submits(
  w: World,
  who: ReturnType<typeof makeRadicleService>,
  file: string,
  changeRef?: string,
): Promise<{ ref: string; headSha: string }> {
  const headSha = await commit(w.maintainer, w.repo.workDir, file, `${file}\n`, `add ${file}`);
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const bundlePath = `${dir}/out.bundle`;
    await makeBundle(w.maintainer, w.repo.workDir, w.repo.head, headSha, bundlePath);
    const submitted = await who.submitChange(w.repo.rid, {
      bundlePath,
      title: `Add ${file}`,
      description: "Please look.",
      baseSha: w.repo.head,
      headSha,
      changeRef,
    });
    return { ref: submitted.ref, headSha };
  } finally {
    await rm(dir, { recursive: true }).catch(() => {});
  }
}

radTest(
  "a stranger's change request and each revision of it are one change_request.pushed each",
  async () => {
    const w = await world({ explorerUrl: "https://explorer.example/{rid}/{kind}/{id}" });
    try {
      await w.consumer.reconcile(); // first sight

      await w.theyPull();
      const opened = await submits(w, w.theirs, "theirs.md");
      await w.theyPush();
      assertEquals(await w.consumer.reconcile(), 1);
      const [first] = w.sink.threadEvents();
      assertEquals(first.kind, "change_request.pushed");
      assertEquals(first.repoRef, w.repo.rid);
      assertEquals(first.actor.did, w.maintainer.did);
      assertEquals(first.thread, { kind: "change_request", ref: opened.ref });
      // The base is the repository's default branch: a Radicle change request has no other.
      assertEquals(first.changeRequest, {
        headSha: opened.headSha,
        baseRef: w.repo.defaultBranch,
        author: w.maintainer.did,
        url: `https://explorer.example/${w.repo.rid}/patches/${opened.ref}`,
      });
      assertStringIncludes(first.deliveryId, `${w.repo.rid}:${opened.ref}:`);

      // A push of a new revision is a new head, under a new delivery id.
      const revised = await submits(w, w.theirs, "theirs-again.md", opened.ref);
      await w.theyPush();
      assertEquals(await w.consumer.reconcile(), 1);
      const second = w.sink.threadEvents()[1];
      assertEquals(second.kind, "change_request.pushed");
      assertEquals(second.thread, { kind: "change_request", ref: opened.ref });
      assertEquals(second.changeRequest?.headSha, revised.headSha);
      assertEquals(second.changeRequest?.author, w.maintainer.did);
      assertEquals(second.deliveryId === first.deliveryId, false);

      assertEquals(await w.consumer.reconcile(), 0);
      assertEquals(w.sink.events.length, 2);
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "our own revisions are not pushes: the patch flow asked for their checks already",
  async () => {
    const w = await world();
    try {
      await w.consumer.reconcile();
      await submits(w, w.service, "ours-again.md", w.changeId);
      await submits(w, w.service, "ours-new.md");
      assertEquals(await w.consumer.reconcile(), 0);
      assertEquals(w.sink.events, []);
    } finally {
      await w.dispose();
    }
  },
);

radTest("a history walked for the first time is one push: the latest revision only", async () => {
  // An explorer that is not https renders no link at all, as GitHub's would not.
  const w = await world({ explorerUrl: "http://explorer.example/{rid}/{kind}/{id}" });
  try {
    await w.consumer.reconcile(); // first sight

    // Three revisions the bridge has never seen, arriving at once in a new namespace.
    await w.theyPull();
    const opened = await submits(w, w.theirs, "one.md");
    await submits(w, w.theirs, "two.md", opened.ref);
    const latest = await submits(w, w.theirs, "three.md", opened.ref);
    await w.theyPush();

    assertEquals(await w.consumer.reconcile(), 1);
    const pushes = w.sink.threadEvents().filter((e) => e.kind === "change_request.pushed");
    assertEquals(pushes.map((e) => e.changeRequest?.headSha), [latest.headSha]);
    assertEquals(pushes[0].changeRequest?.url, null);
  } finally {
    await w.dispose();
  }
});

radTest("a merged or archived change request's revisions are not pushes", async () => {
  const w = await world();
  try {
    await w.consumer.reconcile();
    await w.theyPull();

    const archived = await submits(w, w.theirs, "archived.md");
    const out = await w.maintainer.exec.rad([
      "patch",
      "archive",
      archived.ref,
      "--repo",
      w.repo.rid,
      "--no-announce",
    ]);
    assertEquals(out.code, 0, `rad patch archive failed: ${out.stderr}`);

    const merged = await submits(w, w.theirs, "merged.md");
    const pushed = await w.maintainer.exec.git(w.repo.workDir, [
      "push",
      "-o",
      "no-sync",
      "rad",
      `${merged.headSha}:refs/heads/${w.repo.defaultBranch}`,
    ]);
    assertEquals(pushed.code, 0, `merge push failed: ${pushed.stderr}`);
    await w.theyPush();

    await w.consumer.reconcile();
    const kinds = w.sink.threadEvents().map((e) => [e.kind, e.thread.ref]);
    assertEquals(kinds.some(([kind]) => kind === "change_request.pushed"), false, String(kinds));
    assertEquals(
      kinds.some(([kind, ref]) => kind === "change_request.closed" && ref === archived.ref),
      true,
    );
    assertEquals(
      kinds.some(([kind, ref]) => kind === "change_request.merged" && ref === merged.ref),
      true,
    );
  } finally {
    await w.dispose();
  }
});

radTest(
  "a stranger's revision on top never hides the author's: one push, for the author's head",
  async () => {
    const w = await world();
    const stranger = await makePeer("stranger");
    const scratch = await tempDir("events-stranger");
    try {
      await seedFrom(w.maintainer, stranger, w.repo.rid);
      const theirsToo = makeRadicleService({
        exec: stranger.exec,
        node: w.node,
        diag: SILENT_DIAGNOSTICS,
        scratchDir: scratch.path,
      });
      await w.consumer.reconcile(); // first sight

      // Two change requests by the maintainer, each with a stranger's revision on top of it.
      const first = await submits(w, w.theirs, "first.md");
      const second = await submits(w, w.theirs, "second.md");
      await pullRefs(w.maintainer, stranger, w.repo.rid);
      await stranger.exec.rad(["patch", "cache", "--repo", w.repo.rid, "--no-announce", "-q"]);
      const onFirst = await submits(w, theirsToo, "on-first.md", first.ref);
      const onSecond = await submits(w, theirsToo, "on-second.md", second.ref);
      await w.theyPush();
      await pullRefs(stranger, w.bot, w.repo.rid);

      // Each namespace in turn, in both orders: the stranger's first for one change request,
      // the author's first for the other. The materialized state is read whole either way.
      const fetched = (nid: string, cob: string): NodeEvent => ({
        type: "refsFetched",
        rid: w.repo.rid,
        remote: nid,
        updated: [{
          updated: { name: cobRef(nid, cob), old: "0".repeat(40), new: "0".repeat(40) },
        }],
      });
      await w.consumer.handle(fetched(stranger.nid, first.ref));
      await w.consumer.handle(fetched(w.maintainer.nid, first.ref));
      await w.consumer.handle(fetched(w.maintainer.nid, second.ref));
      await w.consumer.handle(fetched(stranger.nid, second.ref));
      assertEquals(await w.consumer.reconcile(), 0, "nothing left over for the reconcile");

      // The stranger's namespace carries the author's ops too (that is how they revised on top
      // of them), so the author's revision may be minted from either reference — under the one
      // delivery id it derives from, which is the consumer's primary key doing its job.
      const minted = w.sink.threadEvents().filter((e) => e.kind === "change_request.pushed");
      const pushes = [...new Map(minted.map((e) => [e.deliveryId, e])).values()];
      assertEquals(
        pushes.map((e) => [e.thread.ref, e.changeRequest?.headSha, e.actor.did]).sort(),
        [
          [first.ref, first.headSha, w.maintainer.did],
          [second.ref, second.headSha, w.maintainer.did],
        ].sort(),
      );
      assertEquals(pushes.every((e) => e.changeRequest?.author === w.maintainer.did), true);

      // And the change request reads back with the author's head beside the newest — the one
      // the forge's thread read hands the control plane to compare the push against.
      for (const [{ ref, headSha }, onTop] of [[first, onFirst], [second, onSecond]] as const) {
        const change = await w.service.getChange(w.repo.rid, ref);
        assertEquals(change.revisions.length, 2);
        assertEquals(change.head, onTop.headSha);
        assertEquals(change.authorHead, headSha);
      }
    } finally {
      await scratch.dispose();
      await stranger.dispose();
      await w.dispose();
    }
  },
);

radTest(
  "a change request reopened asks again: one push for the author's head, whoever reopened it",
  async () => {
    const w = await world();
    const archive = async (peer: Peer, id: string, undo: boolean) => {
      const out = await peer.exec.rad([
        "patch",
        "archive",
        id,
        ...(undo ? ["--undo"] : []),
        "--repo",
        w.repo.rid,
        "--no-announce",
      ]);
      assertEquals(out.code, 0, `rad patch archive failed: ${out.stderr}`);
    };
    try {
      await w.consumer.reconcile(); // first sight
      await w.theyPull();
      const opened = await submits(w, w.theirs, "reopen.md");
      await w.theyPush();
      await w.consumer.reconcile();
      const pushes = () => w.sink.threadEvents().filter((e) => e.kind === "change_request.pushed");
      assertEquals(pushes().length, 1);

      // Archived: closed, and nothing pushed.
      await archive(w.maintainer, opened.ref, false);
      await w.theyPush();
      await w.consumer.reconcile();
      assertEquals(pushes().length, 1);
      assertEquals(
        w.sink.threadEvents().some((e) => e.kind === "change_request.closed"),
        true,
      );

      // Reopened: the same head, asked for again under the reopen's own delivery id.
      await archive(w.maintainer, opened.ref, true);
      await w.theyPush();
      await w.consumer.reconcile();
      assertEquals(pushes().length, 2);
      const reopened = pushes()[1];
      assertEquals(reopened.thread, { kind: "change_request", ref: opened.ref });
      assertEquals(reopened.changeRequest?.headSha, opened.headSha);
      assertEquals(reopened.changeRequest?.author, w.maintainer.did);
      assertEquals(reopened.actor.did, w.maintainer.did);
      assertEquals(reopened.deliveryId === pushes()[0].deliveryId, false);
      assertEquals(await w.consumer.reconcile(), 0, "and a replay asks nothing more");

      // Ryph reopening its own change request asks too: the control plane decides who counts.
      await archive(w.bot, w.changeId, false);
      await archive(w.bot, w.changeId, true);
      await w.consumer.reconcile();
      const ours = pushes().filter((e) => e.thread.ref === w.changeId);
      assertEquals(ours.map((e) => [e.actor.did, e.changeRequest?.headSha]), [
        [w.bot.did, w.headSha],
      ]);
    } finally {
      await w.dispose();
    }
  },
);
