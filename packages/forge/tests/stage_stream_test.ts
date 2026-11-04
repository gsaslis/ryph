// Staging a stored bundle into a fresh file: a staging file that cannot be created must not
// leave the stored bundle's stream open. Its FileHandle, collected while open, is an uncaught
// error under Bun (and kills a Node process), not a quiet leak.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageStream } from "../src/http/bundle_intake.ts";

test("a staging file that cannot be created cancels the stream it was to hold", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    let cancelled = false;
    const source = () =>
      new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode("bundle-bytes")),
        cancel: () => void (cancelled = true),
      });
    await writeFile(`${root}/taken.bundle`, "already here");
    await assertRejects(() => stageStream(source(), `${root}/taken.bundle`));
    assert(cancelled, "the stream was left open");
    assertEquals(await readFile(`${root}/taken.bundle`, "utf8"), "already here");

    cancelled = false;
    await assertRejects(() => stageStream(source(), `${root}/no/such/dir/x.bundle`));
    assert(cancelled, "the stream was left open");

    const whole = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("bundle-bytes"));
        c.close();
      },
    });
    await stageStream(whole, `${root}/fresh.bundle`);
    assertEquals(await readFile(`${root}/fresh.bundle`, "utf8"), "bundle-bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
