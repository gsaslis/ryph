import { afterEach, describe, expect, it, vi } from "vitest";

// An artifact's content, against a stubbed control plane: what is asked of it, the exact headers
// the browser gets whatever came back, and how a refusal reads inside a frame.

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";
import { ARTIFACT_HANDSHAKE, ARTIFACT_SIGN_IN_HANDSHAKE } from "$lib/server/artifact-content";

type Sent = { url: string; headers: Headers };

function stubUpstream(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init.headers) });
    return Promise.resolve(response());
  });
  return sent;
}

// Byte for byte what the control plane serves (packages/orchestrator ARTIFACT_CSP).
const CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; " +
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/; " +
  "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/ data:; " +
  "img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; " +
  "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const GUARDS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-cache",
};

async function call(
  accessToken: string | undefined,
  id = "art_1",
  n = "2",
  headers: Record<string, string> = { "sec-fetch-dest": "iframe" },
) {
  const url = new URL(`https://ryph.test/artifacts/${id}/v/${n}/content`);
  const event = {
    request: new Request(url, { headers }),
    url,
    params: { id, n },
    locals: { accessToken },
    getClientAddress: () => "203.0.113.7",
  };
  // oxlint-disable-next-line no-explicit-any
  return await GET(event as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /artifacts/:id/v/:n/content", () => {
  it("reads the version as the session and serves it under exactly its own guards", async () => {
    const sent = stubUpstream(() =>
      new Response("<p>hi</p>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          etag: '"art_1-2"',
          "content-security-policy": "default-src *",
          "cache-control": "public, max-age=600",
          "set-cookie": "upstream=1",
          "access-control-allow-origin": "*",
        },
      })
    );
    const out = await call("good-jwt");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://api.test/v1/artifacts/art_1/versions/2/content");
    expect(sent[0].headers.get("authorization")).toBe("Bearer good-jwt");
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");

    expect(out.status).toBe(200);
    expect(await out.text()).toBe("<p>hi</p>");
    expect(Object.fromEntries(out.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      etag: '"art_1-2"',
      ...GUARDS,
    });
  });

  it("answers 401 to a visitor without a session, without asking upstream or redirecting", async () => {
    const sent = stubUpstream(() => new Response("<p>hi</p>"));
    const out = await call(undefined);
    expect(out.status).toBe(401);
    expect(out.headers.get("location")).toBeNull();
    expect(out.headers.get("content-security-policy")).toBe(CSP);
    expect(sent).toEqual([]);
  });

  it("answers 401 when the control plane refused the session", async () => {
    stubUpstream(() => new Response(null, { status: 401 }));
    const out = await call("good-jwt");
    expect(out.status).toBe(401);
    expect(out.headers.get("location")).toBeNull();
    expect(await out.text()).toContain(ARTIFACT_SIGN_IN_HANDSHAKE);
  });

  it("tells the page around a 401 frame that it wants a session, and no other refusal", async () => {
    stubUpstream(() => new Response(null, { status: 404 }));
    const refused = await (await call(undefined)).text();
    expect(refused).toContain(ARTIFACT_SIGN_IN_HANDSHAKE);
    const missing = await (await call("good-jwt")).text();
    expect(missing).toContain(ARTIFACT_HANDSHAKE);
    expect(missing).not.toContain("ryph-artifact-sign-in");
  });

  it("posts the sign-in notice with the nonce before the handshake, then the handshake", () => {
    const body = ARTIFACT_SIGN_IN_HANDSHAKE.slice("<script>".length, -"</script>".length);
    const posted: unknown[] = [];
    const listeners = new Map<string, (e: { isTrusted: boolean }) => void>();
    const win = {
      name: "nonce-1",
      parent: { postMessage: (m: unknown) => posted.push(m) },
      addEventListener: (type: string, f: (e: { isTrusted: boolean }) => void) =>
        listeners.set(type, f),
    };
    new Function("window", "parent", "addEventListener", body)(
      win,
      win.parent,
      win.addEventListener,
    );
    expect(win.name).toBe("");
    expect(posted).toEqual([{ type: "ryph-artifact-sign-in", nonce: "nonce-1" }]);
    listeners.get("load")!({ isTrusted: true });
    expect(posted).toEqual([
      { type: "ryph-artifact-sign-in", nonce: "nonce-1" },
      { type: "ryph-artifact-loaded", nonce: "nonce-1" },
    ]);
  });

  it("keeps the plain handshake byte for byte the control plane's", () => {
    expect(ARTIFACT_HANDSHAKE).toBe(
      '<script>(()=>{const n=window.name;window.name="";' +
        'const p=parent;let s=0;addEventListener("load",e=>{if(s||!e.isTrusted)return;s=1;' +
        'try{p.postMessage({type:"ryph-artifact-loaded",nonce:n},"*")}catch{}},true);' +
        'addEventListener("pagehide",e=>{if(!e.isTrusted)return;' +
        'try{p.postMessage({type:"ryph-artifact-leaving",nonce:n},"*")}catch{}},true);})();</script>',
    );
  });

  it("answers 404 alike for an artifact that is not there and one this person cannot read", async () => {
    for (const status of [403, 404]) {
      stubUpstream(() => new Response(JSON.stringify({ error: "nope" }), { status }));
      const out = await call("good-jwt");
      expect(out.status, String(status)).toBe(404);
      expect(out.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await out.text()).toContain("ryph-artifact-loaded");
      expect(out.headers.get("content-security-policy")).toBe(CSP);
      expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("answers 502 to an upstream failure", async () => {
    stubUpstream(() => new Response("boom", { status: 500 }));
    expect((await call("good-jwt")).status).toBe(502);
  });

  it("refuses a version that is not a positive whole number without asking upstream", async () => {
    for (const n of ["0", "-1", "1.5", "abc", "01"]) {
      const sent = stubUpstream(() => new Response("<p>hi</p>"));
      const out = await call("good-jwt", "art_1", n);
      expect(out.status, n).toBe(404);
      expect(sent, n).toEqual([]);
    }
  });

  it("keeps the id inside its own path segment", async () => {
    const sent = stubUpstream(() => new Response(null, { status: 404 }));
    await call("good-jwt", "../../runs");
    expect(sent[0].url).toBe("http://api.test/v1/artifacts/..%2F..%2Fruns/versions/2/content");
  });

  it("answers only a frame, and sends anything else to the artifact's page", async () => {
    for (
      const headers of [
        {} as Record<string, string>,
        { "sec-fetch-dest": "document" },
        { "sec-fetch-dest": "empty" },
        { "sec-fetch-dest": "frame" },
      ]
    ) {
      const sent = stubUpstream(() => new Response("<p>hi</p>"));
      const out = await call("good-jwt", "art_1", "2", headers);
      expect(out.status, JSON.stringify(headers)).toBe(302);
      expect(out.headers.get("location")).toBe("/artifacts/art_1?v=2");
      expect(sent).toEqual([]);
    }
    // Even without a session, and for a version that is not a number.
    expect((await call(undefined, "art_1", "x", {})).headers.get("location")).toBe(
      "/artifacts/art_1",
    );
  });

  it("asks upstream whether the copy the browser holds is still current", async () => {
    const sent = stubUpstream(() =>
      new Response(null, { status: 304, headers: { etag: '"art_1-2"' } })
    );
    const out = await call("good-jwt", "art_1", "2", {
      "sec-fetch-dest": "iframe",
      "if-none-match": '"art_1-2"',
    });
    expect(sent[0].headers.get("if-none-match")).toBe('"art_1-2"');
    expect(out.status).toBe(304);
    expect(out.headers.get("etag")).toBe('"art_1-2"');
    expect(out.headers.get("cache-control")).toBe("private, no-cache");
    expect(out.headers.get("content-security-policy")).toBe(CSP);
    expect(await out.text()).toBe("");
  });
});
