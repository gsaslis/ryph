// What an MCP server's sealed credential is bound to.
//
// One class, `mcp-credentials`, its key derived from RYPH_MCP_KEY (in the binary, RYPH_SECRETS_KEY
// when that is unset — the same master as the provider keys, but a different derived key). The
// header map is bound to the row's id, its kind, and where it is sent:
// - a REMOTE row (typed, or a catalogue preset's): its `url`. Repointing it in the database makes
//   the credential unopenable rather than sending it there, and the API takes the credential
//   again with any new url
// - a HOSTED row: what runs behind the slug and how it is set up — its `slug`, its catalogue entry
//   or custom container (image, command, port, path), and its settings (a Grafana URL setting is
//   where the container sends the credential on). Not its url: a hosted row is never dialled at
//   it. It is dialled at its launch key (`launchKey`, below), derived from these same fields
// - a PLATFORM row carries no credential at all

import {
  decryptSecret,
  deriveSealingKey,
  encryptSecret,
  type MasterKey,
  type SealBinding,
  type SealingKey,
  sha256Hex,
} from "@ryph/sealed";
import type { McpServer } from "./types.ts";
import type { HostedOutlook } from "./hosting.ts";
import { guardRoutePath } from "./tool_guard.ts";

export const MCP_CREDENTIALS_CLASS = "mcp-credentials";

/** A server credential's binding: the row, and where the credential goes. */
export function mcpCredentialBinding(
  server: Pick<McpServer, "id" | "kind" | "url" | "slug" | "catalogueId" | "custom" | "settings">,
): SealBinding {
  if (server.kind !== "hosted") {
    return { id: server.id, kind: server.kind, url: server.url };
  }
  const { custom, settings } = server;
  return {
    id: server.id,
    kind: server.kind,
    slug: server.slug,
    catalogueId: server.catalogueId,
    // Fixed array shapes and sorted entries, not the stored JSON: a jsonb column hands keys back
    // in its own order.
    custom: custom === null
      ? null
      : JSON.stringify([custom.image, custom.command, custom.port, custom.path]),
    // No settings and empty settings are one value, as the routes' `sameSettings` reads them: an
    // edit between the two relaunches nothing and must not make the credential unopenable.
    settings: JSON.stringify(
      Object.entries(settings ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    ),
  };
}

/**
 * A digest of the row's credential binding: what the routes compare-and-set an edit on, and what
 * a launch key is derived from. Fields sorted, as `associatedData` sorts them.
 */
export async function credentialBindingDigest(
  server: Parameters<typeof mcpCredentialBinding>[0],
): Promise<string> {
  const binding = mcpCredentialBinding(server);
  const fields = Object.keys(binding).sort().map((name) => [name, binding[name]]);
  return await sha256Hex(JSON.stringify([MCP_CREDENTIALS_CLASS, fields]));
}

/**
 * The code on a hosted row whose route here is a launch from other inputs than the row has now
 * (another state of it): nothing is dialled until it is relaunched from the current one, which
 * this gateway does — the supervisor relaunches a row whose probe answers this.
 */
export const HOSTED_STALE = "hosted_stale";

/**
 * The code on a hosted row this gateway has NO container routed for and none is coming: hosting
 * is off or misconfigured here, the row is stopped or archived, or its launch cannot be derived
 * from what it says. Nothing will change without a person.
 */
export const HOSTED_NOT_RUNNING = "hosted_not_running";

/**
 * The code on a hosted row with nothing routed yet but a launch coming by itself: hosting still
 * booting or waiting for the lease a departing gateway holds, a gateway handing over, the row
 * starting or due a backoff relaunch. Worth asking again shortly.
 */
export const HOSTED_STARTING = "hosted_starting";

/** A hosted image digest as a row may carry it, and nothing else: it is spliced into a reference. */
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * A hosted launch's key: 128 bits of SHA-256 over exactly what the launch is made from that the
 * row says — the credential binding (row id, kind, slug, catalogue entry or custom container,
 * settings), the image digest it runs, and a custom container's caller-auth env var — as a
 * fixed-shape JSON array, so no two inputs encode alike. A catalogue entry is in it by id: the
 * entry itself is code shipped with the gateway, read once at start, and every row is relaunched
 * at boot, so no container outlives the entry it was launched from. It names the
 * container (`toolContainerName`) and the guard's route to it, and the data plane derives it from
 * the row as it stands before every dial: a credential is only ever dialled at the container
 * launched from the inputs it is bound to. The digest is not part of the sealed binding — moving
 * a row to its entry's newer image would otherwise need the credential again — but it is in the
 * key, so a container of another digest than the row names is another address.
 */
export async function launchKey(
  server: Parameters<typeof mcpCredentialBinding>[0],
  imageDigest: string | null,
): Promise<string> {
  const hex = await sha256Hex(
    JSON.stringify([
      "ryph hosted launch v1",
      await credentialBindingDigest(server),
      imageDigest,
      // A custom container's caller-auth env var: not where the credential goes, so not in the
      // binding, but a launch input all the same.
      server.custom?.callerAuth?.env ?? null,
    ]),
  );
  return hex.slice(0, 32);
}

/** What this gateway has routed for a hosted row: the launch key, and whether the guard serves it. */
export interface HostedRouteState {
  key: string;
  /** The running guard routes the key: set once its relaunch with the route returned. */
  ready: boolean;
}

/** Why a hosted row's credential is not sent this time, as the data plane answers it. */
export interface HostedRefusal {
  code: typeof HOSTED_STALE | typeof HOSTED_STARTING | typeof HOSTED_NOT_RUNNING;
  /** 503 when this gateway is about to fix it (a client may ask again), 502 when it is not. */
  status: 502 | 503;
  error: string;
}

/** A route launched from other inputs than the row has now: relaunched by the supervisor. */
const STALE: HostedRefusal = {
  code: HOSTED_STALE,
  status: 503,
  error: "this server's container was launched from other settings than it has now; " +
    "it is relaunched with the current ones — try again shortly",
};

/** The refusal for a hosted row with nothing routed: a launch coming (503), or none (502). */
function unrouted(
  outlook: ((server: McpServer) => HostedOutlook) | undefined,
  server: McpServer,
): HostedRefusal {
  const coming = outlook?.(server) ?? { coming: false, reason: "this gateway hosts nothing" };
  if (coming.coming) return startingRefusal();
  return {
    code: HOSTED_NOT_RUNNING,
    status: 502,
    error: `this server has no running container on this gateway: ${coming.reason}`,
  };
}

/** The 503 for a container not answering yet: routed for a launch still coming up. */
export function startingRefusal(): HostedRefusal {
  return {
    code: HOSTED_STARTING,
    status: 503,
    error: "this server's container is starting — try again shortly",
  };
}

/** Where a hosted row may be dialled right now, or why not. */
export type HostedDial = { ok: true; target: string } | { ok: false; refusal: HostedRefusal };

/** What the hosting service says, as the data plane and the probe read it. */
export interface HostedGateDeps {
  /** What this gateway has routed for a row (core/hosting.ts `route`). */
  route?: (serverId: string) => HostedRouteState | null;
  /** For a row with nothing routed: whether a launch is coming. */
  outlook?: (server: McpServer) => HostedOutlook;
  /** The tool guard's origin, or null while none runs. */
  guardOrigin?: () => string | null;
}

/**
 * Where to dial a hosted row: `<guard>/<key>/mcp`, the key computed here from the row as it
 * stands (`launchKey`), never its stored url and never its slug. That address reaches the
 * container launched from exactly these inputs or nothing, so this is SAFE whatever the route table
 * says; the table only decides which refusal is honest when the key is not served yet:
 * - nothing routed for the row, or no guard: `hosted_starting` (503) when a launch is coming,
 *   `hosted_not_running` (502) when not
 * - routed to a launch of other inputs: `hosted_stale` (503), and the supervisor relaunches —
 *   unless no launch can come (the row is blocked), which is `hosted_not_running`
 * - routed to this key, the guard not yet relaunched with it: `hosted_starting`
 */
export async function hostedDial(deps: HostedGateDeps, server: McpServer): Promise<HostedDial> {
  const digest = server.host?.imageDigest ?? null;
  const route = deps.route?.(server.id) ?? null;
  const origin = deps.guardOrigin?.() ?? null;
  if (route === null || origin === null || digest === null) {
    return { ok: false, refusal: unrouted(deps.outlook, server) };
  }
  const key = await launchKey(server, digest);
  if (route.key !== key) {
    // Stale only when a relaunch is coming: a row whose launch cannot be derived any more (a
    // malformed digest, its catalogue entry gone) has nothing coming, whatever is still routed.
    const coming = deps.outlook?.(server) ?? { coming: true };
    return { ok: false, refusal: coming.coming ? STALE : unrouted(deps.outlook, server) };
  }
  if (!route.ready) return { ok: false, refusal: startingRefusal() };
  return { ok: true, target: new URL(guardRoutePath(key), origin).href };
}

export interface McpSealer {
  seal(plaintext: string, binding: SealBinding): Promise<string>;
  open(sealed: string, binding: SealBinding): Promise<string>;
}

/** The sealer over a master: the class key derived once, on first use. */
export function makeMcpSealer(master: MasterKey): McpSealer {
  let key: Promise<SealingKey> | null = null;
  const derived = () => key ??= deriveSealingKey(master, MCP_CREDENTIALS_CLASS);
  return {
    seal: async (plaintext, binding) => encryptSecret(await derived(), plaintext, binding),
    open: async (sealed, binding) => decryptSecret(await derived(), sealed, binding),
  };
}
