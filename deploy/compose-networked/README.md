# 🧱 The networked deployment, on one machine

[`compose.yaml`](compose.yaml) in this directory runs **Mode B** — the networked deployment, every
service in its own container — on one machine, on one Postgres, with no cloud account. It is ryph's
example of that deployment: the shape closest to [Kubernetes](../helm/ryph/README.md), with the same
topology and env contract, and a starting point for running the services apart on your own hardware.
It is also where the split is checked end to end, because everything that makes Mode B different
from Mode A lives in the gaps between processes. For the simplest self-host, three containers
instead of a dozen, see [`deploy/compose`](../compose/README.md).

It pulls the published images from `quay.io/ryph`, at `RYPH_VERSION` (default `edge`, the newest
build of main; a release like `0.1.0`, or `sha-<commit>`, pins one):

```sh
bun run compose:init                                 # write missing secrets to this directory's .env
cd deploy/compose-networked
docker compose pull && docker compose up -d --wait
```

It needs Docker Compose 2.23.1 or later, for the inline `configs` that create the databases
(`docker compose version`; some NAS vendors ship an older one).

Compose reads `.env` from this directory, the project directory, and that is where `compose:init`
writes it. A stack started before this file moved here kept its secrets in the repository root's
`.env`: move that file here. `compose:init` refuses to mint a new `POSTGRES_PASSWORD` or
`RYPH_SECRETS_KEY` while the root `.env` still has both. `compose:init` needs Bun and this checkout;
without them, set each `${VAR:?…}` variable in `compose.yaml` in `.env` here yourself
(`openssl rand -hex 32` for each). Keep the caveats below in mind before you run it for real: the
`launcher` service holds the docker socket ([Runs](#runs-the-launcher-and-the-run-gate)), and among
the services a compose network cannot draw the boundaries a Kubernetes deployment does
([What compose cannot express](#what-compose-cannot-express)).

For development, the `compose:*` tasks build every image from this checkout instead
(`compose.build.yaml` layered over `compose.yaml`):

```sh
bun run compose:up      # write missing secrets to .env, build, start, wait until healthy
bun run compose:smoke   # drive every service-to-service link over real sockets
bun run compose:logs    # follow everything

bun run compose:stop    # pause; everything is kept, compose:up resumes in seconds
bun run compose:down    # remove the containers and networks, the run gate too; the data survives
bun run compose:reset   # remove the data too — the database, the object store, the cache
```

The tasks run from the repository root and pass `-f deploy/compose-networked/compose.yaml`, so the
project directory, and with it `.env`, is still this one. `compose:up` runs `bun run compose:init`
first, which writes a fresh random value into this directory's `.env` for every secret that is
missing there (see [Configuration](#configuration)). Nothing else needs setting up. The plain
`docker compose …` commands in the rest of this file run from this directory.

The other deployment is not here. **Mode A is the `ryph` binary**
([`packages/ryph`](../../packages/ryph/README.md)) — one process, one database, one of everything.
Nothing in this file applies to it. To run that binary with Docker Compose on a server of your own,
see [`deploy/compose`](../compose/README.md): three containers, not a dozen.

## What is running

| Service         | Port(s)            | Owns                                                                     | Database           |
| --------------- | ------------------ | ------------------------------------------------------------------------ | ------------------ |
| `postgres`      | 5433 → 5432        | every database                                                           | —                  |
| `objects`       | 9000               | patch bundles and run images (SeaweedFS, standing in for object storage) | —                  |
| `control-plane` | 7411               | runs, agents, policy, identity, the JWKS every peer verifies             | `ryph`             |
| `forge`         | 7412               | the git gateway; door ③ when a GitHub App or GitLab is configured        | `ryph_forge`       |
| `historian`     | 7413               | the transcript firehose                                                  | `ryph_history`     |
| `model-proxy`   | 7420 / 7421        | the model data plane; provider keys and the internal seam                | `ryph_keys`        |
| `mcp-gateway`   | 7430 / 7431        | the tool data plane; MCP servers, the probe, the usage trail             | `ryph_mcp`         |
| `memory`        | 7440               | what agents remember: the canon, the inbox, the brief                    | `ryph_memory`      |
| `chat`          | 7450               | chatrooms (Telegram, Zulip, Slack, Discord); mentions to the door        | `ryph_chat`        |
| `automations`   | 7414               | user-created triggers (webhook and cron) and their fires                 | `ryph_automations` |
| `web`           | 7480               | the agent's `web__search` and `web__fetch` — no state at all             | —                  |
| `previews`      | 7490 / 7491 / 7493 | dev servers agents expose, at `http://<id>.preview.localhost:7490`       | —                  |
| `app`           | 3000               | the BFF — the only container a browser talks to                          | —                  |
| `launcher`      | 7470               | the docker socket: runs, checks, builds, hosted MCP servers              | —                  |

Every service that keeps state has a database of its own; `web` and `previews` keep nothing. The
forge's patch bundles go to `objects`, its webhook deliveries to `ryph_forge`. `previews` publishes
its public port (`:7490`) only; its tunnel port (`:7491`) is the runners' (the tunnel a runner dials
out for `ryph__expose_port`, through the run gate) and its API port (`:7493`) the control plane's
(`/internal/*`), which the gate does not relay. A browser resolves every `*.localhost` name to
loopback, so a preview opens with no DNS set up; the link the app shows goes through the control
plane, which checks that you can read the run.

Two more run only under `COMPOSE_PROFILES=radicle` — see [The Radicle forge](#the-radicle-forge):

| Service        | Port(s) | Owns                                                               | Database       |
| -------------- | ------- | ------------------------------------------------------------------ | -------------- |
| `radicle-node` | 8776    | Radicle storage, the deployment's key, the gossip connection       | —              |
| `radicle`      | 7470    | the bridge: `rad`, patch pushes, the event consumer and its cursor | `ryph_radicle` |

Open <http://localhost:3000>. The first account you register becomes the owner, and it needs the
setup token the control plane prints at boot
(`docker compose logs control-plane | grep "Setup
token"`). There is no other way in, and no seeded
user.

**The model-proxy and the mcp-gateway publish no host port, deliberately.** Their data listeners
(`:7420`, `:7430`) are for agent containers, through the run gate, and their control listeners
(`:7421`, `:7431`) for the control plane and the app's proxy on this file's network. Key and server
management is reached through the app, which is how a person is meant to reach it. Neither does the
launcher: only the control plane and the gateway call it.

## Webhooks need a front door

Every service is published on `127.0.0.1` only, and nothing here routes by path: the app on `:3000`
serves the UI and nothing else. GitHub, GitLab and an automation's sender need one address that
reaches the right service, which is a reverse proxy you put in front, routing as the Helm chart's
Ingress does:

| Path                                          | Service             |
| --------------------------------------------- | ------------------- |
| `/v1/hooks/github`, `/v1/hooks/gitlab`, exact | `forge` :7412       |
| the rest of `/v1/hooks/`                      | `automations` :7414 |
| everything else                               | `app` :3000         |

The two exact paths go first. The repository page shows a GitLab project's webhook URL on
`RYPH_APP_ORIGIN` (`<origin>/v1/hooks/gitlab?project=…&generation=…`), so without the proxy every
delivery reaches the app, which answers 404, and GitLab soon disables the hook. Point a GitHub App's
webhook URL at `<origin>/v1/hooks/github`, and set `PUBLIC_AUTOMATIONS_ORIGIN` to the same origin so
the trigger page shows its ingestion URL there. Each of those doors answers a delivery under any
host name and verifies its own secret. With Caddy, for example:

```
ryph.example.com {
  handle /v1/hooks/github {
    reverse_proxy 127.0.0.1:7412
  }
  handle /v1/hooks/gitlab {
    reverse_proxy 127.0.0.1:7412
  }
  handle /v1/hooks/* {
    reverse_proxy 127.0.0.1:7414
  }
  handle {
    reverse_proxy 127.0.0.1:3000
  }
}
```

Behind the proxy, set `RYPH_ADDRESS_HEADER=x-forwarded-for` (and `RYPH_XFF_DEPTH`, 1 behind one
proxy that appends the client) so the app sees each browser's address: sign-in is rate limited per
client address, and without it every visitor arrives from docker's gateway and shares one limit.

Route nothing else of the forge's: `/v1/hooks/radicle` is the Radicle bridge's own door, and the
rest of the forge is for the services and runs.

## Artifact thumbnails

`artifact-thumbnails` reuses the browser image (`RYPH_ARTIFACT_THUMBNAIL_IMAGE`, so it stays on when
`RYPH_BROWSER_IMAGE` is `off`) with the thumbnail entrypoint, in a credential-free container with
**`network_mode: none`**. The control plane alone mounts its named `thumbnail-socket` volume,
read-only, and connects to `/run/ryph-thumbnails/render.sock` using
`RYPH_ARTIFACT_THUMBNAIL_SOCKET`. The browser image seeds the directory as uid/gid 1994, mode 0750;
the renderer's socket is mode 0660. Control-plane adds group 1994, and disables copy-up on its mount
so only the renderer seeds the volume. There is no TCP listener or bridge back to the control plane.
The renderer has no secrets or Docker socket, runs nonroot with a read-only root, drops
capabilities, disallows privilege escalation, and bounds CPU, memory, PIDs, `/tmp`, and shared
memory.

**Chromium's sandbox remains required.** Stock Docker seccomp blocks its user namespaces, so Compose
explicitly loads `packages/host/src/thumbnail_seccomp.json`, the same pinned Playwright-derived
profile embedded in the local binary. The path is relative to this Compose directory: keep that file
when copying the deployment. It permits private namespace creation without extra capabilities,
unconfined seccomp or disabling Chromium's sandbox. Docker client proxy variables are explicitly
blanked to avoid injecting proxy credentials.

The renderer performs a real fixed-document render before opening its listener. Launch failure exits
nonzero with an actionable diagnostic instead of reporting healthy. Control-plane startup does not
depend on renderer health, so preview failure cannot prevent publication. Kernel/AppArmor policy can
still refuse user namespaces; fix that policy rather than disable the sandbox. GKE keeps Chromium's
sandbox required inside gVisor too. `compose.build.yaml` builds the reused browser image; no new
image or generated secret is needed. `bun run compose:smoke` now verifies an actual published
artifact's PNG response, not just health.

## Why there is an object store

Patch bundles are the forge's durable output. On its own volume they pin it at one replica — a
bundle submitted through replica A simply 404s when replica B is asked to deliver it, per patch and
silently — so the networked deployment puts them in object storage (`RYPH_PATCH_STORE=s3`) and keeps
only the working set (`cache/`, `staging/`) on the node. SeaweedFS stands in for whatever the real
deployment uses — it used to be MinIO, until MinIO stopped publishing community images and archived
the project; see the note in `compose.yaml`. It is not optional here, because a stack demonstrating
the single-replica shape would not be demonstrating Mode B.

It also earns something no unit test can. The SigV4 signer is hand-rolled, its arithmetic pinned
against AWS's published vectors, and only a real S3 implementation can say whether it accepts a
signature — which is the one check in [`smoke.ts`](smoke.ts) that drives an adapter rather than a
service, and the one that caught a `Content-Length` the Fetch standard forbids sending.

Only the S3 port answers on the network. SeaweedFS's master, volume and filer ports serve reads and
writes of every object with no credentials, so they listen on the container's loopback and
`create-bucket` joins the `objects` container's network namespace to reach the master. The S3
gateway's gRPC port does answer on the network, and it carries an API that adds identities; a filer
signing key (`RYPH_OBJECTS_SIGNING_KEY`, held by `objects` alone) makes it demand a signed token.

`create-bucket` makes `ryph-patches` once, the same shape as the schema jobs and for the same
reason. Mode A keeps `local`: for a binary on a laptop, "durable" and "on this machine" are the same
thing, and asking for object storage first would be absurd.

## A database and a migration job per owner

Each service that owns tables gets its own database on the shared server. That is not tidiness: the
control plane holds the OAuth master key's ciphertext, the proxy holds every provider secret's, the
gateway every MCP credential's, and one database would mean one credential opening all of them.

Schema is applied by **one-shot jobs**, never at boot — N replicas migrating on startup race each
other. There is one per schema owner rather than one for all because each schema lives in the image
of the service that owns it; a single job would need an image carrying every schema file at once,
which is precisely the host image the split deleted. Each service probes its database on startup and
exits naming the fix if the schema is absent, so a stack brought up without them stops rather than
limps.

Each job applies its owner's committed migration set (`packages/<owner>/drizzle`) with
`drizzle-kit migrate`, which records what ran in that set's own table and runs only what is new. A
volume whose tables were made by the jobs' old `drizzle-kit push` has no such record, so its first
`migrate` fails on tables that already exist: `compose:reset` it.

The `init-databases` config in `compose.yaml` creates every database beside `ryph`. Postgres runs it
**once**, on an empty data directory — editing it later does nothing until `compose:reset` removes
the volume. Every job newer than the historian's and the model-proxy's creates its own database
first for exactly that reason, so a volume that predates them keeps coming up. The SQL is inline
rather than a file in the checkout because compose copies a config's content into the container: a
bind mount of a checkout file is unreadable to postgres on NAS shares (UGOS, Synology) that only let
their admin group read.

## The end-to-end check

`bun run compose:smoke` is a list of assertions, and each one is a link between two processes:

- every service answers `/healthz` and `/readyz`
- the app's `/api/v1/*` proxy reaches the control plane, historian, model-proxy, mcp-gateway and
  memory, and one user bearer works at all five, because all five verify the control plane's JWKS
- an agent with a model policy reaches the proxy's internal surface, and an unknown key id comes
  back as a definitive **400**, never a 5xx; an agent with a tool policy does the same at the
  gateway's
- only the launcher mounts the docker socket, and it has made the run gate on `ryph` and on the
  internal run network `ryph-runs-ryph`
- **a real run**: a task for an `echo` agent (the runner's built-in harness, no model) on the
  stack's fixture repository. The fixture has no `.ryph/`, so no environment is built: the launcher
  starts the run's container on the agent image, on the run network alone, with no socket. The run
  fetches its spec, clones through the forge's git gateway, streams its transcript to the historian,
  lands its work as a patch and reports success, every hop through the gate. `fixture-repo` makes
  the repository on first start, a one-commit git repository the forge reads from
  `RYPH_LOCAL_REPO_ROOT=/fixtures`
- the transcript comes back through the app, and the finished run's tail closes with `done`, so the
  conclude ping reached the historian
- a memory written through the app rides the run's brief, composed by the control plane over
  memory's internal surface, and the run's outcome reaches memory
- **the boundary, from a run's position**: a container on the run network reaches every route the
  gate relays (control plane, forge, historian, the two data listeners, the egress proxy, the
  previews tunnel) and nothing else: not `:7421` or `:7431`, not the app or the launcher, no service
  by name, not the docker host, not the internet
- the chat service answers the app's proxy with its own routes, and its bot credentials seal under a
  key the control plane never holds (`RYPH_CHAT_KEY`)
- a real S3 implementation accepts the forge's hand-rolled SigV4 signature, and a bundle round trips
  through the store the forge actually writes to
- the login page's first-run link agrees with the control plane about whether this instance still
  needs an admin — asserted before bootstrap and after, so one predicate covers both directions

Where a check could be satisfied by a service talking to itself, it is not the check we want. What
it does **not** cover, and why: no model call is made and no tool is called (`echo` can hold neither
policy, and spending them needs a provider account and a real MCP server), so no run is handed a
virtual key or MCP token; no preview is opened (`echo` exposes no port), and door ③ stays dark
without a GitHub App. Nor is an environment build: the fixture repository has no `.ryph/`, so its
run starts on the agent image at once.

**Running it claims the admin account.** The first registration on a stack is its admin, and this
check registers `smoke@ryph.local` with the setup token it reads from the control plane's log (set
`RYPH_SMOKE_SETUP_TOKEN` if the log has scrolled past it) — so run it before you make your own
account, or not at all on a stack you are using by hand. It says which account it used when it
finishes. On a stack whose admin is a person, point it at them:

```sh
RYPH_SMOKE_EMAIL=you@example.com RYPH_SMOKE_PASSWORD=… bun run compose:smoke
```

It is otherwise idempotent: it reuses the bootstrap user, the provider key, the agent and the
connected repository it made last time, and starts one new task each pass.

## Runs: the launcher and the run gate

The provisioner is `docker`, and the control plane still holds no docker socket. The `launcher`
service ([@ryph/launcher](../../packages/launcher/README.md)) is the only container that mounts it.
It holds no platform secret, and the control plane asks it over HTTP, with `RYPH_LAUNCHER_TOKEN`, to
launch runs, check suites and environment builds and to fetch images ahead. Everything about a
container that could reach past it is the launcher's own configuration, never a request's: the
networks, the gate and its routes, the OCI runtime, mounts and privileges.

Runs are confined. Each joins `ryph-runs-ryph`, an internal network with no route anywhere, whose
one door is the run gate `ryph-gate-ryph`: a container on both networks that relays the ports in
`RYPH_DOCKER_GATE_ROUTES`, each to the service behind it, and nothing else.

| Gate port | Service         | What a run dials it for                                    |
| --------- | --------------- | ---------------------------------------------------------- |
| 7411      | `control-plane` | its spec, credentials, heartbeat and result                |
| 7412      | `forge`         | the git gateway: its clone, and its work as a bundle       |
| 7413      | `historian`     | its transcript                                             |
| 7420      | `model-proxy`   | the model data plane, with its virtual key                 |
| 7430      | `mcp-gateway`   | the tool data plane, with its virtual MCP token            |
| 7460      | `egress-proxy`  | its one way to the internet, through the agent's allowlist |
| 7491      | `previews`      | the tunnel for a port it exposes (`ryph__expose_port`)     |

So every address a run is handed names the gate: `RYPH_PUBLIC_URL`, `RYPH_GIT_GATEWAY_URL`,
`RYPH_RUN_HISTORY_URL`, `RYPH_EGRESS_PROXY_URL` and `RYPH_RUN_PREVIEWS_URL` on the control plane,
`RYPH_MODEL_PROXY_URL` on the proxy, `RYPH_MCP_GATEWAY_URL` on the gateway. The control plane reads
the launcher's routes at boot and warns of an address of its own that misses them. Nothing checks
the model proxy's and the gateway's. Its own calls to the historian and the previews service go to
them directly (`RYPH_HISTORY_URL`, `RYPH_PREVIEWS_URL`), so they do not depend on the gate. Every
run's tunnel comes through the gate's one address, so the previews service cannot tell runs apart
there: while a run floods its tunnel port with connections, the others' tunnel dials can fail (each
retries on its backoff, and gets through once the flood stops), never the control plane's calls.
Telling runs apart behind the gate needs it to say who each connection is (the PROXY protocol, say),
a follow-up.

Environment builds run in the launcher too: it clones from the forge by name
(`RYPH_ENV_GIT_GATEWAY_URL`), and BuildKit runs privileged in a container of its own, on an internal
network of the build's own with the same gate attached. Checks run on the result. Both are on by
default here (`RYPH_ENVIRONMENTS`, `RYPH_CHECKS`, read by the control plane and the launcher alike).

With `RYPH_DOCKER_RUNTIME` set on the launcher, it refuses every environment build, and since builds
are on by default, the control plane then refuses to boot. Builds run privileged and outside that
runtime, so the launcher builds only the default branch, and only when told to trust the control
plane on which branch a build is of. Set one of these in `.env`:

- `RYPH_ENV_TRUST_DEFAULT_BRANCH=on`, to build the default branch only;
- `RYPH_ENVIRONMENTS=off`, to build nothing and run every task on `RYPH_AGENT_IMAGE`.

The images it launches are the published ones at `RYPH_VERSION`, and `docker compose pull` fetches
them ahead; the launcher also fetches them at boot. To run ones built from this checkout instead,
`bun run agent-image` builds the universal image, the harness layer and `ryph-agent:dev` (see
[`images/README.md`](../../images/README.md)); then set these in `.env`:

```sh
RYPH_AGENT_IMAGE=ryph-agent:dev
RYPH_ENV_BASE_IMAGE=ryph-universal:dev
RYPH_HARNESS_IMAGE=ryph-harness:dev
```

For a run that exercises the whole control loop without burning tokens, give the agent
`harnessKind: "echo"`, the runner's built-in harness, which never calls a model.

The launcher reaches docker through the socket's group, `DOCKER_GID`. On Docker Engine on Linux the
socket is `root:docker`, and `compose:init` writes its group (`stat -c %g /var/run/docker.sock`)
into `.env` when `.env` does not set it. Docker Desktop's socket is `root:root`, so the default, 0,
is right there and nothing is written. Without `compose:init`, set it yourself on Linux: with the
wrong group the launcher cannot use the socket, and no run starts. The rest of the stack still comes
up, since the control plane and the gateway wait for the launcher to have started, not to be
healthy; the launcher stays unhealthy and the control plane's log says `DOCKER IS NOT REACHABLE`.

The launcher needs Docker Engine 28 or later to confine runs, and refuses a run network that keeps a
route out. The gate, the run network and everything on it are the launcher's, not compose's.
`bun run compose:down` removes them with everything else, by this deployment's labels, along with
the BuildKit container and network of a build the launcher was stopped in the middle of. A plain
`docker compose down` cannot remove the `ryph` network while the gate is on it. Without bun, the
same by hand:

```sh
d=ryph
docker compose down
docker ps -aq --filter label=ryph.deployment=$d | xargs -r docker rm -f
# What a launcher stopped mid-build leaves: a BuildKit container and its state volume, named for
# this deployment's digest.
p=ryph-build-$(printf %s $d | sha256sum | cut -c1-12)-
docker ps -aq --filter name=buildx_buildkit_$p | xargs -r docker rm -f
docker volume ls -q --filter name=buildx_buildkit_$p | xargs -r docker volume rm
docker volume ls -q --filter label=ryph.check --filter label=ryph.deployment=$d | xargs -r docker volume rm
# Per-run and per-build networks, then the deployment's own.
docker network ls -q --filter label=ryph.deployment=$d | xargs -r docker network rm
docker network ls -q --filter name=$p | xargs -r docker network rm
# Each that is still there: the first `down` may already have removed the ones compose declares.
for n in ryph-runs-$d ryph-tools-$d $d; do docker network inspect $n >/dev/null 2>&1 && docker network rm $n; done
docker compose down
```

On macOS, where there is no `sha256sum`, use `shasum -a 256` in its place.

## Hosted MCP servers

The gateway **hosts** an MCP server from its catalogue (launches the vendor's container, fronts it
with the tool guard, supervises it) through the launcher, with `RYPH_TOOL_HOST=launcher` and
`RYPH_LAUNCHER_TOOLS_TOKEN`. That token opens the launcher's tool-host routes and nothing on the run
side, so a compromised gateway can start and stop `ryph-tool-*` containers, which hosting does
anyway, and cannot launch a run.

The servers are **confined like runs**. They go on `ryph-tools-ryph`, which the launcher makes
`--internal` with gateway mode `isolated` (and refuses to host on where the engine cannot), and no
service joins it. The gateway reaches a server through the tool guard, the one container also on
`ryph`, where the gateway dials it by name; the guard runs the launcher's `RYPH_TOOL_GUARD_IMAGE`
and no other, so the tools token cannot put an image of its own on `ryph`. A server's one way out is
the egress relay, `ryph-egress-relay-ryph-tools-ryph` (the run gate's image, on both networks), to
the egress proxy's second listener, `:7461`, which takes only claims the gateway signs with
`RYPH_EGRESS_TOOL_KEY` and opens any public host on any port, never a private, loopback, link-local
or CGNAT address. So a vendor's image reaches its API and nothing of this stack: not the control
plane, not the gateway's `:7431`, not Postgres, not the docker host or your LAN. Nothing is
published, and runs are not on that network. `compose:smoke` probes all of it from a container on
the tools network. A server on your LAN is registered by its URL instead, not hosted.

The guard's launch is fixed as well as its image: the launcher refuses one with a command, an env
var the guard does not read (`NODE_OPTIONS` among them), another port or an oversized cap, so the
tools token cannot run code of its own in the one hosted container on `ryph`. `compose:smoke` asks
it for one with `NODE_OPTIONS` and expects the 400.

**Security: this host's public address is the residual.** "Never private" is the private ranges plus
the addresses on the egress proxy's own interfaces, and those are the `egress-proxy` container's,
never the VM's. A hosted server may dial any public address on any port, so on a cloud VM it can
reach the VM's own public address, and anything on the host bound to `0.0.0.0` behind the cloud
firewall. **On a cloud VM, set `RYPH_EGRESS_DENY_CIDRS` to this host's public addresses**
(comma-separated CIDRs, IPv4 and IPv6, passed through to `egress-proxy`); neither listener dials
them then, by literal or by a name that resolves to one, and a malformed entry stops the proxy at
boot. Claims never expire (a server is long-lived and relaunched only at the gateway's boot), so
revoking them is rotating `RYPH_EGRESS_TOOL_KEY` in `.env` and restarting `egress-proxy` and
`mcp-gateway`.

A server you would rather run yourself can still be a compose service, registered as a **remote
URL**. For Grafana:

```yaml
grafana-mcp:
  image: grafana/mcp-grafana:1.4.0@sha256:13cf62271d456750e3371051a7e3927339ad956f3ac5e7b998a943472b48be1c
  # Read-only; the Host allowlist names the address the gateway dials it at.
  command: [
    "-t",
    "streamable-http",
    "--address",
    "0.0.0.0:8000",
    "--disable-write",
    "--allowed-hosts",
    "grafana-mcp:8000",
  ]
  environment:
    # A random value only the gateway's registered credential carries. Runs cannot reach this
    # service (the gate does not relay it), but every service on the network can, so this is what
    # keeps them from calling it directly.
    MCP_GRAFANA_SERVER_TOKEN: ${GRAFANA_MCP_CALLER_TOKEN:?set a random caller token}
  user: "65534:65534"
  read_only: true
  cap_drop: [ALL]
  security_opt: [no-new-privileges]
  mem_limit: 512m
```

Then, on the `mcp-gateway` service, set `RYPH_MCP_ALLOW_INSECURE=1` and
`RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS=1` — both are logged at boot, and both widen the upstream rule for
**every** server, which is exactly the trade hosting exists to avoid — and register the server in
the app with the URL `http://grafana-mcp:8000/mcp` and a **custom headers** credential:

```
Authorization: Bearer <the caller token above>
X-Grafana-URL: https://grafana.example.com
X-Grafana-Service-Account-Token: glsa_…
```

All three are sealed in the gateway like any credential; the Grafana container never holds the
service-account token, only the caller token that opens it.

## The Radicle forge

Off by default, and the default stack is exactly what it was before. The `radicle` **compose
profile** adds a **second forge** — a Radicle node and the bridge that speaks to it:

```sh
COMPOSE_PROFILES=radicle RYPH_RADICLE_URL=http://radicle:7470 bun run compose:up
COMPOSE_PROFILES=radicle bun run compose:logs
```

`COMPOSE_PROFILES` and not `--profile`: the flag is docker compose's own, before the subcommand, and
`bun run` appends what you give it after one. Put it in this directory's `.env` to stop typing it.

Two containers, one named volume (`radicle-data`) mounted as `RAD_HOME` by both. That shape is not a
choice: `git-remote-rad` writes a patch straight into storage on the local filesystem, and the
node's control socket is a file in the same tree — so whatever pushes has to share the volume with
the node rather than dial it. Both containers run as **uid 1994**, pinned in both images; a
different uid on either side makes the socket unopenable from the other and looks exactly like a
node that is down.

- **`radicle-node`** is upstream's binary, PID 1, `radicle-node --listen 0.0.0.0:8776 --force` —
  never `rad node start`, which forks and returns. On first boot it copies the key pair from
  `/run/secrets/radicle` if one is mounted and generates one otherwise, then rewrites `config.json`
  from the environment. **Nothing is published**: the node is outbound-only, because a fetch rides
  the connection it opened. To accept inbound peers, uncomment the `ports:` block in `compose.yaml`
  — with the bind spelled out, since a bare `- "8776:8776"` binds every interface, which on a laptop
  means the office wifi.
- **`radicle`** is the bridge, on `:7470`, published to loopback. It is the only thing that touches
  `RAD_HOME`, and every route on it — the git door included — takes `RYPH_RADICLE_TOKEN`. That
  bearer is the _whole_ boundary here, and on this stack it is worth being plain about what it is
  not: compose puts every service on one flat network, so any service in the stack can dial
  `radicle:7470` and present the token if it has it (runs cannot: the gate does not relay it).
  Nothing but the forge is _meant_ to call it; nothing but the token stops anything else. The Helm
  chart (`deploy/helm/ryph/templates/radicle.yaml`) adds a NetworkPolicy that admits the forge
  alone.
- **`migrate-radicle`** creates `ryph_radicle` and applies the bridge's set, like every other schema
  owner's job.

`RYPH_RADICLE_URL` on the **forge** is the switch, and it is separate from the profile on purpose:
running the pair without it is the useful state for working on the bridge alone, and an empty value
means no Radicle provider is registered and no connected repo can carry `provider=radicle`.

`RYPH_RADICLE_EXPLORER_URL` is read by **both** services and set on both here — the bridge renders a
submitted patch's URL from it, the forge renders every other thread's — so a value on one and not
the other is a deployment that links a patch and not the issue beside it. It is a **template**, with
`{rid}`, `{kind}` (`patches` or `issues`) and `{id}` substituted:

```
RYPH_RADICLE_EXPLORER_URL=https://app.radicle.xyz/nodes/seed.radicle.garden/{rid}/{kind}/{id}
```

It is unset by default, and that is a real answer rather than a missing one: Radicle has no
canonical web host, a private network has no explorer at all, and a URL with no placeholder in it
would send every patch to the same home page. Unset, nothing is invented — a thread's id is its
address, and `patches.forge_url` is null the whole way down.

| Variable                         | Default                      | What it does                                               |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `RYPH_RADICLE_URL` (forge)       | unset — provider off         | `http://radicle:7470` turns the second forge on            |
| `RYPH_RADICLE_TOKEN`             | generated by `compose:init`  | the forge ⇄ bridge bearer, both directions                 |
| `RYPH_RADICLE_ALIAS`             | `ryph`                       | the alias beside ryph's patches and comments               |
| `RAD_PASSPHRASE`                 | empty — an unencrypted key   | must be the same for both containers                       |
| `RYPH_RADICLE_CONNECT`           | heartwood's two public seeds | comma-separated `<nid>@<host>:<port>`                      |
| `RYPH_RADICLE_EXTERNAL_ADDRESS`  | unset                        | only when this node is reachable from outside              |
| `RYPH_RADICLE_EXPLORER_URL`      | unset — no web links         | thread-URL template, on BOTH the forge and the bridge      |
| `RYPH_RADICLE_RECONCILE_SECONDS` | `300`                        | the slow correctness pass — the event stream has no replay |

**The key on the volume is a laptop convenience and nothing more.** Storage is re-fetchable from the
network; authorship is not, so a real deployment provisions the key pair from a Secret (the Helm
chart's `radicle.key`) and this stack's generated one dies with `compose:reset`.

## Configuration

No secret has a default. Each is a required variable in `compose.yaml`, and compose refuses to start
without it. `bun run compose:init` (run by `compose:up` and `perf:up`) finds every one and appends a
fresh random value (32 bytes, hex) to this directory's `.env` for each that is missing, with the
file at mode 0600. On Docker Engine on Linux it also writes `DOCKER_GID`
([Runs](#runs-the-launcher-and-the-run-gate)). It never changes a line that is already there, so a
value you set by hand stays, and running it again does nothing. Compose reads the same `.env`, and
so do `compose:smoke` and the `perf:*` tasks.

The values this file used to ship (`dev-forge-token`, `deadbeef…` and the rest) are public now.
Every service refuses to boot when any variable in its environment contains one, unless
`RYPH_ALLOW_DEV_SECRETS=1`; only the Helm chart's dev values (`secrets.allowDevSecrets`) set that. A
stack whose volumes were created with the old values needs `bun run compose:reset` once: Postgres
keeps the password it was initialised with, and sealed secrets need the key they were sealed with.

| Variable                                                                                                                                                                                                                                                                                                             | Default                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `POSTGRES_PASSWORD`                                                                                                                                                                                                                                                                                                  | generated                                |
| `RYPH_S3_ACCESS_KEY_ID`, `RYPH_S3_SECRET_ACCESS_KEY`, `RYPH_OBJECTS_SIGNING_KEY`                                                                                                                                                                                                                                     | generated                                |
| `RYPH_SECRETS_KEY`, `RYPH_MCP_KEY`, `RYPH_CHAT_KEY` — the master keys, one per secret class; `RYPH_EGRESS_KEY` — signs each run's egress claim; `RYPH_EGRESS_TOOL_KEY` — signs each hosted server's; `RYPH_PROXY_SECRET` — the app's proof of a client address                                                       | generated (64 hex)                       |
| `RYPH_FORGE_TOKEN`, `RYPH_HISTORY_TOKEN`, `RYPH_MODEL_PROXY_TOKEN`, `RYPH_MCP_GATEWAY_TOKEN`, `RYPH_AUTOMATIONS_TOKEN`, `RYPH_MEMORY_TOKEN`, `RYPH_MEMORY_GATEWAY_TOKEN`, `RYPH_CHAT_TOKEN`, `RYPH_CHAT_GATEWAY_TOKEN`, `RYPH_WEB_GATEWAY_TOKEN`, `RYPH_PLATFORM_TOKEN`, `RYPH_RADICLE_TOKEN`, `RYPH_PREVIEWS_TOKEN` | generated, one per service link          |
| `RYPH_LAUNCHER_TOKEN` (control plane ⇄ launcher), `RYPH_LAUNCHER_TOOLS_TOKEN` (gateway ⇄ launcher)                                                                                                                                                                                                                   | generated, one per link                  |
| `DOCKER_GID`: the docker socket's group, for the launcher                                                                                                                                                                                                                                                            | 0; `compose:init` sets it on Linux       |
| `RYPH_AGENT_IMAGE`, `RYPH_ENV_BASE_IMAGE`, `RYPH_HARNESS_IMAGE`, `RYPH_TOOL_GUARD_IMAGE`, `RYPH_DOCKER_GATE_IMAGE`: what the launcher starts                                                                                                                                                                         | published, at `RYPH_VERSION`             |
| `RYPH_BROWSER_IMAGE`: the browser a browser agent's run gets; `off` for none                                                                                                                                                                                                                                         | published, at `RYPH_VERSION`             |
| `RYPH_ARTIFACT_THUMBNAIL_IMAGE`: the thumbnail renderer's image; set it beside a custom `RYPH_BROWSER_IMAGE`                                                                                                                                                                                                         | the published browser, at `RYPH_VERSION` |
| `RYPH_ENVIRONMENTS`, `RYPH_CHECKS`: environment builds and checks                                                                                                                                                                                                                                                    | `on`                                     |
| `RYPH_WEB_SEARCH_KEY` — a Brave Search key for `web__search`                                                                                                                                                                                                                                                         | unset — runs get `web__fetch` only       |
| `RYPH_MODEL_SPEND_CEILING_USD` — the deployment's rolling model spend ceiling, on the proxy; `RYPH_RUN_MAX_SPEND_USD` — the per-run spend ceiling, on the control plane                                                                                                                                              | unset — no cap on either                 |
| `RYPH_GITHUB_*`                                                                                                                                                                                                                                                                                                      | unset — door ③ stays dark                |
| `PUBLIC_GITHUB_APP_NAME`, `PUBLIC_GITHUB_CLIENT_ID`                                                                                                                                                                                                                                                                  | unset                                    |
| `RYPH_GITLAB_*` — one GitLab instance, as a bot user (or one person, `RYPH_GITLAB_MODE=user`)                                                                                                                                                                                                                        | unset — no GitLab                        |
| `PUBLIC_GITLAB_URL`, `PUBLIC_GITLAB_CLIENT_ID` — derived from `RYPH_GITLAB_URL` and `RYPH_GITLAB_CLIENT_ID`                                                                                                                                                                                                          | gitlab.com, unset                        |
| `RYPH_RADICLE_*` — the optional second forge                                                                                                                                                                                                                                                                         | see above; off by default                |

A GitLab instance with a self-signed certificate needs its CA in the two services that dial it: the
`forge` (its API calls and git) and `memory` (repository files a memory cites). The file passes each
only the variables it names, so mount the CA and set `NODE_EXTRA_CA_CERTS` on both, and
`GIT_SSL_CAINFO` on the forge, in a `compose.override.yaml`:

```yaml
# compose.override.yaml
services:
  forge:
    volumes:
      - ./gitlab-ca.pem:/etc/ssl/gitlab-ca.pem:ro
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/gitlab-ca.pem
      GIT_SSL_CAINFO: /etc/ssl/gitlab-ca.pem
  memory:
    volumes:
      - ./gitlab-ca.pem:/etc/ssl/gitlab-ca.pem:ro
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/gitlab-ca.pem
```

`GIT_SSL_CAINFO` replaces git's CA bundle rather than adding to it, so a forge that also reaches
GitHub needs a file holding the system bundle and your CA together.

The three master keys are separate on purpose. Provider secrets are sealed and unsealed entirely
inside the model-proxy, MCP credentials inside the mcp-gateway; the control plane cannot open either
and should not be able to. Mode A collapses them because one process is one trust domain — the
separation stays real so that splitting later needs no re-key.

The service tokens are separate for the same reason, and the file hands each one out accordingly:
one token per link, held by the two ends of that link and nobody else. That is what makes "a leaked
forge credential must not also open the historian" a property of the wiring rather than a hope — see
the next section for why those tokens carry so much weight here.

## A model endpoint on your LAN

The model proxy forwards to the two built-in providers and to whatever OpenAI-compatible endpoints
an admin registers under **Model keys → Custom endpoints**. The base URL is checked before it is
stored, and the default rules assume a hosted upstream: `https`, and a host that is not literally a
loopback, link-local or private-range address — `169.254.169.254`, the cloud metadata server, above
all. On a laptop that is precisely the wrong default, because the endpoint worth registering here is
the Ollama or vLLM on the next machine, at `http://192.168.1.20:11434/v1`.

`RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1` is the escape hatch, and this file passes it through to the
`model-proxy` service. Set it in the environment (or this directory's `.env`) before
`docker compose up` and a registration may name a private address, and may be plain `http` when it
does — the hop stays on your own network, where a bearer in the clear is a trade you can decide to
make. Plain `http` to a **public** host stays refused with the knob on: there is no LAN to trade
against, and the run's virtual key would cross the internet in the clear. The proxy warns about the
knob once at boot, so which deployment is running with it open is never a guess.

Two things it does not lift. A query string, a fragment or credentials in the URL are still refused,
for their own reason — the proxy appends the request's own path to this URL, so anything after it
would be silently dropped or carried into every forwarded request. And the address rule is a check
on the string an admin typed, not a resolution: a hostname that resolves to `10.0.0.1` passes it. On
Kubernetes what actually holds that boundary is the NetworkPolicy on the model-proxy pod, whose
egress rule excepts every private range. **A compose network cannot express one** (see
[What compose cannot express](#what-compose-cannot-express)), so here the string check is the whole
of it.

One address gotcha, since it costs an afternoon: the URL is dialled by the `model-proxy` container,
not by your shell. `127.0.0.1` in it means that container, and a compose service name means another
container on this network. A model server running on the host machine is reached by the host's LAN
address.

## Service containers

A repo can declare the databases its tests need in
[`.ryph/services.yml`](../../packages/orchestrator/docs/service-containers.md), and with
`RYPH_SERVICES=on` in the `control-plane` service's environment this deployment launches them: the
declaration is read through the forge, resolved against the catalogue and the operator's policy, and
the launcher starts each service beside its run, on that run's own network. Nothing about it is
configured on the launcher; the catalogue and the policy are the control plane's.

One caveat carries over from every docker deployment: **a docker network gives addressing isolation,
not enforced isolation.** Under OrbStack, measured, networks do not isolate at all, so another run
can reach this run's database by IP. The boundary that is real is the Kubernetes NetworkPolicy;
under docker this is a development and trusted-deployment feature.

One rule does apply here in full, because it is resolved in the control plane rather than at launch:
**the platform's own names are taken.** A service named `postgres`, `forge` or `control-plane` would
answer in the platform's place wherever a service name beats DNS, so a fixed list of them is refused
outright, and the addresses a deployment actually hands its runs are checked on top of it (here, the
gate's name) ([`RESERVED_SERVICE_NAMES`](../../packages/orchestrator/src/core/services.ts)). Both
checks run here, and each refusal names the fix.

## What compose cannot express

**For runs, the launcher's gate draws the line.** A run is on an internal network with no route
anywhere, and the gate relays only the ports runs are handed. So egress is a boundary here, not a
preference: the egress proxy is a run's only way to the internet, through the agent's allowlist, and
a run that ignores it reaches nothing. And the model-proxy's two listeners are split for runs as
they are on Kubernetes: the gate relays `:7420` and not `:7421`, and the gateway's `:7430` and not
`:7431`, so a run cannot open a connection to either internal listener. `compose:smoke` probes both
from a container on the run network. **Hosted MCP servers** get the same line drawn for them: an
internal network of their own, the tool guard their one way in and the egress relay their one way
out, which `compose:smoke` probes from a container on the tools network.

**Among the services, the network is still flat.** A service that can reach `:7420` can reach
`:7421`, so between services the boundary rests entirely on the service token each internal surface
checks. That check is real (the internal routes stay dark unless `RYPH_MODEL_PROXY_TOKEN` and
`RYPH_MCP_GATEWAY_TOKEN` are set), but it is the second of two defences, and the first, a
NetworkPolicy per service, does not exist here.

Because it is the only defence left standing, each of those tokens goes to the two ends of its link
and nowhere else. Both surfaces mint run credentials against the operator's real secrets from
caller-supplied scope, so a third service holding the token is a third process that can mint them —
which is why the forge, the service that clones untrusted repositories and terminates public
webhooks, holds `RYPH_FORGE_TOKEN` and nothing more.

The Kubernetes deployment ([the Helm chart](../helm/ryph/README.md)) is where the first defence
exists between services too: NetworkPolicies that open `:7420` to runs and `:7421` to the control
plane and the app, and nothing else, with a check (`bun run k8s:smoke`) that probes them from a
run's position.

**The launcher is root-equivalent.** It holds the docker socket, and whoever controls it controls
the machine. What it does not hold is a platform secret, and the control plane, which holds them,
cannot make it do what a request cannot say: no mount, no capability, no privileged container, no
published port, no other network. A compromised control plane can launch an unprivileged run on an
image it names, which a run already is; a compromised gateway, a hosted server on the tools network,
confined as one already is. Environment builds still run in a privileged BuildKit container, as
everywhere on docker.

The other gap is scale. Every service is still declared at one replica, but that is now a default
rather than a requirement: the correctness work behind more than one — a cross-replica history bus,
durable run conclusions, one reaper by advisory lock, a signing key every replica agrees on, patches
in object storage, and a cancel that reaches a run nobody can dial — has landed. What this file does
not yet do is _prove_ it: every check here runs against one of each, so raising a replica count is
expected to work rather than known to.

## Draining

`docker compose stop` sends SIGTERM, and every service drains: unready first, then the socket, then
its connections. `stop_grace_period` is **30s** because the drain deadline is 25s. Compose's 10s
default would SIGKILL mid-drain, which is the exact failure the deadline exists to prevent. The
launcher drains for 40 s, to outlast a run's 30 s `docker stop`, so its grace is 45 s.

The historian is where this is visible. An open SSE tail never finishes, so `shutdown()` alone would
wait for a viewer to close their browser; instead the deadline fires, the process logs
`drain.deadline_exceeded`, and exits 0. See [`@ryph/service`](../../packages/service/README.md) for
why that is a clean outcome and not a failure.
