import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lazyThumbnail, THUMBNAIL_RETRY_DELAYS_MS } from "./lazy-thumbnail";
import { ThumbnailState } from "./thumbnail-state.svelte";

let intersect: (entries: { isIntersecting: boolean }[]) => void;
const disconnect = vi.fn();
beforeEach(() => {
  disconnect.mockClear();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function imageNode(): HTMLImageElement {
  return Object.assign(new EventTarget(), { src: "" }) as HTMLImageElement;
}

it("waits for visibility, then a fresh session, before requesting the image once", async () => {
  let resolve!: (available: boolean) => void;
  const ready = vi.fn(() => new Promise<boolean>((done) => resolve = done));
  const node = imageNode();
  const state = new ThumbnailState("/thumbnail");
  const stop = lazyThumbnail(state, ready)(node);
  expect(ready).not.toHaveBeenCalled();
  intersect([{ isIntersecting: false }]);
  expect(ready).not.toHaveBeenCalled();
  intersect([{ isIntersecting: true }]);
  expect(ready).toHaveBeenCalledOnce();
  expect(node.src).toBe("");
  resolve(true);
  await Promise.resolve();
  expect(node.src).toBe("/thumbnail");
  intersect([{ isIntersecting: true }]);
  expect(ready).toHaveBeenCalledOnce();
  stop?.();
});

it("does not request an image after it was unmounted during refresh", async () => {
  let resolve!: (available: boolean) => void;
  const node = imageNode();
  const state = new ThumbnailState("/old-thumbnail");
  const stop = lazyThumbnail(state, () => new Promise((done) => resolve = done))(node);
  intersect([{ isIntersecting: true }]);
  stop?.();
  resolve(true);
  await Promise.resolve();
  expect(node.src).toBe("");
  expect(disconnect).toHaveBeenCalled();
});

it.each([false, "reject"])("shows the placeholder when session readiness is %s", async (result) => {
  const node = imageNode();
  const state = new ThumbnailState("/thumbnail");
  const ready = vi.fn(() =>
    result === false ? Promise.resolve(false) : Promise.reject(new Error("offline"))
  );
  const stop = lazyThumbnail(state, ready)(node);
  intersect([{ isIntersecting: true }]);
  await Promise.resolve();
  expect(state.failed).toBe(true);
  expect(node.src).toBe("");
  intersect([{ isIntersecting: true }]);
  expect(ready).toHaveBeenCalledOnce();
  stop?.();
});

it("caps errors at four jittered retries with fresh-session checks and distinct URLs", async () => {
  const node = imageNode();
  const state = new ThumbnailState("/thumbnail");
  const ready = vi.fn(() => Promise.resolve(true));
  const stop = lazyThumbnail(state, ready)(node);
  intersect([{ isIntersecting: true }]);
  await Promise.resolve();
  for (const [index, delay] of THUMBNAIL_RETRY_DELAYS_MS.entries()) {
    node.dispatchEvent(new Event("error"));
    expect(state.failed).toBe(false);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(ready).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(node.src).toBe(`/thumbnail?retry=${index + 1}`);
  }
  node.dispatchEvent(new Event("error"));
  expect(state.failed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000_000);
  expect(ready).toHaveBeenCalledTimes(5);
  stop?.();
});

it("pauses retries outside the viewport and cancels a pending retry on cleanup", async () => {
  const node = imageNode();
  const ready = vi.fn(() => Promise.resolve(true));
  const stop = lazyThumbnail(new ThumbnailState("/thumbnail"), ready)(node);
  intersect([{ isIntersecting: true }]);
  await Promise.resolve();
  node.dispatchEvent(new Event("error"));
  expect(vi.getTimerCount()).toBe(1);
  intersect([{ isIntersecting: false }]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ready).toHaveBeenCalledOnce();
  intersect([{ isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ready).toHaveBeenCalledTimes(2);
  node.dispatchEvent(new Event("error"));
  stop?.();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ready).toHaveBeenCalledTimes(2);
});

it("stops retrying as soon as an image loads", async () => {
  const node = imageNode();
  const state = new ThumbnailState("/thumbnail");
  const ready = vi.fn(() => Promise.resolve(true));
  const stop = lazyThumbnail(state, ready)(node);
  intersect([{ isIntersecting: true }]);
  await Promise.resolve();
  node.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(2_000);
  node.dispatchEvent(new Event("load"));
  expect(state.loaded).toBe(true);
  expect(state.failed).toBe(false);
  node.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ready).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  stop?.();
});
