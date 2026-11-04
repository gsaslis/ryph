import { afterEach, describe, expect, it, vi } from "vitest";

// The open by preview id alone, against a stubbed control plane: where the previews service sends
// a page load that came without the preview's cookie.

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";

const ID = "a".repeat(32);
const TICKET = `1700000060.${"c".repeat(32)}.${"d".repeat(64)}`;
const ENTER = `https://${ID}.preview.cell.example/__ryph/enter?ticket=${TICKET}`;

type Sent = { url: string; method: string | undefined; headers: Headers };

function stubUpstream(response: () => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), method: init.method, headers: new Headers(init.headers) });
    return Promise.resolve(response());
  });
  return sent;
}

async function call(
  { accessToken = "good-jwt" as string | null, previewId = ID, query = "" } = {},
): Promise<Response> {
  const url = new URL(`https://ryph.test/previews/${previewId}${query}`);
  const event = {
    request: new Request(url),
    url,
    params: { previewId },
    locals: { accessToken: accessToken ?? undefined },
    getClientAddress: () => "203.0.113.7",
  };
  // oxlint-disable-next-line no-explicit-any
  return await GET(event as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /previews/:previewId", () => {
  it("asks the control plane by the preview alone and sends the tab to the answer", async () => {
    const sent = stubUpstream(() => Response.json({ url: ENTER }));
    const path = "/nodes/x?y=1";
    const out = await call({ query: `?path=${encodeURIComponent(path)}&grant=ignored` });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("POST");
    const asked = new URL(sent[0].url);
    expect(asked.origin + asked.pathname).toBe(`http://api.test/v1/previews/${ID}/open`);
    // Where the link pointed goes along; nothing else does.
    expect([...asked.searchParams]).toEqual([["path", path]]);
    expect(sent[0].headers.get("authorization")).toBe("Bearer good-jwt");
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(ENTER);
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(out.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses what is not a preview id, asking nothing", async () => {
    for (const previewId of ["p", ID.toUpperCase(), `${ID}0`, "../x", "r-0123456789"]) {
      const sent = stubUpstream(() => Response.json({ url: ENTER }));
      const out = await call({ previewId });
      expect(sent).toEqual([]);
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe("/");
    }
  });

  it("sends a visitor without a session to sign in, and back here with the path", async () => {
    const sent = stubUpstream(() => Response.json({ url: ENTER }));
    const query = `?path=${encodeURIComponent("/a?b=%2F")}`;
    const out = await call({ accessToken: null, query });
    expect(sent).toEqual([]);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(
      `/login?backTo=${encodeURIComponent(`/previews/${ID}${query}`)}`,
    );
  });

  it("sends any failure to the one notice that can try again, never showing the upstream's answer", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("secret upstream body", { status: 404 }),
      () => new Response("secret upstream body", { status: 410 }),
      () => new Response("secret upstream body", { status: 502 }),
      () => Response.json({ url: "https://evil.test/" }),
      () => Response.json({ url: ENTER.replace(ID, "b".repeat(32)) }),
      () => Promise.reject(new Error("unreachable")),
    ];
    // Missing, ended, not theirs, out of reach: all alike, and the path kept for the retry.
    for (const failure of failures) {
      stubUpstream(failure);
      const out = await call({ query: `?path=${encodeURIComponent("/a?b=1")}` });
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe(
        `/previews/unavailable?id=${ID}&path=${encodeURIComponent("/a?b=1")}`,
      );
      expect(await out.text()).toBe("");
    }
    stubUpstream(failures[0]);
    expect((await call()).headers.get("location")).toBe(`/previews/unavailable?id=${ID}`);
  });
});
