// The master key file: owner-only, and never written into a file someone else could read.

import { test } from "bun:test";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveEgressKey,
  loadOrCreateSecretsKey,
  mintHexKey,
  secretsKeyPath,
  storeSecretsKey,
} from "../src/secrets_key.ts";

test("a wider key file is replaced owner-only, never written into", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "ryph-key-"));
  try {
    const path = join(dir, "secrets.key");
    await writeFile(path, "", { mode: 0o644 });
    const before = await open(path, "r");
    const hex = mintHexKey();
    try {
      assertEquals(await storeSecretsKey(`pglite:${join(dir, "data")}`, hex), path);
      assertEquals(await before.readFile("utf8"), "");
    } finally {
      await before.close();
    }
    assertEquals((await stat(path)).mode & 0o777, 0o600);
    assertEquals(await readFile(path, "utf8"), `${hex}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RYPH_SECRETS_KEY_FILE names the key's file for any database, and must be absolute", () => {
  const env = { RYPH_SECRETS_KEY_FILE: "/var/lib/ryph/secrets.key" };
  assertEquals(secretsKeyPath("postgres:///ryph", env), "/var/lib/ryph/secrets.key");
  assertEquals(secretsKeyPath("pglite:/data/ryph", env), "/var/lib/ryph/secrets.key");
  // Without it, postgres:// has nowhere to keep one and PGlite keeps it beside its data.
  assertEquals(secretsKeyPath("postgres://db/ryph", {}), null);
  assertEquals(secretsKeyPath("pglite:/data/ryph", {}), "/data/secrets.key");
  assertThrows(
    () => secretsKeyPath("postgres:///ryph", { RYPH_SECRETS_KEY_FILE: "secrets.key" }),
    Error,
    "must be an absolute path",
  );
});

test("a postgres:// database mints its key into RYPH_SECRETS_KEY_FILE once, then reads it", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "ryph-key-"));
  const saved = { file: process.env.RYPH_SECRETS_KEY_FILE, key: process.env.RYPH_SECRETS_KEY };
  try {
    delete process.env.RYPH_SECRETS_KEY;
    const path = join(dir, "state", "secrets.key");
    process.env.RYPH_SECRETS_KEY_FILE = path;
    const first = await loadOrCreateSecretsKey("postgres:///ryph");
    assertEquals(first?.created, true);
    assertEquals(first?.path, path);
    assertEquals((await stat(path)).mode & 0o777, 0o600);
    const second = await loadOrCreateSecretsKey("postgres:///ryph");
    assertEquals(second, { hex: first!.hex, path, created: false });
  } finally {
    if (saved.file === undefined) delete process.env.RYPH_SECRETS_KEY_FILE;
    else process.env.RYPH_SECRETS_KEY_FILE = saved.file;
    if (saved.key !== undefined) process.env.RYPH_SECRETS_KEY = saved.key;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the egress claim key is derived from the master key: stable, distinct, and not it", () => {
  const master = mintHexKey();
  const derived = deriveEgressKey(master);
  assertEquals(/^[0-9a-f]{64}$/.test(derived), true);
  assertEquals(deriveEgressKey(master), derived);
  assertEquals(derived === master, false);
  assertEquals(deriveEgressKey(mintHexKey()) === derived, false);
});
