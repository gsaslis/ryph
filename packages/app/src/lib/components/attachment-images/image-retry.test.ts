import { describe, expect, it } from "vitest";
import {
  attemptUrl,
  type Clock,
  ImageRetry,
  RETRY_DELAY_MS,
  RETRY_WINDOW_MS,
} from "./image-retry.svelte";

// An image a ref names may not be uploaded yet when it is first read: it is asked for again for a
// while, then shown as failed, and a click asks once more.

function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const c: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  /** Moves time on, firing whatever falls due. */
  function advance(ms: number) {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  }
  return { c, advance, pending: () => timers.size };
}

describe("ImageRetry", () => {
  it("asks again after a failure, and shows the image once one attempt loads", () => {
    const { c, advance } = clock();
    const load = new ImageRetry(c);
    expect(load.state).toBe("loading");
    load.errored();
    expect(load.attempt).toBe(0);
    advance(RETRY_DELAY_MS);
    expect(load.attempt).toBe(1);
    expect(load.state).toBe("loading");
    load.loaded();
    expect(load.state).toBe("loaded");
  });

  it("gives up once the window after the first failure has passed", () => {
    const { c, advance } = clock();
    const load = new ImageRetry(c);
    while (load.state === "loading") {
      load.errored();
      advance(RETRY_DELAY_MS);
    }
    expect(load.state).toBe("failed");
    expect(load.attempt).toBe(RETRY_WINDOW_MS / RETRY_DELAY_MS);
  });

  it("a click on a failed image starts a fresh window", () => {
    const { c, advance } = clock();
    const load = new ImageRetry(c);
    while (load.state === "loading") {
      load.errored();
      advance(RETRY_DELAY_MS);
    }
    const before = load.attempt;
    load.retry();
    expect(load.state).toBe("loading");
    expect(load.attempt).toBe(before + 1);
    load.errored();
    advance(RETRY_DELAY_MS);
    expect(load.state).toBe("loading");
    expect(load.attempt).toBe(before + 2);
  });

  it("a repeated error for the same attempt schedules only one retry, and dispose cancels it", () => {
    const { c, pending } = clock();
    const load = new ImageRetry(c);
    load.errored();
    load.errored();
    expect(pending()).toBe(1);
    load.dispose();
    expect(pending()).toBe(0);
  });

  it("only a fetched URL gets the retry query", () => {
    expect(attemptUrl("/api/v1/runs/r/attachments/img-1", 0)).toBe(
      "/api/v1/runs/r/attachments/img-1",
    );
    expect(attemptUrl("/api/v1/runs/r/attachments/img-1", 2)).toBe(
      "/api/v1/runs/r/attachments/img-1?attempt=2",
    );
    expect(attemptUrl("/a?b=1", 1)).toBe("/a?b=1&attempt=1");
    expect(attemptUrl("data:image/png;base64,AA", 3)).toBe("data:image/png;base64,AA");
  });
});
