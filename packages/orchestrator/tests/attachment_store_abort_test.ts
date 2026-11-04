import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PatchStore } from "@ryph/forge/patch-store";
import { patchStoreAttachments } from "../src/adapters/attachment_store/patch_store.ts";

test("attachment store propagates the signal and cleans staging after an aborted put", async () => {
  const controller = new AbortController();
  const reason = new Error("deadline");
  let staging = "";
  const store: PatchStore = {
    async put(key, source, signal) {
      expect(key).toBe("blob");
      expect(signal).toBe(controller.signal);
      staging = source;
      expect(await readFile(source, "utf8")).toBe("bytes");
      controller.abort(reason);
      signal!.throwIfAborted();
    },
    get(_key, signal) {
      expect(signal).toBe(controller.signal);
      return Promise.resolve(null);
    },
    delete(_key, signal) {
      expect(signal).toBe(controller.signal);
      return Promise.resolve();
    },
  };
  const attachments = patchStoreAttachments(store);
  await attachments.get("blob", controller.signal);
  await attachments.delete("blob", controller.signal);
  await expect(attachments.put("blob", new TextEncoder().encode("bytes"), controller.signal))
    .rejects.toBe(reason);
  expect(staging).not.toBe("");
  await expect(access(dirname(staging))).rejects.toThrow();
});

test("attachment store refuses pre-aborted writes before invoking storage", async () => {
  let called = false;
  const attachments = patchStoreAttachments({
    put() {
      called = true;
      return Promise.resolve();
    },
    get() {
      return Promise.resolve(null);
    },
    async delete() {},
  });
  const reason = new Error("deadline");
  await expect(attachments.put("blob", new Uint8Array(), AbortSignal.abort(reason)))
    .rejects.toBe(reason);
  expect(called).toBe(false);
});
