import { afterEach, describe, expect, it, vi } from "vitest";

// The open action's route, against a stubbed control plane: which requests it refuses, what it
// asks the control plane, and where the tab is sent.

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";

const RUN = "r-0123456789";
const ID = "a".repeat(32);
const ENTER = `https://${ID}.preview.cell.example/__ryph/enter?ticket=one-time`;

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
  {
    accessToken = "good-jwt" as string | null,
    runId = RUN,
    previewId = ID,
    query = "",
    site = "same-origin" as string | null,
  } = {},
): Promise<Response> {
  const url = new URL(`https://ryph.test/previews/${runId}/${previewId}${query}`);
  const headers = new Headers();
  if (site !== null) headers.set("sec-fetch-site", site);
  const event = {
    request: new Request(url, { headers }),
    url,
    params: { runId, previewId },
    locals: { accessToken: accessToken ?? undefined },
    getClientAddress: () => "203.0.113.7",
  };
  // oxlint-disable-next-line no-explicit-any
  return await GET(event as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /previews/:runId/:previewId", () => {
  it("asks the control plane as the session and sends the tab to the answer", async () => {
    const sent = stubUpstream(() => Response.json({ url: ENTER }));
    const out = await call({ query: "?grant=proof&task=t-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].url).toBe(`http://api.test/v1/runs/${RUN}/previews/${ID}/open?grant=proof`);
    expect(sent[0].headers.get("authorization")).toBe("Bearer good-jwt");
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(ENTER);
    expect(out.headers.get("cache-control")).toBe("no-store");
  });

  it("passes on where in the preview the link pointed", async () => {
    const sent = stubUpstream(() => Response.json({ url: ENTER }));
    const path = "/nodes/oak.radicle.garden?tab=1";
    const out = await call({ query: `?path=${encodeURIComponent(path)}` });
    expect(new URL(sent[0].url).searchParams.get("path")).toBe(path);
    expect(out.headers.get("location")).toBe(ENTER);
  });

  it("follows a local binary's answer, the preview itself", async () => {
    const local = `http://${ID}.localhost:49152`;
    stubUpstream(() => Response.json({ url: local }));
    const out = await call({ site: null });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`${local}/`);
  });

  it("opens a pasted link, and the return from signing in through another site", async () => {
    // A pasted link is `none`; the sign-in's redirect chain can end `cross-site`.
    for (const site of ["cross-site", "same-site", "none"]) {
      const sent = stubUpstream(() => Response.json({ url: ENTER }));
      const out = await call({ site, query: "?task=t-1" });
      expect(sent).toHaveLength(1);
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe(ENTER);
    }
  });

  it("refuses ids that are not a run's and a preview's", async () => {
    for (
      const ids of [{ runId: "r-1" }, { runId: "../x" }, { previewId: "p" }, {
        previewId: ID.toUpperCase(),
      }]
    ) {
      const sent = stubUpstream(() => Response.json({ url: ENTER }));
      const out = await call(ids);
      expect(sent).toEqual([]);
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe("/");
    }
  });

  it("sends a visitor without a session to sign in, and back here after", async () => {
    const sent = stubUpstream(() => Response.json({ url: ENTER }));
    const out = await call({ accessToken: null, query: "?grant=proof" });
    expect(sent).toEqual([]);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(
      `/login?backTo=${encodeURIComponent(`/previews/${RUN}/${ID}?grant=proof`)}`,
    );
    stubUpstream(() => new Response(null, { status: 401 }));
    expect((await call()).headers.get("location")).toMatch(/^\/login\?backTo=/);
    // A link the previews service sent here comes back with its path.
    const query = `?path=${encodeURIComponent("/nodes/x?y=1&z=%2F")}`;
    const back = new URL(
      (await call({ accessToken: null, query })).headers.get("location")!,
      "https://ryph.test",
    ).searchParams.get("backTo");
    expect(back).toBe(`/previews/${RUN}/${ID}${query}`);
    expect(new URL(back!, "https://ryph.test").searchParams.get("path")).toBe("/nodes/x?y=1&z=%2F");
  });

  it("goes back to the task page on any failure, never showing the upstream's answer", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("secret upstream body", { status: 404 }),
      () => new Response("secret upstream body", { status: 410 }),
      () => new Response("secret upstream body", { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => Response.json({}),
      () => Promise.reject(new Error("unreachable")),
    ];
    for (const failure of failures) {
      stubUpstream(failure);
      const out = await call({ query: "?task=t-1" });
      expect(out.status).toBe(303);
      expect(out.headers.get("location")).toBe("/tasks/t-1");
      expect(await out.text()).toBe("");
    }
    stubUpstream(() => new Response(null, { status: 500 }));
    expect((await call({ query: "?task=../../evil" })).headers.get("location")).toBe("/");
  });

  it("does not follow an answer outside the preview's own origin", async () => {
    const answers = [
      "https://evil.test/",
      "javascript:alert(1)",
      `https://${"b".repeat(32)}.preview.cell.example/__ryph/enter?ticket=x`,
      `http://${ID}.preview.cell.example/__ryph/enter?ticket=x`,
      `https://${ID}.preview.cell.example/elsewhere`,
      `https://${ID}.preview.cell.example/__ryph/enter?ticket=x&next=https://evil.test`,
    ];
    for (const url of answers) {
      stubUpstream(() => Response.json({ url }));
      const out = await call({ query: "?task=t-1" });
      expect(out.headers.get("location")).toBe("/tasks/t-1");
    }
  });
});
