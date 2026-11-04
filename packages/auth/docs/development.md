# 🛠️ Development

## 📋 Prerequisites

Tool versions are pinned in the workspace root's [`mise.toml`](../../../mise.toml). Install
[mise](https://mise.jdx.dev), then let it provision Bun:

```sh
mise install      # installs the pinned Bun
```

## ⚡ Tasks

Defined in [`package.json`](../package.json):

| Task                  | What it does                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bun run ci`          | the package gate — typecheck, architecture guard, tests; with the root's `bun run fmt:check` and `bun run lint`, run before pushing |
| `bun run dev`         | runs auth standalone (composition root, port 7412)                                                                                  |
| `bun run test`        | runs the test suite in `tests/`                                                                                                     |
| `bun run check`       | type-checks `src/`, `scripts/`, and `tests/` without running anything                                                               |
| `bun run guard`       | architecture guard (enforces the import/dependency fence)                                                                           |
| `bun run db:push`     | applies `schema.ts` straight to the database — local dev, no migration files                                                        |
| `bun run db:generate` | generates SQL migrations from the schema                                                                                            |

## 🗄️ Database & deployment

Auth's storage — users, sessions, identities, settings, the signing key — is
[drizzle](https://orm.drizzle.team/) on PostgreSQL, the same stack and `db:push` workflow as
[the orchestrator](../../orchestrator/docs/development.md#-database).

The thing to know: in the **default (mounted) deployment you don't push auth's schema separately.**
The host's [`drizzle.config.ts`](../../host/drizzle.config.ts) lists every module's schema file, and
the mounted packages share one database, so a single `bun run db:push` in the host provisions auth's
tables too. Auth's own `db:push` is for the **standalone** deployment, where it owns its database.

Tests push the schema programmatically onto a fresh `:memory:` database per test
([`tests/db.ts`](../tests/db.ts)), exercising the same push path as local dev.

## 🔒 The security choices

The interesting parts of this package are its defaults; here's what each is and why.

- **Passwords: scrypt via `node:crypto`** ([`helpers/password.ts`](../src/helpers/password.ts)).
  Zero dependencies. The hash is **self-describing** (`scrypt:N=16384:salt:hash`), so the work
  factor can be raised later without invalidating existing hashes — a new login re-reads the
  parameters from the stored hash.
- **Flat-timing login.** An unknown email is verified against a `DECOY_HASH` so it costs the same
  wall-clock time as a real user with a wrong password, and the error never distinguishes the two.
  Both defend against account enumeration — see [token-flows.md](token-flows.md#-login).
- **Refresh rotation.** Every refresh deletes the presented session before minting a new one, making
  refresh tokens single-use; a replay is dead on arrival
  ([token-flows.md](token-flows.md#-refresh-rotation)).
- **Refresh tokens stored hashed.** Only a SHA-256 digest is persisted; a database read never yields
  a usable token.
- **Per-email login rate limiting.** A per-process failed-attempt window (default 10 per 15 min,
  reset on success) blunts online guessing on a single node. It's in-memory on purpose: a shared
  store can back it when a multi-replica deployment exists to need it.
- **EdDSA, not HMAC.** Asymmetric signing means verifiers hold only the public key — a leaked
  verifier config can't mint tokens. It's also what makes
  [stateless verification across many services](architecture.md#-issuer-and-verifier) safe.
- **Every link is a digest at rest.** Invite, verification, and reset tokens are 32 random bytes
  stored as SHA-256; the raw value exists in the mail that carried it or on the admin's screen that
  showed it, once. A newer link voids the older ones of its kind.
- **Uniform answers.** Open registration and "forgot password" respond identically whether or not
  the address has an account, and act on the owner's side instead.
- **Nothing before the proof.** An account made by open registration or an open invite has no name,
  no password and no session until its address is proven; the mailed link — which names nobody —
  takes the name and password and signs in. So a registrant who typed someone else's address holds
  nothing the owner could inherit, no word of theirs reaches the mailbox, and the owner's click
  cannot verify a stranger's credentials. Until an address is proven, the account can attach nothing
  durable (no passkey, no linked account) and every service surface refuses it.
- **Claiming, not colliding.** A provider-verified sign-in that lands on an unverified account takes
  it over — passkeys and linked identities removed, sessions ended, unspent links voided — because
  the provider proved the address and the registrant never did. The first proof by link does the
  same. Only an account nobody has signed into can be claimed, and its API tokens go with the rest.
  The reverse (an unverified registration on a verified account's address) simply does nothing.
- **Only a trusted provider's "verified" is proof.** `IdentityProvider.trustsEmails` says whose is:
  GitHub's, not a self-managed GitLab's (which may confirm any typed address). An untrusted
  provider's addresses never sign into, link or claim an existing account; they are looked at only
  once the invite or the gate has admitted the person, and then only to refuse (`link-required`) an
  address an account holds. The account such a provider registers does not hold that address at all:
  its `email` is a stand-in under the reserved `.invalid` TLD (its own id, `addresslessEmail`) and
  the address is kept beside it as `unprovenEmail`, which nothing looks up and admins see marked
  unproven. Whoever proves the address later, by a trusted provider or a mailed link, finds it free
  and gets an account of their own: nothing the GitLab account made, linked or minted can pass to
  them, so there is no claim to make. No form accepts a `.invalid` address, no provider's word that
  one is verified counts, and a stand-in gets no reset link, mailed or minted.
- **Passkeys bind to the app's origin** and refuse a signature counter that does not advance.
- **One way in stays.** A password, a linked account, or a passkey can be removed only while another
  remains.
- **Last admin stays.** Demoting, deactivating, or deleting the only admin is refused.

## 🧪 What the tests cover

[`tests/auth_flow_test.ts`](../tests/auth_flow_test.ts) drives the real service against an in-memory
store: bootstrap → login → verify → refresh rotation → logout, sessions, deactivation, the
last-admin rule, invites, rate limiting, and a JWKS assertion that **no private key material** is
ever served. [`tests/provider_login_test.ts`](../tests/provider_login_test.ts) covers sign-in and
linking through a scripted provider, [`tests/email_flows_test.ts`](../tests/email_flows_test.ts)
verification and reset over a recording mailer and with none, and
[`tests/passkeys_test.ts`](../tests/passkeys_test.ts) registers and asserts with a software
authenticator holding a real P-256 key.
[`tests/drizzle_store_test.ts`](../tests/drizzle_store_test.ts) exercises the Postgres adapter
against a pushed schema.

> **Fake-clock caveat.** jose validates `exp` against the real wall clock, so tests can't mint a
> token "in the past" with a fake clock and expect jose to honor it. Token-TTL correctness is
> asserted structurally instead (`payload.exp - payload.iat === 600`) rather than by advancing a
> clock past expiry.
