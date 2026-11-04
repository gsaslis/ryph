// The ingest boundary for the management surface — every JSON payload is parsed against a
// schema here before it may travel as a core type, same doctrine as the model-proxy's.

import { z } from "@zod/zod";
import { ENV_NAME, PINNED_IMAGE } from "./core/catalogue.ts";
import { AllowedToolsSchema } from "./tool_scope.ts";
import { TOOL_PROXY_ENV_NAMES } from "./core/tool_egress.ts";
import {
  HEADER_NAME,
  HEADER_VALUE,
  MAX_HEADER_VALUE,
  REFUSED_CREDENTIAL_HEADERS_TEXT,
  refusedCredentialHeader,
} from "./core/credential_headers.ts";

const singleLine = z.string().trim().min(1).max(200)
  .refine((s) => !/[\r\n]/.test(s), { error: "must be a single line" });

/** Rides the gateway URL path and the container's config file: held to the agent-handle shape. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const slug = z.string().regex(SLUG_PATTERN, {
  error: "must be 1–39 lowercase letters, digits or hyphens, starting with a letter or digit",
});

const description = z.string().trim().max(2000);

// Where the URL may point is the upstream guard's question (resolved, ranged); the schema only
// asks that it parse. Length-capped so a row cannot carry a payload.
const url = z.string().trim().min(1).max(2048).refine((s) => URL.canParse(s), {
  error: "must be an absolute URL",
});

// A bearer token: opaque, but visible ASCII and never absurdly long. Whitespace inside would be a
// paste accident, and anything past ASCII (a zero-width space copied with the key) is a header
// value no request can carry — refuse it now rather than fail the first tool call.
const secret = z.string().min(8).max(4096).refine((s) => /^[\x21-\x7E]+$/.test(s), {
  error: "must be visible ASCII with no whitespace",
});

// An arbitrary header map, for servers that authenticate some other way (an API-key header, a
// pair of headers). Names are token-shaped and never one that steers the request
// (`refusedCredentialHeader`); values visible ASCII (`HEADER_VALUE`); the map small.
const headerName = z.string().regex(HEADER_NAME, { error: "not a valid header name" })
  .refine((name) => !refusedCredentialHeader(name), {
    error: `a credential may not set ${REFUSED_CREDENTIAL_HEADERS_TEXT}`,
  });
const headerValue = z.string().min(1).max(MAX_HEADER_VALUE).refine((s) => HEADER_VALUE.test(s), {
  error: "must be visible ASCII text, with single spaces between words",
});
const headers = z.record(headerName, headerValue)
  .refine((h) => Object.keys(h).length >= 1 && Object.keys(h).length <= 16, {
    error: "provide between 1 and 16 headers",
  });

// A credential field sent beside the wrong `auth` kind is refused, never silently dropped: an
// operator who pasted a secret must not see a success that stored none.
const absent = (message: string) => z.undefined({ error: message }).optional();

/**
 * How a credential arrives: as a discriminated union on `auth`, so a `bearer` server must carry a
 * secret and a `headers` server a map, and a `none` server carries nothing at all.
 */
const credential = z.discriminatedUnion("auth", [
  z.object({
    auth: z.literal("none"),
    secret: absent("auth=none takes no secret"),
    headers: absent("auth=none takes no headers"),
  }),
  z.object({
    auth: z.literal("bearer"),
    secret,
    headers: absent("auth=bearer takes a secret, not headers"),
  }),
  z.object({
    auth: z.literal("headers"),
    headers,
    secret: absent("auth=headers takes headers, not a secret"),
  }),
]);
export type CredentialInput = z.infer<typeof credential>;

/**
 * What POST /v1/mcp-servers accepts for a REMOTE server — the body that existed before hosting,
 * verbatim, with an optional `kind: "remote"`. The credential arrives exactly once, here.
 */
export const CreateMcpServerSchema = z.object({
  kind: z.literal("remote").optional(),
  slug,
  name: singleLine,
  description: description.optional(),
  url,
}).and(credential);

// A hosted server's settings are checked against its catalogue entry (core/catalogue.ts), which
// is data this schema cannot see; here they only have to be a small map of plain values.
const settingKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, {
  error: "not a setting key",
});
const settings = z.record(settingKey, z.union([z.string().max(2048), z.boolean()]))
  .refine((s) => Object.keys(s).length <= 16, { error: "too many settings" });

/** A hosted server's secrets, by the header name its catalogue entry reads them from. */
const secretsByHeader = z.record(headerName, headerValue)
  .refine((h) => Object.keys(h).length <= 16, { error: "too many credential headers" });

/**
 * Hosted from the catalogue: which entry, the settings its card asked for, the secrets it names.
 * The slug is optional — derived from the entry (`grafana`, `grafana-2`) when absent, because
 * nobody should have to invent one.
 */
export const CreateCatalogueServerSchema = z.object({
  kind: z.literal("hosted"),
  catalogueId: z.string().min(1).max(64),
  slug: slug.optional(),
  name: singleLine,
  description: description.optional(),
  settings: settings.default({}),
  credential: secretsByHeader.default({}),
}).strict();

/**
 * A remote server from a catalogue PRESET: the same body as a hosted catalogue create, with
 * `kind: "remote"`. No `url` — the entry writes it from the settings — and no `auth`: the
 * entry's headers are the only delivery, so the secrets arrive by header name, as above.
 */
export const CreateRemotePresetSchema = z.object({
  kind: z.literal("remote"),
  catalogueId: z.string().min(1).max(64),
  slug: slug.optional(),
  name: singleLine,
  description: description.optional(),
  settings: settings.default({}),
  credential: secretsByHeader.default({}),
}).strict();

/**
 * A stdio server named as an HTTP one. Not a proof — an image can do anything — but the obvious
 * spellings are refused with the reason, rather than launched to fail its first probe.
 */
const STDIO_ARG = /^(?:-{0,2}(?:t|transport)[= ])?stdio$/i;

/** The advanced path's container: an HTTP-speaking, digest-pinned image the operator names. */
export const CustomContainerSchema = z.object({
  image: z.string().trim().regex(PINNED_IMAGE, {
    error: "must be digest-pinned: repo[:tag]@sha256:<64 hex>",
  }),
  command: z.array(z.string().min(1).max(512)).max(32).default([]),
  port: z.int().min(1).max(65535),
  path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, { error: "must be an absolute path" })
    .default("/mcp"),
  /**
   * Which env var the image reads its caller token from. Required, and there is no opt-out on
   * this path: a catalogue entry's opt-out is a reviewed line in a file, while this image is one
   * an operator named minutes ago, and the caller token is the only thing standing between it
   * and its neighbours on the tools network — or a run, on a backend whose networks do not
   * isolate (OrbStack).
   */
  callerAuth: z.object({
    env: z.string().regex(ENV_NAME, { error: "not an env var name" }).refine(
      (name) => !TOOL_PROXY_ENV_NAMES.has(name),
      { error: "reserved: the tool host sets a hosted server's proxy itself" },
    ),
  }).strict(),
}).strict().superRefine((c, ctx) => {
  const joined = c.command.join(" ");
  if (
    c.command.some((a) => STDIO_ARG.test(a)) ||
    /(?:^|\s)-{1,2}(?:t|transport)\s+stdio\b/i.test(joined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["command"],
      message: "stdio servers are not hosted yet — only images that speak streamable HTTP",
    });
  }
});

/**
 * Hosted from an operator-named image, with a credential in the remote shape. Admin-only.
 *
 * Spelled as a union of whole objects rather than `.and(credential)` like the remote body: a zod
 * intersection drops the unknown-key refusal of a strict object nested inside it, and `custom`
 * being strict is what refuses a `privileged` or a `mounts` smuggled into it.
 */
const customBase = {
  kind: z.literal("hosted"),
  custom: CustomContainerSchema,
  slug,
  name: singleLine,
  description: description.optional(),
};
export const CreateCustomServerSchema = z.discriminatedUnion("auth", [
  z.object({ ...customBase, auth: z.literal("none") }),
  z.object({ ...customBase, auth: z.literal("bearer"), secret }),
  z.object({ ...customBase, auth: z.literal("headers"), headers }),
]);

/**
 * What PATCH /v1/mcp-servers/:id accepts: rename, redescribe, repoint, rotate the credential in
 * place (or change how the server authenticates), in any combination — but at least one. The
 * credential fields follow the same shape as create: `auth` says which of `secret` / `headers`
 * must come with it. A catalogue row also takes `settings` (a partial map; a change relaunches a
 * hosted row's container, and rewrites a remote preset's URL) and `credential` (its secrets by
 * header name — a rotation, which touches no container). Which fields apply to which kind of row
 * is the route's question.
 */
export const UpdateMcpServerSchema = z.object({
  name: singleLine.optional(),
  description: description.nullable().optional(),
  url: url.optional(),
  auth: z.enum(["none", "bearer", "headers"]).optional(),
  secret: secret.optional(),
  headers: headers.optional(),
  settings: settings.optional(),
  credential: secretsByHeader.optional(),
}).superRefine((patch, ctx) => {
  if (patch.auth === "bearer" && patch.secret === undefined) {
    ctx.addIssue({ code: "custom", path: ["secret"], message: "auth=bearer needs a secret" });
  }
  if (patch.auth === "headers" && patch.headers === undefined) {
    ctx.addIssue({ code: "custom", path: ["headers"], message: "auth=headers needs headers" });
  }
  // Each credential field only beside its own kind — never dropped in silence, see `absent`.
  if (patch.secret !== undefined && patch.auth !== "bearer") {
    ctx.addIssue({ code: "custom", path: ["secret"], message: "a secret needs auth=bearer" });
  }
  if (patch.headers !== undefined && patch.auth !== "headers") {
    ctx.addIssue({ code: "custom", path: ["headers"], message: "headers need auth=headers" });
  }
  if (patch.auth !== undefined && patch.credential !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["credential"],
      message: "rotate with either auth or credential, not both",
    });
  }
  if (
    patch.name === undefined && patch.description === undefined && patch.url === undefined &&
    patch.auth === undefined && patch.settings === undefined && patch.credential === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "nothing to update: provide name, description, url, settings and/or a credential",
    });
  }
});

/** What POST /v1/mcp-servers/:id/restart accepts — an empty body, or a move to the new image. */
export const RestartMcpServerSchema = z.object({
  updateImage: z.boolean().optional(),
}).strict();

/** The credential half of an update, in the create shape — or undefined when it is untouched. */
export function credentialOfUpdate(
  patch: z.infer<typeof UpdateMcpServerSchema>,
): CredentialInput | undefined {
  switch (patch.auth) {
    case undefined:
      return undefined;
    case "none":
      return { auth: "none" };
    case "bearer":
      return { auth: "bearer", secret: patch.secret! };
    case "headers":
      return { auth: "headers", headers: patch.headers! };
  }
}

// The tool allowlist grammar lives in its own leaf so the control plane can import it without
// pulling this package's data plane and stores in behind it; re-exported here, where the rest of
// the management schemas are, so there is still one place to read.
export { AllowedToolsSchema } from "./tool_scope.ts";

/**
 * What POST /internal/v1/runs/:id/mcp-credentials accepts — the run's frozen tool scope, handed
 * over the wire by the control plane instead of read from a shared table. The run id is the path
 * parameter, so it is deliberately absent here.
 */
export const IssueMcpCredentialsSchema = z.object({
  servers: z.array(z.object({
    serverId: z.string().min(1).max(200),
    allowedTools: AllowedToolsSchema,
  })).min(1).max(32),
});
