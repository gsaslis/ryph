// The catalogue: which MCP servers this platform knows how to set up, as data. One JSON file per
// entry under packages/mcp-gateway/catalogue/, validated here at load and reviewed like code.
// An entry is one of two kinds:
//
// - `hosted`: an image the gateway runs on the tools network (Grafana). The catalogue is then
//   the list of images the platform will run on an operator's machine.
// - `remote`: a PRESET for a vendor's own MCP endpoint (Linear, Sentry, …) — a reviewed URL, the
//   settings that may shape it, and the headers the vendor's static key rides in. No container;
//   the row it creates is an ordinary remote row whose URL the entry, not the operator, wrote.
//
// What a remote entry may NOT do, and this schema refuses: let anything the operator TYPES reach
// the URL's host (only a reviewed choice may vary it — a Datadog site), put a typed value in the
// URL without an anchored pattern it must match, leave the URL anything but https, or deliver its
// credential any way but headers. The URL that results still meets the same upstream rule every
// remote URL does (core/upstream_guard.ts), at create and on every settings edit.
//
// What a hosted entry may NOT do, and this schema refuses: name a mount, request privileges (both are
// unknown keys to a strict schema, so neither can even be spelled), reference a setting the
// operator was not asked for, point at an unpinned tag, have its credential delivered any way
// but headers, or be silent about how its image authenticates ITS callers (`callerAuth` is
// required; an image that cannot says `{ none: true, reason }`, which a reviewer weighs). Headers-only is the first version's whole security story: the credential stays
// sealed in the gateway and rides each call, so no tool container is ever launched holding one.
// An env-delivered credential (a `delivery: "env"` arm) and a stdio bridge are each one extension
// away and deliberately absent until a server that needs them is actually wanted.
//
// Pure: parsing, settings resolution and the derivations a launch needs. Loading files is the
// directory adapter's job (adapters/catalogue/directory.ts), behind the Catalogue port.

import { z } from "@zod/zod";
import type { HostSettings } from "./types.ts";
import { TOOL_PROXY_ENV_NAMES } from "./tool_egress.ts";
import { credentialHeadersProblem } from "./credential_headers.ts";

/**
 * `repo[:tag]@sha256:<64 hex>` — the digest is what gets pulled, the tag is for the reviewer. An
 * unpinned reference is refused wherever an image is named (catalogue entries, custom rows): a
 * tag can be moved under us, and this is the list of code the platform runs.
 */
export const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

/** The digest half of a pinned reference. */
export function digestOf(image: string): string {
  return image.slice(image.indexOf("@") + 1);
}

/** The same image at another digest — how a row keeps running what it was launched from. */
export function atDigest(image: string, digest: string): string {
  const repo = image.slice(0, image.indexOf("@")).replace(/:[^/]*$/, "");
  return `${repo}@${digest}`;
}

/** Docker's memory spelling, capped at a sane ceiling for a tool server. */
export const MEMORY = /^[1-9][0-9]{0,4}[mg]$/;

/**
 * A CPU cap, in whole CPUs — "0.25", "1", "2.5". DECIMAL, never Kubernetes' milli spelling:
 * this value reaches `docker run --cpus` verbatim, which does not understand "250m", and
 * Kubernetes accepts the decimal form too. Capped at 8: a tool server that needs
 * more than that is not a tool server.
 */
export const CPUS = /^(?:[0-8](?:\.[0-9]{1,2})?|8(?:\.0{1,2})?)$/;

const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, {
  error: "not a valid header name",
});
const label = z.string().trim().min(1).max(80);
const blurb = z.string().trim().max(400);
const settingKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, {
  error: "setting keys are a letter, then letters, digits or underscores",
});
/** A POSIX-ish env var name. Exported: a custom container names one of these too (src/schema.ts). */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const envName = z.string().regex(ENV_NAME, { error: "not an env var name" });
const arg = z.string().min(1).max(256);

const textSetting = (kind: "url" | "text") =>
  z.object({
    key: settingKey,
    label,
    kind: z.literal(kind),
    placeholder: z.string().max(200).optional(),
    description: blurb.optional(),
    /** Also handed to the container as this env var. Settings only — never a credential. */
    env: envName.optional(),
    optional: z.boolean().optional(),
  }).strict();

const toggleSetting = z.object({
  key: settingKey,
  label,
  kind: z.literal("toggle"),
  description: blurb.optional(),
  default: z.boolean(),
  /** Extra argv when the toggle is on (`"true"`) or off (`"false"`). */
  args: z.object({ true: z.array(arg).max(8).optional(), false: z.array(arg).max(8).optional() })
    .strict().optional(),
}).strict();

const setting = z.discriminatedUnion("kind", [
  textSetting("url"),
  textSetting("text"),
  toggleSetting,
]);

// ── A remote entry's settings: each one shapes the vendor URL, and nothing else. ──────────────

/**
 * Reviewed URL text a toggle or a choice contributes (`/readonly`, `&read_only=true`, a Datadog
 * site's host). No braces, so it cannot open a placeholder; no `#`, `@`, `\` or whitespace, so it
 * cannot end the URL early, smuggle userinfo, or confuse a parser about where the host stops.
 */
const fragment = z.string().max(200).regex(/^[A-Za-z0-9._~/?&=%:+,;!$'()*-]*$/, {
  error: "URL text only: no braces, #, @, backslash or whitespace",
});

const remoteToggle = z.object({
  key: settingKey,
  label,
  kind: z.literal("toggle"),
  description: blurb.optional(),
  default: z.boolean(),
  /** What `{key}` in the entry's URL becomes when the toggle is on (`"true"`) or off. */
  url: z.object({ true: fragment.optional(), false: fragment.optional() }).strict(),
}).strict();

const optionValue = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, {
  error: "option values are slug-shaped",
});

/** One of a reviewed list — a vendor's regions. The only setting that may reach the host. */
const choiceSetting = z.object({
  key: settingKey,
  label,
  kind: z.literal("choice"),
  description: blurb.optional(),
  default: optionValue,
  options: z.array(z.object({ value: optionValue, label, url: fragment }).strict()).min(2).max(16),
}).strict();

/** A value the operator types, with the pattern it must match before it may reach the URL. */
const remoteText = z.object({
  key: settingKey,
  label,
  kind: z.literal("text"),
  placeholder: z.string().max(200).optional(),
  description: blurb.optional(),
  optional: z.boolean().optional(),
  /**
   * An anchored regular expression (`^…$`) the trimmed value must match. Required: this is
   * operator text on its way into a URL that carries the org's credential. It is
   * percent-encoded on top, so a pattern that turned out too loose still cannot reach the host.
   */
  pattern: z.string().max(200).refine((p) => {
    if (!p.startsWith("^") || !p.endsWith("$")) return false;
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, { error: "an anchored regular expression: ^…$" }),
  /** Reviewed text put before the value when one is given (`"/"` for a path segment). */
  urlPrefix: fragment.optional(),
}).strict();

const remoteSetting = z.discriminatedUnion("kind", [remoteToggle, choiceSetting, remoteText]);

/** Any setting either kind of entry may ask for — what the Add form renders. */
export type CatalogueSetting = z.infer<typeof setting> | z.infer<typeof remoteSetting>;

/** A header whose value comes from a setting (the Grafana URL), sealed along with the rest. */
const fromSetting = z.object({
  from: z.string().regex(/^setting:[A-Za-z][A-Za-z0-9_]{0,63}$/, {
    error: 'must be "setting:<KEY>"',
  }),
}).strict();

/** A header whose value is the operator's secret: asked for once, sealed, never shown again. */
const secretHeader = z.object({
  label,
  secret: z.literal(true),
  /**
   * Reviewed text put in front of what the operator pastes — `"Bearer "`, PagerDuty's
   * `"Token token="` — so the form asks for the key alone. Part of the sealed value.
   */
  prefix: z.string().regex(/^[A-Za-z][A-Za-z0-9 =_-]{0,31}$/, {
    error: 'a short scheme like "Bearer "',
  }).optional(),
  placeholder: z.string().max(200).optional(),
  description: blurb.optional(),
}).strict();

/**
 * Tools an agent's policy should leave unticked unless someone means it: the writes, the
 * destructive and the money-moving ones. Advice the agent form acts on, never enforcement — the
 * allowlist an admin saves is what the data plane holds a run to.
 */
const toolName = z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/, { error: "not a tool name" });
const defaultOff = z.array(toolName).max(128).optional();

/**
 * How an entry looks on a card: the vendor's mark and its colour. The logo is an SVG document,
 * inline — the catalogue is a directory of files and ships with the gateway, so there is nothing
 * to fetch and no host to trust — and the app shows it as an image, never as markup, so a
 * catalogue author cannot put script on the page through it; the checks here are the cheap ones.
 */
const brand = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: "a hex colour like #F46800" }),
  logo: z.string().max(16_000).regex(/^<svg[\s>]/, { error: "an inline SVG document" }).refine(
    (svg) => !/<script|\bon[a-z]+\s*=|javascript:/i.test(svg),
    { error: "no script in a logo" },
  ),
}).strict();

const entryId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, {
  error: "ids are slug-shaped, ≤31 chars",
});

/** Why an entry may not name a proxy variable. */
const RESERVED_ENV = "reserved: the tool host sets a hosted server's proxy itself";

export const HostedEntrySchema = z.object({
  kind: z.literal("hosted"),
  id: entryId,
  name: label,
  description: blurb,
  docs: z.url({ protocol: /^https$/ }),
  brand: brand.optional(),
  defaultOff,
  image: z.string().regex(PINNED_IMAGE, {
    error: "must be digest-pinned: repo[:tag]@sha256:<64 hex>",
  }),
  port: z.int().min(1).max(65535),
  path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, { error: "must be an absolute path" }),
  command: z.array(arg).max(32),
  memory: z.string().regex(MEMORY, { error: 'a memory size like "512m"' }).optional(),
  cpus: z.string().regex(CPUS, { error: 'a CPU count like "0.25" or "2"' }).optional(),
  settings: z.array(setting).max(16),
  credential: z.object({
    // A literal, not an enum: headers is the only delivery this version implements, and an
    // entry asking for anything else has to be refused at load rather than half-supported.
    delivery: z.literal("headers"),
    headers: z.record(headerName, z.union([fromSetting, secretHeader])),
  }).strict(),
  /**
   * The server authenticates its CALLERS with `Authorization: Bearer <token>`, the token read
   * from this env var. The gateway mints one per launch, hands it to the container and to the
   * guard, and nothing else holds it — so a run that reaches the container's address directly
   * (on a backend whose networks do not isolate: OrbStack, measured) is refused by the server
   * itself. Not the operator's credential: a random value that only opens this one container.
   *
   * REQUIRED, because it is the layer that holds where the network does not, and an entry that
   * simply omitted it would ship that hole silently. An image that genuinely cannot authenticate
   * its callers says so out loud instead — `{ none: true, reason }`, which a reviewer reads
   * beside the image and accepts or does not.
   */
  callerAuth: z.union([
    z.object({ env: envName }).strict(),
    z.object({
      none: z.literal(true),
      reason: z.string().trim().min(20).max(400),
    }).strict(),
  ]),
  /** false: the server keeps per-run state and needs per-run instances, which do not exist yet. */
  shared: z.boolean(),
}).strict().superRefine((entry, ctx) => {
  const keys = new Set<string>();
  const callerEnv = callerAuthEnvOf(entry);
  const envs = new Set<string>(callerEnv === null ? [] : [callerEnv]);
  if (
    callerEnv !== null &&
    Object.keys(entry.credential.headers).some((h) => h.toLowerCase() === "authorization")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["credential", "headers"],
      message: "Authorization carries the caller token when callerAuth is set",
    });
  }
  // The proxy a confined tool host hands every launch (core/tool_egress.ts) is the hosted
  // server's one way out, so no entry may name its env: a setting that did would steer a vendor's
  // client off the relay, and one beside it would be overwritten without a word.
  if (callerEnv !== null && TOOL_PROXY_ENV_NAMES.has(callerEnv)) {
    ctx.addIssue({ code: "custom", path: ["callerAuth", "env"], message: RESERVED_ENV });
  }
  for (const [i, s] of entry.settings.entries()) {
    if (keys.has(s.key)) {
      ctx.addIssue({ code: "custom", path: ["settings", i, "key"], message: "duplicate key" });
    }
    keys.add(s.key);
    if (s.kind !== "toggle" && s.env !== undefined) {
      if (envs.has(s.env)) {
        ctx.addIssue({ code: "custom", path: ["settings", i, "env"], message: "duplicate env" });
      }
      if (TOOL_PROXY_ENV_NAMES.has(s.env)) {
        ctx.addIssue({ code: "custom", path: ["settings", i, "env"], message: RESERVED_ENV });
      }
      envs.add(s.env);
    }
  }
  for (const [name, source] of Object.entries(entry.credential.headers)) {
    if (!("from" in source)) continue;
    const key = source.from.slice("setting:".length);
    const target = entry.settings.find((s) => s.key === key);
    if (target === undefined || target.kind === "toggle") {
      ctx.addIssue({
        code: "custom",
        path: ["credential", "headers", name, "from"],
        message: `names "${key}", which is not a text or url setting of this entry`,
      });
    }
  }
});
export type HostedCatalogueEntry = z.infer<typeof HostedEntrySchema>;

/** `{key}` in a remote entry's URL: where that setting's value goes. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;

export const RemoteEntrySchema = z.object({
  kind: z.literal("remote"),
  id: entryId,
  name: label,
  description: blurb,
  docs: z.url({ protocol: /^https$/ }),
  brand: brand.optional(),
  defaultOff,
  /**
   * The vendor's endpoint, with `{key}` where a setting goes: `https://mcp.linear.app/mcp{readOnly}`.
   * https, always — the operator's flags that allow plain http are for URLs operators type.
   */
  url: z.string().max(400).regex(/^https:\/\/[A-Za-z0-9.{}_-]+(?:[/?][^\s#\\@]*)?$/, {
    error: "an https URL, with {key} placeholders",
  }),
  settings: z.array(remoteSetting).max(16),
  credential: z.object({
    delivery: z.literal("headers"),
    // Secret headers only: a remote entry has no url setting for a header to carry.
    headers: z.record(headerName, secretHeader).refine((h) => Object.keys(h).length > 0, {
      error: "a remote entry names at least one credential header",
    }),
  }).strict(),
}).strict().superRefine((entry, ctx) => {
  const keys = new Set<string>();
  for (const [i, s] of entry.settings.entries()) {
    if (keys.has(s.key)) {
      ctx.addIssue({ code: "custom", path: ["settings", i, "key"], message: "duplicate key" });
    }
    keys.add(s.key);
    if (s.kind === "choice") {
      const values = s.options.map((o) => o.value);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", i, "options"],
          message: "duplicate value",
        });
      }
      if (!values.includes(s.default)) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", i, "default"],
          message: "not an option",
        });
      }
    }
  }
  const used = [...entry.url.matchAll(PLACEHOLDER)].map((m) => m[1]);
  for (const key of used) {
    if (!keys.has(key)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: `{${key}} names no setting` });
    }
  }
  for (const [i, s] of entry.settings.entries()) {
    if (used.filter((k) => k === s.key).length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["settings", i, "key"],
        message: `{${s.key}} must appear in the url exactly once`,
      });
    }
  }
  // The host — everything between the scheme and the first / or ? — is reviewed text, or a
  // reviewed choice. Never a toggle's text spliced into a name, and never anything typed.
  const authority = entry.url.slice("https://".length).split(/[/?]/, 1)[0];
  for (const m of authority.matchAll(PLACEHOLDER)) {
    const s = entry.settings.find((x) => x.key === m[1]);
    if (s !== undefined && s.kind !== "choice") {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `{${m[1]}} is in the host, and only a choice setting may be`,
      });
    }
    // A choice in the host spells host text and nothing else: no port, path or query riding in.
    if (s?.kind === "choice") {
      for (const [j, o] of s.options.entries()) {
        if (!/^[a-z0-9.-]+$/.test(o.url)) {
          ctx.addIssue({
            code: "custom",
            path: ["settings", entry.settings.indexOf(s), "options", j, "url"],
            message: "a choice in the host is hostname text only",
          });
        }
      }
    }
  }
});
export type RemoteCatalogueEntry = z.infer<typeof RemoteEntrySchema>;

export const CatalogueEntrySchema = z.discriminatedUnion("kind", [
  HostedEntrySchema,
  RemoteEntrySchema,
]);
export type CatalogueEntry = z.infer<typeof CatalogueEntrySchema>;

/** The env var this entry's image reads its caller token from, or null where it opted out. */
export function callerAuthEnvOf(entry: Pick<HostedCatalogueEntry, "callerAuth">): string | null {
  return "env" in entry.callerAuth ? entry.callerAuth.env : null;
}

/** The entry's secret headers — the fields the Add form asks for beside the settings. */
export function secretHeadersOf(
  entry: CatalogueEntry,
): Array<
  { name: string; label: string; prefix?: string; placeholder?: string; description?: string }
> {
  return Object.entries(entry.credential.headers).flatMap(([name, source]) =>
    "secret" in source
      ? [{
        name,
        label: source.label,
        prefix: source.prefix,
        placeholder: source.placeholder,
        description: source.description,
      }]
      : []
  );
}

/**
 * The operator's secrets back out of a row's unsealed header map — each header's value with the
 * entry's prefix taken off — so an edit that re-derives the map (a setting moved) can re-seal
 * the same secrets around it. A header the map lacks is simply absent from the result.
 */
export function secretsFromHeaders(
  entry: CatalogueEntry,
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    secretHeadersOf(entry).flatMap((s) => {
      const value = headers[s.name];
      if (value === undefined) return [];
      const prefix = s.prefix ?? "";
      return [[s.name, value.startsWith(prefix) ? value.slice(prefix.length) : value]];
    }),
  );
}

/**
 * A remote entry's URL for these (already resolved) settings: each `{key}` replaced by the
 * toggle's or the choice's reviewed text, or by the typed value — percent-encoded, after
 * `resolveSettings` matched it against the entry's pattern — behind its reviewed prefix.
 * The caller still checks the result against the upstream rule; this only spells it.
 */
export function remoteUrlOf(entry: RemoteCatalogueEntry, settings: HostSettings): string {
  return entry.url.replace(PLACEHOLDER, (_, key: string) => {
    const s = entry.settings.find((x) => x.key === key)!;
    const value = settings[key];
    switch (s.kind) {
      case "toggle":
        return s.url[value === true ? "true" : "false"] ?? "";
      case "choice":
        return s.options.find((o) => o.value === value)?.url ?? "";
      case "text":
        return typeof value === "string" && value !== ""
          ? `${s.urlPrefix ?? ""}${encodeURIComponent(value)}`
          : "";
    }
  });
}

/**
 * How a `url`-typed setting is judged, beyond its shape: the SAME rule a remote upstream's URL
 * meets (core/upstream_guard.ts), injected because that rule resolves DNS and this module does
 * not. Not optional and not a default — a setting's URL becomes both the container's env and a
 * sealed outbound header that rides every call beside the operator's credential, so an
 * unchecked one is an SSRF hole with a credential attached.
 */
export type SettingUrlCheck = (
  url: string,
) => Promise<{ ok: true } | { ok: false; detail: string }>;

/**
 * The operator's answers checked against the entry's settings: every key known, every required
 * text answered (and matching its pattern, where the entry gives one), urls absolute http(s) AND
 * past the upstream rule, toggles boolean and choices one of their options, with their defaults
 * filled in. `base` is the row's current settings for an edit, so a PATCH may name just
 * the one that changed — and every url in the RESULT is checked, not only the ones it named.
 */
export async function resolveSettings(
  entry: CatalogueEntry,
  input: Record<string, unknown>,
  opts: { base?: HostSettings; checkUrl: SettingUrlCheck },
): Promise<{ ok: true; settings: HostSettings } | { ok: false; error: string }> {
  const base = opts.base ?? {};
  for (const key of Object.keys(input)) {
    if (!entry.settings.some((s) => s.key === key)) {
      return { ok: false, error: `settings.${key}: ${entry.name} has no such setting` };
    }
  }
  const merged: Record<string, unknown> = { ...base, ...input };
  const settings: HostSettings = {};
  for (const s of entry.settings) {
    const value = merged[s.key];
    if (s.kind === "toggle") {
      if (value === undefined) settings[s.key] = s.default;
      else if (typeof value === "boolean") settings[s.key] = value;
      else return { ok: false, error: `settings.${s.key}: must be true or false` };
      continue;
    }
    if (s.kind === "choice") {
      if (value === undefined) settings[s.key] = s.default;
      else if (s.options.some((o) => o.value === value)) settings[s.key] = value as string;
      else {
        const values = s.options.map((o) => o.value).join(", ");
        return { ok: false, error: `settings.${s.key}: must be one of ${values}` };
      }
      continue;
    }
    const text = typeof value === "string" ? value.trim() : value;
    if (text === undefined || text === "") {
      if (s.optional) continue;
      return { ok: false, error: `settings.${s.key}: ${s.label} is required` };
    }
    if (typeof text !== "string" || text.length > 2048 || /[\r\n]/.test(text)) {
      return { ok: false, error: `settings.${s.key}: must be a single line of text` };
    }
    if (s.kind === "url") {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return { ok: false, error: `settings.${s.key}: must be an absolute URL` };
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, error: `settings.${s.key}: must be an http(s) URL` };
      }
      if (url.username !== "" || url.password !== "") {
        return { ok: false, error: `settings.${s.key}: must not carry a credential` };
      }
      // The flags the remote path honours (RYPH_MCP_ALLOW_INSECURE,
      // RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS) are the injected rule's, so they mean here exactly
      // what they mean there — and mean nothing more.
      const verdict = await opts.checkUrl(text);
      if (!verdict.ok) return { ok: false, error: `settings.${s.key}: ${verdict.detail}` };
    }
    if ("pattern" in s) {
      // Wrapped, so an alternation that slipped past the lexical anchoring check (`^a|.*$`)
      // still has to match the whole value; and never a dot segment, which a path normalises.
      if (!new RegExp(`^(?:${s.pattern})$`).test(text) || text === "." || text === "..") {
        return { ok: false, error: `settings.${s.key}: not a valid ${s.label}` };
      }
    }
    settings[s.key] = text;
  }
  return { ok: true, settings };
}

/** What a launch needs from an entry and its settings: argv after the entrypoint, and env. */
export function launchOf(
  entry: HostedCatalogueEntry,
  settings: HostSettings,
): { command: string[]; env: Record<string, string> } {
  const command = [...entry.command];
  const env: Record<string, string> = {};
  for (const s of entry.settings) {
    const value = settings[s.key];
    if (s.kind === "toggle") {
      command.push(...(s.args?.[value === true ? "true" : "false"] ?? []));
    } else if (s.env !== undefined && typeof value === "string") {
      env[s.env] = value;
    }
  }
  return { command, env };
}

/**
 * The outbound header map for a catalogue row — setting-derived headers from `settings`, secret
 * headers from `secrets` behind their entry's prefix — plus the trace the API may show (the last four of the first secret).
 * This map is what gets sealed; it is the same `encryptedAuth` a remote row carries.
 */
export function composeHeaders(
  entry: CatalogueEntry,
  settings: HostSettings,
  secrets: Record<string, string>,
): { ok: true; headers: Record<string, string>; trace: string | null } | {
  ok: false;
  error: string;
} {
  const wanted = secretHeadersOf(entry);
  for (const name of Object.keys(secrets)) {
    if (!wanted.some((w) => w.name === name)) {
      return { ok: false, error: `credential.${name}: ${entry.name} reads no such header` };
    }
  }
  const headers: Record<string, string> = {};
  let trace: string | null = null;
  for (const [name, source] of Object.entries(entry.credential.headers)) {
    if (!("secret" in source)) {
      const value = settings[source.from.slice("setting:".length)];
      if (typeof value === "string" && value !== "") headers[name] = value;
      continue;
    }
    const value = secrets[name];
    if (value === undefined || value === "") {
      return { ok: false, error: `credential.${name}: ${source.label} is required` };
    }
    if (!/^[\x21-\x7e]+$/.test(value) || value.length > 4096) {
      return { ok: false, error: `credential.${name}: must be printable ASCII with no spaces` };
    }
    headers[name] = `${source.prefix ?? ""}${value}`;
    trace ??= value.slice(-4);
  }
  // The setting-derived values too: whatever is sealed must be sendable as it stands.
  const problem = credentialHeadersProblem(headers);
  if (problem !== null) return { ok: false, error: `credential: ${problem}` };
  return { ok: true, headers, trace };
}
