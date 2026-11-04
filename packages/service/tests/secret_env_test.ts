// A credential from its variable or the file `<name>_FILE` names, for every service that takes one.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFromEnv } from "../src/mod.ts";

test("a secret is its variable, else its file's contents, and a bad file is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "ryph-secret-"));
  try {
    const file = join(dir, "token");
    writeFileSync(file, "from-file\n");
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    assertEquals(secretFromEnv(env({ T: " set ", T_FILE: file }), "T"), "set");
    assertEquals(secretFromEnv(env({ T_FILE: file }), "T"), "from-file");
    assertEquals(secretFromEnv(env({}), "T"), undefined);
    writeFileSync(file, "\n");
    assertThrows(() => secretFromEnv(env({ T_FILE: file }), "T"), Error, "is empty");
    assertThrows(
      () => secretFromEnv(env({ T_FILE: join(dir, "missing") }), "T"),
      Error,
      "T_FILE=",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
