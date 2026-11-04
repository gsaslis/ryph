import { expect, it } from "vitest";
import { artifactThumbnailHref, ThumbnailState } from "./thumbnail-state.svelte";

it("addresses a screenshot, not a document, with an encoded id and version", () => {
  expect(artifactThumbnailHref("a/b", 2)).toBe("/artifacts/a%2Fb/v/2/thumbnail");
});

it("keeps a neutral placeholder until load, and stops at failure without retries", () => {
  const image = new ThumbnailState(artifactThumbnailHref("art_1", 1));
  expect(image.loaded).toBe(false);
  expect(image.failed).toBe(false);
  image.load();
  expect(image.loaded).toBe(true);
  image.fail();
  expect(image.failed).toBe(true);
  expect(image.loaded).toBe(false);
  image.load();
  expect(image.loaded).toBe(false);
});

it("a new id or version starts fresh and old events cannot fail its replacement", () => {
  const previous = new ThumbnailState(artifactThumbnailHref("art_1", 1));
  previous.fail();
  for (const [id, version] of [["art_1", 2], ["art_2", 1]] as const) {
    const next = new ThumbnailState(artifactThumbnailHref(id, version));
    expect(next.failed).toBe(false);
    expect(next.loaded).toBe(false);
    previous.fail();
    next.load();
    expect(next.failed).toBe(false);
    expect(next.loaded).toBe(true);
  }
});
