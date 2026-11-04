// Sealing and unsealing: the round trip, the binding, per-class keys, tamper detection, and the
// master-key format gate.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { decryptSecret, deriveSealingKey, encryptSecret, importMasterKey } from "../src/mod.ts";
import { associatedData, sealingKeyInfo } from "../src/seal.ts";

const MASTER_HEX = "a".repeat(64);
const BINDING = { id: "ms-1", url: "https://mcp.example.com/mcp" };

const keyOf = async (cls = "mcp-credentials", hex = MASTER_HEX) =>
  await deriveSealingKey(await importMasterKey(hex), cls);

test("a sealed secret round-trips, and two seals of one plaintext differ (fresh IVs)", async () => {
  const key = await keyOf();
  const sealed = await encryptSecret(key, "sk-ant-verysecret", BINDING);
  assertEquals(await decryptSecret(key, sealed, BINDING), "sk-ant-verysecret");
  assert(sealed.startsWith("v2."));
  assert(!sealed.includes("verysecret"));

  const sealedAgain = await encryptSecret(key, "sk-ant-verysecret", BINDING);
  assert(sealed !== sealedAgain, "a reused IV would forfeit GCM's guarantees");
  assertEquals(await decryptSecret(key, sealedAgain, BINDING), "sk-ant-verysecret");
});

test("field order in a binding does not matter; its contents do", async () => {
  const key = await keyOf();
  const sealed = await encryptSecret(key, "s3cret-value", { id: "pk-1", provider: "openai" });
  assertEquals(
    await decryptSecret(key, sealed, { provider: "openai", id: "pk-1" }),
    "s3cret-value",
  );
});

test("a changed destination or row id does not open (the binding is authenticated)", async () => {
  const key = await keyOf("provider-keys");
  const binding = { id: "pk-1", provider: "groq", baseUrl: "https://api.groq.com/openai/v1" };
  const sealed = await encryptSecret(key, "gsk-secret", binding);
  const variants = [
    { ...binding, baseUrl: "https://attacker.example.com/v1" },
    { ...binding, provider: "openai" },
    { ...binding, id: "pk-2" },
    { ...binding, baseUrl: null },
    { id: "pk-1", provider: "groq" }, // a field dropped
    { ...binding, extra: null }, // a field added
  ];
  for (const variant of variants) {
    await assertRejects(() => decryptSecret(key, sealed, variant));
  }
  assertEquals(await decryptSecret(key, sealed, binding), "gsk-secret");
});

test("the associated data cannot be collided by moving characters between fields", () => {
  const a = associatedData("c", { a: "x.y", b: "z" });
  const b = associatedData("c", { a: "x", b: "y.z" });
  assertNotEquals(new TextDecoder().decode(a), new TextDecoder().decode(b));
  const c = associatedData("c", { a: null });
  const d = associatedData("c", { a: "null" });
  assertNotEquals(new TextDecoder().decode(c), new TextDecoder().decode(d));
});

test("each class derives its own key: one master, two classes, no cross-opening", async () => {
  const master = await importMasterKey(MASTER_HEX);
  const mcp = await deriveSealingKey(master, "mcp-credentials");
  const proxy = await deriveSealingKey(master, "provider-keys");
  const sealed = await encryptSecret(mcp, "the-secret", BINDING);
  await assertRejects(() => decryptSecret(proxy, sealed, BINDING));
  // Not just the label in the associated data: the AES keys themselves differ. A value sealed
  // under one class's key with the other class's label folded in still does not open.
  const forged = await encryptSecret({ secretClass: "provider-keys", key: mcp.key }, "x", BINDING);
  await assertRejects(() => decryptSecret(proxy, forged, BINDING));
  assertEquals(sealingKeyInfo("mcp-credentials"), "ryph sealed mcp-credentials v2");
});

test("derivation is deterministic: a second import of the master opens the first's values", async () => {
  const sealed = await encryptSecret(await keyOf(), "the-secret", BINDING);
  assertEquals(await decryptSecret(await keyOf(), sealed, BINDING), "the-secret");
});

test("a class label is a slug", async () => {
  const master = await importMasterKey(MASTER_HEX);
  await assertRejects(() => deriveSealingKey(master, "Provider Keys"), Error, "class");
  await assertRejects(() => deriveSealingKey(master, ""), Error, "class");
});

test("a tampered row throws instead of yielding garbage (GCM authenticates)", async () => {
  const key = await keyOf();
  const sealed = await encryptSecret(key, "sk-ant-verysecret", BINDING);
  const [v, iv, ct] = sealed.split(".");
  const tampered = `${v}.${iv}.${ct.slice(0, -4)}AAA=`;
  await assertRejects(() => decryptSecret(key, tampered, BINDING));
});

test("a wrong master key cannot unseal", async () => {
  const sealed = await encryptSecret(await keyOf(), "sk-ant-verysecret", BINDING);
  const other = await keyOf("mcp-credentials", "b".repeat(64));
  await assertRejects(() => decryptSecret(other, sealed, BINDING));
});

test("the master key must be exactly 64 hex chars — a truncated key must not 'work'", async () => {
  await assertRejects(() => importMasterKey("abc123"), Error, "64 hex characters");
  await assertRejects(() => importMasterKey("g".repeat(64)), Error, "64 hex characters");
});

test("an unknown sealed format is refused", async () => {
  const key = await keyOf();
  await assertRejects(() => decryptSecret(key, "v9.xx.yy", BINDING), Error, "format");
  await assertRejects(() => decryptSecret(key, "not-sealed-at-all", BINDING), Error, "format");
});
