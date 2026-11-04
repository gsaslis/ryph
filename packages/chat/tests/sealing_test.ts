// Sealed chatroom secrets: bound to the room, which secret, its platform and a Zulip realm; and
// never written back by a rename or an archive.

import { assertEquals, assertRejects } from "@std/assert";
import { importMasterKey } from "@ryph/sealed";
import { drizzleChatStore } from "../src/adapters/store/drizzle.ts";
import { tokenBinding } from "../src/core/service.ts";
import type { Chatroom } from "../src/core/types.ts";
import { makeChatSealer } from "../src/sealing.ts";
import { reusableDbSuite } from "./reusable_db.ts";

const { test, makeTestDb } = reusableDbSuite("chat sealing");

const MASTER_HEX = "c4".repeat(32);
const T0 = "2026-09-01T00:00:00.000Z";

const room = (overrides: Partial<Chatroom>): Chatroom => ({
  id: "chr-1",
  name: "room",
  kind: "telegram",
  botUsername: "ryph_bot",
  botId: "1",
  sealedBotToken: "",
  sealedAppToken: null,
  realmUrl: null,
  botEmail: null,
  chatId: null,
  chatTitle: null,
  linkCode: null,
  quiet: false,
  ownerUserId: "u-1",
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  ...overrides,
});

test("a room secret opens only for its room, its slot and its realm", async () => {
  const sealer = makeChatSealer(await importMasterKey(MASTER_HEX));
  const zulip = room({ kind: "zulip", realmUrl: "https://acme.zulipchat.com" });
  const sealed = await sealer.seal("zulip-api-key", tokenBinding(zulip, "bot"));
  assertEquals(await sealer.unseal(sealed, tokenBinding(zulip, "bot")), "zulip-api-key");
  for (
    const [moved, field] of [
      [{ ...zulip, realmUrl: "https://attacker.example" }, "bot"],
      [{ ...zulip, id: "chr-2" }, "bot"],
      [{ ...zulip, kind: "slack" as const }, "bot"],
      [zulip, "app"],
    ] as const
  ) {
    await assertRejects(() => sealer.unseal(sealed, tokenBinding(moved, field)));
  }
});

test("a rename or an archive never writes a room's sealed secrets back", async () => {
  const handle = await makeTestDb();
  const store = drizzleChatStore(handle);
  try {
    await store.createChatroom(room({ id: "chr-1", sealedBotToken: "v2.as.read" }));
    const read = (await store.getChatroom("chr-1"))!;
    await store.saveChatroom({
      ...read,
      name: "renamed",
      archivedAt: T0,
      sealedBotToken: "v2.other.value",
      sealedAppToken: "v2.other.app",
    });
    const after = (await store.getChatroom("chr-1"))!;
    assertEquals([after.name, after.archivedAt], ["renamed", T0]);
    assertEquals([after.sealedBotToken, after.sealedAppToken], ["v2.as.read", null]);
  } finally {
    await handle.close();
  }
});
