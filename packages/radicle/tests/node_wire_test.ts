// The control-socket WIRE FORMAT, against the protocol rather than against our own idea of it.
//
// Why this exists as its own file. A command the node cannot deserialize is not an exception
// here: the node answers `{"error":"invalid type: …"}` on a socket whose caller logs and moves
// on, so a serde mismatch shows up as a seed that quietly fetches nothing. Two of them cost a
// live debugging session each, and neither is documented.
//
// The reference is heartwood's `Command`, `crates/radicle/src/node/command.rs`:
//
//   #[serde(rename_all = "camelCase", tag = "command")]
//
// so the variant's name is the `command` field in camelCase and every field of it is camelCase
// too. The shapes that are not obvious from the name:
//
// - `timeout` is `std::time::Duration`, whose serde representation is the STRUCT
//   `{"secs":<u64>,"nanos":<u32>}`. A number is refused: `invalid type: integer …, expected
//   struct Duration` (measured, rad 1.10.2).
// - `nid` on `Fetch` is a `NodeId`, not an `Option<NodeId>`: `invalid type: null, expected a
//   string`. There is no "fetch from anyone" command at all, and the node refuses a fetch from
//   a peer it has no session with — which is why fetching a repository from the NETWORK is
//   `rad sync --fetch` (core/sync_fetch.ts) and not a command on this socket.
// - `scope` on `Seed` is `node::policy::Scope`, `rename_all = "camelCase"` — `"all"` or
//   `"followed"`.
// - `namespaces` on `AnnounceRefsFor` and `SeedsFor` is a `HashSet<PublicKey>`: an array of
//   strings, required even when it is empty.
// - `Subscribe` is a unit variant: the tag and nothing else.
//
// `assertEquals` on the recorded object is a deep comparison, so an EXTRA field fails here too
// — which is the half that matters when somebody adds one speculatively.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { socketNodeControl } from "../src/adapters/node/socket.ts";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { socketPath } from "./util.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const NID = "z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";

/** Runs `drive` against a fake node and hands back every command line it received, parsed. */
async function wire(
  drive: (node: ReturnType<typeof socketNodeControl>) => Promise<void>,
  opts: { sessions?: unknown[]; seeds?: unknown[]; fetchResults?: Record<string, unknown> } = {},
): Promise<Array<Record<string, unknown>>> {
  const sock = await socketPath();
  const fake = startFakeNode({
    path: sock.path,
    sessions: opts.sessions,
    seeds: opts.seeds,
    fetchResults: opts.fetchResults,
  });
  try {
    await drive(socketNodeControl({ socket: sock.path }));
    return fake.commands;
  } finally {
    await fake.close();
    await sock.dispose();
  }
}

test("fetch is `{command,rid,nid,timeout}` with timeout as a Duration struct", async () => {
  const sent = await wire((node) => node.fetch(RID, NID, 30_000).then(() => {}));
  assertEquals(sent, [{
    command: "fetch",
    rid: RID,
    nid: NID,
    timeout: { secs: 30, nanos: 0 },
  }]);
});

test("a sub-second remainder becomes nanos, and never a fractional secs", async () => {
  const sent = await wire((node) => node.fetch(RID, NID, 1_250).then(() => {}));
  assertEquals(sent[0].timeout, { secs: 1, nanos: 250_000_000 });
  // `secs` is a u64 on the other side: a float would be refused outright.
  assertEquals(Number.isInteger((sent[0].timeout as { secs: number }).secs), true);
});

test("seed carries the scope by its camelCase name, and unseed carries none", async () => {
  const sent = await wire(async (node) => {
    await node.seed(RID, "all");
    await node.unseed(RID);
  });
  assertEquals(sent, [
    { command: "seed", rid: RID, scope: "all" },
    { command: "unseed", rid: RID },
  ]);
});

test("seedsFor and announceRefsFor both carry a namespaces array, empty or not", async () => {
  const sent = await wire(async (node) => {
    await node.seedsFor(RID);
    await node.announceRefsFor(RID, [NID]);
  });
  assertEquals(sent, [
    // The routing question — "does anybody claim to hold this" — reports a sync status for no
    // namespace, and the field is required all the same.
    { command: "seedsFor", rid: RID, namespaces: [] },
    { command: "announceRefsFor", rid: RID, namespaces: [NID] },
  ]);
});

test("the tag-only commands are the tag and nothing else", async () => {
  const sent = await wire(async (node) => {
    await node.nodeId();
    await node.status();
    await node.sessions();
    // The line is written before anything is read back, so the subscription only has to be
    // opened — and then ended, or the iterator would wait for an event forever.
    const ac = new AbortController();
    const stream = node.subscribe(ac.signal)[Symbol.asyncIterator]();
    const first = stream.next();
    setTimeout(() => ac.abort(), 50);
    assertEquals((await first).value, { kind: "eof", reason: "the subscription was aborted" });
  });
  assertEquals(sent, [
    { command: "nodeId" },
    { command: "status" },
    { command: "sessions" },
    { command: "subscribe" },
  ]);
});
