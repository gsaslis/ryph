import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintedFile, writeSecretFile } from "../src/secret_file.ts";

test("a minted file is never left empty: an empty one counts as absent and is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "service-mint-"));
  try {
    const path = join(dir, "token");
    writeFileSync(path, ""); // what a crash between create and write used to leave
    const token = mintedFile(path, () => "fresh");
    assertEquals(token, "fresh");
    assertEquals(readFileSync(path, "utf8"), "fresh\n");
    // A file that is there and whole wins over any mint, and nothing is left beside it.
    assertEquals(mintedFile(path, () => "other"), "fresh");
    assertEquals(readdirSync(dir), ["token"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret file replaces what was there, owner-only even over a wider file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-secret-"));
  try {
    const path = join(dir, "key");
    writeFileSync(path, "old\n", { mode: 0o644 });
    await writeSecretFile(path, "new\n");
    assertEquals(readFileSync(path, "utf8"), "new\n");
    assertEquals(statSync(path).mode & 0o777, 0o600);
    assertEquals(readdirSync(dir), ["key"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
