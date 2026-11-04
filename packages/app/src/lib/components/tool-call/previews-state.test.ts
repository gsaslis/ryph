import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewsState } from "./previews-context.svelte";

const preview = {
  id: "a".repeat(32),
  port: 5173,
  label: "App",
  url: `http://${"a".repeat(32)}.localhost:12345`,
};
let page: EventTarget & { hidden: boolean };
beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", page);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps the list stable through grant renewal and transient discovery failures", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews: [preview] }));
  vi.stubGlobal("fetch", fetcher);
  const state = new PreviewsState();
  let grant = "first";
  state.called("r-1");
  const stop = state.connect("r-1", () => grant, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.previews).toEqual([preview]);
  expect(state.status).toBe("ready");
  expect(fetcher.mock.calls[0][0]).toContain("?grant=first");
  grant = "renewed";
  expect(state.previews).toEqual([preview]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher.mock.calls[1][0]).toContain("?grant=renewed");
  expect(state.previews).toEqual([preview]);
  fetcher.mockRejectedValue(new Error("offline"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(state.previews).toEqual([preview]);
  expect(state.status).toBe("unavailable");
  fetcher.mockImplementation(() => Response.json({ previews: [preview] }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(state.status).toBe("ready");
  expect(state.previews).toEqual([preview]);
  fetcher.mockImplementation(() => Response.json({ previews: [] }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(state.previews).toEqual([]);
  stop();
  state.connect("r-1", () => null, true)();
  expect(state.status).toBe("ended");
  expect(vi.getTimerCount()).toBe(0);
});

it("polls on any deployment and stops polling a missing endpoint", async () => {
  vi.useFakeTimers();
  const hosted = { ...preview, url: `https://${"a".repeat(32)}.preview.cell.example` };
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews: [hosted] }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("location", { hostname: "ryph.example" });
  const state = new PreviewsState();
  state.called("r-0123456789");
  let stop = state.connect("r-0123456789", () => "proof", false, "t-1");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.status).toBe("ready");
  expect(state.previews).toEqual([hosted]);
  expect(state.href(hosted)).toBe(`/previews/r-0123456789/${hosted.id}?grant=proof&task=t-1`);
  stop();
  fetcher.mockReset();
  fetcher.mockResolvedValue(new Response(null, { status: 404 }));
  stop = state.connect("r-0123456789", () => null, false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.status).toBe("unavailable");
  expect(state.href(hosted)).toBe(`/previews/r-0123456789/${hosted.id}`);
  stop();
});

it("links with the grant the latest poll carried", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Response.json({ previews: [preview] })));
  const state = new PreviewsState();
  let grant = "first";
  state.called("r-0123456789");
  const stop = state.connect("r-0123456789", () => grant, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.href(preview)).toContain("grant=first");
  grant = "renewed";
  await vi.advanceTimersByTimeAsync(3000);
  expect(state.href(preview)).toContain("grant=renewed");
  stop();
});

it("ignores a previous run's late response after cleanup", async () => {
  let reply!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  vi.stubGlobal("fetch", () => pending);
  const state = new PreviewsState();
  state.called("r-1");
  const stop = state.connect("r-1", () => null, false);
  stop();
  state.connect("r-2", () => null, true)();
  reply(Response.json({ previews: [preview] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.previews).toEqual([]);
  expect(state.status).toBe("ended");
});

it("pauses discovery while the tab is hidden and resumes when it is shown", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews: [preview] }));
  vi.stubGlobal("fetch", fetcher);
  const state = new PreviewsState();
  state.called("r-1");
  const stop = state.connect("r-1", () => null, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  page.hidden = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stop();
  page.hidden = true;
  await vi.advanceTimersByTimeAsync(3000);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reads once on connect, and polls on only once the transcript shows a preview call", async () => {
  vi.useFakeTimers();
  let previews: unknown[] = [];
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews }));
  vi.stubGlobal("fetch", fetcher);
  const state = new PreviewsState();
  const stop = state.connect("r-1", () => null, false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.status).toBe("ready");
  // Another run's call starts nothing here.
  state.called("r-2");
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  previews = [preview];
  state.called("r-1");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state.previews).toEqual([preview]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  stop();
});

it("keeps polling a run that has previews though its call is not in the loaded history", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews: [preview] }));
  vi.stubGlobal("fetch", fetcher);
  const state = new PreviewsState();
  const stop = state.connect("r-1", () => null, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.previews).toEqual([preview]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  stop();
});

it("polls as one loop however often the transcript shows a preview call", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => Response.json({ previews: [preview] }));
  vi.stubGlobal("fetch", fetcher);
  const state = new PreviewsState();
  const stop = state.connect("r-1", () => null, false);
  state.called("r-1");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.previews).toEqual([preview]);
  expect(state.status).toBe("ready");
  // Told again as the transcript grows: still one loop.
  state.called("r-1");
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stop();
  // The run ended: nothing polls, whatever the transcript shows.
  state.connect("r-1", () => null, true);
  state.called("r-1");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
