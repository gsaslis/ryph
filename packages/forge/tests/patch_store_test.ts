import { test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { silentDiagnostics } from "./util.ts";

test("put files the source under the key; get streams it back; a put consumes the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const store = localFsPatchStore(`${root}/patches`, silentDiagnostics());
    const staged = `${root}/staged.bundle`;
    await writeFile(staged, "bundle-bytes");

    await store.put("r-1/abc.bundle", staged);
    const stream = await store.get("r-1/abc.bundle");
    assert(stream !== null);
    assertEquals(await new Response(stream).text(), "bundle-bytes");
    // The source was moved, not copied.
    assertEquals(
      ((await assertRejects(() => stat(staged))) as NodeJS.ErrnoException).code,
      "ENOENT",
    );

    assertEquals(await store.get("r-1/nope.bundle"), null);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("keys cannot traverse out of the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const store = localFsPatchStore(`${root}/patches`, silentDiagnostics());
    await assertRejects(() => store.get("../escape"), Error, "invalid patch key");
    await assertRejects(() => store.put("a/../../b", `${root}/x`), Error, "invalid patch key");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("delete removes what is under the key, and a key already gone is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const store = localFsPatchStore(`${root}/patches`, silentDiagnostics());
    const staged = `${root}/staged.bin`;
    await writeFile(staged, "image-bytes");
    await store.put("attachments/r-1/att-1", staged);

    await store.delete("attachments/r-1/att-1");
    assertEquals(await store.get("attachments/r-1/att-1"), null);
    await store.delete("attachments/r-1/att-1");
    await assertRejects(() => store.delete("../escape"), Error, "invalid patch key");
  } finally {
    await rm(root, { recursive: true });
  }
});
