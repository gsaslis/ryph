// Fetching from the network through `rad sync --fetch`, and reading what it says.
//
// Two halves, and the second one is why this file exists at all:
//
// - the PARSER against output captured from the real CLI (rad 1.10.2), including the case that
//   broke a live deployment: a fetch that served nothing and exited ZERO;
// - the real `rad` itself, driven against the package's fake node. Fully offline — the CLI
//   talks to a unix socket we own, and the fake answers `status`, `seedsFor`, `session`,
//   `connect` and `fetch` exactly as heartwood serializes them. Nothing dials the network.
//
// The second half is what keeps the first honest: every golden below was PRODUCED by the runs
// in this file, not written from the docs.

import { test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { parseSyncFetch, SYNC_EXEC_GRACE_MS, syncFetch } from "../src/core/sync_fetch.ts";
import { makeEventConsumer } from "../src/core/events.ts";
import type { RadicleService } from "../src/core/service.ts";
import { FetchRefusedError } from "../src/ports/node.ts";
import type { ExecOptions, ExecResult, RadExec } from "../src/ports/rad.ts";
import { SILENT_DIAGNOSTICS } from "../src/ports/diagnostics.ts";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { makePeer, RAD_MISSING, socketPath } from "./util.ts";

const RID = "rad:z2oo6c5ceo8RPkRsxHBE2LBz7uHsC";
const SEED = "z6MkjM3HpqNVV4ZsL5s3RAd8ThVG3VG98YsDCjHBNnGMq5o7";
const radTest = test.skipIf(RAD_MISSING);

function out(code: number, stdout: string, timedOut = false): ExecResult {
  return { code, stdout, stderr: "", timedOut };
}

// ── the parser, against captured output ──────────────────────────────────────────────────

test("a fetch that served the repository is the 🌱 line, and nothing else says so", () => {
  const parsed = parseSyncFetch(out(
    0,
    `Fetching ${RID} from the network, found 1 potential seed(s).\n` +
      `✓ Target met: 1 seed(s)\n` +
      `🌱 Fetched from ${SEED}\n`,
  ));
  assertEquals(parsed.fetched, [SEED]);
  assertEquals(parsed.failures, []);
  assertEquals(parsed.candidates, 1);
  assertEquals(parsed.inProgress, false);
});

test("A FETCH THAT SERVED NOTHING EXITS ZERO — the exit code is not the verdict", () => {
  // Captured from rad 1.10.2 against a node that refused the fetch. `sync.rs` hands a
  // `FetcherResult::TargetError` to `display_fetch_result`, which PRINTS it and returns `()`;
  // `run` then returns `Ok(())`. Reading exit 0 as "fetched" calls every refusal a success.
  const parsed = parseSyncFetch(out(
    0,
    `Fetching ${RID} from the network, found 1 potential seed(s).\n` +
      `✗ Target not met: required 1 more seed(s)\n` +
      `✗ Error: Fetched from 0 preferred seed(s), could not reach 1 seed(s)\n` +
      `✗ Error: Could not replicate from 0 preferred seed(s)\n` +
      `✗ Error: ${SEED}: an I/O error occurred during the fetch handshake (connection reset)\n`,
  ));
  assertEquals(parsed.fetched, []);
  assertEquals(parsed.failures, [{
    nid: SEED,
    reason: "an I/O error occurred during the fetch handshake (connection reset)",
  }]);
  // The summary lines are not mistaken for per-seed ones: only the `<nid>: <reason>` shape is.
  assertEquals(parsed.candidates, 1);
  assertStringIncludes(parsed.summary, "could not reach 1 seed(s)");
});

test("a seed that was never dialled is not a seed that refused us", () => {
  const parsed = parseSyncFetch(out(
    0,
    `Fetching ${RID} from the network, found 1 potential seed(s).\n` +
      `✗ Error: ${SEED}: Could not connect. No addresses known.\n`,
  ));
  assertEquals(parsed.failures.length, 1);
});

test("the failures that DO exit non-zero carry the CLI's own sentence", () => {
  const noNode = parseSyncFetch(out(
    1,
    "✗ Error: to sync a repository, your node must be running. To start it, run `rad node start`\n",
  ));
  assertEquals(noNode.fetched, []);
  assertStringIncludes(noNode.summary, "your node must be running");
  const unseeded = parseSyncFetch(out(1, `✗ Error: repository ${RID} is not seeded\n`));
  assertStringIncludes(unseeded.summary, "is not seeded");
  const nobody = parseSyncFetch(out(1, "✗ Error: no candidate seeds were found to fetch from\n"));
  assertStringIncludes(nobody.summary, "no candidate seeds");
  assertEquals(nobody.failures, []);
});

test("the CLI giving up on the NODE is 'still running', not a refusal", () => {
  // Measured on a live node: a fetch from a big seed ran past the CLI's control-socket read
  // deadline; `rad` printed this and exited non-zero while the node went on and finished the
  // fetch. Calling that a refusal tells somebody their public repository is private.
  const parsed = parseSyncFetch(out(1, "✗ Error: timed out reading from control socket\n"));
  assertEquals(parsed.inProgress, true);
});

// ── the command, and what a failure becomes ──────────────────────────────────────────────

/** A `RadExec` that answers one canned result and records how it was called. */
function scriptedExec(result: ExecResult): RadExec & { calls: Array<[string[], ExecOptions?]> } {
  const calls: Array<[string[], ExecOptions?]> = [];
  return {
    calls,
    home: "/nowhere",
    socket: "/dev/null",
    storageDir: (rid: string) => `/nowhere/storage/${rid}`,
    rad: (args, options) => {
      calls.push([args, options]);
      return Promise.resolve(result);
    },
    git: () => Promise.resolve(out(0, "")),
    radJob: () => Promise.resolve(out(0, "")),
  };
}

test("the fetch is one replica, the caller's budget, and a subprocess bound above it", async () => {
  const exec = scriptedExec(out(0, `🌱 Fetched from ${SEED}\n`));
  await syncFetch({ exec, diag: SILENT_DIAGNOSTICS }, RID, 20_000);
  assertEquals(exec.calls[0][0], [
    "sync",
    RID,
    "--fetch",
    // One replica is all a clone needs — heartwood's own `clone.rs` says exactly that. Waiting
    // for the default three spends the budget on seeds nobody asked for.
    "--replicas",
    "1",
    "--timeout",
    "20sec",
  ]);
  // The CLI gets to end its own walk and print per-seed reasons; the subprocess bound is the
  // backstop for a `rad` that ignores its own timeout.
  assertEquals(exec.calls[0][1]?.timeoutMs, 20_000 + SYNC_EXEC_GRACE_MS);
});

test("a caller with its own deadline can take the grace away", async () => {
  const exec = scriptedExec(out(0, `🌱 Fetched from ${SEED}\n`));
  await syncFetch({ exec, diag: SILENT_DIAGNOSTICS }, RID, 3_000, 0);
  assertEquals(exec.calls[0][1]?.timeoutMs, 3_000);
});

test("a refusal carries every seed's reason, and how many were actually asked", async () => {
  const exec = scriptedExec(out(
    0,
    `Fetching ${RID} from the network, found 2 potential seed(s).\n` +
      `✗ Error: ${SEED}: an I/O error occurred during the fetch handshake (connection reset)\n` +
      `✗ Error: z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo: Could not connect. ` +
      `No addresses known.\n`,
  ));
  const err = await assertRejects(
    () => syncFetch({ exec, diag: SILENT_DIAGNOSTICS }, RID, 20_000),
    FetchRefusedError,
  );
  assertStringIncludes(err.message, "connection reset");
  assertEquals(err.attempts.length, 2);
  // ONE of them was asked. The other was never dialled, and counting it would turn "nobody we
  // could reach has it" into "something that has it refused us" — the difference the connect
  // flow's 409 is built on.
  assertEquals(err.triedSeeds, 1);
  assertEquals(err.candidates, 2);
  assertEquals(err.inProgress, false);
});

test("a subprocess we cut off is in progress, not refused", async () => {
  const exec = scriptedExec(out(124, "", true));
  const err = await assertRejects(
    () => syncFetch({ exec, diag: SILENT_DIAGNOSTICS }, RID, 1_000),
    FetchRefusedError,
  );
  assertEquals(err.inProgress, true);
  assertEquals(err.triedSeeds, 0);
});

// ── the real CLI, against the fake node ──────────────────────────────────────────────────

/**
 * A throwaway identity seeding `RID`, pointed at `socket`.
 *
 * `preferredSeeds` is emptied: a stock profile carries iris and rosa, and the fetcher adds
 * them as candidates, which would make every assertion below depend on what the CLI thinks of
 * two nodes that are not there.
 */
async function seedingPeer(socket: string) {
  const peer = await makePeer("sync-fetch", socket);
  const configPath = `${peer.home}/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.preferredSeeds = [];
  await writeFile(configPath, JSON.stringify(config, null, 2));
  // RAD_SOCKET=/dev/null for this ONE command: with a node in reach, `rad seed` hands the
  // policy to it (`Command::Seed`) instead of writing it, and a fake node that only answers
  // `{"updated":true}` keeps nothing — after which `rad sync` says the repository is not
  // seeded. Without a node the CLI writes the policy database itself, which is what the real
  // bridge's node does for it.
  const seeded = await peer.exec.rad(["seed", RID, "--scope", "all", "--no-fetch"], {
    env: { RAD_SOCKET: "/dev/null" },
  });
  assertEquals(seeded.code, 0, `${seeded.stderr}${seeded.stdout}`);
  return peer;
}

/** A routing answer for one holder, in heartwood's `Seed` shape. */
const holder = (connected: boolean) => ({
  nid: SEED,
  addrs: [{
    addr: "seed.example.com:8776",
    source: "peer",
    lastSuccess: null,
    lastAttempt: null,
    banned: false,
  }],
  ...(connected ? { state: { connected: { since: 1 } } } : {}),
});

const session = {
  nid: SEED,
  link: "outbound",
  addr: "seed.example.com:8776",
  state: { connected: { since: 1 } },
};

radTest("the real rad fetches from a routing-table holder", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, seeds: [holder(true)], sessions: [session] });
  const peer = await seedingPeer(sock.path);
  try {
    const outcome = await syncFetch(
      { exec: peer.exec, diag: SILENT_DIAGNOSTICS },
      RID,
      5_000,
    );
    assertEquals(outcome.fetched, [SEED]);
    assertEquals(outcome.candidates, 1);
    // `seedsFor` — the ROUTING table — is what the CLI consults, and it is the whole reason
    // this replaced a walk over the node's established sessions.
    assertEquals(
      fake.commands.map((c) => c.command),
      ["status", "seedsFor", "session", "fetch"],
    );
    assertEquals(fake.commands[3].nid, SEED);
  } finally {
    await fake.close();
    await sock.dispose();
    await peer.dispose();
  }
});

radTest("the real rad's refusal exits ZERO and is still a refusal", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({
    path: sock.path,
    seeds: [holder(true)],
    sessions: [session],
    fetchResults: {
      [SEED]: {
        status: "failed",
        reason: "an I/O error occurred during the fetch handshake (connection reset)",
      },
    },
  });
  const peer = await seedingPeer(sock.path);
  try {
    const err = await assertRejects(
      () => syncFetch({ exec: peer.exec, diag: SILENT_DIAGNOSTICS }, RID, 5_000),
      FetchRefusedError,
    );
    assertStringIncludes(err.message, "connection reset");
    // It WAS asked, and it refused: the one reading that makes "this may be private" fair.
    assertEquals(err.triedSeeds, 1);
    assertEquals(fake.commands.filter((c) => c.command === "fetch").length, 1);
  } finally {
    await fake.close();
    await sock.dispose();
    await peer.dispose();
  }
});

radTest("a holder the node has no session with is a candidate, not a refusal", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, seeds: [holder(false)], sessions: [] });
  const peer = await seedingPeer(sock.path);
  try {
    const err = await assertRejects(
      () => syncFetch({ exec: peer.exec, diag: SILENT_DIAGNOSTICS }, RID, 5_000),
      FetchRefusedError,
    );
    // The CLI dials it rather than skipping it — a fetch straight at an unconnected peer is
    // refused by the node outright ("peer … is not connected; cannot initiate fetch"), which
    // is precisely what the bridge used to do to itself. Here it has no address of its own for
    // the seed, so it says so, and NOTHING was asked.
    assertStringIncludes(err.message, "Could not connect");
    assertEquals(err.triedSeeds, 0);
    assertEquals(fake.commands.some((c) => c.command === "fetch"), false);
  } finally {
    await fake.close();
    await sock.dispose();
    await peer.dispose();
  }
});

radTest("the real rad without a node refuses in one sentence", async () => {
  const peer = await makePeer("sync-fetch-no-node");
  try {
    const err = await assertRejects(
      () => syncFetch({ exec: peer.exec, diag: SILENT_DIAGNOSTICS }, RID, 2_000),
      FetchRefusedError,
    );
    assertStringIncludes(err.message, "your node must be running");
  } finally {
    await peer.dispose();
  }
});

// ── the pull loop ────────────────────────────────────────────────────────────────────────

/** Just enough of the service for the pull: which repos there are, and fetching one. */
function pullService(
  repos: string[],
  fetched: string[],
  fail?: (rid: string) => Error | null,
): RadicleService {
  return {
    seededRepos: () => Promise.resolve(repos),
    retryPendingUnseeds: () => Promise.resolve(),
    fetchFromNetwork: (rid: string) => {
      fetched.push(rid);
      const err = fail?.(rid) ?? null;
      return err === null ? Promise.resolve() : Promise.reject(err);
    },
  } as unknown as RadicleService;
}

function consumerFor(service: RadicleService) {
  return makeEventConsumer({
    service,
    exec: scriptedExec(out(0, "")),
    // The pull touches neither the socket nor the store; a consumer that is never started
    // reaches nothing else.
    node: { subscribe: async function* () {} } as never,
    cursors: { listByRepo: () => Promise.resolve([]) } as never,
    sink: { deliver: () => Promise.resolve({ kind: "delivered" as const }) } as never,
    diag: SILENT_DIAGNOSTICS,
  });
}

test("the pull asks for every seeded repository, in turn", async () => {
  const fetched: string[] = [];
  await consumerFor(pullService(["rad:one", "rad:two"], fetched)).pull();
  // Sequential: one unreachable seed must not hold up the rest, and a burst of parallel
  // `rad sync` processes is a node's worth of fetch slots spent at once.
  assertEquals(fetched, ["rad:one", "rad:two"]);
});

test("a repository nobody serves does not stop the pull", async () => {
  const fetched: string[] = [];
  await consumerFor(
    pullService(
      ["rad:one", "rad:two", "rad:three"],
      fetched,
      (rid) => rid === "rad:two" ? new FetchRefusedError(rid, 0, []) : null,
    ),
  ).pull();
  assertEquals(fetched, ["rad:one", "rad:two", "rad:three"]);
});

test("a pull that is still running is not started a second time", async () => {
  const fetched: string[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const service = {
    seededRepos: () => Promise.resolve(["rad:one"]),
    retryPendingUnseeds: () => Promise.resolve(),
    fetchFromNetwork: async (rid: string) => {
      fetched.push(rid);
      await held;
    },
  } as unknown as RadicleService;
  const consumer = consumerFor(service);
  const first = consumer.pull();
  const second = consumer.pull();
  release();
  await Promise.all([first, second]);
  assertEquals(fetched, ["rad:one"], "the second tick joined the first pass rather than doubling");
});
