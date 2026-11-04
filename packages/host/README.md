# @ryph/host

The single-process local deployment: one composition root that builds every service-shaped
module into one process. `bun run up` (here or from the workspace root) serves:

- the **control plane** on `:7411` — the orchestrator's user and runner surfaces, with
  [`@ryph/auth`](../auth/README.md)'s routes, [`@ryph/model-proxy`](../model-proxy/README.md)'s
  key CRUD, [`@ryph/mcp-gateway`](../mcp-gateway/README.md)'s MCP server CRUD, and
  [`@ryph/historian`](../historian/README.md)'s run-history surface mounted into the same router;
- the **model-proxy data plane** on `:7420` — its own listener, because agent containers dial
  it over the network in every deployment (dark without `RYPH_SECRETS_KEY`);
- the **mcp-gateway data plane** on `:7430` — its own listener for the same reason: it is what
  agent containers dial as "the MCP server" (dark without `RYPH_MCP_KEY`, which defaults to
  `RYPH_SECRETS_KEY`).

With the `docker` provisioner the gateway also **hosts** MCP servers from its
catalogue (Grafana's, today) through the same docker launcher the runs use: at boot the launcher
makes the `ryph-tools` network (internal, its gateway isolated, as a confined run's) and the egress
relay beside it, the gateway launches the tool guard and reconciles the hosted rows, and a supervisor
rides its own interval beside the reaper. On the way down the drain removes those containers and
the guard (the rows stay, and the next boot relaunches them); runs, by contrast, keep going and
report to the next boot, unless `ryph up` was asked to cancel them. This process already reaches
the launcher for runs, so hosting grants it nothing new. A hosted server's one way out is the
egress relay to this process's egress proxy on a second port (`RYPH_EGRESS_TOOL_PORT`, 7461), which
opens any public host to the claim the gateway signs for it and never a private address — so it
reaches its vendor's API and nothing of this machine, its LAN or ryph's listeners. The standalone gateway hosts through a
launcher too, with `RYPH_TOOL_HOST=launcher` and the launcher's tools token. See
[@ryph/mcp-gateway](../mcp-gateway/README.md#-hosted-servers).

Upgrading from a version before the docker launcher: hosted-server containers and the tool guard it
left running lack the deployment label, so the new launcher will not replace them, nor remake the
plain `ryph-tools` network an older version made while they are on it. Stop `ryph`, and with no
other ryph running on this engine remove them once:
`docker ps -aq --filter label=ryph.tool.network=ryph-tools | xargs -r docker rm -f`.

Three things are deliberately **not** in here. The runner is a spawned container that talks HTTP
in every deployment — composing it in would erase the one boundary that must stay
network-shaped. The web app ([`@ryph/app`](../app/README.md)) is a SvelteKit/Node runtime;
run it in a second terminal: `cd packages/app && npm run dev`.

The forge ([`@ryph/forge`](../forge/README.md)) is the one service that can go either way.
In a networked deployment it is its own process, for three reasons. Agent containers dial it
directly — they clone through it and hand their work back to it — so mounting it here would not
remove the network boundary. It is also a different secret domain: it holds the GitHub App's
private key, installation tokens, the GitLab bot's token, and the webhook secrets, while this
process holds the control-plane database, auth sessions, and `RYPH_SECRETS_KEY` — and it is the
surface that takes hostile input (raw git wire protocol, large bundle uploads, webhook payloads
authored by anyone who can open an issue). And it needs different powers: this process runs
`docker`, the forge runs `git` and writes a repo cache to disk, and merging them would grant the
control plane both. This host dials it over HTTP then, via `RYPH_FORGE_URL` and `RYPH_FORGE_TOKEN`.

On one person's machine none of that buys anything — the secret is the owner's own, and this
process already runs `git` — so `RYPH_FORGE_URL=embedded` mounts it here instead, on its own
listener (`RYPH_FORGE_PORT`, default `7412`) because runs still dial it. The shared tokens are
minted per boot, the gateway address a run dials defaults to `RYPH_PUBLIC_URL`'s host on the
forge's port, and its mailroom shares the hooks table the automations keep in the one database.
Every other forge variable keeps its meaning; `RYPH_LOCAL_REPO_ROOT` is read here, checked, and
handed to it. The `ryph` binary makes this the default.

Beside an in-process forge, `RYPH_RADICLE_URL=embedded` mounts the Radicle bridge
([`@ryph/radicle`](../radicle/README.md#-user-mode)) here too, in **user mode**: over your own
Radicle identity and the `radicle-node` you already run (`RAD_HOME`, default `~/.radicle`), so
ryph acts as you on Radicle. It listens on loopback only, on an ephemeral port, and its bearer is
minted per boot and handed to the forge in memory, never through the environment. Its events go
to the forge's mailroom; its cursors and the repositories you connected live in the one database.
Since every write there is signed as you, only `repos:manage-all` may connect a Radicle
repository, and every boot drops repositories the bridge tracks that nothing has connected.

This package is pure composition — no `core/`, no ports, no adapters, and no architecture
guard, because there is nothing to fence. Each mounted package exports a `setup()` that
performs its startup work and returns its routes and services; this root builds the shared
stores, calls each `setup()`, and passes the cross-wiring. Each service package keeps its own
`src/main.ts` as the standalone composition root; the networked deployment is a wiring change
here, not a refactor there.

## Automatic Docker artifact thumbnails

With the Docker provisioner the released binary renders artifact thumbnails in disposable
browser-image containers, independently of the interactive browser sidecar. Explicit
`RYPH_ARTIFACT_THUMBNAIL_URL` or `RYPH_ARTIFACT_THUMBNAIL_SOCKET` configuration takes precedence.
Otherwise `RYPH_ARTIFACT_THUMBNAIL_IMAGE` selects the image (`off` disables automatic rendering),
then an explicitly named `RYPH_BROWSER_IMAGE`, then the browser image pinned to the binary's
release. `RYPH_BROWSER_IMAGE=off` does not disable thumbnails. Source checkouts have no default
browser image: name a locally built image to opt in.

The host checks the local image cache and, only if absent, warms it with a bounded background
pull. Startup does not wait for this optional feature; requests while warming are unavailable
and retry later. The pull is separate from the short rendering budget, so cold image downloads
are not restarted every time a thumbnail times out. Failed pulls retry on subsequent requests.
A failed container exit invalidates the warmed-image state, so an image pruned after startup
is reinspected and pulled again if absent.

Each render sends at most 24 MiB of HTML over stdin and reads at most 4 MiB of PNG. Containers
have no network, host mounts or credentials, run as uid/gid 1994, drop all capabilities, have a
read-only filesystem, writable bounded `/tmp` and `/dev/shm`, and CPU/memory/PID limits. Proxy
environment variables (uppercase and lowercase) are explicitly empty, overriding Docker client
config proxy injection without removing host-side registry authentication. They use
`bun --no-env-file src/thumbnail_cli.ts`; there is no shared socket to mount across Docker
Desktop's VM boundary. Abort, timeout and shutdown kill the client and explicitly issue bounded
`docker rm --force` by unique container name; `--rm` also removes normally completed containers.
For incomplete renders, not-found removals are retried across a bounded three-second window:
a daemon create request can outlive the killed attach client. If Docker is unreachable or its
creation arrives after that window, cleanup is best-effort, not a guarantee against daemon failure.

**Chromium's sandbox is required, without fallback.** The embedded, attributed Playwright
seccomp profile allows user-namespace creation, a `clone3` ENOSYS fallback and namespace-local
`chroot`, without granting outer capabilities or disabling seccomp. `RYPH_DOCKER_RUNTIME` is
honoured (for example a configured gVisor runtime). The Docker host kernel must permit
unprivileged user namespaces; an AppArmor policy can independently prohibit them. Such hosts
fail closed and log an actionable warning. Configure an appropriate confined runtime/host
policy rather than passing `--no-sandbox`, `--privileged`, `SYS_ADMIN` or disabling AppArmor.
Focused tests exercise process arguments, bounds, cancellation, removal and selection with a
fake Docker executable. To verify the actual sandbox, CLI and Docker Desktop transport with an
already-built browser image (this test never pulls an image):

```sh
RYPH_TEST_THUMBNAIL_IMAGE=ryph-browser:dev bun test packages/host/tests/artifact_thumbnail_docker_test.ts
```

The smoke test is skipped unless that variable is set. It fails if Chromium cannot start its
sandbox on the Docker host; do not disable the sandbox to make it pass.

## Running

```sh
bun run db:push   # every mounted module's tables, in one database
bun run up
```

One push, one database. This package's `drizzle.config.ts` lists the orchestrator's, auth's,
model-proxy's, mcp-gateway's **and** the historian's schema files, because in this deployment they all share one
PostgreSQL instance — embedded via PGlite by default, so nothing needs installing. The standalone
deployments push their own schemas from their own packages instead.

Sharing one instance is not just thrift. Every module takes a schema-scoped view of a *single*
connection, because opening the same PGlite data directory twice **succeeds and then silently
diverges** — two engines over one set of files, last close wins.

The historian can still be given a database of its own by setting `RYPH_HISTORY_DB` (push it
with `bun run db:push:history`, backed by `drizzle-history.config.ts`). Unset is the default:
its transcript tables live alongside the rest. Under SQLite the split was load-bearing — a single
writer lock meant the firehose blocked control-plane writes — but under one Postgres these are
separate MVCC connections, so the split becomes a deployment choice rather than a requirement.

## Environment

All variables keep the same names, defaults, and semantics as the standalone services
(the per-package docs own the details):

| Variable                                        | Default            | Role                                                        |
| ----------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| `RYPH_PORT`                                     | `7411`             | Control-plane port                                          |
| `RYPH_MODEL_PROXY_PORT`                         | `7420`             | Model-proxy data-plane port                                 |
| `RYPH_MCP_GATEWAY_PORT`                         | `7430`             | MCP-gateway data-plane port                                 |
| `RYPH_DB`                                       | `pglite:./data/ryph` | The one database every mounted module shares: `pglite:<path>`, `pglite:memory://`, or `postgres://…` |
| `RYPH_HISTORY_DB`                               | —                  | Gives the transcript a database of its own; unset, it shares `RYPH_DB` |
| `RYPH_AUTH`                                     | on                 | `off` opens the user surface (local hacking)                |
| `RYPH_MULTIUSER`                                | off                | `on` lets several people use the instance; its first registration then needs the setup token logged at boot. Off, the owner is made at boot (named from git) and signs in by a one-time login link, and registration, invites, org join and user management are refused. The networked control plane defaults it on |
| `RYPH_BIND_SCOPE`                               | unset             | Set to `container` only for an isolated container network namespace (not host networking). Logs wildcard `RYPH_BIND` at INFO with container-network exposure wording; unset or any other value retains WARN. Changes logging only, not listeners or access controls. Host exposure still depends on published ports and network configuration |
| `RYPH_BIND`                                     | `127.0.0.1`        | Comma-separated addresses the control plane, the model proxy and the embedded forge listen on, besides loopback, which they always bind unless `0.0.0.0` or `::` covers it. The address this machine's runs dial is detected at every boot and bound too, so it never needs listing: a native Linux engine's docker bridge (nothing on Docker Desktop, which forwards to loopback). List others here. Required with `kubernetes` runs, which call in from outside |
| `RYPH_ALLOWED_HOSTS`                            | —                  | Host names the control plane answers to beyond loopback's, `host.docker.internal`, the bind addresses and the URLs it hands out, comma-separated: a name, `host:port`, an IPv6 address bare or bracketed, or a URL; `*` turns the check off |
| `RYPH_PROXY_SECRET`                             | unset              | Set on this and the app alike, `x-client-ip` counts only from the app. Required with `RYPH_MULTIUSER=on`. The binary mints one per launch |
| `RYPH_SECRETS_KEY`                              | unset              | The model-proxy's master key, sealing provider secrets; unset keeps model access and the data plane dark |
| `RYPH_MCP_KEY`                                  | `RYPH_SECRETS_KEY` | The mcp-gateway's master key, sealing MCP server credentials — the third secret class, defaulted like the OAuth key. Set it separately only to keep a later split of the gateway from re-keying. With neither set, tool access is dark: the server management surface answers `mcp_disabled`, agents with a tool policy are refused, and the gateway data plane never starts |
| `RYPH_MODEL_PROXY_URL`                          | `http://localhost:7420` | The model-proxy data plane's address as seen from an agent container — `host.docker.internal` under Docker Desktop |
| `RYPH_MCP_GATEWAY_URL`                          | `http://localhost:7430` | The mcp-gateway data plane's address as seen from an agent container, same rule |
| `RYPH_MCP_GATEWAY_HOST`                         | `127.0.0.1`        | The interface that data plane binds — the one listener here that is loopback by default, because it is the one that opens on an *upgrade* rather than on a configuration change. A containerised runner dials the host from outside its loopback, so that deployment sets this to `0.0.0.0` alongside a `RYPH_MCP_GATEWAY_URL` a container can reach; `ryph config` shows both as resolved, and the status block reports the bind address |
| `RYPH_MCP_ALLOW_INSECURE`, `RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS` | off | Widen where the gateway may dial from public `https` hosts only to plain `http` and to private, loopback and link-local ranges. An MCP server on this machine needs both. Each is logged at boot when set |
| `RYPH_MCP_VIRTUAL_KEY_TTL_MS`                   | `43200000` (12 h)  | Backstop lifetime of a run's virtual MCP token; revocation on conclusion is the primary cutoff |
| `RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS`            | off                | Lets an admin register a custom model endpoint at a loopback, link-local or private-range address — a LAN vLLM, and nothing else; plain `http` is permitted only for such an address. Logged at boot when set, like the two MCP flags above |
| `RYPH_TOOL_GUARD_IMAGE`                         | `ryph-tool-guard:dev`; the binary: the published one (src/images.ts) | The tool guard fronting hosted MCP servers, pulled into the provisioner backend's image store when missing. `bun run agent-image` builds the `:dev` one. Hosted servers run on docker, the backend agents run on; under `manual` the catalogue says hosting is unavailable, and why. (The standalone gateway also takes `RYPH_TOOL_HOST=kubernetes`; see deploy/README.md) |
| `RYPH_TOOL_NETWORK`                             | `ryph-tools`       | The docker network hosted MCP servers go on, which the launcher makes internal with no gateway on the docker host and refuses to host on where the engine cannot (Podman, a native engine before 28). This process never joins it: it dials the tool guard on a port published to the host's loopback, or by name on `RYPH_DOCKER_NETWORK` when it is itself a container there (`RYPH_DOCKER_GATE_TARGET` names it). Embedded launcher only: with `RYPH_LAUNCHER_URL` naming a launcher elsewhere, this is the launcher's setting and boot is refused when it is set here |
| `RYPH_EGRESS_TOOL_PORT`                         | `7461`             | The egress proxy's second listener, on `RYPH_EGRESS_BIND`: hosted MCP servers' one way to the internet, through the launcher's egress relay. It takes only their claims, opens any public host on any port, and never a private, loopback or link-local address, whatever `RYPH_EGRESS_ALLOW_PRIVATE` says. On whenever the docker launcher relays hosted servers to it, `RYPH_EGRESS_KEY` or not |
| `RYPH_EGRESS_TOOL_KEY`                          | minted per boot    | Hex, ≥ 32 characters: what hosted servers' egress claims are signed and verified with — both halves are this process. Unset, a fresh one each boot, and every hosted server is relaunched for a claim under it. Never `RYPH_EGRESS_KEY`'s value. A claim never expires (a hosted server is long-lived), so revoking them is rotating this key and restarting — which unset, every boot already is |
| `RYPH_EGRESS_DENY_CIDRS`                        | unset              | Comma-separated CIDRs, IPv4 and IPv6 (a bare address is just it), that neither egress listener ever dials, `RYPH_EGRESS_ALLOW_PRIVATE` or not — checked on the address a name resolves to and on a literal. **On a cloud VM, set it to this host's public addresses**: they are often on no interface (a 1:1 NAT), so the proxy cannot see they are its own, and a hosted server's claim opens every public address on every port — this host's included, past the cloud firewall. A malformed entry refuses to boot |
| `RYPH_TOOL_MEMORY`, `RYPH_TOOL_CPUS`            | `512m`, `1`        | Caps for every hosted server's container unless its catalogue entry names its own memory |
| `RYPH_TOOL_MAX_SERVERS`                         | `16`               | How many hosted MCP servers may exist at once (archived ones aside). Each is a capped container on THIS machine, and creating one is a user action, so a create past the ceiling is a `409` naming this variable |
| `RYPH_MCP_SUPERVISOR_INTERVAL_MS`               | `30000`            | How often healthy hosted servers are probed (three misses make one `unreachable`) and unreachable ones considered for a relaunch, on a 30 s → 10 min backoff |
| `RYPH_WEB_TOOLS`                                | `on`               | `off` takes the web tools away: @ryph/web is not mounted, no row is seeded, and **no run is granted the row — not by default, and not through an agent's own tool policy**, which is the part that matters, since a platform row cannot be archived. A row seeded by an earlier boot stays in the database and still shows in the agent form; what changes is that every scope entry naming it is dropped at task start. Spelled `on`/`off` (also `true`/`false`, `1`/`0`); anything else fails the boot rather than being read as one of them |
| `RYPH_WEB_SEARCH_PROVIDER`, `RYPH_WEB_SEARCH_KEY` | `brave`, unset   | The web tools' search backend. @ryph/web is mounted in-process, so `web__fetch` is always offered to tool-capable agents; without a key, `web__search` is not offered at all and one line at boot says so. The key is never logged and never reaches a run |
| `RYPH_WEB_ALLOW_INSECURE`                       | off                | Lets `web__fetch` read plain `http://` pages. Default: https only. Private, loopback, link-local and multicast addresses are refused either way, on every redirect hop |
| `RYPH_WEB_URL`, `RYPH_WEB_GATEWAY_TOKEN`        | unset              | A STANDALONE web service the gateway dials, instead of the in-process mount |
| `RYPH_WEB_FETCH_TIMEOUT_MS`                     | `20000`            | The whole of one page fetch, redirects included. The conversion has its own budget (5 s) and ceiling (4 at once), both fixed |
| `RYPH_PUBLIC_URL`                               | `http://localhost:7411` | The control plane's address as runners dial it         |
| `RYPH_APP_URL`                                  | unset              | The web app's origin as a browser reaches it: mailed links, run links, and the passkey origin derive from it. Unset, no link can be built, except the boot login link single-user prints, which assumes ./dev's UI at `http://localhost:5173` |
| `RYPH_SMTP_URL`, `RYPH_MAIL_FROM`                | unset              | Outbound mail for verification and password-reset links — both or neither. Unset, every such link is shown to an admin in the UI instead |
| `RYPH_AUTH_SWEEP_INTERVAL_MS`                   | `3600000`          | How often accounts unverified past a week and expired link tokens are purged |
| `RYPH_PROVISIONER`                              | `manual`           | `docker` or `kubernetes` to actually launch containers |
| `RYPH_LAUNCHER_URL`                             | `embedded`         | Under docker, where the docker launcher is ([@ryph/launcher](../launcher/README.md)). `embedded` starts it in this process; a URL names a launcher service (deploy/compose). With a URL, the docker, gate and build settings below (`RYPH_DOCKER_NETWORK`, `RYPH_DOCKER_RUN_NETWORK`, `RYPH_DOCKER_RUNTIME`, `RYPH_DOCKER_GATE_*`, `RYPH_TOOL_NETWORK`, `RYPH_ENV_BUILDKIT_IMAGE`, `RYPH_ENV_CACHE_DIR`, `RYPH_ENV_TEMP_DIR`, `RYPH_ENV_BUILD_PLATFORM`, `RYPH_ENV_TRUST_DEFAULT_BRANCH`, `RYPH_IMAGE_PREFETCH`) are the launcher's, and boot is refused when any is set here. Checks and builds turned on here must be served by the launcher too |
| `RYPH_LAUNCHER_TOKEN`, `RYPH_LAUNCHER_TOKEN_FILE` | minted per boot when embedded | The launcher's run-side token, or a file holding it. Required with a launcher URL |
| `RYPH_LAUNCHER_TOOLS_TOKEN`, `RYPH_LAUNCHER_TOOLS_TOKEN_FILE` | minted per boot when embedded | The launcher's tool-host token, or a file holding it. Without one, a launcher elsewhere hosts no MCP servers for this process |
| `RYPH_AGENT_IMAGE`, `RYPH_DOCKER_NETWORK`       | under docker `ryph-agent:dev` (the binary: the published one, src/images.ts); unset | The image every run launches on, whatever its harness kind / docker network |
| `RYPH_IMAGE_PREFETCH`                           | `on`               | Under docker, the launcher pulls every missing image runs, hosted tool servers and builds launch, one at a time, so the first run does not wait on them; `GET /v1/images` reports progress and `POST /v1/images/pull` retries. Only refs with a registry path are pulled, never a bare local tag like `ryph-agent:dev`. `off` leaves each to its first launch |
| `RYPH_HARNESS_KINDS`                            | `pi,echo`          | The harness kinds an agent may be created with             |
| `RYPH_BROWSER_IMAGE`, `RYPH_BROWSER_CPUS`, `RYPH_BROWSER_MEMORY` | unset (the binary under docker: the published one, `off` for none); Docker: uncapped; other backends: `1`, `1536Mi` | The browser sidecar a browser agent's run gets, and what each one adds to the run's size class; unset or `off`, no run gets one. `kubernetes` (1.29+) and `docker` only; the image must pull, or a Kubernetes browser run's pod never starts |
| `RYPH_HISTORY_URL`, `RYPH_RUN_HISTORY_URL`      | unset; `RYPH_HISTORY_URL` | A standalone historian this process dials instead of mounting one, and the same historian as a run reaches it to post its transcript (set only when runs reach it another way, e.g. through a run gate). `RYPH_RUN_HISTORY_URL` without `RYPH_HISTORY_URL` fails the boot |
| `RYPH_RUN_SIZES`, `RYPH_RUN_SIZE_DEFAULT`       | Docker: `standard`; other backends: `standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi` | Size classes an admin picks per repo or workspace; see the orchestrator's [development.md](../orchestrator/docs/development.md) |
| `RYPH_ENVIRONMENTS`, `RYPH_ENV_*`               | `off` (the binary under docker: `on`) | Environment builds; off, every run uses `RYPH_AGENT_IMAGE`. Under docker `RYPH_HARNESS_IMAGE` and `RYPH_ENV_BASE_IMAGE` default to the agent image's `ryph-harness` and `ryph-universal` siblings (src/images.ts) |
| `RYPH_DOCKER_RUNTIME`                           | docker's default (`runc`) | The OCI runtime agent containers launch under. `kata-runtime` or `runsc` trades a little boot time for a boundary an escaped run must cross before it reaches the daemon, the sibling runs' credentials, or the host. Linux only |
| `RYPH_DOCKER_RUN_NETWORK`, `RYPH_DOCKER_GATE_IMAGE` | unset, `ryph-run-gate:dev` (the binary: the published one, pulled when missing) | Confined docker runs: the internal network runs join instead of `RYPH_DOCKER_NETWORK`, and the run gate image that relays the run-facing addresses' ports (each must name `ryph-gate-<deployment>`), each to the same port on `host.docker.internal` (or `RYPH_DOCKER_GATE_TARGET`). Refused at boot when the network is not internal. Embedded launcher only, like every docker row here: with `RYPH_LAUNCHER_URL` set to a URL these are the launcher's settings, and boot is refused when they are set here. See the orchestrator's docs/development.md |
| `RYPH_DOCKER_GATE_TARGET`                       | `host.docker.internal` | Embedded launcher only: where the run gate relays every route, as a container on `RYPH_DOCKER_NETWORK` reaches it, i.e. this process's own name there when it runs as a container. The listeners the gate relays to must then leave loopback, or boot is refused. A launcher elsewhere names each route's target in its own `RYPH_DOCKER_GATE_ROUTES`, and this is refused. A containerised process with the launcher embedded and MCP hosting on must set it (with `RYPH_DOCKER_RUN_NETWORK`), or boot is refused: the tool guard and hosted servers' egress relay would otherwise aim at the docker host, not this container |
| `RYPH_K8S_*`                                    | the pod's own      | For `RYPH_PROVISIONER=kubernetes` — namespace, API server, runtime class, work volume class; see the orchestrator's [kubernetes.md](../orchestrator/docs/kubernetes.md). The cluster needs the PriorityClasses in deploy/helm/ryph/templates/priorityclasses.yaml first, or every run hangs until the startup grace and ends `lost` |
| `RYPH_DRAIN_DEADLINE_MS`                        | `25000`            | Hard cap on a SIGTERM drain. The listeners close, then the database — a half-written PGlite directory is the thing a local user cannot re-create |
| `RYPH_STARTUP_GRACE_MS`                         | `600000` (10 min)  | Silence tolerated before a run's *first* heartbeat, apart from `RYPH_HEARTBEAT_TIMEOUT_MS` — wide enough to cover a cold container's boot |
| `RYPH_RUN_MAX_WALL_CLOCK_MS`, `RYPH_RUN_MAX_SPEND_USD`, `RYPH_RUN_MAX_CALLS_IN_FLIGHT` | `43200000`, unset, `8` | The ceiling every run is under — wall clock from launch, spend in USD at list price, model calls held open at once; an agent's policy and a task's override lower it. `0` is no cap. See the orchestrator's [development.md](../orchestrator/docs/development.md) |
| `RYPH_RUN_CONCURRENCY`, `RYPH_RUN_MAX_CREDENTIALS` | unset, `3`         | How many runs may be live at once (unset: no cap), and how many times one run may be issued a model credential |
| `RYPH_MODEL_SPEND_CEILING_USD`, `RYPH_MODEL_SPEND_WINDOW_DAYS`, `RYPH_MODEL_SPEND_BACKSTOP_MS` | unset, `30`, `30000` | The deployment's last line on model spend: a rolling ceiling at which every spending call is refused and no task starts, its window, and how long a run may sit past its own cap before the proxy refuses its calls itself. In the environment on purpose: nobody raises the last line from an admin session |
| `RYPH_LOCAL_REPO_ROOT`                          | unset              | The directory repositories on this machine may be added from, as the embedded forge's `local` provider. Must be an existing absolute directory, resolved through symlinks at boot, or the boot fails. `off` turns local repositories off, the same as unset. Only with `RYPH_FORGE_URL=embedded`; beside a standalone forge it is ignored with a warning, since that forge reads its own. The `ryph` binary defaults it to your home directory when unset; set it to `off` to opt out there |
| `RYPH_RADICLE_URL`                              | unset              | `embedded` runs the Radicle bridge in this process in user mode (above); needs `RYPH_FORGE_URL=embedded`. Any other value is a bridge elsewhere, which the forge reads for itself. `rad` is found on `PATH` (or `RYPH_RADICLE_BIN_DIR`); the boot fails, with the fix, without `rad`, an identity, or a way to unlock an encrypted key (`SSH_AUTH_SOCK` or `RAD_PASSPHRASE`) |
| `RYPH_RADICLE_DATA`, `RYPH_RADICLE_PORT`        | `./data/radicle`, ephemeral | The embedded bridge's scratch repositories and git mirrors — never inside `RAD_HOME` — and its loopback port. The binary puts the data at `~/.ryph/radicle`. Every other `RYPH_RADICLE_*` knob keeps the bridge's meaning |
| `RYPH_VIRTUAL_KEY_TTL_MS`, `RYPH_HEARTBEAT_TIMEOUT_MS`, `RYPH_CANCEL_GRACE_MS`, `RYPH_REAPER_INTERVAL_MS` | see code | Timing knobs |
| `RYPH_GITHUB_TOKEN[_COMMAND]`, `RYPH_GITLAB_*` | unset | The forge's: GitHub or GitLab as you (user mode), or GitLab as a bot (packages/forge's README). An in-process forge reads them from this process's environment; beside a standalone forge they do nothing, and the boot says so. The boot summary names the account: `github (as @login)`, `gitlab (as @login at host)` |
| `RYPH_MERGE_POLL_INTERVAL_MS`, `RYPH_MERGE_POLL_PER_TICK` | `60000`, `2` | GitHub or GitLab user mode (no webhooks): how long after an answer an open pull or merge request is read again for a merge or close, and how many the submit sweep reads per tick. GitLab bot mode also polls, every ten minutes, the projects whose webhook has not delivered a merge request event in the last half hour. `0` per tick switches the poll off, that one too. One whose patches closed is read every ten minutes for a week, whatever the interval |

The `up` task loads an `.env` file next to this README; start from the annotated template:

```sh
cp .env.example .env
```
