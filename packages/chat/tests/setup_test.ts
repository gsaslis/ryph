// The poll pass the root ticks: every live room, each under the lock when one is provided, a
// room another replica holds skipped, a room whose poll throws warned and the rest still polled,
// and every transport told which rooms this pass answers for.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { pollLockKey } from "../src/setup.ts";
import { makeApi, makeRoom } from "./api.ts";
import { BOT_TOKEN, mention } from "./fake_transport.ts";

test("pollAll polls every live room and skips the ones another replica holds", async () => {
  const locked = new Set<string>();
  const taken: string[] = [];
  const api = await makeApi({
    lock: {
      take: (id) => {
        if (locked.has(id)) return Promise.resolve(null);
        taken.push(id);
        return Promise.resolve(() => Promise.resolve());
      },
      held: () => Promise.resolve(true),
    },
  });
  try {
    const a = await makeRoom(api, "a");
    const b = await makeRoom(api, "b");
    const archived = await makeRoom(api, "c");
    await api.service.archiveChatroom(archived.id);
    locked.add(b.id);
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 1, text: `@ryph_bot ${a.linkCode}` }));
    await api.chat.pollAll(new AbortController().signal);
    assertEquals(taken, [a.id]);
    assertEquals(api.transport.polls.length, 1, "b is held elsewhere, c is archived");
    assertEquals((await api.store.getChatroom(a.id))?.chatId, "-100200300");
    // And the transports are told what this pass answers for, so what a platform holds for a room
    // it no longer polls — a Slack socket still acknowledging events — is let go of rather than
    // left consuming them. Only `a` is this poller's.
    assertEquals(api.transport.released, [new Set([a.id])]);
  } finally {
    await api.close();
  }
});

test("a room's lock is taken once and kept until the room stops being polled", async () => {
  // A Slack connection outlives a pass and acknowledges envelopes on arrival, so a lock handed
  // back between passes would let a second poller open its own connection for the same app and
  // swallow half the events. The lock is the room's for as long as this poller answers for it.
  const taken: string[] = [];
  const given: string[] = [];
  /** Rooms whose lock the database has quietly let go of — its connection went away. */
  const lost = new Set<string>();
  const api = await makeApi({
    lock: {
      take: (id) => {
        taken.push(id);
        return Promise.resolve(() => {
          given.push(id);
          return Promise.resolve();
        });
      },
      held: (id) => Promise.resolve(!lost.has(id)),
    },
  });
  try {
    const a = await makeRoom(api, "a");
    const b = await makeRoom(api, "b");
    for (let pass = 0; pass < 3; pass++) {
      await api.chat.pollAll(new AbortController().signal);
    }
    // The pass locks its rooms concurrently, so what matters is that each was asked for once.
    assertEquals(taken.length, 2, "once each, not once per pass");
    assertEquals(new Set(taken), new Set([a.id, b.id]));
    assertEquals(given, []);

    // The database let go of b's lock without telling anyone — the connection it lived on went
    // away. The poller asks rather than assuming, so it stops answering for b and drops what its
    // transport held; the stale release is never called, because it would unlock nothing.
    lost.add(b.id);
    await api.chat.pollAll(new AbortController().signal);
    assertEquals(given, []);
    assertEquals(api.transport.released.at(-1), new Set([a.id]));
    // And the next pass takes it again, since asking is all it takes to find it free.
    lost.delete(b.id);
    await api.chat.pollAll(new AbortController().signal);
    assertEquals(taken.length, 3);

    // Archived, so this poller no longer answers for it: the lock goes back and the transport is
    // told to let go of whatever it held.
    await api.service.archiveChatroom(a.id);
    await api.chat.pollAll(new AbortController().signal);
    assertEquals(given, [a.id]);
    assertEquals(api.transport.released.at(-1), new Set([b.id]));
  } finally {
    await api.close();
  }
});

test("a lock that throws costs one room, not the pass", async () => {
  // The acquire used to sit outside the try, where one rejection took the whole pass with it and
  // the transports were never told what this poller answers for.
  const failing = new Set<string>();
  const api = await makeApi({
    lock: {
      take: (id) =>
        failing.has(id)
          ? Promise.reject(new Error("the lock session is gone"))
          : Promise.resolve(() => Promise.resolve()),
      held: () => Promise.resolve(true),
    },
  });
  try {
    const a = await makeRoom(api, "a");
    const b = await makeRoom(api, "b");
    failing.add(b.id);
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 1, text: `@ryph_bot ${a.linkCode}` }));
    await api.chat.pollAll(new AbortController().signal);

    assert(api.warnings.includes("chat.poll_failed"), "b's acquire is warned like any failure");
    assertEquals((await api.store.getChatroom(a.id))?.chatId, "-100200300", "a was still polled");
    // The pass finished, and a room whose lock could not be ASKED about is not a room this poller
    // has been told it lost: nothing of its is let go of on a transient failure.
    assertEquals(api.transport.released, [new Set([a.id, b.id])]);
  } finally {
    await api.close();
  }
});

test("a room whose poll throws is warned; the next pass asks again from the same cursor", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    const original = api.transport.poll.bind(api.transport);
    let fail = true;
    api.transport.poll = (room, opts) =>
      fail ? Promise.reject(new Error("telegram getUpdates answered 502")) : original(room, opts);
    await api.chat.pollAll(new AbortController().signal);
    assert(api.warnings.includes("chat.poll_failed"));
    assertEquals(await api.store.getCursor(room.id), null);
    fail = false;
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 3 }));
    await api.chat.pollAll(new AbortController().signal);
    assertEquals((await api.store.getCursor(room.id))?.offset, 4);
  } finally {
    await api.close();
  }
});

test("a room that keeps failing warns once per failure and backs off until it changes", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    let polls = 0;
    let error = "the room's token does not open";
    api.transport.poll = () => {
      polls++;
      return Promise.reject(new Error(error));
    };
    const pass = () => api.chat.pollAll(new AbortController().signal);
    const warned = () => api.warnings.filter((w) => w === "chat.poll_failed").length;

    await pass(); // fails, warned
    await pass(); // retried on the next tick: fails again, the same failure, not warned
    assertEquals([polls, warned()], [2, 1]);
    await pass(); // waiting out the delay: not polled at all
    assertEquals(polls, 2);
    api.clock.advance(2_000);
    await pass();
    assertEquals([polls, warned()], [3, 1]);
    api.clock.advance(2_000); // the wait has doubled to 4 s
    await pass();
    assertEquals(polls, 3);
    api.clock.advance(2_000);
    error = "telegram getUpdates answered 502"; // a different failure is warned again
    await pass();
    assertEquals([polls, warned()], [4, 2]);

    // An edit to the room starts it afresh: polled on the next tick, whatever the delay was.
    await api.store.saveChatroom({ ...(await api.store.getChatroom(room.id))!, updatedAt: "x" });
    await pass();
    assertEquals(polls, 5);
  } finally {
    await api.close();
  }
});

test("pollLockKey is stable, in this service's number space, and spreads rooms", () => {
  assertEquals(pollLockKey("chr-abc"), pollLockKey("chr-abc"));
  assert(pollLockKey("chr-abc") >= 8_500_000 && pollLockKey("chr-abc") < 8_600_000);
  assert(pollLockKey("chr-abc") !== pollLockKey("chr-abd"));
});
