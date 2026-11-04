import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_LEAVING,
  ARTIFACT_LOADED,
  ARTIFACT_SANDBOX,
  ARTIFACT_SIGN_IN,
  artifactContentHref,
  artifactHref,
  artifactsOfRun,
  FrameGuard,
  frameNonce,
  type FrameSession,
  FrameStage,
  HANDSHAKE_GRACE_MS,
  latestRunVersion,
  parseVersion,
  pickVersion,
  runArtifactLabel,
  type StageView,
  STILL_LOADING_MS,
} from "./artifacts";

describe("artifact links", () => {
  it("names the page and a version's content", () => {
    expect(artifactHref("art_1")).toBe("/artifacts/art_1");
    expect(artifactHref("art_1", 3)).toBe("/artifacts/art_1?v=3");
    expect(artifactContentHref("art_1", 3)).toBe("/artifacts/art_1/v/3/content");
    expect(artifactHref("a/b")).toBe("/artifacts/a%2Fb");
  });

  it("never lets the frame share this app's origin or leave its tab", () => {
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
  });
});

describe("pickVersion", () => {
  const versions = [{ version: 1 }, { version: 2 }, { version: 3 }];
  it("takes a version the artifact has", () => {
    expect(pickVersion("2", versions, 3)).toBe(2);
  });
  it("falls back to the current one for anything else", () => {
    for (const asked of [null, "", "9", "0", "-1", "2.0", "abc", "02"]) {
      expect(pickVersion(asked, versions, 3), String(asked)).toBe(3);
    }
  });
});

describe("parseVersion", () => {
  it("reads positive whole numbers only", () => {
    expect(parseVersion("1")).toBe(1);
    expect(parseVersion("42")).toBe(42);
    for (const bad of [undefined, "", "0", "-1", "1.5", "01", "1e3", "9999999999"]) {
      expect(parseVersion(bad), String(bad)).toBeNull();
    }
  });
});

describe("a run's artifacts", () => {
  const made = (versions: [number, string][]) => ({
    versions: versions.map(([version, runId]) => ({ version, runId })),
  });
  const first = made([[1, "r1"], [3, "r1"]]);
  const later = made([[2, "r2"]]);

  it("lists only the artifacts the run made a version of", () => {
    expect(artifactsOfRun([first, later], "r1")).toEqual([first]);
    expect(artifactsOfRun([first, later], "r2")).toEqual([later]);
    expect(artifactsOfRun([first, later], "r3")).toEqual([]);
    expect(artifactsOfRun([first, later], null)).toEqual([]);
  });

  it("finds the newest version a run made", () => {
    expect(latestRunVersion(first, "r1")).toEqual({ version: 3, runId: "r1" });
    expect(latestRunVersion(later, "r2")).toEqual({ version: 2, runId: "r2" });
    expect(latestRunVersion(first, "r2")).toBeNull();
    expect(latestRunVersion(first, null)).toBeNull();
  });

  it("says published for the run that made version 1, updated for any other", () => {
    expect(runArtifactLabel(first, "r1")).toBe("Published artifact");
    expect(runArtifactLabel(later, "r2")).toBe("Updated artifact");
  });
});

describe("FrameGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const seen: string[] = [];
    const guard = new FrameGuard({
      onaccept: () => seen.push("accept"),
      onstray: () => seen.push("stray"),
      onslow: () => seen.push("slow"),
    }, "n0nce");
    const loaded = { type: ARTIFACT_LOADED, nonce: "n0nce" };
    const leaving = { type: ARTIFACT_LEAVING, nonce: "n0nce" };
    return { guard, seen, loaded, leaving };
  };

  it("names each placement with a fresh secret", () => {
    const a = frameNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(frameNonce()).not.toBe(a);
  });

  it("accepts one load and its handshake, in either order", () => {
    const one = make();
    one.guard.load();
    one.guard.message(one.loaded, true);
    expect(one.seen).toEqual(["accept"]);

    const two = make();
    two.guard.message(two.loaded, true);
    expect(two.seen).toEqual([]);
    two.guard.load();
    expect(two.seen).toEqual(["accept"]);
    vi.advanceTimersByTime(STILL_LOADING_MS * 2);
    expect(two.seen).toEqual(["accept"]);
  });

  it("stops a load with no handshake after the grace", () => {
    const { guard, seen } = make();
    guard.load();
    vi.advanceTimersByTime(HANDSHAKE_GRACE_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["stray"]);
  });

  it("calls a frame that takes long slow, and keeps waiting for it", () => {
    const { guard, seen, loaded } = make();
    vi.advanceTimersByTime(STILL_LOADING_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["slow"]);
    vi.advanceTimersByTime(STILL_LOADING_MS * 10);
    expect(guard.state).toBe("waiting");
    guard.message(loaded, true);
    guard.load();
    expect(seen).toEqual(["slow", "accept"]);
  });

  it("stops any load after the accepted one, once", () => {
    const { guard, seen, loaded } = make();
    guard.load();
    guard.message(loaded, true);
    guard.load();
    guard.load();
    guard.message(loaded, true);
    vi.advanceTimersByTime(STILL_LOADING_MS * 2);
    expect(seen).toEqual(["accept", "stray"]);
  });

  it("stops on a leaving notice, which may come with no source", () => {
    const { guard, seen, loaded, leaving } = make();
    guard.load();
    guard.message(loaded, true);
    guard.message(leaving, false);
    expect(seen).toEqual(["accept", "stray"]);
  });

  it("ignores what does not carry the nonce, and a handshake from elsewhere", () => {
    const { guard, seen, loaded } = make();
    guard.message({ type: ARTIFACT_LOADED, nonce: "" }, true);
    guard.message({ type: ARTIFACT_LEAVING, nonce: "guess" }, true);
    guard.message("ryph-artifact-loaded", true);
    guard.message(null, true);
    guard.message(loaded, false);
    guard.load();
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(HANDSHAKE_GRACE_MS);
    expect(seen).toEqual(["stray"]);
  });

  it("stops a second handshake: the same nonce in a document that loaded again", () => {
    const { guard, seen, loaded } = make();
    guard.message(loaded, true);
    guard.message(loaded, true);
    expect(seen).toEqual(["stray"]);
  });

  it("hands a sign-in notice to its holder, before the handshake and from the frame only", () => {
    const signins: string[] = [];
    const seen: string[] = [];
    const guard = new FrameGuard({
      onaccept: () => seen.push("accept"),
      onstray: () => seen.push("stray"),
      onsignin: () => signins.push("sign-in"),
    }, "n-1");
    guard.message({ type: ARTIFACT_SIGN_IN, nonce: "guess" }, true);
    guard.message({ type: ARTIFACT_SIGN_IN, nonce: "n-1" }, false);
    expect(signins).toEqual([]);
    guard.message({ type: ARTIFACT_SIGN_IN, nonce: "n-1" }, true);
    expect(signins).toEqual(["sign-in"]);
    expect(guard.state).toBe("disposed");
    guard.message({ type: ARTIFACT_LOADED, nonce: "n-1" }, true);
    guard.load();
    vi.advanceTimersByTime(STILL_LOADING_MS * 2);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a sign-in notice as a document when nobody holds the hook, or after the handshake", () => {
    const { guard, seen, loaded } = make();
    guard.message({ type: ARTIFACT_SIGN_IN, nonce: guard.nonce }, true);
    guard.load();
    guard.message(loaded, true);
    expect(seen).toEqual(["accept"]);

    const signins: string[] = [];
    const late = new FrameGuard({
      onaccept: () => {},
      onstray: () => {},
      onsignin: () => signins.push("sign-in"),
    }, "n-2");
    late.message({ type: ARTIFACT_LOADED, nonce: "n-2" }, true);
    late.message({ type: ARTIFACT_SIGN_IN, nonce: "n-2" }, true);
    expect(signins).toEqual([]);
  });

  it("says nothing once disposed", () => {
    const { guard, seen, leaving } = make();
    guard.dispose();
    guard.load();
    guard.message(leaving, false);
    vi.advanceTimersByTime(STILL_LOADING_MS * 2);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("FrameStage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Fake = {
    url: string;
    nonce: string;
    hidden: boolean;
    removed: boolean;
    load: () => void;
    window: object;
  };

  const make = (session: FrameSession | null = null) => {
    const frames: Fake[] = [];
    const views: StageView[] = [];
    const stage = new FrameStage(
      ({ url, nonce, hidden, onload }) => {
        const f: Fake = { url, nonce, hidden, removed: false, load: onload, window: {} };
        frames.push(f);
        return {
          window: f.window,
          reveal: () => (f.hidden = false),
          remove: () => (f.removed = true),
        };
      },
      (view) => views.push(view),
      session,
    );
    const answer = (f: Fake) => {
      f.load();
      stage.message({ type: ARTIFACT_LOADED, nonce: f.nonce }, f.window);
    };
    const stops = () =>
      views.filter((v, i) => v.stopped !== null && views[i - 1]?.stopped === null);
    return { stage, frames, views, answer, stops };
  };

  it("shows a version once it said it loaded", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/v1");
    expect(stage.view).toEqual({ shown: null, pending: 1, slow: false, stopped: null });
    expect(frames[0].hidden).toBe(false);
    answer(frames[0]);
    expect(stage.view).toEqual({ shown: 1, pending: null, slow: false, stopped: null });
  });

  it("loads a new version hidden behind the shown one and swaps once it loaded", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    stage.place(2, "/v2");
    expect(frames[1].hidden).toBe(true);
    expect(stage.view).toMatchObject({ shown: 1, pending: 2 });
    answer(frames[1]);
    expect(frames[1].hidden).toBe(false);
    expect(frames[0].removed).toBe(true);
    expect(stage.view).toMatchObject({ shown: 2, pending: null });
  });

  it("leaves the shown version alone at the same url and loads it again at another", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/a/v1");
    answer(frames[0]);
    stage.place(1, "/a/v1");
    expect(frames).toHaveLength(1);
    stage.place(1, "/b/v1");
    expect(frames).toHaveLength(2);
    expect(frames[1].url).toBe("/b/v1");
    answer(frames[1]);
    expect(frames[0].removed).toBe(true);
    expect(stage.view).toMatchObject({ shown: 1, pending: null });
  });

  it("keeps the shown version when the new one strays, and names the one that did", () => {
    const { stage, frames, answer, stops } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    stage.place(2, "/v2");
    frames[1].load();
    stage.message({ type: ARTIFACT_LOADED, nonce: "wrong" }, frames[1].window);
    vi.advanceTimersByTime(HANDSHAKE_GRACE_MS);
    expect(frames[0].removed).toBe(false);
    expect(frames[1].removed).toBe(true);
    expect(stage.view).toEqual({ shown: 1, pending: null, slow: false, stopped: 2 });
    expect(stops()).toHaveLength(1);
  });

  it("keeps the shown version while a new one is slow, and says so", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    stage.place(2, "/v2");
    vi.advanceTimersByTime(STILL_LOADING_MS);
    expect(stage.view).toEqual({ shown: 1, pending: 2, slow: true, stopped: null });
    answer(frames[1]);
    expect(stage.view).toEqual({ shown: 2, pending: null, slow: false, stopped: null });
  });

  it("takes everything down when the shown version strays, once, and loads nothing by itself", () => {
    const { stage, frames, answer, stops } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    stage.place(2, "/v2");
    frames[0].load();
    frames[0].load();
    stage.message({ type: ARTIFACT_LEAVING, nonce: frames[0].nonce }, null);
    vi.advanceTimersByTime(STILL_LOADING_MS * 4);
    expect(frames.every((f) => f.removed)).toBe(true);
    expect(frames).toHaveLength(2);
    expect(stage.view).toEqual({ shown: null, pending: null, slow: false, stopped: 1 });
    expect(stops()).toHaveLength(1);
  });

  it("places a stopped version again only when asked", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    frames[0].load();
    stage.place(1, "/v1");
    expect(stage.view).toEqual({ shown: null, pending: 1, slow: false, stopped: null });
    answer(frames[1]);
    expect(stage.view.shown).toBe(1);
  });

  it("ignores a handshake that does not come from the frame's own window", () => {
    const { stage, frames } = make();
    stage.place(1, "/v1");
    frames[0].load();
    stage.message({ type: ARTIFACT_LOADED, nonce: frames[0].nonce }, {});
    stage.message({ type: ARTIFACT_LOADED, nonce: frames[0].nonce }, null);
    vi.advanceTimersByTime(HANDSHAKE_GRACE_MS);
    expect(stage.view.stopped).toBe(1);
  });

  it("goes back to the shown version without placing it again", () => {
    const { stage, frames, answer } = make();
    stage.place(1, "/v1");
    answer(frames[0]);
    stage.place(2, "/v2");
    stage.place(1, "/v1");
    expect(frames).toHaveLength(2);
    expect(frames[1].removed).toBe(true);
    expect(stage.view).toEqual({ shown: 1, pending: null, slow: false, stopped: null });
  });

  /** A session whose `ready` and `renew` settle when the test says. */
  const controlled = () => {
    const calls: string[] = [];
    let settle: () => void = () => {};
    const pending = (name: string) => () => {
      calls.push(name);
      return new Promise<boolean>((resolve) => (settle = () => resolve(true)));
    };
    const session: FrameSession = { ready: pending("ready"), renew: pending("renew") };
    return { session, calls, settle: () => settle() };
  };
  const signIn = (stage: FrameStage, f: Fake) =>
    stage.message({ type: ARTIFACT_SIGN_IN, nonce: f.nonce }, f.window);
  const settled = () => vi.advanceTimersByTimeAsync(0);

  it("opens a frame only once the session is seen to, as loading meanwhile", async () => {
    const { session, calls, settle } = controlled();
    const { stage, frames, answer } = make(session);
    stage.place(1, "/v1");
    expect(calls).toEqual(["ready"]);
    expect(frames).toHaveLength(0);
    expect(stage.view).toEqual({ shown: null, pending: 1, slow: false, stopped: null });
    settle();
    await settled();
    expect(frames).toHaveLength(1);
    answer(frames[0]);
    expect(stage.view.shown).toBe(1);
  });

  it("opens only the version placed last when the session took a while", async () => {
    const { session, settle } = controlled();
    const { stage, frames } = make(session);
    stage.place(1, "/v1");
    const first = settle;
    stage.place(2, "/v2");
    first();
    settle();
    await settled();
    expect(frames.map((f) => f.url)).toEqual(["/v2"]);
  });

  it("opens the frame anyway when seeing to the session failed", async () => {
    const session: FrameSession = {
      ready: () => Promise.reject(new Error("offline")),
      renew: () => Promise.resolve(false),
    };
    const { stage, frames } = make(session);
    stage.place(1, "/v1");
    await settled();
    expect(frames).toHaveLength(1);
  });

  it("renews the session and loads once more when a version switch is refused for want of one", async () => {
    // The last seconds of a token: the metadata read was fine, the frame's content was a 401.
    const ready = vi.fn(() => Promise.resolve(true));
    const renew = vi.fn(() => Promise.resolve(true));
    const { stage, frames, answer } = make({ ready, renew });
    stage.place(1, "/v1");
    await settled();
    answer(frames[0]);
    stage.place(2, "/v2");
    await settled();
    signIn(stage, frames[1]);
    expect(frames[1].removed).toBe(true);
    expect(frames[0].removed).toBe(false);
    expect(stage.view).toEqual({ shown: 1, pending: 2, slow: false, stopped: null });
    expect(renew).toHaveBeenCalledTimes(1);
    await settled();
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({ url: "/v2", hidden: true });
    answer(frames[2]);
    expect(stage.view).toEqual({ shown: 2, pending: null, slow: false, stopped: null });
    expect(frames[0].removed).toBe(true);
  });

  it("renews at most once per placement, and then shows the sign-in notice", async () => {
    const renew = vi.fn(() => Promise.resolve(false));
    const { stage, frames, answer } = make({ ready: () => Promise.resolve(true), renew });
    stage.place(1, "/v1");
    await settled();
    signIn(stage, frames[0]);
    await settled();
    expect(frames).toHaveLength(2);
    signIn(stage, frames[1]);
    answer(frames[1]);
    await settled();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(2);
    expect(stage.view).toEqual({ shown: 1, pending: null, slow: false, stopped: null });

    // Placing it again, say with "Load again", is a fresh placement with its own one renewal.
    stage.place(1, "/v1-again");
    await settled();
    signIn(stage, frames[2]);
    await settled();
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("drops a renewal that something else was placed during, and one after dispose", async () => {
    const { session, calls, settle } = controlled();
    const { stage, frames } = make(session);
    stage.place(1, "/v1");
    settle();
    await settled();
    signIn(stage, frames[0]);
    expect(calls).toEqual(["ready", "renew"]);
    stage.dispose();
    settle();
    await settled();
    expect(frames).toHaveLength(1);
  });

  it("ignores a sign-in notice that does not carry the nonce or come from the frame", async () => {
    const renew = vi.fn(() => Promise.resolve(true));
    const { stage, frames } = make({ ready: () => Promise.resolve(true), renew });
    stage.place(1, "/v1");
    await settled();
    stage.message({ type: ARTIFACT_SIGN_IN, nonce: "guess" }, frames[0].window);
    stage.message({ type: ARTIFACT_SIGN_IN, nonce: frames[0].nonce }, {});
    expect(renew).not.toHaveBeenCalled();
    expect(frames[0].removed).toBe(false);
  });
});
