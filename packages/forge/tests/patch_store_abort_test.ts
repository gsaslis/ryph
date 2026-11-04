import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { s3PatchStore } from "../src/adapters/patch_store/s3.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";

const diag = { debug() {}, warn() {} };

for (const method of ["get", "put", "delete"] as const) {
  test(`s3 ${method} cancels the in-flight HTTP request with the supplied signal`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ryph-abort-test-"));
    try {
      const source = join(dir, "source");
      await writeFile(source, "bytes");
      const controller = new AbortController();
      const reason = new Error("deadline");
      let observed: AbortSignal | null | undefined;
      const store = s3PatchStore({
        config: {
          endpoint: "https://objects.example.com",
          region: "us-east-1",
          bucket: "test",
          accessKeyId: "key",
          secretAccessKey: "secret",
        },
        diag,
        fetch: ((_input, init) => {
          observed = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            observed!.addEventListener("abort", () => reject(observed!.reason), { once: true });
            controller.abort(reason);
          });
        }) as typeof fetch,
      });
      const operation = method === "put"
        ? store.put("blob", source, controller.signal)
        : store[method]("blob", controller.signal);
      await expect(operation).rejects.toBe(reason);
      expect(observed).toBe(controller.signal);
      expect(observed?.aborted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("local store rejects pre-aborted operations without modifying files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-abort-test-"));
  try {
    const source = join(dir, "source");
    await writeFile(source, "bytes");
    const store = localFsPatchStore(dir, diag);
    const reason = new Error("deadline");
    const signal = AbortSignal.abort(reason);
    await expect(store.put("blob", source, signal)).rejects.toBe(reason);
    await expect(store.get("source", signal)).rejects.toBe(reason);
    await expect(store.delete("source", signal)).rejects.toBe(reason);
    expect(await readFile(source, "utf8")).toBe("bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local store read stream is cancelled after get returns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-abort-test-"));
  try {
    await writeFile(join(dir, "blob"), new Uint8Array(1024 * 1024));
    const controller = new AbortController();
    const stream = await localFsPatchStore(dir, diag).get("blob", controller.signal);
    controller.abort();
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
