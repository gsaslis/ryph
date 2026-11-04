// The control-socket adapter against a REAL unix listener speaking the real line protocol.
// No radicle-node is needed for this — the protocol is the contract, and the fake implements it.

import { test } from "bun:test";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { startFakeNode } from "../src/adapters/node/fake.ts";
import { socketNodeControl } from "../src/adapters/node/socket.ts";
import {
  FetchRefusedError,
  NodeCommandError,
  type NodeStreamItem,
  NodeUnavailableError,
} from "../src/ports/node.ts";
import { socketPath } from "./util.ts";

const NID = "z6MkrZSV9qadiiEtb9UadbAbMRZgtPxxzprBoTgvqiZqq1gG";
const RID = "rad:z4V14vdenmiCJQPkp9347PXnNUahZ";

test("one command per connection, answered on the same connection", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, nid: NID });
  const node = socketNodeControl({ socket: sock.path });
  try {
    assertEquals(await node.nodeId(), NID);
    assertEquals(await node.seed(RID, "all"), { updated: true });
    assertEquals(await node.unseed(RID), { updated: true });
    assertEquals(await node.status(), { running: true });
    assertEquals(await node.sessions(), []);
    assertEquals(fake.commands.map((c) => c.command), [
      "nodeId",
      "seed",
      "unseed",
      "status",
      "sessions",
    ]);
    // The seed command carries the scope the bridge always uses.
    assertEquals(fake.commands[1], { command: "seed", rid: RID, scope: "all" });
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

test("announceRefsFor names the repo and the namespaces it gossips", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path });
  const node = socketNodeControl({ socket: sock.path });
  try {
    await node.announceRefsFor(RID, [NID]);
    assertEquals(fake.commands[0], {
      command: "announceRefsFor",
      rid: RID,
      namespaces: [NID],
    });
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

// The shape below cost a live debugging session: `rad 1.10.2` answers a number timeout with
// "invalid type: integer …, expected struct Duration", and that refusal lands in a log nobody
// reads while the seed quietly fetches nothing. (A null nid is refused the same way — there is
// no "fetch from anyone" command, which is why fetching from the NETWORK goes through
// `rad sync --fetch`; see tests/sync_fetch_test.ts.)
test("fetch sends a Duration struct, never a number of milliseconds", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path });
  const node = socketNodeControl({ socket: sock.path });
  try {
    await node.fetch(RID, NID, 20_500);
    assertEquals(fake.commands[0], {
      command: "fetch",
      rid: RID,
      nid: NID,
      timeout: { secs: 20, nanos: 500_000_000 },
    });
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

// A failed fetch is a NORMAL reply — `{"status":"failed","reason":"…"}`, heartwood's tagged
// `FetchResult` — not an error line and not a throw. A caller that only fails on a throw calls
// every refusal a success.
test("a named peer that refuses is a failure, not a success with a failure inside it", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({
    path: sock.path,
    fetchResults: { [NID]: { status: "failed", reason: "repository not found" } },
  });
  const node = socketNodeControl({ socket: sock.path });
  try {
    const err = await assertRejects(() => node.fetch(RID, NID, 1_000), FetchRefusedError);
    assertStringIncludes(err.message, "repository not found");
    assertEquals(err.triedSeeds, 0);
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

test("sessions answers the peers, not the lines the node wrote them on", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({
    path: sock.path,
    sessions: [{ nid: NID, state: { connected: { since: 1 } } }, { nid: NID, state: "attempted" }],
  });
  const node = socketNodeControl({ socket: sock.path });
  try {
    assertEquals((await node.sessions()).length, 2);
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

test("an {error} line becomes a NodeCommandError naming the command", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path, failCommands: ["seed"] });
  const node = socketNodeControl({ socket: sock.path });
  try {
    const err = await assertRejects(() => node.seed(RID, "all"), NodeCommandError);
    assertStringIncludes(err.message, "node refused seed");
    assertStringIncludes(err.message, "not having it");
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

test("a socket that is not there is NodeUnavailable, distinct from a refusal", async () => {
  const node = socketNodeControl({ socket: "/tmp/ryph-no-such-socket-ever" });
  await assertRejects(() => node.nodeId(), NodeUnavailableError);
});

test("subscribe streams events and ends with exactly one eof when the node hangs up", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path });
  const node = socketNodeControl({ socket: sock.path });
  const items: NodeStreamItem[] = [];
  try {
    const reading = (async () => {
      for await (const item of node.subscribe()) items.push(item);
    })();
    // Wait for the subscription to land before emitting into it.
    while (fake.subscribers() === 0) await new Promise((r) => setTimeout(r, 5));
    fake.emit({ type: "refsFetched", rid: RID, remote: NID, updated: [] });
    fake.emit({ type: "peerConnected", nid: NID });
    // A type this bridge has never heard of must not end the stream.
    fake.emit({ type: "somethingInventedLater", payload: { deep: true } });
    while (items.length < 3) await new Promise((r) => setTimeout(r, 5));
    fake.hangUp();
    await reading;

    assertEquals(items.length, 4);
    assertEquals(items.slice(0, 3).map((i) => i.kind === "event" ? i.event.type : i.kind), [
      "refsFetched",
      "peerConnected",
      "somethingInventedLater",
    ]);
    const last = items[3];
    assertEquals(last.kind, "eof");
  } finally {
    await fake.close();
    await sock.dispose();
  }
});

test("a subscription whose socket never opens yields an eof rather than throwing", async () => {
  const node = socketNodeControl({ socket: "/tmp/ryph-no-such-socket-ever" });
  const items: NodeStreamItem[] = [];
  for await (const item of node.subscribe()) items.push(item);
  assertEquals(items.length, 1);
  assertEquals(items[0].kind, "eof");
});

test("aborting a subscription ends it with an eof", async () => {
  const sock = await socketPath();
  const fake = startFakeNode({ path: sock.path });
  const node = socketNodeControl({ socket: sock.path });
  const abort = new AbortController();
  const items: NodeStreamItem[] = [];
  try {
    const reading = (async () => {
      for await (const item of node.subscribe(abort.signal)) items.push(item);
    })();
    while (fake.subscribers() === 0) await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await reading;
    assertEquals(items.length, 1);
    assertEquals(items[0].kind, "eof");
  } finally {
    await fake.close();
    await sock.dispose();
  }
});
