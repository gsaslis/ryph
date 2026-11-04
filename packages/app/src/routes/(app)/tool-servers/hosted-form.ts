// The catalogue and hosted halves of the Add dialog and the table, as pure functions: the
// catalogue and custom create bodies from form state, the slug a catalogue server gets by
// default, the one-line summary of a catalogue row's settings, and a hosted row's status chip. The gateway checks all of it again;
// these exist so the operator hears "the image needs a digest" before a round trip, not after.

import type {
  CreateCatalogueServerInput,
  CreateCustomServerInput,
  McpCredentialInput,
} from "$lib/api/mcp-servers";
import type {
  CatalogueEntry,
  CatalogueSetting,
  HostSettings,
  HostStatus,
  McpCatalogue,
  McpServer,
} from "$lib/api/types";

/**
 * A remote preset's row: the vendor's own endpoint, configured from a catalogue entry. It has
 * settings and secrets like a hosted catalogue row, and no container to restart, update or read.
 */
export function isRemotePreset(server: McpServer): boolean {
  return server.kind === "remote" && server.catalogueId !== null;
}

/** Only the settings that changed, so a rename alone never relaunches a container. */
export function changedSettings(
  before: HostSettings | null,
  after: Record<string, string | boolean>,
): HostSettings | undefined {
  const changed: HostSettings = {};
  for (const [key, value] of Object.entries(after)) {
    const next = typeof value === "string" ? value.trim() : value;
    if (next !== (before?.[key] ?? (typeof value === "boolean" ? false : ""))) changed[key] = next;
  }
  return Object.keys(changed).length === 0 ? undefined : changed;
}

/**
 * Whether an edit to a catalogue row must carry its key again, because the gateway binds a key
 * to where it is sent and will not send the old one somewhere new. A remote preset's URL is
 * derived from all of its settings (a choice can move the host, a toggle the path), so any
 * changed setting asks for it. A hosted row's url, text and choice settings can point its
 * container elsewhere; a toggle cannot, so a toggle-only change does not ask.
 */
export function editNeedsKey(
  server: McpServer,
  entry: CatalogueEntry | undefined,
  settings: Record<string, string | boolean>,
): boolean {
  if (server.catalogueId === null || entry === undefined || entry.secrets.length === 0) {
    return false;
  }
  const changed = Object.keys(changedSettings(server.settings, settings) ?? {});
  if (isRemotePreset(server)) return changed.length > 0;
  if (server.kind !== "hosted") return false;
  return changed.some((key) => entry.settings.find((s) => s.key === key)?.kind !== "toggle");
}

/**
 * Whether a plain remote row's edit must carry its credential again: a new URL on a row that
 * has one. The gateway will not send the old credential to the new address. Comparing trimmed
 * text is what decides whether the URL rides in the body at all.
 */
export function urlNeedsCredential(server: McpServer, url: string): boolean {
  return urlChanged(server, url) && server.auth !== "none";
}

/** Whether a plain remote row's URL field differs from the stored one. */
export function urlChanged(server: McpServer, url: string): boolean {
  return server.kind === "remote" && !isRemotePreset(server) && url.trim() !== server.url;
}

/** Why an entry cannot be added here, or null when it can. Remote presets always can. */
export function entryUnavailable(entry: CatalogueEntry, catalogue: McpCatalogue): string | null {
  if (entry.kind === "remote" || catalogue.hostingAvailable) return null;
  return catalogue.reason ?? "This deployment cannot run servers itself.";
}

/** What a catalogue card says about where the server runs: "Runs here", or the vendor's host. */
export function entryWhere(entry: CatalogueEntry): string {
  return entry.kind === "remote" ? entry.host ?? "Remote" : "Runs here";
}

/** Whether a typed value matches the entry's pattern. A pattern the browser cannot compile passes. */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/**
 * What is wrong with one typed setting, in a few words, or null. Empty is not judged here: the
 * form shows required-ness on its own, and submit names a missing one.
 */
export function settingProblem(
  setting: CatalogueSetting,
  value: string | boolean | undefined,
): string | null {
  if (setting.kind === "toggle" || typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (setting.kind === "url" && !/^https?:\/\/[^\s]+$/i.test(text)) {
    return `${setting.label} must be an http(s) URL`;
  }
  if (
    setting.kind === "text" && setting.pattern !== null && !matchesPattern(setting.pattern, text)
  ) {
    // A placeholder always matches its own pattern, so it is the clearest way to say what fits.
    return setting.placeholder
      ? `Should look like ${setting.placeholder}.`
      : `${setting.label} isn't in the expected format.`;
  }
  if (
    setting.kind === "choice" && setting.options !== null &&
    !setting.options.some((o) => o.value === text)
  ) {
    return `Pick a ${setting.label.toLowerCase()}`;
  }
  return null;
}

/** What the catalogue form holds while the operator types. */
export type CatalogueFormState = {
  name: string;
  description: string;
  /** Text and url settings as typed; toggles as booleans. */
  settings: Record<string, string | boolean>;
  /** Secrets by header name. */
  secrets: Record<string, string>;
  /** The slug field under "Advanced", and whether the operator touched it. */
  slug: string;
  slugEdited: boolean;
};

/** The form's starting state for an entry: its name, its toggle defaults, the derived slug. */
export function initialCatalogueForm(
  entry: CatalogueEntry,
  servers: McpServer[],
): CatalogueFormState {
  const settings: Record<string, string | boolean> = {};
  for (const s of entry.settings) {
    settings[s.key] = s.kind === "toggle"
      ? s.default === true
      : typeof s.default === "string"
      ? s.default
      : s.kind === "choice" && !s.optional
      ? s.options?.[0]?.value ?? ""
      : "";
  }
  return {
    name: entry.name,
    description: "",
    settings,
    secrets: Object.fromEntries(entry.secrets.map((s) => [s.header, ""])),
    slug: defaultSlug(entry.id, servers),
    slugEdited: false,
  };
}

/**
 * `grafana`, then `grafana-2`, `grafana-3`… — the first no LIVE server holds. The gateway
 * derives the same when the slug is omitted; this one is shown under "Advanced" so the operator
 * can see what the run will call the server.
 */
export function defaultSlug(base: string, servers: McpServer[]): string {
  const taken = new Set(servers.filter((s) => s.archivedAt === null).map((s) => s.slug));
  for (let n = 1;; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The catalogue create body, or the first thing missing in the operator's words. Text is trimmed,
 * an empty optional setting is left out, toggles go as booleans, and the slug rides only when
 * the operator changed it — otherwise the gateway derives it at the moment of creation, which
 * is the one that cannot race another tab.
 */
export function composeCatalogueBody(
  entry: CatalogueEntry,
  form: CatalogueFormState,
): { ok: true; body: CreateCatalogueServerInput } | { ok: false; error: string } {
  const name = form.name.trim();
  if (name === "") return { ok: false, error: "Give the server a name" };
  const settings: HostSettings = {};
  for (const s of entry.settings) {
    const value = form.settings[s.key];
    if (s.kind === "toggle") {
      settings[s.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      if (s.optional) continue;
      return { ok: false, error: `${s.label} is required` };
    }
    const problem = settingProblem(s, text);
    if (problem !== null) return { ok: false, error: problem };
    settings[s.key] = text;
  }
  const credential = composeSecrets(entry, form.secrets);
  if (!credential.ok) return credential;
  const description = form.description.trim();
  const slug = form.slug.trim();
  return {
    ok: true,
    body: {
      kind: entry.kind,
      catalogueId: entry.id,
      ...(form.slugEdited && slug !== "" ? { slug } : {}),
      name,
      ...(description === "" ? {} : { description }),
      settings,
      credential: credential.credential,
    },
  };
}

/**
 * An entry's secrets by header, trimmed, or the first one missing. A value pasted with the
 * entry's prefix on it (`Bearer …`) has it taken off, since the gateway adds it again.
 */
export function composeSecrets(
  entry: CatalogueEntry,
  values: Record<string, string>,
): { ok: true; credential: Record<string, string> } | { ok: false; error: string } {
  const credential: Record<string, string> = {};
  for (const secret of entry.secrets) {
    let value = (values[secret.header] ?? "").trim();
    const prefix = secret.prefix ?? "";
    // Padded so a bare "Bearer" counts as the prefix and nothing after it.
    if (prefix.trim() !== "" && `${value} `.toLowerCase().startsWith(prefix.toLowerCase())) {
      value = value.slice(prefix.length).trim();
    }
    if (value === "") return { ok: false, error: `Paste the ${secret.label.toLowerCase()}` };
    credential[secret.header] = value;
  }
  return { ok: true, credential };
}

/** `repo[:tag]@sha256:<64 hex>` — the gateway's PINNED_IMAGE, duplicated for the same reason. */
export const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

/** The obvious spellings of "this server speaks stdio" — refused with the reason. */
const STDIO_ARG = /^(?:-{0,2}(?:t|transport)[= ])?stdio$/i;

export const STDIO_REFUSAL =
  "stdio servers are not hosted yet — only images that speak streamable HTTP";

/** The custom container form, as typed. */
export type CustomFormState = {
  name: string;
  slug: string;
  description: string;
  image: string;
  /** Whitespace-separated argv after the image's entrypoint. */
  command: string;
  port: string;
  path: string;
  /** The env var the image reads its caller token from. Required — see the gateway's schema. */
  callerAuthEnv: string;
};

/** The gateway's env-var shape, duplicated here so the refusal is typed rather than a 400. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The custom create body, or the reason it is not one yet. The command line is split on
 * whitespace into argv — there is no shell, so no quoting either — and a stdio command is
 * refused here with the pointer the gateway would give.
 */
export function composeCustomBody(
  form: CustomFormState,
  credential: McpCredentialInput,
): { ok: true; body: CreateCustomServerInput } | { ok: false; error: string } {
  const name = form.name.trim();
  const slug = form.slug.trim();
  const image = form.image.trim();
  if (name === "") return { ok: false, error: "Give the server a name" };
  if (slug === "") return { ok: false, error: "Give the server a slug" };
  if (!PINNED_IMAGE.test(image)) {
    return { ok: false, error: "The image must be pinned by digest: repo[:tag]@sha256:<64 hex>" };
  }
  const command = form.command.trim() === "" ? [] : form.command.trim().split(/\s+/);
  if (
    command.some((a) => STDIO_ARG.test(a)) ||
    /(?:^|\s)-{1,2}(?:t|transport)\s+stdio\b/i.test(command.join(" "))
  ) {
    return { ok: false, error: STDIO_REFUSAL };
  }
  const port = Number(form.port.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "The port must be a number between 1 and 65535" };
  }
  const path = form.path.trim() === "" ? "/mcp" : form.path.trim();
  if (!path.startsWith("/")) return { ok: false, error: "The path must start with /" };
  const callerAuthEnv = form.callerAuthEnv.trim();
  if (!ENV_NAME.test(callerAuthEnv)) {
    return {
      ok: false,
      error: "Name the env var the image reads its caller token from — UPPER_SNAKE_CASE",
    };
  }
  const description = form.description.trim();
  return {
    ok: true,
    body: {
      kind: "hosted",
      slug,
      name,
      ...(description === "" ? {} : { description }),
      custom: { image, command, port, path, callerAuth: { env: callerAuthEnv } },
      ...credential,
    },
  };
}

/**
 * A catalogue row's settings in one line — `grafana.example.com · read-only`: url settings as
 * their host, text settings as typed, choices by their option's label, toggles by their label
 * when on. Labels come from the entry when
 * the catalogue still has it, the raw keys otherwise.
 */
export function settingsSummary(
  settings: HostSettings | null,
  entry: CatalogueEntry | undefined,
): string {
  if (settings === null) return "";
  const parts: string[] = [];
  const known = entry?.settings ?? [];
  const keys = known.length > 0 ? known.map((s) => s.key) : Object.keys(settings);
  for (const key of keys) {
    const value = settings[key];
    const setting = known.find((s) => s.key === key);
    if (typeof value === "boolean") {
      if (value) parts.push((setting?.label ?? key).toLowerCase());
    } else if (typeof value === "string" && value !== "") {
      if (setting?.kind === "choice") {
        parts.push(setting.options?.find((o) => o.value === value)?.label ?? value);
      } else {
        parts.push(setting?.kind === "url" || /^https?:\/\//.test(value) ? hostOf(value) : value);
      }
    }
  }
  return parts.join(" · ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A hosted row's status chip: what it says, and how loud. */
export const HOST_STATUS_CHIP: Record<
  HostStatus,
  { label: string; variant: "secondary" | "outline" | "destructive" | "default" }
> = {
  starting: { label: "Starting", variant: "outline" },
  healthy: { label: "Healthy", variant: "secondary" },
  unreachable: { label: "Unreachable", variant: "destructive" },
  stopped: { label: "Stopped", variant: "outline" },
  "update-available": { label: "Update available", variant: "default" },
};
