// The management surface, as a mountable route list — the same trick as @ryph/model-proxy:
// the Route shape is @ryph/shared's, so the default deployment spreads these into the host's
// route table.
//
// Invariants:
// - WRITE-ONLY on credentials: a secret arrives in a create or update body and never comes back.
//   Every response passes through `toPublicMcpServer`; there is no GET that could leak one. The
//   probe unseals a credential to USE it and returns only what upstream said.
// - rotation replaces the credential UNDER THE SAME ID: agents reference the id, so a rotated
//   server needs no re-assignment anywhere, and in-flight runs pick the new credential up on
//   their next call — which is what rotation is for. For a hosted server too: its container
//   never held the credential, so rotating one touches no container.
// - servers are archived, never deleted: historical runs keep resolving which server they
//   called, and archiving is the immediate kill-switch for every run scoped to it. A hosted
//   server's container is stopped and removed as well; the row stays. Archiving is NOT on this
//   surface: the control plane fronts it (it alone knows which agents still name a server) and
//   reaches `archiveMcpServer` below over the internal surface, or in-process.
// - a credential is sealed for WHERE IT GOES (core/sealing.ts): a remote row's url, a hosted
//   row's container and settings. Changing that takes the credential again in the same request
//   (CREDENTIAL_REQUIRED); the server never re-seals an old secret for a new destination
// - a URL is checked against the upstream guard before it is stored, so "you registered the
//   control plane's address" is a 400 the operator sees, not a 502 the run sees. A hosted row's
//   URL is never typed at all: the gateway mints it, and a PATCH naming one is refused. Nor is a
//   remote preset's: its catalogue entry writes it from the settings, and the result meets the
//   same guard as a typed one, at create and on every settings edit
// - MANAGING a server is ADMIN-ONLY: registering (remote, catalogue or custom), repointing,
//   rotating, re-settling, archiving, probing with the real credential, reading a container's
//   logs, and reading a run's tool-call trail each either hold a credential or aim one
//   somewhere. LISTING is not — the agent form every user fills in needs the names
// - the paths are mounted in every deployment: without a master key they carry the disabled
//   stand-ins, so "tools are off" is always an answer and never a 404. Likewise a gateway that
//   cannot host answers `hosting_unavailable`, with the reason, on the hosting-only paths.

import {
  describeIssues,
  json,
  MAX_JSON_BODY_BYTES,
  parseBody,
  readCapped,
  type Route,
  route,
} from "@ryph/shared/http";
import {
  type CatalogueEntry,
  type CatalogueSetting,
  composeHeaders,
  type RemoteCatalogueEntry,
  remoteUrlOf,
  resolveSettings,
  secretHeadersOf,
  secretsFromHeaders,
  type SettingUrlCheck,
} from "../core/catalogue.ts";
import { hostedMarkerUrl, type HostingService } from "../core/hosting.ts";
import { credentialBindingDigest, mcpCredentialBinding } from "../core/sealing.ts";
import type { SealBinding } from "@ryph/sealed";
import { isPlatformServer } from "../core/platform.ts";
import {
  type HostSettings,
  type McpAuthKind,
  type McpServer,
  needsSecret,
  type PublicMcpServer,
  SECRET_REQUIRED,
  toPublicMcpServer,
} from "../core/types.ts";
import type { UpstreamTarget, UpstreamVerdict } from "../core/upstream_guard.ts";
import type { Catalogue } from "../ports/catalogue.ts";
import { type GatewayStore, type McpServerEdit, usageCursor } from "../ports/gateway_store.ts";
import { mintId } from "@ryph/sealed";
import {
  CreateCatalogueServerSchema,
  CreateCustomServerSchema,
  CreateMcpServerSchema,
  CreateRemotePresetSchema,
  type CredentialInput,
  credentialOfUpdate,
  RestartMcpServerSchema,
  UpdateMcpServerSchema,
} from "../schema.ts";
import type { ProbeResult } from "./probe.ts";

/** The management surface's paths, shared by the live routes and their disabled stand-ins. */
const PATHS = {
  catalogue: "/v1/mcp-catalogue",
  collection: "/v1/mcp-servers",
  item: "/v1/mcp-servers/:id",
  probe: "/v1/mcp-servers/:id/probe",
  restart: "/v1/mcp-servers/:id/restart",
  logs: "/v1/mcp-servers/:id/logs",
  usage: "/v1/mcp-usage/:runId",
} as const;

/**
 * The machine-readable marker on a "tools are off" refusal. The VALUE is the contract, not this
 * name: @ryph/app does not import this package and will carry its own copy, so changing
 * the string here means changing it there too — the MODEL_ACCESS_DISABLED precedent.
 */
export const MCP_DISABLED = "mcp_disabled";

/**
 * The marker on "move the URL, move the credential": repointing a server that carries a sealed
 * credential without re-supplying it would send the old secret to a host the caller chose, which
 * is a credential-exfiltration primitive wearing an edit's clothes. Same contract note as above.
 */
export const CREDENTIAL_REQUIRED = "credential_required";

/**
 * The marker on "the server moved while its credential was being saved": the credential was
 * sealed for where the row pointed when the edit read it, and another edit has since pointed it
 * elsewhere. Nothing was written; the caller sends it again against the row as it now stands.
 */
export const SERVER_CHANGED = "server_changed";

/** The marker on "this server is archived": the row resolves, but nothing may use it again. */
export const SERVER_ARCHIVED = "server_archived";

/**
 * The marker on "this server is the platform's": it is never edited, archived, probed or
 * restarted through the API — it exists because the deployment configured the service behind
 * it, and goes away the same way. The app carries its own copy, as with MCP_DISABLED.
 */
export const PLATFORM_MANAGED = "platform_managed";

/**
 * The marker on "this gateway cannot run hosted servers" — tool access is on, remote servers
 * work, but there is no container backend to launch into (a manual provisioner, or the
 * standalone gateway). The app carries its own copy, as with MCP_DISABLED.
 */
export const HOSTING_UNAVAILABLE = "hosting_unavailable";

/** What archiving one server came to. `server` is the row as the API shows it. */
export type ArchiveOutcome =
  | { kind: "archived"; server: PublicMcpServer }
  | { kind: "missing" }
  | { kind: "platform" };

/**
 * Archives one server: the kill switch. No gate and no "is it still used" check — both are the
 * caller's, the control plane's, which alone knows the agents that name a server.
 *
 * Idempotent: an archived server answers as it stands, with its first archive time. The row
 * first: archiving must bite on the next call even if stopping the container takes a while or
 * fails — a container still up is stopped on a repeat archive.
 */
export function archiveMcpServer(
  deps: Pick<McpServerRoutesDeps, "store" | "hosting" | "now">,
): (id: string) => Promise<ArchiveOutcome> {
  const { store, hosting } = deps;
  return async (id) => {
    // A platform row is unarchivable: it is in every run's scope by default, and the only way it
    // goes away is the deployment no longer configuring the service behind it.
    const target = await store.getServer(id);
    if (target !== null && isPlatformServer(target)) return { kind: "platform" };
    let archived = await store.archiveServer(id, deps.now().toISOString());
    if (!archived) return { kind: "missing" };
    if (archived.kind === "hosted" && archived.host?.status !== "stopped") {
      // Whatever hosting thinks of itself. Availability is about launching — it is false while
      // boot is still pulling the guard image, and false for good on a backend whose network
      // would not come up — and in every one of those windows a container from a previous
      // process can still be running. Nothing enumerates an archived row afterwards (boot and the
      // supervisor walk LIVE rows), so this is the last moment its container is named at all; a
      // stop that fails or refuses leaves the row archived, which is what the caller asked for.
      //
      // The catch costs nothing: a hosting service that HAS a backend records a failed stop on
      // the row itself (`host.lastError`) and resolves, so the only rejection here comes from a
      // deployment that runs no containers at all — where there is none to stop.
      const row = archived;
      archived = await hosting.stop(row).catch(() => row);
    }
    return {
      kind: "archived",
      server: toPublicMcpServer(archived, await hosting.latestDigest(archived)),
    };
  };
}

/** The logs route's default and ceiling, in lines. */
export const LOGS_DEFAULT_TAIL = 200;
export const LOGS_MAX_TAIL = 1000;

export interface McpServerRoutesDeps {
  store: GatewayStore;
  /** Seals a credential for the row, bound to it (`mcpCredentialBinding`) — built by the
   * composition root from the master key. */
  encrypt(plaintext: string, binding: SealBinding): Promise<string>;
  /**
   * Unseals one — for the two places the control side must: re-deriving a hosted row's header map
   * when a toggle it carries changes, and redacting its values out of a container's logs.
   */
  decrypt(sealed: string, binding: SealBinding): Promise<string>;
  /** The host's user-surface gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  /**
   * The same gate, narrowed to `tools:manage`: everything that manages a server (and so its
   * credential) —
   * catalogue and custom containers included — plus container logs and the usage trail.
   * Break-glass passes, as it does everywhere.
   */
  authenticateManage(req: Request): Promise<Response | null>;
  /** The gate on one run's tool-call trail: its grant from the control plane, or `tools:manage`. */
  authenticateRunRead(req: Request, runId: string): Promise<Response | null>;
  /** The upstream guard, with the platform's resolver behind it. */
  checkUpstream(target: UpstreamTarget): Promise<UpstreamVerdict>;
  /** Connects to a server with its real credential and reports what it found. */
  probe(server: McpServer): Promise<ProbeResult>;
  catalogue: Catalogue;
  /** Launches and supervises hosted servers — or says why this gateway cannot. */
  hosting: HostingService;
  now(): Date;
}

/** The credential columns of a row, from the create-shaped input. Sealed exactly once, here. */
async function sealCredential(
  input: CredentialInput,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<Pick<McpServer, "auth" | "encryptedAuth" | "authLast4">> {
  let headers: Record<string, string>;
  let trace: string;
  switch (input.auth) {
    case "none":
      return { auth: "none", encryptedAuth: null, authLast4: null };
    case "bearer":
      headers = { Authorization: `Bearer ${input.secret}` };
      trace = input.secret;
      break;
    case "headers": {
      headers = input.headers;
      // The trace is the first header's value: enough to tell two rotations apart.
      trace = Object.values(input.headers)[0];
      break;
    }
  }
  const auth: McpAuthKind = input.auth;
  return {
    auth,
    encryptedAuth: await encrypt(JSON.stringify(headers)),
    authLast4: trace.slice(-4),
  };
}

/** A hosted catalogue row's credential columns: the entry's header map, sealed. */
async function sealHeaders(
  headers: Record<string, string>,
  trace: string | null,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<Pick<McpServer, "auth" | "encryptedAuth" | "authLast4">> {
  if (Object.keys(headers).length === 0) {
    return { auth: "none", encryptedAuth: null, authLast4: null };
  }
  return {
    auth: "headers",
    encryptedAuth: await encrypt(JSON.stringify(headers)),
    authLast4: trace,
  };
}

/**
 * The host a remote preset dials with its defaults — for the card, so an operator sees whose
 * endpoint it is before pasting a key. Only a choice may vary the host, and every choice has a
 * default, so this is the host the form starts on; a typed value never reaches it.
 */
function defaultHostOf(entry: RemoteCatalogueEntry): string | null {
  const defaults: HostSettings = {};
  for (const s of entry.settings) if (s.kind !== "text") defaults[s.key] = s.default;
  try {
    return new URL(remoteUrlOf(entry, defaults)).hostname;
  } catch {
    return null;
  }
}

/**
 * What the catalogue route shows of an entry: what the Add form needs, the image a hosted one
 * runs, and the host a remote one dials. Not the launch internals, and not a remote entry's URL
 * template — the row's URL, once created, is what an operator reads.
 */
function publicEntry(entry: CatalogueEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    docs: entry.docs,
    brand: entry.brand ?? null,
    image: entry.kind === "hosted" ? entry.image : null,
    host: entry.kind === "remote" ? defaultHostOf(entry) : null,
    settings: (entry.settings as CatalogueSetting[]).map((s) => ({
      key: s.key,
      label: s.label,
      kind: s.kind,
      placeholder: "placeholder" in s ? s.placeholder ?? null : null,
      description: s.description ?? null,
      optional: "optional" in s ? s.optional ?? false : false,
      default: "default" in s ? s.default : null,
      options: s.kind === "choice" ? s.options.map(({ value, label }) => ({ value, label })) : null,
      pattern: "pattern" in s ? s.pattern : null,
    })),
    secrets: secretHeadersOf(entry).map((s) => ({
      header: s.name,
      label: s.label,
      placeholder: s.placeholder ?? null,
      description: s.description ?? null,
      prefix: s.prefix ?? null,
    })),
    defaultOff: entry.defaultOff ?? [],
  };
}

/** Replaces every occurrence of a secret value — a backstop, for an image that logs headers. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(`····${secret.slice(-4)}`);
  }
  return out;
}

/** The answer when the stored credential has to be opened and cannot be: enter it again. */
const secretRequired = (doing: string): Response =>
  json(409, {
    error: `this server's stored credential cannot be used, so ${doing} — send \`credential\` ` +
      "to enter it again",
    code: SECRET_REQUIRED,
  });

const sameSettings = (a: HostSettings | null, b: HostSettings | null) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

export function mcpServerRoutes(deps: McpServerRoutesDeps): Route[] {
  const { store, hosting } = deps;
  const nowIso = () => deps.now().toISOString();

  /**
   * Writes an edit of `server` (the row as this request read it). An edit of anything a credential
   * is bound to — the credential itself, the url, the settings — lands only while the row still
   * has both the binding AND the credential it was read with: a credential sealed for the binding
   * as read, or a move judged against the credential as read (none, so no credential needed
   * again), would otherwise be paired with a concurrent PATCH's other half — a row at a new url
   * with a credential sealed for the old one. The comparison is the whole binding, so it is a
   * compare-and-set on `url`, settings, slug and container at once, and on `encryptedAuth`.
   * A rename or a description touches neither, and is written as it comes.
   */
  const storeEdit = async (
    server: McpServer,
    edit: McpServerEdit,
  ): Promise<{ ok: true; server: McpServer } | { ok: false; res: Response }> => {
    let updated: McpServer | null | "changed";
    const bound = edit.encryptedAuth !== undefined || edit.auth !== undefined ||
      edit.url !== undefined || edit.settings !== undefined;
    if (!bound) {
      updated = await store.updateServer(server.id, edit);
    } else {
      const readAs = await credentialBindingDigest(server);
      updated = await store.updateServerIf(
        server.id,
        edit,
        async (current) =>
          current.encryptedAuth === server.encryptedAuth &&
          await credentialBindingDigest(current) === readAs,
      );
    }
    if (updated === null) return { ok: false, res: json(404, { error: "no such server" }) };
    if (updated === "changed") {
      return {
        ok: false,
        res: json(409, {
          error: "this server's credential or destination changed while this edit was being " +
            "saved — nothing was written; send it again",
          code: SERVER_CHANGED,
        }),
      };
    }
    return { ok: true, server: updated };
  };

  /** `storeEdit`, answered as the PATCH's response. */
  const writeEdit = async (server: McpServer, edit: McpServerEdit): Promise<Response> => {
    const written = await storeEdit(server, edit);
    return written.ok ? json(200, await present(written.server)) : written.res;
  };

  /**
   * The row's sealed header map, opened for the control side's two needs (a relaunch re-deriving
   * it, logs redacted with it); `{}` for a row that takes none. Null when it takes one and it is
   * missing or does not open: the caller answers `secretRequired`, never a 500.
   */
  const openHeaders = async (server: McpServer): Promise<Record<string, string> | null> => {
    if (needsSecret(server)) return null;
    if (server.encryptedAuth === null) return {};
    try {
      return JSON.parse(
        await deps.decrypt(server.encryptedAuth, mcpCredentialBinding(server)),
      ) as Record<string, string>;
    } catch {
      return null;
    }
  };

  const refusedUrl = (verdict: UpstreamVerdict): Response | null =>
    verdict.ok ? null : json(400, { error: `url: ${verdict.detail}` });

  /**
   * A `url`-typed setting meets the same rule a remote upstream's URL does — it is the one
   * operator-typed URL that would otherwise never meet it, and it ends up as the container's env
   * AND a sealed header riding every call. `kind: "remote"` deliberately: the hosted exemption
   * covers the guard route the gateway mints and nothing anybody types.
   */
  const checkSettingUrl = (slug: string): SettingUrlCheck => (url) =>
    deps.checkUpstream({ kind: "remote", slug, url });

  /**
   * The refusal when this deployment already hosts as many servers as it allows, or null. Each
   * hosted row is a memory-capped container on the machine the control plane runs on, so an
   * unbounded create loop is an outage of everything else here, not just of tool access.
   */
  const capacityRefusal = async (): Promise<Response | null> => {
    const { live, max } = await hosting.capacity();
    return live < max ? null : json(409, {
      error: `this deployment hosts at most ${max} MCP servers at once, and has ${live} — ` +
        "archive one, or raise RYPH_TOOL_MAX_SERVERS",
    });
  };

  const hostingRefusal = (): Response | null => {
    const availability = hosting.availability();
    return availability.available
      ? null
      : json(503, { error: availability.reason, code: HOSTING_UNAVAILABLE });
  };

  /** The public shape, with "update available" worked out against today's catalogue. */
  const present = async (server: McpServer): Promise<PublicMcpServer> =>
    toPublicMcpServer(server, await hosting.latestDigest(server));

  /**
   * `grafana`, then `grafana-2`, `grafana-3`… — the first one no live server holds. A suggestion
   * only: the insert is still what decides, so a create racing this one answers 409, not a 500.
   */
  const freeSlug = async (base: string): Promise<string> => {
    for (let n = 1;; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if ((await store.getLiveServerBySlug(candidate)) === null) return candidate;
    }
  };

  const slugTaken = (slug: string) => json(409, { error: `slug "${slug}" is already taken` });

  /** The refusal every management action answers for a platform row. */
  const platformManaged = () =>
    json(409, {
      error: "this server is provided by the platform and is not managed here",
      code: PLATFORM_MANAGED,
    });

  /** Seals for this row as it will stand: bound to its id and where its credential goes. */
  const sealFor = (row: Parameters<typeof mcpCredentialBinding>[0]) => (plaintext: string) =>
    deps.encrypt(plaintext, mcpCredentialBinding(row));

  const hostedRow = (
    id: string,
    fields: Pick<McpServer, "slug" | "name" | "catalogueId" | "custom" | "settings"> & {
      description: string | null;
    },
    credential: Pick<McpServer, "auth" | "encryptedAuth" | "authLast4">,
  ): McpServer => {
    const at = nowIso();
    return {
      id,
      transport: "http",
      kind: "hosted",
      ...fields,
      url: hostedMarkerUrl(fields.slug),
      ...credential,
      host: {
        handle: null,
        status: "starting",
        imageDigest: null,
        startedAt: null,
        lastError: null,
      },
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
  };

  const createRemote = async (raw: unknown): Promise<Response> => {
    const parsed = CreateMcpServerSchema.safeParse(raw);
    if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
    const body = parsed.data;
    const refused = refusedUrl(
      await deps.checkUpstream({ kind: "remote", slug: body.slug, url: body.url }),
    );
    if (refused) return refused;
    const at = nowIso();
    const row: Omit<McpServer, "auth" | "encryptedAuth" | "authLast4"> = {
      id: mintId("ms"),
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      transport: "http",
      kind: "remote",
      url: body.url,
      catalogueId: null,
      custom: null,
      settings: null,
      host: null,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const server: McpServer = { ...row, ...(await sealCredential(body, sealFor(row))) };
    // The store's answer IS the uniqueness check — a read first would let two racing creates both
    // pass it, and the loser would surface as a 500.
    if ((await store.createServer(server)) === "slug_taken") return slugTaken(body.slug);
    return json(201, await present(server));
  };

  const createFromCatalogue = async (raw: unknown): Promise<Response> => {
    const parsed = CreateCatalogueServerSchema.safeParse(raw);
    if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
    const body = parsed.data;
    const entry = await deps.catalogue.get(body.catalogueId);
    if (entry === null) return json(400, { error: `catalogueId: no entry "${body.catalogueId}"` });
    if (entry.kind !== "hosted") {
      return json(400, {
        error: `catalogueId: ${entry.name} is the vendor's own endpoint, not a server this ` +
          'deployment runs — create it with kind "remote"',
      });
    }
    if (!entry.shared) {
      return json(400, {
        error: `${entry.name} keeps per-run state and needs per-run instances, which are not ` +
          "available yet",
      });
    }
    const off = hostingRefusal();
    if (off) return off;
    const full = await capacityRefusal();
    if (full) return full;
    const settings = await resolveSettings(entry, body.settings, {
      checkUrl: checkSettingUrl(body.slug ?? entry.id),
    });
    if (!settings.ok) return json(400, { error: settings.error });
    const headers = composeHeaders(entry, settings.settings, body.credential);
    if (!headers.ok) return json(400, { error: headers.error });
    const slug = body.slug ?? await freeSlug(entry.id);
    const id = mintId("ms");
    const fields = {
      slug,
      name: body.name,
      description: body.description ?? null,
      catalogueId: entry.id,
      custom: null,
      settings: settings.settings,
    };
    const server = hostedRow(
      id,
      fields,
      await sealHeaders(
        headers.headers,
        headers.trace,
        sealFor({ ...fields, id, kind: "hosted", url: "" }),
      ),
    );
    if ((await store.createServer(server)) === "slug_taken") return slugTaken(slug);
    // Answers now, `starting`: the launch — an image pull, possibly — and the wait for the first
    // answer happen in the background, and the row turns `healthy` when the server answers.
    return json(201, await present(await hosting.launch(server)));
  };

  /**
   * A remote preset's URL for these settings, held to what a typed URL is held to: it parses, it
   * is https, and it passes the upstream guard. The entry was reviewed and its schema keeps typed
   * text out of the host — this is the check that does not take either on trust, because the
   * sealed credential rides every call to whatever this returns.
   */
  const presetUrl = async (
    entry: RemoteCatalogueEntry,
    settings: HostSettings,
    slug: string,
  ): Promise<{ ok: true; url: string } | { ok: false; res: Response }> => {
    const url = remoteUrlOf(entry, settings);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, res: json(400, { error: `url: these settings make "${url}"` }) };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, res: json(400, { error: `url: these settings make "${url}"` }) };
    }
    const refused = refusedUrl(await deps.checkUpstream({ kind: "remote", slug, url }));
    return refused ? { ok: false, res: refused } : { ok: true, url };
  };

  // A remote row whose URL and header map its catalogue entry wrote. No container and no hosting
  // dependency: it works on a gateway that cannot host, and never counts toward that capacity.
  const createPreset = async (raw: unknown): Promise<Response> => {
    const parsed = CreateRemotePresetSchema.safeParse(raw);
    if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
    const body = parsed.data;
    const entry = await deps.catalogue.get(body.catalogueId);
    if (entry === null) return json(400, { error: `catalogueId: no entry "${body.catalogueId}"` });
    if (entry.kind !== "remote") {
      return json(400, {
        error: `catalogueId: ${entry.name} is a server this deployment runs, not a remote ` +
          'endpoint — create it with kind "hosted"',
      });
    }
    const slug = body.slug ?? await freeSlug(entry.id);
    const settings = await resolveSettings(entry, body.settings, {
      checkUrl: checkSettingUrl(slug),
    });
    if (!settings.ok) return json(400, { error: settings.error });
    const headers = composeHeaders(entry, settings.settings, body.credential);
    if (!headers.ok) return json(400, { error: headers.error });
    const url = await presetUrl(entry, settings.settings, slug);
    if (!url.ok) return url.res;
    const at = nowIso();
    const row: Omit<McpServer, "auth" | "encryptedAuth" | "authLast4"> = {
      id: mintId("ms"),
      slug,
      name: body.name,
      description: body.description ?? null,
      transport: "http",
      kind: "remote",
      url: url.url,
      catalogueId: entry.id,
      custom: null,
      settings: settings.settings,
      host: null,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const server: McpServer = {
      ...row,
      ...(await sealHeaders(headers.headers, headers.trace, sealFor(row))),
    };
    if ((await store.createServer(server)) === "slug_taken") return slugTaken(slug);
    return json(201, await present(server));
  };

  const createCustom = async (raw: unknown): Promise<Response> => {
    const parsed = CreateCustomServerSchema.safeParse(raw);
    if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
    const body = parsed.data;
    const off = hostingRefusal();
    if (off) return off;
    const full = await capacityRefusal();
    if (full) return full;
    const id = mintId("ms");
    const fields = {
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      catalogueId: null,
      custom: body.custom,
      settings: null,
    };
    const server = hostedRow(
      id,
      fields,
      await sealCredential(body, sealFor({ ...fields, id, kind: "hosted", url: "" })),
    );
    if ((await store.createServer(server)) === "slug_taken") return slugTaken(body.slug);
    return json(201, await present(await hosting.launch(server)));
  };

  // Registering a server takes `tools:manage`, whichever kind: each of the four either carries a
  // credential or decides which image the deployment is trusting with one.
  const create = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    let raw: unknown;
    try {
      const text = await readCapped(req, MAX_JSON_BODY_BYTES);
      if (text === null) {
        return json(413, { error: `body exceeds ${MAX_JSON_BODY_BYTES} bytes` });
      }
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }
    const kind = raw !== null && typeof raw === "object" ? (raw as { kind?: unknown }).kind : null;
    if (kind === undefined && "catalogueId" in (raw as object)) {
      return json(400, { error: 'kind: a catalogue server names its kind, "remote" or "hosted"' });
    }
    if (kind === undefined || kind === "remote") {
      // Naming a catalogue entry is what makes it a preset. Without one it is the plain remote
      // body, whose URL the operator types.
      return "catalogueId" in (raw as object) ? await createPreset(raw) : await createRemote(raw);
    }
    if (kind !== "hosted") return json(400, { error: 'kind: must be "remote" or "hosted"' });
    return "custom" in (raw as object) ? await createCustom(raw) : await createFromCatalogue(raw);
  };

  const catalogueList = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const availability = hosting.availability();
    // Entries nobody can act on are left out: a `shared: false` server needs per-run instances.
    // A remote preset is always listed — it needs no container, so hosting being off is no
    // reason to hide it; `hostingAvailable` is for the hosted cards alone.
    const entries = (await deps.catalogue.list())
      .filter((e) => e.kind === "remote" || e.shared)
      .map(publicEntry);
    return json(200, {
      hostingAvailable: availability.available,
      ...(availability.available ? {} : { reason: availability.reason }),
      entries,
    });
  };

  const list = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const servers = await store.listServers();
    return json(200, { mcpServers: await Promise.all(servers.map(present)) });
  };

  const get = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const server = await store.getServer(params.id);
    if (!server) return json(404, { error: "no such server" });
    return json(200, await present(server));
  };

  const update = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    // Read for what the PATCH may do — the row's kind, its catalogue entry — but written back as an
    // edit of only the fields it names, never this whole row: a concurrent archive, rotation, or
    // host status flip is not undone by an edit that raced it.
    const server = await store.getServer(params.id);
    if (!server) return json(404, { error: "no such server" });
    if (isPlatformServer(server)) return platformManaged();
    const body = await parseBody(req, UpdateMcpServerSchema);
    if (!body.ok) return body.res;
    const patch = body.data;
    // An archived row's credential was wiped with the archive and is never sealed again; the store
    // drops one that races in, and this says so to a caller who sends one.
    if (
      server.archivedAt !== null && (patch.credential !== undefined || patch.auth !== undefined)
    ) {
      return json(409, { error: "this server is archived", code: SERVER_ARCHIVED });
    }
    const edit: McpServerEdit = { updatedAt: nowIso() };
    if (patch.name !== undefined) edit.name = patch.name;
    if (patch.description !== undefined) edit.description = patch.description;

    if (server.kind === "remote" && server.catalogueId !== null) {
      // ── Remote, from a catalogue preset ───────────────────────────────────────────────────
      if (patch.url !== undefined) {
        return json(400, {
          error: "url: a catalogue server's URL comes from its entry — change its settings",
        });
      }
      if (patch.auth !== undefined) {
        return json(400, { error: "rotate a catalogue server's secret with `credential`" });
      }
      // The entry only for what it shapes: a row whose entry has left the catalogue still works
      // (the data plane reads its URL and sealed headers, not the entry), so it can still be
      // renamed — just not re-settled or rotated against an entry nobody can read any more.
      if (patch.settings !== undefined || patch.credential !== undefined) {
        const entry = await deps.catalogue.get(server.catalogueId);
        if (entry === null || entry.kind !== "remote") {
          return json(409, { error: `the catalogue no longer has "${server.catalogueId}"` });
        }
        if (patch.settings !== undefined) {
          const resolved = await resolveSettings(entry, patch.settings, {
            base: server.settings ?? {},
            checkUrl: checkSettingUrl(server.slug),
          });
          if (!resolved.ok) return json(400, { error: resolved.error });
          const url = await presetUrl(entry, resolved.settings, server.slug);
          if (!url.ok) return url.res;
          // Any move of the URL — a region choice, or an entry whose URL changed between
          // releases — takes the credential again, as CREDENTIAL_REQUIRED does for a plain remote
          // row: the sealed key is bound to the URL it was given for, and the server never seals
          // the old one for a new URL on its own say-so.
          if (
            url.url !== server.url && server.encryptedAuth !== null &&
            patch.credential === undefined
          ) {
            return json(400, {
              error: "moving this server to another URL needs its credential again: send " +
                "`credential` with the new settings",
              code: CREDENTIAL_REQUIRED,
            });
          }
          edit.settings = resolved.settings;
          edit.url = url.url;
        }
        if (patch.credential !== undefined) {
          // A remote entry's headers are all secrets, so nothing in them follows the settings:
          // only a rotation reseals.
          const headers = composeHeaders(entry, {}, patch.credential);
          if (!headers.ok) return json(400, { error: headers.error });
          Object.assign(
            edit,
            await sealHeaders(
              headers.headers,
              headers.trace,
              sealFor({ ...server, url: edit.url ?? server.url }),
            ),
          );
        }
      }
      return await writeEdit(server, edit);
    }

    if (server.kind === "remote") {
      if (patch.settings !== undefined || patch.credential !== undefined) {
        return json(400, { error: "settings and credential are for catalogue servers" });
      }
      const credential = credentialOfUpdate(patch);
      if (patch.url !== undefined) {
        const refused = refusedUrl(
          await deps.checkUpstream({ kind: "remote", slug: server.slug, url: patch.url }),
        );
        if (refused) return refused;
        // Moving a credentialed server's URL REQUIRES the credential again in the same request.
        // Otherwise "repoint, then probe" reads the stored secret out to a host of the caller's
        // choosing — the guard passes, it is a public https endpoint — and the row never changed
        // hands. Re-supplying it makes the move an explicit act on the secret itself.
        if (server.encryptedAuth !== null && credential === undefined) {
          return json(400, {
            error:
              "a server carrying a credential cannot be repointed without supplying it again: " +
              "send the credential (auth + secret/headers) with the new url",
            code: CREDENTIAL_REQUIRED,
          });
        }
        edit.url = patch.url;
      }
      if (credential !== undefined) {
        // Rotation in place: same id, new credential — nothing referencing the server moves.
        // Sealed for the url it goes to: the new one when this PATCH moves it.
        Object.assign(
          edit,
          await sealCredential(credential, sealFor({ ...server, url: edit.url ?? server.url })),
        );
      }
      return await writeEdit(server, edit);
    }

    // ── Hosted ────────────────────────────────────────────────────────────────────────────
    if (patch.url !== undefined) {
      return json(400, { error: "url: a hosted server's URL is minted by the gateway" });
    }
    if (server.custom !== null) {
      if (patch.settings !== undefined || patch.credential !== undefined) {
        return json(400, {
          error: "a custom container has no settings; rotate it with auth and secret/headers",
        });
      }
      const credential = credentialOfUpdate(patch);
      if (credential !== undefined) {
        Object.assign(edit, await sealCredential(credential, sealFor(server)));
      }
      return await writeEdit(server, edit);
    }

    if (patch.auth !== undefined) {
      return json(400, { error: "rotate a catalogue server's secret with `credential`" });
    }
    const entry = server.catalogueId === null ? null : await deps.catalogue.get(server.catalogueId);
    if (entry === null || entry.kind !== "hosted") {
      return json(409, { error: `the catalogue no longer has "${server.catalogueId}"` });
    }
    let settings = server.settings ?? {};
    if (patch.settings !== undefined) {
      const resolved = await resolveSettings(entry, patch.settings, {
        base: settings,
        checkUrl: checkSettingUrl(server.slug),
      });
      if (!resolved.ok) return json(400, { error: resolved.error });
      settings = resolved.settings;
    }
    const relaunch = !sameSettings(settings, server.settings);
    // A setting that can steer where the container sends the credential on — a URL, a region
    // choice, a site name — takes the credential again when it changes, as a remote row's url
    // does: the server never moves an old secret to a new destination on its own say-so. A
    // toggle steers nothing, and an entry with no secret has nothing to move.
    const before = server.settings ?? {};
    const steered = entry.settings.some((s) =>
      s.kind !== "toggle" && settings[s.key] !== before[s.key]
    );
    if (
      steered && patch.credential === undefined && server.encryptedAuth !== null &&
      secretHeadersOf(entry).length > 0
    ) {
      return json(400, {
        error: "changing where this server sends its credential needs the credential again: " +
          "send `credential` with the new settings",
        code: CREDENTIAL_REQUIRED,
      });
    }
    if (relaunch && server.archivedAt === null) {
      const off = hostingRefusal();
      if (off) return off;
    }
    if (patch.settings !== undefined) edit.settings = settings;
    if (patch.credential !== undefined || relaunch) {
      // The secrets are the rotation's when it carries them; otherwise the row's own, unsealed
      // to re-derive the header map around a setting that changed (the Grafana URL header) —
      // only ever a toggle, or an entry with no secret, by the refusal above.
      let secrets = patch.credential;
      if (secrets === undefined) {
        const current = await openHeaders(server);
        if (current === null) return secretRequired("this change cannot carry it over");
        // Prefixes off, or composing would put a second one in front.
        secrets = secretsFromHeaders(entry, current);
      }
      const headers = composeHeaders(entry, settings, secrets);
      if (!headers.ok) return json(400, { error: headers.error });
      // Bound to the settings as they will stand: the row's own when this PATCH leaves them.
      const stands = patch.settings === undefined ? server.settings : settings;
      Object.assign(
        edit,
        await sealHeaders(
          headers.headers,
          headers.trace,
          sealFor({ ...server, settings: stands }),
        ),
      );
    }
    const written = await storeEdit(server, edit);
    if (!written.ok) return written.res;
    const updated = written.server;
    // Settings are argv or env, so a change is always a relaunch. A rotation is not: the
    // container never held the credential, and the next call carries the new one.
    const result = relaunch && updated.archivedAt === null
      ? await hosting.launch(updated)
      : updated;
    return json(200, await present(result));
  };

  const probe = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const server = await store.getServer(params.id);
    if (!server) return json(404, { error: "no such server" });
    // A platform row is probed too — not at its marker URL with a credential it does not have,
    // but where a run's calls go, with the gateway's own (see probe.ts). It is the one management
    // action a platform row answers: a look, changing nothing.
    // Archiving is the kill switch, and it is meant to be total: the data plane stops forwarding
    // for an archived row, so the probe — the one other place the real credential goes out — must
    // stop dialing for it too. The row stays readable; only using it ends.
    if (server.archivedAt !== null) {
      return json(409, { error: "this server is archived", code: SERVER_ARCHIVED });
    }
    // A verdict about upstream rides a 200 either way; only OUR failures are HTTP errors.
    return json(200, await deps.probe(server));
  };

  /** A live hosted row for the hosting-only actions, or the refusal to send instead. */
  const hostedOr = async (
    id: string,
  ): Promise<{ ok: true; server: McpServer } | { ok: false; res: Response }> => {
    const server = await store.getServer(id);
    if (!server) return { ok: false, res: json(404, { error: "no such server" }) };
    if (server.kind !== "hosted") {
      return { ok: false, res: json(400, { error: "only a hosted server has a container" }) };
    }
    if (server.archivedAt !== null) {
      return { ok: false, res: json(409, { error: "the server is archived" }) };
    }
    const off = hostingRefusal();
    if (off) return { ok: false, res: off };
    return { ok: true, server };
  };

  const restart = async (req: Request, params: Record<string, string>): Promise<Response> => {
    // Management, like the rest: a restart decides which image the deployment runs — `updateImage`
    // moves the container to the digest the catalogue pins today — and hands it the credential.
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, RestartMcpServerSchema, { emptyIs: {} });
    if (!body.ok) return body.res;
    const found = await hostedOr(params.id);
    if (!found.ok) return found.res;
    const updateImage = body.data.updateImage ?? false;
    if (updateImage && found.server.catalogueId === null) {
      return json(400, { error: "updateImage: a custom container has no catalogue image" });
    }
    return json(200, await present(await hosting.launch(found.server, { updateImage })));
  };

  const logs = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const raw = new URL(req.url).searchParams.get("tail");
    const tail = raw === null ? LOGS_DEFAULT_TAIL : Number(raw);
    if (!Number.isInteger(tail) || tail < 1) {
      return json(400, { error: "tail: must be a positive integer" });
    }
    const found = await hostedOr(params.id);
    if (!found.ok) return found.res;
    const text = await hosting.logs(found.server, Math.min(tail, LOGS_MAX_TAIL));
    // The container never held the credential, so there should be nothing to hide — but it has
    // SEEN it, on every request, and an image that logs its headers would echo it here.
    // A catalogue row's setting-derived headers (the Grafana URL) are not secrets, and are what a
    // reader of these logs is looking for; a custom row's headers are all treated as secret.
    // A credential that cannot be opened cannot be redacted either: no logs until it is entered
    // again, rather than logs that may echo it.
    const sealed = await openHeaders(found.server);
    if (sealed === null) return secretRequired("its logs cannot be redacted");
    const named = found.server.catalogueId === null
      ? null
      : await deps.catalogue.get(found.server.catalogueId);
    const entry = named?.kind === "hosted" ? named : null;
    // Every sealed value is redacted except the headers today's entry derives from a setting —
    // judged by what the row holds, not by the entry's secret names, so an entry that renamed
    // its secret header since the row was sealed still has the old one hidden. The bare
    // secrets, prefixes off, too: a log line that printed the key alone is caught as well.
    const fromSettings = new Set(
      entry === null
        ? []
        : Object.entries(entry.credential.headers).flatMap(([n, s]) => "from" in s ? [n] : []),
    );
    const secrets = [
      ...Object.entries(sealed).flatMap(([n, v]) => fromSettings.has(n) ? [] : [v]),
      ...(entry === null ? [] : Object.values(secretsFromHeaders(entry, sealed))),
    ];
    return json(200, { logs: redact(text, secrets) });
  };

  const usage = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.runId);
    if (denied) return denied;
    const query = new URL(req.url).searchParams;

    // How long a run's trail is, is the AGENT's decision: a call to a tool outside the allowlist
    // is refused locally, before any dial, and still writes a row — so a loop writes rows as fast
    // as it can send requests. Nobody reads a trail whole: a request without a limit gets the
    // newest page, and the cursor is how a reader that wants more walks backwards for it.
    const rawLimit = query.get("limit");
    if (rawLimit !== null && !/^\d{1,4}$/.test(rawLimit)) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    const rawCursor = query.get("cursor");
    // Opaque on the wire, but not unchecked: a cursor we did not issue is a client error, not a
    // silent read of the newest page under a caller that thinks it is paging.
    if (rawCursor !== null && usageCursor(rawCursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    const page = await store.listUsageForRun(params.runId, {
      limit: rawLimit === null ? undefined : Number(rawLimit),
      cursor: rawCursor ?? undefined,
    });
    // `usage` keeps its shape and its order — the added fields are how a reader learns the trail
    // did not end here.
    return json(200, {
      usage: page.records,
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== null,
    });
  };

  return [
    route("GET", PATHS.catalogue, catalogueList),
    route("POST", PATHS.collection, create),
    route("GET", PATHS.collection, list),
    route("GET", PATHS.item, get),
    route("PATCH", PATHS.item, update),
    route("POST", PATHS.probe, probe),
    route("POST", PATHS.restart, restart),
    route("GET", PATHS.logs, logs),
    route("GET", PATHS.usage, usage),
  ];
}

/**
 * Mounts the same paths as `mcpServerRoutes`, answering every one with a "feature off" refusal.
 * A deployment without a master key has nothing to seal credentials with, so the management
 * surface cannot exist — but leaving the paths unmounted answers 404, which a client cannot
 * tell from a broken deployment. These say which it is.
 */
export function disabledMcpServerRoutes(
  deps: Pick<McpServerRoutesDeps, "authenticate">,
): Route[] {
  const off = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(503, { error: "MCP access not configured", code: MCP_DISABLED });
  };

  return [
    route("GET", PATHS.catalogue, off),
    route("POST", PATHS.collection, off),
    route("GET", PATHS.collection, off),
    route("GET", PATHS.item, off),
    route("PATCH", PATHS.item, off),
    route("POST", PATHS.probe, off),
    route("POST", PATHS.restart, off),
    route("GET", PATHS.logs, off),
    route("GET", PATHS.usage, off),
  ];
}
