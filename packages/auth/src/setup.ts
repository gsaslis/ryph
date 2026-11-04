// The package's startup contract: one call performs everything auth needs at boot and returns
// what a composition root mounts. The host calls this on startup; the standalone main.ts is
// the same call behind its own port.

import {
  appOrigin,
  AuthConfigError,
  type LoginLinkOutcome,
  makeAuthService,
} from "./core/service.ts";
import type { PublicUser } from "./core/types.ts";
import { type Verifier, verifierFromJwksSource } from "./core/verify.ts";
import type { Route } from "@ryph/shared/http";
import { authRoutes } from "./http/routes.ts";
import type { AuthStore } from "./ports/auth_store.ts";
import type { ChallengeProvider, IdentityProvider } from "./ports/identity_provider.ts";
import type { Mailer } from "./ports/mailer.ts";

export interface AuthSetupDeps {
  store: AuthStore;
  now(): Date;
  /** Null: sign-in and linking through a provider are refused as not configured. */
  identityProvider?: IdentityProvider | null;
  /** Null: no identity is proved by signed challenge here — Radicle's way in, where a forge
   * has no OAuth to borrow. */
  challengeProvider?: ChallengeProvider | null;
  /** Null: nothing is mailed; verification and reset links are handed to admins instead. */
  mailer?: Mailer | null;
  /** The web app's origin as a browser reaches it; null means no link can be built. */
  appUrl?: string | null;
  /** Where a failed send is reported; a send never fails the request that asked for it. */
  onMailError?: (err: unknown) => void;
  /**
   * Whether more than one person may use this instance — RYPH_MULTIUSER, read by the composition
   * root (`multiUserFromEnv`). No default here: the local binary and a networked deployment
   * answer it differently, and each says which it is.
   */
  multiUser: boolean;
  /**
   * See `AuthRoutesDeps.proxySecret`. Required multi-user: with more than one person on the
   * instance, a client address must come from the app alone. RYPH_PROXY_SECRET, read by the root.
   */
  proxySecret?: string | null;
  /**
   * Whether multi-user refuses to start without `proxySecret`. Default true; a root whose user
   * surface is open (RYPH_AUTH=off) passes false, as nobody signs in there to rate-limit.
   */
  requireProxySecret?: boolean;
  /** See `AuthRoutesDeps.localLoginSecret`. */
  localLoginSecret?: string | null;
  /** See `AuthServiceDeps.loginLinks`: true where this root mints login links (the binary,
   * `bun run up`). Default false. */
  loginLinks?: boolean;
}

export interface AuthSetup {
  /** The mountable user-auth surface: login, refresh, users, sessions, identities, JWKS. */
  routes: Route[];
  /** Verifies this issuer's tokens — what sibling surfaces gate their routes with. */
  verifier: Verifier;
  /** Housekeeping for the composition root's slow tick: purges stale accounts and tokens. */
  sweep(): Promise<{ purgedUsers: number }>;
  /**
   * Multi-user and still unclaimed: the token the first registration must present, for the
   * composition root to print. Null once anyone has registered, and always single-user.
   */
  setupToken: string | null;
  /** Single-user: makes the owner on an empty instance, and answers who it is. */
  ensureOwner(defaults: { email: string; name: string }): Promise<PublicUser | null>;
  /** Single-user: a one-time link that signs the owner in, built on `fallbackAppUrl` when the
   * deployment has no app URL of its own. */
  mintLoginLink(fallbackAppUrl?: string | null): Promise<LoginLinkOutcome>;
  /** Whether an owner can sign in without a login link (see AuthService.ownerCanSignIn): what a root
   * checks before booting multi-user over a single-user database. */
  ownerCanSignIn(): Promise<boolean>;
  /** The addresses of the owners `ownerCanSignIn` counts, null on an instance with nobody yet
   * (see AuthService.ownerSignInEmails): both answers in one scan. */
  ownerSignInEmails(): Promise<string[] | null>;
}

/**
 * Performs auth's startup work — ensures the signing key exists — and returns the package's
 * contributions to the deployment. Throws when the store cannot be read (an unprovisioned
 * database, above all), and with an AuthConfigError for multi-user without a proxy secret or
 * an app URL that is not absolute http(s).
 */
export async function setup(deps: AuthSetupDeps): Promise<AuthSetup> {
  if (deps.multiUser && (deps.requireProxySecret ?? true) && !deps.proxySecret) {
    throw new AuthConfigError(
      "RYPH_PROXY_SECRET is unset — RYPH_MULTIUSER=on needs it, with the same value on the " +
        "app, so only the app can name a client address",
    );
  }
  const service = await makeAuthService({
    store: deps.store,
    now: deps.now,
    identityProvider: deps.identityProvider ?? null,
    challengeProvider: deps.challengeProvider ?? null,
    mailer: deps.mailer ?? null,
    appUrl: deps.appUrl ?? null,
    onMailError: deps.onMailError,
    multiUser: deps.multiUser,
    loginLinks: deps.loginLinks ?? false,
  });
  // A SOURCE, not a snapshot. The JWKS is a table, and a second replica booting into an empty
  // database adds a key to it that this process must be able to verify against without being
  // restarted — see verifierFromJwksSource.
  const verifier = verifierFromJwksSource(() => service.jwks());
  return {
    routes: authRoutes({
      service,
      verifier,
      now: deps.now,
      proxySecret: deps.proxySecret ?? null,
      localLoginSecret: deps.localLoginSecret ?? null,
    }),
    verifier,
    sweep: () => service.sweep(),
    setupToken: await service.setupToken(),
    ensureOwner: (defaults) => service.ensureOwner(defaults),
    mintLoginLink: (fallbackAppUrl) => service.mintLoginLink(fallbackAppUrl),
    ownerCanSignIn: () => service.ownerCanSignIn(),
    ownerSignInEmails: () => service.ownerSignInEmails(),
  };
}

export { AuthConfigError };

/**
 * The boot log's line for an unclaimed instance: where to claim it, token included. Said at
 * warn so a deployment logging only warnings still prints it — it is the one line the operator
 * has to find.
 */
export function setupTokenNotice(token: string, appUrl: string | null): string {
  const where = appUrl === null
    ? `enter it on the app's /register page`
    : `open ${appOrigin(appUrl)}/register?setup=${token}`;
  return `this instance has no owner yet. Setup token: ${token} — to claim it, ${where}. ` +
    `It stops working once an owner exists.`;
}

/**
 * RYPH_MULTIUSER as a composition root reads it: `on`/`true`/`1` or `off`/`false`/`0`, and
 * `fallback` when unset — off for the local binary, on for a networked deployment. Anything
 * else throws, so a typo is a boot error rather than the wrong answer.
 */
export function multiUserFromEnv(
  get: (name: string) => string | undefined,
  fallback: boolean,
): boolean {
  const raw = get("RYPH_MULTIUSER")?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["on", "true", "1", "yes"].includes(raw)) return true;
  if (["off", "false", "0", "no"].includes(raw)) return false;
  throw new Error(`RYPH_MULTIUSER must be on or off, got ${JSON.stringify(raw)}`);
}
