// RYPH_LOCAL_REPO_ROOT is the line around what an in-process forge may read off this disk, so the
// host settles it once at boot: a real absolute directory, or the boot fails saying which.

import { test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveLocalRoot } from "../src/main.ts";

test("a local root resolves through symlinks to the real directory", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ryph-root-")));
  try {
    await mkdir(join(dir, "code"));
    await symlink(join(dir, "code"), join(dir, "link"));
    // The forge compares a repo's real path against this, so a link must not stand in for it.
    assertEquals(resolveLocalRoot(join(dir, "link")), join(dir, "code"));
    assertEquals(resolveLocalRoot(dir), dir);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a local root that is missing, a file, or relative fails the boot by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-root-"));
  try {
    await writeFile(join(dir, "file"), "");
    assertThrows(() => resolveLocalRoot(join(dir, "nope")), Error, "does not exist");
    assertThrows(() => resolveLocalRoot(join(dir, "file")), Error, "is not a directory");
    assertThrows(() => resolveLocalRoot("code"), Error, "must be an absolute path");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a local root of off is no root, not a path to check", () => {
  assertEquals(resolveLocalRoot("off"), null);
  assertEquals(resolveLocalRoot("OFF"), null);
  assertEquals(resolveLocalRoot(" off "), null);
});
