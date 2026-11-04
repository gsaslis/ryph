// The management surface for remote PRESETS — catalogue entries for a vendor's own endpoint: they
// create an ordinary remote row whose URL the entry wrote, with no container and no need for
// hosting; the URL meets the upstream guard at create and on every settings edit; a PATCH may
// move it only through the settings, and rotates through `credential`, prefix and all.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { directoryCatalogue } from "../src/adapters/catalogue/directory.ts";
import { type CatalogueEntry, CatalogueEntrySchema } from "../src/core/catalogue.ts";
import { type HostingService, unavailableHosting } from "../src/core/hosting.ts";
import { fixedCatalogue, makeApi } from "./api.ts";
import { call } from "./fixtures.ts";

const KEY = "vk_live_presetkey4321";

/**
 * A test-local preset. The region is the whole host, so one option can name a host the tests'
 * resolver does not know — which the upstream rule reads as not public, and refuses.
 */
const VENDOR = CatalogueEntrySchema.parse({
  kind: "remote",
  id: "vendor",
  name: "Vendor",
  description: "A vendor's own MCP endpoint.",
  docs: "https://example.com/vendor",
  url: "https://{region}/mcp{readOnly}",
  settings: [
    {
      key: "region",
      label: "Region",
      kind: "choice",
      default: "us",
      options: [
        { value: "us", label: "US", url: "mcp.vendor.example" },
        { value: "eu", label: "EU", url: "mcp.eu.vendor.example" },
        { value: "dark", label: "Unresolvable", url: "mcp.vendor.invalid" },
      ],
    },
    { key: "readOnly", label: "Read-only", kind: "toggle", default: true, url: { true: "/ro" } },
  ],
  credential: {
    delivery: "headers",
    headers: { Authorization: { label: "API key", secret: true, prefix: "Bearer " } },
  },
  defaultOff: ["delete_thing"],
});

const grafana = (await (await directoryCatalogue()).get("grafana"))!;
const catalogue = fixedCatalogue([VENDOR, grafana] as CatalogueEntry[]);

const PRESET = {
  kind: "remote",
  catalogueId: "vendor",
  name: "Vendor",
  credential: { Authorization: KEY },
};

test("a preset creates a remote row with hosting unavailable: URL and headers from the entry", async () => {
  const { handler, sealed, store } = makeApi({ catalogue });
  const res = await call(handler, "POST", "/v1/mcp-servers", PRESET);
  assertEquals(res.status, 201);
  const created = await res.json();
  assertEquals(created.kind, "remote");
  assertEquals(created.slug, "vendor");
  assertEquals(created.catalogueId, "vendor");
  assertEquals(created.settings, { region: "us", readOnly: true });
  assertEquals(created.url, "https://mcp.vendor.example/mcp/ro");
  assertEquals(created.auth, "headers");
  assertEquals(created.authLast4, "4321");
  assertEquals(created.host, null);
  assert(!JSON.stringify(created).includes(KEY), "the key never rides a response");
  assertEquals(sealed, [JSON.stringify({ Authorization: `Bearer ${KEY}` })]);
  assertEquals((await store.getServer(created.id))?.kind, "remote");

  // The slug steps aside, as a hosted entry's does; settings shape the URL.
  const second = await (await call(handler, "POST", "/v1/mcp-servers", {
    ...PRESET,
    settings: { region: "eu", readOnly: false },
  })).json();
  assertEquals(second.slug, "vendor-2");
  assertEquals(second.url, "https://mcp.eu.vendor.example/mcp");
});

test("a preset's URL meets the upstream rule, and its body what the entry allows", async () => {
  const { handler, store } = makeApi({ catalogue });
  for (
    const [body, fragment] of [
      [{ ...PRESET, settings: { region: "dark" } }, "url: "],
      [{ ...PRESET, settings: { region: "ap" } }, "must be one of"],
      [{ ...PRESET, settings: { nope: true } }, "no such setting"],
      [{ ...PRESET, credential: {} }, "API key is required"],
      [{ ...PRESET, credential: { "X-Other": KEY } }, "reads no such header"],
      [{ ...PRESET, catalogueId: "nope" }, 'no entry "nope"'],
      // The URL is the entry's to write; a body that names one is refused, not ignored.
      [{ ...PRESET, url: "https://evil.example/mcp" }, "url"],
      [{ ...PRESET, auth: "bearer", secret: KEY }, "auth"],
    ] as const
  ) {
    const res = await call(handler, "POST", "/v1/mcp-servers", body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertStringIncludes((await res.json()).error, fragment);
  }
  assertEquals((await store.listServers()).length, 0, "nothing stored for a refused body");
});

test("a preset and a hosted entry are each created under their own kind", async () => {
  const { handler } = makeApi({ catalogue });
  const hostedVendor = await call(handler, "POST", "/v1/mcp-servers", {
    ...PRESET,
    kind: "hosted",
  });
  assertEquals(hostedVendor.status, 400);
  assertStringIncludes((await hostedVendor.json()).error, 'create it with kind "remote"');

  const remoteGrafana = await call(handler, "POST", "/v1/mcp-servers", {
    kind: "remote",
    catalogueId: "grafana",
    name: "Grafana",
    settings: { GRAFANA_URL: "https://grafana.example.com" },
    credential: { "X-Grafana-Service-Account-Token": "glsa_token12345678" },
  });
  assertEquals(remoteGrafana.status, 400);
  assertStringIncludes((await remoteGrafana.json()).error, 'create it with kind "hosted"');
});

test("PATCH on a preset row: settings move the URL, never a typed one; rotation keeps the prefix", async () => {
  const { handler, sealed, store } = makeApi({ catalogue });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", PRESET)).json();
  const path = `/v1/mcp-servers/${created.id}`;

  const repoint = await call(handler, "PATCH", path, { url: "https://mcp.eu.vendor.example/mcp" });
  assertEquals(repoint.status, 400);
  assertStringIncludes((await repoint.json()).error, "comes from its entry");
  const typed = await call(handler, "PATCH", path, {
    auth: "headers",
    headers: { Authorization: "Bearer x" },
  });
  assertEquals(typed.status, 400);
  assertStringIncludes((await typed.json()).error, "with `credential`");

  // Any move of the URL takes the credential again, within the host too: the sealed key is
  // bound to the URL it was given for, and never re-sealed for another by the server.
  const narrowed = await call(handler, "PATCH", path, { settings: { readOnly: false } });
  assertEquals(narrowed.status, 400);
  assertEquals((await narrowed.json()).code, "credential_required");
  assertEquals(sealed.length, 1, "nothing is resealed for the new URL");
  const narrowedWith = await call(handler, "PATCH", path, {
    settings: { readOnly: false },
    credential: { Authorization: "vk_live_us00000002" },
  });
  assertEquals(narrowedWith.status, 200);
  assertEquals((await narrowedWith.json()).url, "https://mcp.vendor.example/mcp");
  // A move to another host, even a reviewed one, takes the credential again.
  const bare = await call(handler, "PATCH", path, { settings: { region: "eu", readOnly: true } });
  assertEquals(bare.status, 400);
  assertEquals((await bare.json()).code, "credential_required");
  assertEquals((await store.getServer(created.id))?.url, "https://mcp.vendor.example/mcp");
  const moved = await call(handler, "PATCH", path, {
    settings: { region: "eu", readOnly: true },
    credential: { Authorization: "vk_live_eu00000001" },
  });
  assertEquals(moved.status, 200);
  const after = await moved.json();
  assertEquals(after.url, "https://mcp.eu.vendor.example/mcp/ro");
  assertEquals(after.settings, { region: "eu", readOnly: true });
  assertEquals(JSON.parse(sealed.at(-1)!), { Authorization: "Bearer vk_live_eu00000001" });

  // …and a move to a host the rule refuses leaves the row where it was.
  const dark = await call(handler, "PATCH", path, { settings: { region: "dark" } });
  assertEquals(dark.status, 400);
  assertStringIncludes((await dark.json()).error, "url: ");
  assertEquals((await store.getServer(created.id))?.url, "https://mcp.eu.vendor.example/mcp/ro");

  // Rotation in place: same id, the new key sealed behind the entry's prefix.
  const rotated = await (await call(handler, "PATCH", path, {
    credential: { Authorization: "vk_live_rotated0001" },
  })).json();
  assertEquals(rotated.id, created.id);
  assertEquals(rotated.authLast4, "0001");
  assertEquals(JSON.parse(sealed.at(-1)!), { Authorization: "Bearer vk_live_rotated0001" });
  assertEquals(rotated.url, "https://mcp.eu.vendor.example/mcp/ro");

  // A plain remote row still refuses the catalogue fields.
  const plain = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "plain",
    name: "Plain",
    url: "https://plain.example/mcp",
    auth: "none",
  })).json();
  const refused = await call(handler, "PATCH", `/v1/mcp-servers/${plain.id}`, {
    settings: { region: "eu" },
  });
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "for catalogue servers");
});

test("a preset whose entry left the catalogue cannot be re-settled", async () => {
  const { handler, store } = makeApi({ catalogue });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", PRESET)).json();
  const gone = makeApi({ store, catalogue: fixedCatalogue([]) });
  const res = await call(gone.handler, "PATCH", `/v1/mcp-servers/${created.id}`, {
    settings: { region: "eu" },
  });
  assertEquals(res.status, 409);
  assertStringIncludes((await res.json()).error, 'no longer has "vendor"');
  // A rename needs nothing of the entry: the row still works without it.
  const renamed = await call(gone.handler, "PATCH", `/v1/mcp-servers/${created.id}`, {
    name: "Renamed",
  });
  assertEquals(renamed.status, 200);
  assertEquals((await renamed.json()).name, "Renamed");
});

test("a preset row has no container: restart and logs refuse, archive stops nothing", async () => {
  const stopped: string[] = [];
  const hosting: HostingService = {
    ...unavailableHosting("no container backend in this test"),
    stop: (s) => {
      stopped.push(s.id);
      return Promise.resolve(s);
    },
  };
  const { handler } = makeApi({ catalogue, hosting });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", PRESET)).json();
  const restart = await call(handler, "POST", `/v1/mcp-servers/${created.id}/restart`);
  assertEquals(restart.status, 400);
  assertStringIncludes((await restart.json()).error, "only a hosted server");
  const logs = await call(handler, "GET", `/v1/mcp-servers/${created.id}/logs`);
  assertEquals(logs.status, 400);
  await logs.body?.cancel();

  const archived = await call(handler, "POST", `/internal/v1/mcp-servers/${created.id}/archive`);
  assertEquals(archived.status, 200);
  assert((await archived.json()).archivedAt !== null);
  assertEquals(stopped, []);
});

test("the catalogue lists presets even with hosting off, with what the form needs", async () => {
  const { handler } = makeApi({ catalogue });
  const body = await (await call(handler, "GET", "/v1/mcp-catalogue")).json();
  assertEquals(body.hostingAvailable, false);
  assertEquals(body.reason, "no container backend in this test");
  const vendor = body.entries.find((e: { id: string }) => e.id === "vendor");
  assertEquals(vendor, {
    id: "vendor",
    kind: "remote",
    name: "Vendor",
    description: "A vendor's own MCP endpoint.",
    docs: "https://example.com/vendor",
    brand: null,
    image: null,
    host: "mcp.vendor.example",
    settings: [
      {
        key: "region",
        label: "Region",
        kind: "choice",
        placeholder: null,
        description: null,
        optional: false,
        default: "us",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
          { value: "dark", label: "Unresolvable" },
        ],
        pattern: null,
      },
      {
        key: "readOnly",
        label: "Read-only",
        kind: "toggle",
        placeholder: null,
        description: null,
        optional: false,
        default: true,
        options: null,
        pattern: null,
      },
    ],
    secrets: [{
      header: "Authorization",
      label: "API key",
      placeholder: null,
      description: null,
      prefix: "Bearer ",
    }],
    defaultOff: ["delete_thing"],
  });
  // The hosted card is still there beside it, with its image and no host.
  const hosted = body.entries.find((e: { id: string }) => e.id === "grafana");
  assertEquals(hosted.kind, "hosted");
  assertEquals(hosted.host, null);
  assert(hosted.image.includes("@sha256:"));
});

test("a catalogue create names its kind", async () => {
  const { handler } = makeApi({ catalogue });
  const { kind: _kind, ...unnamed } = PRESET;
  const res = await call(handler, "POST", "/v1/mcp-servers", unnamed);
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "names its kind");
});
