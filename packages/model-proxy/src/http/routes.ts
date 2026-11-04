// The management surface, as a mountable route list — the same trick as @ryph/auth: the
// Route shape is @ryph/shared's, so the default deployment spreads these into the host's route
// table.
//
// Invariants:
// - WRITE-ONLY on secrets: the secret arrives in a create or rotate body and never comes back.
//   Every response passes through `toPublicProviderKey`; there is no GET that could leak one.
// - rotation replaces the secret UNDER THE SAME ID: agents reference the id, so a rotated key
//   needs no re-assignment anywhere
// - a secret is sealed for WHERE AND HOW IT IS SENT (its key, its provider, a custom endpoint's
//   address, auth header and scheme, and extra headers): changing any of those drops the
//   endpoint's keys' secrets, and they are entered again
// - keys are archived, never deleted: historical runs keep resolving whose key they spent, and
//   archiving is the immediate kill-switch for every credential minted from the key
// - the paths are mounted in every deployment: without a master key they carry the disabled
//   stand-ins, so "model access is off" is always an answer and never a 404
// - a CUSTOM ENDPOINT is configuration, not a credential — but registering one decides where a
//   sealed key will be spent and what URL this pod will dial, so writing it is admin-only and
//   reading it is any user's, exactly like a provider key
// - `extraHeaders` never comes back out of the LIST (`toPublicProviderSpec` is that redaction
//   point). It is not secret by contract, but it is the one field an admin might put something
//   regrettable in, and the list is every signed-in user's — so the single-endpoint read that
//   does return it is admin-gated instead

import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { CHATGPT_PLAN } from "../core/chatgpt_plan.ts";
import { type ProviderKey, toPublicProviderKey } from "../core/types.ts";
import { providerKeyBinding } from "../core/sealing.ts";
import type { ProviderSpec } from "../core/registry.ts";
import type { SealBinding } from "@ryph/sealed";
import {
  canonicalAuthScheme,
  canonicalExtraHeaders,
  customProviderSpec,
  endpointHeadersProblem,
  endpointShape,
  toAdminProviderSpec,
  toPublicProviderSpec,
} from "../core/registry.ts";
import { listProviderSpecs, resolveProvider } from "../core/service.ts";
import type { GuardedKeyWrite, KeyStore } from "../ports/key_store.ts";
import { mintId } from "@ryph/sealed";
import {
  CreateCustomProviderSchema,
  CreateProviderKeySchema,
  endpointAddressProblem,
  PlatformModelPolicySchema,
  privateModelEndpointsAllowed,
  type ResolveHost,
  systemResolveHost,
  UpdateCustomProviderSchema,
  UpdateProviderKeySchema,
} from "../schema.ts";

/** The management surface's paths, shared by the live routes and their disabled stand-ins. */
const PATHS = {
  collection: "/v1/provider-keys",
  item: "/v1/provider-keys/:id",
  archive: "/v1/provider-keys/:id/archive",
  platform: "/v1/platform-model-policy",
  providers: "/v1/providers",
  provider: "/v1/providers/:id",
  providerArchive: "/v1/providers/:id/archive",
} as const;

import { USAGE_PATHS } from "./usage.ts";
import { PLAN_PATHS } from "./chatgpt_plan.ts";

/**
 * The machine-readable marker on a "model access is off" refusal. The VALUE is the contract,
 * not this name: @ryph/app builds on its own and carries its own copy in
 * `lib/api/provider-keys.ts`, so changing the string here means changing it there too. The
 * host's boot test asserts the literal, which is what catches the half-done rename.
 */
export const MODEL_ACCESS_DISABLED = "model_access_disabled";

/**
 * The marker on "the secret must be entered again", with a 409, wherever it is met: a key with no
 * secret (its endpoint changed), one whose stored secret does not open, or a save that raced an
 * endpoint change. The mcp-gateway answers the same code
 * for the same condition on a server credential. The app carries its own copy, as above.
 */
export const SECRET_REQUIRED = "secret_required";

/** The marker on a key whose provider no longer resolves: it can only be archived. */
export const PROVIDER_MISSING = "provider_missing";

export interface ProviderKeyRoutesDeps {
  store: KeyStore;
  /** Seals a secret for the row, bound to it (`providerKeyBinding`) — built by the composition
   * root from the master key. */
  encrypt(plaintext: string, binding: SealBinding): Promise<string>;
  /** The host's user-surface gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  /**
   * The same gate narrowed to ADMINS — every route that touches a credential: registering a
   * provider key, rotating its secret, archiving it, and setting or clearing the platform model
   * policy. Reading stays on `authenticate`, because the app shows both to any signed-in user.
   * Break-glass passes, as it does everywhere.
   */
  authenticateManage(req: Request): Promise<Response | null>;
  now(): Date;
  /**
   * Signs a ChatGPT plan key out — its session ended at OpenAI (best effort), its tokens
   * dropped, the key archived — which is what archiving one is. Absent where plans are not
   * wired, and the key is archived like any other.
   */
  archivePlanKey?(
    keyId: string,
  ): Promise<{ key: ProviderKey; revoked: boolean | null } | null>;
  /** Whether ChatGPT plan keys are on: a local deployment. Off, `/v1/providers` leaves the
   * provider out, so no picker offers it. */
  planOn?: boolean;
  /** Resolves a custom endpoint's host, to refuse one whose name points inside the network
   * (`endpointAddressProblem`); the platform's DNS unless a test fakes it. */
  resolveHost?: ResolveHost;
}

export function providerKeyRoutes(deps: ProviderKeyRoutesDeps): Route[] {
  /** The 400 for a base URL whose name resolves inside the network. */
  const addressRefusal = async (baseUrl: string): Promise<Response | null> => {
    const problem = await endpointAddressProblem(
      baseUrl,
      privateModelEndpointsAllowed(),
      deps.resolveHost ?? systemResolveHost,
    );
    return problem === null || problem.kind === "unresolvable"
      ? null
      : json(400, { error: `baseUrl: ${problem.detail}` });
  };
  const { store } = deps;
  const nowIso = () => deps.now().toISOString();

  /**
   * The refusal for a secret sealed for an endpoint shape that is no longer the endpoint's: the
   * endpoint moved between the read the secret was bound to and the write, which
   * `writeProviderKeySealedFor` checks under the endpoint row's lock. Nothing was written.
   */
  const movedWhileSealing = () =>
    json(409, {
      error: "the endpoint changed while the key was saved — enter the secret again",
      code: SECRET_REQUIRED,
    });

  /** A key write whose secret was sealed for `sealedFor`: guarded by that endpoint's shape when
   * it is a custom one, plain for a built-in (whose shape is code). */
  const writeSealedFor = async (
    sealedFor: ProviderSpec,
    write: { create: ProviderKey } | {
      id: string;
      patch: Parameters<KeyStore["updateProviderKey"]>[1];
    },
  ): Promise<GuardedKeyWrite> => {
    if (!sealedFor.builtin) {
      return await store.writeProviderKeySealedFor(
        { providerId: sealedFor.id, shape: endpointShape(sealedFor) },
        write,
      );
    }
    if ("create" in write) {
      await store.createProviderKey(write.create);
      return { moved: false, key: write.create };
    }
    return { moved: false, key: await store.updateProviderKey(write.id, write.patch) };
  };

  const create = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, CreateProviderKeySchema);
    if (!body.ok) return body.res;
    // The existence check the ingest schema used to make statically. It lives here because the
    // set of providers is built-ins ∪ live rows, and only this side of the boundary holds a
    // store. An ARCHIVED endpoint is refused too: registering a key that could never spend is
    // a mistake worth catching at the keyboard rather than at a run's boot.
    // A plan key has no secret to paste: it is an OAuth token set, and signing in is the only
    // way one is made (POST /v1/chatgpt-plan/sign-ins).
    if (body.data.provider === CHATGPT_PLAN) {
      return json(400, { error: "a ChatGPT plan key is added by signing in, not with a secret" });
    }
    const provider = await resolveProvider(store, body.data.provider);
    if (provider === null) return json(400, { error: "no such provider" });
    if (provider.archivedAt !== null) {
      return json(400, { error: "that model endpoint is archived" });
    }

    const at = nowIso();
    const id = mintId("pk");
    const key = {
      id,
      provider: body.data.provider,
      label: body.data.label,
      last4: body.data.secret.slice(-4),
      // Bound to the key and to where it will be sent: this provider, at this address.
      encryptedSecret: await deps.encrypt(
        body.data.secret,
        providerKeyBinding({ id, provider: body.data.provider }, provider),
      ),
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const written = await writeSealedFor(provider, { create: key });
    if (written.moved) return movedWhileSealing();
    return json(201, toPublicProviderKey(key, { account: true }));
  };

  const list = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const keys = await store.listProviderKeys();
    // A plan key's account is shown to the people who manage keys, and no one else. Asked only
    // when there is one to show: it is a second verification of the same bearer.
    const account = keys.some((key) => key.plan) && await deps.authenticateManage(req) === null;
    // A key whose provider is gone is shown as such: it can only be archived.
    const missing = new Set<string>();
    for (const provider of new Set(keys.map((key) => key.provider))) {
      if (await resolveProvider(store, provider) === null) missing.add(provider);
    }
    return json(200, {
      providerKeys: keys.map((key) =>
        toPublicProviderKey(key, { account, providerMissing: missing.has(key.provider) })
      ),
    });
  };

  const update = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const key = await store.getProviderKey(params.id);
    if (!key) return json(404, { error: "no such provider key" });
    const body = await parseBody(req, UpdateProviderKeySchema);
    if (!body.ok) return body.res;
    if (key.provider === CHATGPT_PLAN && body.data.secret !== undefined) {
      return json(400, { error: "a ChatGPT plan key is renewed by signing in again" });
    }
    // The secret is sealed for where the key is sent NOW: its provider, at the endpoint's current
    // shape. A provider that no longer resolves has nowhere to bind it to, and never will: the
    // key can only be archived.
    let sealedFor: ProviderSpec | null = null;
    if (body.data.secret !== undefined) {
      sealedFor = await resolveProvider(store, key.provider);
      if (sealedFor === null) {
        return json(409, {
          error: `this key's provider "${key.provider}" no longer exists — archive the key`,
          code: PROVIDER_MISSING,
        });
      }
    }

    // A patch of exactly what changed, never the whole row read above: a plan key's tokens
    // rotate under it, and writing the row back would put the spent refresh token back.
    const patch = {
      ...(body.data.label === undefined ? {} : { label: body.data.label }),
      // Rotation in place: same id, new secret — nothing referencing the key moves. Also how a
      // key whose endpoint moved gets its secret back.
      ...(body.data.secret === undefined || sealedFor === null ? {} : {
        last4: body.data.secret.slice(-4),
        encryptedSecret: await deps.encrypt(body.data.secret, providerKeyBinding(key, sealedFor)),
      }),
      updatedAt: nowIso(),
    };
    let updated: ProviderKey | null;
    if (sealedFor === null) updated = await store.updateProviderKey(key.id, patch);
    else {
      // Written only while the endpoint is still the shape the secret was sealed for.
      const written = await writeSealedFor(sealedFor, { id: key.id, patch });
      if (written.moved) return movedWhileSealing();
      updated = written.key;
    }
    if (updated === null) return json(404, { error: "no such provider key" });
    return json(200, toPublicProviderKey(updated, { account: true }));
  };

  const archive = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const key = await store.getProviderKey(params.id);
    if (!key) return json(404, { error: "no such provider key" });
    if (key.archivedAt !== null) {
      return json(200, toPublicProviderKey(key, { account: true })); // idempotent
    }
    // A plan key is signed out: its session ended at OpenAI first, as signing out asks, its
    // tokens dropped, under the key's lock. Best effort at OpenAI: archiving is the kill switch
    // here whatever OpenAI answers, and `revoked: false` tells the person to disconnect ryph in
    // ChatGPT's settings to be sure.
    if (key.provider === CHATGPT_PLAN && deps.archivePlanKey) {
      const signedOut = await deps.archivePlanKey(key.id);
      if (signedOut === null) return json(404, { error: "no such provider key" });
      return json(200, {
        ...toPublicProviderKey(signedOut.key, { account: true }),
        ...(signedOut.revoked === null ? {} : { revoked: signedOut.revoked }),
      });
    }
    const at = nowIso();
    const archived = await store.updateProviderKey(key.id, { archivedAt: at, updatedAt: at });
    return json(
      200,
      toPublicProviderKey(archived ?? { ...key, archivedAt: at, updatedAt: at }, { account: true }),
    );
  };

  // ── custom model endpoints ───────────────────────────────────────────────────────────────
  //
  // Built-ins and rows answer as ONE list, built-ins first, and a reader cannot tell which is
  // which except by the `builtin` flag it is told. Writes touch rows only: a built-in has no row
  // to patch or archive, so both answer 404 rather than pretending to have done something.

  const listProviders = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const specs = await listProviderSpecs(store, { planOn: deps.planOn ?? false });
    return json(200, { providers: specs.map(toPublicProviderSpec) });
  };

  /**
   * One provider in full, `extraHeaders` included — what an edit dialog needs to show the
   * operator what is stored before it PATCHes a replacement back.
   *
   * ADMIN-gated while the list above is not, and that split is the entire reason this route is
   * separate rather than a wider list. Nothing here is a secret — the credential is the provider
   * key, which is sealed and has no read path at all — but `extraHeaders` is a free-text map an
   * admin typed, and somebody will eventually put something in it that the label said not to.
   * The list is read by every signed-in user (the key form's provider picker); this is read only
   * by the people who may rewrite the row anyway. Built-ins resolve here too and answer
   * `extraHeaders: {}`: which kind an id turns out to be is not a reason to answer differently.
   */
  const getProvider = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const spec = await resolveProvider(store, params.id);
    if (spec === null) return json(404, { error: "no such model endpoint" });
    return json(200, toAdminProviderSpec(spec));
  };

  const createProvider = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, CreateCustomProviderSchema);
    if (!body.ok) return body.res;
    const unreachable = await addressRefusal(body.data.baseUrl);
    if (unreachable !== null) return unreachable;
    if (await store.getCustomProvider(body.data.id) !== null) {
      // Not an upsert: the id is what provider keys and agent policies point at, so silently
      // repointing it at another URL is the one thing a create must never do.
      return json(409, { error: "a model endpoint with that id already exists" });
    }
    const at = nowIso();
    // Header names are stored lower-cased and values trimmed (`canonicalExtraHeaders`), the
    // form `endpointShape` compares in: re-saving what is stored never reads as a move.
    const authHeader = (body.data.authHeader ?? "authorization").toLowerCase();
    // The scheme follows the header when it is not stated: `authorization` wants `Bearer`, a
    // named header (Azure's `api-key`) wants the bare value. Stating `null` is how an admin
    // asks for a bare value on `authorization` itself.
    const authScheme = body.data.authScheme === undefined
      ? (authHeader === "authorization" ? "Bearer" : null)
      : canonicalAuthScheme(body.data.authScheme);
    const extraHeaders = canonicalExtraHeaders(body.data.extraHeaders ?? {});
    if (extraHeaders === null) return json(400, { error: "a header is set twice" });
    const headersProblem = endpointHeadersProblem(extraHeaders, authHeader, authScheme);
    if (headersProblem !== null) return json(400, { error: headersProblem });
    const row = {
      id: body.data.id,
      label: body.data.label,
      baseUrl: body.data.baseUrl,
      authHeader,
      authScheme,
      extraHeaders,
      models: body.data.models,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createCustomProvider(row);
    return json(201, toPublicProviderSpec(customProviderSpec(row)));
  };

  const updateProvider = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, UpdateCustomProviderSchema);
    if (!body.ok) return body.res;
    const existing = await store.getCustomProvider(params.id);
    // 404 covers both "no such row" and "that is a built-in": neither has a row to patch, and
    // telling them apart would only tell a caller which names ship as code — which the list
    // route says outright anyway.
    if (existing === null) return json(404, { error: "no such model endpoint" });
    // Archiving is a kill switch everywhere else — no key may be registered against an archived
    // endpoint, no credential issued, nothing forwarded — so editing one is editing something
    // that can never be used again, and there is deliberately no un-archive path for the edit
    // to be mistaken for. Same refusal POST /v1/provider-keys gives, for the same reason.
    if (existing.archivedAt !== null) {
      return json(400, { error: "that model endpoint is archived" });
    }
    // Canonical, as on create: names lower-cased, values and scheme trimmed.
    const authHeader = body.data.authHeader?.toLowerCase();
    const authScheme = body.data.authScheme === undefined
      ? undefined
      : canonicalAuthScheme(body.data.authScheme);
    const extraHeaders = body.data.extraHeaders === undefined
      ? undefined
      : canonicalExtraHeaders(body.data.extraHeaders);
    if (extraHeaders === null) return json(400, { error: "a header is set twice" });
    // Held against the auth header the row will carry, which this patch may or may not change.
    const headersProblem = endpointHeadersProblem(
      extraHeaders ?? existing.extraHeaders,
      authHeader ?? existing.authHeader,
      authScheme === undefined ? existing.authScheme : authScheme,
    );
    if (headersProblem !== null) return json(400, { error: headersProblem });
    if (body.data.baseUrl !== undefined) {
      const unreachable = await addressRefusal(body.data.baseUrl);
      if (unreachable !== null) return unreachable;
    }
    // A changed request shape (`endpointShape`: `baseUrl`, `authHeader`, `authScheme`,
    // `extraHeaders`, compared canonically) drops the secret of every key registered against
    // this endpoint, in the store's same transaction: each was sealed for the old shape and is
    // entered again (the keys then read `needsSecret`), never re-sealed for the new one here.
    // The answer says how many live keys that was.
    const updated = await store.updateCustomProvider(params.id, {
      ...body.data,
      ...(authHeader === undefined ? {} : { authHeader }),
      ...(authScheme === undefined ? {} : { authScheme }),
      ...(extraHeaders === undefined ? {} : { extraHeaders }),
      updatedAt: nowIso(),
    });
    if (updated === null) return json(404, { error: "no such model endpoint" });
    return json(200, {
      ...toPublicProviderSpec(customProviderSpec(updated.provider)),
      keysCleared: updated.keysCleared,
    });
  };

  const archiveProvider = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const existing = await store.getCustomProvider(params.id);
    if (existing === null) return json(404, { error: "no such model endpoint" });
    // Idempotent, and the row stays resolvable forever: every usage row it priced still needs
    // it, and an in-flight run needs it to be refused with a 403 rather than a 502.
    if (existing.archivedAt === null) await store.archiveCustomProvider(params.id, nowIso());
    const row = await store.getCustomProvider(params.id) ?? existing;
    return json(200, toPublicProviderSpec(customProviderSpec(row)));
  };

  // The platform's own policy: which key the platform's background model calls spend. Set by
  // naming a live key; the provider is the key's, never typed. Cleared, the consolidator and
  // every other off-run model call go dark and say so.
  const getPlatform = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(200, { policy: await store.getPlatformPolicy() });
  };

  const setPlatform = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, PlatformModelPolicySchema);
    if (!body.ok) return body.res;
    const key = await store.getProviderKey(body.data.providerKeyId);
    if (!key) return json(400, { error: "no such provider key" });
    if (key.archivedAt !== null) return json(400, { error: "that provider key is archived" });
    // And the ENDPOINT behind it, which is a kill switch of its own. Without this the policy
    // could be set against a withdrawn endpoint, every consumer's mint would then fail with
    // `resolvePlatformPolicy`'s definitive refusal, and memory consolidation would go dark with
    // nothing at the keyboard having said so. Same argument as POST /v1/provider-keys makes.
    const provider = await resolveProvider(store, key.provider);
    if (provider === null) return json(400, { error: "no such provider" });
    if (provider.archivedAt !== null) {
      return json(400, { error: "that model endpoint is archived" });
    }
    const policy = {
      providerKeyId: key.id,
      provider: key.provider,
      allowedModels: body.data.allowedModels,
      model: body.data.model,
      updatedAt: nowIso(),
    };
    await store.savePlatformPolicy(policy);
    // Every platform credential already out was minted against the OLD policy — another key,
    // another allowlist. Killing them here is what makes the edit take effect now rather than
    // whenever the longest-lived of them lapses; each consumer re-mints on its next 401.
    await store.revokePlatformVirtualKeys(policy.updatedAt);
    return json(200, { policy });
  };

  const clearPlatform = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const at = nowIso();
    await store.clearPlatformPolicy();
    // "Go dark" has to mean now: without this the outstanding credentials keep spending the key
    // an admin just withdrew, for up to their whole TTL.
    await store.revokePlatformVirtualKeys(at);
    return json(200, { policy: null });
  };

  return [
    route("POST", PATHS.collection, create),
    route("GET", PATHS.collection, list),
    route("PATCH", PATHS.item, update),
    route("POST", PATHS.archive, archive),
    route("GET", PATHS.providers, listProviders),
    route("POST", PATHS.providers, createProvider),
    route("GET", PATHS.provider, getProvider),
    route("PATCH", PATHS.provider, updateProvider),
    route("POST", PATHS.providerArchive, archiveProvider),
    route("GET", PATHS.platform, getPlatform),
    route("PUT", PATHS.platform, setPlatform),
    route("DELETE", PATHS.platform, clearPlatform),
  ];
}

/**
 * Mounts the same paths as `providerKeyRoutes`, answering every one with a "feature off"
 * refusal. A deployment without a master key has nothing to seal secrets with, so the
 * management surface cannot exist — but leaving the paths unmounted answers 404, which a
 * client cannot tell from a broken deployment. These say which it is, so callers can
 * degrade to an empty state instead of treating it as a fault.
 */
export function disabledProviderKeyRoutes(
  deps: Pick<ProviderKeyRoutesDeps, "authenticate">,
): Route[] {
  const off = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(503, { error: "model access not configured", code: MODEL_ACCESS_DISABLED });
  };

  return [
    route("POST", PATHS.collection, off),
    route("GET", PATHS.collection, off),
    route("PATCH", PATHS.item, off),
    route("POST", PATHS.archive, off),
    route("GET", PATHS.providers, off),
    route("POST", PATHS.providers, off),
    route("GET", PATHS.provider, off),
    route("PATCH", PATHS.provider, off),
    route("POST", PATHS.providerArchive, off),
    route("GET", PATHS.platform, off),
    route("PUT", PATHS.platform, off),
    route("DELETE", PATHS.platform, off),
    route("GET", USAGE_PATHS.window, off),
    route("GET", USAGE_PATHS.run, off),
    route("POST", PLAN_PATHS.signIns, off),
    route("GET", PLAN_PATHS.signIn, off),
    route("POST", PLAN_PATHS.models, off),
  ];
}
