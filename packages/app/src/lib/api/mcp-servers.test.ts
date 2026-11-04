import { describe, expect, it } from "vitest";
import { ApiError } from "./call";
import {
  createMcpServer,
  getMcpCatalogue,
  getMcpServerLogs,
  getToolAccess,
  getToolCallTrail,
  isHostingUnavailable,
  presetLine,
  probeMcpServer,
  restartMcpServer,
  TOOL_CALL_TRAIL_LIMIT,
  updateMcpServer,
} from "./mcp-servers";
import { mcpServerSchema } from "./types";

// A deployment may run without tool access — no MCP master key, so no gateway management surface.
// Like model access, that is a configuration choice and not a fault, and the pages that ask for
// servers must open anyway. So must they when the surface is missing, broken or another user's
// business: this is the seam where all four would otherwise reach a page `load` as an uncaught
// throw and replace the page with an error page.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const server = {
  id: "ms-1",
  slug: "linear",
  name: "Linear",
  description: null,
  transport: "http",
  kind: "remote",
  url: "https://mcp.linear.app/mcp",
  auth: "bearer",
  authLast4: "abcd",
  catalogueId: null,
  custom: null,
  settings: null,
  host: null,
  archivedAt: null,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
};

describe("getToolAccess", () => {
  it("reads the servers when the surface is live", async () => {
    const fetch = respond(200, { mcpServers: [server] }) as unknown as typeof globalThis.fetch;

    expect(await getToolAccess(fetch)).toEqual({
      toolAccessEnabled: true,
      toolAccessState: "on",
      mcpServers: [server],
    });
  });

  it("folds a disabled surface into an empty, disabled result", async () => {
    const fetch = respond(503, {
      error: "MCP access not configured",
      code: "mcp_disabled",
    }) as unknown as typeof globalThis.fetch;

    expect(await getToolAccess(fetch)).toEqual({
      toolAccessEnabled: false,
      toolAccessState: "off",
      mcpServers: [],
    });
  });

  // The agent forms ask for this on every open. A tool plane that is missing (a deployment whose
  // router does not mount the gateway answers 404), broken, or not this user's to read must cost
  // the form its Tools section — never the page, which is how creating and editing an agent died.
  it.each([
    [404, { error: "not found" }, "unavailable"],
    [502, { error: "upstream unavailable" }, "unavailable"],
    [503, { error: "upstream unavailable" }, "unavailable"],
    [403, { error: "admins only" }, "forbidden"],
  ])("folds a %i into a %s surface rather than an error page", async (status, body, state) => {
    const fetch = respond(status, body) as unknown as typeof globalThis.fetch;

    expect(await getToolAccess(fetch)).toEqual({
      toolAccessEnabled: false,
      toolAccessState: state,
      mcpServers: [],
    });
  });

  it("folds a gateway nobody could reach at all", async () => {
    const fetch =
      (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;

    expect((await getToolAccess(fetch)).toolAccessState).toBe("unavailable");
  });

  // Not every failure is this surface's to fold: a 401 is the session's business (the caller
  // refreshes and retries), and a 400 means we sent something wrong.
  it("still throws what is not a tool-surface failure", async () => {
    const fetch = respond(400, { error: "bad request" }) as unknown as typeof globalThis.fetch;

    await expect(getToolAccess(fetch)).rejects.toThrow("bad request");
  });
});

describe("getToolCallTrail", () => {
  const record = {
    runId: "run-1",
    serverId: "ms-1",
    method: "tools/call",
    tool: "create_issue",
    status: "ok",
    httpStatus: 200,
    durationMs: 412,
    at: "2026-09-10T12:00:01.000Z",
  };

  it("is empty, not a failure, when tool access is off", async () => {
    const fetch = respond(503, {
      error: "MCP access not configured",
      code: "mcp_disabled",
    }) as unknown as typeof globalThis.fetch;

    expect(await getToolCallTrail(fetch, "run-1")).toEqual({
      calls: [],
      hasMore: false,
      unavailable: false,
    });
  });

  // The run view is the page; the trail is a card on it. A gateway that is down, absent or not
  // this user's to read costs the card, and says so — it does not take the run with it.
  it.each([404, 500, 403])("is a note, not an error page, on a %i", async (status) => {
    const fetch = respond(status, { error: "nope" }) as unknown as typeof globalThis.fetch;

    expect(await getToolCallTrail(fetch, "run-1")).toEqual({
      calls: [],
      hasMore: false,
      unavailable: true,
    });
  });

  it("returns the recorded calls otherwise", async () => {
    const fetch = respond(200, { usage: [record] }) as unknown as typeof globalThis.fetch;

    expect(await getToolCallTrail(fetch, "run-1")).toEqual({
      calls: [record],
      hasMore: false,
      unavailable: false,
    });
  });

  // How long a run's trail is, is the agent's decision — a denied call writes a row without ever
  // dialing upstream. Every read this app makes is a bounded window on the newest end of it.
  it("always asks for a bounded window, and carries the gateway's word that more exists", async () => {
    let asked: string | null = null;
    const fetch = ((url: string) => {
      asked = url;
      return respond(200, { usage: [record], hasMore: true, nextCursor: "41" })();
    }) as unknown as typeof globalThis.fetch;

    expect(await getToolCallTrail(fetch, "run-1")).toEqual({
      calls: [record],
      hasMore: true,
      unavailable: false,
    });
    expect(asked).toBe(`/api/v1/mcp-usage/run-1?limit=${TOOL_CALL_TRAIL_LIMIT}`);
  });
});

describe("probeMcpServer", () => {
  // A verdict about upstream rides a 200 either way; both arms must parse, since the page shows
  // "credential rejected" from one and the tool list from the other.
  it("parses a refusal as a verdict, not an error", async () => {
    const fetch = respond(200, {
      ok: false,
      reason: "credential_rejected",
      detail: "upstream answered 401",
    }) as unknown as typeof globalThis.fetch;

    expect(await probeMcpServer(fetch, "ms-1")).toEqual({
      ok: false,
      reason: "credential_rejected",
      detail: "upstream answered 401",
    });
  });

  it("parses the tool list with the server's own annotations", async () => {
    const fetch = respond(200, {
      ok: true,
      protocolVersion: "2025-06-18",
      serverInfo: { name: "linear", version: "1.0.0" },
      tools: [
        { name: "search", description: "Search issues", annotations: { readOnlyHint: true } },
        { name: "create_issue", description: null, annotations: null },
      ],
    }) as unknown as typeof globalThis.fetch;

    const result = await probeMcpServer(fetch, "ms-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools.map((t) => t.name)).toEqual(["search", "create_issue"]);
  });
});

describe("updateMcpServer", () => {
  // The API's shape is flat: `auth` and its secret ride beside `name` and `url`. The client takes
  // the credential as one value so a caller cannot send half of one.
  it("flattens the credential into the wire body", async () => {
    let sent: unknown = null;
    const fetch = ((_: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return respond(200, server)();
    }) as unknown as typeof globalThis.fetch;

    await updateMcpServer(fetch, "ms-1", {
      name: "Linear (org)",
      credential: { auth: "bearer", secret: "lin_api_0123456789" },
    });
    expect(sent).toEqual({ name: "Linear (org)", auth: "bearer", secret: "lin_api_0123456789" });
  });

  it("sends a catalogue server's secrets as `credential`, beside its settings", () => {
    let sent: unknown = null;
    const fetch = ((_: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return respond(200, server)();
    }) as unknown as typeof globalThis.fetch;

    return updateMcpServer(fetch, "ms-1", {
      settings: { readOnly: false },
      secrets: { "X-Grafana-Service-Account-Token": "glsa_x" },
    }).then(() => {
      expect(sent).toEqual({
        settings: { readOnly: false },
        credential: { "X-Grafana-Service-Account-Token": "glsa_x" },
      });
    });
  });
});

const hosted = {
  ...server,
  id: "ms-2",
  slug: "grafana",
  kind: "hosted",
  url: "http://127.0.0.1:54321/grafana/mcp",
  auth: "headers",
  catalogueId: "grafana",
  custom: null,
  settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
  host: {
    handle: "ryph-tool-grafana-ms-2",
    status: "starting",
    imageDigest: null,
    startedAt: null,
    lastError: null,
  },
};

describe("mcpServerSchema", () => {
  it("reads a hosted row with its container state", () => {
    const parsed = mcpServerSchema.parse(hosted);
    expect(parsed.kind).toBe("hosted");
    expect(parsed.host?.status).toBe("starting");
    expect(parsed.settings).toEqual({ GRAFANA_URL: "https://grafana.example.com", readOnly: true });
  });

  it("reads a row from a gateway that predates hosting as remote", () => {
    const { kind: _k, catalogueId: _c, custom: _u, settings: _s, host: _h, ...old } = hosted;
    const parsed = mcpServerSchema.parse(old);
    expect([parsed.kind, parsed.host, parsed.settings]).toEqual(["remote", null, null]);
  });
});

describe("getMcpCatalogue", () => {
  it("reads the entries and whether hosting is available", async () => {
    const body = {
      hostingAvailable: false,
      reason: "the manual provisioner runs no containers",
      entries: [{
        id: "grafana",
        kind: "hosted",
        name: "Grafana",
        description: "d",
        docs: "https://github.com/grafana/mcp-grafana",
        brand: { color: "#F46800", logo: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
        image: "grafana/mcp-grafana@sha256:abc",
        host: null,
        settings: [],
        secrets: [],
        defaultOff: [],
      }],
    };
    const fetch = respond(200, body) as unknown as typeof globalThis.fetch;
    expect(await getMcpCatalogue(fetch)).toEqual(body);
  });

  it("refuses an entry missing a field the gateway always sends", async () => {
    const { defaultOff: _d, ...partial } = {
      id: "linear",
      kind: "remote",
      name: "Linear",
      description: "d",
      docs: "https://linear.app/docs/mcp",
      brand: null,
      image: null,
      host: "mcp.linear.app",
      settings: [],
      secrets: [],
      defaultOff: [],
    };
    const fetch = respond(200, {
      hostingAvailable: true,
      entries: [partial],
    }) as unknown as typeof globalThis.fetch;
    await expect(getMcpCatalogue(fetch)).rejects.toThrow();
  });

  it("reads a remote preset: its host, a choice, a patterned text, a prefixed secret", async () => {
    const preset = {
      id: "datadog",
      kind: "remote",
      name: "Datadog",
      description: "Metrics, logs, monitors.",
      docs: "https://docs.datadoghq.com/bits_ai/mcp_server/",
      brand: null,
      image: null,
      host: "mcp.datadoghq.com",
      settings: [
        {
          key: "site",
          label: "Site",
          kind: "choice",
          placeholder: null,
          description: null,
          optional: false,
          default: "us1",
          options: [{ value: "us1", label: "US1" }, { value: "eu1", label: "EU1" }],
          pattern: null,
        },
        {
          key: "project",
          label: "Project",
          kind: "text",
          placeholder: null,
          description: null,
          optional: true,
          default: null,
          options: null,
          pattern: "^[a-z0-9-]+$",
        },
      ],
      secrets: [{
        header: "Authorization",
        label: "API key",
        placeholder: null,
        description: null,
        prefix: "Bearer ",
      }],
      defaultOff: ["create_monitor"],
    };
    const fetch = respond(200, {
      hostingAvailable: false,
      reason: "no backend",
      entries: [preset],
    }) as unknown as typeof globalThis.fetch;
    const [entry] = (await getMcpCatalogue(fetch)).entries;
    expect(entry).toEqual(preset);
  });

  it("folds a disabled surface into an empty catalogue that cannot host", async () => {
    const fetch = respond(503, {
      error: "MCP access not configured",
      code: "mcp_disabled",
    }) as unknown as typeof globalThis.fetch;
    expect(await getMcpCatalogue(fetch)).toMatchObject({ hostingAvailable: false, entries: [] });
  });
});

describe("createMcpServer", () => {
  it("sends a remote preset as kind remote with its catalogue id, settings and credential", async () => {
    let sent: unknown = null;
    const fetch = ((_: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return respond(201, {
        ...server,
        slug: "linear",
        catalogueId: "linear",
        settings: {},
        url: "https://mcp.linear.app/mcp",
      })();
    }) as unknown as typeof globalThis.fetch;

    const row = await createMcpServer(fetch, {
      kind: "remote",
      catalogueId: "linear",
      name: "Linear",
      settings: {},
      credential: { Authorization: "lin_api_x" },
    });
    expect(sent).toEqual({
      kind: "remote",
      catalogueId: "linear",
      name: "Linear",
      settings: {},
      credential: { Authorization: "lin_api_x" },
    });
    expect([row.kind, row.catalogueId, row.host]).toEqual(["remote", "linear", null]);
  });
});

describe("hosted server actions", () => {
  it("restart posts an empty body, or asks for the new image", async () => {
    const sent: unknown[] = [];
    const urls: string[] = [];
    const fetch = ((url: string, init: RequestInit) => {
      urls.push(url);
      sent.push(JSON.parse(init.body as string));
      return respond(200, hosted)();
    }) as unknown as typeof globalThis.fetch;

    await restartMcpServer(fetch, "ms-2");
    await restartMcpServer(fetch, "ms-2", { updateImage: true });
    expect(urls).toEqual(["/api/v1/mcp-servers/ms-2/restart", "/api/v1/mcp-servers/ms-2/restart"]);
    expect(sent).toEqual([{}, { updateImage: true }]);
  });

  it("logs asks for a tail and answers the text", async () => {
    let asked = "";
    const fetch = ((url: string) => {
      asked = url;
      return respond(200, { logs: "line 1\nline 2" })();
    }) as unknown as typeof globalThis.fetch;

    expect(await getMcpServerLogs(fetch, "ms-2")).toBe("line 1\nline 2");
    expect(asked).toBe("/api/v1/mcp-servers/ms-2/logs?tail=200");
    await getMcpServerLogs(fetch, "ms-2", 50);
    expect(asked).toBe("/api/v1/mcp-servers/ms-2/logs?tail=50");
  });

  it("recognises the hosting-unavailable refusal", () => {
    const body = { error: "no container backend", code: "hosting_unavailable" };
    expect(isHostingUnavailable(new ApiError(503, body, body.error))).toBe(true);
    expect(isHostingUnavailable(new ApiError(503, { error: "x" }, "x"))).toBe(false);
  });
});

describe("presetLine", () => {
  it("shows just the host when the server goes by the entry's name", () => {
    expect(presetLine("Sentry", "Sentry", "https://mcp.sentry.dev/mcp")).toBe("mcp.sentry.dev");
    expect(presetLine(" sentry ", "Sentry", "https://mcp.sentry.dev/mcp")).toBe("mcp.sentry.dev");
  });

  it("leads with the entry's name when the server was renamed", () => {
    expect(presetLine("Errors", "Sentry", "https://mcp.sentry.dev/mcp")).toBe(
      "Sentry · mcp.sentry.dev",
    );
  });

  it("falls back to the host, or the raw URL, without an entry", () => {
    expect(presetLine("Errors", null, "https://mcp.sentry.dev/mcp")).toBe("mcp.sentry.dev");
    expect(presetLine("Errors", null, "not a url")).toBe("not a url");
  });
});
