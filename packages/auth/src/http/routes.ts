// The auth HTTP surface, as a mountable route list.
// The Route shape is @ryph/shared's, so the default deployment spreads these into the host's
// route table; the standalone composition root (main.ts) serves the same list alone.

import {
  json,
  parseBody as parseJsonBody,
  type Route,
  route,
  type Schema,
} from "@ryph/shared/http";
import { isLoopbackHost } from "@ryph/shared/net";

// Small identity documents, with room for WebAuthn attestation certificate chains.
export const AUTH_BODY_LIMIT = 256 * 1024;
import type { AuthService, ResetLinkOutcome, VerificationLinkOutcome } from "../core/service.ts";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Claims, SessionMeta } from "../core/types.ts";
import {
  can,
  type Capability,
  forbidden,
  mayGrant,
  type Role,
  SESSION_ONLY_CAPABILITIES,
} from "../core/capabilities.ts";
import type { Verifier } from "../core/verify.ts";
import {
  AcceptInviteSchema,
  ChangePasswordSchema,
  CreateApiTokenSchema,
  CreateInviteSchema,
  CreateUserSchema,
  ExchangeApiTokenSchema,
  ForgotPasswordSchema,
  inviteToken,
  LinkIdentityProofSchema,
  linkToken,
  LoginLinkSchema,
  LoginSchema,
  OAuthCallbackSchema,
  PasskeyLoginSchema,
  PasskeyRegisterSchema,
  providerParam,
  RefreshSchema,
  RenamePasskeySchema,
  ResetPasswordSchema,
  UpdateProfileSchema,
  UpdateSettingsSchema,
  UpdateUserSchema,
  VerifyEmailSchema,
} from "../schema.ts";
import { bearerToken, sha256Hex, timingSafeEqual } from "@ryph/sealed";
import { failureWindow } from "./failure_window.ts";

/** Every auth body is a handful of fields; a passkey response is the largest. */
const parseBody = <T>(req: Request, schema: Schema<T>) =>
  parseJsonBody(req, schema, { maxBytes: AUTH_BODY_LIMIT });

/** The header the app's server puts its proxy secret on, beside the client facts it vouches for. */
export const PROXY_SECRET_HEADER = "x-ryph-proxy-secret";

/**
 * Whether `presented` is the secret behind `digest`, compared as digests in constant time. The
 * caller hashes its configured secret once and passes the digest, not the secret.
 */
async function secretMatches(presented: string | null, digest: Promise<string>): Promise<boolean> {
  if (presented === null) return false;
  return timingSafeEqual(await sha256Hex(presented), await digest);
}

/**
 * The network a client address stands for in a budget: an IPv4 address as is, an IPv6 address
 * by its /64. One subscriber is handed a whole /64, so keying on the full address would give a
 * caller a fresh budget per address it rotates to. Anything that does not parse is kept whole.
 */
function budgetNetwork(address: string): string {
  const a = address.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, "").replace(/%.*$/, "");
  if (!a.includes(":")) return a;
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const groups = halves.length === 1
    ? head
    : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

export interface AuthRoutesDeps {
  service: AuthService;
  verifier: Verifier;
  now(): Date;
  /** Failed-attempt budget per key (an email, or a client address) per window. */
  loginRateLimit?: { attempts: number; windowMs: number; maxEntries?: number };
  /**
   * The secret the app's server presents (on `x-ryph-proxy-secret`) when it vouches for who is
   * calling. Set, `x-client-ip` and `x-client-user-agent` count only beside it, so a caller that
   * reaches this listener directly — a run, anything else on the machine — cannot pick its own
   * address to dodge a budget. Null or unset: the headers are trusted as sent, which is right
   * only where nothing but the app can reach this listener.
   */
  proxySecret?: string | null;
  /**
   * The secret a local `ryph login` presents to mint a login link. Null or unset: the route
   * does not exist. Only the single-user binary sets one.
   */
  localLoginSecret?: string | null;
}

export function authRoutes(deps: AuthRoutesDeps): Route[] {
  const { service, verifier } = deps;
  const limit = deps.loginRateLimit ?? { attempts: 10, windowMs: 15 * 60 * 1000 };
  // Each configured secret is hashed once, here, and every request compares against the digest.
  const proxySecretDigest = deps.proxySecret == null ? null : sha256Hex(deps.proxySecret);
  const localLoginSecretDigest = deps.localLoginSecret == null
    ? null
    : sha256Hex(deps.localLoginSecret);

  /** Whether the client facts on this request come from the app's server. */
  const vouched = async (req: Request): Promise<boolean> =>
    proxySecretDigest === null ||
    await secretMatches(req.headers.get(PROXY_SECRET_HEADER), proxySecretDigest);

  /**
   * The client facts a session records. The IP is whatever the trusted front (the BFF) says it
   * is, on a header of its own — `x-forwarded-for` is a chain any hop can append to — and only
   * when the front proved it is the one saying so.
   */
  const sessionMeta = async (req: Request): Promise<SessionMeta> => {
    const trusted = await vouched(req);
    return {
      userAgent: (trusted ? req.headers.get("x-client-user-agent") : null) ??
        req.headers.get("user-agent"),
      ip: trusted ? req.headers.get("x-client-ip") : null,
    };
  };

  // Per-process failed-attempt window: login is keyed on the client address alone, the mailing
  // flows on the address and the email. It forgets after windowMs, and drops expired keys as new
  // ones arrive so a spray of distinct keys cannot grow it without bound. Per process, so N
  // control-plane replicas allow N times the attempts; a shared store can back this when a
  // multi-replica deployment exists to need it.
  //
  // A budget goes only where something can be guessed (a password) or where each call costs
  // something (a mail). A link token, an invite token or a login link is a 256-bit random secret
  // and a passkey assertion is a signature, so a budget slows no real guessing there; it is only
  // a lever. A run on Docker Desktop or OrbStack reaches the app over loopback, which the app
  // vouches as the owner's own address, so ten bad attempts from it would lock the owner out of
  // every route keyed on that address. Those routes take no budget, and login takes none from a
  // vouched loopback address.
  //
  // Budgets keyed on a client address and budgets keyed on an email live in separate windows.
  // Any caller can name as many emails as it likes, so a shared cap would let one flood the
  // email keys until its own address budget was evicted and it had fresh guesses.
  const byAddress = failureWindow({ ...limit, now: deps.now });
  const byEmail = failureWindow({ ...limit, now: deps.now });
  /** The budget key for an anonymous flow: the surface plus whoever the front says is calling.
   * A caller the front did not vouch for shares one budget with every other such caller. */
  const addressKey = (surface: string, meta: SessionMeta): string =>
    `${surface}:${meta.ip === null ? "unknown" : budgetNetwork(meta.ip)}`;
  const tooMany = () => json(429, { error: "too many attempts, try again later" });

  const claimsOf = async (req: Request): Promise<Claims | null> => {
    const token = bearerToken(req);
    return token === null ? null : await verifier.verify(token);
  };
  const unauthorized = () => json(401, { error: "unauthorized" });
  /** What every act that would add or re-role another person answers on a single-user instance. */
  const singleUser = () =>
    json(403, { error: "this instance has a single user", code: "single_user" });
  const refuseUnless = (claims: Claims, capability: Capability): Response | null =>
    can(claims, capability) ? null : json(403, forbidden(capability));
  const unverified = () => json(403, { error: "verify your email address first" });
  /**
   * The gate on the account itself: sessions, passkeys, identities, the password, the tokens.
   * An API token is a narrowed credential and never reaches those, whatever capabilities it
   * carries; otherwise a token minted to read tasks could set a new password and sign in whole.
   */
  const sessionOnly = (claims: Claims): Response | null =>
    claims.via === "session" ? null : json(403, {
      error: "this needs a signed-in session, not an API token",
      code: "session_required",
    });
  /**
   * The stricter gate for anything that changes how a person signs in, and for every admin act:
   * the token must say the address is proven, must come from a session, and that session must
   * still exist. A token minted before an account was disowned satisfies none of it, and a
   * demoted or deactivated admin's token loses its session with the demotion.
   */
  const liveClaimsOf = async (req: Request): Promise<Claims | Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    if (!claims.emailVerified) return unverified();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    if (!await service.credentialAlive(claims)) return unauthorized();
    return claims;
  };

  const login = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, LoginSchema);
    if (!body.ok) return body.res;
    const email = body.data.email.toLowerCase();
    // Keyed on the caller, never the account, so a stranger cannot lock someone out of signing in
    // by guessing at their address. A success does not reset it: an attacker holding one account
    // could otherwise sign in between guesses at the others.
    const meta = await sessionMeta(req);
    const budget = meta.ip !== null && isLoopbackHost(meta.ip) ? null : addressKey("login", meta);
    if (budget !== null && byAddress.isLimited(budget)) return tooMany();

    const outcome = await service.login(email, body.data.password, meta);
    if (!outcome.ok) {
      if (budget !== null) byAddress.recordFailure(budget);
      return json(401, { error: "invalid credentials" });
    }
    return json(200, outcome.tokens);
  };

  const refresh = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, RefreshSchema);
    if (!body.ok) return body.res;
    const outcome = await service.refresh(body.data.refreshToken, await sessionMeta(req));
    if (!outcome.ok) return json(401, { error: "invalid refresh token" });
    return json(200, outcome.tokens);
  };

  const logout = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, RefreshSchema);
    if (!body.ok) return body.res;
    await service.logout(body.data.refreshToken);
    return json(200, { ok: true });
  };

  // The one read that also answers "is this session still there?": a front that asks it on
  // every page load signs a person out the moment their session was ended elsewhere, instead
  // of when their access token happens to expire.
  const me = async (req: Request): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    if (!await service.credentialAlive(claims)) return unauthorized();
    const user = await service.getUser(claims.sub);
    if (!user) return unauthorized();
    return json(200, user);
  };

  const createUser = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, CreateUserSchema);
    if (!body.ok) return body.res;
    // Every call may send a mail, so every call spends budget — per address and per caller.
    // Not per address while the instance is unclaimed: then nothing is mailed, the setup token
    // is the gate, and a stranger who knows the operator's address could otherwise spend its
    // budget and keep the operator's real claim at 429.
    const addressBudget = addressKey("register", await sessionMeta(req));
    const emailBudget = await service.needsBootstrap()
      ? null
      : `register:${body.data.email.toLowerCase()}`;
    if (byAddress.isLimited(addressBudget)) return tooMany();
    if (emailBudget !== null && byEmail.isLimited(emailBudget)) return tooMany();
    byAddress.recordFailure(addressBudget);
    if (emailBudget !== null) byEmail.recordFailure(emailBudget);
    const outcome = await service.createUser(body.data);
    if (!outcome.ok) {
      switch (outcome.error) {
        case "incomplete":
          return json(400, { error: "name and password: required" });
        case "single-user":
          return singleUser();
        case "setup-token":
          return json(403, {
            error: "the setup token is missing or wrong — it is in the control plane's log",
            code: "setup_token",
          });
        case "registration-closed":
          return json(403, { error: "registration is closed — ask an admin for an invite" });
      }
    }
    // Open registration answers the same whether or not the address was already taken.
    if (outcome.user === null || !outcome.bootstrapped) return json(202, { ok: true });
    return json(201, outcome.user);
  };

  // ---- verification and password reset -----------------------------------------------------

  /** No failure budget: the link's token is a 256-bit random secret (see the note on budgets). */
  const verifyEmail = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const meta = await sessionMeta(req);
    const token = linkToken.safeParse(params.token);
    if (!token.success) return json(410, { error: "this link is no longer valid" });
    const body = await parseBody(req, VerifyEmailSchema);
    if (!body.ok) return body.res;
    const outcome = await service.verifyEmail(token.data, body.data, meta);
    if (!outcome.ok) return json(410, { error: "this link is no longer valid" });
    return json(200, outcome.tokens);
  };

  const forgotPassword = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, ForgotPasswordSchema);
    if (!body.ok) return body.res;
    // Its own budget, apart from login's: a stranger asking on someone's behalf must not lock
    // that someone out of signing in.
    const key = `forgot:${body.data.email.toLowerCase()}`;
    if (byEmail.isLimited(key)) return tooMany();
    byEmail.recordFailure(key);
    await service.forgotPassword(body.data.email.toLowerCase());
    return json(202, { ok: true });
  };

  /** No failure budget: the link's token is a 256-bit random secret (see the note on budgets). */
  const resetPassword = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const token = linkToken.safeParse(params.token);
    if (!token.success) return json(410, { error: "this link is no longer valid" });
    const body = await parseBody(req, ResetPasswordSchema);
    if (!body.ok) return body.res;
    const outcome = await service.resetPassword(token.data, body.data.password);
    if (!outcome.ok) return json(410, { error: "this link is no longer valid" });
    return json(200, { ok: true });
  };

  const adminLink =
    (mint: (userId: string) => Promise<ResetLinkOutcome | VerificationLinkOutcome>) =>
    async (req: Request, params: Record<string, string>): Promise<Response> => {
      const claims = await liveClaimsOf(req);
      if (claims instanceof Response) return claims;
      const refused = refuseUnless(claims, "users:manage");
      if (refused) return refused;
      const outcome = await mint(params.id);
      if (outcome.ok) return json(201, { link: outcome.link });
      if (outcome.error === "not-found") return json(404, { error: "no such user" });
      if (outcome.error === "owner") {
        return json(403, { error: "an owner changes their password signed in, not by link" });
      }
      if (outcome.error === "no-address") {
        return json(409, { error: "that account has no address a password could sign in with" });
      }
      if (outcome.error === "already-verified") {
        return json(409, { error: "that address is already verified" });
      }
      return json(503, { error: "RYPH_APP_URL is not set, so no link can be built" });
    };

  const listResetRequests = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    return json(200, { users: await service.listResetRequests() });
  };

  // ---- invites -----------------------------------------------------------------------------

  const createInvite = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    const body = await parseBody(req, CreateInviteSchema);
    if (!body.ok) return body.res;
    if (!mayGrant(claims, body.data.role)) return notGrantable(body.data.role);
    const outcome = await service.createInvite(body.data, claims.sub);
    if (!outcome.ok) {
      return outcome.error === "single-user"
        ? singleUser()
        : json(409, { error: "that address already has an account" });
    }
    return json(201, { invite: outcome.invite, token: outcome.token });
  };

  const listInvites = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    return json(200, { invites: await service.listInvites() });
  };

  const revokeInvite = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    await service.revokeInvite(params.id);
    return json(200, { ok: true });
  };

  /** Unauthenticated: the person holding the link is exactly who has no account yet. */
  const previewInvite = async (
    _req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const token = inviteToken.safeParse(params.token);
    const preview = token.success ? await service.previewInvite(token.data) : null;
    if (!preview) return json(404, { error: "no such invite" });
    return json(200, preview);
  };

  /**
   * No failure budget on the caller: the invite token is a 256-bit random secret (see the note
   * on budgets). An acceptance may send a mail, though, so it spends the email's budget like a
   * sign-up does.
   */
  const acceptInvite = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const meta = await sessionMeta(req);
    const token = inviteToken.safeParse(params.token);
    if (!token.success) return json(404, { error: "no such invite" });
    const body = await parseBody(req, AcceptInviteSchema);
    if (!body.ok) return body.res;
    const emailBudget = body.data.email === null
      ? null
      : `register:${body.data.email.toLowerCase()}`;
    if (emailBudget !== null && byEmail.isLimited(emailBudget)) return tooMany();
    if (emailBudget !== null) byEmail.recordFailure(emailBudget);
    const outcome = await service.acceptInvite(token.data, body.data, meta);
    if (outcome.ok) {
      return outcome.tokens === null ? json(202, { ok: true }) : json(200, outcome.tokens);
    }
    switch (outcome.error) {
      case "invalid-invite":
        return json(410, { error: "this invite is no longer valid" });
      case "email-required":
        return json(400, { error: "email: required" });
      case "incomplete":
        return json(400, { error: "name and password: required" });
      case "email-taken":
        return json(409, { error: "that address already has an account — sign in instead" });
      case "single-user":
        return singleUser();
    }
  };

  // ---- users, as an admin manages them ----------------------------------------------------

  const listUsers = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    return json(200, { users: await service.listUsers() });
  };

  const updateUser = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "users:manage");
    if (refused) return refused;
    const body = await parseBody(req, UpdateUserSchema);
    if (!body.ok) return body.res;

    let user = await service.getUser(params.id);
    if (!user) return json(404, { error: "no such user" });
    if (body.data.role !== undefined) {
      if (!mayGrant(claims, body.data.role)) return notGrantable(body.data.role);
      const outcome = await service.setRole(params.id, body.data.role);
      if (!outcome.ok) return refuseUpdate(outcome.error);
      user = outcome.user;
    }
    if (body.data.status !== undefined) {
      const outcome = await service.setStatus(params.id, body.data.status);
      if (!outcome.ok) return refuseUpdate(outcome.error);
      user = outcome.user;
    }
    return json(200, user);
  };

  const refuseUpdate = (error: "not-found" | "last-owner" | "single-user"): Response =>
    error === "not-found"
      ? json(404, { error: "no such user" })
      : error === "single-user"
      ? singleUser()
      : json(409, { error: "the last owner cannot be demoted, deactivated, or deleted" });

  /** Nobody hands out more than they hold: a role is grantable only from within its caller's. */
  const notGrantable = (role: Role): Response =>
    json(403, forbidden("users:manage", `granting ${role}, which bundles more than you hold,`));

  const deleteUser = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    if (claims.sub !== params.id) {
      const refused = refuseUnless(claims, "users:manage");
      if (refused) return refused;
    }
    const outcome = await service.deleteUser(params.id);
    if (!outcome.ok) return refuseUpdate(outcome.error);
    return json(200, { ok: true });
  };

  // ---- the signed-in user's own account ----------------------------------------------------

  const changePassword = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const body = await parseBody(req, ChangePasswordSchema);
    if (!body.ok) return body.res;
    const outcome = await service.changePassword(
      claims.sub,
      body.data.currentPassword ?? null,
      body.data.newPassword,
    );
    if (!outcome.ok) {
      if (outcome.error === "not-found") return unauthorized();
      return json(401, { error: "current password does not match" });
    }
    return json(200, { ok: true });
  };

  const listSessions = async (req: Request): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    return json(200, { sessions: await service.listSessions(claims.sub), current: claims.sid });
  };

  const revokeSession = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    await service.revokeSession(claims.sub, params.id);
    return json(200, { ok: true });
  };

  const revokeAllSessions = async (req: Request): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    if (!await service.credentialAlive(claims)) return unauthorized();
    await service.revokeAllSessions(claims.sub);
    return json(200, { ok: true });
  };

  const listIdentities = async (req: Request): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    return json(200, { identities: await service.listIdentities(claims.sub) });
  };

  const unlinkIdentity = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const provider = providerParam.safeParse(params.provider);
    if (!provider.success) return json(404, { error: "no such identity" });
    const outcome = await service.unlinkIdentity(claims.sub, provider.data);
    if (!outcome.ok) {
      if (outcome.error === "not-found") return json(404, { error: "no such identity" });
      return json(409, { error: "set a password before unlinking your only sign-in method" });
    }
    return json(200, { ok: true });
  };

  /**
   * Linking an identity on a provider with no OAuth, part one: a nonce and the line to run.
   *
   * Radicle has no authorization server and no accounts — what it has is that every key can
   * sign. So the proof is a signature over something WE chose, in a namespace that is ours,
   * spendable once: the nonce stops a signature made yesterday from being replayed today, the
   * namespace stops one made for another tool from counting here, and single-use stops one seen
   * in transit from being spent twice.
   */
  const identityChallenge = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const provider = providerParam.safeParse(params.provider);
    if (!provider.success) return json(404, { error: "no such provider" });
    const outcome = await service.mintIdentityChallenge(claims.sub, provider.data);
    if (outcome.ok) return json(201, outcome.challenge);
    switch (outcome.error) {
      case "no-provider":
        return json(404, { error: "no such provider" });
      case "not-found":
        return unauthorized();
      case "unverified":
        return unverified();
    }
  };

  /** Part two: the signature, checked against the key the subject itself names. */
  const linkIdentityByProof = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const provider = providerParam.safeParse(params.provider);
    if (!provider.success) return json(404, { error: "no such provider" });
    const body = await parseBody(req, LinkIdentityProofSchema);
    if (!body.ok) return body.res;
    const outcome = await service.linkProviderByProof(claims.sub, provider.data, body.data);
    if (outcome.ok) return json(200, outcome.identity);
    switch (outcome.error) {
      case "no-provider":
        return json(404, { error: "no such provider" });
      case "not-found":
        return unauthorized();
      case "unverified":
        return unverified();
      case "linked-elsewhere":
        return json(409, { error: "that account is already linked to another user" });
      case "bad-proof":
        // Unparseable, wrong key, wrong namespace, wrong nonce, expired, already spent — one
        // answer for all of them. Saying which would tell a prober where to aim.
        return json(400, { error: "bad_signature" });
    }
  };

  // ---- sign-in and linking through a provider ----------------------------------------------

  const listProviders = (): Response => json(200, { providers: service.providers() });

  /**
   * One route, two intents told apart by the bearer: with one, the account links to the caller;
   * without, it signs in — or registers, when a gate admits. The intent rides the token rather
   * than the body so a stolen callback cannot be replayed as the other.
   */
  const oauthCallback = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const provider = providerParam.safeParse(params.provider);
    if (!provider.success) return json(404, { error: "no such provider" });
    const body = await parseBody(req, OAuthCallbackSchema);
    if (!body.ok) return body.res;
    const claims = bearerToken(req) === null ? null : await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    // What the authorize leg pinned, for the provider to check again on its token leg.
    const leg = {
      redirectUri: body.data.redirectUri ?? null,
      codeVerifier: body.data.codeVerifier ?? null,
    };

    if (claims) {
      const outcome = await service.linkProvider(claims.sub, provider.data, body.data.code, leg);
      if (outcome.ok) return json(200, { identity: outcome.identity });
      switch (outcome.error) {
        case "no-provider":
          return json(404, { error: "no such provider" });
        case "code-refused":
          return json(502, { error: "the provider did not accept the authorization code" });
        case "not-found":
          return unauthorized();
        case "unverified":
          return unverified();
        case "linked-elsewhere":
          return json(409, { error: "that account is already linked to another user" });
      }
    }

    const outcome = await service.loginWithProvider(
      provider.data,
      body.data.code,
      await sessionMeta(req),
      body.data.invite ?? null,
      leg,
    );
    if (outcome.ok) return json(200, outcome.tokens);
    switch (outcome.error) {
      case "no-provider":
        return json(404, { error: "no such provider" });
      case "code-refused":
        return json(502, { error: "the provider did not accept the authorization code" });
      case "deactivated":
        return json(403, { error: "this account is deactivated" });
      case "no-verified-email":
        return json(403, {
          error: "the account has no verified email address — verify one with the provider first",
        });
      case "membership-unknown":
        return json(503, { error: "could not verify org membership — try again later" });
      case "no-organization":
        return json(403, {
          error: "no organization to join yet — an admin has to connect the forge app first",
        });
      case "registration-closed":
        return json(403, { error: "no account matches, and registration is closed" });
      case "invalid-invite":
        return json(410, { error: "this invite is no longer valid" });
      case "linked-before-upgrade":
        return json(409, {
          error: "this login is linked to an account from before the upgrade — sign in to it " +
            "with your password and link the account again from Settings",
        });
      case "invite-email-mismatch":
        return json(403, {
          error: "this invite is for a different address than the one the provider verified",
        });
      case "link-required":
        return json(409, {
          error: "this account is not linked yet — sign in another way and link it from Settings",
          code: "link_required",
        });
    }
  };

  // ---- passkeys ----------------------------------------------------------------------------

  const noAppUrl = () =>
    json(503, { error: "RYPH_APP_URL is not set, so passkeys have no origin to bind to" });

  const passkeyRegisterOptions = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const outcome = await service.passkeyRegistrationOptions(claims.sub);
    if (!outcome.ok) {
      if (outcome.error === "no-app-url") return noAppUrl();
      return outcome.error === "unverified" ? unverified() : unauthorized();
    }
    return json(200, { challengeId: outcome.challengeId, options: outcome.options });
  };

  const passkeyRegisterVerify = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const body = await parseBody(req, PasskeyRegisterSchema);
    if (!body.ok) return body.res;
    const outcome = await service.registerPasskey(
      claims.sub,
      body.data.challengeId,
      body.data.response as unknown as RegistrationResponseJSON,
      body.data.name,
    );
    if (!outcome.ok) {
      if (outcome.error === "no-app-url") return noAppUrl();
      if (outcome.error === "unverified") return unverified();
      return json(400, { error: "the passkey could not be verified" });
    }
    return json(201, outcome.passkey);
  };

  const listPasskeys = async (req: Request): Promise<Response> => {
    const claims = await claimsOf(req);
    if (!claims) return unauthorized();
    const refused = sessionOnly(claims);
    if (refused) return refused;
    return json(200, { passkeys: await service.listPasskeys(claims.sub) });
  };

  const renamePasskey = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const body = await parseBody(req, RenamePasskeySchema);
    if (!body.ok) return body.res;
    const passkey = await service.renamePasskey(claims.sub, params.id, body.data.name);
    if (!passkey) return json(404, { error: "no such passkey" });
    return json(200, passkey);
  };

  const deletePasskey = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const outcome = await service.deletePasskey(claims.sub, params.id);
    if (!outcome.ok) {
      if (outcome.error === "not-found") return json(404, { error: "no such passkey" });
      return json(409, {
        error: "set a password or link an account before removing your only sign-in method",
      });
    }
    return json(200, { ok: true });
  };

  const passkeyLoginOptions = async (): Promise<Response> => {
    const outcome = await service.passkeyLoginOptions();
    if (!outcome.ok) return noAppUrl();
    return json(200, { challengeId: outcome.challengeId, options: outcome.options });
  };

  /** No failure budget: an assertion is a signature over a fresh challenge, which no number of
   * attempts forges (see the note on budgets). */
  const passkeyLoginVerify = async (req: Request): Promise<Response> => {
    const meta = await sessionMeta(req);
    const body = await parseBody(req, PasskeyLoginSchema);
    if (!body.ok) return body.res;
    const outcome = await service.loginWithPasskey(
      body.data.challengeId,
      body.data.response as unknown as AuthenticationResponseJSON,
      meta,
    );
    if (outcome.ok) return json(200, outcome.tokens);
    if (outcome.error === "no-app-url") return noAppUrl();
    if (outcome.error === "deactivated") return json(403, { error: "this account is deactivated" });
    return json(401, { error: "the passkey could not be verified" });
  };

  // ---- API tokens ----------------------------------------------------------------------------

  const createApiToken = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "tokens:write");
    if (refused) return refused;
    const body = await parseBody(req, CreateApiTokenSchema);
    if (!body.ok) return body.res;
    // Nobody mints more than they hold. A token never mints another: `liveClaimsOf` already
    // turned it away, so a script holding one cannot spawn a longer-lived copy of itself.
    const beyond = body.data.caps.find((capability) => !can(claims, capability));
    if (beyond !== undefined) {
      return json(403, forbidden(beyond, "a token carrying it"));
    }
    const governing = body.data.caps.find((c) => SESSION_ONLY_CAPABILITIES.includes(c));
    if (governing !== undefined) {
      return json(400, {
        error: `${governing} is answered to a signed-in session only; a token cannot carry it`,
        code: "session_required",
        capability: governing,
      });
    }
    const outcome = await service.mintApiToken(claims.sub, body.data);
    if (!outcome.ok) {
      return outcome.error === "not-found"
        ? json(404, { error: "no such user" })
        : json(403, { error: "caps: a capability beyond what you hold" });
    }
    return json(201, { token: outcome.token, summary: outcome.summary });
  };

  const listApiTokens = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    return json(200, { tokens: await service.listApiTokens(claims.sub) });
  };

  const revokeApiToken = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const anyOwner = can(claims, "tokens:manage-all");
    const found = await service.revokeApiToken(params.id, anyOwner ? null : claims.sub);
    return found ? json(200, { ok: true }) : json(404, { error: "no such token" });
  };

  /**
   * Unauthenticated: the secret IS the credential, a 256-bit random token, so it takes no budget
   * (see the failure windows above). Every refusal reads the same, so nothing about which tokens
   * exist leaks.
   */
  const exchangeApiToken = async (req: Request): Promise<Response> => {
    const body = await parseBody(req, ExchangeApiTokenSchema);
    if (!body.ok) return body.res;
    const outcome = await service.exchangeApiToken(body.data.token);
    if (!outcome.ok) return json(401, { error: "the token is unknown, revoked, or expired" });
    return json(200, { accessToken: outcome.accessToken, expiresIn: outcome.expiresIn });
  };

  // ---- the registration gates --------------------------------------------------------------

  /**
   * Readable without a token, like the bootstrap state: the sign-in page decides from these
   * whether to offer registration at all, and it renders to people who have no token yet.
   */
  const getSettings = async (): Promise<Response> =>
    json(200, {
      ...(await service.getSettings()),
      mailerConfigured: service.mailerConfigured(),
      multiUser: service.multiUser(),
    });

  const updateSettings = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const refused = refuseUnless(claims, "settings:manage");
    if (refused) return refused;
    const body = await parseBody(req, UpdateSettingsSchema);
    if (!body.ok) return body.res;
    // Opening a gate is letting someone else in, which a single-user instance never does.
    if (!service.multiUser() && (body.data.allowOpenRegistration || body.data.allowForgeOrgJoin)) {
      return singleUser();
    }
    return json(200, {
      ...(await service.updateSettings(body.data)),
      mailerConfigured: service.mailerConfigured(),
      multiUser: service.multiUser(),
    });
  };

  /**
   * Unauthenticated on purpose, and the leak is deliberate and small: it says only whether this
   * instance has any users at all, which the login page needs in order not to offer a
   * "create the admin account" link that can only ever answer 401. Everything else about the
   * user set stays behind a token.
   */
  const bootstrapState = async (): Promise<Response> =>
    json(200, { needsBootstrap: await service.needsBootstrap(), multiUser: service.multiUser() });

  // ---- single-user sign-in, and the profile ------------------------------------------------

  /**
   * Unauthenticated: the link IS the credential.
   *
   * No failure budget, on purpose. A run on Docker Desktop or OrbStack can reach the app through
   * host.docker.internal, which arrives as loopback, so the app vouches it as the owner's own
   * address and its bad links would spend the owner's budget and lock fresh `ryph login` links
   * out; stale links clicked twice spent it too. The token is a 256-bit random secret, single
   * use and ten minutes long, so a budget would not slow any real guessing.
   */
  const redeemLoginLink = async (req: Request): Promise<Response> => {
    const meta = await sessionMeta(req);
    const body = await parseBody(req, LoginLinkSchema);
    if (!body.ok) return body.res;
    // Not "expired": a fresh link would be refused the same, so the person signs in otherwise.
    if (service.multiUser()) {
      return json(409, {
        error: "login links only work on a single-user instance — sign in with your password",
        code: "multi_user",
      });
    }
    const outcome = await service.redeemLoginLink(body.data.token, meta);
    if (!outcome.ok) return json(410, { error: "this link is no longer valid" });
    return json(200, outcome.tokens);
  };

  /**
   * A fresh login link for `ryph login`. Its secret lives in a file only the person who started
   * the binary can read, so holding it says as much as holding the database does.
   *
   * No failure budget, on purpose. The caller is always direct, so it would share the one
   * "unknown" budget with every other unvouched caller, and a run that reaches this listener
   * could spend it with ten bad bearers and lock `ryph login` out. The bearer is a 256-bit
   * random secret compared in constant time, so a budget would not slow any real guessing.
   */
  const mintLoginLink = async (req: Request): Promise<Response> => {
    if (
      localLoginSecretDigest === null ||
      !await secretMatches(bearerToken(req), localLoginSecretDigest)
    ) {
      return unauthorized();
    }
    const outcome = await service.mintLoginLink();
    if (outcome.ok) return json(201, { link: outcome.link });
    switch (outcome.error) {
      case "multi-user":
        return json(409, { error: "login links are for a single-user instance" });
      case "not-found":
        return json(404, { error: "this instance has no owner who can sign in" });
      case "no-app-url":
        return json(503, { error: "RYPH_APP_URL is not set, so no link can be built" });
    }
  };

  const updateProfile = async (req: Request): Promise<Response> => {
    const claims = await liveClaimsOf(req);
    if (claims instanceof Response) return claims;
    const body = await parseBody(req, UpdateProfileSchema);
    if (!body.ok) return body.res;
    const outcome = await service.updateProfile(claims.sub, body.data);
    if (outcome.ok) return json(200, outcome.user);
    switch (outcome.error) {
      case "not-found":
        return unauthorized();
      case "email-taken":
        return json(409, { error: "that address already has an account" });
      case "multi-user":
        return json(403, { error: "an address can only be changed on a single-user instance" });
      case "owner-only":
        return json(403, { error: "only the owner can change an address here" });
    }
  };

  return [
    route("GET", "/v1/auth/bootstrap", bootstrapState),
    route("POST", "/v1/auth/login", login),
    route("POST", "/v1/auth/refresh", refresh),
    route("POST", "/v1/auth/logout", logout),
    route("GET", "/v1/auth/me", me),
    route("PATCH", "/v1/auth/me", updateProfile),
    route("POST", "/v1/auth/login-link", redeemLoginLink),
    ...(localLoginSecretDigest === null
      ? []
      : [route("POST", "/v1/auth/local/login-link", mintLoginLink)]),
    route("POST", "/v1/auth/users", createUser),
    route("GET", "/v1/auth/users", listUsers),
    route("PATCH", "/v1/auth/users/:id", updateUser),
    route("DELETE", "/v1/auth/users/:id", deleteUser),
    route("POST", "/v1/auth/invites", createInvite),
    route("GET", "/v1/auth/invites", listInvites),
    route("DELETE", "/v1/auth/invites/:id", revokeInvite),
    route("GET", "/v1/auth/invites/:token", previewInvite),
    route("POST", "/v1/auth/invites/:token/accept", acceptInvite),
    route("POST", "/v1/auth/verify/:token", verifyEmail),
    route("POST", "/v1/auth/password/forgot", forgotPassword),
    route("POST", "/v1/auth/password/reset/:token", resetPassword),
    route("GET", "/v1/auth/password/pending", listResetRequests),
    route("POST", "/v1/auth/users/:id/reset-link", adminLink((id) => service.mintResetLink(id))),
    route(
      "POST",
      "/v1/auth/users/:id/verify-link",
      adminLink((id) => service.mintVerificationLink(id)),
    ),
    route("POST", "/v1/auth/password", changePassword),
    route("POST", "/v1/auth/tokens", createApiToken),
    route("GET", "/v1/auth/tokens", listApiTokens),
    route("DELETE", "/v1/auth/tokens/:id", revokeApiToken),
    route("POST", "/v1/auth/token", exchangeApiToken),
    route("GET", "/v1/auth/sessions", listSessions),
    route("DELETE", "/v1/auth/sessions/:id", revokeSession),
    route("POST", "/v1/auth/sessions/revoke-all", revokeAllSessions),
    route("GET", "/v1/auth/providers", listProviders),
    route("POST", "/v1/auth/oauth/:provider/callback", oauthCallback),
    route("POST", "/v1/auth/passkeys/register/options", passkeyRegisterOptions),
    route("POST", "/v1/auth/passkeys/register/verify", passkeyRegisterVerify),
    route("POST", "/v1/auth/passkeys/login/options", passkeyLoginOptions),
    route("POST", "/v1/auth/passkeys/login/verify", passkeyLoginVerify),
    route("GET", "/v1/auth/passkeys", listPasskeys),
    route("PATCH", "/v1/auth/passkeys/:id", renamePasskey),
    route("DELETE", "/v1/auth/passkeys/:id", deletePasskey),
    route("GET", "/v1/auth/identities", listIdentities),
    route("DELETE", "/v1/auth/identities/:provider", unlinkIdentity),
    route("POST", "/v1/auth/identities/:provider/challenge", identityChallenge),
    route("POST", "/v1/auth/identities/:provider/link", linkIdentityByProof),
    route("GET", "/v1/auth/settings", getSettings),
    route("PATCH", "/v1/auth/settings", updateSettings),
    route("GET", "/.well-known/jwks.json", async () => json(200, await service.jwks())),
  ];
}
