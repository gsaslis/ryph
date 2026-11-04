# @ryph/model-proxy 🗝️

Model access for agent runs: **real provider keys sealed in one place, run-scoped virtual keys
everywhere else.**

An agent container runs untrusted code three ways — the repo's setup steps, the coding agent's
pre-approved tool calls, and the agent itself under possible prompt injection. Whatever
credential reaches that container must be assumed readable by the repo it works on. So no real
provider key ever goes there. Instead:

1. A user registers a **provider key** (an Anthropic or OpenAI key, or one for any
   OpenAI-compatible endpoint an admin registered) once, centrally. It is sealed (`v2`: AES-GCM
   under a key derived from `RYPH_SECRETS_KEY` for provider keys alone, with the key's id, its
   provider and — for a custom endpoint — the endpoint's base URL, auth header and scheme and
   extra headers as authenticated data) before it lands in a row, and never appears in any API
   response again — the management surface is write-only on secrets. A row repointed in the
   database opens nothing.
2. At a run's boot, the orchestrator mints a **virtual key**: a random run-scoped token whose
   hash and frozen scope (which provider key, which models) land in a row. The container
   receives it via the runner's boot-time credentials fetch, inside env vars the provider's own
   SDKs read (`ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` pointing at the proxy).
3. The harness calls "the provider" — actually the **proxy process**, which authenticates the
   virtual key, enforces the model allowlist server-side, forwards the request with the real
   key, streams the answer back, and meters the tokens each call reported — attributed to its
   run, agent and task.
4. When the run concludes, its virtual keys are **revoked**; a TTL is the backstop. Exfiltrating
   one from a workspace buys an attacker a dead, model-bounded, run-scoped token.

Archiving a provider key is the kill switch: every in-flight run backed by it loses access on
its next request — liveness of the real key is deliberately the one *live* check in an otherwise
frozen scope.

## 🧭 Control plane vs data plane

Two halves, two listeners, and where each half lands depends on the deployment (the full
treatment — ports, adapters, the secret's life, the virtual key's life — is
[docs/architecture.md](docs/architecture.md)):

- **Control side.** Key CRUD on the user surface, and the issuer that mints a run's virtual key.
  In the single process, [`@ryph/host`](../host/README.md) calls this package's `setup()` and
  spreads the routes into its own router, exactly like @ryph/auth. Standalone, `src/main.ts`
  serves them on their **own control listener** (`:7421`) — plus `/internal/v1/…`, the
  service-authed surface a remote control plane dials instead of holding an in-process issuer.
- **Data side — its own listener, always.** Agent containers dial it over the network in every
  deployment: the host serves it on its own port beside the control plane; `src/main.ts` serves
  it on `:7420`. The hot path streams every token of every completion; the same reasoning that
  keeps the transcript firehose out of the control plane keeps this off it too. It serves no
  users and holds no state a user created: delete and redeploy it freely.
- **The seam between the two halves is the shared key store**, not an API: the control side
  writes `provider_keys` and `virtual_keys`, the data side reads them per request (and appends
  `proxy_usage`) — one shared connection under the host, one database owned by the standalone
  process. A proxy restart mid-run is a non-event.

### 🔒 The master key lives here

`RYPH_SECRETS_KEY` seals provider secrets, and **only this package's two halves ever hold
it**. Once key CRUD moved onto the listener below, nothing in the control plane needs to open a
provider secret, and a compromised control plane should not be able to.

### 👤 Who may do what

Every route on the management surface is verified against the same @ryph/auth JWKS the
orchestrator and the historian use, so the app forwards one user bearer wherever the path lives.
Above that, two gates over one verification:

| | | |
| --- | --- | --- |
| `POST /v1/provider-keys` | admin | Register a provider key. The secret arrives here and never comes back. |
| `GET /v1/provider-keys` | any user | Metadata plus `last4` and `archivedAt`; never a secret. `needsSecret` when the key's secret must be entered again, `providerMissing` when its provider no longer exists (archive it). |
| `PATCH /v1/provider-keys/:id` | admin | Relabel, and/or rotate the secret under the same id — also how a `needsSecret` key gets its secret back. `409 provider_missing` for a key whose provider is gone; `409 secret_required` when the endpoint's shape moved while the secret was being saved (it was sealed for the old one — enter it again). A secret is visible ASCII with no whitespace (`POST` too): it rides a header. |
| `POST /v1/provider-keys/:id/archive` | admin | The kill switch. Idempotent; the row stays resolvable forever. |
| `GET /v1/providers` | any user | Every provider: the two built-ins, then the registered endpoints, each with the header its credential rides in (`authHeader`, `authScheme`). Never their `extraHeaders`. |
| `GET /v1/providers/:id` | admin | One endpoint in full — `extraHeaders` and all, which is what an edit dialog prefills from. Built-ins resolve too, reporting `extraHeaders: {}`; anything else is a `404`. |
| `POST /v1/providers` | admin | Register an OpenAI-compatible endpoint. |
| `PATCH /v1/providers/:id` | admin | Change anything but the id. A built-in is a `404`: it has no row. Changing `baseUrl`, `authHeader`, `authScheme` or `extraHeaders` (compared canonically: header names lower-cased, values, scheme and URL trimmed) clears the secrets of the endpoint's keys in the same transaction and answers how many live keys that was (`keysCleared`): they read `needsSecret` until entered again, and a run using one is refused with `409 secret_required` (as is one whose stored secret does not open, or cannot ride a header). `extraHeaders` and `authHeader` may not be `host`, `forwarded`, `x-forwarded-host`, `x-forwarded-for`, `x-forwarded-proto`, `x-real-ip`, `content-length`, `transfer-encoding`, `connection`, `te`, `upgrade`, `keep-alive` or any `proxy-*` name, nor may a static header be the auth header itself; `authScheme` is one token (`Bearer`) and each `extraHeaders` value visible ASCII (`0x21`–`0x7E`) with single spaces between words. |
| `POST /v1/providers/:id/archive` | admin | The kill switch for an endpoint. Idempotent; built-ins `404`. |
| `GET /v1/platform-model-policy` | any user | The policy as set, or `null`. The app's Model keys page shows it. |
| `PUT /v1/platform-model-policy` | admin | Name the live key the platform's own model calls spend, and on which models. |
| `DELETE /v1/platform-model-policy` | admin | Clear it: every off-run model call goes dark and says so. |
| `POST /v1/chatgpt-plan/sign-ins` | admin | Start signing a ChatGPT plan in (or `keyId` in again): the authorize URL. `409` when the loopback listener cannot bind. |
| `GET /v1/chatgpt-plan/sign-ins/:id` | admin | `pending`, `done` (with `keyId`), `failed` (with `error`) or `expired`. |
| `POST /v1/provider-keys/:id/chatgpt-plan/models` | admin | Fetch the plan key's model list again. |

Registering an endpoint is not touching a credential, and it takes `models:manage` anyway: it
decides which URL this pod dials with a real provider key in hand. **Anything that touches a
credential takes `models:manage`** (in the verified token's `caps`): registering a key, rotating
its secret, archiving it, and deciding whose key the platform itself spends, which is a spending
decision as much as a security one. A verified user without it is told so with a `403` whose code
is `forbidden` and whose `capability` names it: they are who they claim, and may not. **Reading
takes only `models:read`**, because the app shows the key list and the policy to every member and
nothing there is a secret. `RYPH_AUTH=off` passes here as everywhere.

The one read that is not is `GET /v1/providers/:id`, and `extraHeaders` is the whole reason:
nothing in it is secret by contract — the credential is the sealed provider key, which has no
read path at all — but it is a free-text map an admin typed, and the list above is read by every
signed-in user. Holding the field back from the many and handing it to the few who may rewrite
the row anyway costs one request and keeps a regrettable paste out of general view.

### 🧩 Custom model endpoints

The two built-ins are not the whole list. An admin can register any **OpenAI-compatible
endpoint** — Cloudflare Workers AI, Groq, Together, Fireworks, OpenRouter, DeepSeek, Azure
OpenAI, Google AI Studio's compatibility endpoint, a self-hosted vLLM — as a row, and from then
on it behaves exactly like `anthropic` and `openai`: keys are sealed here, runs get virtual
keys, the allowlist is enforced server-side, tokens are metered and priced. Static credentials
only: a bearer, or a named header like Azure's `api-key`. No OAuth, no service-account refresh —
full Vertex AI is out of scope on purpose.

**The switch is the `dialect`, not the name.** A provider id used to imply a wire shape because
there were two of them; now it is whatever an admin typed. So every provider — built-in or
row — carries `dialect: "anthropic-messages" | "openai-responses" | "openai-completions"`, and
everything that used to branch on the id branches on that instead: the metering shape here, the
harness capability check in the control plane, the model client in @ryph/memory. The strings are
deliberately pi's own `api` names, so the runner writes the value into `models.json` without a
translation table.

**OpenAI speaks Responses.** The built-in `openai` provider is `openai-responses`: pi drives it
over `/v1/responses` (unstored, streamed, carrying encrypted reasoning between turns), the memory
service calls it the same way, and a ChatGPT plan accepts nothing else. Custom endpoints stay
`openai-completions`, the shape OpenAI-compatible servers actually implement; a row has no dialect
column. The dialect is what a client speaks, not a path filter: `/v1/chat/completions` on the
`openai` provider is still forwarded and metered, and either OpenAI dialect reads either usage
shape (`usage.input_tokens`/`output_tokens` with `input_tokens_details.cached_tokens` and
`output_tokens_details.reasoning_tokens`, or the `prompt_`/`completion_` spellings).

**A row declares its models, and the built-ins do not.** That is not an inconsistency: pi carries
a catalogue for Anthropic and OpenAI and the price list covers them, while nothing anywhere knows
what a self-hosted vLLM serves or charges. So a registered endpoint states its models (ids,
context window, pi's `compat` overrides, and optionally USD-per-million rates), the runner writes
them into pi's config, and the usage report prices them from the same declaration. A model
declared **without** a price is reported as _unpriced_ — never as free. Under a spend cap, a
run's own or the deployment's ceiling, a request naming an unpriced model (or none) is refused
with `403 {code: "unpriced"}` from the first dollar: a spend that cannot be priced cannot be
counted toward the cap, so letting it through would leave the cap unenforced.

**The forwarding path.** Each provider carries two paths, and they are different things:
`baseUrl` is where the real API lives, **path included**, and `clientBasePath` is the segment the
CLIENT already has in its base URL. The proxy strips the second off the incoming path and appends
what is left to the first:

| baseUrl | clientBasePath | in | out |
| --- | --- | --- | --- |
| `https://api.anthropic.com` | `""` | `/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `https://api.openai.com/v1` | `/v1` | `/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| `…/accounts/X/ai/v1` | `/v1` | `/v1/chat/completions` | `…/accounts/X/ai/v1/chat/completions` |

(This is why `openai`'s base URL gained its `/v1`: every provider's real path now lives in exactly
one field.) Where `clientBasePath` is non-empty, a path that does not carry it is **refused**: the
issuer hands the client a base URL ending in that segment, so nothing correctly configured omits
it, and forwarding it anyway would give every upstream endpoint a second spelling on this
listener — one the path-keyed rules below never see. Anthropic's prefix is empty, so nothing of
its own can be missing.

**What a run may reach.** Every provider serves a run a fixed list of routes (core/endpoints.ts)
and refuses everything else with `404 endpoint_not_allowed`, unread. A custom endpoint's list is
its dialect's model call and models list — for `openai-completions`, `POST /v1/chat/completions`,
`GET /v1/models` and `GET /v1/models/{id}` — because the real key behind a gateway reaches files,
batches, fine-tuning and the account's own key-info routes too. Its query string keeps only
`api-version`. Azure's old deployment paths (`/openai/deployments/<name>/…`, where the path picks
the model) are not served; its `/openai/v1` API, which takes the model in the body, is.

**What counts as spending.** A request that buys tokens must name a model this run is allowed, and
one that names none is refused rather than waved through. That is every listed route that takes a
body; the models lists are not.

**Two legs, two credentials.** pi → proxy is always `Authorization: Bearer <virtual key>`. The
admin's `authHeader`/`authScheme` describes only proxy → upstream: `scheme: null` sends the bare
value, which is what `x-api-key` and Azure's `api-key` want. An endpoint's non-secret
`extraHeaders` are set on the forwarded request **before** the credential, so nothing typed into
them can displace the real key. Nothing sealed ever goes in a row here: a custom endpoint's
credential is an ordinary provider key registered against its slug.

**What goes on the wire is what the key was sealed for.** The scheme and static headers are sent
in their canonical spelling — the one `endpointShape` binds the key to — never as stored, and
they are held to the registration rules again at every forward, so a row written straight into
the database cannot smuggle in a name or value the API refuses. An endpoint whose stored headers
fail them answers `502 endpoint_misconfigured` until an admin fixes it; a secret that opens but is
not visible ASCII answers `409 secret_required`, and a ChatGPT plan token that is not,
`502 credential_header_refused`. None of these ever reaches `Headers` — whose error message
quotes the whole header value, the credential in it — and none is logged with a value. These
refusals, and every other one no retry can change (`unknown upstream provider`, an archived
endpoint, `needs_reauth`), carry `x-should-retry: false`, which Anthropic's and OpenAI's SDKs read
before their own backoff.

**Where a base URL may point.** It is admin-entered, and this pod holds real provider keys, so
registration refuses a URL that is not `https`, that carries a query string, a fragment or
credentials, or whose host is literally a loopback, link-local or private-range address —
`169.254.169.254` above all — the ranges kept in step with the NetworkPolicy's own except list,
CGNAT and the IPv6 translation prefixes included. `RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1` lifts
the address rule, and plain `http` with it — but only for a private address, which is how a LAN
vLLM gets registered without the flag also putting a sealed key on the public internet in
cleartext. A host that is a NAME is resolved, at registration and again before a forward (a
pass trusted for 30 s), and refused when any address it has is one of those ranges: a
`169.254.169.254.nip.io` is the metadata server under a public-looking name, and in the binary and
in compose no NetworkPolicy would stop the dial. Be honest about what that check is: **not**
DNS-rebinding-proof, because fetch resolves the name again for itself and Bun's fetch cannot be
pinned to an address while keeping the name for TLS, so a record that changes between the two
lookups passes. In the cluster what holds the boundary is the NetworkPolicy on this pod, whose egress rule excepts every private
range (`deploy/helm/ryph/templates/networkpolicies.yaml`) — the third service in the deployment to be held
on the way out, for the same reason memory and chat are. The forward itself never follows a
redirect (`redirect: "manual"`): fetch keeps `x-api-key` and `api-key` across origins, a run picks
the route and (on a built-in) the query, and an open redirect on a registered upstream would otherwise hand it
the unsealed key. The `3xx` is relayed to the caller like any other answer, so the address check
now bites outside the cluster too.

**What a container gets.** A built-in's credential rides the SDK's own variables
(`ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`). A custom endpoint has no SDK convention to borrow,
so it gets ryph's own two plus a third entry:

```
RYPH_MODEL_API_KEY         = <the virtual token>
RYPH_MODEL_BASE_URL        = <proxyUrl>/v1
RYPH_MODEL_PROVIDER_CONFIG = {"id":"groq","dialect":"openai-completions","models":[…]}
```

The blob rides as one more env var precisely so the orchestrator→runner wire shape does not
change — the env map flows through both untouched, and only the harness adapter at the far end
has to know the name. It carries nothing sealed and nothing about the upstream leg: not the real
base URL, not the auth header, not the extra headers.

**What registering an endpoint costs you, stated plainly.** A run picks the body and most
headers; this proxy attaches the real key and streams the answer back. Every provider is held to
a route list (src/core/endpoints.ts): Anthropic serves a run only `POST /v1/messages`,
`POST /v1/messages/count_tokens` and its models list, OpenAI only `POST /v1/responses`,
`POST /v1/chat/completions` and its models list, a custom endpoint only its dialect's model call
and models list (anything else is a `404`, `code: "endpoint_not_allowed"`), and a background
response is a `400`. The built-ins also carry an allowlist of headers on both legs, so no
`openai-organization` goes up and no organization id comes back. A custom endpoint forwards the
run's headers, so if the host reflects request headers into a model call's answer, the run reads
the real key out of it. A refusal of the key itself (a `401` or `403`) from a custom endpoint or a plan
is answered with a fixed body (`code: "upstream_credential_refused"`), never relayed: a gateway's
refusal can quote the key it was handed. What a custom endpoint changes is the *set of origins* a run can be
pointed at: from two well-understood APIs to whatever an admin typed. So registering one is a
decision about which third party may be handed this deployment's unsealed keys, and it deserves
the care registering the key itself gets — which is why it is admin-only.

**What a model call may carry.** A body is held to what the harness sends: client-side
(function or custom) tools, and images and files inline (src/core/body_policy.ts). A server tool
(web search and fetch, code execution, file search, image generation, hosted MCP servers), media
by URL or by `file_id`, an `item_reference`, and stored state (`previous_response_id`,
`conversation`, a stored `prompt`, Anthropic's `mcp_servers` and `container`) are refused with
`400 body_not_allowed`, naming each. Each of them has the provider dial an address the run chose
from outside its network, spend outside the tokens metered here, or read the organization's
stored data. The same rule holds for a custom endpoint of the matching dialect and, after its own
refusals, for a ChatGPT plan.

### 💬 ChatGPT plan keys

A third built-in, `chatgpt-plan`, spends the usage a person's ChatGPT plan includes instead of API
prices, through OpenAI's [token sharing for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source).
Its credential is not a pasted key but an OAuth token set, so it is made only by signing in
(`POST /v1/provider-keys` refuses it) and it is a `provider_keys` row like any other: the tokens
sealed as one JSON document, the non-secret registration beside them (`plan`: the issued
`oaiapp_…` client, the account's subject, email and plan, its model list) and its state in two
columns of its own (`active`, `needs_reauth`, `limited`).

- **Local deployments only.** OpenAI offers plan usage to apps run locally; a remotely hosted one
  needs its approval first. So plan keys are on only where the composition root passes
  `chatgptPlan`: the host, when `RYPH_APP_URL` is a loopback address (the binary,
  `bun run up`). The standalone proxy never does. Off, the sign-in routes answer `403`
  (`code: "chatgpt_plan_local_only"`), `/v1/providers` leaves the provider out, no run is issued
  a plan key and the data plane refuses one with the same `403`. Signing an existing key out
  still works.

- **Signing in.** Authorization code with PKCE (`S256`), `dynamic_agent_client` plus
  `agent_name_hint=Ryph` for a first registration and the issued client (with `id_token_hint`
  and `login_hint`) for a later one, and one `ext_agent_host_id` per deployment, minted once into
  `chatgpt_agent_host`. Each attempt's state, nonce and sealed verifier are a
  `chatgpt_sign_ins` row. The callback is `http://127.0.0.1:1455/auth/callback`; the proxy
  listens there only while a sign-in it started is pending, and that listener is the only way a
  sign-in finishes. There is no pasted-address route.
  Finishing checks the state, exchanges the code once, verifies the ID token against OpenAI's
  JWKS (issuer, audience = the issued client, nonce, expiry) and requires
  `chatgpt.tokens.use.direct` among the granted scopes. A sign-in into an existing key must be
  the same account.
- **Forwarding.** Only `POST /v1/responses` and `GET /v1/models` reach `api.openai.com`. A
  Responses body goes up with `store: false` and `stream: true`, without the fields the plan
  refuses (pi sends `max_output_tokens`, `temperature` and `prompt_cache_retention`), and a
  `previous_response_id`, a `system` item or a hosted tool the plan does not run is a `400`
  naming it (`code: "plan_unsupported"`, `refused: [...]`). A caller that did not ask for a
  stream — the memory service — gets the stream assembled back into one JSON response. A plan
  body is capped at 24 MiB, a million JSON values and 128 levels of nesting, measured before it
  is parsed (`413` past any of them); only an allowlist of request headers and no query string
  go up. The access token is refreshed when it is within two minutes of expiry, or once after a
  `401` on a token more than five minutes old: one refresh per key at a time, in this process (a
  queue per key) and across replicas (an advisory lock on the key, on a connection reserved for
  that one acquisition), with the rotated refresh token written back over the secret it was
  refreshed from, retried, and held in memory until it lands. Re-sign-in, archiving and the
  status marks take the same lock. OpenAI refusing the refresh token marks
  the key `needs_reauth` and every call on it is a `403` with `code: "needs_reauth"`; a `429` or
  a mid-stream `response.failed` with `subscription_sharing_usage_limit_exceeded` marks it
  `limited`, and the next completed response clears that. Nothing ever falls back to another key.
- **Money.** A plan's usage is **included**: metered like any other, priced at $0, reported as
  `pricing: "included"` with an `includedRequests` count beside `unpricedRequests`, and never
  refused by a spend cap, the run's or the deployment's.
- **Runs.** The issuer hands a run ryph's own variables plus the config blob, its models the key's
  own list, so pi drives it as an `openai-responses` provider of its own.
- **Archiving** is signing out: under the key's lock it revokes the newest refresh token at OpenAI
  (best effort, twice), drops the tokens and archives the key, and answers `revoked: false` when
  OpenAI did not confirm it, so the app can ask the person to disconnect ryph in ChatGPT's
  settings. Signing a key in again drops the session it replaces without revoking it, since a revoke
  might end the new session too; the old one lapses within thirty days.
- **Who sees the account.** The key list shows a plan key's email only to admins
  (`models:manage`); everyone else gets `email: null`, and a new key is labelled "ChatGPT plan",
  not after its account.

### 🔌 The internal surface

Three routes, one shared credential (`RYPH_MODEL_PROXY_TOKEN`), mounted **only when that token
is set** — no token means no remote control plane, so the surface does not exist rather than
existing unauthenticated. Between them they answer exactly the questions the orchestrator's
`ModelAccess` port asks, and nothing beyond them: an authenticated route with no caller is a
surface nobody keeps honest.

| | |
| --- | --- |
| `GET /internal/v1/provider-keys/:id` | Metadata only — id, provider, `dialect`, `providerArchivedAt`, `archivedAt`. Enough to validate an agent's policy, and nothing else: not the label, not the last4, and never the sealed secret. The dialect is in there because a provider id no longer implies a wire shape; the endpoint's own archived timestamp is, because a live key can sit behind a withdrawn endpoint and a policy naming one must die at the form rather than at a run's boot. |
| `POST /internal/v1/runs/:id/credentials` | Mints the run's virtual key and returns the container's env map. |
| `DELETE /internal/v1/runs/:id/credentials` | Kills every live credential of a concluded run. Idempotent. |

Issue draws the line the whole link depends on: a **definitive** refusal — unknown provider,
unknown/archived/mismatched key — answers `400`, and every could-not-ask failure answers `503`.
The run boot-fails either way, but only one of them is worth retrying.

### 🛰️ The platform's own credentials

Off-run model calls the platform makes for itself — the memory consolidator's judgement and the
ingest extractor today, any background AI work later — spend a **platform credential**: a virtual
key minted from the admin-set **platform model policy** (`PUT /v1/platform-model-policy`: which
provider key, which models, which one by default; the app's Model keys page sets it) rather than
from any agent's policy, metered and allowlisted like a run's under the principal
`platform:<consumer>`. No service other than the proxy ever holds a real provider key; this is
the reusable pattern decision 4 of the memory proposal names.

`POST /internal/v1/platform/credentials` mints one for a named consumer and is gated by a token of
its own, `RYPH_PLATFORM_TOKEN`: holding it lets a service mint platform credentials and nothing
else, where the control plane's token would also let it issue run credentials and read key
metadata. No policy or an archived key answers `400`, like an issue that can never succeed.

Unlike a run, a platform consumer has no conclusion to be revoked at — it re-mints on every
restart, every expiry and every `401` — so two rules keep the credentials from piling up
indefinitely behind a 24h backstop TTL:

- **One live credential per consumer.** Minting revokes whatever that consumer already held, so
  `platform:memory` is exactly one working token at any moment, never a drawer of them.
- **A policy change revokes every platform credential outstanding.** Setting or clearing the
  policy kills all `platform:*` keys, whichever consumer minted them: they were minted against
  another key and another allowlist, and an edit that left them spending would be no edit at all.
  Each consumer re-mints once on the `401` its next call gets, so the change is invisible except
  in what it is now allowed to spend.

### 💸 Usage and cost

Every forwarded request lands **one `proxy_usage` row**, written when its response body ends — read
to the end, failed mid-stream, or abandoned by the caller — because only then is a stream's usage
known. The row carries what the response itself reported, normalized across the dialects the proxy
forwards (Anthropic Messages, OpenAI Responses — read off the terminal `response.completed`,
`.incomplete` or `.failed` event when streamed — and Chat Completions; JSON or SSE): uncached input,
cache reads, cache writes and the 1h-retention part of them, output and reasoning tokens — plus the
call's duration and the run, agent and task it belongs to. The agent and task are frozen onto the
virtual key at issue time, so no report ever reaches into the control plane's database. Recording
is fire-and-forget, and a response that reported no usage (an error, a models list) is still a row,
with its token columns null.

**A billed call is never $0 because it went unreported** (src/core/usage_fallback.ts). A run
controls whether usage arrives, so the proxy takes that choice away: a streamed Chat Completions
call is forwarded with `stream_options.include_usage: true` (unless a custom endpoint's model
declares pi's `supportsUsageInStreaming: false`); a caller that hangs up does not end the upstream
call, which is read on in the background for up to 60 s (and 64 MiB) until its usage arrives,
holding the run's concurrency slot meanwhile; and a call the provider took (2xx) whose usage
still never came is charged an **estimate** — input at body bytes / 4, base64 media runs at one
token per 750 bytes and at least 1,600 each; output at the request's own `max_tokens` /
`max_output_tokens` / `max_completion_tokens`, else the endpoint's declared maximum, else 32,000.
Reported counts stand (an Anthropic stream cut after `message_start` keeps its exact input). Such a
row has `estimated: true`, and the caps and the ceiling count it like any other.

**Money is never stored.** Reports price tokens at read time from a hand-kept price list,
`src/core/pricing_catalogue.ts` — sourced from the model data of pi-ai 1.5.0, the pi release
the agent image installs, and edited by hand from here on — so a price correction re-prices history
too. A custom endpoint's declared rates arrive as an **overlay** built once per request from the
rows and checked before the catalogue, so a declaration always wins for its own provider id and
neither list can quietly overwrite the other on a deploy. Archived endpoints are in the overlay
too: a report over last month prices rows spent while the endpoint still existed. A price applies
per request (long-context tiers switch on one request's input size), so the store sums tokens per
model and **tier bucket**, and `src/core/usage_report.ts` prices each bucket before rolling
anything up. A declared model is bucketed by the same global thresholds as any other — the
bucketing SQL has no provider predicate — but carries no tiers of its own, so every bucket prices
at its base rates. A model neither
list knows — including one an admin declared without rates — is reported as _unpriced_, never as
free.

| | | |
| --- | --- | --- |
| `GET /v1/model-usage/runs/:runId` | any user | One run's calls, tokens and estimated cost, per model. The app's run page shows it. |
| `GET /v1/model-usage?from=…&to=…` | any user | A window (default the last 30 days, at most 366): totals, and breakdowns by model, by agent (platform work under its consumer), by provider key, by UTC day, and the most expensive tasks. The app's Usage page. |

Both answer `503` with `model_access_disabled` on a deployment without a master key, like key CRUD.

What is static still ships as code — it is just no longer the whole list. `src/core/registry.ts`
holds the two built-ins (how each is dialed and authenticated) and which **dialects** each harness
kind can drive; everything else is a `custom_providers` row projected into the identical
`ProviderSpec`, so nothing downstream asks which kind it got. Built-ins ∪ rows, joined in one
function (`resolveProvider`) and nowhere else.

Model *catalogues* are not stored for the built-ins: the provider list offers a built-in's models
straight from the price list, so the app's pickers have something to show, and any other id can
still be typed. A registered endpoint is the opposite case and therefore does declare its models,
because pi has no catalogue for a provider it has never heard of and the price list cannot guess
what a self-hosted model charges. (Either way the list only offers choices: the agent's allowlist,
not the price list, decides what may be called.)

Each listed model may also carry `thinkingLevels`, the levels of pi's `--thinking` it takes: a
built-in's from `src/core/thinking_catalogue.ts`, hand-kept from the same pi-ai release as the
price list; a ChatGPT plan model's from the efforts its
account's model list names; a custom endpoint's as its admin declared them (the runner hands
them to pi as the model's `thinkingLevelMap`). Nothing is filled in: a custom endpoint's models
come back exactly as stored from every route (list, admin read, create, edit, archive), so one
saved back is its declaration unchanged. Where levels are absent, the app works out what pi will
do: a plan or custom model goes into pi's models.json, where pi gives it `off` alone unless it
reasons and `off` through `high` if it does; a built-in model the catalogue lacks is not known,
so every level is offered. Nothing is refused on these grounds: pi clamps a level to the nearest
one the model takes.

## 🚀 Running

```sh
export RYPH_SECRETS_KEY=$(openssl rand -hex 32)
export RYPH_DB=pglite:./data/ryph
export RYPH_MODEL_PROXY_URL=http://model-proxy:7420     # as an AGENT CONTAINER dials it
export RYPH_MODEL_PROXY_TOKEN=$(openssl rand -hex 32) # shared with the control plane
export RYPH_AUTH_URL=http://orchestrator:7411           # the JWKS key CRUD verifies against

bun run dev            # data plane on :7420, control plane on :7421
```

| Variable | Effect |
| --- | --- |
| `RYPH_SECRETS_KEY` | The AES-GCM master key (64 hex chars). Required — the proxy cannot unseal keys without it |
| `RYPH_DB` | A database URL: `pglite:<path>`, `pglite:memory://`, `postgres://…`. Standalone, this is the proxy's own database (`ryph_keys`) |
| `RYPH_MODEL_PROXY_URL` | The data plane's address **as an agent container dials it** — a container-network address, not this process's bind address. Unset, keys can still be managed; only minting is refused, and it says so |
| `RYPH_MODEL_PROXY_TOKEN` | The shared service credential the control plane presents on `/internal/v1/…`. Unset, that surface is dark |
| `RYPH_PLATFORM_TOKEN` | The credential a platform consumer (the memory service) presents on `/internal/v1/platform/credentials`. Unset, that route is dark and the consolidator runs without a model |
| `RYPH_AUTH_URL` | The @ryph/auth origin whose JWKS gates key CRUD — point it at the **same** one the orchestrator uses, so one user bearer works at both |
| `RYPH_VIRTUAL_KEY_TTL_MS` | Backstop lifetime of a run's virtual key (default 12h). Revocation on conclusion is the primary cutoff |
| `RYPH_MODEL_SPEND_BACKSTOP_MS` | How long a run may sit past its spend cap before the data plane refuses its spending calls itself (default 30s, three reaper sweeps). The orchestrator cancels the run at the cap; this is what remains when it cannot |
| `RYPH_MODEL_SPEND_CEILING_USD` | The deployment's last line on model spend: a rolling ceiling in US dollars at list price. At it, every spending call is refused and no task can start. Unset, no ceiling. In the environment on purpose, so nobody raises it from an admin session |
| `RYPH_MODEL_SPEND_WINDOW_DAYS` | The ceiling's rolling window (default 30) |
| `RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS` | `1` lets a custom endpoint's base URL be plain `http` and/or a loopback/private/link-local address — a LAN vLLM, and nothing else. Read per registration, so it is a deployment's answer and not a build's. Off by default, and the pod's NetworkPolicy still excepts every private range |
| `RYPH_MODEL_PROXY_PORT` | Data-plane port (default `7420`) |
| `RYPH_MODEL_PROXY_CONTROL_PORT` | Control-plane port (default `7421`) — key CRUD and the internal surface. Never expose this to the run network |

The control plane's side of the link is one URL and the same token:
`RYPH_MODEL_PROXY_CONTROL_URL` + `RYPH_MODEL_PROXY_TOKEN`. It deliberately does **not** read
`RYPH_MODEL_PROXY_URL` — the proxy builds the container's env itself, because it is the one
that knows how containers reach it.

Schema lifecycle is the orchestrator's: its `bun run db:push` covers these tables (its
drizzle.config lists this package's schema file).

## 🧪 Commands

```sh
bun run test  # crypto, issuer, enforcement, proxy, metering, pricing, routes, store
bun run ci    # type-check, architecture guard, tests (fmt and lint run from the repo root)
```

## 🔭 Future hardening

The sealed format is versioned (`v2.` today) so the symmetric master key can later give way to
sealing against a proxy-held keypair — making the control plane write-only on secrets: unable
to leak what it cannot read.
