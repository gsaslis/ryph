# @ryph/mcp-gateway 🔌

Tool access for agent runs: **real MCP credentials sealed in one place, run-scoped virtual tokens
everywhere else, and every tool call through a host we own.**

Model keys and git credentials shared a comfortable property: the worst an injected agent could
do with them was spend money or propose a patch. Tools are the channel that lets an agent _act_ —
post a message, create an issue, review a PR — and any tool that sends text anywhere is an
exfiltration channel that egress lockdown cannot close, because it is a sanctioned one. This
package cannot make that go away. It does what the platform has always done: **grant the
narrowest capability, structurally, and make every use of it visible.**

1. An operator registers an **MCP server** (a remote streamable-HTTP endpoint and its bearer or
   header credential) once, centrally. The credential is sealed with AES-GCM before it lands in a
   row and never appears in any API response again — the management surface is write-only on
   secrets. A **probe** connects with the real credential and lists the server's tools, with the
   descriptions the person ticking a tool should read.
2. An agent's blueprint names servers by id together with a **tool allowlist**; a run freezes that
   into a scope. At the run's boot the orchestrator mints one **virtual MCP token** for the run:
   a random token whose hash and frozen scope land in a row. The container receives it, plus one
   gateway URL per server (`/v1/mcp/<runId>/<slug>`), through the runner's boot-time credentials
   fetch — the token as an env var, never in a file.
3. The harness dials "the MCP server" — actually the **gateway data plane**, which authenticates
   the token, checks that the path's run and server agree with the scope, refuses `tools/call` on
   any tool outside the allowlist with a JSON-RPC _method not found_ (indistinguishable from a
   tool that does not exist), filters `tools/list` so the model never sees the rest, forwards with
   the real credential, streams the answer back, and records every call in `mcp_usage`. The scope
   is a **capability** boundary, not just a tool list: every method beyond `initialize`, `ping`,
   the four client notifications, `tools/list` and `tools/call` — `resources/*`, `prompts/*`,
   `completion/*`, `logging/*`, any vendor extension — is **default-denied** without upstream
   ever being dialed, so a run scoped to no tools on a server really has no access to it. What
   reaches upstream is the judged message re-serialised, never the client's bytes.
4. When the run concludes its token is **revoked** — the run itself, so no credential issued for it
   afterwards, even one racing the revocation, works either; a TTL is the backstop. Exfiltrating one from a
   workspace buys an attacker a dead, tool-bounded, run-scoped credential.

Archiving a server is the kill switch: every in-flight run scoped to it loses access on its next
call — liveness of the server row is deliberately the one _live_ check in an otherwise frozen
scope. Rotating a credential replaces it under the same id, and in-flight runs pick the new one up
on their next call, which is what rotation is for.

## 🧭 Control plane vs data plane

The model-proxy's silhouette, one credential class over (the full treatment — ports, adapters,
the credential's life, the token's life, the data plane's two inspections — is
[docs/architecture.md](docs/architecture.md)):

- **Control side.** Server CRUD, the probe, and the usage trail on the user surface, and the
  issuer that mints a run's token. In the single process the host calls this package's `setup()`
  and spreads the routes into its own router. Standalone, `src/main.ts` serves them on their
  **own control listener** (`:7431`) — plus `/internal/v1/…`, the service-authed surface a remote
  control plane dials instead of holding an in-process issuer.
- **Data side — its own listener, always.** Agent containers dial it over the network in every
  deployment; `src/main.ts` serves it on `:7430`. It is a reverse proxy with exactly two
  inspections (the request's method and tool name; the `tools/list` response), and it holds no
  state a user created: delete and redeploy it freely.
- **The seam between the two halves is the shared store**, not an API: the control side writes
  `mcp_servers` and `mcp_virtual_keys`, the data side reads them per request and appends
  `mcp_usage`.

### 🔒 The master key lives here

`RYPH_MCP_KEY` seals MCP credentials, and **only this package's two halves ever hold it**. The
model-proxy's `RYPH_SECRETS_KEY` is a different key for a different secret class: a compromise
of one process opens one class. The single-process deployment ([@ryph/host](../host/README.md),
and the `ryph` binary built on it) defaults this key to `RYPH_SECRETS_KEY` — one process is one
trust domain — while
keeping the seam real for a deployment that later splits: set `RYPH_MCP_KEY` separately there and
nothing already sealed has to be re-keyed when the gateway moves out.

### 🛡️ Where the gateway may dial

The gateway forwards to operator-supplied URLs with operator-supplied credentials, which makes it
a confused-deputy and SSRF target by construction. So by default an upstream must be a **public
https host**: loopback, link-local, RFC 1918, the CGNAT range, the documentation and
benchmarking ranges (198.18.0.0/15 is routed internally in some networks), multicast, anything
outside IPv6 global unicast, `localhost`, and any name that resolves to one of those are refused —
at registration (a `400` the operator sees), at probe time, and again before every forward, cached
briefly, so a name that changes its mind is caught on the next call. Redirects are **never
followed**, by the data plane or the probe: the guard judged the registered URL, and a public host
answering `307` to a private one would otherwise carry the credential past it. The probe names the
redirect so the operator can register its target. `RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS` opens the ranges for deployments
whose servers are internal; `RYPH_MCP_ALLOW_INSECURE` permits plain http. Both are logged when
set.

### 🧰 Hosted servers

Most of the ecosystem ships MCP servers as a local binary, not a URL. For those the gateway runs
the server itself: the operator picks a hosted **catalogue** entry (Grafana, today), answers its settings
(the Grafana URL, read-only or not), pastes its secret (a service-account token), and the gateway
launches the vendor's digest-pinned image on `ryph-tools` — a network that confines it, which no
agent container and no service of ours joins — fronted by the **tool guard**, waits until it answers, and lists its tools in the same picker as
any remote server. The credential **never enters the container**: the catalogue is headers-only,
so it stays sealed here and rides each call exactly as a remote server's does.

- **What the operator may type.** A row's URL is minted by the gateway, never typed; a `url`
  setting (the Grafana URL) is, and meets the same public-`https` rule as a remote upstream —
  including the two flags, and on every edit — because it rides each call as a sealed header
  beside the credential.
- **Where it runs.** In the single-process deployment, on the backend agents run on: docker,
  through the docker launcher. Under `manual` hosting is unavailable and the catalogue
  says why. The standalone gateway holds the master key, so it is never handed a container socket.
  It takes `RYPH_TOOL_HOST=launcher`, which hosts through a docker launcher at `RYPH_LAUNCHER_URL`
  with a token that opens only the launcher's tool routes, or `RYPH_TOOL_HOST=kubernetes`, where a
  Deployment and a Service per server, in a namespace its Role reaches and nothing else does,
  replace the socket.
- **How a run is kept out, and the server kept in.** The tools network, which confines on both
  backends: under docker the launcher makes it internal with no gateway on the docker host (and
  refuses to host where the engine cannot), so a vendor's container reaches the guard and its egress
  relay and nothing else — the relay going to the egress proxy's tool listener, which opens any
  public host on any port to the claim this gateway mints per launch (`RYPH_EGRESS_TOOL_KEY`) and
  never a private address. The guard — the one container also on an ordinary network, running the
  launcher's own image, the only one ever published and only on `127.0.0.1`, answering nothing
  without a token minted at every gateway boot. And a per-launch caller token the server itself
  demands and only the guard presents — what keeps hosted servers out of one another, and what holds
  under OrbStack, whose networks do not isolate (measured). Every hosted container gets one: a
  catalogue entry names the env var its image reads it from or opts out in writing
  (`callerAuth: { none: true, reason }`, a line a reviewer weighs), and a custom container must name
  one — nobody reviews an image an operator named minutes ago. On Kubernetes the first layer is a
  real one: NetworkPolicies deny the tools namespace from both ends, nothing is published because
  the gateway is in the cluster, and the caller token becomes the second line it was always meant
  to be.
- **How it is kept honest.** A row's status is `starting · healthy · unreachable · stopped`, and
  `update-available` when the catalogue's pinned digest moves past the row's. A supervisor probes
  healthy rows and relaunches unreachable ones on a doubling backoff; containers run with no
  restart policy, so a crash is a status and not a loop (on Kubernetes the kubelet does restart a
  crashing pod, on its own backoff — the row still reads unreachable, which is the part that
  matters). A deployment hosts at most `RYPH_TOOL_MAX_SERVERS` of them at once (16 by default)
  — each is a capped container on the control plane's own machine, so a create past the ceiling
  is a `409` rather than an OOM. Boot reconciles rows against the backend BOTH ways — every live
  row gets its container back, and every container of ours (the `ryph.tool` label) that no live
  row accounts for is removed, which is the only thing that ever sees an archive whose stop did
  not land. A clean exit removes every container and the guard — the rows stay, and the next boot
  relaunches them.
- **The catalogue** is one JSON file per entry under [`catalogue/`](catalogue/), validated at load
  by a strict schema (no mounts, no privileges, digest-pinned, headers-only) and covered by a test
  that launches every hosted entry against a fake host and renders every remote preset's URL. A
  new entry is a JSON file and a review.

What is deliberately deferred (per-run instances, env-delivered credentials and stdio bridging) is
below; where each piece lives is in [docs/architecture.md](docs/architecture.md#-hosted-servers).

### 🧭 Remote presets

Most vendors now run their official MCP server themselves, at a URL. For those the catalogue holds
a **remote preset** rather than an image: the vendor's endpoint, the few settings that shape it (a
region, a project, read-only), and the header its static key rides in. Picking Linear, Sentry,
Atlassian, Datadog, PagerDuty, Stripe or Supabase asks for those settings and the key, and creates
an ordinary remote row — no container, so presets work wherever remote servers do, including
deployments that cannot host.

- **What the operator may type.** Never the host. A preset's URL is a reviewed template; a
  `choice` setting (a Datadog site) picks among reviewed hosts, and a `text` setting (a Sentry
  org) reaches the path or query only after matching the entry's anchored pattern, percent-encoded.
  The rendered URL then meets the same public-`https` rule as any remote upstream, at create and on
  every settings edit. A settings edit that moves the server's URL **at all** (a region, a project
  in the path) needs the credential again in the same request, as a hand-registered row's
  `PATCH url` does: the key was sealed for the URL it was given for.
- **What an agent is offered.** Each entry lists `defaultOff`: the write, destructive and
  money-moving tools. The agent form starts a newly added server with everything else ticked.
  Advice, not enforcement — the saved allowlist is what the data plane holds a run to.

The entries, what each one exposes and why its defaults are what they are, are in
[`catalogue/README.md`](catalogue/README.md). Vendors whose hosted server takes OAuth only (Notion,
Figma) wait for OAuth brokering.

### 🧠 Platform servers

A third kind beside `remote` and `hosted`: a server the **platform itself** provides — the memory
service's MCP route, the chat service's, the forge's tool surface, and the web service's. Each row
is seeded at boot when the deployment names the service (`RYPH_MEMORY_URL` with
`RYPH_MEMORY_GATEWAY_TOKEN`, `RYPH_CHAT_URL` with `RYPH_CHAT_GATEWAY_TOKEN`, `RYPH_FORGE_TOOLS_URL`
with `RYPH_FORGE_GATEWAY_TOKEN`, `RYPH_WEB_URL` with `RYPH_WEB_GATEWAY_TOKEN`; the single-process
host wires memory, chat and web in-process with tokens minted at boot, and dials the forge — always
its own process — at its URL), carries a `platform://memory`, `platform://chat`, `platform://forge`
or `platform://web` marker instead of an address, and is never edited, probed or archived through
the API (`409`, `platform_managed`). The data plane forwards to the configured address with the
gateway's own credential and the run's id in `x-ryph-run-id` — a header the inbound allowlist never
carries, so a container cannot set it — and the service trusts this gateway for exactly one claim:
which run is calling. The orchestrator adds the memory row to every remembering agent's tool scope
by default (an agent's policy may name it to narrow its tools), and the chat row to a run that a
response bound to a chatroom — its one tool, `chat__post`, posts into the team's incident room. The
forge row joins a run only through the agent's forge policy, with an allowlist derived from it; a
tool policy naming `ms-platform-forge` is refused. The web row ([@ryph/web](../web/README.md)) joins
every tool-capable agent's runs by default wherever the deployment serves it, the way memory's does
— an agent's tool policy may name it to narrow it to one of its two tools, or give it an **empty
allowlist**, which is the per-agent opt-out: untick every tool on the row in the agent form (the
form allows that for a platform row precisely because its rows are granted by default, and refuses
it for an operator's server, where removing the row says the same thing), and the row stays in the
frozen scope while this gateway denies every tool on it and hides all of them from `tools/list`. A
deployment that wants no web access at all unwires the service — `RYPH_WEB_URL` unset here, or
`RYPH_WEB_TOOLS=off` under the single binary, where this gateway and that service are one process.
It is the one platform server whose tools read something nobody here wrote, which is why everything
it returns arrives framed as untrusted third-party text.

If an operator's own server already holds one of the platform slugs (`memory`, `chat`, `forge`, `web`), the seed cannot place the
row — and
the gateway **logs the conflict and keeps serving** rather than exiting. The remedy (archive the
server holding the slug, then restart) is a call to the management surface this very process
serves, so failing the boot would take the fix down with the fault. Until it is fixed the platform
upstream stays unwired: the row is absent from the agent form, and a run whose frozen scope still
names it gets the data plane's `502`, which says the same thing.

### 🔌 The internal surface

Four routes, one shared credential (`RYPH_MCP_GATEWAY_TOKEN`), mounted **only when that token
is set**. Between them they answer exactly the four questions the orchestrator's `ToolAccess`
port asks:

| | |
| --- | --- |
| `GET /internal/v1/mcp-servers/:id` | Metadata only — id, slug, name, `archivedAt`. Enough to validate an agent's tool policy, and nothing else: not the URL, not the last4, and never the sealed credential. |
| `POST /internal/v1/runs/:id/mcp-credentials` | Mints the run's token and returns `{ token, servers: [{ slug, name, url }] }` — what the harness config needs. |
| `DELETE /internal/v1/runs/:id/mcp-credentials` | Kills the run's live token. Idempotent. |
| `POST /internal/v1/mcp-servers/:id/archive` | The kill switch, with no question asked: the control plane fronts it as `POST /v1/mcp-servers/:id/archive` and refuses there while an agent's tool policy still names the server. Idempotent; the slug is freed for reuse; a hosted server's container is stopped and removed. A platform row is refused (`409`, `platform_managed`). |

Issue draws the line the whole link depends on: a **definitive** refusal — unknown or archived
server, an empty or duplicated scope — answers `400`, and every could-not-ask failure answers
`503`. The run boot-fails either way, but only one of them is worth retrying.

## 🚀 Running

```sh
export RYPH_MCP_KEY=$(bun -e 'console.log([...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,"0")).join(""))')
export RYPH_DB=pglite:./data/ryph
export RYPH_MCP_GATEWAY_URL=http://mcp-gateway:7430      # as an AGENT CONTAINER dials it
export RYPH_MCP_GATEWAY_TOKEN=$(openssl rand -hex 32)    # shared with the control plane
export RYPH_AUTH_URL=http://orchestrator:7411            # the JWKS server CRUD verifies against

bun run db:push        # once, against a fresh database
bun run dev            # data plane on :7430, control plane on :7431
```

| Variable | Effect |
| --- | --- |
| `RYPH_MCP_KEY` | The AES-GCM master key (64 hex chars). Required — the gateway cannot unseal credentials without it |
| `RYPH_DB` | A database URL: `pglite:<path>`, `pglite:memory://`, `postgres://…`. Standalone, this is the gateway's own database (`ryph_mcp`) |
| `RYPH_MCP_GATEWAY_URL` | The data plane's address **as an agent container dials it**. Unset, servers can still be managed and probed; only minting is refused, and it says so |
| `RYPH_MCP_GATEWAY_TOKEN` | The shared service credential the control plane presents on `/internal/v1/…`. Unset, that surface is dark |
| `RYPH_AUTH_URL` | The @ryph/auth origin whose JWKS gates server CRUD — the **same** one the orchestrator uses |
| `RYPH_MCP_VIRTUAL_KEY_TTL_MS` | Backstop lifetime of a run's token (default 12h). Revocation on conclusion is the primary cutoff |
| `RYPH_MCP_PER_RUN_REQUESTS` | Every request one run may make through the data plane, denied calls included (default `10000`). Past it: `429`, and nothing is dialed |
| `RYPH_MCP_HOSTING_STARTUP_TIMEOUT_MS` | How long a hosted server gets to answer after a launch before it reads unreachable (default 5 min: on Kubernetes the pod may first wait for a node) |
| `RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS` | Permit upstreams in private, loopback and link-local ranges |
| `RYPH_MCP_ALLOW_INSECURE` | Permit plain `http://` upstreams |
| `RYPH_TOOL_MAX_SERVERS` | How many hosted servers a deployment may have at once (default 16) — read by the mounting host, since it is the one that runs containers |
| `RYPH_TOOL_HOST` | Where hosted servers run: `launcher` (a docker launcher), `kubernetes`, or unset for no hosting |
| `RYPH_LAUNCHER_URL` | With `RYPH_TOOL_HOST=launcher`, where the docker launcher listens. Required there. The tools network and everything else about the containers are the launcher's settings, and setting them here (`RYPH_TOOL_NETWORK`, `RYPH_DOCKER_RUNTIME`, `RYPH_TOOL_GUARD_IMAGE`, `RYPH_TOOL_EGRESS_TARGET`) fails the boot |
| `RYPH_LAUNCHER_TOOLS_TOKEN`, `RYPH_LAUNCHER_TOOLS_TOKEN_FILE` | With `RYPH_TOOL_HOST=launcher`, the launcher's tool-host token, or a file holding it. Required there. It opens the launcher's tool routes and none of its run routes |
| `RYPH_TOOL_GUARD_IMAGE` | The tool guard fronting hosted servers. Required with `RYPH_TOOL_HOST=kubernetes`; with `launcher` it is the launcher's, which says it at connect |
| `RYPH_EGRESS_TOOL_KEY` | Hex, ≥ 32 characters: what hosted servers' egress claims are signed with, the egress proxy's tool listener holding the same; never `RYPH_EGRESS_KEY`'s value. Required with `RYPH_TOOL_HOST=launcher` when the launcher relays hosted servers to the proxy (its `RYPH_TOOL_EGRESS_TARGET` is not `off`) |
| `RYPH_MCP_GATEWAY_PORT` | Data-plane port (default `7430`) — reachable from the run network |
| `RYPH_MCP_GATEWAY_CONTROL_PORT` | Control-plane port (default `7431`) — server CRUD and the internal surface. Never expose this to the run network |

The management surface, mounted at `/v1/mcp-servers` (and `/v1/mcp-usage/:runId` for a run's
tool-call trail). **Managing a server is admin-only**; listing is not — see below.

| Route | Who | What |
| --- | --- | --- |
| `GET /v1/mcp-catalogue` | any user | What can be set up — each entry's `kind` (`hosted` or `remote`), settings and secret fields, its pinned image or vendor host, and its `defaultOff` tools — plus `hostingAvailable` and, when false, the reason (remote presets are listed either way). |
| `POST /v1/mcp-servers` | admin | Register a remote server: `{ slug, name, description?, url, auth: "none" }`, or `auth: "bearer", secret`, or `auth: "headers", headers: {…} }`. Or from a remote preset: `{ kind: "remote", catalogueId, name, settings, credential: { <header>: <secret> }, slug? }`. Or host one: `{ kind: "hosted", catalogueId, name, settings, credential: { <header>: <secret> }, slug? }` (slug derived when omitted), or `{ kind: "hosted", custom: { image, command, port, path }, slug, name, auth, … }` with a digest-pinned, HTTP-speaking image. A hosted create answers `201` at once with `host.status: "starting"`. The credential arrives here and never comes back. |
| `GET /v1/mcp-servers`, `/:id` | any user | Metadata plus `authLast4`, `kind` (`remote`, `hosted`, or the platform's `platform`), and for hosted rows `catalogueId`/`custom`, `settings` and `host`; never a credential. |
| `PATCH /v1/mcp-servers/:id` | admin | Rename, redescribe, repoint, and/or rotate the credential under the same id (the same `auth` + `secret`/`headers` shape as create). Moving the `url` of a remote server that carries a credential **requires the credential again in the same request** (`400`, `credential_required`, otherwise). A remote preset row takes `settings` and `credential` instead of `url` and `auth`; settings that move its URL at all need `credential` too. A hosted catalogue row takes `settings` (a change relaunches its container) and `credential` (a rotation, which touches no container); any setting change other than a toggle needs `credential` too, since the container may send it there. A stored credential that no longer opens (`409`, `secret_required`) is entered again with `credential`. An edit of the credential, url or settings lands only while the row still has the credential and destination it was read with (`409`, `server_changed`: send it again). A hosted row's URL is minted, never patched. |
| `POST /v1/mcp-servers/:id/probe` | admin | Connect upstream with the real credential — `initialize`, `tools/list` — and return `{ ok: true, tools: [{ name, description, annotations }] }` or `{ ok: false, reason: "credential_rejected" \| "secret_required" \| "unreachable" \| "protocol" \| "policy", detail, code? }` — `code` the data plane's `hosted_*` refusal when a hosted row's route is why. Never stores anything. An archived server is refused (`409`, `server_archived`). |
| `POST /v1/mcp-servers/:id/restart` | admin | Hosted only: relaunch the container, keeping the digest it runs — or `{ "updateImage": true }` to move to the one the catalogue pins today. |
| `GET /v1/mcp-servers/:id/logs?tail=n` | admin | Hosted only: the container's last `n` lines (200 by default, 1 000 at most). Never its env; the row's secret values are redacted as a backstop. |
| `GET /v1/mcp-usage/:runId` | admin | One page of the run's trail: `{ usage, nextCursor, hasMore }`, oldest-first within the page. `?limit=` (1–200, default 200) and `?cursor=` walk **backwards from the newest call** — there is no unbounded read, because how many rows a run has is the agent's decision. |

### 👮 Who may manage a server

**Registering, repointing, rotating, re-settling, archiving, restarting and probing a server are
`tools:manage`** (in the verified @ryph/auth token's `caps`), as are a container's logs and a
run's tool-call trail. Each of those either holds an org credential, aims one somewhere, or decides
which image is trusted with it: a `PATCH url` followed by a `probe` is, in one pair of calls,
"decrypt the org's Linear token and send it to a host I picked". A verified user without it is
told so with a `403` whose code is `forbidden` and whose `capability` names it: they are who they
claim, and may not. **Listing servers and reading the catalogue take `tools:read`**, because the
agent form every member fills in needs the names and the tools.
`RYPH_AUTH=off` is the same total bypass it is everywhere.

Three rules narrow the credential's reach further, inside the admin surface:

- **Repointing a credentialed server requires the credential again** in the same request. Moving a
  URL is then an explicit act on the secret, not an edit that quietly re-aims one. Dropping it
  (`auth: "none"`) counts as supplying one: nothing follows the URL anywhere.
- **A hosted server has no URL to re-aim.** Its `url` is a marker (`hosted://<slug>`) that nothing
  dials, and a `PATCH` naming one is refused. Its address is its **launch key**: a hash of exactly
  what its credential is bound to (the row's id, slug, catalogue entry or image, settings), the
  image digest it runs, and a custom image's caller-auth env var. The container is named `ryph-tool-<key>` and nothing else ever runs under
  that name; the tool guard routes `/<key>/mcp` to that container and no other; and the data plane
  and the probe compute the key from the row as it stands right before they dial. A row edited,
  reverted or swapped in the database, a stale route, or a launch that failed or was overtaken can
  only make the key unserved, never deliver the credential to a container launched from anything
  else.
- **An archived server is never probed.** The kill switch is meant to be total, and the probe is
  the one other place the real credential goes out.

The codes a client may meet on a server's credential, on the data plane and the management
surface alike:

| Code | Status | Meaning |
| --- | --- | --- |
| `credential_required` | 400 | This edit moves where the credential goes — a URL, or a hosted setting other than a toggle — and must carry it again. |
| `server_changed` | 409 | The row's credential or destination changed while this edit was being saved; nothing was written. Send it again. |
| `secret_required` | 409 | The stored credential is missing or does not open for the row as it stands (moved in the database); an admin enters it again. The probe says `reason: "secret_required"`. |
| `credential_header_refused` | 502 | The stored credential names a header that steers the request, or a value that is not visible ASCII with single spaces between words; entered again through the API, which refuses both, it is fixed. Never quotes a value. |
| `hosted_stale` | 503 | This gateway's launch for the row was made from other inputs than the row has now (its settings, image, slug or digest changed), so the row's own launch key is not served yet. Nothing is sent; the supervisor relaunches from the row as it stands — ask again shortly. |
| `hosted_starting` | 503 | The row's launch key is not served yet but a launch is coming by itself: hosting still booting, waiting for the lease a departing gateway holds, shutting down or handing over after a lost lease, the row starting or due a backoff relaunch, or the guard not yet relaunched with its route. Also a connection the guard refused or whose name did not resolve (never a timeout or a reset) for a row still `starting`, while the guard is being relaunched, or within 10 s of the route being set or the guard relaunched — a heuristic for a guard still coming up. Ask again shortly. |
| `hosted_not_running` | 502 | Nothing is routed and nothing is coming: hosting is off or broken here, the row is stopped or archived, or its launch cannot be derived from it (also when an older launch of it is still routed). The message says which. |

The pi-mcp extension retries the two `503`s for about a minute and fails at once on the `502`s.

Without a master key the same paths carry a `mcp_disabled` stand-in, so "tools are off" is an
answer and never a `404`. A gateway that cannot host answers `503 hosting_unavailable`, with the
reason, on the hosting-only paths — remote servers work exactly as before.

## 🧪 Commands

```sh
bun run test    # enforcement, framing, the guard, issuer, data plane, routes, probe, store, an
                # end-to-end run with the real MCP SDK on both ends and the gateway between, and
                # hosting: the lifecycle on a fake host, both adapters' argv, the catalogue, and
                # the tool guard's own program over real loopback sockets
bun run ci      # type-check, architecture guard, tests (fmt and lint run from the root)
```

## 🔭 What it deliberately does not do yet

**Hosting is shared, headers-only, and local.** One long-lived container per hosted server, never
one per run; credentials delivered per request, never into a container's env; stdio servers not
bridged; hosting on docker and Kubernetes only. Each is its own follow-up, and the `ToolHost` port's
`lifetime` field and the catalogue's `delivery` literal are where they slot in. Local
credential-free servers inside the run container, and OAuth brokering (the gateway as the OAuth
client, refreshing and re-sealing), remain the next phases; approval-gated tools — parking a
`tools/call` until a human says yes — the phase after that.
