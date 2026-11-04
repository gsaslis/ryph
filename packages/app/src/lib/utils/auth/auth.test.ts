import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({ browser: true }));

import {
  ensureFreshSession,
  ensureFreshSessionResult,
  noteSessionExpiry,
  refreshSession,
  renewSession,
  renewSessionResult,
  SESSION_MARGIN_MS,
} from "./auth";
import { sessionSecondsLeft } from "./jwt";

// The session clock artifact frames are placed by: their content route answers 401 and never
// refreshes, so the browser refreshes before a frame would load with a token in its last seconds.

let now = 0;
let refreshes = 0;
let refreshAnswer: () => Response;

const user = { id: "u-1", email: "a@b.c", name: "A", caps: ["*"], emailVerified: true };

beforeEach(() => {
  now = 1_000_000;
  refreshes = 0;
  refreshAnswer = () => Response.json({ user, expiresIn: 870 });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    expect(url).toBe("/auth/refresh");
    expect(init.method).toBe("POST");
    refreshes += 1;
    return Promise.resolve(refreshAnswer());
  });
});

afterEach(() => {
  noteSessionExpiry(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureFreshSession", () => {
  it("leaves a session with time to spare alone", async () => {
    noteSessionExpiry(600);
    now += 600_000 - SESSION_MARGIN_MS - 1;
    expect(await ensureFreshSession()).toBe(true);
    expect(refreshes).toBe(0);
  });

  it("refreshes once a token is near its end, and then trusts the new one", async () => {
    noteSessionExpiry(600);
    now += 600_000 - SESSION_MARGIN_MS;
    expect(await ensureFreshSession()).toBe(true);
    expect(refreshes).toBe(1);
    // The refresh said how long the new token lasts.
    now += 800_000 - SESSION_MARGIN_MS;
    expect(await ensureFreshSession()).toBe(true);
    expect(refreshes).toBe(1);
  });

  it("refreshes a token already expired, as a frame mounted late finds it", async () => {
    noteSessionExpiry(10);
    now += 3_600_000;
    expect(await ensureFreshSession()).toBe(true);
    expect(refreshes).toBe(1);
  });

  it("shares one refresh among frames placed at once", async () => {
    noteSessionExpiry(5);
    const all = await Promise.all([ensureFreshSession(), ensureFreshSession(), renewSession()]);
    expect(all).toEqual([true, true, true]);
    expect(refreshes).toBe(1);
  });

  it("says there is no session when the refresh fails, and stops asking", async () => {
    refreshAnswer = () => new Response(null, { status: 401 });
    noteSessionExpiry(5);
    expect(await ensureFreshSession()).toBe(false);
    expect(await ensureFreshSession()).toBe(false);
    expect(refreshes).toBe(1);
    // Until the server says something new.
    noteSessionExpiry(5);
    expect(await ensureFreshSession()).toBe(false);
    expect(refreshes).toBe(2);
  });

  it("trusts a session it knows nothing about", async () => {
    noteSessionExpiry(null);
    expect(await ensureFreshSession()).toBe(true);
    expect(refreshes).toBe(0);
  });
});

describe("renewSession", () => {
  it("refreshes even when the clock thought the token was good", async () => {
    noteSessionExpiry(600);
    expect(await renewSession()).toBe(true);
    expect(refreshes).toBe(1);
  });

  it("says so when the refresh token is gone", async () => {
    refreshAnswer = () => new Response(null, { status: 401 });
    expect(await renewSession()).toBe(false);
  });
});

describe("session readiness results", () => {
  it.each([401, 403])(
    "only explicit credential rejection (%s) requires sign-in",
    async (status) => {
      refreshAnswer = () => new Response(null, { status });
      noteSessionExpiry(5);
      expect(await ensureFreshSessionResult()).toBe("auth-required");
      expect(await ensureFreshSessionResult()).toBe("auth-required");
      expect(refreshes).toBe(1);
    },
  );

  it.each([429, 500, 502, 503])("keeps HTTP %s refresh failures retryable", async (status) => {
    refreshAnswer = () => new Response(null, { status });
    noteSessionExpiry(5);
    expect(await ensureFreshSessionResult()).toBe("unavailable");
    refreshAnswer = () => Response.json({ user, expiresIn: 870 });
    expect(await ensureFreshSessionResult()).toBe("ready");
    expect(refreshes).toBe(2);
  });

  it("keeps network failures retryable", async () => {
    refreshAnswer = () => {
      throw new TypeError("offline");
    };
    noteSessionExpiry(5);
    expect(await ensureFreshSessionResult()).toBe("unavailable");
    refreshAnswer = () => Response.json({ user, expiresIn: 870 });
    expect(await ensureFreshSessionResult()).toBe("ready");
  });

  it("shares one rotation across old and richer APIs", async () => {
    noteSessionExpiry(5);
    const results = await Promise.all([
      ensureFreshSessionResult(),
      renewSessionResult(),
      refreshSession(),
      ensureFreshSession(),
      renewSession(),
    ]);
    expect(results).toEqual(["ready", "ready", user, true, true]);
    expect(refreshes).toBe(1);
  });

  it("does not treat a malformed success body as rejected credentials", async () => {
    refreshAnswer = () => Response.json({});
    expect(await renewSessionResult()).toBe("unavailable");
  });
});

describe("sessionSecondsLeft", () => {
  const jwt = (exp: number) =>
    `h.${
      btoa(JSON.stringify({ sub: "u", email: "e", name: "n", caps: [], exp }))
        .replace(/=+$/, "")
    }.s`;

  it("counts down to when getUserData stops accepting the token", () => {
    const at = Math.floor(Date.now() / 1000);
    const left = sessionSecondsLeft(jwt(at + 900));
    expect(left).toBeGreaterThanOrEqual(869);
    expect(left).toBeLessThanOrEqual(870);
  });

  it("is null for a token already inside the buffer, or none", () => {
    const at = Math.floor(Date.now() / 1000);
    expect(sessionSecondsLeft(jwt(at + 20))).toBeNull();
    expect(sessionSecondsLeft("garbage")).toBeNull();
    expect(sessionSecondsLeft(undefined)).toBeNull();
  });
});
