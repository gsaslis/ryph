import { describe, expect, it } from "vitest";
import type { CatalogueEntry, McpServer } from "$lib/api/types";
import {
  changedSettings,
  composeCatalogueBody,
  composeCustomBody,
  composeSecrets,
  defaultSlug,
  editNeedsKey,
  entryUnavailable,
  entryWhere,
  HOST_STATUS_CHIP,
  initialCatalogueForm,
  isRemotePreset,
  settingProblem,
  settingsSummary,
  STDIO_REFUSAL,
  urlChanged,
  urlNeedsCredential,
} from "./hosted-form";

// The hosted half of the Add dialog composes bodies the gateway checks again. These pin what the
// dialog sends — and what it refuses before sending — so a form tweak cannot quietly start
// shipping an empty optional setting, a string where a toggle belongs, or a slug nobody typed.

const GRAFANA: CatalogueEntry = {
  id: "grafana",
  kind: "hosted",
  host: null,
  defaultOff: [],
  name: "Grafana",
  description: "Dashboards, queries, alerting.",
  docs: "https://github.com/grafana/mcp-grafana",
  brand: null,
  image: `grafana/mcp-grafana:1.4.0@sha256:${"a".repeat(64)}`,
  settings: [
    {
      key: "GRAFANA_URL",
      label: "Grafana URL",
      kind: "url",
      placeholder: "https://grafana.example.com",
      description: null,
      optional: false,
      default: null,
      options: null,
      pattern: null,
    },
    {
      key: "ORG",
      label: "Organisation",
      kind: "text",
      placeholder: null,
      description: null,
      optional: true,
      default: null,
      options: null,
      pattern: null,
    },
    {
      key: "readOnly",
      label: "Read-only",
      kind: "toggle",
      placeholder: null,
      description: "Write tools are not offered to agents.",
      optional: false,
      default: true,
      options: null,
      pattern: null,
    },
  ],
  secrets: [{
    header: "X-Grafana-Service-Account-Token",
    label: "Service account token",
    placeholder: "glsa_…",
    description: null,
    prefix: null,
  }],
};

const DATADOG: CatalogueEntry = {
  id: "datadog",
  kind: "remote",
  name: "Datadog",
  description: "Metrics, logs, monitors.",
  docs: "https://docs.datadoghq.com",
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
      default: null,
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

function server(slug: string, archivedAt: string | null = null): McpServer {
  return {
    id: `ms-${slug}`,
    slug,
    name: slug,
    description: null,
    transport: "http",
    kind: "remote",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    authLast4: null,
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("defaultSlug", () => {
  it("takes the entry id, then steps aside for live servers only", () => {
    expect(defaultSlug("grafana", [])).toBe("grafana");
    expect(defaultSlug("grafana", [server("grafana")])).toBe("grafana-2");
    expect(defaultSlug("grafana", [server("grafana"), server("grafana-2")])).toBe("grafana-3");
    expect(defaultSlug("grafana", [server("grafana", "2026-09-11T00:00:00.000Z")])).toBe(
      "grafana",
    );
  });
});

describe("composeCatalogueBody", () => {
  const filled = () => {
    const form = initialCatalogueForm(GRAFANA, [server("grafana")]);
    form.settings.GRAFANA_URL = "  https://grafana.example.com ";
    form.secrets["X-Grafana-Service-Account-Token"] = " glsa_abcd1234 ";
    return form;
  };

  it("starts from the entry: its name, toggle defaults, the derived slug", () => {
    const form = initialCatalogueForm(GRAFANA, [server("grafana")]);
    expect(form).toMatchObject({
      name: "Grafana",
      settings: { GRAFANA_URL: "", ORG: "", readOnly: true },
      secrets: { "X-Grafana-Service-Account-Token": "" },
      slug: "grafana-2",
      slugEdited: false,
    });
  });

  it("trims, drops an empty optional setting, keeps toggles boolean, keys secrets by header", () => {
    expect(composeCatalogueBody(GRAFANA, filled())).toEqual({
      ok: true,
      body: {
        kind: "hosted",
        catalogueId: "grafana",
        name: "Grafana",
        settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
        credential: { "X-Grafana-Service-Account-Token": "glsa_abcd1234" },
      },
    });
  });

  it("sends the slug only when the operator edited it", () => {
    const form = filled();
    form.slug = "ops-grafana";
    const untouched = composeCatalogueBody(GRAFANA, form);
    expect(untouched.ok && "slug" in untouched.body).toBe(false);
    form.slugEdited = true;
    const edited = composeCatalogueBody(GRAFANA, form);
    expect(edited.ok && edited.body.slug).toBe("ops-grafana");
  });

  it("refuses a missing required setting, a non-URL, and a missing secret", () => {
    const noUrl = filled();
    noUrl.settings.GRAFANA_URL = " ";
    expect(composeCatalogueBody(GRAFANA, noUrl)).toEqual({
      ok: false,
      error: "Grafana URL is required",
    });
    const badUrl = filled();
    badUrl.settings.GRAFANA_URL = "grafana.local";
    expect(composeCatalogueBody(GRAFANA, badUrl)).toMatchObject({ ok: false });
    const noToken = filled();
    noToken.secrets["X-Grafana-Service-Account-Token"] = "";
    expect(composeCatalogueBody(GRAFANA, noToken)).toEqual({
      ok: false,
      error: "Paste the service account token",
    });
  });
});

describe("remote presets", () => {
  it("starts a required choice on its first option and sends kind remote", () => {
    const form = initialCatalogueForm(DATADOG, []);
    expect(form.settings).toEqual({ site: "us1", project: "" });
    form.secrets.Authorization = "dd_key";
    expect(composeCatalogueBody(DATADOG, form)).toEqual({
      ok: true,
      body: {
        kind: "remote",
        catalogueId: "datadog",
        name: "Datadog",
        settings: { site: "us1" },
        credential: { Authorization: "dd_key" },
      },
    });
  });

  it("refuses a text setting that misses its pattern, and a choice outside its options", () => {
    const form = initialCatalogueForm(DATADOG, []);
    form.secrets.Authorization = "dd_key";
    form.settings.project = "Not Valid";
    expect(composeCatalogueBody(DATADOG, form)).toEqual({
      ok: false,
      error: "Project isn't in the expected format.",
    });
    expect(settingProblem({ ...DATADOG.settings[1], placeholder: "ops-1" }, "Not Valid")).toBe(
      "Should look like ops-1.",
    );
    form.settings.project = "ops-1";
    form.settings.site = "mars";
    expect(composeCatalogueBody(DATADOG, form)).toMatchObject({ ok: false });
    expect(settingProblem(DATADOG.settings[1], "ops-1")).toBeNull();
    expect(settingProblem(DATADOG.settings[1], "")).toBeNull();
  });

  it("takes a pasted prefix off a secret, since the gateway adds it", () => {
    expect(composeSecrets(DATADOG, { Authorization: " Bearer dd_key " })).toEqual({
      ok: true,
      credential: { Authorization: "dd_key" },
    });
    expect(composeSecrets(DATADOG, { Authorization: "Bearer " })).toMatchObject({ ok: false });
    expect(composeSecrets(DATADOG, { Authorization: "Bearerless" })).toEqual({
      ok: true,
      credential: { Authorization: "Bearerless" },
    });
  });

  it("is never gated on hosting, where a hosted entry is", () => {
    const off = { hostingAvailable: false, reason: "No container backend.", entries: [] };
    expect(entryUnavailable(DATADOG, off)).toBeNull();
    expect(entryUnavailable(GRAFANA, off)).toBe("No container backend.");
    expect(entryUnavailable(GRAFANA, { ...off, hostingAvailable: true })).toBeNull();
    expect([entryWhere(DATADOG), entryWhere(GRAFANA)]).toEqual(["mcp.datadoghq.com", "Runs here"]);
  });

  it("tells a preset row from a remote URL row and a hosted one", () => {
    expect(isRemotePreset({ ...server("linear"), catalogueId: "linear" })).toBe(true);
    expect(isRemotePreset(server("linear"))).toBe(false);
    expect(isRemotePreset({ ...server("grafana"), kind: "hosted", catalogueId: "grafana" })).toBe(
      false,
    );
  });

  it("summarises a choice by its option label", () => {
    expect(settingsSummary({ site: "eu1", project: "ops" }, DATADOG)).toBe("EU1 · ops");
  });
});

describe("composeCustomBody", () => {
  const form = {
    name: "Internal tools",
    slug: "internal",
    description: "",
    image: `registry.example.com/tools@sha256:${"b".repeat(64)}`,
    command: "  serve   --port 9000 ",
    port: "9000",
    path: "",
    callerAuthEnv: "MCP_SERVER_TOKEN",
  };

  it("splits the command into argv and defaults the path", () => {
    expect(composeCustomBody(form, { auth: "headers", headers: { "X-Api-Key": "k" } })).toEqual({
      ok: true,
      body: {
        kind: "hosted",
        slug: "internal",
        name: "Internal tools",
        custom: {
          image: form.image,
          command: ["serve", "--port", "9000"],
          port: 9000,
          path: "/mcp",
          callerAuth: { env: "MCP_SERVER_TOKEN" },
        },
        auth: "headers",
        headers: { "X-Api-Key": "k" },
      },
    });
  });

  it("requires a digest, refuses stdio, and wants a real port", () => {
    const none = { auth: "none" } as const;
    expect(composeCustomBody({ ...form, image: "registry.example.com/tools:latest" }, none))
      .toMatchObject({ ok: false, error: expect.stringContaining("digest") });
    for (const command of ["-t stdio", "--transport stdio", "--transport=stdio", "stdio"]) {
      expect(composeCustomBody({ ...form, command }, none)).toEqual({
        ok: false,
        error: STDIO_REFUSAL,
      });
    }
    expect(composeCustomBody({ ...form, port: "0" }, none)).toMatchObject({ ok: false });
    expect(composeCustomBody({ ...form, port: "80a" }, none)).toMatchObject({ ok: false });
  });

  it("makes the operator name the caller-token env var, since the network may not isolate", () => {
    const none = { auth: "none" } as const;
    for (const callerAuthEnv of ["", "lower_case", "1LEADING", "HAS SPACE"]) {
      expect(composeCustomBody({ ...form, callerAuthEnv }, none)).toMatchObject({
        ok: false,
        error: expect.stringContaining("caller token"),
      });
    }
  });
});

describe("settingsSummary", () => {
  it("shows url settings as their host and toggles by label when on", () => {
    expect(
      settingsSummary({ GRAFANA_URL: "https://grafana.example.com", readOnly: true }, GRAFANA),
    ).toBe("grafana.example.com · read-only");
    expect(
      settingsSummary({ GRAFANA_URL: "https://grafana.example.com", readOnly: false }, GRAFANA),
    ).toBe("grafana.example.com");
  });

  it("falls back to raw keys when the catalogue lost the entry", () => {
    expect(settingsSummary({ URL: "https://x.example.com/a", fast: true }, undefined)).toBe(
      "x.example.com · fast",
    );
    expect(settingsSummary(null, GRAFANA)).toBe("");
  });
});

describe("HOST_STATUS_CHIP", () => {
  it("names every status, and only unreachable is alarming", () => {
    expect(HOST_STATUS_CHIP["update-available"].label).toBe("Update available");
    const loud = Object.entries(HOST_STATUS_CHIP).filter(([, c]) => c.variant === "destructive");
    expect(loud.map(([s]) => s)).toEqual(["unreachable"]);
  });
});

describe("editNeedsKey", () => {
  const preset: McpServer = {
    ...server("datadog"),
    catalogueId: "datadog",
    settings: { site: "us1", project: "web" },
  };
  const hosted: McpServer = {
    ...server("grafana"),
    kind: "hosted",
    catalogueId: "grafana",
    settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
  };

  it("asks a remote preset for the key on any changed setting", () => {
    expect(editNeedsKey(preset, DATADOG, { site: "eu1", project: "web" })).toBe(true);
    expect(editNeedsKey(preset, DATADOG, { site: "us1", project: "api" })).toBe(true);
  });

  it("does not ask a remote preset whose settings are unchanged", () => {
    expect(editNeedsKey(preset, DATADOG, { site: "us1", project: "web" })).toBe(false);
    expect(editNeedsKey(preset, DATADOG, { site: " us1 ", project: "web" })).toBe(false);
  });

  it("asks a hosted row for the key on a url, text or choice change", () => {
    expect(
      editNeedsKey(hosted, GRAFANA, { GRAFANA_URL: "https://other.example.com", readOnly: true }),
    ).toBe(true);
    expect(
      editNeedsKey(hosted, GRAFANA, {
        GRAFANA_URL: "https://grafana.example.com",
        ORG: "ops",
        readOnly: true,
      }),
    ).toBe(true);
  });

  it("does not ask a hosted row for a toggle-only change", () => {
    expect(
      editNeedsKey(hosted, GRAFANA, {
        GRAFANA_URL: "https://grafana.example.com",
        readOnly: false,
      }),
    ).toBe(false);
  });

  it("does not ask when the entry has no secrets, or is gone", () => {
    const open: CatalogueEntry = { ...GRAFANA, secrets: [] };
    expect(editNeedsKey(hosted, open, { GRAFANA_URL: "https://other.example.com" })).toBe(false);
    expect(editNeedsKey(preset, { ...DATADOG, secrets: [] }, { site: "eu1" })).toBe(false);
    expect(editNeedsKey(preset, undefined, { site: "eu1" })).toBe(false);
  });

  it("does not ask a plain remote row", () => {
    expect(editNeedsKey(server("linear"), DATADOG, { site: "eu1" })).toBe(false);
  });
});

describe("changedSettings", () => {
  it("keeps only what changed, trimmed", () => {
    expect(
      changedSettings({ site: "us1", readOnly: true }, { site: " eu1 ", readOnly: true }),
    ).toEqual({ site: "eu1" });
    expect(changedSettings({ site: "us1" }, { site: "us1" })).toBeUndefined();
    expect(changedSettings(null, { readOnly: false, org: "" })).toBeUndefined();
  });
});

describe("urlNeedsCredential", () => {
  const linear: McpServer = { ...server("linear"), auth: "bearer", authLast4: "abcd" };

  it("asks for the credential when a credentialed row's URL changes", () => {
    expect(urlNeedsCredential(linear, "https://mcp.example.com/v2")).toBe(true);
  });

  it("does not ask for an unchanged URL, padding aside", () => {
    expect(urlNeedsCredential(linear, " https://mcp.example.com/mcp ")).toBe(false);
    expect(urlChanged(linear, " https://mcp.example.com/mcp ")).toBe(false);
  });

  it("does not ask a row with no credential, though the URL still changed", () => {
    const open = server("open");
    expect(urlNeedsCredential(open, "https://mcp.example.com/v2")).toBe(false);
    expect(urlChanged(open, "https://mcp.example.com/v2")).toBe(true);
  });

  it("never applies to a remote preset or a hosted row", () => {
    const preset: McpServer = { ...linear, catalogueId: "datadog" };
    const hosted: McpServer = { ...linear, kind: "hosted" };
    expect(urlChanged(preset, "https://elsewhere.example.com")).toBe(false);
    expect(urlNeedsCredential(hosted, "https://elsewhere.example.com")).toBe(false);
  });
});
