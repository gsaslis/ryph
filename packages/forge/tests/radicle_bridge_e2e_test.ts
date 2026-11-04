// The forge's Radicle adapter and its change transport, against the REAL bridge — no fake on
// the forge → bridge seam anywhere in this file.
//
// This test exists because that seam hid two bugs at once. `radicle_api_test.ts` drives the
// adapter against a fake bridge and `@ryph/radicle`'s `bridge_test.ts` drives the bridge
// against real `rad` binaries, and both were green while a live network run failed on the very
// first call: the forge percent-encodes a RID (it carries a colon) and the bridge's router
// handed URLPattern's groups through raw, so `rad:z…` arrived as `rad%3Az…` and every route
// answered "not a repository id". Each side tested the address it spelled itself. Nothing
// tested the one that crosses.
//
// So: a real `rad` in a temp `RAD_HOME`, the real bridge's route table behind a real HTTP
// server, and the real `radicleForgeApi` / `radicleChangeTransport` dialling it. Offline, like
// the bridge's own suite — the fake node answers the control socket, which is all a submission
// and a read need. It SKIPS (loudly) where `rad` is not installed.
//
// Reaching into `../../radicle` is deliberate: this is a cross-package test, and duplicating
// the peer fixtures would mean duplicating the part that must not drift.

import { test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { setup } from "../../radicle/src/setup.ts";
import { makeRouter } from "@ryph/shared/http";
import { startFakeNode } from "../../radicle/src/adapters/node/fake.ts";
import { socketNodeControl } from "../../radicle/src/adapters/node/socket.ts";
import { memoryCursorStore } from "../../radicle/src/adapters/cursor_store/memory.ts";
import { recordingEventSink } from "../../radicle/src/adapters/event_sink/recording.ts";
import { SILENT_DIAGNOSTICS } from "../../radicle/src/ports/diagnostics.ts";
import {
  commit,
  initRepo,
  makeBundle,
  makePeer,
  type Peer,
  pullRefs,
  RAD_MISSING,
  RAD_SKIP_REASON,
  seedFrom,
  socketPath,
  tempDir,
  type TestRepo,
} from "../../radicle/tests/util.ts";

import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { providerRegistry, wholeRepoVisibility } from "../src/ports/forge_api.ts";
import { radicleForgeApi } from "../src/adapters/forge_api/radicle.ts";
import { radicleChangeTransport } from "../src/adapters/change_transport/radicle.ts";
import { ForgeApiError } from "../src/ports/forge_api.ts";
import type { ForgeApi, ForgeRepo } from "../src/ports/forge_api.ts";
import type { RadicleBridgeApi } from "../src/ports/radicle_bridge.ts";
import type { ChangeTransport } from "../src/ports/change_transport.ts";
import type { RepoCache } from "../src/ports/repo_cache.ts";
import { silentDiagnostics } from "./util.ts";
import { renderImages } from "../src/core/images.ts";
import { fakeRunImages } from "../src/adapters/run_images/fake.ts";

const TOKEN = "a-test-service-token";
const EXPLORER = "https://explorer.test/{rid}/{kind}/{id}";
const BRANCH = "ryph/ada/r-1";

/**
 * No cache entry, ever. The interesting path is the other one: the transport then fetches the
 * base from the bridge's own git door, with the shared bearer, which is a second crossing of
 * the seam this file is about.
 */
const coldCache: RepoCache = {
  refreshBase: () => Promise.reject(new Error("the cold cache never warms")),
  serveBase: () => Promise.reject(new Error("the cold cache never warms")),
  find: () => Promise.resolve(null),
  ensureCommit: () => Promise.reject(new Error("the cold cache never warms")),
  withHeld: () => Promise.reject(new Error("the cold cache never warms")),
  remoteDefaultBranch: () => Promise.reject(new Error("the cold cache never warms")),
  remoteBranchHead: () => Promise.reject(new Error("the cold cache never warms")),
};

interface World {
  maintainer: Peer;
  bot: Peer;
  repo: TestRepo;
  ref: ForgeRepo;
  api: ForgeApi & RadicleBridgeApi;
  transport: ChangeTransport;
  /** The bridge's own address, for the one assertion that has to read past a rendering budget. */
  baseUrl: string;
  dispose(): Promise<void>;
}

/** The whole stack: two identities, a seeded repository, a live bridge, and the forge's own
 * adapter pointed at it over HTTP. */
async function world(files?: Record<string, string>): Promise<World> {
  const maintainer = await makePeer("maintainer");
  const bot = await makePeer("ryph");
  const repo = await initRepo(maintainer, { name: "widget", description: "a widget", files });
  await seedFrom(maintainer, bot, repo.rid);

  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, nid: bot.nid });
  const data = await tempDir("bridge-data");
  await mkdir(`${data.path}/export`, { recursive: true });
  await mkdir(`${data.path}/scratch`, { recursive: true });

  const bridge = setup({
    exec: bot.exec,
    node: socketNodeControl({ socket: sock.path }),
    cursors: memoryCursorStore(),
    sink: recordingEventSink(),
    diag: SILENT_DIAGNOSTICS,
    token: TOKEN,
    explorerUrl: EXPLORER,
    config: {
      exportDir: `${data.path}/export`,
      scratchDir: `${data.path}/scratch`,
      maxBundleBytes: 50 * 1024 * 1024,
      maxUploadPackBytes: 8 * 1024 * 1024,
      fetchBeforeAdvertise: false,
      gitFetchTimeoutMs: 1_000,
      // No pre-advertise fetch here, so no freshness window to skip one on.
      gitFetchFreshMs: 0,
    },
  });
  const router = makeRouter(bridge.routes);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, router);
  const baseUrl = `http://127.0.0.1:${server.addr.port}`;
  const diag = silentDiagnostics();

  return {
    maintainer,
    bot,
    repo,
    ref: { repoRef: repo.rid, tenantId: null },
    api: radicleForgeApi({ baseUrl, token: TOKEN, explorerUrl: EXPLORER, diag }),
    transport: radicleChangeTransport({ baseUrl, token: TOKEN, cache: coldCache, diag }),
    baseUrl,
    async dispose() {
      await server.shutdown();
      await fake.close();
      await sock.dispose();
      await data.dispose();
      await maintainer.dispose();
      await bot.dispose();
      await rm(repo.workDir, { recursive: true }).catch(() => {});
    },
  };
}

/** One more commit in the maintainer's working copy, bundled as a run's output would be. */
async function work(
  w: World,
  file: string,
  content: string,
  message: string,
): Promise<{ bundlePath: string; headSha: string; dispose(): Promise<void> }> {
  const headSha = await commit(w.maintainer, w.repo.workDir, file, content, message);
  const dir = await tempDir("bundle");
  const bundlePath = `${dir.path}/out.bundle`;
  await makeBundle(w.maintainer, w.repo.workDir, w.repo.head, headSha, bundlePath, BRANCH);
  return { bundlePath, headSha, dispose: dir.dispose };
}

const radTest = test.skipIf(RAD_MISSING);

/** A surface this file does not drive: reaching it is a bug in the test, not a stub's answer. */
const never = () => Promise.reject(new Error("not part of this surface"));

radTest(`the forge reads a repository through the real bridge [${RAD_SKIP_REASON}]`, async () => {
  const w = await world();
  try {
    // THE REGRESSION. Every address the forge builds percent-encodes the RID, because it
    // carries a colon; a bridge that does not decode its path groups answers 400 to the one
    // address it exists to serve. Nothing below this line works if this does not.
    const doc = await w.api.describeRepo(w.repo.rid);
    assertEquals(doc.rid, w.repo.rid);
    assertEquals(doc.name, "widget");
    assertEquals(doc.defaultBranch, "main");
    assertEquals(doc.delegates, [w.maintainer.did]);
    assertEquals(doc.isDelegate, false, "ryph is a stranger here, which is the normal case");
    assertEquals(doc.self.did, w.bot.did);

    // Delegacy read live, through the same escaped address. Admin is delegacy and ryph is a
    // stranger here; write is permissionless on a public repo, which this one is — the very
    // asymmetry that lets a stranger open a patch against a repo it does not own.
    assertEquals(await w.api.checkPermission(w.ref, w.maintainer.did, "admin"), "allowed");
    assertEquals(await w.api.checkPermission(w.ref, w.bot.did, "admin"), "denied");
    assertEquals(await w.api.checkPermission(w.ref, w.bot.did, "write"), "allowed");
    assertEquals(
      await w.api.repoVisibility(null, [w.repo.rid]),
      new Map([[w.repo.rid, wholeRepoVisibility(false)]]),
    );
    assertEquals(
      w.api.upstreamUrl(w.ref, w.repo.rid).endsWith(
        `/v1/repos/${encodeURIComponent(w.repo.rid)}/git`,
      ),
      true,
    );
  } finally {
    await w.dispose();
  }
});

radTest(
  "a bundle becomes a change request, and a second delivery becomes its revision",
  async () => {
    const w = await world();
    try {
      const first = await work(w, "FEATURE.md", "one\n", "add the feature");
      const delivered = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: first.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: first.headSha,
        title: "Add the feature",
        description: "A longer explanation.\n\nWith a second paragraph.",
        embeds: [],
        draft: false,
        existingRef: null,
      });
      await first.dispose();
      assertEquals(delivered.kind, "delivered", JSON.stringify(delivered));
      assert(delivered.kind === "delivered");
      const ref = delivered.ref;
      assertEquals(ref.length, 40);
      assertEquals(delivered.url, `https://explorer.test/${w.repo.rid}/patches/${ref}`);

      // Read back through the adapter — not through the bridge's own shapes.
      const head = await w.api.describeChangeRequest(w.ref, ref);
      assertEquals(head.state, "open");
      assertEquals(head.merged, false);
      assertEquals(head.headSha, first.headSha);
      assertEquals(head.headRef, `patches/${ref}`);
      assertEquals(head.headRepoRef, w.repo.rid, "a Radicle change request never forks");
      assertEquals(head.defaultBranch, "main");

      const listed = await w.api.listChangeRequests(w.ref, { state: "open", page: 1 });
      assertEquals(listed.items.map((c) => c.ref), [ref]);
      assertEquals(listed.items[0].title, "Add the feature");
      assertEquals(listed.hasMore, false);

      // The hunks, which is what a review's remarks are checked against.
      const patches = await w.api.listChangeRequestPatches(w.ref, ref);
      assertEquals(patches.complete, true);
      assertEquals(patches.headSha, first.headSha);
      assertEquals(patches.files.map((f) => f.path), ["FEATURE.md"]);
      assertStringIncludes(patches.files[0].patch ?? "", "+one");

      // The file listing a change request read renders carries the same hunks, merged onto
      // the stat — so the read says where a remark may anchor instead of "no diff shown".
      const files = await w.api.listChangeRequestFiles(w.ref, ref);
      assertEquals(files.items.map((f) => f.path), ["FEATURE.md"]);
      assertEquals(files.items[0].additions, 1);
      assertStringIncludes(files.items[0].patch ?? "", "+one");

      // A second generation of the same work: a REVISION on the same change request, not a
      // second one. `existingRef` is the whole difference.
      const second = await work(w, "FEATURE.md", "one\ntwo\n", "extend it");
      const revised = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: second.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: second.headSha,
        title: "Add the feature",
        description: "Now with more.",
        embeds: [],
        draft: false,
        existingRef: ref,
      });
      await second.dispose();
      assert(revised.kind === "delivered");
      assertEquals(revised.ref, ref, "a revision stays on the same change request");

      const after = await w.api.describeChangeRequest(w.ref, ref);
      assertEquals(after.headSha, second.headSha);
      assertEquals(
        (await w.api.listChangeRequests(w.ref, { state: "open", page: 1 })).items.length,
        1,
      );
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "issues, comments, reactions and a review with an inline remark, all through the adapter",
  async () => {
    const w = await world();
    try {
      // ---- an issue, its listing and its thread ----------------------------------------------
      const opened = await w.api.createIssue(w.ref, {
        title: "The widget squeaks",
        body: "Every time it turns.",
        labels: [],
      });
      assertEquals(opened.ref.length, 40);
      assertEquals(opened.url, `https://explorer.test/${w.repo.rid}/issues/${opened.ref}`);
      assertEquals(await w.api.threadKind(w.ref, opened.ref), "issue");

      const issues = await w.api.listIssues(w.ref, { state: "open", labels: [], page: 1 });
      assertEquals(issues.items.map((i) => i.ref), [opened.ref]);
      // The root comment IS the body, so a fresh issue has no replies.
      assertEquals(issues.items[0].comments, 0);

      // The comment handle carries its thread, and both halves of it need escaping on the way
      // back out — the thread ref and the comment id ride inside one opaque string.
      const posted = await w.api.postComment(
        w.ref,
        { kind: "issue", ref: opened.ref },
        "Looking at this now.",
      );
      assertEquals(posted.commentId.startsWith(`issue:${opened.ref}:`), true);
      await w.api.updateComment(w.ref, posted.commentId, "Looked at it.");
      await w.api.addReaction(w.ref, posted.commentId, "eyes");

      const thread = await w.api.fetchThread(w.ref, { kind: "issue", ref: opened.ref });
      assertEquals(thread.kind, "issue");
      assertEquals(thread.title, "The widget squeaks");
      assertEquals(thread.body, "Every time it turns.");
      assertEquals(thread.entries.map((e) => e.body), ["Looked at it."]);
      assertEquals(thread.entries[0].authorLogin, w.bot.did);

      // ---- a change request, a comment on it, and a review --------------------------------
      const made = await work(w, "src.ts", "line one\nline two\n", "add src");
      const delivered = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: made.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: made.headSha,
        title: "Reviewable",
        description: "",
        embeds: [],
        draft: false,
        existingRef: null,
      });
      await made.dispose();
      assert(delivered.kind === "delivered");
      const ref = delivered.ref;
      assertEquals(await w.api.threadKind(w.ref, ref), "change_request");

      await w.api.createComment(w.ref, { kind: "change_request", ref }, "One thought first.");
      await w.api.createReview(w.ref, ref, {
        body: "Looks reasonable",
        comments: [{ path: "src.ts", line: 2, side: "RIGHT", body: "this line needs a comment" }],
        headSha: made.headSha,
      });

      const conversation = await w.api.fetchThread(w.ref, { kind: "change_request", ref });
      assertEquals(conversation.kind, "change_request");
      assertEquals(conversation.title, "Reviewable");
      const kinds = conversation.entries.map((e) => e.kind);
      assertEquals(kinds.includes("comment"), true);
      assertEquals(kinds.includes("review"), true);
      const remark = conversation.entries.find((e) => e.kind === "review_comment");
      assert(remark, "the inline remark is part of the conversation a run has to answer");
      assertEquals(remark.body, "this line needs a comment");
      assertEquals(remark.location, "src.ts:2");
      // A run's review never approves and never blocks a merge.
      assertEquals(
        conversation.entries.find((e) => e.kind === "review")?.state,
        "commented",
      );

      // A review checked against a head that has moved on is refused rather than anchored to a
      // diff nobody looked at.
      const stale = await assertRejects(
        () =>
          w.api.createReview(w.ref, ref, {
            body: "late",
            comments: [],
            headSha: "0".repeat(40),
          }),
        ForgeApiError,
      );
      assert(stale.terminal);
      assertStringIncludes(stale.message, "read the diff again");
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "the two refusals that cross the seam: a capability ryph lacks, and a repo nobody gave us",
  async () => {
    const w = await world();
    try {
      const opened = await w.api.createIssue(w.ref, {
        title: "Labelled?",
        body: "we shall see",
        labels: [],
      });
      // Radicle reserves labelling for a repository's delegates, and ryph is not one. The
      // bridge types it as a 403 `forge_capability_unavailable`; the adapter has to turn that
      // into a sentence a model can act on rather than a 500 it retries until its cap is gone.
      const refused = await assertRejects(
        () => w.api.addLabels(w.ref, { kind: "issue", ref: opened.ref }, ["bug"]),
        ForgeApiError,
      );
      assert(refused.terminal, "no retry makes ryph a delegate");
      assertStringIncludes(refused.message, "delegate");
      assertStringIncludes(refused.message, "Nothing was written");

      // And the design gap the live network test found: the node was asked for a repository it
      // has never seen and the network handed nothing back. From here a private repository
      // whose allow list we are not on is indistinguishable from an id nobody offers — so the
      // answer is a VALUE carrying our DID and the command a delegate would run, not a throw.
      const stranger = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
      const outcome = await w.api.seedRepo(stranger);
      assertEquals(outcome.kind, "unavailable");
      assert(outcome.kind === "unavailable");
      assertEquals(outcome.rid, stranger);
      assertEquals(outcome.did, w.bot.did);
      assertEquals(outcome.command, `rad id update --allow ${w.bot.did}`);
      assertEquals(outcome.seeds, 0);

      // A repository this node simply does not hold is still a terminal read failure — the
      // seed route is the only one that answers with a command.
      const unread = await assertRejects(
        () => w.api.describeRepo(stranger),
        ForgeApiError,
      );
      assert(unread.terminal);
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "a title and a description the header framing could not carry round-trip whole",
  async () => {
    const w = await world();
    try {
      // THE REGRESSION. `title` and `description` are the agent's own words, and they used to
      // ride an HTTP header. A header value is a ByteString: `fetch` throws
      // `not a valid ByteString` at CONSTRUCTION for any of the three characters below, which
      // the transport's catch reported as "the bridge is unreachable" — non-terminal, so the
      // patch was retried forever and never landed. And a description near the 65_000-character
      // cap `prBody` allows outgrows the header block a server accepts, which came back as a
      // bare 400 and read as terminal. Neither is possible now: both are parts of the body.
      const title = "Don’t squeak — fix the widget \u{1F600}";
      const description = "é" + "a".repeat(64_990) + "—\u{1F680}";
      assertEquals(description.length, 64_994);

      const made = await work(w, "QUIET.md", "shhh\n", "quieten it");
      const delivered = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: made.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: made.headSha,
        title,
        description,
        embeds: [],
        draft: false,
        existingRef: null,
      });
      await made.dispose();
      assertEquals(delivered.kind, "delivered", JSON.stringify(delivered));
      assert(delivered.kind === "delivered");

      const thread = await w.api.fetchThread(w.ref, {
        kind: "change_request",
        ref: delivered.ref,
      });
      // The title is one line by the time it reaches a push option, but every character of it
      // survives the crossing.
      assertEquals(thread.title, title);
      // What a RUN reads is bounded by the adapter's per-entry budget; what the forge DELIVERED
      // is the whole thing, and only the bridge can say so.
      assertEquals(thread.body, description.slice(0, 16_000));
      const raw = await fetch(
        `${w.baseUrl}/v1/repos/${encodeURIComponent(w.repo.rid)}/changes/${delivered.ref}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      const stored = (await raw.json()).change;
      assertEquals(stored.title, title);
      assertEquals(stored.description, description);
    } finally {
      await w.dispose();
    }
  },
);

radTest("a bridge that cannot be reached leaves no open descriptor behind", async () => {
  const w = await world();
  try {
    const made = await work(w, "LEAK.md", "one\n", "check for a leak");
    // A transport pointed at a port nobody is listening on, sharing this world's cache and
    // bundle so the staging half still succeeds and the FETCH is what fails. The descriptor
    // itself was checked by Deno's resource sanitizer, which caught the bundle's file left open
    // when its `open` sat outside a `finally`.
    // TODO(bun): no sanitizer under bun test, so a leaked descriptor no longer fails this; what
    // is left checks the failure is the retryable kind.
    const dead = radicleChangeTransport({
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
      cache: coldCache,
      diag: silentDiagnostics(),
      requestTimeoutMs: 2_000,
    });
    const outcome = await dead.deliver({
      repo: w.ref,
      repoUrl: w.repo.rid,
      bundlePath: made.bundlePath,
      branchName: BRANCH,
      baseBranch: "main",
      headSha: made.headSha,
      title: "never arrives",
      description: "",
      embeds: [],
      draft: false,
      existingRef: null,
    });
    await made.dispose();
    assertEquals(outcome.kind, "failed");
    assert(outcome.kind === "failed");
    // Not terminal: a dead socket is a neighbour restarting, and the patch is worth retrying.
    assertEquals(outcome.terminal, false);
  } finally {
    await w.dispose();
  }
});

// ---- the services file, over the same seam -------------------------------------------------

const DECLARATION = `services:
  db:
    uses: postgres@18
    port: 5433
`;

/**
 * The forge's own service door, pointed at this world's bridge.
 *
 * Built here rather than in `world()` because only this half of the file needs it: it is the
 * forge's REAL handler, its real repo cache, and the real Radicle adapter — so the clone it
 * makes to answer a services read is a clone through the bridge's git door.
 */
async function forgeDoor(w: World) {
  const diag = silentDiagnostics();
  const root = await tempDir("forge-root");
  await mkdir(`${root.path}/staging`, { recursive: true });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root.path}/cache`, diag }),
    patches: localFsPatchStore(`${root.path}/patches`, diag),
    diag,
    forges: providerRegistry({ radicle: w.api }, "forge API"),
    // Door ③ is mounted whole or not at all; no bundle is submitted through this one.
    transports: providerRegistry({ radicle: { deliver: never } }, "change transport"),
    serviceToken: TOKEN,
    config: {
      maxUploadPackBytes: 8 * 1024 * 1024,
      maxBundleBytes: 8 * 1024 * 1024,
      stagingDir: `${root.path}/staging`,
    },
  };
  const handler = makeHandler(deps);
  const ask = async (route: string, body: Record<string, unknown>) => {
    const res = await handler(
      new Request(`http://forge/v1/service/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          repo: { provider: "radicle", repoRef: w.repo.rid, tenantId: null },
          url: w.repo.rid,
          ...body,
        }),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    ask,
    read: (url: string, ref = "main") =>
      handler(
        new Request("http://forge/v1/service/services-file", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({
            repo: { provider: "radicle", repoRef: w.repo.rid, tenantId: null },
            url,
            ref,
          }),
        }),
      ),
    dispose: root.dispose,
  };
}

radTest(
  "a Radicle repo's services file is read through the bridge's git door, by its RID",
  async () => {
    // THE REGRESSION, from the other end. `url` is the connected repo's stored address, and a
    // Radicle row's is the RID. A flow that stored "" for it had this schema refuse the read
    // (`url: Too small`), the orchestrator read the 400 as "services unavailable", and every
    // run on every Radicle repo was refused before it started.
    const w = await world({ ".ryph/services.yml": DECLARATION });
    const door = await forgeDoor(w);
    try {
      const res = await door.read(w.repo.rid);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.kind, "file");
      assertEquals(body.stale, false);
      assertStringIncludes(body.text, "uses: postgres@18");
    } finally {
      await door.dispose();
      await w.dispose();
    }
  },
);

radTest("a Radicle repo that declares nothing is absent, not unavailable", async () => {
  // The distinction the launch path rests on: "the repo declares none" starts the run, "we
  // could not ask" refuses it. A repo with no file must never be mistaken for the second.
  const w = await world();
  const door = await forgeDoor(w);
  try {
    assertEquals(await (await door.read(w.repo.rid)).json(), { kind: "absent" });
  } finally {
    await door.dispose();
    await w.dispose();
  }
});

// ---- the environment reads, over the same seam ---------------------------------------------

radTest(
  "a Radicle repo's default head and .ryph tree are read through the bridge's git door",
  async () => {
    const w = await world({ ".ryph/Dockerfile": "FROM quay.io/ryph/ryph-universal:1\n" });
    const door = await forgeDoor(w);
    try {
      // The default branch comes off the git door's HEAD, which the bridge points at the
      // identity document's default — no second question to the bridge's API.
      const head = await door.ask("default-branch-head", {});
      assertEquals(head, { status: 200, body: { ref: "main", commit: w.repo.head } });

      const byRef = await door.ask("ryph-tree", { commitOrRef: "main" });
      assertEquals(byRef.status, 200);
      assertEquals(byRef.body.commit, w.repo.head);
      assertEquals(typeof byRef.body.tree, "string");
      // By id, through the same door: v2 upload-pack serves a commit nobody names as a tip.
      const byId = await door.ask("ryph-tree", { commitOrRef: w.repo.head });
      assertEquals(byId.body, byRef.body);
    } finally {
      await door.dispose();
      await w.dispose();
    }
  },
);

radTest(
  "branch kinds through the real bridge: the default, a canonical branch, and our own change request",
  async () => {
    const w = await world();
    const door = await forgeDoor(w);
    try {
      const made = await work(w, "FEATURE.md", "one\n", "add the feature");
      const delivered = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: made.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: made.headSha,
        title: "Add the feature",
        description: "",
        embeds: [],
        draft: false,
        existingRef: null,
      });
      await made.dispose();
      assert(delivered.kind === "delivered", JSON.stringify(delivered));

      const kind = async (ref: string) => (await door.ask("branch-kind", { ref })).body;
      assertEquals(await kind("main"), { kind: "default" });
      assertEquals(await kind("refs/heads/main"), { kind: "default" });
      // Our node published it, and our node is not a delegate here — it counts all the same.
      assertEquals(await kind(`refs/heads/patches/${delivered.ref}`), { kind: "branch" });
      assertEquals(await kind("somewhere-canonical"), { kind: "branch" });
    } finally {
      await door.dispose();
      await w.dispose();
    }
  },
);

radTest(
  "an agent's image reaches Radicle as an embed, and reads back as the same image",
  async () => {
    const w = await world();
    try {
      const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2]);
      const images = fakeRunImages({
        "r-1": [{
          ref: "img-3f9a1c0b2d4e",
          attachmentId: "att-1",
          mime: "image/png",
          url: null,
          bytes: shot,
        }],
      });
      const opened = await w.api.createIssue(w.ref, {
        title: "The widget squeaks",
        body: "Every time it turns.",
        labels: [],
      });
      const rendered = await renderImages(
        images,
        "r-1",
        "Fixed, see ![the quiet widget](img-3f9a1c0b2d4e).",
        "embed",
      );
      await w.api.createComment(
        w.ref,
        { kind: "issue", ref: opened.ref },
        rendered.text,
        rendered.embeds,
      );

      // The same read a run gets: the image is the comment's, at the link the body carries.
      const thread = await w.api.fetchThread(w.ref, { kind: "issue", ref: opened.ref }, {
        images: { focus: null },
      });
      const [image] = thread.entries[0].images ?? [];
      assert(image?.kind === "image", JSON.stringify(thread.entries[0]));
      assertEquals(image.markup, `[the quiet widget](${rendered.embeds[0].oid})`);
      assertEquals(image.name, "img-3f9a1c0b2d4e.png");
      assertEquals(Uint8Array.fromBase64(image.data), shot);

      // A change request's description, delivered with its embed.
      const made = await work(w, "QUIET.md", "shhh\n", "quieten it");
      const description = await renderImages(images, "r-1", "![](img-3f9a1c0b2d4e)", "embed");
      const delivered = await w.transport.deliver({
        repo: w.ref,
        repoUrl: w.repo.rid,
        bundlePath: made.bundlePath,
        branchName: BRANCH,
        baseBranch: "main",
        headSha: made.headSha,
        title: "Quieten the widget",
        description: description.text,
        embeds: description.embeds,
        draft: false,
        existingRef: null,
      });
      await made.dispose();
      assert(delivered.kind === "delivered", JSON.stringify(delivered));
      const change = await w.api.fetchThread(
        w.ref,
        { kind: "change_request", ref: delivered.ref },
        {
          images: { focus: null },
        },
      );
      assertEquals(change.body, `[img-3f9a1c0b2d4e.png](${description.embeds[0].oid})`);
      const [described] = change.bodyImages ?? [];
      assert(described?.kind === "image", JSON.stringify(change.bodyImages));
      assertEquals(Uint8Array.fromBase64(described.data), shot);
    } finally {
      await w.dispose();
    }
  },
);

radTest(
  "a merge of an older revision: the read names its head, and containment leaves the newer missed",
  async () => {
    const w = await world();
    const door = await forgeDoor(w);
    try {
      const deliver = async (file: string, existingRef: string | null) => {
        const made = await work(w, file, `${file}\n`, `add ${file}`);
        const delivered = await w.transport.deliver({
          repo: w.ref,
          repoUrl: w.repo.rid,
          bundlePath: made.bundlePath,
          branchName: BRANCH,
          baseBranch: "main",
          headSha: made.headSha,
          title: "Add the feature",
          description: "",
          embeds: [],
          draft: false,
          existingRef,
        });
        await made.dispose();
        assert(delivered.kind === "delivered", JSON.stringify(delivered));
        return { ref: delivered.ref, head: made.headSha };
      };
      // Two pushes in one generation: the second is a revision of the first's change request.
      const r1 = await deliver("one.md", null);
      const r2 = await deliver("two.md", r1.ref);
      assertEquals(r2.ref, r1.ref);

      // The delegate merges the FIRST revision, by pushing its head onto the default branch.
      await pullRefs(w.bot, w.maintainer, w.repo.rid);
      await w.maintainer.exec.rad(["patch", "cache", "--repo", w.repo.rid, "--no-announce", "-q"]);
      const pushed = await w.maintainer.exec.git(w.repo.workDir, [
        "push",
        "-o",
        "no-sync",
        "rad",
        `${r1.head}:refs/heads/${w.repo.defaultBranch}`,
      ]);
      assertEquals(pushed.code, 0, `merge push failed: ${pushed.stderr}`);
      await pullRefs(w.maintainer, w.bot, w.repo.rid);

      // The lean read: merged, with the latest head still the second — and what merged, the first.
      const state = await w.api.readChangeRequestState(w.ref, r1.ref);
      assertEquals([state?.state, state?.merged], ["closed", true]);
      assertEquals(state?.headSha, r2.head);
      assertEquals(state?.mergedHeads, [r1.head]);

      // And git's answer through the bridge's door: the first contained, the second missed —
      // fetched by id through the door to be compared by content, and still missed, since its
      // change is not what merged.
      const answer = await door.ask("merge-containment", {
        mergedHeads: state?.mergedHeads,
        heads: [r1.head, r2.head],
      });
      assertEquals(answer, {
        status: 200,
        body: { contained: [r1.head], missed: [r2.head] },
      });
    } finally {
      await door.dispose();
      await w.dispose();
    }
  },
);
