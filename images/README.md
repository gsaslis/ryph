# 🐳 Images

Six very different kinds of image live here: the services, the agent containers, the tool guard, the
egress proxy, the run gate, and the browser.

**The services** — one per process in the networked deployment, built from the workspace root:

|                  |                     |                                                                                                                                |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `control-plane/` | orchestrator + auth | run state, agents, policy, identity, the user surface                                                                          |
| `model-proxy/`   | model-proxy         | two listeners: the data plane agent containers dial, the control plane that manages keys                                       |
| `mcp-gateway/`   | mcp-gateway         | the same two listeners one credential class over: the "MCP server" containers dial, and the control plane that manages servers |
| `historian/`     | historian           | the transcript firehose, on its own database                                                                                   |
| `memory/`        | memory              | what agents remember — the canon, the inbox, the brief — on its own database; bakes the embeddings runtime and model in        |
| `chat/`          | chat                | chatrooms — a Telegram, Zulip or Slack bot per room, per-conversation bindings to runs, the poller — on its own database       |
| `web/`           | web                 | the platform's `web__search` and `web__fetch` — the only stateless service: no database, no schema, no disk                    |
| `previews/`      | previews            | hosted previews: dev servers agents expose, served on a domain of their own over runners' tunnels — no database, no disk       |
| `forge/`         | forge               | the GitHub boundary and the git gateway                                                                                        |
| `app/`           | app                 | the SvelteKit BFF — the only public-facing container                                                                           |

**The optional pair** — `radicle-node/` and `radicle/`, the two containers of the `radicle` service.
They are not in the table above because a deployment either speaks Radicle or does not: no
`RYPH_RADICLE_URL`, no provider, and neither image is built, pushed or scheduled. `radicle-node/` is
upstream's code built from source with plain `cargo build` at a pinned heartwood commit, because the
release archives' linux-musl binaries crash (see `radicle-node/build-radicle.sh`, the one place to
bump the version; the bridge image runs the same script). `radicle/` is our Bun bridge, and carries
the same `rad`, `git` and `git-remote-rad` because it shells out to them. They share one volume as
`RAD_HOME` and one uid (1994), pinned in both, because `git-remote-rad` writes into storage on the
local filesystem and the node's control socket is a file in that tree — so the pusher shares the
volume rather than dialling it. Compose runs them behind a profile (`COMPOSE_PROFILES=radicle`), the
Helm chart with `radicle.enabled` (`deploy/helm/ryph/templates/radicle.yaml`), and `images:publish`
builds and pushes them with the rest.

**The binary** — `ryph/`, the single-process [`ryph`](../packages/ryph/README.md) binary compiled in
the image, with `git` and Node for the artifact sanitizer beside it. It is not a service of the
networked deployment: it is the one-machine deployment in a container, for
[`deploy/compose`](../deploy/compose/README.md). It carries no docker CLI and never mounts the
socket: it reaches docker through the launcher below. Its `ryph-radicle` target adds Radicle's CLI.

**The launcher** (`launcher/`, [@ryph/launcher](../packages/launcher/README.md)) is the one
container of a compose deployment that holds the docker socket, and the only image with the docker
CLI and its buildx plugin. It runs runs, check suites, environment builds and image prefetch for the
control plane (or the binary), and hosted MCP servers for the gateway, each over HTTP with its own
service token. It holds no platform secret. Beside the CLI it has `git`, `bash` and `tar`, because
the environment builder clones and writes its build contexts on this side. Bun on the service
images' base, uid 1996, the socket's group added by compose (`group_add`). Both compose deployments
run it; Kubernetes does not, since the kube API is that seam there.

There is no `host/` image any more. It packaged the whole single-process composition — orchestrator,
auth, model proxy, and historian in one container on one database — and that shape had no honest N:
every replica ran its own reaper, its own historian listener map, and its own proxy. The
single-process deployment is now the [`ryph`](../packages/ryph/README.md) binary, which is where
one-of-everything belongs.

Every service answers two probes, from [@ryph/service](../packages/service/README.md):
`GET /healthz` (alive — no dependencies, so a database outage never crash-loops the fleet) and
`GET /readyz` (should get traffic — checks the one dependency it cannot serve without, and 503s the
instant a drain begins). SIGTERM drains in order and on a deadline; see that package for why the
deadline is not optional.

Schema provisioning is **not** an entrypoint step in any of them — N replicas migrating at boot race
each other. Each image ships drizzle-kit and its owner's committed migrations, and the deployment
applies them before the service starts: a one-shot job per owner in compose, an init container in
each pod under a Postgres advisory lock on Kubernetes. Each service probes its database at boot and
exits naming the fix if the schema is absent.

They run together in [`deploy/compose-networked`](../deploy/compose-networked/compose.yaml), the
networked example deployment — the databases on one Postgres, the migration jobs wired ahead of the
replicas, and an end-to-end check that drives every link between them. That is where these images
are verified as a stack rather than one at a time; see
[its README](../deploy/compose-networked/README.md). The Helm chart,
[`deploy/helm/ryph`](../deploy/helm/ryph/README.md), runs the same services on Kubernetes, with an
agent image launched per run and the tool guard launched by the gateway.

**The tool guard** — `tool-guard/`, the one container of hosted MCP servers that is ever published,
and under docker the one also on an ordinary network: the tools network beside it confines the
vendors (internal, the launcher's to make). The single process launches it at boot on `ryph-tools`,
beside the vendor containers it fronts (Grafana's, from the gateway's catalogue): a token-gated,
byte-streaming reverse proxy routing `/<launch key>/mcp` to that launch's container,
`ryph-tool-<launch key>`, and to no other host (a route table naming one is refused at boot),
answering `401` to anything without the token the gateway minted at boot, stripping it before
forwarding, presenting a server's caller token where its entry declares one, and speaking to each
server as `Host: localhost:<port>`. One TypeScript file on a distroless Node base under
`node --permission --allow-net` (no file access, no child processes), run as uid 65534 on a
read-only root — it reads nothing but its env. It is our own build, never a vendor's pull. Locally
it has to be in the backend's store, where `bun run agent-image` builds it into docker's alongside
the agent images (`ryph-tool-guard:dev`; point `RYPH_TOOL_GUARD_IMAGE` elsewhere to override; under
a standalone launcher the launcher's own setting, the one image it runs as the guard). The
standalone gateway launches it on Kubernetes (`RYPH_TOOL_HOST=kubernetes`), from the registry
`bun run images:publish` pushes it to, and on docker through the launcher
(`RYPH_TOOL_HOST=launcher`). Its program is tested from the gateway's suite
(`packages/mcp-gateway/tests/tool_guard_image_test.ts`).

**The egress proxy** — `egress-proxy/`, the tool guard's sibling pointed outward: the one way out of
a run's network, and the only place a hostname allowlist can actually be enforced. It terminates
`CONNECT`, matches the requested hostname — and then the ClientHello's SNI, which must be the same
name — against the allowlist the run presents, and forwards or refuses with a `403` naming the host.
Per-host, never per-path — the URL stays inside TLS and this process never sees it; there is no
interception and no CA in any agent image.

Two properties make it a thin target rather than a second confused deputy. **It holds no
credential:** `RYPH_EGRESS_KEY` only _verifies_ the signed claim a run presents, so compromising
this container buys an attacker the allowlist they already had. And **it holds no state:** the claim
carries the run's allowlist and the control plane's signature, so there is no database, no control
listener, and nothing for it to be asked. **It never dials inward**, whatever a claim allows:
loopback, private, link-local and this machine's own addresses are refused, and so are the container
runtimes' names for the host (`host.docker.internal` and its kin) — so on a confined docker
deployment it cannot be used to walk around the run gate's port list. Same build shape as the guard
— one TypeScript file on distroless Node under `node --permission --allow-net`, uid 65534, read-only
root — and `bun run agent-image` puts it in both local stores (`ryph-egress-proxy:dev`). Its program
is tested from the orchestrator's suite (`packages/orchestrator/tests/egress_test.ts`), which drives
both halves of the token format so the pair cannot drift. A second listener (`RYPH_EGRESS_TOOL_KEY`,
`:7461`) takes only hosted MCP servers' claims, signed by the gateway with a key of their own, and
opens any public host on any port and nothing inward, whatever `RYPH_EGRESS_ALLOW_PRIVATE` says:
under docker their one way out, through an egress relay (the run gate's image) on their internal
network. That half is tested from the gateway's suite
(`packages/mcp-gateway/tests/tool_egress_test.ts`). `RYPH_EGRESS_DENY_CIDRS` names addresses neither
listener dials; on a cloud VM it should hold the host's public addresses, which a container's
interfaces never show it.

**The run gate** — `run-gate/`, the one door out of a confined docker run network. Under docker an
`--internal` network takes the host with it, so a confined run (`RYPH_DOCKER_RUN_NETWORK`) could not
reach the host-resident control plane at all. The gate is one container per deployment
(`ryph-gate-<deployment>`) on that network and an ordinary one, relaying a fixed list of TCP ports,
the ports of the addresses runs are handed, each to a target of its own, and nothing else. The
docker launcher starts it. In the binary every route goes to the same port on `host.docker.internal`
(or `RYPH_DOCKER_GATE_TARGET`). A launcher service names each route's target in its own
`RYPH_DOCKER_GATE_ROUTES`: deploy/compose sends every port to `ryph`, and the networked stack sends
each to the service behind it. Bytes, not a protocol: every service behind it authenticates its own
callers, so it holds no credential and checks none. Its argv is its whole policy, every route
spelled out as `<listen>=<host>:<port>`
(`7411=host.docker.internal:7411 7460=host.docker.internal:7460`), so `docker inspect` reads it; the
short forms `--target <host> <port>[:<target port>]…`, which need `--target`, exist for a gate
started by hand. The egress proxy's build shape — one TypeScript file on distroless Node under
`node --permission`, uid 65534, and the provisioner adds a read-only root, no capabilities and small
caps (but a large open-file limit). Shared by every run, so bounded per run: each source address
holds at most 256 relays (`--per-source`), a relay quiet both ways for 15 minutes is closed, and a
half-close is passed through rather than cutting the answer. `bun run agent-image` builds it into
docker's store (`ryph-run-gate:dev`). Tested from `packages/orchestrator/tests/run_gate_test.ts`.

**The browser** — `browser/`, the sidecar a browser-enabled run gets beside its agent
([@ryph/browser](../packages/browser/README.md)). Not a service and not published per deployment's
choice: the orchestrator launches it per run when `RYPH_BROWSER_IMAGE` names it — a native sidecar
on Kubernetes, a container in the agent's network namespace under docker — so `localhost` is the
agent's own. Bun plus `playwright-core` and the Chromium **headless shell** alone, at the revision
that playwright-core pins, with the shell's system libraries and two font families; Mesa's GPU
driver stack, which debian's `libgbm1` drags in and a pod never uses, is purged. uid 1994, nothing
to configure at boot: the runner hands it a bearer and the egress proxy's credentials over HTTP,
once. Locally `bun run agent-image` builds it into docker's store (`ryph-browser:dev`, which
`ryph setup` offers as `RYPH_BROWSER_IMAGE`).

# 🤖 Agent containers

> **Build them with `bun run agent-image`.** It builds the universal image, the harness layer and
> `ryph-agent` on top of the two — plus the tool guard, the egress proxy, the run gate and the
> browser — with docker, into docker's store. See [`build.ts`](agent/build.ts).

> **Rebuild your environments after rebuilding these.** Environment images copy `/opt/ryph` from the
> harness when they are built, and a harness rebuilt under the same tag (`ryph-harness:dev`) looks
> unchanged to the control plane, so nothing re-layers on its own. Restart the control plane, then
> use **Rebuild** on each repo's or workspace's environment, or runs keep the old runner and tools.

An **agent container** is one run: the [orchestrator](../packages/orchestrator/README.md) launches
one per run, the [@ryph/runner](../packages/runner/README.md) inside works the task to completion,
and the container exits. Its image is two things layered in a fixed order:

|                                                 | What it is                                                                                                                                         | Owner    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **The environment** — `env/universal/`          | the machine: Ubuntu 24.04, build tools, the everyday CLI tools, Rust through rustup, and Node, Deno, Bun, Python, uv and Go through mise           | the repo |
| **The harness layer** — `harness/`              | everything that is ours, under `/opt/ryph` and nowhere else: the compiled runner, pi on its own Node, the MCP extension, the baker, `harness.json` | us       |
| **The default image** — `agent/` (`ryph-agent`) | the first with the second copied on last, user `1994`, entrypoint tini → runner                                                                    | —        |

**The universal image** (`quay.io/ryph/ryph-universal`, tag `1`) is the environment of every repo
that declares none, and the `FROM` a repo's own `.ryph/Dockerfile` is meant to start with. It aims
at "the mainstream just works": a repo that pins a version — `rust-toolchain.toml`, `.nvmrc`,
`.python-version`, `mise.toml` — gets that version installed on first use, as the run user, with no
configuration, because rustup and mise's shims read those files and every toolchain home is owned by
uid 1994. It is published by `bun run images:publish --build-universal`, and kept under a 4 GB
compressed budget (`images/env/universal/check-size.sh` measures a pushed tag against it). A plain
publish does not rebuild it: see [Publishing](#-publishing).

**The harness layer** (`ryph-harness`) is a `FROM scratch` image holding only `/opt/ryph`:

```
/opt/ryph/
  bin/tini            static init: reaps orphans and forwards signals to the runner
  bin/ryph-runner     the runner, bun build --compile'd — no Bun install, no node_modules
  bin/ryph-bake       setup.yml at image build time (packages/runner/src/bake.ts)
  bin/pi              a wrapper: exec pi on the layer's own Node
  node/               pi's Node 24 — never on PATH
  lib/pi/             pi, pinned
  lib/check-base.sh   refuses a base the layer cannot run on
  pi-mcp/             the MCP and images extensions, at the fixed path the runner passes with -e
  harness.json        runner, pi, Node and tini versions, harness kinds, build time
```

Both default and repository environment images start the runner as `tini -s -- ryph-runner`, under
the layer's static tini. It reaps orphaned descendants of setup and background commands: the runner
waits for its direct children, but is not itself a PID-1 reaper. `-s` keeps tini reaping when it is
not PID 1 (`docker run --init`, a shared process namespace). Signals go to the runner only (not
tini's `-g` group mode), so cancellation still stops jobs and finalizes the checkout in the runner's
order; the image sets `RYPH_INIT=tini`, and with it the runner ignores the other signals tini
forwards, as the kernel did while the runner was PID 1. What it cannot ignore, it no longer escapes:
a process in the run can SIGKILL or SIGSTOP the runner, which then shows as a lost heartbeat, and a
broadcast SIGTERM starts a cancel. The harness build tests orphan reaping and TERM forwarding, and
`bun run agent-image` and `bun run images:publish` run the same test against the agent image as PID
1 (`agent/check_init.ts`, on runc only). Existing images need rebuilding or re-layering to pick this
up; an already-running sandbox cannot change its PID 1. A check never runs this tini: its script
replaces the entrypoint, and the baked image it usually launches holds no harness layer. The docker
check launcher puts docker's own `--init` in front instead; a kubernetes check pod has no reaper.

Its runtimes never leak: `/opt/ryph/bin` is not on `PATH`, the runner spawns pi by absolute path,
and the repo's `node`, `bun` and `cargo` are the environment's — so a repo on Node 20 and pi on Node
24 never meet. It asks three things of any base, and `check-base.sh` fails the build naming
whichever is missing: glibc (x86_64 for anything published), `/bin/bash`, and `git` (new enough for
`git checkout --end-of-options`). It warns, without failing, when `rg` or `fd` is missing: pi's
`grep` and `find` tools need them, and pi never downloads them. The same layer is copied last onto
every environment image a repo builds, so a harness upgrade re-layers them without touching their
warm builds.

**The harness kind no longer picks an image.** Every image carries every harness the layer lists in
`harness.json` (`pi` and `echo` today), so `RYPH_AGENT_IMAGE` names one default image for every
agent, and the kind picks a harness inside the runner. The orchestrator takes the kinds an agent may
be created with from its own `RYPH_HARNESS_KINDS` (default `pi,echo`), not from the image. A runner
asked for a kind its layer does not carry refuses at boot, naming what the layer does carry. `echo`
is the runner's built-in reference harness — it echoes, no model call — so an `echo` agent on the
same image exercises every part of the control plane (spawn, spec fetch, heartbeats, result, cancel)
and burns no tokens: a free end-to-end smoke test.

## 📦 The container contract

The launch environment carries routing information and one single-use bootstrap token:

| Variable                | What it carries                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `RYPH_ORCHESTRATOR_URL` | The orchestrator address the runner fetches its spec from and reports to                 |
| `RYPH_RUN_ID`           | The run this container speaks for                                                        |
| `RYPH_BOOTSTRAP_TOKEN`  | Redeemed once at `POST /v1/runs/:id/bootstrap`; expires 5 minutes past the startup grace |
| `RYPH_EGRESS_PROXY`     | Optional non-secret proxy address, also used by provisioners to check network wiring     |

The image sets one more itself, `RYPH_INIT=tini`, which tells the runner it runs under the layer's
init (above). No payload rides the env. On boot the runner exchanges its bootstrap token for run,
control, git and egress credentials. The exchange atomically consumes the token across replicas and
restarts. Credentials remain in runner memory, never its environment; `/proc/1/environ` can expose
only the spent bootstrap token. Network errors and 5xx are retried; a refused or lost exchange fails
closed. The runner then fetches its spec — the frozen `WorkItem` plus the agent's `InjectedContext`
— from `GET /v1/runs/:id/spec` with the run credentials, and validates it through its own ingest
schema. The fetch doubles as the boot handshake: a container that cannot reach or authenticate
against the orchestrator fails immediately, before doing work it could never report. The same
credentials then carry the reporting channel
([heartbeats](../packages/runner/docs/architecture.md#-heartbeats) and the result).

Roll out a bootstrap-capable runner image with this contract change: update both the default agent
image and the configured harness-image digest. Environment resolution checks the harness digest, so
old baked runners must not be selected under the new digest. Older runners cannot redeem the new
launch contract; already-running containers retain their existing run bearers.

Secrets never ride the work item. **Model credentials don't ride the launch env either**: alongside
the spec, the runner fetches `GET /v1/runs/:id/credentials` on boot and retains the answer in
memory, supplying it explicitly only in child environments: a run-scoped virtual key plus the
[model-proxy](../packages/model-proxy/README.md)'s address, never the real thing. Which variables
carry them depends on the upstream the agent's key belongs to. For one of the two built-in providers
they are that provider's conventional pair (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`), so the
harness's SDK picks them up unchanged. For an OpenAI-compatible endpoint an admin registered there
is no convention to borrow — the image has never heard of it — so they are three of the platform's
own: `RYPH_MODEL_API_KEY`, `RYPH_MODEL_BASE_URL`, and `RYPH_MODEL_PROVIDER_CONFIG`, a JSON blob
naming the endpoint's slug, the wire dialect it speaks and every model it declares. That blob is
what the harness adapter turns into a provider entry its CLI can be pointed at
([harnesses](../packages/runner/docs/harnesses.md)); it holds no secret, only the shape of the
endpoint. Either way no real provider key ever enters the container, `docker inspect` shows only the
four contract vars, and the credential dies with the run. No git host credential ever enters the
container either: a private repository is a connected one, cloned through the forge's git gateway on
a run-scoped read-only key. The workspace needs nothing mounted: it is a temp dir inside the
container and dies with it.

The same fetch carries **tool credentials** for a run whose agent has a tool policy: an `mcp` half
with one run-scoped virtual token for the [MCP gateway](../packages/mcp-gateway/README.md) and the
gateway's per-run URL for each server in scope. The runner does not export that token under any name
the harness's own subprocesses would see: it lands in pi's spawn environment only, as
`MCP_GATEWAY_TOKEN`, referenced from a throwaway `mcp.json` the runner writes — so a repo's
`setup.yml` steps never hold it, one notch tighter than the model key. The harness layer bakes the
one extension that reads that file, [`@ryph/pi-mcp`](../packages/pi-mcp/README.md), at
`/opt/ryph/pi-mcp/`; the runner loads it by path (`-e`) only when the run has tools. Beside it sits
the images extension (`images.ts`), which every run loads: it keeps each request pi sends within the
provider's image limits, whatever the agent reads.

A repo's own [environment setup](../packages/runner/docs/environment-setup.md) — its `setup.yml`
steps — runs inside this container with whatever the image ships. The stock images deliberately ship
no container runtime, so a step that runs containers (`docker compose up -d db`, etc.) fails on
them. The omission is a security posture, not a gap: a Docker daemon inside a container requires a
privileged launch, and rootless mode softens that without moving the real boundary — the shared host
kernel — so the trade belongs to whoever operates the deployment, not to a stock image.

The answer for a repo that needs a database is not to put a runtime in here. It is
[`.ryph/services.yml`](../packages/orchestrator/docs/service-containers.md): the repo declares what
it needs, and the **platform** starts it beside the run — a sidecar in the run's Kubernetes Job, or
a container on the run's own docker network — reachable from a setup step by name. So the platform
now launches images on a repo's behalf and **owns the safety of each one itself**, which is why
those images come from a reviewed, digest-pinned catalogue carrying the capability set each entry's
entrypoint actually needs, and not from anything the repo can name. (A deployment can still bake its
own agent image with a runtime inside, or install one via `setup.yml` and pay that cost on every
run, and then it owns that trade as before.)

## 🔨 Build

The build context is the workspace root — that's where the lockfile and the shared import map live
(and the root `.dockerignore` allowlists what may enter the context). The three builds feed each
other by tag, which `bun run agent-image` does for you; by hand, for what a deployment runs:

```sh
docker build --platform linux/amd64 -f images/env/universal/Dockerfile -t ryph-universal:dev .
docker build --platform linux/amd64 -f images/harness/Dockerfile \
  --build-arg RYPH_VERSION=$(git rev-parse --short=12 HEAD) -t ryph-harness:dev .
docker build --platform linux/amd64 -f images/agent/Dockerfile \
  --build-arg UNIVERSAL_IMAGE=ryph-universal:dev --build-arg HARNESS_IMAGE=ryph-harness:dev \
  -t ryph-agent:dev .
```

`bun run agent-image` builds for the machine's own architecture instead, so the local backends run
it natively on Apple silicon. A deployment gets all three from `bun run images:publish`, or pulls
the published ones from `quay.io/ryph`; one that mirrors them into its own registry copies the
universal image (it is the deployment's `RYPH_ENV_BASE_IMAGE`) rather than rebuild it.

## 🚀 Run

Normally the orchestrator does this (`RYPH_PROVISIONER=docker` with `RYPH_AGENT_IMAGE` set): it
launches the container with the contract env, and the runner fetches its spec on boot. By hand —
without an orchestrator to fetch from — append the runner's CLI flags and mount the input files; the
entrypoint forwards arguments through tini to the runner:

```sh
docker run --rm \
  -v "$PWD/workitem.json:/inputs/workitem.json:ro" \
  ryph-agent:dev \
  --work-item /inputs/workitem.json \
  > result.json 2> run.log
```

Exit semantics match the runner's
[result catalogue](../packages/runner/docs/architecture.md#-every-possible-result): a parseable
`Result` on stdout with a normal exit means the runner did its job whatever the status; an abnormal
exit means it could not even report. Bad usage exits 2.

## 🪂 Cancellation

`docker stop` sends SIGTERM, which is the runner's **graceful cancel**
([cancellation-flow.md](../packages/runner/docs/cancellation-flow.md)): the harness stops at a
coherent point and committed work is still pushed. Docker's default 10s grace is too short for
"finish the current action, commit, push" — give it room, e.g. `docker stop -t 120`. When the
timeout expires Docker sends SIGKILL, the same escape hatch as the local second signal.

There is a second way in: when the bootstrap exchange hands the runner a control token, it exposes
an **inbound control API** — an authenticated `POST /cancel` on `RYPH_PORT` (default `8080`) that
requests the same graceful cancel. It binds `0.0.0.0`, so a control plane on the same container
network reaches it by the container's name (`ryph-run-<id>`), no port publish needed. The
`docker stop` SIGTERM above stays the backstop for when that endpoint is unreachable or ignored.

# 📤 Publishing

`bun run images:publish` ([`publish.ts`](publish.ts)) builds every image here and pushes it to Quay,
which is where both Docker Compose deployments and the `ryph` binary's defaults pull from:

| Image                                                                                                                                   | `--only` name                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `quay.io/ryph/ryph-<service>`: control-plane, historian, model-proxy, mcp-gateway, forge, automations, memory, chat, web, previews, app | the service's name              |
| `quay.io/ryph/ryph-egress-proxy`, `-tool-guard`, `-run-gate`, `-browser`                                                                | `egress-proxy`, `tool-guard`, … |
| `quay.io/ryph/ryph-launcher`                                                                                                            | `launcher`                      |
| `quay.io/ryph/ryph-universal`, `-harness`, `-agent`                                                                                     | `universal`, `harness`, `agent` |
| `quay.io/ryph/ryph` (the binary), and `:<tag>-radicle` with Radicle's CLI                                                               | `ryph`, `ryph-radicle`          |
| `quay.io/ryph/ryph-radicle-node`, `-radicle` (the bridge)                                                                               | `radicle-node`, `radicle`       |

A build at a commit tagged `vX.Y.Z` is the release `X.Y.Z` and is tagged with that version (no `v`);
any other build is an edge build, tagged `sha-<12-char commit>` only. Once every image has pushed, a
release's images get their commit's `sha-<12>` too, and `edge` moves to the new set, all in one
pass, so a failed build never leaves `edge` half moved. The packages are bare (no description, no
linked repo). A dirty tree is refused; `--allow-dirty` publishes `sha-<12>-dirty` and leaves `edge`
alone. The `ryph` image's binary is built with the same tag baked in, so its default run images are
the ones published beside it, and the harness reports that version. See
[Releases & versioning](../CONTRIBUTING.md#releases--versioning).

The universal image is the exception: a publish reuses the one `ryph-universal:1` points at, by
digest, and does not build it. In that same last pass it tags that image with the publish's own tag
(and `edge` and a release's `sha-<12>`), so its digest stays the same from release to release, and
the agent image is built FROM that digest. A new universal digest makes a deployment rebuild every
environment it has, so rebuilding it is deliberate: `--build-universal`, or naming `universal` in
`--only`, builds it like the others and moves `1` to the new build. A registry with no
`ryph-universal:1` yet (a fresh namespace, or a `--registry` elsewhere) is refused until it is built
that way. The harness is still built every time.

Builds are `linux/amd64,linux/arm64` with provenance (`mode=max`) and an SBOM, through a buildx
builder of their own (`ryph-publish`, docker-container driver, created on first use) on Docker
Desktop. On an Apple silicon Mac the amd64 half is emulated, and the Rust builds (`radicle-node`,
`radicle`, `ryph-radicle`) take a very long time that way; `--platform linux/amd64` or `--only`
without them keeps a first push short. The agent image is built FROM the universal and harness
images this same run pushed, by digest, and one platform of it is loaded and its init checked as PID
1 before it is pushed.

```sh
docker login quay.io -u 'ryph+<robot>'                       # once: a robot account that can push

bun run images:publish --dry-run                             # the plan and every buildx command
bun run images:publish --platform linux/amd64 --only agent   # agent, its harness, universal reused
bun run images:publish                                       # everything, universal reused
bun run images:publish --build-universal                     # everything, universal rebuilt
```

`--registry localhost:5000/ryph` pushes to a local `registry:2` instead, through a builder that
speaks plain http to it, which is how to try the whole path without touching Quay.
