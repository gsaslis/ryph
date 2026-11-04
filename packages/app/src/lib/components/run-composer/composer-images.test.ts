import { describe, expect, it } from "vitest";
import type { UploadedAttachment } from "$lib/api/attachments";
import { ComposerImages, type Uploader } from "./composer-images.svelte";

// The images in the message box: each uploads as it is added, the message waits for all of them,
// and what is sent is the ids of the ones that made it, in the order they show.

type Pending = {
  file: File;
  progress: (fraction: number) => void;
  signal: AbortSignal;
  resolve: (a: UploadedAttachment) => void;
  reject: (e: Error) => void;
};

/** An uploader whose uploads finish when the test says so. */
function uploads() {
  const pending: Pending[] = [];
  const upload: Uploader = (file, progress, signal) =>
    new Promise((resolve, reject) => pending.push({ file, progress, signal, resolve, reject }));
  return { upload, pending };
}

function previews() {
  const live = new Set<string>();
  let n = 0;
  return {
    live,
    create: () => {
      const url = `blob:${++n}`;
      live.add(url);
      return url;
    },
    revoke: (url: string) => live.delete(url),
  };
}

const image = (name: string, type = "image/png", size = 10) =>
  new File([new Uint8Array(size)], name, { type });

const done = (id: string): UploadedAttachment => ({ id, mime: "image/png", bytes: 10 });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ComposerImages", () => {
  it("uploads each image as it is added, and is ready once all have answered", async () => {
    const u = uploads();
    const images = new ComposerImages(u.upload, null, previews());
    expect(images.add([image("a.png"), image("b.png")])).toEqual([]);
    expect(images.items.map((i) => i.state)).toEqual(["uploading", "uploading"]);
    expect(images.settled).toBe(false);

    u.pending[0].progress(0.5);
    expect(images.items[0].progress).toBe(0.5);

    // The second answers first: the ids still follow the chips.
    u.pending[1].resolve(done("a-2"));
    await flush();
    expect(images.ids).toEqual(["a-2"]);
    expect(images.ready).toBe(false);
    u.pending[0].resolve(done("a-1"));
    await flush();
    expect(images.ids).toEqual(["a-1", "a-2"]);
    expect(images.settled).toBe(true);
    expect(images.ready).toBe(true);
  });

  it("refuses what is not an image it takes, and past ten, without uploading it", () => {
    const u = uploads();
    const images = new ComposerImages(u.upload, null, previews());
    const refused = images.add([
      image("logo.svg", "image/svg+xml"),
      ...Array.from({ length: 12 }, (_, i) => image(`${i}.png`)),
    ]);
    expect(images.items).toHaveLength(10);
    expect(u.pending).toHaveLength(10);
    expect(refused).toEqual([
      "logo.svg is not a PNG, JPEG, GIF or WebP image",
      "A message takes at most 10 images; 2 were left out",
    ]);
  });

  it("holds a failed upload with its reason until it is retried", async () => {
    const u = uploads();
    const images = new ComposerImages(u.upload, null, previews());
    images.add([image("a.png")]);
    u.pending[0].reject(new Error("the run has ended"));
    await flush();
    expect(images.items[0]).toMatchObject({ state: "failed", error: "the run has ended" });
    expect(images.settled).toBe(true);
    expect(images.ready).toBe(false);

    images.retry(images.items[0].key);
    expect(images.items[0]).toMatchObject({ state: "uploading", error: null });
    expect(u.pending).toHaveLength(2);
    expect(u.pending[1].file.name).toBe("a.png");
    u.pending[1].resolve(done("a-1"));
    await flush();
    expect(images.ready).toBe(true);
    expect(images.ids).toEqual(["a-1"]);
  });

  it("cancels an upload removed mid-flight, and never sends its id", async () => {
    const u = uploads();
    const p = previews();
    const images = new ComposerImages(u.upload, null, p);
    images.add([image("a.png"), image("b.png")]);
    images.remove(images.items[0].key);
    expect(u.pending[0].signal.aborted).toBe(true);
    u.pending[0].resolve(done("a-1"));
    u.pending[1].resolve(done("a-2"));
    await flush();
    expect(images.ids).toEqual(["a-2"]);
    expect(p.live.size).toBe(1);
  });

  it("empties on clear and lets go of every preview", async () => {
    const u = uploads();
    const p = previews();
    const images = new ComposerImages(u.upload, null, p);
    images.add([image("a.png"), image("b.png")]);
    u.pending[0].resolve(done("a-1"));
    await flush();
    images.clear();
    expect(images.items).toEqual([]);
    expect(images.ids).toEqual([]);
    expect(p.live.size).toBe(0);
    expect(u.pending[1].signal.aborted).toBe(true);
  });

  it("takes back a finished upload when its chip is removed or the box goes away, never a sent one", async () => {
    const u = uploads();
    const discarded: string[] = [];
    const images = new ComposerImages(u.upload, (id) => {
      discarded.push(id);
      return Promise.reject(new Error("offline"));
    }, previews());
    images.add([image("a.png"), image("b.png"), image("c.png")]);
    u.pending[0].resolve(done("a-1"));
    u.pending[1].resolve(done("a-2"));
    await flush();
    // Removed: taken back, and a failed take-back is nobody's problem here.
    images.remove(images.items[0].key);
    expect(discarded).toEqual(["a-1"]);
    // Still uploading: nothing to take back yet, only an upload to cancel.
    images.remove(images.items[1].key);
    expect(discarded).toEqual(["a-1"]);
    // Sent: clear is what follows a send, and those ids belong to the message now.
    images.clear();
    expect(discarded).toEqual(["a-1"]);
    images.add([image("d.png")]);
    u.pending[3].resolve(done("a-4"));
    await flush();
    images.dispose();
    expect(discarded).toEqual(["a-1", "a-4"]);
  });

  it("holds the files behind its chips, in order, until they leave", () => {
    const u = uploads();
    const images = new ComposerImages(u.upload, null, previews());
    const [a, b, c] = [image("a.png"), image("b.png"), image("c.png")];
    images.add([a, b, c]);
    images.remove(images.items[1].key);
    expect(images.files).toEqual([a, c]);
    images.clear();
    expect(images.files).toEqual([]);
  });
});
