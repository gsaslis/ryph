// User mode, against the real `rad`: the bridge acting AS a person, over their own profile, which
// holds more than ryph has any business with.
//
// The cast: `me` is the person — their identity is the bridge's, and their storage holds `mine`
// (a repository they made, so their node already seeds it) and `theirs` (a stranger's, sitting in
// storage with no seeding policy, as one does after a `rad clone` that was later unseeded).
//
// What is pinned here, rule by rule:
// - nothing is in scope until it is connected: every route, the git door and the consumer
// - connecting a repository the node seeds leaves its policy alone; one it does not seed gets a
//   policy, and only that one is removed on disconnect
// - the person's own merge, announced by their node, arrives without waiting for the timer —
//   and their own comments still never do
// - a repository the person BLOCKED is refused, and the block is left exactly as it was
// - disconnecting takes a repository out of scope at once and forgets its cursors and mirror;
//   a policy the node could not remove then is removed once it can
// - no `change_request.pushed`, from anybody: there are no checks here
//
// The bridge runs `rad` and `git` exactly as `startRadicle` sets them up in user mode — git
// confined to `file` and `rad`, an ssh-agent socket in the environment — so every write below
// also proves nothing it does needs more than that.

import { test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setup } from "../src/setup.ts";
import { makeRadicleService } from "../src/core/service.ts";
import { makeRouter } from "@ryph/shared/http";
import { socketNodeControl } from "../src/adapters/node/socket.ts";
import { cliRadExec } from "../src/adapters/rad/cli.ts";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { memoryCursorStore } from "../src/adapters/cursor_store/memory.ts";
import { memoryTrackedRepos } from "../src/adapters/tracked_repos/memory.ts";
import { recordingEventSink } from "../src/adapters/event_sink/recording.ts";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import { type NodeControl, type NodeEvent, NodeUnavailableError } from "../src/ports/node.ts";
import type { CursorStore } from "../src/ports/cursor_store.ts";
import type { RadExec } from "../src/ports/rad.ts";
import type { TrackedRepo, TrackedRepoStore } from "../src/ports/tracked_repos.ts";
import {
  commit,
  initRepo,
  makeBundle,
  makePeer,
  type Peer,
  pullRefs,
  RAD_MISSING,
  RAD_SKIP_REASON,
  radBinDir,
  seedFrom,
  socketPath,
  tempDir,
  type TestRepo,
} from "./util.ts";

const TOKEN = "a-test-service-token";
/** What a forge told the bridge's mode presents: a user-mode bridge seeds for nothing else. */
const AUTH = { authorization: `Bearer ${TOKEN}`, "x-ryph-radicle-mode": "user" };
const radTest = test.skipIf(RAD_MISSING);

interface Bench {
  me: Peer;
  stranger: Peer;
  mine: TestRepo;
  theirs: TestRepo;
  tracked: TrackedRepoStore;
  cursors: CursorStore;
  /** Where the git door keeps its mirrors. */
  exportDir: string;
  /** Takes the node away (every call fails as an unreachable socket would), or brings it back. */
  nodeDown(down: boolean): void;
  sink: ReturnType<typeof recordingEventSink>;
  bridge: ReturnType<typeof setup>;
  call(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** Every command the node was sent, by name, in order. */
  nodeCommands(): string[];
  dispose(): Promise<void>;
}

async function bench(
  opts: {
    tracked?: TrackedRepo[];
    /** Stands between the bridge and its `rad`, to make one command answer something else. */
    wrapExec?: (exec: RadExec) => RadExec;
  } = {},
): Promise<Bench> {
  const sock = await socketPath();
  const me = await makePeer("me", sock.path);
  const stranger = await makePeer("stranger");
  const mine = await initRepo(me, { name: "mine" });
  const theirs = await initRepo(stranger, { name: "theirs" });
  await seedFrom(stranger, me, theirs.rid);
  // …and then not seeded any more: in storage, with no policy, as after a `rad unseed`.
  const unseeded = await me.exec.rad(["unseed", theirs.rid], { env: { RAD_SOCKET: "/dev/null" } });
  assertEquals(unseeded.code, 0, unseeded.stderr);

  const fake = startFakeNode({ path: sock.path, nid: me.nid });
  const data = await tempDir("user-mode-data");
  const tracked = memoryTrackedRepos(opts.tracked);
  const cursors = memoryCursorStore();
  const sink = recordingEventSink();
  const real = socketNodeControl({ socket: sock.path });
  let down = false;
  // The fake answers the policy commands and keeps nothing; a real node writes them to its
  // policy table, which is what `rad seed` lists — so this writes them there too.
  const policyTable = (args: string[]) =>
    me.exec.rad(args, { env: { RAD_SOCKET: "/dev/null" } }).then(() => {});
  const node = new Proxy(real, {
    get: (target, key) => {
      const value = Reflect.get(target, key);
      if (typeof value !== "function" || key === "subscribe") return value;
      return async (...args: unknown[]) => {
        if (down) throw new NodeUnavailableError(sock.path, "the node is down");
        const answer = await value.apply(target, args);
        const rid = String(args[0]);
        if (key === "seed") {
          await policyTable(["seed", rid, "--scope", String(args[1]), "--no-fetch"]);
        }
        if (key === "unseed") await policyTable(["unseed", rid]);
        return answer;
      };
    },
  }) as NodeControl;
  const bridge = setup({
    mode: "user",
    tracked,
    exec: (opts.wrapExec ?? ((e) => e))(cliRadExec({
      home: me.home,
      passphrase: "",
      binDir: radBinDir(),
      socket: sock.path,
      gitProtocols: "file:rad",
      agentSocket: `${data.path}/no-agent.sock`,
    })),
    node,
    cursors,
    sink,
    diag: SILENT_DIAGNOSTICS,
    token: TOKEN,
    // A seed of a repository the node did not hold would wait on a network nobody serves.
    fetchTimeoutMs: 1_000,
    reconcileIntervalMs: 3_600_000,
    config: {
      exportDir: `${data.path}/export`,
      scratchDir: `${data.path}/scratch`,
      maxBundleBytes: 50 * 1024 * 1024,
      maxUploadPackBytes: 1024 * 1024,
      fetchBeforeAdvertise: false,
      gitFetchTimeoutMs: 1_000,
      gitFetchFreshMs: 0,
    },
  });
  await mkdir(`${data.path}/scratch`, { recursive: true });
  const router = makeRouter(bridge.routes);
  return {
    me,
    stranger,
    mine,
    theirs,
    tracked,
    cursors,
    exportDir: `${data.path}/export`,
    nodeDown: (value) => {
      down = value;
    },
    sink,
    bridge,
    call: (method, path, init) =>
      router(new Request(`http://bridge${path}`, { method, headers: AUTH, ...init })),
    nodeCommands: () => fake.commands.map((c) => String(c.command)),
    async dispose() {
      await bridge.consumer.stop();
      await fake.close();
      await sock.dispose();
      await data.dispose();
      await me.dispose();
      await stranger.dispose();
      for (const r of [mine, theirs]) {
        await rm(r.workDir, { recursive: true }).catch(() => {});
      }
    },
  };
}

const seg = (rid: string) => encodeURIComponent(rid);

async function policyOf(peer: Peer, rid: string): Promise<string> {
  return (await peer.exec.rad(["inspect", rid, "--policy"])).stdout.trim();
}

/** The person's own `rad seed` listing — the policy rows as they wrote them. */
async function policies(peer: Peer): Promise<string> {
  return (await peer.exec.rad(["seed"], { env: { RAD_SOCKET: "/dev/null" } })).stdout;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

radTest(`nothing on the node is in scope until it is connected [${RAD_SKIP_REASON}]`, async () => {
  const b = await bench();
  try {
    for (
      const path of [
        `/v1/repos/${seg(b.mine.rid)}`,
        `/v1/repos/${seg(b.mine.rid)}/issues`,
        `/v1/repos/${seg(b.mine.rid)}/changes`,
        `/v1/repos/${seg(b.mine.rid)}/git/info/refs?service=git-upload-pack`,
      ]
    ) {
      const res = await b.call("GET", path);
      assertEquals(res.status, 404, path);
      assertStringIncludes((await res.json()).error, "not a repository connected to ryph");
    }
    // The consumer walks the tracked set, and a fetch the node made of anything else is not
    // the bridge's business either.
    assertEquals(await b.bridge.service.seededRepos(), []);
    assertEquals(await b.bridge.consumer.reconcile(), 0);
    assertEquals(
      await b.bridge.consumer.handle({
        type: "refsFetched",
        remote: b.me.nid,
        rid: b.mine.rid,
        updated: [],
      }),
      0,
    );
    // The identity is not a repository, and needs no connecting — and says whose node it is.
    const self = await b.call("GET", "/v1/identity");
    assertEquals(self.status, 200);
    assertEquals((await self.json()).mode, "user");
  } finally {
    await b.dispose();
  }
});

radTest(
  "connecting a repository the node already seeds tracks it and leaves the policy alone",
  async () => {
    const b = await bench();
    try {
      assertStringIncludes(await policyOf(b.me, b.mine.rid), "is being seeded with scope `all`");

      const seeded = await b.call("POST", `/v1/repos/${seg(b.mine.rid)}/seed`);
      assertEquals(seeded.status, 200);
      assertEquals((await seeded.json()).rid, b.mine.rid);
      assertEquals(b.nodeCommands().includes("seed"), false);
      assertEquals((await b.tracked.get(b.mine.rid))?.createdPolicy, false);

      // Now it is served, and only it.
      assertEquals((await b.call("GET", `/v1/repos/${seg(b.mine.rid)}`)).status, 200);
      assertEquals((await b.call("GET", `/v1/repos/${seg(b.theirs.rid)}`)).status, 404);
      const refs = await b.call(
        "GET",
        `/v1/repos/${seg(b.mine.rid)}/git/info/refs?service=git-upload-pack`,
      );
      assertEquals(refs.status, 200);
      await refs.body?.cancel();
      assertEquals(await b.bridge.service.seededRepos(), [b.mine.rid]);

      // Disconnecting forgets it, and the node's policy is still the person's.
      const unseeded = await b.call("DELETE", `/v1/repos/${seg(b.mine.rid)}/seed`);
      assertEquals(await unseeded.json(), { unseeded: false });
      assertEquals(b.nodeCommands().includes("unseed"), false);
      assertEquals(await b.tracked.get(b.mine.rid), null);
      assertEquals((await b.call("GET", `/v1/repos/${seg(b.mine.rid)}`)).status, 404);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "connecting one the node does not seed writes a policy, and only that one is removed",
  async () => {
    const b = await bench();
    try {
      assertStringIncludes(await policyOf(b.me, b.theirs.rid), "is not being seeded");

      const seeded = await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`);
      assertEquals(seeded.status, 200);
      assertEquals(b.nodeCommands().filter((c) => c === "seed").length, 1);
      assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);

      // The node now holds the policy ryph asked for (the fake keeps nothing, so write it as the
      // node would). A second connect finds it — and still knows whose it is.
      await b.me.exec.rad(["seed", b.theirs.rid, "--no-fetch"], {
        env: { RAD_SOCKET: "/dev/null" },
      });
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
      assertEquals(b.nodeCommands().filter((c) => c === "seed").length, 1);
      assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);

      const unseeded = await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`);
      assertEquals(await unseeded.json(), { unseeded: true });
      assertEquals(b.nodeCommands().filter((c) => c === "unseed").length, 1);
      assertEquals(await b.tracked.get(b.theirs.rid), null);
    } finally {
      await b.dispose();
    }
  },
);

radTest("the person's own merge, announced by their node, arrives without the timer", async () => {
  const b = await bench();
  try {
    assertEquals((await b.call("POST", `/v1/repos/${seg(b.mine.rid)}/seed`)).status, 200);
    // ryph, as the person, opens a patch on their repository.
    const head = await commit(b.me, b.mine.workDir, "F.md", "one\n", "the work");
    const dir = await tempDir("bundle");
    const bundlePath = `${dir.path}/out.bundle`;
    await makeBundle(b.me, b.mine.workDir, b.mine.head, head, bundlePath);
    const submitted = await b.bridge.service.submitChange(b.mine.rid, {
      bundlePath,
      title: "The work",
      description: "Please look at this.",
      baseSha: b.mine.head,
      headSha: head,
    });
    await dir.dispose();
    assertEquals(await b.bridge.consumer.reconcile(), 0); // first sight

    // The person comments on it themselves. Their own words are never news — that is what
    // keeps `/ryph` commands out of user mode.
    await b.bridge.service.addComment(b.mine.rid, "change", submitted.ref, {
      body: "/ryph do the thing",
    });
    const announced: NodeEvent = {
      type: "localRefsAnnounced",
      // Spelled without its `rad:`, which the consumer must not mistake for another repository.
      rid: b.mine.rid.slice("rad:".length),
      refs: { remote: b.me.nid, at: "0".repeat(40) },
      timestamp: Date.now(),
    };
    assertEquals(await b.bridge.consumer.handle(announced), 0);
    assertEquals(b.sink.events, []);

    // …and merges it on their own node, by pushing its head onto the default branch.
    const pushed = await b.me.exec.git(b.mine.workDir, [
      "push",
      "-o",
      "no-sync",
      "rad",
      `${head}:refs/heads/${b.mine.defaultBranch}`,
    ]);
    assertEquals(pushed.code, 0, pushed.stderr);
    assertStringIncludes(pushed.stderr, "merged");

    // No fetch ever happens for this — only the node's announcement of its own refs.
    assert(await b.bridge.consumer.handle(announced) >= 2);
    const merged = b.sink.threadEvents().find((e) => e.kind === "change_request.merged");
    assertEquals(merged?.thread, { kind: "change_request", ref: submitted.ref });
    assertEquals(merged?.actor.did, b.me.did);
    const moved = b.sink.branchEvents()[0];
    assertEquals(moved?.branch, { ref: b.mine.defaultBranch, commit: head });
    assertEquals(b.sink.threadEvents().some((e) => e.kind === "comment.created"), false);

    // An announcement about a repository nobody connected is still nobody's business.
    assertEquals(await b.bridge.consumer.handle({ ...announced, rid: b.theirs.rid }), 0);
  } finally {
    await b.dispose();
  }
});

radTest("a deployment's bridge still ignores its node's own announcements", async () => {
  const b = await bench();
  try {
    const deployment = setup({
      exec: b.me.exec,
      node: socketNodeControl({ socket: "/dev/null" }),
      cursors: memoryCursorStore(),
      sink: b.sink,
      diag: SILENT_DIAGNOSTICS,
      token: TOKEN,
      config: {
        exportDir: "/nonexistent",
        scratchDir: "/nonexistent",
        maxBundleBytes: 1,
        maxUploadPackBytes: 1,
        fetchBeforeAdvertise: false,
        gitFetchTimeoutMs: 1,
        gitFetchFreshMs: 0,
      },
    });
    // Everything in storage is in scope, untracked or not.
    assertEquals(await deployment.service.inScope(b.theirs.rid), true);
    assertEquals((await deployment.service.identity()).mode, "deployment");
    assertEquals(
      await deployment.consumer.handle({ type: "localRefsAnnounced", rid: b.mine.rid }),
      0,
    );
  } finally {
    await b.dispose();
  }
});

radTest("a repository the person blocked is refused, and the block row is left alone", async () => {
  const b = await bench();
  try {
    const blocked = await b.me.exec.rad(["block", b.theirs.rid], {
      env: { RAD_SOCKET: "/dev/null" },
    });
    assertEquals(blocked.code, 0, blocked.stderr);
    // What `rad inspect --policy` cannot tell from no policy at all.
    assertStringIncludes(await policyOf(b.me, b.theirs.rid), "is not being seeded");

    const res = await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`);
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error, "repo_blocked");
    assertEquals(body.command, `rad unblock ${b.theirs.rid}`);
    assertEquals(b.nodeCommands().includes("seed"), false);
    assertEquals(await b.tracked.get(b.theirs.rid), null);
    assert(/rad:\S+\s.*\sblock\s/.test(
      (await policies(b.me)).split("\n").find((l) => l.includes(b.theirs.rid)) ?? "",
    ));
  } finally {
    await b.dispose();
  }
});

radTest(
  "disconnecting forgets the cursors and the mirror, so a reconnect is a first sight",
  async () => {
    const b = await bench();
    try {
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.mine.rid)}/seed`)).status, 200);
      const refs = await b.call(
        "GET",
        `/v1/repos/${seg(b.mine.rid)}/git/info/refs?service=git-upload-pack`,
      );
      await refs.body?.cancel();
      assertEquals(await b.bridge.consumer.reconcile(), 0); // first sight sets the cursors
      assert((await b.cursors.listByRepo(b.mine.rid)).length > 0);
      const mirror = `${b.exportDir}/${b.mine.rid.slice("rad:".length)}.git`;
      assert(await exists(mirror));

      assertEquals((await b.call("DELETE", `/v1/repos/${seg(b.mine.rid)}/seed`)).status, 200);
      assertEquals(await b.cursors.listByRepo(b.mine.rid), []);
      assertEquals(await exists(mirror), false);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "a disconnect while the node is down leaves scope at once, and the policy goes later",
  async () => {
    const b = await bench();
    try {
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
      assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);

      b.nodeDown(true);
      const res = await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`);
      assertEquals(res.status, 503);
      // Out of scope regardless — served by nothing, pulled by nothing.
      assertEquals((await b.call("GET", `/v1/repos/${seg(b.theirs.rid)}`)).status, 404);
      assertEquals(await b.bridge.service.seededRepos(), []);
      assertEquals((await b.tracked.pendingUnseeds()).map((r) => r.rid), [b.theirs.rid]);
      // Still down: the retry keeps it owed.
      await b.bridge.consumer.pull();
      assertEquals((await b.tracked.pendingUnseeds()).length, 1);

      b.nodeDown(false);
      await b.bridge.consumer.pull();
      assertEquals(b.nodeCommands().filter((c) => c === "unseed").length, 1);
      assertEquals(await b.tracked.get(b.theirs.rid), null);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "a leftover row that says the policy is not ours is corrected when ryph writes it",
  async () => {
    const b = await bench();
    try {
      await b.tracked.track(b.theirs.rid, false);
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
      assertEquals(b.nodeCommands().filter((c) => c === "seed").length, 1);
      assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);
      // …so the disconnect removes it again.
      await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`);
      assertEquals(b.nodeCommands().filter((c) => c === "unseed").length, 1);
    } finally {
      await b.dispose();
    }
  },
);

radTest("nobody's revision asks for checks in user mode", async () => {
  const b = await bench();
  try {
    assertEquals((await b.call("POST", `/v1/repos/${seg(b.mine.rid)}/seed`)).status, 200);
    assertEquals(await b.bridge.consumer.reconcile(), 0); // first sight

    // A stranger opens a patch on the person's repository, and the node fetches it.
    await seedFrom(b.me, b.stranger, b.mine.rid);
    const head = await commit(b.stranger, b.mine.workDir, "S.md", "s\n", "a stranger's work");
    const dir = await tempDir("bundle");
    await makeBundle(b.stranger, b.mine.workDir, b.mine.head, head, `${dir.path}/b.bundle`);
    const theirs = makeRadicleService({
      exec: b.stranger.exec,
      node: socketNodeControl({ socket: "/dev/null" }),
      diag: SILENT_DIAGNOSTICS,
      scratchDir: dir.path,
    });
    await theirs.submitChange(b.mine.rid, {
      bundlePath: `${dir.path}/b.bundle`,
      title: "A stranger's work",
      description: "",
      baseSha: b.mine.head,
      headSha: head,
    });
    await dir.dispose();
    await pullRefs(b.stranger, b.me, b.mine.rid);

    await b.bridge.consumer.reconcile();
    assertEquals(
      b.sink.threadEvents().filter((e) => e.kind === "change_request.pushed"),
      [],
    );
  } finally {
    await b.dispose();
  }
});

radTest(
  "a tracked repository nothing connected is disconnected through the same path",
  async () => {
    const b = await bench();
    try {
      for (const rid of [b.mine.rid, b.theirs.rid]) {
        assertEquals((await b.call("POST", `/v1/repos/${seg(rid)}/seed`)).status, 200);
      }
      // The control plane still has `mine` connected; `theirs` was disconnected while the
      // bridge was not listening.
      await new Promise((r) => setTimeout(r, 5));
      const before = new Date().toISOString();
      assertEquals(
        await b.bridge.service.untrackExcept(new Set([b.mine.rid]), before),
        [b.theirs.rid],
      );
      assertEquals(await b.bridge.service.seededRepos(), [b.mine.rid]);
      // …and ryph's own policy for it went with it, as a disconnect's does.
      assertEquals(b.nodeCommands().filter((c) => c === "unseed").length, 1);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "a repository connected while the boot check runs is a connect in flight, not drift",
  async () => {
    const b = await bench();
    try {
      // The check read the control plane's rows before this connect's row landed…
      const before = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.mine.rid)}/seed`)).status, 200);
      // …so `mine` is not in `keep`, and is still left alone.
      assertEquals(await b.bridge.service.untrackExcept(new Set(), before), []);
      assertEquals(await b.bridge.service.seededRepos(), [b.mine.rid]);
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "a disconnect never removes a block the person put on a repository ryph had seeded",
  async () => {
    const b = await bench();
    const block = () =>
      b.me.exec.rad(["block", b.theirs.rid], { env: { RAD_SOCKET: "/dev/null" } });
    try {
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
      assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);
      assertEquals((await block()).code, 0);

      const res = await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`);
      assertEquals(await res.json(), { unseeded: false });
      assertEquals(b.nodeCommands().includes("unseed"), false);
      assertEquals(await b.tracked.get(b.theirs.rid), null);
      assertStringIncludes(
        (await policies(b.me)).split("\n").find((l) => l.includes(b.theirs.rid)) ?? "",
        "block",
      );
    } finally {
      await b.dispose();
    }
  },
);

radTest(
  "a pending removal settles without touching a block put there in the meantime",
  async () => {
    const b = await bench();
    try {
      assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
      // The fake keeps nothing, so write the policy as the node would have.
      await b.me.exec.rad(["seed", b.theirs.rid, "--no-fetch"], {
        env: { RAD_SOCKET: "/dev/null" },
      });
      b.nodeDown(true);
      assertEquals((await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 503);
      await b.me.exec.rad(["block", b.theirs.rid], { env: { RAD_SOCKET: "/dev/null" } });
      b.nodeDown(false);
      await b.bridge.consumer.pull();
      assertEquals(b.nodeCommands().includes("unseed"), false);
      assertEquals(await b.tracked.get(b.theirs.rid), null);
    } finally {
      await b.dispose();
    }
  },
);

radTest("a failed reconnect leaves a pending removal pending", async () => {
  const b = await bench();
  try {
    assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
    b.nodeDown(true);
    assertEquals((await b.call("DELETE", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 503);
    // The policy has gone meanwhile (the person removed it), so connecting again has to write
    // one — while the node is still down: the seed fails, and nothing is forgotten.
    await b.me.exec.rad(["unseed", b.theirs.rid], { env: { RAD_SOCKET: "/dev/null" } });
    assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 503);
    assertEquals((await b.tracked.get(b.theirs.rid))?.unseedPending, true);
    assertEquals(await b.bridge.service.inScope(b.theirs.rid), false);
  } finally {
    await b.dispose();
  }
});

radTest("only the listing's first cell names the repository a policy row is for", async () => {
  // A hostile repository NAMES `theirs` and claims an allow row for it. `theirs` itself has no
  // policy, so ryph must still seed it — and own the policy it wrote.
  let rid = "";
  const b = await bench({
    wrapExec: (exec) => ({
      ...exec,
      rad: async (args, o) => {
        const out = await exec.rad(args, o);
        if (args.length !== 1 || args[0] !== "seed") return out;
        const forged = `│ rad:z4V14vdenmiCJQPkp9347PXnNUahZ   ${rid}   allow    all │`;
        return { ...out, stdout: out.stdout.replace(/(├[^\n]*\n)/, `$1${forged}\n`) };
      },
    }),
  });
  rid = b.theirs.rid;
  try {
    assertEquals((await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`)).status, 200);
    assertEquals(b.nodeCommands().filter((c) => c === "seed").length, 1);
    assertEquals((await b.tracked.get(b.theirs.rid))?.createdPolicy, true);
  } finally {
    await b.dispose();
  }
});

radTest("a disconnect during a reconcile pass leaves no cursors behind", async () => {
  const b = await bench();
  try {
    for (const rid of [b.mine.rid, b.theirs.rid]) {
      assertEquals((await b.call("POST", `/v1/repos/${seg(rid)}/seed`)).status, 200);
    }
    // While the pass works on the first repository, the second is disconnected — after the
    // pass has already listed it.
    const [first, second] = [b.mine.rid, b.theirs.rid].sort();
    const listByRepo = b.cursors.listByRepo.bind(b.cursors);
    let fired = false;
    b.cursors.listByRepo = async (rid: string) => {
      if (!fired && rid === first) {
        fired = true;
        await b.call("DELETE", `/v1/repos/${seg(second)}/seed`);
      }
      return await listByRepo(rid);
    };
    await b.bridge.consumer.reconcile();
    assert(fired);
    assertEquals(await b.bridge.service.inScope(second), false);
    assertEquals(await listByRepo(second), [], "cursors written back for an out-of-scope repo");
  } finally {
    await b.dispose();
  }
});

radTest("a forge not told the bridge acts as a user cannot seed through it", async () => {
  const b = await bench();
  try {
    for (const mode of [null, "deployment"]) {
      const res = await b.call("POST", `/v1/repos/${seg(b.theirs.rid)}/seed`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(mode === null ? {} : { "x-ryph-radicle-mode": mode }),
        },
      });
      assertEquals(res.status, 409);
      assertEquals((await res.json()).error, "bridge_mode_mismatch");
    }
    assertEquals(b.nodeCommands().includes("seed"), false);
    assertEquals(await b.tracked.get(b.theirs.rid), null);
  } finally {
    await b.dispose();
  }
});

test("retrying pending unseeds swallows a store that is down", async () => {
  const store = memoryTrackedRepos([]);
  const down = () => Promise.reject(new Error("the database is down"));
  for (
    const broken of [
      { ...store, pendingUnseeds: down },
      {
        ...store,
        pendingUnseeds: () =>
          Promise.resolve([{ rid: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5", unseedPending: true }]),
        get: down,
      },
    ]
  ) {
    const service = makeRadicleService({
      exec: (() => {
        throw new Error("never runs");
      }) as unknown as RadExec,
      node: socketNodeControl({ socket: "/dev/null" }),
      diag: SILENT_DIAGNOSTICS,
      scratchDir: "/dev/null",
      tracked: broken as unknown as TrackedRepoStore,
    });
    // Resolves: the pull loop awaits this before every pass, and a rejection would skip the pass.
    await service.retryPendingUnseeds();
  }
});
