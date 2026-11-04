// ChatGPT plan keys: signing in, keeping the token set fresh, and the key's state — everything a
// plan key needs beyond what any provider key gets, over the KeyStore and the OpenAiAccounts port.
//
// Invariants:
// - a key comes into being ONLY through a finished sign-in: state checked, code exchanged once,
//   ID token verified (signature, issuer, audience = the issued client, nonce, expiry) and the
//   plan scope granted. A sign-in into an existing key must be the same account
// - the tokens are sealed, one JSON document per key, replaced whole after a refresh
// - every write that depends on the key's tokens or status goes through `exclusive`: this
//   process's queue for the key, then the database's lock on it across processes, and a re-read
//   inside both. The refresh, a re-sign-in's write, archiving (revoke, then tombstone) and the
//   status marks all do — the refresh token rotates on every use, and one spent twice is one
//   OpenAI revokes
// - a refreshed token set is written back only over the secret it was refreshed from (a
//   compare-and-swap), retried, and held in memory until it lands: the rotated refresh token is
//   the only one that works, and losing it is a sign-in lost
// - only OpenAI's verdict on the refresh token marks a key `needs_reauth`; not reaching OpenAI
//   leaves the key as it was and the call fails for now
// - nothing here logs or returns a token, a code or a verifier

import { mintId } from "@ryph/sealed";
import {
  accessExpired,
  accessExpiryOf,
  authorizeUrl,
  callbackParams,
  CHATGPT_PLAN,
  DYNAMIC_CLIENT_ID,
  mintAgentHostId,
  parseTokenSet,
  pkceChallenge,
  PLAN_USE_SCOPE,
  planModelsOf,
  type PlanTokenSet,
  randomToken,
  REDIRECT_URI,
  refreshDue,
  refreshTokenUnusable,
  refreshTooEarly,
  scopesOf,
  sealableTokens,
  SIGN_IN_TTL_MS,
  TOKEN_EXPIRED_CODE,
} from "./chatgpt_plan.ts";
import { holdsCurrentSealed, type PlanSignIn, type ProviderKey } from "./types.ts";
import { BUILTIN_PROVIDERS } from "./registry.ts";
import { providerKeyBinding, signInBinding } from "./sealing.ts";
import type { SealBinding } from "@ryph/sealed";
import type { KeyStore } from "../ports/key_store.ts";
import { OAuthError, type OpenAiAccounts, type TokenGrant } from "../ports/openai_accounts.ts";

/** How long a finished or abandoned sign-in stays readable before it is pruned. */
const SIGN_IN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** What an error from the browser may contribute to a message: OpenAI's text, cut short. */
const MAX_ERROR_TEXT = 300;
/**
 * How long a claimed sign-in may sit in `exchanging` before it reads as failed: what is left of
 * a completion that died midway (a restart, a crash). The work it covers is three calls to
 * OpenAI, each bounded at 15 s, and a few writes.
 */
const EXCHANGE_STALE_MS = 2 * 60 * 1000;
/**
 * A refused access token is refreshed only when the token set is older than this — unless the
 * refusal says the token is dead (`token_expired`, or past its expiry by our own reckoning): OpenAI
 * ends a token early on its side (a plan change does), and a refresh is the only thing that helps.
 * Any other 401 for a token just minted is not one a refresh fixes, and every refresh spends the
 * rotating refresh token: without the gap, a run that kept drawing 401s would rotate it once per
 * call. Read off the stored set's `savedAt`, so it holds across replicas.
 */
const FORCED_REFRESH_GAP_MS = 5 * 60 * 1000;
/** How many times a refreshed token set's write-back is tried before it is held in memory. */
const WRITE_BACK_ATTEMPTS = 3;
const WRITE_BACK_RETRY_MS = 200;
/** The secret an archived plan key keeps: nothing. The tokens are revoked or abandoned, and no
 * path reads an archived key's secret. */
const ARCHIVED_SECRET = "";

export interface PlanKeysDeps {
  store: KeyStore;
  accounts: OpenAiAccounts;
  /** Seals and unseals a key's token set, as every provider secret is (`provider-keys`). */
  seal(plaintext: string, binding: SealBinding): Promise<string>;
  unseal(sealed: string, binding: SealBinding): Promise<string>;
  /** Seals and unseals a sign-in's PKCE verifier (`chatgpt-sign-in-verifiers`). */
  sealVerifier(plaintext: string, binding: SealBinding): Promise<string>;
  unsealVerifier(sealed: string, binding: SealBinding): Promise<string>;
  now(): Date;
  diag: {
    debug(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
}

/** A refusal with the status its route answers. */
export interface PlanFailure {
  ok: false;
  status: 400 | 404 | 409 | 502;
  error: string;
}

export type SignInStatus =
  | { status: "pending" | "expired" }
  | { status: "done"; keyId: string }
  | { status: "failed"; error: string };

/** An access token the upstream just refused, and the error code it refused it with. */
export interface RejectedToken {
  token: string;
  code: string | null;
}

/** What the data plane gets for a key: a usable access token, or why there is none. */
export type AccessToken =
  | { ok: true; token: string }
  | { ok: false; reason: "needs_reauth" | "unavailable"; error: string };

export interface PlanKeys {
  /** This deployment's `ext_agent_host_id`, minted on first use. */
  agentHostId(): Promise<string>;
  /** Begins a sign-in: a new key, or `keyId` signed in again. */
  startSignIn(input: { label?: string; keyId?: string }): Promise<
    { ok: true; signIn: PlanSignIn; authorizeUrl: string } | PlanFailure
  >;
  signInStatus(id: string): Promise<SignInStatus | null>;
  /** Finishes a sign-in from the query the browser's return carried to the loopback listener,
   * found by the query's own state. */
  completeSignIn(query: URLSearchParams): Promise<{ ok: true; keyId: string } | PlanFailure>;
  /** The key's access token, refreshed first when it is near expiry — or, with `rejected`, when
   * that exact token was just refused upstream (at once when the refusal says it expired). */
  accessToken(key: ProviderKey, rejected?: RejectedToken): Promise<AccessToken>;
  markLimited(key: ProviderKey): Promise<void>;
  clearLimited(key: ProviderKey): Promise<void>;
  /** Re-reads the account's model list into the key. */
  refreshModels(keyId: string): Promise<{ ok: true; models: string[] } | PlanFailure>;
  /**
   * Signs the key out: its renewable session ended at OpenAI (best effort), its tokens dropped,
   * the key archived. `revoked` says whether OpenAI confirmed the end; false means the person
   * should disconnect ryph in ChatGPT's settings to be sure. Null for a key already archived.
   */
  archive(keyId: string): Promise<{ key: ProviderKey; revoked: boolean | null } | null>;
}

/** What a claimed sign-in got from OpenAI so far, for the cleanup if it throws: tokens no key
 * holds yet. */
interface Issued {
  grant: { clientId: string; grant: TokenGrant } | null;
}

const fail = (status: PlanFailure["status"], error: string): PlanFailure => ({
  ok: false,
  status,
  error,
});

/**
 * What a plan key's token set is bound to: the row's own id and provider. Only a `chatgpt-plan`
 * row has one: any other provider here (a row rewritten in the database) throws, and nothing is
 * opened or sealed for it.
 */
const planKeyBinding = (key: Pick<ProviderKey, "id" | "provider">): SealBinding => {
  if (key.provider !== CHATGPT_PLAN) {
    throw new Error(`provider key "${key.id}" is not a ChatGPT plan key`);
  }
  return providerKeyBinding(key, BUILTIN_PROVIDERS[CHATGPT_PLAN]);
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makePlanKeys(deps: PlanKeysDeps): PlanKeys {
  const { store, accounts } = deps;
  const nowIso = () => deps.now().toISOString();

  let hostId: Promise<string> | null = null;
  const agentHostId = (): Promise<string> => {
    hostId ??= store.claimAgentHostId(mintAgentHostId(), nowIso()).catch((err) => {
      hostId = null; // a database blip must not be cached as the answer
      throw err;
    });
    return hostId;
  };

  // ── the key's lock ────────────────────────────────────────────────────────────────────────

  /** Each key's queue in this process: the tail of the last `exclusive` call, never rejecting. */
  const queues = new Map<string, Promise<void>>();

  /** `fn` with the key to itself: after every earlier caller in this process, under the
   * database's lock across processes. Not re-entrant: `fn` never calls it again. */
  const exclusive = <T>(keyId: string, fn: () => Promise<T>): Promise<T> => {
    const turn = (queues.get(keyId) ?? Promise.resolve()).then(() =>
      store.withProviderKeyLock(keyId, fn)
    );
    const tail = turn.then(() => {}, () => {});
    queues.set(keyId, tail);
    void tail.then(() => {
      if (queues.get(keyId) === tail) queues.delete(keyId);
    });
    return turn;
  };

  // ── the token set ─────────────────────────────────────────────────────────────────────────

  /**
   * Token sets a refresh got that could not be written back yet, by key: `sealed` is meant to
   * replace `basis`, the secret the row held when it was refreshed. While the row still holds
   * `basis`, these ARE the key's tokens — its refresh token has rotated past the stored one.
   */
  const unsaved = new Map<string, { basis: string; sealed: string; tokens: PlanTokenSet }>();

  /** The key's current token set: a held-back one when the row is still its basis. */
  const tokensOf = async (key: ProviderKey): Promise<PlanTokenSet> => {
    const held = unsaved.get(key.id);
    if (held !== undefined) {
      if (key.encryptedSecret === held.basis) return held.tokens;
      // The row moved on: to this set (a write that landed after all) or past it.
      if (key.encryptedSecret === held.sealed) return held.tokens;
    }
    return parseTokenSet(await deps.unseal(key.encryptedSecret, planKeyBinding(key)));
  };

  /**
   * Writes a token set over the secret it was refreshed from, tried a few times. Never throws:
   * `written`, `superseded` (the row no longer holds `basis` — someone else wrote, and theirs
   * stands), or `held` (still unwritten; kept in memory and tried again under the next lock).
   */
  const writeBack = async (
    keyId: string,
    basis: string,
    tokens: PlanTokenSet,
    sealed: string,
  ): Promise<"written" | "superseded" | "held"> => {
    for (let attempt = 1; attempt <= WRITE_BACK_ATTEMPTS; attempt++) {
      try {
        const replaced = await store.replaceProviderKeySecret(keyId, basis, sealed, nowIso());
        if (replaced) {
          unsaved.delete(keyId);
          return "written";
        }
        const now = await store.getProviderKey(keyId);
        // A write that landed and whose answer was lost reads as superseded by itself.
        if (now?.encryptedSecret === sealed) {
          unsaved.delete(keyId);
          return "written";
        }
        unsaved.delete(keyId);
        deps.diag.warn("chatgpt_plan.write_back_superseded", { keyId });
        return "superseded";
      } catch (err) {
        deps.diag.warn("chatgpt_plan.write_back_failed", { keyId, attempt, err: errorText(err) });
        if (attempt < WRITE_BACK_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, WRITE_BACK_RETRY_MS * attempt));
        }
      }
    }
    unsaved.set(keyId, { basis, sealed, tokens });
    return "held";
  };

  /** A token response as the token set to seal. `previous` fills what a refresh leaves out. */
  const tokenSetOf = (
    clientId: string,
    grant: TokenGrant,
    previous: PlanTokenSet | null,
  ): PlanTokenSet | null => {
    const refreshToken = grant.refreshToken ?? previous?.refreshToken ?? null;
    if (refreshToken === null) return null;
    const at = deps.now();
    return {
      v: 1,
      clientId,
      accessToken: grant.accessToken,
      refreshToken,
      idToken: grant.idToken ?? previous?.idToken ?? null,
      accessExpiresAt: accessExpiryOf(grant, at.getTime()),
      earliestRefreshAt: grant.earliestRefreshAt,
      scopes: grant.scope === null ? previous?.scopes ?? [] : scopesOf(grant.scope),
      savedAt: at.toISOString(),
    };
  };

  const modelsFor = async (accessToken: string) => {
    try {
      return planModelsOf(await accounts.listModels(accessToken));
    } catch (err) {
      deps.diag.warn("chatgpt_plan.models_failed", { err: errorText(err) });
      return null;
    }
  };

  // ── sign-in ───────────────────────────────────────────────────────────────────────────────

  const startSignIn: PlanKeys["startSignIn"] = async ({ label, keyId }) => {
    let clientId: string | null = null;
    let idTokenHint: string | null = null;
    let loginHint: string | null = null;
    if (keyId !== undefined) {
      const key = await store.getProviderKey(keyId);
      if (key === null) return fail(404, "no such provider key");
      if (key.provider !== CHATGPT_PLAN || !key.plan) {
        return fail(400, "that key is not a ChatGPT plan key");
      }
      if (key.archivedAt !== null) return fail(400, "that provider key is archived");
      clientId = key.plan.clientId;
      loginHint = key.plan.email;
      try {
        idTokenHint = (await tokensOf(key)).idToken;
      } catch {
        // No hint: OpenAI shows the account picker, which is all a hint saves.
      }
    }

    const at = deps.now();
    const verifier = randomToken();
    const id = mintId("si");
    const signIn: PlanSignIn = {
      id,
      state: randomToken(),
      nonce: randomToken(),
      encryptedVerifier: await deps.sealVerifier(
        verifier,
        signInBinding({ id, clientId, redirectUri: REDIRECT_URI }),
      ),
      clientId,
      keyId: keyId ?? null,
      label: label ?? null,
      redirectUri: REDIRECT_URI,
      status: "pending",
      error: null,
      resultKeyId: null,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + SIGN_IN_TTL_MS).toISOString(),
      updatedAt: at.toISOString(),
    };
    await store.pruneSignIns(new Date(at.getTime() - SIGN_IN_RETENTION_MS).toISOString());
    await store.createSignIn(signIn);
    return {
      ok: true,
      signIn,
      authorizeUrl: authorizeUrl({
        clientId,
        agentHostId: await agentHostId(),
        state: signIn.state,
        nonce: signIn.nonce,
        challenge: await pkceChallenge(verifier),
        redirectUri: signIn.redirectUri,
        idTokenHint,
        loginHint,
      }),
    };
  };

  const signInStatus: PlanKeys["signInStatus"] = async (id) => {
    const row = await store.getSignIn(id);
    if (row === null) return null;
    if (row.status === "done" && row.resultKeyId !== null) {
      return { status: "done", keyId: row.resultKeyId };
    }
    if (row.status === "failed") return { status: "failed", error: row.error ?? "sign-in failed" };
    // A completion that died midway left its claim behind; nothing will finish it now.
    if (
      row.status === "exchanging" &&
      Date.parse(row.updatedAt) + EXCHANGE_STALE_MS <= deps.now().getTime()
    ) {
      return { status: "failed", error: "the sign-in was interrupted; start again" };
    }
    // An exchange in progress reads as pending, even past the expiry it beat.
    if (row.status === "pending" && row.expiresAt <= nowIso()) return { status: "expired" };
    return { status: "pending" };
  };

  /** Ends a claimed sign-in in failure, and says so. */
  const failed = async (
    signIn: PlanSignIn,
    error: string,
    status: PlanFailure["status"] = 400,
  ): Promise<PlanFailure> => {
    try {
      await store.finishSignIn(signIn.id, {
        status: "failed",
        error,
        resultKeyId: null,
        at: nowIso(),
      });
    } catch (err) {
      // The claim stays behind, and reads as failed once it is stale (`signInStatus`).
      deps.diag.warn("chatgpt_plan.sign_in_unrecorded", { signIn: signIn.id, err: errorText(err) });
    }
    deps.diag.debug("chatgpt_plan.sign_in_failed", { signIn: signIn.id, error });
    return fail(status, error);
  };

  /** The tokens just issued, ended at once: a sign-in that cannot use them must not leave a
   * live session behind at OpenAI. Best effort, and only for a first registration, whose client
   * is brand new. A re-sign-in's tokens are under the key's own client, where a revoke may end
   * every grant (see the re-sign-in below), so they are left to lapse like the session they
   * would have replaced. */
  const discard = (signIn: PlanSignIn, clientId: string, grant: TokenGrant) => {
    if (signIn.keyId !== null || signIn.clientId !== null) return;
    if (grant.refreshToken === null) return;
    accounts.revoke({ clientId, refreshToken: grant.refreshToken }).catch(() => {});
  };

  const completeSignIn: PlanKeys["completeSignIn"] = async (query) => {
    const params = callbackParams(query);
    // The state binds the browser's answer to THIS attempt: an answer with no state, or one no
    // attempt issued, finishes nothing.
    const found = params.state === null ? null : await store.getSignInByState(params.state);
    if (found === null) return fail(404, "no such sign-in");

    const signIn = await store.claimSignIn(found.id, nowIso());
    if (signIn === null) {
      // Already done (the browser's return arrived twice, and this one lost): the same answer.
      const current = await signInStatus(found.id);
      if (current?.status === "done") return { ok: true, keyId: current.keyId };
      if (current?.status === "failed") return fail(400, current.error);
      if (current?.status === "expired") return fail(400, "this sign-in expired; start again");
      return fail(409, "this sign-in is being finished already");
    }

    // From the claim on, the attempt ends done or failed whatever throws: a claim left behind
    // reads as pending to the app for minutes. Tokens issued before the throw are ended too.
    const issued: Issued = { grant: null };
    try {
      return await finishClaimed(signIn, params, issued);
    } catch (err) {
      deps.diag.warn("chatgpt_plan.sign_in_threw", { signIn: signIn.id, err: errorText(err) });
      if (issued.grant !== null) discard(signIn, issued.grant.clientId, issued.grant.grant);
      return await failed(signIn, "the sign-in could not be finished; start again", 502);
    }
  };

  /** The rest of a completion, once its claim is taken. Throws only on what it cannot help: the
   * database, the sealing. */
  const finishClaimed = async (
    signIn: PlanSignIn,
    params: ReturnType<typeof callbackParams>,
    issued: Issued,
  ): Promise<{ ok: true; keyId: string } | PlanFailure> => {
    if (params.error !== null) {
      const detail = params.errorDescription === null
        ? ""
        : `: ${params.errorDescription.slice(0, MAX_ERROR_TEXT)}`;
      return await failed(
        signIn,
        params.error === "access_denied"
          ? `ChatGPT sign-in was declined${detail}`
          : `OpenAI ended the sign-in with ${params.error.slice(0, 100)}${detail}`,
      );
    }
    if (params.code === null) return await failed(signIn, "the address carries no code");

    // Which client the code belongs to. A first registration learns it here; a re-sign-in
    // already knows it and refuses any other rather than re-pointing the key.
    let clientId: string;
    if (signIn.clientId !== null) {
      if (params.clientId !== null && params.clientId !== signIn.clientId) {
        return await failed(signIn, "OpenAI answered for a different client than this key's");
      }
      clientId = signIn.clientId;
    } else {
      if (params.clientId === null || params.clientId === DYNAMIC_CLIENT_ID) {
        return await failed(
          signIn,
          "OpenAI did not finish registering ryph (no client id came back)",
        );
      }
      clientId = params.clientId;
    }

    let grant: TokenGrant;
    try {
      grant = await accounts.exchangeCode({
        clientId,
        code: params.code,
        verifier: await deps.unsealVerifier(signIn.encryptedVerifier, signInBinding(signIn)),
        redirectUri: signIn.redirectUri,
      });
    } catch (err) {
      if (err instanceof OAuthError && err.transient) {
        // The code may still be good: put the attempt back so the same address can be tried
        // again while it lasts.
        await store.finishSignIn(signIn.id, {
          status: "pending",
          error: null,
          resultKeyId: null,
          at: nowIso(),
        });
        return fail(502, `${errorText(err)}; try again`);
      }
      return await failed(
        signIn,
        err instanceof OAuthError && err.code === "invalid_grant"
          ? "OpenAI refused the code (it may have been used or expired); start again"
          : errorText(err),
      );
    }

    issued.grant = { clientId, grant };
    if (grant.idToken === null) {
      discard(signIn, clientId, grant);
      return await failed(signIn, "OpenAI sent no ID token");
    }
    let identity;
    try {
      identity = await accounts.verifyIdToken(grant.idToken, { clientId, nonce: signIn.nonce });
    } catch (err) {
      discard(signIn, clientId, grant);
      return await failed(signIn, `the ID token did not verify: ${errorText(err)}`);
    }
    const scopes = scopesOf(grant.scope);
    if (!scopes.includes(PLAN_USE_SCOPE)) {
      discard(signIn, clientId, grant);
      return await failed(
        signIn,
        "ChatGPT plan use was not allowed for ryph; sign in again and allow it, or enable it " +
          "for this app in ChatGPT's settings",
      );
    }
    const tokens = tokenSetOf(clientId, grant, null);
    if (tokens === null) {
      discard(signIn, clientId, grant);
      return await failed(signIn, "OpenAI sent no refresh token (offline access was not granted)");
    }

    const models = await modelsFor(tokens.accessToken);
    const at = nowIso();
    // The key's id before the seal, which is bound to it: the re-signed key's own, or the new one.
    const keyId = signIn.keyId ?? mintId("pk");
    const encryptedSecret = await deps.seal(
      sealableTokens(tokens),
      planKeyBinding({ id: keyId, provider: CHATGPT_PLAN }),
    );

    if (signIn.keyId !== null) {
      // Under the key's lock and against the row as it stands then: a refresh running beside
      // this must not write its rotated tokens over the new ones, nor this over an archive.
      const replaced = await exclusive(signIn.keyId, async () => {
        const key = await store.getProviderKey(signIn.keyId!);
        if (
          key === null || key.archivedAt !== null || !key.plan || key.provider !== CHATGPT_PLAN
        ) {
          return { ok: false as const, error: "the key being signed in again is gone" };
        }
        if (key.plan.subject !== identity.sub) {
          return {
            ok: false as const,
            error: "that is a different ChatGPT account from this key's; sign in as " +
              (key.plan.email ?? "the account the key was made with") + ", or add a new key",
          };
        }
        // The secret first and the state with it, so `active` never stands beside a dead token.
        await store.updateProviderKey(key.id, {
          encryptedSecret,
          plan: {
            ...key.plan,
            email: identity.email ?? key.plan.email,
            planType: identity.planType ?? key.plan.planType,
            scopes,
            ...(models === null ? {} : { models, modelsFetchedAt: at }),
          },
          planStatus: "active",
          planLimitedAt: null,
          updatedAt: at,
        });
        unsaved.delete(key.id);
        return { ok: true as const, keyId: key.id };
      });
      if (!replaced.ok) {
        discard(signIn, clientId, grant);
        return await failed(signIn, replaced.error);
      }
      issued.grant = null; // the key holds them now
      // The session this replaces is NOT revoked here. OpenAI's docs say revocation ends "the
      // renewable session" without saying whether that is one grant or every grant for the
      // issued client, which a re-sign-in shares, so a revoke could sign the new session out too.
      // The old refresh token is simply dropped and lapses within thirty days.
      await store.finishSignIn(signIn.id, {
        status: "done",
        error: null,
        resultKeyId: replaced.keyId,
        at,
      });
      return { ok: true, keyId: replaced.keyId };
    }

    const key: ProviderKey = {
      id: keyId,
      provider: CHATGPT_PLAN,
      // Not the email: every signed-in user reads labels, and only admins read the account.
      label: signIn.label ?? "ChatGPT plan",
      // There is no pasted secret to show four characters of.
      last4: "",
      encryptedSecret,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
      plan: {
        clientId,
        subject: identity.sub,
        email: identity.email,
        planType: identity.planType,
        scopes,
        models: models ?? [],
        modelsFetchedAt: models === null ? null : at,
      },
      planStatus: "active",
      planLimitedAt: null,
    };
    await store.createProviderKey(key);
    issued.grant = null; // the key holds them now
    await store.finishSignIn(signIn.id, { status: "done", error: null, resultKeyId: key.id, at });
    deps.diag.debug("chatgpt_plan.signed_in", { keyId: key.id, signIn: signIn.id });
    return { ok: true, keyId: key.id };
  };

  // ── tokens ────────────────────────────────────────────────────────────────────────────────

  const inFlight = new Map<string, Promise<AccessToken>>();

  /** The refresh itself, under the key's lock, deciding again from the row as it now stands. */
  const refreshLocked = (keyId: string, rejected: RejectedToken | undefined) =>
    exclusive(keyId, async (): Promise<AccessToken> => {
      const found = await store.getProviderKey(keyId);
      if (found === null || found.archivedAt !== null) {
        unsaved.delete(keyId);
        return { ok: false, reason: "needs_reauth", error: "the ChatGPT plan key was archived" };
      }
      if (found.planStatus === "needs_reauth") {
        return {
          ok: false,
          reason: "needs_reauth",
          error: "the ChatGPT plan key needs signing in again",
        };
      }
      // A token set an earlier refresh could not write back is written now, before anything
      // else spends it.
      let key = found;
      const held = unsaved.get(keyId);
      if (held !== undefined) {
        if (key.encryptedSecret === held.basis) {
          await writeBack(keyId, held.basis, held.tokens, held.sealed);
          // As the row now stands: the held set written, or still held over the same row.
          key = await store.getProviderKey(keyId) ?? key;
        } else if (key.encryptedSecret !== held.sealed) unsaved.delete(keyId);
      }
      const tokens = await tokensOf(key);
      const nowMs = deps.now().getTime();
      // Why this refresh runs, for the log: due, or which refusal forced it.
      let why: string;
      if (rejected === undefined) {
        if (!refreshDue(tokens, nowMs)) return { ok: true, token: tokens.accessToken };
        why = "due";
      } else {
        // Another caller — in this process or another — refreshed while this one waited.
        if (tokens.accessToken !== rejected.token) {
          deps.diag.debug("chatgpt_plan.rejected_already_refreshed", { keyId });
          return { ok: true, token: tokens.accessToken };
        }
        // A token OpenAI says has expired, or that is past its expiry anyway, is dead: refreshed
        // now, whatever the throttles below say (still one refresh at a time, under the lock).
        const dead = rejected.code === TOKEN_EXPIRED_CODE
          ? "token_expired"
          : accessExpired(tokens, nowMs)
          ? "past_expiry"
          : null;
        if (dead === null) {
          // Any other refusal is replaced only once OpenAI allows it, and not again soon after
          // the token was minted; until then the rejection stands, and refreshing anyway would
          // spend the rotating refresh token on nothing.
          const denied = refreshTooEarly(tokens, nowMs)
            ? "earliest_refresh_at"
            : nowMs - Date.parse(tokens.savedAt) < FORCED_REFRESH_GAP_MS
            ? "minted_recently"
            : null;
          if (denied !== null) {
            deps.diag.warn("chatgpt_plan.rejected_refresh_denied", {
              keyId,
              code: rejected.code,
              reason: denied,
              savedAt: tokens.savedAt,
              earliestRefreshAt: tokens.earliestRefreshAt,
            });
            return { ok: true, token: tokens.accessToken };
          }
        }
        why = dead ?? "rejected";
        deps.diag.warn("chatgpt_plan.rejected_refreshing", {
          keyId,
          code: rejected.code,
          reason: why,
          accessExpiresAt: tokens.accessExpiresAt,
        });
      }

      let grant: TokenGrant;
      try {
        grant = await accounts.refresh({
          clientId: tokens.clientId,
          refreshToken: tokens.refreshToken,
        });
      } catch (err) {
        const code = err instanceof OAuthError ? err.code : null;
        // A 401 from the token endpoint is final whatever its code says, as it is for Codex.
        if (
          err instanceof OAuthError && !err.transient &&
          (refreshTokenUnusable(code) || err.status === 401)
        ) {
          await store.updateProviderKey(keyId, {
            planStatus: "needs_reauth",
            updatedAt: nowIso(),
          });
          deps.diag.warn("chatgpt_plan.needs_reauth", { keyId, code });
          return {
            ok: false,
            reason: "needs_reauth",
            error: "the ChatGPT plan key's session ended; an admin signs it in again under " +
              "Model keys",
          };
        }
        deps.diag.warn("chatgpt_plan.refresh_failed", { keyId, why, err: errorText(err) });
        // OAuthError messages carry no token: what OpenAI answered, or that it was not reached.
        return {
          ok: false,
          reason: "unavailable",
          error: `could not refresh the ChatGPT sign-in (${errorText(err)}); try again shortly`,
        };
      }
      const next = tokenSetOf(tokens.clientId, grant, tokens);
      if (next === null) {
        return { ok: false, reason: "unavailable", error: "OpenAI's refresh carried no token" };
      }
      if (next.accessToken === tokens.accessToken) {
        deps.diag.warn("chatgpt_plan.refresh_same_token", { keyId, why });
      }
      // Access token, expiry, scopes and the rotated refresh token, together, in one write, over
      // the secret this refreshed from. Held in memory when it cannot land: the call still gets
      // its token, and the next lock writes it.
      const written = await writeBack(
        keyId,
        key.encryptedSecret,
        next,
        await deps.seal(sealableTokens(next), planKeyBinding(key)),
      );
      deps.diag.debug("chatgpt_plan.refreshed", {
        keyId,
        why,
        written,
        accessExpiresAt: next.accessExpiresAt,
      });
      return { ok: true, token: next.accessToken };
    });

  const accessToken: PlanKeys["accessToken"] = async (key, rejected) => {
    if (key.planStatus === "needs_reauth") {
      return {
        ok: false,
        reason: "needs_reauth",
        error: "the ChatGPT plan key needs signing in again",
      };
    }
    let tokens: PlanTokenSet;
    try {
      tokens = await tokensOf(key);
    } catch (err) {
      // Not a blip: a token set that does not open (bound to another row, or not in the current format) stays
      // that way until someone signs the key in again.
      deps.diag.warn("chatgpt_plan.unreadable_tokens", { keyId: key.id, err: errorText(err) });
      // Recorded, so the key reads `needs_reauth` rather than `active`. Only for a `v2` value:
      // one bound to another row never opens, while anything else already reads `needs_reauth`
      // (see `toPublicProviderKey`).
      if (holdsCurrentSealed(key.encryptedSecret)) {
        // Only over the value found unreadable: a sign-in that landed since stays active.
        await store.markPlanNeedsReauth(key.id, key.encryptedSecret, nowIso())
          .catch((writeErr) =>
            deps.diag.warn("chatgpt_plan.status_write_failed", {
              keyId: key.id,
              err: errorText(writeErr),
            })
          );
      }
      return {
        ok: false,
        reason: "needs_reauth",
        error: "the ChatGPT plan key's stored sign-in cannot be read; an admin signs it in " +
          "again under Model keys",
      };
    }
    if (rejected === undefined && !refreshDue(tokens, deps.now().getTime())) {
      return { ok: true, token: tokens.accessToken };
    }
    // Every caller that finds the token due waits on the one refresh already running.
    const running = inFlight.get(key.id);
    if (running !== undefined) return await running;
    const refresh = refreshLocked(key.id, rejected).catch((err): AccessToken => {
      deps.diag.warn("chatgpt_plan.refresh_failed", { keyId: key.id, err: errorText(err) });
      return { ok: false, reason: "unavailable", error: "could not refresh the ChatGPT sign-in" };
    }).finally(() => inFlight.delete(key.id));
    inFlight.set(key.id, refresh);
    return await refresh;
  };

  // The marks are conditional writes as well as locked ones: the row they read came from the
  // start of the call, and by its end a refresh may have found the key `needs_reauth`.
  const markLimited: PlanKeys["markLimited"] = async (key) => {
    // Already limited as the call found it: parallel 429s queue no lock round trips, and the
    // first one's time stands.
    if (key.planStatus === "needs_reauth" || key.planStatus === "limited") return;
    const marked = await exclusive(key.id, () => store.markPlanLimited(key.id, nowIso()));
    if (marked) deps.diag.warn("chatgpt_plan.limited", { keyId: key.id });
  };

  const clearLimited: PlanKeys["clearLimited"] = async (key) => {
    if (key.planStatus !== "limited") return;
    await exclusive(key.id, () => store.clearPlanLimited(key.id, nowIso()));
  };

  const refreshModels: PlanKeys["refreshModels"] = async (keyId) => {
    const key = await store.getProviderKey(keyId);
    if (key === null) return fail(404, "no such provider key");
    if (key.provider !== CHATGPT_PLAN || !key.plan) {
      return fail(400, "that key is not a ChatGPT plan key");
    }
    if (key.archivedAt !== null) return fail(400, "that provider key is archived");
    const token = await accessToken(key);
    if (!token.ok) return fail(token.reason === "needs_reauth" ? 409 : 502, token.error);
    let models;
    try {
      models = planModelsOf(await accounts.listModels(token.token));
    } catch (err) {
      return fail(502, errorText(err));
    }
    // Over the registration as it stands under the lock: a re-sign-in beside this writes it too.
    await exclusive(keyId, async () => {
      const latest = await store.getProviderKey(keyId);
      if (!latest?.plan || latest.archivedAt !== null) return;
      const at = nowIso();
      await store.updateProviderKey(keyId, {
        plan: { ...latest.plan, models, modelsFetchedAt: at },
        updatedAt: at,
      });
    });
    return { ok: true, models: models.map((model) => model.id) };
  };

  /** Ends the token set's renewable session at OpenAI; true when OpenAI confirmed it. Twice at
   * most: a network failure or a 5xx is worth one more try. Never throws. */
  const revokeTokens = async (keyId: string, tokens: PlanTokenSet): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await accounts.revoke({ clientId: tokens.clientId, refreshToken: tokens.refreshToken });
        return true;
      } catch (err) {
        deps.diag.warn("chatgpt_plan.revoke_failed", { keyId, err: errorText(err) });
      }
    }
    return false;
  };

  const archive: PlanKeys["archive"] = (keyId) =>
    // Under the lock, so the token revoked is the newest: a refresh finishing just before would
    // otherwise leave its rotated session live at OpenAI with nothing holding it.
    exclusive(keyId, async () => {
      const key = await store.getProviderKey(keyId);
      if (key === null) return null;
      if (key.archivedAt !== null) return { key, revoked: null };
      let tokens: PlanTokenSet | null = null;
      try {
        tokens = await tokensOf(key);
      } catch (err) {
        deps.diag.warn("chatgpt_plan.unreadable_tokens", { keyId, err: errorText(err) });
      }
      const revoked = tokens === null ? false : await revokeTokens(keyId, tokens);
      // Archived whatever OpenAI answered: archiving is the kill switch here. The tokens go with
      // it, so nothing on this side can spend the session if the revocation did not land.
      const at = nowIso();
      const archived = await store.updateProviderKey(keyId, {
        archivedAt: at,
        encryptedSecret: ARCHIVED_SECRET,
        updatedAt: at,
      });
      unsaved.delete(keyId);
      return {
        key: archived ??
          { ...key, archivedAt: at, encryptedSecret: ARCHIVED_SECRET, updatedAt: at },
        revoked,
      };
    });

  return {
    agentHostId,
    startSignIn,
    signInStatus,
    completeSignIn,
    accessToken,
    markLimited,
    clearLimited,
    refreshModels,
    archive,
  };
}
