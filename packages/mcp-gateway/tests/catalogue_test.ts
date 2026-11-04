// The catalogue: the shipped entries load and validate, every hosted one launches against a fake
// host with nothing secret in its env and every remote one renders an https URL, the schema
// refuses what each kind of entry may not do, and the Grafana entry says what mcp-grafana
// actually reads.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  atDigest,
  CatalogueEntrySchema,
  composeHeaders,
  digestOf,
  type HostedCatalogueEntry,
  launchOf,
  type RemoteCatalogueEntry,
  remoteUrlOf,
  resolveSettings,
  secretHeadersOf,
  secretsFromHeaders,
} from "../src/core/catalogue.ts";
import { makeHosting } from "../src/core/hosting.ts";
import { checkUpstreamUrl, type UpstreamPolicy } from "../src/core/upstream_guard.ts";
import { directoryCatalogue } from "../src/adapters/catalogue/directory.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { fakeToolHost } from "./fake_tool_host.ts";
import { server, T0 } from "./fixtures.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** The rule a url setting meets, over a resolver whose public internet is `*.example(.com)`. */
const policy = (over: Partial<UpstreamPolicy> = {}): UpstreamPolicy => ({
  allowInsecure: false,
  allowPrivate: false,
  resolve: (host) => Promise.resolve(/\.example(\.com)?$/.test(host) ? ["93.184.215.14"] : []),
  ...over,
});

const checkUrl = (over: Partial<UpstreamPolicy> = {}) => (url: string) =>
  checkUpstreamUrl({ kind: "remote", slug: "demo", url }, policy(over));

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "hosted",
    id: "demo",
    name: "Demo",
    description: "A demo server.",
    docs: "https://example.com/demo",
    image: `example/demo:1.0@${DIGEST}`,
    port: 8000,
    path: "/mcp",
    command: ["--http"],
    settings: [
      { key: "BASE_URL", label: "Base URL", kind: "url", env: "BASE_URL" },
      {
        key: "readOnly",
        label: "Read-only",
        kind: "toggle",
        default: true,
        args: { true: ["--ro"] },
      },
    ],
    credential: {
      delivery: "headers",
      headers: {
        "X-Base": { from: "setting:BASE_URL" },
        "X-Token": { label: "Token", secret: true },
      },
    },
    callerAuth: { env: "SERVER_TOKEN" },
    shared: true,
    ...overrides,
  };
}

const refusal = (raw: unknown): string => {
  const parsed = CatalogueEntrySchema.safeParse(raw);
  assert(!parsed.success, "expected the schema to refuse this entry");
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
};

test("the shipped catalogue loads, and Grafana is in it", async () => {
  const catalogue = await directoryCatalogue();
  const entries = await catalogue.list();
  assert(entries.length >= 1);
  const grafana = await catalogue.get("grafana");
  assert(grafana !== null);
  assertEquals(await catalogue.get("nope"), null);
});

test("every shipped hosted entry launches against a fake host with no secret in its env", async () => {
  // The review question for a new entry, as a test: it parses, it derives a launch, the launch
  // is digest-pinned on the tools network with nothing published, and not one of its secret
  // headers' values reaches the container.
  const catalogue = await directoryCatalogue();
  for (const e of await catalogue.list()) {
    if (e.kind !== "hosted") continue;
    const answers: Record<string, unknown> = {};
    for (const s of e.settings) {
      if (s.kind === "url") answers[s.key] = "https://service.example.com";
      if (s.kind === "text") answers[s.key] = "value";
    }
    const settings = await resolveSettings(e, answers, { checkUrl: checkUrl() });
    assert(settings.ok, `${e.id}: ${!settings.ok && settings.error}`);
    const secret = "sekret-value-1234";
    const secrets = Object.fromEntries(secretHeadersOf(e).map((s) => [s.name, secret]));
    const headers = composeHeaders(e, settings.settings, secrets);
    assert(headers.ok, `${e.id}: ${!headers.ok && headers.error}`);

    const host = fakeToolHost();
    const store = memoryGatewayStore();
    const row = server({
      id: "ms-1",
      slug: e.id,
      kind: "hosted",
      catalogueId: e.id,
      settings: settings.settings,
      auth: "headers",
      encryptedAuth: `sealed:${JSON.stringify(headers.headers)}`,
      host: {
        handle: null,
        status: "starting",
        imageDigest: null,
        startedAt: null,
        lastError: null,
      },
    });
    await store.createServer(row);
    const hosting = makeHosting({
      store,
      host,
      catalogue,
      probe: () => Promise.resolve({ ok: true }),
      guardImage: "ryph-tool-guard:test",
      now: () => new Date(T0),
      diag: { debug() {}, warn() {} },
      sleep: () => Promise.resolve(),
    });
    await hosting.boot();
    await hosting.launch(row);
    await hosting.idle();

    const launched = host.launches.find((l) => l.name !== "ryph-tool-guard");
    assert(launched !== undefined, `${e.id} never launched`);
    assertEquals(
      launched.image,
      e.image.replace(/:[^/@]*@/, "@"),
      `${e.id} runs its pinned digest`,
    );
    assertEquals(launched.publish, undefined, `${e.id} is never published`);
    assertEquals(launched.lifetime, "shared");
    assert(
      !JSON.stringify([launched.env, launched.secretEnv]).includes(secret) &&
        !launched.command.includes(secret),
      `${e.id} leaks a secret into its container`,
    );
    assertEquals((await store.getServer("ms-1"))?.host?.status, "healthy", e.id);
  }
});

test("Grafana: the headers mcp-grafana reads, read-only by default, the URL as a setting", async () => {
  const grafana = (await (await directoryCatalogue()).get("grafana")) as HostedCatalogueEntry;
  // Verified against mcpgrafana.go (v1.4.0): header values take precedence over env, which is
  // what lets the token stay sealed here and ride each call.
  assertEquals(Object.keys(grafana.credential.headers).sort(), [
    "X-Grafana-Service-Account-Token",
    "X-Grafana-URL",
  ]);
  assertEquals(secretHeadersOf(grafana).map((s) => s.name), ["X-Grafana-Service-Account-Token"]);
  assert(/^grafana\/mcp-grafana:[^@]+@sha256:[a-f0-9]{64}$/.test(grafana.image));
  assertEquals(grafana.path, "/mcp");
  assertEquals(grafana.command, ["-t", "streamable-http", "--address", "0.0.0.0:8000"]);
  // The card's mark: Simple Icons' Grafana (CC0), in the brand orange, as an inline SVG.
  assertEquals(grafana.brand?.color, "#F46800");
  assert(grafana.brand?.logo.startsWith("<svg"));

  const defaults = await resolveSettings(grafana, {
    GRAFANA_URL: "https://grafana.example.com",
  }, { checkUrl: checkUrl() });
  assert(defaults.ok);
  assertEquals(defaults.settings, { GRAFANA_URL: "https://grafana.example.com", readOnly: true });
  const readOnly = launchOf(grafana, defaults.settings);
  assertEquals(readOnly.command.at(-1), "--disable-write");
  assertEquals(readOnly.env, { GRAFANA_URL: "https://grafana.example.com" });

  const writable = await resolveSettings(grafana, { readOnly: false }, {
    base: defaults.settings,
    checkUrl: checkUrl(),
  });
  assert(writable.ok);
  assertEquals(launchOf(grafana, writable.settings).command.includes("--disable-write"), false);

  const headers = composeHeaders(grafana, defaults.settings, {
    "X-Grafana-Service-Account-Token": "glsa_abcdefgh1234",
  });
  assert(headers.ok);
  assertEquals(headers.headers, {
    "X-Grafana-URL": "https://grafana.example.com",
    "X-Grafana-Service-Account-Token": "glsa_abcdefgh1234",
  });
  assertEquals(headers.trace, "1234");
});

test("an entry may not name a mount, ask for privileges, or carry unknown keys", () => {
  assert(refusal(entry({ mounts: [{ source: "/", target: "/host" }] })).includes("mounts"));
  assert(refusal(entry({ volumes: ["/var/run/docker.sock:/sock"] })).includes("volumes"));
  assert(refusal(entry({ privileged: true })).includes("privileged"));
  assert(refusal(entry({ capabilities: ["NET_ADMIN"] })).includes("capabilities"));
  assert(refusal(entry({ user: "root" })).includes("user"));
  assert(refusal(entry({ network: "host" })).includes("network"));
});

test("an entry sizes itself, in a spelling all three backends understand", () => {
  // The value reaches `docker run --cpus` verbatim, which does not parse Kubernetes' milli
  // spelling, so the schema refuses it here rather than at a launch that only fails on some
  // backends. (`container run --cpus` takes whole vCPUs; that adapter rounds a fraction up.)
  assert(CatalogueEntrySchema.safeParse(entry({ cpus: "0.25" })).success);
  assert(CatalogueEntrySchema.safeParse(entry({ cpus: "2" })).success);
  assert(CatalogueEntrySchema.safeParse(entry({ memory: "2g", cpus: "1.5" })).success);
  for (const cpus of ["250m", "1000m", "0.25 ", "-1", "1e0", "", "0.001", "16", "one"]) {
    assert(refusal(entry({ cpus })).includes("cpus"), cpus);
  }
  // Sizing is optional: an entry that says nothing takes the deployment's default.
  const parsed = CatalogueEntrySchema.safeParse(entry());
  assert(parsed.success && parsed.data.kind === "hosted");
  assertEquals(parsed.data.cpus, undefined);
  assertEquals(parsed.data.memory, undefined);
});

test("an entry must pin a digest", () => {
  for (
    const image of [
      "example/demo:latest",
      "example/demo",
      "example/demo@sha256:abc",
      `-example/demo@${DIGEST}`,
    ]
  ) {
    assert(refusal(entry({ image })).includes("image"), image);
  }
  assert(CatalogueEntrySchema.safeParse(entry({ image: `ghcr.io/o/r@${DIGEST}` })).success);
});

test("an entry may not reference a setting the operator was not asked for", () => {
  const credential = {
    delivery: "headers",
    headers: { "X-Base": { from: "setting:NOT_ASKED" }, "X-Token": { label: "T", secret: true } },
  };
  assert(refusal(entry({ credential })).includes("NOT_ASKED"));
  // Nor a toggle, whose value is a flag and not a header value.
  const toToggle = {
    delivery: "headers",
    headers: { "X-Ro": { from: "setting:readOnly" } },
  };
  assert(refusal(entry({ credential: toToggle })).includes("readOnly"));
});

test("an entry may not ask for its credential any way but headers", () => {
  for (const delivery of ["env", "file", "stdio"]) {
    const credential = { delivery, headers: { "X-Token": { label: "T", secret: true } } };
    assert(refusal(entry({ credential })).includes("delivery"), delivery);
  }
  // A secret header that tries to be delivered as env inside the header spec is refused too.
  const sneaky = {
    delivery: "headers",
    headers: { "X-Token": { label: "T", secret: true, env: "TOKEN" } },
  };
  assert(!CatalogueEntrySchema.safeParse(entry({ credential: sneaky })).success);
});

test("no entry may name a proxy variable: the tool host sets a hosted server's way out", () => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY"]) {
    const settings = [{ key: "PROXY", label: "Proxy", kind: "text", env: name }];
    assert(
      refusal(entry({ settings, credential: { delivery: "headers", headers: {} } }))
        .includes("reserved"),
      name,
    );
    assert(refusal(entry({ callerAuth: { env: name } })).includes("reserved"), name);
  }
  assert(refusal(entry({ callerAuth: { env: "NODE_USE_ENV_PROXY" } })).includes("reserved"));
});

test("caller auth: its own env var, and Authorization left free to carry it", () => {
  assert(CatalogueEntrySchema.safeParse(entry({ callerAuth: { env: "SERVER_TOKEN" } })).success);
  // Required — an entry cannot ship the hole by saying nothing. The tools network keeps runs out,
  // but not the other hosted servers on it (nor runs under OrbStack, whose networks do not
  // isolate), so this is the layer that holds against them.
  assert(refusal(entry({ callerAuth: undefined })).includes("callerAuth"));
  // An image that genuinely cannot authenticate its callers says so, with a reason a reviewer
  // reads beside it — never a bare `none`.
  assert(
    CatalogueEntrySchema.safeParse(entry({
      callerAuth: { none: true, reason: "demo serves one fixed public dataset and reads no token" },
    })).success,
  );
  assert(refusal(entry({ callerAuth: { none: true } })).includes("callerAuth"));
  assert(refusal(entry({ callerAuth: { none: true, reason: "because" } })).includes("callerAuth"));
  assert(
    refusal(entry({ callerAuth: { none: false, reason: "x".repeat(30) } })).includes("callerAuth"),
  );
  // Not a setting's env var…
  assert(refusal(entry({ callerAuth: { env: "BASE_URL" } })).includes("duplicate env"));
  // …not lower-case or shell-ish…
  assert(refusal(entry({ callerAuth: { env: "token; rm" } })).includes("env"));
  // …not with anything else in it (neither arm of the union accepts an extra key)…
  assert(refusal(entry({ callerAuth: { env: "T", header: "X-Auth" } })).includes("callerAuth"));
  // …and no credential header may claim Authorization, which is where the caller token rides.
  const credential = {
    delivery: "headers",
    headers: { authorization: { label: "Token", secret: true } },
  };
  assert(refusal(entry({ callerAuth: { env: "T" }, credential })).includes("Authorization"));
});

test("Grafana authenticates its callers — the guard's token, not the operator's", async () => {
  const grafana = (await (await directoryCatalogue()).get("grafana")) as HostedCatalogueEntry;
  // mcp-grafana ≥ 1.4 reads it from MCP_GRAFANA_SERVER_TOKEN and wants `Authorization: Bearer`.
  assertEquals(grafana.callerAuth, { env: "MCP_GRAFANA_SERVER_TOKEN" });
});

test("settings resolve against the entry: known keys, required answers, http(s) urls", async () => {
  const e = CatalogueEntrySchema.parse(entry()) as HostedCatalogueEntry;
  const ok = await resolveSettings(e, { BASE_URL: " https://svc.example.com " }, {
    checkUrl: checkUrl(),
  });
  assert(ok.ok);
  assertEquals(ok.settings, { BASE_URL: "https://svc.example.com", readOnly: true });
  for (
    const [input, fragment] of [
      [{}, "required"],
      [{ BASE_URL: "svc.example.com" }, "absolute URL"],
      [{ BASE_URL: "ftp://svc.example.com" }, "http(s)"],
      [{ BASE_URL: "https://u:p@svc.example.com" }, "credential"],
      [{ BASE_URL: "https://svc.example.com", readOnly: "yes" }, "true or false"],
      [{ BASE_URL: "https://svc.example.com", EXTRA: "x" }, "no such setting"],
    ] as const
  ) {
    const r = await resolveSettings(e, input, { checkUrl: checkUrl() });
    assert(!r.ok && r.error.includes(fragment), `${JSON.stringify(input)} → ${!r.ok && r.error}`);
  }
});

test("a url setting meets the upstream rule, flags and all — it is a header, not just env", async () => {
  // The value becomes the container's env AND a sealed header riding every call beside the
  // operator's token, so the loopback / link-local / private-range rule applies to it exactly as
  // it does to a remote upstream. 169.254.169.254 is the one that matters most.
  const e = CatalogueEntrySchema.parse(entry()) as HostedCatalogueEntry;
  for (
    const [url, fragment] of [
      ["https://127.0.0.1:3000/", "private"],
      ["https://localhost/", "loopback"],
      ["https://169.254.169.254/latest/meta-data/", "private"],
      ["https://10.0.0.5/", "private"],
      ["https://192.168.1.10/", "private"],
      ["https://172.16.4.4/", "private"],
      ["https://[::1]/", "private"],
      ["https://nowhere.invalid/", "does not resolve"],
      ["http://svc.example.com/", "RYPH_MCP_ALLOW_INSECURE"],
    ] as const
  ) {
    const r = await resolveSettings(e, { BASE_URL: url }, { checkUrl: checkUrl() });
    assert(!r.ok, `${url} was accepted`);
    assert(r.error.startsWith("settings.BASE_URL: "), r.error);
    assert(r.error.includes(fragment), `${url} → ${r.error}`);
  }
  const ok = await resolveSettings(e, { BASE_URL: "https://svc.example.com" }, {
    checkUrl: checkUrl(),
  });
  assert(ok.ok, !ok.ok ? ok.error : "");

  // And the flags widen it here exactly as much as they widen a remote upstream, never more.
  const open = { checkUrl: checkUrl({ allowPrivate: true, allowInsecure: true }) };
  assert((await resolveSettings(e, { BASE_URL: "http://127.0.0.1:3000/" }, open)).ok);
  const insecureOnly = { checkUrl: checkUrl({ allowInsecure: true }) };
  assert(!(await resolveSettings(e, { BASE_URL: "http://10.0.0.5/" }, insecureOnly)).ok);
});

test("a url the operator did not touch is checked too, so an edit cannot slip one past", async () => {
  // A PATCH may name one setting; the rest come from the row. Every url in the RESULT is judged,
  // because all of them are relaunched into the container and resealed into the header map.
  const e = CatalogueEntrySchema.parse(entry()) as HostedCatalogueEntry;
  const r = await resolveSettings(e, { readOnly: false }, {
    base: { BASE_URL: "https://169.254.169.254/", readOnly: true },
    checkUrl: checkUrl(),
  });
  assert(!r.ok && r.error.includes("private"), !r.ok ? r.error : "accepted");
});

test("secrets are required, single-line, and only the ones the entry names", () => {
  const e = CatalogueEntrySchema.parse(entry()) as HostedCatalogueEntry;
  const settings = { BASE_URL: "https://svc.example.com", readOnly: true };
  const missing = composeHeaders(e, settings, {});
  assert(!missing.ok && missing.error.includes("Token is required"));
  const spaced = composeHeaders(e, settings, { "X-Token": "has a space" });
  assert(!spaced.ok && spaced.error.includes("no spaces"));
  const control = composeHeaders(e, settings, { "X-Token": "tok\u0000en-1234" });
  assert(!control.ok && control.error.includes("printable ASCII"));
  const unknown = composeHeaders(e, settings, { "X-Token": "tok-12345678", "X-Other": "x" });
  assert(!unknown.ok && unknown.error.includes("X-Other"));
});

test("digest helpers keep the repository and swap the digest", () => {
  const image = `grafana/mcp-grafana:1.4.0@${DIGEST}`;
  assertEquals(digestOf(image), DIGEST);
  const older = `sha256:${"b".repeat(64)}`;
  assertEquals(atDigest(image, older), `grafana/mcp-grafana@${older}`);
  assertEquals(atDigest(`localhost/x@${DIGEST}`, older), `localhost/x@${older}`);
});

test("a directory with an invalid entry fails the load, naming the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await writeFile(join(dir, "demo.json"), JSON.stringify(entry({ privileged: true })));
    await assertRejects(() => directoryCatalogue(dir), Error, "demo.json");
    await writeFile(join(dir, "demo.json"), JSON.stringify(entry()));
    await writeFile(join(dir, "other.json"), JSON.stringify(entry()));
    await assertRejects(() => directoryCatalogue(dir), Error, "does not match the file name");
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ── Remote presets ───────────────────────────────────────────────────────────────────────────

function remoteEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "remote",
    id: "vendor",
    name: "Vendor",
    description: "A vendor's own MCP endpoint.",
    docs: "https://example.com/vendor",
    url: "https://{region}.vendor.example/mcp{readOnly}{project}",
    settings: [
      {
        key: "region",
        label: "Region",
        kind: "choice",
        default: "us",
        options: [
          { value: "us", label: "US", url: "mcp" },
          { value: "eu", label: "EU", url: "mcp.eu" },
        ],
      },
      {
        key: "readOnly",
        label: "Read-only",
        kind: "toggle",
        default: true,
        url: { true: "/readonly" },
      },
      {
        key: "project",
        label: "Project",
        kind: "text",
        optional: true,
        placeholder: "my-project",
        pattern: "^[a-z0-9 -]{1,40}$",
        urlPrefix: "?project=",
      },
    ],
    credential: {
      delivery: "headers",
      headers: { Authorization: { label: "API key", secret: true, prefix: "Bearer " } },
    },
    defaultOff: ["delete_issue"],
    ...overrides,
  };
}

const remoteSettings = (patch: Record<string, unknown>) =>
  (remoteEntry().settings as Array<Record<string, unknown>>).map((s) =>
    s.key === patch.key ? { ...s, ...patch } : s
  );

test("a remote entry: a reviewed https URL, settings that shape it, secret headers", () => {
  const parsed = CatalogueEntrySchema.safeParse(remoteEntry());
  assert(parsed.success, !parsed.success ? parsed.error.message : "");
  assertEquals(parsed.data.kind, "remote");
  assertEquals(parsed.data.defaultOff, ["delete_issue"]);
  // No settings at all is fine too: a fixed endpoint.
  assert(
    CatalogueEntrySchema.safeParse(
      remoteEntry({ url: "https://mcp.vendor.example/mcp", settings: [] }),
    )
      .success,
  );
});

test("a remote entry keeps everything but a reviewed choice out of the host", () => {
  assert(
    refusal(remoteEntry({ url: "https://{region}{project}.vendor.example/mcp{readOnly}" }))
      .includes("{project} is in the host"),
  );
  assert(
    refusal(remoteEntry({ url: "https://{region}{readOnly}.vendor.example/mcp{project}" }))
      .includes("{readOnly} is in the host"),
  );
});

test("a remote entry's placeholders and settings match one to one", () => {
  assert(
    refusal(remoteEntry({ url: "https://{region}.vendor.example/mcp{readOnly}{project}{nope}" }))
      .includes("{nope} names no setting"),
  );
  assert(
    refusal(remoteEntry({ url: "https://{region}.vendor.example/mcp{readOnly}" }))
      .includes("{project} must appear in the url exactly once"),
  );
  assert(
    refusal(remoteEntry({ url: "https://{region}.vendor.example/mcp{readOnly}{project}{project}" }))
      .includes("{project} must appear in the url exactly once"),
  );
});

test("a remote entry's URL is https, and nothing else", () => {
  for (
    const url of [
      "http://{region}.vendor.example/mcp{readOnly}{project}",
      "https://user@{region}.vendor.example/mcp{readOnly}{project}",
      "https://{region}.vendor.example/mcp{readOnly}{project}#frag",
    ]
  ) {
    assert(refusal(remoteEntry({ url })).includes("url"), url);
  }
});

test("a typed value needs an anchored pattern before it may reach the URL", () => {
  const { pattern: _, ...withoutPattern } = remoteSettings({ key: "project" })[2];
  const settings = [...remoteSettings({}).slice(0, 2), withoutPattern];
  assert(refusal(remoteEntry({ settings })).includes("pattern"));
  for (const pattern of ["[a-z]+", "^[a-z]+", "[a-z]+$", "^[a-z+$"]) {
    assert(
      refusal(remoteEntry({ settings: remoteSettings({ key: "project", pattern }) }))
        .includes("anchored"),
      pattern,
    );
  }
});

test("a fragment is URL text: no @, #, braces, backslash or whitespace", () => {
  for (const text of ["@evil.example", "/x#y", "{project}", "a\\b", "a b"]) {
    assert(
      refusal(remoteEntry({ settings: remoteSettings({ key: "readOnly", url: { true: text } }) }))
        .includes("URL text only"),
      text,
    );
    const options = [
      { value: "us", label: "US", url: "mcp" },
      { value: "eu", label: "EU", url: text },
    ];
    assert(
      refusal(remoteEntry({ settings: remoteSettings({ key: "region", options }) }))
        .includes("URL text only"),
      text,
    );
    assert(
      refusal(remoteEntry({ settings: remoteSettings({ key: "project", urlPrefix: text }) }))
        .includes("URL text only"),
      text,
    );
  }
});

test("a choice defaults to one of its options", () => {
  assert(
    refusal(remoteEntry({ settings: remoteSettings({ key: "region", default: "ap" }) }))
      .includes("not an option"),
  );
});

test("a remote entry names a secret header, and only secret headers", () => {
  assert(
    refusal(remoteEntry({ credential: { delivery: "headers", headers: {} } }))
      .includes("at least one credential header"),
  );
  // No setting-derived header: there is no url setting for one to carry.
  const fromSetting = {
    delivery: "headers",
    headers: { "X-Project": { from: "setting:project" } },
  };
  assert(refusal(remoteEntry({ credential: fromSetting })).includes("credential"));
  assert(
    refusal(
      remoteEntry({
        credential: {
          delivery: "headers",
          headers: { Authorization: { label: "Key", secret: true, prefix: "Bearer\n" } },
        },
      }),
    ).includes("prefix"),
  );
});

test("remoteUrlOf: toggles, choices, and typed values encoded behind their prefix", async () => {
  const e = CatalogueEntrySchema.parse(remoteEntry()) as RemoteCatalogueEntry;
  const render = async (input: Record<string, unknown>) => {
    const r = await resolveSettings(e, input, { checkUrl: checkUrl() });
    assert(r.ok, !r.ok ? r.error : "");
    return remoteUrlOf(e, r.settings);
  };
  // Defaults: the toggle's on text, the default choice, and an optional text left out entirely.
  assertEquals(await render({}), "https://mcp.vendor.example/mcp/readonly");
  assertEquals(await render({ project: "  " }), "https://mcp.vendor.example/mcp/readonly");
  // Off has no text here, so it contributes nothing.
  assertEquals(
    await render({ readOnly: false, region: "eu" }),
    "https://mcp.eu.vendor.example/mcp",
  );
  // Typed text is trimmed, matched, percent-encoded, and put behind its reviewed prefix.
  assertEquals(
    await render({ project: " my project " }),
    "https://mcp.vendor.example/mcp/readonly?project=my%20project",
  );

  for (
    const [input, fragment] of [
      [{ project: "a/b" }, "not a valid Project"],
      [{ project: "x@evil.example" }, "not a valid Project"],
      [{ region: "ap" }, "must be one of us, eu"],
      [{ region: true }, "must be one of"],
      [{ readOnly: "yes" }, "true or false"],
    ] as const
  ) {
    const r = await resolveSettings(e, input, { checkUrl: checkUrl() });
    assert(!r.ok && r.error.includes(fragment), `${JSON.stringify(input)} → ${!r.ok && r.error}`);
  }
});

test("a pattern holds the whole value, alternation and all, and a dot segment never passes", async () => {
  const dots = CatalogueEntrySchema.parse(
    remoteEntry({ settings: remoteSettings({ key: "project", pattern: "^[a-z.]{1,4}$" }) }),
  ) as RemoteCatalogueEntry;
  for (const value of [".", ".."]) {
    const r = await resolveSettings(dots, { project: value }, { checkUrl: checkUrl() });
    assert(!r.ok && r.error.includes("not a valid Project"), value);
  }
  // `^a|b$` passes the lexical anchoring check; unwrapped, "axe" would match its first half.
  const narrow = CatalogueEntrySchema.parse(
    remoteEntry({ settings: remoteSettings({ key: "project", pattern: "^a|b$" }) }),
  ) as RemoteCatalogueEntry;
  const r = await resolveSettings(narrow, { project: "axe" }, { checkUrl: checkUrl() });
  assert(!r.ok, "each alternative must match the whole value");
  assert((await resolveSettings(narrow, { project: "b" }, { checkUrl: checkUrl() })).ok);
});

test("a choice in the host spells a hostname: no port, path or query", () => {
  for (const url of ["mcp:8443", "mcp/x", "mcp?x=1", "MCP"]) {
    const options = [{ value: "us", label: "US", url }, {
      value: "eu",
      label: "EU",
      url: "mcp.eu",
    }];
    assert(
      refusal(remoteEntry({ settings: remoteSettings({ key: "region", options }) }))
        .includes("hostname text only"),
      url,
    );
  }
});

test("composeHeaders puts the prefix on; secretsFromHeaders takes it back off", () => {
  const e = CatalogueEntrySchema.parse(remoteEntry()) as RemoteCatalogueEntry;
  const composed = composeHeaders(e, {}, { Authorization: "vk_live_abcd1234" });
  assert(composed.ok);
  assertEquals(composed.headers, { Authorization: "Bearer vk_live_abcd1234" });
  // The trace is the secret's, not the prefix's.
  assertEquals(composed.trace, "1234");
  assertEquals(secretsFromHeaders(e, composed.headers), { Authorization: "vk_live_abcd1234" });
  // Round-trips: recomposing what came back seals the same map, with one prefix, not two.
  const again = composeHeaders(e, {}, secretsFromHeaders(e, composed.headers));
  assert(again.ok);
  assertEquals(again.headers, composed.headers);
  assertEquals(secretsFromHeaders(e, {}), {});
});

test("every shipped remote entry renders an https URL from its defaults and every choice", async () => {
  // The review question for a preset: its typed settings' placeholders are valid examples of what
  // they ask for (so the form's hint is never a value it would refuse), and with those, the
  // defaults, and each option of each choice, the URL is an absolute https one.
  const catalogue = await directoryCatalogue();
  for (const e of await catalogue.list()) {
    if (e.kind !== "remote") continue;
    const answers: Record<string, unknown> = {};
    for (const s of e.settings) {
      if (s.kind !== "text") continue;
      assert(s.placeholder !== undefined, `${e.id}.${s.key} has no placeholder`);
      assert(
        new RegExp(s.pattern).test(s.placeholder),
        `${e.id}.${s.key}: placeholder "${s.placeholder}" does not match ${s.pattern}`,
      );
      answers[s.key] = s.placeholder;
    }
    const variants: Array<Record<string, unknown>> = [{}, answers];
    for (const s of e.settings) {
      if (s.kind === "choice") {
        for (const o of s.options) variants.push({ ...answers, [s.key]: o.value });
      }
      if (s.kind === "toggle") variants.push({ ...answers, [s.key]: !s.default });
    }
    for (const input of variants) {
      const r = await resolveSettings(e, input, { checkUrl: checkUrl() });
      if (!r.ok) {
        // Only a required text left out of the bare-defaults variant may refuse.
        assert(Object.keys(input).length === 0 && r.error.includes("is required"), r.error);
        continue;
      }
      const url = new URL(remoteUrlOf(e, r.settings));
      assertEquals(url.protocol, "https:", `${e.id}: ${url}`);
      assert(url.hostname.includes("."), `${e.id}: ${url}`);
      assertEquals([url.username, url.password, url.hash], ["", "", ""], `${e.id}: ${url}`);
    }
  }
});
