import { isHttpError, isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

// The image link a forge comment carries, against a stubbed control plane: who is sent to sign
// in, what is asked of the control plane, and which of its headers reach the browser.

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";

type Sent = { url: string; headers: Headers };

function stubUpstream(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init.headers) });
    return Promise.resolve(response());
  });
  return sent;
}

const IMAGE_HEADERS = {
  "content-type": "image/png",
  "cache-control": "private, no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": 'inline; filename="att-1.png"',
  "set-cookie": "upstream=1",
};

async function call(accessToken: string | undefined, runId = "run-1", attachmentId = "att-1") {
  const url = new URL(`https://ryph.test/images/${runId}/${attachmentId}`);
  const event = {
    request: new Request(url),
    url,
    params: { runId, attachmentId },
    locals: { accessToken },
    getClientAddress: () => "203.0.113.7",
  };
  try {
    // oxlint-disable-next-line no-explicit-any
    return await GET(event as any);
  } catch (thrown) {
    return thrown;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /images/:runId/:attachmentId", () => {
  it("sends a visitor without a session to sign in, and back here after", async () => {
    const sent = stubUpstream(() => new Response(null));
    const out = await call(undefined);
    expect(isRedirect(out)).toBe(true);
    if (!isRedirect(out)) return;
    expect(out.status).toBe(302);
    expect(out.location).toBe(`/login?backTo=${encodeURIComponent("/images/run-1/att-1")}`);
    expect(sent).toEqual([]);
  });

  it("reads the run's attachment as the session, and passes on its bytes and guards", async () => {
    const sent = stubUpstream(() =>
      new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: IMAGE_HEADERS })
    );
    const out = await call("good-jwt") as Response;
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://api.test/v1/runs/run-1/attachments/att-1");
    expect(sent[0].headers.get("authorization")).toBe("Bearer good-jwt");
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");

    expect(out.status).toBe(200);
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    for (const name of Object.keys(IMAGE_HEADERS)) {
      if (name === "set-cookie") continue;
      expect(out.headers.get(name), name).toBe(IMAGE_HEADERS[name as keyof typeof IMAGE_HEADERS]);
    }
    expect(out.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the ids inside their own path segments", async () => {
    const sent = stubUpstream(() => new Response(null, { status: 404 }));
    await call("good-jwt", "run-1", "../../tasks");
    expect(sent[0].url).toBe("http://api.test/v1/runs/run-1/attachments/..%2F..%2Ftasks");
  });

  it("answers 404 alike for an image that is not there and one this person cannot read", async () => {
    for (const status of [403, 404]) {
      stubUpstream(() => new Response(JSON.stringify({ error: "no such run" }), { status }));
      const out = await call("good-jwt");
      expect(isHttpError(out) && out.status, String(status)).toBe(404);
    }
  });

  it("sends a session the control plane refused to sign in again", async () => {
    stubUpstream(() => new Response(null, { status: 401 }));
    const out = await call("good-jwt");
    expect(isRedirect(out) && out.location).toBe(
      `/login?backTo=${encodeURIComponent("/images/run-1/att-1")}`,
    );
  });
});
