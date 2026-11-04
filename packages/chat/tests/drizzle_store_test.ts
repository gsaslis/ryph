// The store on real PostgreSQL: the conditional binding insert is the rule the service leans
// on, and it has to hold in SQL, not in the service's read-then-write.

import { assertEquals } from "@std/assert";
import { drizzleChatStore } from "../src/adapters/store/drizzle.ts";
import type { ChatBinding, Chatroom } from "../src/core/types.ts";
import { reusableDbSuite } from "./reusable_db.ts";

const { test, makeTestDb } = reusableDbSuite("chat store");

const T0 = "2026-09-01T00:00:00.000Z";

const room = (id: string): Chatroom => ({
  id,
  name: id,
  kind: "telegram",
  botUsername: "ryph_bot",
  botId: "1",
  sealedBotToken: "sealed",
  sealedAppToken: null,
  realmUrl: null,
  botEmail: null,
  chatId: null,
  chatTitle: null,
  linkCode: "link-1",
  quiet: false,
  ownerUserId: "u-1",
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
});

const binding = (id: string, chatroomId: string, runId: string, threadKey = ""): ChatBinding => ({
  id,
  chatroomId,
  runId,
  threadKey,
  agentName: "Ada",
  taskTitle: "t",
  runUrl: null,
  state: "active",
  quiet: false,
  createdAt: T0,
  closedAt: null,
});

test("two opens racing on one room: the index decides, exactly one lands", async () => {
  const handle = await makeTestDb();
  const store = drizzleChatStore(handle);
  try {
    await store.createChatroom(room("chr-1"));
    // Both calls see a room with no active binding — which is precisely what the conditional
    // insert's subquery checked, and precisely why both used to land: under READ COMMITTED a
    // subquery reads the same snapshot as its racer. The partial unique index is what makes
    // the answer exactly one, so a mention has one run to route to.
    const outcomes = await Promise.all([
      store.createBinding(binding("cb-a", "chr-1", "r-a")),
      store.createBinding(binding("cb-b", "chr-1", "r-b")),
    ]);
    assertEquals(outcomes.filter((landed) => landed).length, 1);
    assertEquals((await store.listActiveBindings("chr-1")).length, 1);
    // The loser wrote nothing at all.
    const won = outcomes[0] ? "r-a" : "r-b";
    const lost = outcomes[0] ? "r-b" : "r-a";
    assertEquals((await store.getBindingByRun(won))?.state, "active");
    assertEquals(await store.getBindingByRun(lost), null);
  } finally {
    await handle.close();
  }
});

test("createBinding lands only while the conversation has no active binding", async () => {
  const handle = await makeTestDb();
  const store = drizzleChatStore(handle);
  try {
    await store.createChatroom(room("chr-1"));
    await store.createChatroom(room("chr-2"));
    assertEquals(await store.createBinding(binding("cb-1", "chr-1", "r-1")), true);
    assertEquals(await store.createBinding(binding("cb-2", "chr-1", "r-2")), false);
    assertEquals(await store.createBinding(binding("cb-3", "chr-2", "r-3")), true);
    // Another conversation of the same room is another binding.
    assertEquals(await store.createBinding(binding("cb-5", "chr-1", "r-5", "101")), true);
    assertEquals(await store.createBinding(binding("cb-6", "chr-1", "r-6", "101")), false);
    assertEquals((await store.listActiveBindings("chr-1")).map((b) => b.id), ["cb-1", "cb-5"]);
    // A close is conditional: of two racing closes only the first closes it.
    assertEquals(await store.closeBinding("cb-1", T0), true);
    assertEquals(await store.closeBinding("cb-1", T0), false);
    assertEquals((await store.getBindingByRun("r-1"))?.closedAt, T0);
    assertEquals((await store.listActiveBindings("chr-1")).map((b) => b.id), ["cb-5"]);
    assertEquals(await store.createBinding(binding("cb-4", "chr-1", "r-4")), true);
    assertEquals((await store.getBindingByRun("r-4"))?.state, "active");
    assertEquals(await store.getBindingByRun("r-2"), null, "the refused insert wrote nothing");

    const cursor = { chatroomId: "chr-1", queueId: null, lastMessageId: null, updatedAt: T0 };
    await store.saveCursor({ ...cursor, offset: 5 });
    await store.saveCursor({ ...cursor, offset: 9, queueId: "q-1", lastMessageId: 2 ** 40 });
    const saved = await store.getCursor("chr-1");
    assertEquals([saved?.offset, saved?.queueId, saved?.lastMessageId], [9, "q-1", 2 ** 40]);

    const renamed = { ...room("chr-1"), name: "renamed", chatId: "-1" };
    await store.saveChatroom(renamed);
    assertEquals((await store.getChatroom("chr-1"))?.name, "renamed");
    assertEquals((await store.listChatrooms()).map((r) => r.id), ["chr-1", "chr-2"]);
  } finally {
    await handle.close();
  }
});
