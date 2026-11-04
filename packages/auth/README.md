# @ryph/auth

The **token contract** for every ryph service. Sign-in by password, passkey, or a linked forge
account mints short-lived **EdDSA-signed access tokens** (10 min) plus **rotating refresh tokens**
(30 days, stored only as SHA-256 digests). Services verify access tokens **statelessly** against the published JWKS — no
call to auth on any request — which is what lets the orchestrator today, and the historian / memory
service / keystore later, share one identity without sharing a secret.

## ⚙️ How it works

Auth has two halves, and most services only import the second:

- **The issuer** — every way of signing in (password, passkey, a forge account), token minting,
  refresh rotation, invites, verification and reset links, and user management. It owns an Ed25519
  signing key (generated on first boot, persisted, published as JWKS) and the storage behind all of
  it. This is the [service](docs/architecture.md).
- **The verifier** — `verifierFromJwks` / `verifierFromUrl`, the ~60 lines every ryph service
  imports to turn a bearer token into typed `Claims` (or `null`). Stateless: it needs only the
  public JWKS, so verification never calls back to the issuer.

It is a [hexagonal architecture](docs/architecture.md) like the rest of ryph, service-shaped but
**mounted in-process by default** — [`@ryph/host`](../host/README.md) spreads its routes into the
control plane's handler and shares its database. `src/main.ts` is a standalone composition root,
so extracting it into its own service later is a wiring change, not a refactor. [SSO arrives the same
way](docs/architecture.md#-what-changes-for-sso): a new login flow that ends in the same "issue our
tokens" call — verifying services never learn it happened.

## 🔌 Consuming it from a service

```ts
import { verifierFromUrl } from "@ryph/auth"; // or verifierFromJwks when mounted in-process
const verifier = verifierFromUrl("http://auth:7412/.well-known/jwks.json");
const claims = await verifier.verify(bearerToken); // Claims | null — sub, email, name, caps, …
if (!can(claims, "tools:manage")) return json(403, forbidden("tools:manage"));
```

A service puts the gates from `@ryph/auth/gates` in front of its routes rather than writing its
own: each refuses a missing or invalid bearer with a 401 and an unproven address with a 403, and
lets everything through under RYPH_AUTH=off.

| Gate                                    | Answers                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `makeAuthenticate(opts)`                | a `Principal` (the user, or break-glass under RYPH_AUTH=off), for a surface that records who |
| `refuseUnless(principal, cap, what?)`   | null, or the 403 naming the capability; `actorOf(principal)` is the id a write is filed under |
| `makeCapabilityGate(opts, cap?)`        | null or the refusal, for a surface that records no one                                      |
| `makeGrantBearer(opts)`                 | the run-grant gate's `{ sub, caps }`                                                       |
| `verifiedClaims(verifier, req)`         | the raw `Claims`, for a gate with a policy of its own (automations' development identity)  |

## 🎟️ Roles and capabilities

A capability is one permission with one spelling, `<resource>:<verb>`, from the closed list in
`CAPABILITIES`; a `-all` suffix widens a verb from "own and in scope" to everything of that kind.
A role is a named bundle of them, and a user holds one: `viewer` reads, `member` adds everything
own-scoped or forge-backed, `operator` adds every `-all` and `manage` except users, settings
and other people's tokens, and `owner` holds everything. Sign-in expands the role into the
token's `caps` claim (`["*"]` for an owner), so a service decides with `can(claims, capability)`
and never learns what a role is. A refusal is a 403 whose body `forbidden(capability)` names the
capability. A role change ends the user's sessions, so every service sees it within the access
TTL. `checks:request` (a member's) is asking for a repo's checks on a commit of one's own from
outside ryph, the `ryph checks` command or its MCP server; a token may carry it, and the
orchestrator still asks the forge for write on the repo every time. Nobody grants a role beyond their own capabilities, and only an owner grants `owner`.

An API token is a user's credential for a script or an agent: a subset of their capabilities,
spelled out, shown once as `ryph_pat_…` and stored as a digest. `POST /v1/auth/token` trades it
for an ordinary access token good for the access TTL, carrying the token's capabilities narrowed
to what its owner holds now, with `via: "token"` and the token's id as `sid`. Revoking it, a
demotion, and a deactivation are all felt at the next exchange. The account itself stays out of
a token's reach: it mints no token and cannot touch the password, the sessions, the passkeys, or
the linked identities, whatever capabilities it carries.

## 🚪 The surface

Every route that mints a session answers `{accessToken, expiresIn, refreshToken, user}`.

| Route                                              | What it does                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/login`                              | `{email, password}` → a session; rate-limited per email                                                          |
| `POST /v1/auth/refresh` · `POST /v1/auth/logout`   | Rotates the refresh token (the presented one dies) · kills the session                                           |
| `GET /v1/auth/me`                                  | The user behind a bearer access token                                                                             |
| `GET /v1/auth/bootstrap` · `GET /v1/auth/settings` | Unauthenticated: whether the instance has no users yet, and whether it is multi-user · the registration gates and whether mail is configured |
| `POST /v1/auth/users`                              | Multi-user only. While no users exist, creates the owner, given the setup token from the control plane's log. Afterwards: open registration only — a placeholder for the address, named and given a password on its link, uniform |
| `POST /v1/auth/login-link` · `POST /v1/auth/local/login-link` | Single-user only: spends a one-time login link for a session · mints one, for `ryph login`, given the local secret |
| `GET /v1/auth/providers` · `POST /v1/auth/oauth/:provider/callback` | The forges sign-in is offered through · redeem a code: with a bearer it links, without one it signs in or registers |
| `POST /v1/auth/passkeys/login/{options,verify}`    | Discoverable passkey sign-in: no email typed                                                                       |
| `POST /v1/auth/passkeys/register/{options,verify}` · `GET/PATCH/DELETE /v1/auth/passkeys[/:id]` | A user's passkeys                                                                    |
| `GET /v1/auth/invites/:token` · `POST /v1/auth/invites/:token/accept` | Preview and redeem an invite                                                                     |
| `POST/GET /v1/auth/invites` · `DELETE /v1/auth/invites/:id` | `users:manage`: mint (the link comes back once), list, revoke; only a role within one's own                                                       |
| `POST /v1/auth/verify/:token`                      | Prove the address, give the account its name and password, and sign in — the mailed link's landing; registering again re-sends it |
| `POST /v1/auth/password/forgot` · `POST /v1/auth/password/reset/:token` | Uniform "forgot" · set a new password, ending every session                                    |
| `POST /v1/auth/password`                           | Change (or first set) one's password with the current one                                                        |
| `GET /v1/auth/sessions` · `DELETE /v1/auth/sessions/:id` · `POST /v1/auth/sessions/revoke-all` | One's sessions, with the current one named                                          |
| `POST/GET /v1/auth/tokens` · `DELETE /v1/auth/tokens/:id` | `tokens:write`: mint (the secret comes back once), list one's own, revoke one's own (`tokens:manage-all`: anyone's) |
| `POST /v1/auth/token`                              | Unauthenticated: trade an API token for an access token; budgeted by address like a login       |
| `GET /v1/auth/identities` · `DELETE /v1/auth/identities/:provider` | One's linked forge accounts; unlinking keeps at least one way in                                    |
| `POST /v1/auth/identities/:provider/{challenge,link}` | A forge with no OAuth to redirect to (Radicle): mint a single-use nonce and the line that signs it · spend the outstanding challenge the pasted signature verifies against. Never a way IN — there is no account on the other side to sign in to |
| `GET /v1/auth/users` · `PATCH/DELETE /v1/auth/users/:id` | `users:manage`: list, change role or status, remove (a user may remove themself); the last owner stays                |
| `POST /v1/auth/users/:id/{reset,verify}-link` · `GET /v1/auth/password/pending` | `users:manage`, for an instance with no mailer: hand a link over once (an unproven address always gets its verification link) · who is waiting for one |
| `PATCH /v1/auth/settings`                          | `settings:manage`: the registration gates                                                                                     |
| `GET /.well-known/jwks.json`                       | Public keys, for stateless verification anywhere                                                                  |

The exact shape of each flow — with sequence diagrams — is in [token-flows.md](docs/token-flows.md).

## 🚀 Standalone

The default deployment is mounted; to run auth on its own:

```sh
bun run db:push && bun run dev       # standalone composition root, port 7412
```

## ⚡ Quick start

```sh
bun run ci      # the gate: type-check, architecture guard, tests (fmt and lint run from the root)
```

## 📚 Docs

| Doc                                         | What it covers                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)     | the issuer/verifier split, the ports, the two deployments, the signing key, and how a forge signs people in |
| [token-flows.md](docs/token-flows.md)       | every way in and every link out — as sequence diagrams and rules                          |
| [development.md](docs/development.md)        | tasks, the database, and the security choices (scrypt, decoy timing, rate limiting, passkeys) |
