// The whole HTTP surface, against the REAL `rad` binaries, two real identities and real storage
// — offline, in temp homes that are deleted afterwards. This is the test that would have caught
// every wrong assumption about the CLI, and did.
//
// The cast: `maintainer` owns the repository and is its only delegate. `bot` is ryph — it has
// the repository in storage (the offline stand-in for `rad clone`) and is NOT a delegate, which
// is the interesting case and the one a deployment will actually be in.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import { setup } from "../src/setup.ts";
import { makeRouter } from "@ryph/shared/http";
import { socketNodeControl } from "../src/adapters/node/socket.ts";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { memoryCursorStore } from "../src/adapters/cursor_store/memory.ts";
import { recordingEventSink } from "../src/adapters/event_sink/recording.ts";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import type { ChangeView, IssueView } from "../src/core/types.ts";
import type { RadicleService } from "../src/core/service.ts";
import type { RadExec } from "../src/ports/rad.ts";
import {
  commit,
  initRepo,
  makeBundle,
  makePeer,
  type Peer,
  RAD_MISSING,
  RAD_SKIP_REASON,
  seedFrom,
  socketPath,
  tempDir,
  type TestRepo,
} from "./util.ts";

const TOKEN = "a-test-service-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

interface Bench {
  maintainer: Peer;
  bot: Peer;
  repo: TestRepo;
  call(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** The router itself, for the one test that needs a real socket to clone through. */
  handler(req: Request): Promise<Response>;
  /** Every command the fake node was sent, in order. */
  nodeCommands(): Array<Record<string, unknown>>;
  /** The service the routes are built over — what the pull loop drives. */
  service: RadicleService;
  /** Where an uploaded bundle is spooled — a refusal must leave nothing behind in it. */
  scratchDir: string;
  dispose(): Promise<void>;
}

/**
 * With `network`, the bot's own `rad` is pointed at the fake node too — so a `rad sync --fetch`
 * from the git door reaches it — and the fake answers `sessions` and `fetch` as given. Without
 * it the bot's CLI has no node (RAD_SOCKET=/dev/null), which is why the seed tests see a
 * network that answers nothing.
 */
interface BenchNetwork {
  sessions: unknown[];
  fetchResults?: Record<string, unknown>;
  /** The node never answers a fetch. */
  stallFetches?: boolean;
  /** `gitFetchFreshMs` — how recently a fetch must have landed for a clone to skip its own. */
  freshMs: number;
  /** The clock that freshness reads. */
  now: () => number;
}

/**
 * Empties the profile's `preferredSeeds`: a stock one carries iris and rosa, which the fetcher
 * adds as candidates — two nodes that are not there, dialled on every fetch.
 */
async function forgetPreferredSeeds(peer: Peer): Promise<void> {
  const configPath = `${peer.home}/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.preferredSeeds = [];
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

/** Everything a surface test needs: two identities, a seeded repository, and a live router. */
async function bench(
  opts: {
    fetchBeforeAdvertise?: boolean;
    seeds?: unknown[];
    maxBundleBytes?: number;
    network?: BenchNetwork;
    /** Stands between the bridge and the bot's `rad`, to make one command fail. */
    wrapExec?: (exec: RadExec) => RadExec;
  } = {},
): Promise<Bench> {
  const sock = await socketPath();
  const maintainer = await makePeer("maintainer");
  const bot = await makePeer("ryph", opts.network ? sock.path : "/dev/null");
  if (opts.network) await forgetPreferredSeeds(bot);
  const repo = await initRepo(maintainer, { name: "widget", description: "a widget" });
  await seedFrom(maintainer, bot, repo.rid);

  const fake = startFakeNode({
    path: sock.path,
    nid: bot.nid,
    seeds: opts.seeds,
    sessions: opts.network?.sessions,
    fetchResults: opts.network?.fetchResults,
    stallFetches: opts.network?.stallFetches,
  });
  const data = await tempDir("bridge-data");
  await mkdir(`${data.path}/export`, { recursive: true });
  await mkdir(`${data.path}/scratch`, { recursive: true });

  const bridge = setup({
    exec: opts.wrapExec?.(bot.exec) ?? bot.exec,
    node: socketNodeControl({ socket: sock.path }),
    cursors: memoryCursorStore(),
    sink: recordingEventSink(),
    diag: SILENT_DIAGNOSTICS,
    token: TOKEN,
    explorerUrl: "https://explorer.test/{rid}/{kind}/{id}",
    now: opts.network?.now,
    config: {
      exportDir: `${data.path}/export`,
      scratchDir: `${data.path}/scratch`,
      maxBundleBytes: opts.maxBundleBytes ?? 50 * 1024 * 1024,
      maxUploadPackBytes: 1024 * 1024,
      fetchBeforeAdvertise: opts.fetchBeforeAdvertise ?? false,
      gitFetchTimeoutMs: 1_000,
      gitFetchFreshMs: opts.network?.freshMs ?? 0,
    },
  });
  const router = makeRouter(bridge.routes);

  return {
    maintainer,
    bot,
    repo,
    call: (method, path, init) => router(new Request(`http://bridge${path}`, { method, ...init })),
    handler: router,
    nodeCommands: () => fake.commands,
    service: bridge.service,
    scratchDir: `${data.path}/scratch`,
    async dispose() {
      await fake.close();
      await sock.dispose();
      await data.dispose();
      await maintainer.dispose();
      await bot.dispose();
      await rm(repo.workDir, { recursive: true }).catch(() => {});
    },
  };
}

/** A bundle of one new commit on top of the repository's head, plus the two shas. */
async function work(
  b: Bench,
  file: string,
  content: string,
  message: string,
  base: string,
): Promise<{ path: string; head: string; base: string; dispose(): Promise<void> }> {
  const head = await commit(b.maintainer, b.repo.workDir, file, content, message);
  const dir = await tempDir("bundle");
  const path = `${dir.path}/out.bundle`;
  await makeBundle(b.maintainer, b.repo.workDir, base, head, path);
  return { path, head, base, dispose: dir.dispose };
}

/**
 * A submission in the one framing the route takes: `multipart/form-data`, the `meta` JSON in a
 * field and the bundle in a file part. Assembled by hand rather than with `FormData` because
 * that is exactly what the forge's transport does — it streams the parts — and because a
 * `FormData` here would hide the framing the parser is being tested on.
 */
function submitInit(
  bundle: Uint8Array,
  meta: Record<string, unknown>,
  boundary = "a-test-boundary",
): RequestInit {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-disposition: form-data; name="meta"\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n--${boundary}\r\n` +
      `content-disposition: form-data; name="bundle"; filename="change.bundle"\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bundle.length + tail.length);
  body.set(head, 0);
  body.set(bundle, head.length);
  body.set(tail, head.length + bundle.length);
  return {
    headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
    // A Uint8Array over a plain ArrayBuffer is a BodyInit; the cast is TypeScript's
    // ArrayBufferLike looseness, not a claim about the value.
    body: body as unknown as BodyInit,
  };
}

const radTest = test.skipIf(RAD_MISSING);

radTest(`identity and the repository document [${RAD_SKIP_REASON}]`, async () => {
  const b = await bench();
  try {
    const identity = await (await b.call("GET", "/v1/identity", { headers: AUTH })).json();
    assertEquals(identity.did, b.bot.did);
    assertEquals(identity.nid, b.bot.nid);
    assertEquals(identity.alias, "ryph");
    // No node is listening on the fake's socket for `status`? There is — so it answers.
    assertEquals(identity.node?.running, true);

    // ESCAPED, as the forge spells it: a RID is `rad:z…` and every caller percent-encodes
    // the colon. URLPattern hands path groups through raw, so a door that does not decode
    // them answers 400 "not a repository id" to the one address it exists to serve.
    const escaped = await b.call(
      "GET",
      `/v1/repos/${encodeURIComponent(b.repo.rid)}`,
      { headers: AUTH },
    );
    assertEquals(escaped.status, 200);
    assertEquals((await escaped.json()).rid, b.repo.rid);

    const res = await b.call("GET", `/v1/repos/${b.repo.rid}`, { headers: AUTH });
    assertEquals(res.status, 200);
    const doc = await res.json();
    assertEquals(doc.rid, b.repo.rid);
    assertEquals(doc.name, "widget");
    assertEquals(doc.description, "a widget");
    assertEquals(doc.defaultBranch, "main");
    assertEquals(doc.delegates, [b.maintainer.did]);
    assertEquals(doc.threshold, 1);
    assertEquals(doc.visibility, "public");
    assertEquals(doc.allow, []);
    // The capability probe: ryph is a stranger here, and says so.
    assertEquals(doc.isDelegate, false);
    assertEquals(doc.isAllowed, true);
    assertEquals(doc.self.did, b.bot.did);
  } finally {
    await b.dispose();
  }
});

// The design gap the first live network test found, and the shape that closes it.
//
// A private repository refuses the whole fetch at the RESPONDING node (`is_authorized` in
// heartwood's `radicle-node/src/worker.rs`), and the initiator is never told why: heartwood's
// own golden for it (`rad-init-private-clone.md`) prints "an I/O error occurred during the
// fetch handshake (connection reset)". It is also kept out of every inventory announcement and
// its refs are announced only to allowed nodes, so the routing table stays empty too. From this
// side a private repository and one nobody has are the same answer — so the seed route answers
// both at once, with our DID and the command a delegate would run.
radTest("a seed the network answers nothing for is a 409 carrying the allow command", async () => {
  const b = await bench();
  const stranger = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  try {
    const res = await b.call("POST", `/v1/repos/${encodeURIComponent(stranger)}/seed`, {
      headers: AUTH,
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error, "repo_unavailable");
    assertEquals(body.rid, stranger);
    assertEquals(body.did, b.bot.did);
    // Verified against `rad id update --help` (rad 1.10): `--allow <DID>`.
    assertEquals(body.command, `rad id update --allow ${b.bot.did}`);
    // Nobody in the routing table claims it — which is ALSO what a private repository looks
    // like, and exactly why the command is given anyway.
    assertEquals(body.seeds, 0);
    assertStringIncludes(body.reason, "peer");
    // The policy was still written: the seed itself succeeded, only the fetch came back empty.
    const seedCommands = b.nodeCommands().filter((c) => c.command === "seed");
    assertEquals(seedCommands.at(-1)?.rid, stranger);
  } finally {
    await b.dispose();
  }
});

radTest("a seed whose repo the routing table DOES claim reports the seeds it found", async () => {
  // `seedsFor` is the routing answer — what `rad sync` means by "found N potential seed(s)".
  // Above zero it is the one piece of evidence that separates "somebody has it and would not
  // give it to us" from "nobody is offering that id".
  const b = await bench({ seeds: [{ nid: "z6Mkone" }, { nid: "z6Mktwo" }] });
  try {
    const res = await b.call(
      "POST",
      `/v1/repos/${encodeURIComponent("rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5")}/seed`,
      { headers: AUTH },
    );
    assertEquals(res.status, 409);
    assertEquals((await res.json()).seeds, 2);
  } finally {
    await b.dispose();
  }
});

radTest("the whole change-request life: submit, read, revise, re-submit", async () => {
  const b = await bench();
  try {
    const first = await work(b, "FEATURE.md", "one\n", "add the feature", b.repo.head);
    const submitted = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(first.path), {
        title: "Add the feature",
        description: "A longer explanation.\n\nWith a second paragraph.",
        baseSha: first.base,
        headSha: first.head,
      }),
    );
    assertEquals(submitted.status, 200);
    const result = await submitted.json();
    assertEquals(result.created, true);
    assertEquals(result.ref.length, 40);
    assertEquals(result.url, `https://explorer.test/${b.repo.rid}/patches/${result.ref}`);
    await first.dispose();

    // Read it back, materialized and normalized.
    const read = await b.call(`GET`, `/v1/repos/${b.repo.rid}/changes/${result.ref}`, {
      headers: AUTH,
    });
    assertEquals(read.status, 200);
    const change: ChangeView = (await read.json()).change;
    assertEquals(change.title, "Add the feature");
    assertEquals(change.description, "A longer explanation.\n\nWith a second paragraph.");
    assertEquals(change.state, "open");
    assertEquals(change.author.did, b.bot.did);
    assertEquals(change.head, first.head);
    assertEquals(change.base, first.base);
    assertEquals(change.revisions.length, 1);
    // The diff stat is computed with git against storage, not parsed out of the CLI.
    assertEquals(change.files?.filesChanged, 1);
    assertEquals(change.files?.files[0].path, "FEATURE.md");
    assertEquals(change.files?.files[0].status, "added");
    assertEquals(change.files?.insertions, 1);

    // A unique prefix resolves to the same object.
    const byPrefix = await b.call(
      "GET",
      `/v1/repos/${b.repo.rid}/changes/${result.ref.slice(0, 7)}`,
      { headers: AUTH },
    );
    assertEquals((await byPrefix.json()).change.id, result.ref);

    // A second generation: a new revision on the same change request.
    const second = await work(b, "FEATURE.md", "one\ntwo\n", "extend it", b.repo.head);
    const revised = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(second.path), {
        title: "Add the feature",
        description: "Now with more.",
        baseSha: second.base,
        headSha: second.head,
        changeRef: result.ref,
      }),
    );
    assertEquals(revised.status, 200);
    const revision = await revised.json();
    assertEquals(revision.created, true);
    assertEquals(revision.ref, result.ref, "a revision stays on the same change request");
    assertEquals(revision.revision === result.revision, false);

    const after: ChangeView =
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes/${result.ref}`, {
        headers: AUTH,
      })).json()).change;
    assertEquals(after.revisions.length, 2);
    assertEquals(after.head, second.head);

    const compareUrl = `/v1/repos/${b.repo.rid}/changes/${result.ref}/compare`;
    const compare = await b.call("GET", `${compareUrl}?from=${result.revision}`, {
      headers: AUTH,
    });
    assertEquals(compare.status, 200);
    const delta = await compare.json();
    assertEquals(delta.from.head, first.head);
    assertEquals(delta.to.id, revision.revision);
    assertEquals(delta.to.head, second.head);
    assertStringIncludes(delta.text, "+two");
    assertEquals(delta.truncated, false);
    const range = await b.call(
      "GET",
      `${compareUrl}?from=${result.revision}&to=${revision.revision}&mode=range-diff`,
      { headers: AUTH },
    );
    assertEquals(range.status, 200);
    assertEquals((await range.json()).mode, "range-diff");
    const same = await b.call(
      "GET",
      `${compareUrl}?from=${result.revision}&to=${result.revision}`,
      { headers: AUTH },
    );
    assertEquals((await same.json()).text, "");
    const unknown = await b.call("GET", `${compareUrl}?from=${"0".repeat(40)}`, {
      headers: AUTH,
    });
    assertEquals(unknown.status, 404);
    const injection = await b.call("GET", `${compareUrl}?from=--help`, { headers: AUTH });
    assertEquals(injection.status, 400);
    const wrongMode = await b.call("GET", `${compareUrl}?from=${result.revision}&mode=other`, {
      headers: AUTH,
    });
    assertEquals(wrongMode.status, 400);

    // The SAME head again is a no-op, not a failure and not a third revision: git answers
    // "Everything up-to-date" and never reaches the remote helper.
    const again = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(second.path), {
        title: "Add the feature",
        description: "Now with more.",
        baseSha: second.base,
        headSha: second.head,
        changeRef: result.ref,
      }),
    );
    assertEquals(again.status, 200);
    const noop = await again.json();
    assertEquals(noop.created, false);
    assertEquals(noop.ref, result.ref);
    assertEquals(noop.revision, revision.revision);
    await second.dispose();

    const listed = await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes`, {
      headers: AUTH,
    })).json();
    assertEquals(listed.total, 1);
    assertEquals(listed.changes[0].id, result.ref);
    assertEquals(
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes?state=merged`, {
        headers: AUTH,
      })).json()).total,
      0,
    );
  } finally {
    await b.dispose();
  }
});

radTest(
  "two submissions racing for one repository both land, as two distinct patches",
  async () => {
    const b = await bench();
    try {
      // Two bundles, each self-contained against the repository's head, so neither depends on
      // the other having been pushed first.
      const one = await work(b, "ONE.md", "one\n", "one", b.repo.head);
      const two = await work(b, "TWO.md", "two\n", "two", b.repo.head);
      const bodyOne = submitInit(await readFile(one.path), {
        title: "One",
        description: "the first",
        baseSha: one.base,
        headSha: one.head,
      });
      const bodyTwo = submitInit(await readFile(two.path), {
        title: "Two",
        description: "the second",
        baseSha: two.base,
        headSha: two.head,
      });

      // The scratch repositories are private, but `git-remote-rad` writes both patches into the
      // one storage repository — its refs, its COBs, its sigrefs. Without the per-repository
      // lock these interleave there.
      const [resOne, resTwo] = await Promise.all([
        b.call("POST", `/v1/repos/${b.repo.rid}/changes`, bodyOne),
        b.call("POST", `/v1/repos/${b.repo.rid}/changes`, bodyTwo),
      ]);
      assertEquals(resOne.status, 200, await resOne.clone().text());
      assertEquals(resTwo.status, 200, await resTwo.clone().text());
      const first = await resOne.json();
      const second = await resTwo.json();
      assertEquals(first.created, true);
      assertEquals(second.created, true);
      assertEquals(first.ref === second.ref, false, "two submissions are two change requests");
      await one.dispose();
      await two.dispose();

      // And the read-back agrees with both — no half-written COB, no lost patch.
      const listed = await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes`, {
        headers: AUTH,
      })).json();
      assertEquals(listed.total, 2);
      const byId = new Map<string, ChangeView>(
        listed.changes.map((c: ChangeView) => [c.id, c]),
      );
      assertEquals(byId.get(first.ref)?.title, "One");
      assertEquals(byId.get(first.ref)?.head, one.head);
      assertEquals(byId.get(first.ref)?.description, "the first");
      assertEquals(byId.get(second.ref)?.title, "Two");
      assertEquals(byId.get(second.ref)?.head, two.head);
      assertEquals(byId.get(second.ref)?.description, "the second");
    } finally {
      await b.dispose();
    }
  },
);

radTest("a bundle whose head is not what the caller claimed is refused", async () => {
  const b = await bench();
  try {
    const w = await work(b, "X.md", "x\n", "x", b.repo.head);
    const res = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(w.path), {
        title: "Wrong",
        description: "",
        baseSha: w.base,
        headSha: "0".repeat(40),
      }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, "not the 000000");
    await w.dispose();
  } finally {
    await b.dispose();
  }
});

radTest("comments: add, read back, edit, and react", async () => {
  const b = await bench();
  try {
    const w = await work(b, "F.md", "f\n", "f", b.repo.head);
    const change = await (await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(w.path), {
        title: "A change",
        description: "",
        baseSha: w.base,
        headSha: w.head,
      }),
    )).json();
    await w.dispose();

    const posted = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes/${change.ref}/comments`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ body: "first thought" }),
      },
    );
    assertEquals(posted.status, 201);
    const commentId = (await posted.json()).comment.id;
    assertEquals(commentId.length, 40);

    let read: ChangeView =
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes/${change.ref}`, {
        headers: AUTH,
      })).json()).change;
    assertEquals(read.comments.length, 1);
    assertEquals(read.comments[0].id, commentId);
    assertEquals(read.comments[0].body, "first thought");
    assertEquals(read.comments[0].revision, read.revisions[0].id);
    assertEquals(read.comments[0].editedAt, null);

    const edited = await b.call(
      "PATCH",
      `/v1/repos/${b.repo.rid}/changes/${change.ref}/comments/${commentId}`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ body: "second thought" }),
      },
    );
    assertEquals(edited.status, 200);

    const reacted = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes/${change.ref}/comments/${commentId}/reactions`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ reaction: "👍" }),
      },
    );
    assertEquals(reacted.status, 201);

    read = (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes/${change.ref}`, {
      headers: AUTH,
    })).json()).change;
    assertEquals(read.comments.length, 1, "an edit is not a second comment");
    assertEquals(read.comments[0].body, "second thought");
    assertEquals(read.comments[0].editedAt !== null, true);
    assertEquals(read.comments[0].reactions, ["👍"]);
  } finally {
    await b.dispose();
  }
});

radTest("a review with an inline remark, and a second review that edits the first", async () => {
  const b = await bench();
  try {
    const w = await work(b, "src.ts", "line one\nline two\n", "add src", b.repo.head);
    const change = await (await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(w.path), {
        title: "Reviewable",
        description: "",
        baseSha: w.base,
        headSha: w.head,
      }),
    )).json();
    await w.dispose();

    const reviewed = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes/${change.ref}/reviews`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          summary: "Looks reasonable",
          verdict: "accept",
          remarks: [{ path: "src.ts", line: 2, side: "new", body: "this line needs a comment" }],
        }),
      },
    );
    assertEquals(reviewed.status, 201);
    const review = await reviewed.json();
    assertEquals(review.edited, false);
    assertEquals(review.comments.length, 1);

    const read: ChangeView =
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes/${change.ref}`, {
        headers: AUTH,
      })).json()).change;
    assertEquals(read.reviews.length, 1);
    assertEquals(read.reviews[0].verdict, "accept");
    assertEquals(read.reviews[0].summary, "Looks reasonable");
    assertEquals(read.reviews[0].author.did, b.bot.did);
    assertEquals(read.reviews[0].comments.length, 1);
    assertEquals(read.reviews[0].comments[0].location, {
      path: "src.ts",
      commit: w.head,
      line: 2,
      side: "new",
    });

    // The STORED range, read past our own materializer: a round trip agrees with itself
    // whatever the convention, and this one was off by one until a desktop showed `R0`.
    const raw = await b.bot.exec.rad([
      "cob",
      "show",
      "--repo",
      b.repo.rid,
      "--type",
      "xyz.radicle.patch",
      "--object",
      change.ref,
    ]);
    const stored = JSON.stringify(JSON.parse(raw.stdout.trim().split("\n")[0]));
    assert(
      stored.includes('"new":{"type":"lines","range":{"start":2,"end":3}}'),
      `line 2 must be stored as 2..3, got: ${stored.slice(0, 400)}`,
    );

    // Radicle allows one review per author per revision. A second call EDITS rather than
    // failing, and its remarks append to the same review.
    const second = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes/${change.ref}/reviews`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          summary: "Changed my mind",
          verdict: "reject",
          remarks: [{ path: "src.ts", line: 1, side: "new", body: "and this one" }],
        }),
      },
    );
    assertEquals(second.status, 201);
    const editedReview = await second.json();
    assertEquals(editedReview.edited, true);
    assertEquals(editedReview.reviewId, review.reviewId);

    const after: ChangeView =
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/changes/${change.ref}`, {
        headers: AUTH,
      })).json()).change;
    assertEquals(after.reviews.length, 1);
    assertEquals(after.reviews[0].verdict, "reject");
    assertEquals(after.reviews[0].summary, "Changed my mind");
    assertEquals(after.reviews[0].comments.length, 2);
  } finally {
    await b.dispose();
  }
});

radTest("issues: create, list, comment, close", async () => {
  const b = await bench();
  try {
    const created = await b.call("POST", `/v1/repos/${b.repo.rid}/issues`, {
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ title: "The widget squeaks", body: "Every time it turns." }),
    });
    assertEquals(created.status, 201);
    const issue: IssueView = (await created.json()).issue;
    assertEquals(issue.title, "The widget squeaks");
    assertEquals(issue.body, "Every time it turns.");
    assertEquals(issue.author.did, b.bot.did);
    assertEquals(issue.state, "open");
    assertEquals(issue.comments.length, 1);

    const commented = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/issues/${issue.id}/comments`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ body: "Also it is blue.", replyTo: issue.id }),
      },
    );
    assertEquals(commented.status, 201);

    const listed = await (await b.call("GET", `/v1/repos/${b.repo.rid}/issues`, {
      headers: AUTH,
    })).json();
    assertEquals(listed.total, 1);
    assertEquals(listed.issues[0].comments.length, 2);
    assertEquals(listed.issues[0].comments[1].replyTo, issue.id);

    // With no `replyTo` given — which is how every forge write arrives — the comment still
    // replies to the root. An orphan is legal in the COB and invisible in Radicle Desktop.
    const plain = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/issues/${issue.id}/comments`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ body: "And it is round." }),
      },
    );
    assertEquals(plain.status, 201);
    const reread = await (await b.call("GET", `/v1/repos/${b.repo.rid}/issues/${issue.id}`, {
      headers: AUTH,
    })).json();
    assertEquals(reread.issue.comments.length, 3);
    assertEquals(reread.issue.comments[2].replyTo, issue.id);

    // Our own issue: closeable without being a delegate.
    const closed = await b.call("POST", `/v1/repos/${b.repo.rid}/issues/${issue.id}/close`, {
      headers: AUTH,
    });
    assertEquals(closed.status, 200);
    assertEquals((await closed.json()).issue.state, "closed");

    assertEquals(
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/issues?state=open`, {
        headers: AUTH,
      })).json()).total,
      0,
    );
    assertEquals(
      (await (await b.call("GET", `/v1/repos/${b.repo.rid}/issues?state=closed`, {
        headers: AUTH,
      })).json()).total,
      1,
    );
  } finally {
    await b.dispose();
  }
});

radTest("a delegate-only action as a non-delegate is a typed 403, never a 500", async () => {
  const b = await bench();
  try {
    const issue: IssueView = (await (await b.call("POST", `/v1/repos/${b.repo.rid}/issues`, {
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ title: "Labelled?", body: "we shall see" }),
    })).json()).issue;

    const labelled = await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/issues/${issue.id}/labels`,
      {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ labels: ["bug"] }),
      },
    );
    assertEquals(labelled.status, 403);
    const body = await labelled.json();
    assertEquals(body.error, "forge_capability_unavailable");
    assertEquals(body.capability, "add_labels");
    assertStringIncludes(body.reason, "delegate");

    // And the same refusal at creation time, rather than a half-made issue.
    const withLabels = await b.call("POST", `/v1/repos/${b.repo.rid}/issues`, {
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope", body: "x", labels: ["bug"] }),
    });
    assertEquals(withLabels.status, 403);
    assertEquals((await withLabels.json()).capability, "create_issue.labels");
  } finally {
    await b.dispose();
  }
});

radTest("the git door serves the canonical refs and nothing else, read-only", async () => {
  const b = await bench();
  try {
    // Put something in a peer namespace that must NOT be advertised.
    const w = await work(b, "P.md", "p\n", "p", b.repo.head);
    await b.call(
      "POST",
      `/v1/repos/${b.repo.rid}/changes`,
      submitInit(await readFile(w.path), {
        title: "A patch",
        description: "",
        baseSha: w.base,
        headSha: w.head,
      }),
    );
    await w.dispose();

    const advertised = await b.call(
      "GET",
      `/v1/repos/${b.repo.rid}/git/info/refs?service=git-upload-pack`,
      { headers: AUTH },
    );
    assertEquals(advertised.status, 200);
    assertEquals(
      advertised.headers.get("content-type"),
      "application/x-git-upload-pack-advertisement",
    );
    const text = await advertised.text();
    assertStringIncludes(text, "# service=git-upload-pack");
    assertStringIncludes(text, "refs/heads/main");
    assertEquals(text.includes("refs/namespaces/"), false, "peer namespaces must not leak");
    assertEquals(text.includes("refs/cobs/"), false, "COB refs must not leak");
    assertEquals(text.includes("refs/rad/"), false, "rad internals must not leak");

    // receive-pack has no route at all — that is the read-only argument.
    const receive = await b.call(
      "GET",
      `/v1/repos/${b.repo.rid}/git/info/refs?service=git-receive-pack`,
      { headers: AUTH },
    );
    assertEquals(receive.status, 403);
    const noRoute = await b.call("POST", `/v1/repos/${b.repo.rid}/git/git-receive-pack`, {
      headers: AUTH,
    });
    assertEquals(noRoute.status, 404);
  } finally {
    await b.dispose();
  }
});

radTest("every route needs the bearer, and an unknown repository is a 404", async () => {
  const b = await bench();
  try {
    for (
      const [method, path] of [
        ["GET", "/v1/identity"],
        ["GET", `/v1/repos/${b.repo.rid}`],
        ["POST", `/v1/repos/${b.repo.rid}/seed`],
        ["GET", `/v1/repos/${b.repo.rid}/issues`],
        ["GET", `/v1/repos/${b.repo.rid}/git/info/refs?service=git-upload-pack`],
      ] as const
    ) {
      const res = await b.call(method, path);
      assertEquals(res.status, 401, `${method} ${path} should need a bearer`);
      await res.body?.cancel();
      const wrong = await b.call(method, path, { headers: { authorization: "Bearer nope" } });
      assertEquals(wrong.status, 401);
      await wrong.body?.cancel();
    }

    const unknown = await b.call("GET", "/v1/repos/rad:z4V14vdenmiCJQPkp9347PXnNUaXX", {
      headers: AUTH,
    });
    assertEquals(unknown.status, 404);

    const malformed = await b.call("GET", "/v1/repos/not-a-rid", { headers: AUTH });
    assertEquals(malformed.status, 400);

    const missing = await b.call(
      "GET",
      `/v1/repos/${b.repo.rid}/changes/${"0".repeat(40)}`,
      { headers: AUTH },
    );
    assertEquals(missing.status, 404);
  } finally {
    await b.dispose();
  }
});

radTest("a real `git clone` through the door gets the canonical history", async () => {
  const b = await bench();
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    b.handler,
  );
  const target = await tempDir("clone");
  try {
    const url = `http://127.0.0.1:${server.addr.port}/v1/repos/${b.repo.rid}/git`;
    // The bearer rides `http.extraheader`, the same seam the forge's gateway uses — never a
    // credentialed URL, which would land in the clone's .git/config.
    const cloned = await command("git", {
      args: [
        "-c",
        `http.extraheader=Authorization: Bearer ${TOKEN}`,
        "clone",
        "--quiet",
        url,
        `${target.path}/repo`,
      ],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      cloned.code,
      0,
      `clone failed: ${new TextDecoder().decode(cloned.stderr)}`,
    );
    assertEquals(await readFile(`${target.path}/repo/README.md`, "utf8"), "hello\n");

    const refs = await command("git", {
      args: ["-C", `${target.path}/repo`, "for-each-ref", "--format=%(refname)"],
      stdout: "piped",
    }).output();
    const listed = new TextDecoder().decode(refs.stdout);
    assertEquals(listed.includes("refs/namespaces/"), false);
    assertEquals(listed.includes("refs/cobs/"), false);

    // And the door refuses an unauthenticated clone rather than serving it.
    const anonymous = await command("git", {
      args: ["clone", "--quiet", url, `${target.path}/anon`],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(anonymous.code === 0, false);
  } finally {
    await server.shutdown();
    await target.dispose();
    await b.dispose();
  }
});

radTest(
  "the door serves an older revision's head by id, though no ref it advertises holds it",
  async () => {
    // What the forge's merge containment fetches: a merge may take an OLDER revision of a change
    // request, and the commit that merged is then one the door names under no ref — the change
    // request's exported head is the latest revision's, and the canonical branch may not have
    // moved in our storage yet. Here the second revision is rebased, so not even the latest
    // head's history holds the first. Storage keeps it all the same: heartwood makes every
    // revision's head (and every merge's commit) a parent of the op that records it, so the
    // change request's own object holds it reachable, and git's gc never takes it.
    const b = await bench();
    const server = await serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, b.handler);
    const target = await tempDir("by-id");
    const git = async (args: string[]) => {
      const out = await command("git", {
        args,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
    };
    try {
      const first = await work(b, "FEATURE.md", "one\n", "add the feature", b.repo.head);
      const opened = await (await b.call(
        "POST",
        `/v1/repos/${b.repo.rid}/changes`,
        submitInit(await readFile(first.path), {
          title: "Add the feature",
          description: "First.",
          baseSha: first.base,
          headSha: first.head,
        }),
      )).json();
      await first.dispose();
      // Back to the base, and a second revision that does not descend from the first.
      const reset = await b.maintainer.exec.git(b.repo.workDir, [
        "reset",
        "--hard",
        "--quiet",
        b.repo.head,
      ]);
      assertEquals(reset.code, 0, reset.stderr);
      const second = await work(b, "OTHER.md", "two\n", "another take", b.repo.head);
      const revised = await b.call(
        "POST",
        `/v1/repos/${b.repo.rid}/changes`,
        submitInit(await readFile(second.path), {
          title: "Add the feature",
          description: "Rebased.",
          baseSha: second.base,
          headSha: second.head,
          changeRef: opened.ref,
        }),
      );
      assertEquals(revised.status, 200);
      await second.dispose();

      const url = `http://127.0.0.1:${server.addr.port}/v1/repos/${b.repo.rid}/git`;
      const auth = `http.extraheader=Authorization: Bearer ${TOKEN}`;
      assertEquals((await git(["init", "--quiet", "--bare", `${target.path}/cache`])).code, 0);
      // The advertisement holds the latest head under the change request's name, never the
      // first revision's.
      const advertised = await command("git", {
        args: ["-c", auth, "ls-remote", url],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const listed = new TextDecoder().decode(advertised.stdout);
      assertStringIncludes(listed, `${second.head}\trefs/heads/patches/${opened.ref}`);
      assertEquals(listed.includes(first.head), false);

      // Fetched by id, with no destination — exactly the forge cache's `ensureCommit`.
      const fetched = await git([
        "-C",
        `${target.path}/cache`,
        "-c",
        auth,
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--",
        url,
        first.head,
      ]);
      assertEquals(fetched.code, 0, `fetch by id failed: ${fetched.stderr}`);
      const held = await git([
        "-C",
        `${target.path}/cache`,
        "cat-file",
        "-e",
        `${first.head}^{commit}`,
      ]);
      assertEquals(held.code, 0, "the first revision's head is in the cache");
      // And the whole history under it came along: the base is its ancestor there.
      const ancestor = await git([
        "-C",
        `${target.path}/cache`,
        "merge-base",
        "--is-ancestor",
        b.repo.head,
        first.head,
      ]);
      assertEquals(ancestor.code, 0);

      // An id storage never held is git's "not our ref", which the cache reads as missing.
      const missing = await git([
        "-C",
        `${target.path}/cache`,
        "-c",
        auth,
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--",
        url,
        "1".repeat(40),
      ]);
      assertEquals(missing.code === 0, false);
      assertStringIncludes(missing.stderr, "not our ref");
    } finally {
      await server.shutdown();
      await target.dispose();
      await b.dispose();
    }
  },
);

radTest(
  "a bundle over the cap is refused WHILE it streams, never after it is buffered",
  async () => {
    // One kilobyte, so a body that is merely large is already over it.
    const b = await bench({ maxBundleBytes: 1024 });
    try {
      // The body never ends: it hands over one chunk past the cap and then waits forever. A
      // route that called `formData()` — or anything else that reads to the end before it
      // measures — would hang here rather than answer, which is the whole point of the
      // finding. `answered` resolving at all is the assertion.
      let stop!: () => void;
      const hung = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const boundary = "cap-boundary";
      const encoder = new TextEncoder();
      const head = encoder.encode(
        `--${boundary}\r\ncontent-disposition: form-data; name="meta"\r\n\r\n` +
          `${JSON.stringify({ title: "t", description: "d", baseSha: "a", headSha: "b" })}\r\n` +
          `--${boundary}\r\n` +
          `content-disposition: form-data; name="bundle"; filename="x.bundle"\r\n\r\n`,
      );
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 0) {
            controller.enqueue(head);
            sent = 1;
            return;
          }
          if (sent < 40) {
            controller.enqueue(new Uint8Array(256));
            sent++;
            return;
          }
          // Past the cap and still going. Nothing will ever close this.
          await hung;
        },
      });
      const res = await b.call("POST", `/v1/repos/${encodeURIComponent(b.repo.rid)}/changes`, {
        headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
      stop();
      assertEquals(res.status, 413);
      assertStringIncludes((await res.json()).error, "exceeds 1024 bytes");

      // And a body that ANNOUNCES too much is refused without reading a byte of it.
      const announced = await b.call(
        "POST",
        `/v1/repos/${encodeURIComponent(b.repo.rid)}/changes`,
        {
          headers: {
            ...AUTH,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(1024 * 1024 * 1024),
          },
          body: new Uint8Array(0) as unknown as BodyInit,
        },
      );
      assertEquals(announced.status, 413);

      // Nothing was spooled: every refusal deletes the file it opened.
      const spooled: string[] = [];
      for (const entry of await readdir(`${b.scratchDir}`, { withFileTypes: true })) {
        spooled.push(
          entry.name,
        );
      }
      assertEquals(spooled, []);
    } finally {
      await b.dispose();
    }
  },
);

radTest("upload-pack holds the repository's lock until the pack has been written", async () => {
  const b = await bench();
  const rid = encodeURIComponent(b.repo.rid);
  try {
    // Advertise once, so a mirror exists and the pack request is the only lock holder.
    const advertised = await b.call(
      "GET",
      `/v1/repos/${rid}/git/info/refs?service=git-upload-pack`,
      {
        headers: AUTH,
      },
    );
    assertEquals(advertised.status, 200);

    // A pack request whose body does not end until `stop`: `upload-pack` is spawned, the
    // response is returned, and the lock is the thing under test — it must still be held. The
    // body is half a pkt-line, so upload-pack is still reading it rather than already done: a
    // child that has exited ends the pump too, and with it the response.
    let stop!: () => void;
    const hung = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let sent = false;
    const pack = await b.call("POST", `/v1/repos/${rid}/git/git-upload-pack`, {
      headers: { ...AUTH, "content-type": "application/x-git-upload-pack-request" },
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("0032want "));
            return;
          }
          await hung;
          controller.close();
        },
      }),
    });
    assertEquals(pack.status, 200);

    // A second client's advertisement REWRITES the mirror's refs in place. While the pack
    // above is being served out of that directory it must not get to.
    let rewrote = false;
    const second = b.call("GET", `/v1/repos/${rid}/git/info/refs?service=git-upload-pack`, {
      headers: AUTH,
    }).then((res) => {
      rewrote = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(rewrote, false, "the advertisement ran while a pack was being served");

    // Let the pack finish; the advertisement then goes through.
    stop();
    await pack.body?.cancel();
    assertEquals((await second).status, 200);
  } finally {
    await b.dispose();
  }
});

radTest(
  "the identity is re-read when the key on disk changes, not remembered for the process",
  async () => {
    const b = await bench();
    try {
      const before = await (await b.call("GET", "/v1/identity", { headers: AUTH })).json();
      assertEquals(before.did, b.bot.did);

      // A rotated key, or a pod that came back with a restored volume holding a different one.
      // The own-NID filter on the event consumer is the only thing standing between a comment
      // ryph posted and ryph answering it — so a DID cached for the life of the process is not
      // a cache, it is an assumption that this cannot happen.
      for (const name of ["radicle", "radicle.pub"]) {
        await copyFile(`${b.maintainer.home}/keys/${name}`, `${b.bot.home}/keys/${name}`);
      }

      const after = await (await b.call("GET", "/v1/identity", { headers: AUTH })).json();
      assertEquals(after.did, b.maintainer.did);
      assertEquals(after.nid, b.maintainer.nid);
    } finally {
      await b.dispose();
    }
  },
);

// ── the git door's freshness gate ─────────────────────────────────────────────────────────
//
// A clone's `info/refs` asks the network first — unless somebody asked within the window. The
// fake node is the network here: `seedsFor` names one connected holder, `fetch` answers as told,
// and the REAL `rad sync` runs against it, so what is counted below is what the CLI sent.

const HOLDER = "z6MkjM3HpqNVV4ZsL5s3RAd8ThVG3VG98YsDCjHBNnGMq5o7";
const HOLDER_ADDR = "seed.example.com:8776";
const connectedHolder = {
  nid: HOLDER,
  addrs: [{
    addr: HOLDER_ADDR,
    source: "peer",
    lastSuccess: null,
    lastAttempt: null,
    banned: false,
  }],
  state: { connected: { since: 1 } },
};
const holderSession = {
  nid: HOLDER,
  link: "outbound",
  addr: HOLDER_ADDR,
  state: { connected: { since: 1 } },
};

const advertise = (b: Bench) =>
  b.call("GET", `/v1/repos/${b.repo.rid}/git/info/refs?service=git-upload-pack`, { headers: AUTH });
const fetches = (b: Bench) => b.nodeCommands().filter((c) => c.command === "fetch").length;

radTest(
  "a clone inside the fresh window is served from storage without asking the network",
  async () => {
    let clock = 1_000_000;
    const b = await bench({
      fetchBeforeAdvertise: true,
      seeds: [connectedHolder],
      network: { sessions: [holderSession], freshMs: 60_000, now: () => clock },
    });
    try {
      let res = await advertise(b);
      assertEquals(res.status, 200);
      await res.text();
      assertEquals(fetches(b), 1, "the first clone asks the network");

      clock += 59_000;
      res = await advertise(b);
      assertEquals(res.status, 200);
      await res.text();
      assertEquals(fetches(b), 1, "a clone inside the window does not ask again");

      clock += 2_000;
      res = await advertise(b);
      assertEquals(res.status, 200);
      await res.text();
      assertEquals(fetches(b), 2, "past the window the network is asked again");
    } finally {
      await b.dispose();
    }
  },
);

radTest("the pull's fetch is what a clone trusts", async () => {
  const b = await bench({
    fetchBeforeAdvertise: true,
    seeds: [connectedHolder],
    network: { sessions: [holderSession], freshMs: 60_000, now: () => 1_000_000 },
  });
  try {
    // The pull loop calls exactly this; a run's N clones then land on the refs it brought.
    await b.service.fetchFromNetwork(b.repo.rid, 5_000);
    assertEquals(fetches(b), 1);
    const res = await advertise(b);
    assertEquals(res.status, 200);
    await res.text();
    assertEquals(fetches(b), 1, "the clone rode the pull's fetch");
  } finally {
    await b.dispose();
  }
});

radTest(
  "a clone is answered within the fetch budget even when the node never answers the fetch",
  async () => {
    const b = await bench({
      fetchBeforeAdvertise: true,
      seeds: [connectedHolder],
      network: { sessions: [holderSession], freshMs: 0, now: () => 1_000_000, stallFetches: true },
    });
    try {
      // The forge's services-file read waits 10 s for this whole answer, so the budget
      // (1 s here) has to bound it, not the budget plus the pull's grace.
      const started = performance.now();
      const res = await advertise(b);
      assertEquals(res.status, 200, "storage still answers");
      await res.text();
      const tookMs = performance.now() - started;
      assert(tookMs < 2_500, `the clone waited ${Math.round(tookMs)} ms on a 1 s budget`);
    } finally {
      await b.dispose();
    }
  },
);

radTest("a fetch that was refused does not count as fresh", async () => {
  const b = await bench({
    fetchBeforeAdvertise: true,
    seeds: [connectedHolder],
    network: {
      sessions: [holderSession],
      freshMs: 60_000,
      now: () => 1_000_000,
      fetchResults: { [HOLDER]: { status: "failed", reason: "connection reset" } },
    },
  });
  try {
    for (const attempt of [1, 2]) {
      const res = await advertise(b);
      assertEquals(res.status, 200, "storage still answers");
      await res.text();
      assertEquals(fetches(b), attempt, "every clone asks again until a fetch lands");
    }
  } finally {
    await b.dispose();
  }
});

radTest(
  "an issue's embeds are listed on its comments and served from storage, and nothing else",
  async () => {
    const b = await bench();
    try {
      const rid = encodeURIComponent(b.repo.rid);
      const opened = await (await b.call("POST", `/v1/repos/${rid}/issues`, {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ title: "Broken page", body: "It breaks." }),
      })).json();
      const id: string = opened.issue.id;

      // A comment with two embeds, written the way Radicle Desktop writes one: the blob is
      // stored with the op (`--embed-file`) and the body links it by its oid.
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const big = new Uint8Array(5 * 1024 * 1024 + 1);
      const dir = await tempDir("embeds");
      try {
        await writeFile(`${dir.path}/shot.png`, png);
        await writeFile(`${dir.path}/big.png`, big);
        const oidOf = async (path: string) =>
          (await b.bot.exec.git(dir.path, ["hash-object", path])).stdout.trim();
        const shot = await oidOf(`${dir.path}/shot.png`);
        const huge = await oidOf(`${dir.path}/big.png`);
        await writeFile(
          `${dir.path}/op.jsonl`,
          JSON.stringify({
            type: "comment",
            body: `like this [shot.png](${shot})`,
            replyTo: id,
            embeds: [
              { name: "shot.png", content: `git:${shot}` },
              { name: "big.png", content: `git:${huge}` },
            ],
          }) + "\n",
        );
        const update = await b.bot.exec.rad([
          "cob",
          "update",
          "--repo",
          b.repo.rid,
          "--type",
          "xyz.radicle.issue",
          "--object",
          id,
          "--message",
          "Comment",
          "--embed-file",
          "shot.png",
          `${dir.path}/shot.png`,
          "--embed-file",
          "big.png",
          `${dir.path}/big.png`,
          `${dir.path}/op.jsonl`,
        ]);
        assertEquals(update.code, 0, update.stderr);

        const issue: IssueView = (await (await b.call("GET", `/v1/repos/${rid}/issues/${id}`, {
          headers: AUTH,
        })).json()).issue;
        assertEquals(issue.comments[1].embeds, [
          { name: "shot.png", oid: shot },
          { name: "big.png", oid: huge },
        ]);
        // The opening post embeds nothing, and says so by saying nothing.
        assertEquals(issue.comments[0].embeds, undefined);

        const served = await b.call("GET", `/v1/repos/${rid}/issues/${id}/embeds/${shot}`, {
          headers: AUTH,
        });
        assertEquals(served.status, 200);
        const embed = (await served.json()).embed;
        assertEquals(embed.name, "shot.png");
        assertEquals(Uint8Array.fromBase64(embed.data), png);

        // Over the cap: measured before it is read, refused as too large.
        const tooBig = await b.call("GET", `/v1/repos/${rid}/issues/${id}/embeds/${huge}`, {
          headers: AUTH,
        });
        assertEquals(tooBig.status, 413);
        await tooBig.body?.cancel();

        // A blob that IS in storage but that the issue does not embed — the repository's own
        // README — is not this route's to serve.
        const readme = (await b.bot.exec.git(b.bot.exec.storageDir(b.repo.rid), [
          "rev-parse",
          `${b.repo.head}:README.md`,
        ])).stdout.trim();
        const stray = await b.call("GET", `/v1/repos/${rid}/issues/${id}/embeds/${readme}`, {
          headers: AUTH,
        });
        assertEquals(stray.status, 404);
        await stray.body?.cancel();

        const malformed = await b.call("GET", `/v1/repos/${rid}/issues/${id}/embeds/nope`, {
          headers: AUTH,
        });
        assertEquals(malformed.status, 400);
        await malformed.body?.cancel();
      } finally {
        await dir.dispose();
      }
    } finally {
      await b.dispose();
    }
  },
);

/** The git blob id of `bytes` — what the forge links an embed by, computed the way the forge
 * computes it (core/images.ts there), so a test fails if the two sides ever disagree. */
async function blobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const whole = new Uint8Array(header.length + bytes.length);
  whole.set(header, 0);
  whole.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", whole);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

radTest(
  "an issue whose files cannot be attached is closed, and the write refused for good",
  async () => {
    let failEmbeds = 0;
    const b = await bench({
      // Every `rad cob update` that attaches the description's files fails, as a full disk or a
      // killed process would.
      wrapExec: (exec) => ({
        home: exec.home,
        socket: exec.socket,
        storageDir: (rid) => exec.storageDir(rid),
        git: (cwd, args, o) => exec.git(cwd, args, o),
        radJob: (args, o) => exec.radJob(args, o),
        rad: (args, o) => {
          if (args[0] === "cob" && args.includes("Embed files")) {
            failEmbeds++;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "error: disk full",
              timedOut: false,
            });
          }
          return exec.rad(args, o);
        },
      }),
    });
    try {
      const rid = encodeURIComponent(b.repo.rid);
      const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
      const shotOid = await blobOid(shot);
      const opened = await b.call("POST", `/v1/repos/${rid}/issues`, {
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Broken page",
          body: `It breaks: [the page](${shotOid}) <!-- ryph-write:fa-1 -->`,
          embeds: [{ name: "img-aaaaaaaaaaaa.png", data: shot.toBase64() }],
        }),
      });
      // A 4xx: the forge settles it as failed, and never goes looking for the issue it opened.
      assertEquals(opened.status, 409);
      const { error } = await opened.json();
      assertStringIncludes(error, "its files could not be attached, so it was closed");
      assertStringIncludes(error, "disk full");
      assertEquals(failEmbeds, 2, "tried once more before giving up");

      // Nothing left open for the forge's lost-write recovery to find and call written.
      const total = async (state: string) =>
        (await (await b.call("GET", `/v1/repos/${rid}/issues?state=${state}`, { headers: AUTH }))
          .json()).total;
      assertEquals(await total("open"), 0);
      assertEquals(await total("closed"), 1);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "writes carry embeds: stored as blobs, named on the action, and in the op's own tree",
  async () => {
    const b = await bench();
    try {
      const rid = encodeURIComponent(b.repo.rid);
      const json = (body: unknown): RequestInit => ({
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
      const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
      const shotOid = await blobOid(shot);
      const otherOid = await blobOid(other);
      const wire = (name: string, bytes: Uint8Array) => ({ name, data: bytes.toBase64() });
      const storage = b.bot.exec.storageDir(b.repo.rid);
      /** The files an op's commit carries under `embeds/`, as `name oid`. */
      const opTree = async (op: string) =>
        (await b.bot.exec.git(storage, ["ls-tree", "-r", op])).stdout.split("\n")
          .filter((l) => l.includes("\tembeds/"))
          .map((l) => `${l.split("\t")[1].slice("embeds/".length)} ${l.split(/\s+/)[2]}`);

      // An issue whose description shows an image: `rad issue open` takes no files, so the
      // opening comment is edited to carry it.
      const opened = await b.call(
        "POST",
        `/v1/repos/${rid}/issues`,
        json({
          title: "Broken page",
          body: `It breaks: [the page](${shotOid})`,
          embeds: [wire("img-aaaaaaaaaaaa.png", shot)],
        }),
      );
      assertEquals(opened.status, 201);
      const issue: IssueView = (await opened.json()).issue;
      assertEquals(issue.body, `It breaks: [the page](${shotOid})`);
      assertEquals(issue.comments[0].embeds, [{ name: "img-aaaaaaaaaaaa.png", oid: shotOid }]);

      // A comment with an embed; the op that wrote it carries the blob.
      const commented = await b.call(
        "POST",
        `/v1/repos/${rid}/issues/${issue.id}/comments`,
        json({ body: `after: [x](${otherOid})`, embeds: [wire("img-bbbbbbbbbbbb.png", other)] }),
      );
      assertEquals(commented.status, 201);
      const commentId: string = (await commented.json()).comment.id;
      assertEquals(await opTree(commentId), [`img-bbbbbbbbbbbb.png ${otherOid}`]);
      const served = await b.call(
        "GET",
        `/v1/repos/${rid}/issues/${issue.id}/embeds/${otherOid}`,
        { headers: AUTH },
      );
      assertEquals(Uint8Array.fromBase64((await served.json()).embed.data), other);

      // An edit replaces the files as it replaces the text.
      const edited = await b.call(
        "PATCH",
        `/v1/repos/${rid}/issues/${issue.id}/comments/${commentId}`,
        json({ body: `now: [y](${shotOid})`, embeds: [wire("img-aaaaaaaaaaaa.png", shot)] }),
      );
      assertEquals(edited.status, 200);
      const after: IssueView = (await (await b.call("GET", `/v1/repos/${rid}/issues/${issue.id}`, {
        headers: AUTH,
      })).json()).issue;
      assertEquals(after.comments[1].embeds, [{ name: "img-aaaaaaaaaaaa.png", oid: shotOid }]);

      // A change request whose description, and whose review's summary, show images.
      const w = await work(b, "src.ts", "line one\n", "add src", b.repo.head);
      const change = await (await b.call(
        "POST",
        `/v1/repos/${rid}/changes`,
        submitInit(await readFile(w.path), {
          title: "With a screenshot",
          description: `Before: [before](${shotOid})`,
          baseSha: w.base,
          headSha: w.head,
          embeds: [wire("img-aaaaaaaaaaaa.png", shot)],
        }),
      )).json();
      await w.dispose();
      const reviewed = await b.call(
        "POST",
        `/v1/repos/${rid}/changes/${change.ref}/reviews`,
        json({
          summary: `See [after](${otherOid})`,
          summaryEmbeds: [wire("img-bbbbbbbbbbbb.png", other)],
        }),
      );
      assertEquals(reviewed.status, 201);
      const read: ChangeView =
        (await (await b.call("GET", `/v1/repos/${rid}/changes/${change.ref}`, {
          headers: AUTH,
        })).json()).change;
      const revision = read.revisions[read.revisions.length - 1];
      assertEquals(revision.description, `Before: [before](${shotOid})`);
      assertEquals(revision.embeds, [{ name: "img-aaaaaaaaaaaa.png", oid: shotOid }]);
      assertEquals(read.reviews.length, 1);
      assertEquals(read.reviews[0].summary, `See [after](${otherOid})`);
      assertEquals(read.reviews[0].summaryEmbeds, [
        { name: "img-bbbbbbbbbbbb.png", oid: otherOid },
      ]);

      // A name that could be read as a flag, or a path, never reaches the CLI.
      const refused = await b.call(
        "POST",
        `/v1/repos/${rid}/issues/${issue.id}/comments`,
        json({ body: "x", embeds: [wire("--repo", shot)] }),
      );
      assertEquals(refused.status, 400);
      await refused.body?.cancel();
    } finally {
      await b.dispose();
    }
  },
);
