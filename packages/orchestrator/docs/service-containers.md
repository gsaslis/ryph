# 🧱 Service containers

How a repo says _"my tests need Postgres and Redis"_ and gets them, on a platform whose agent images
deliberately cannot start a container.

Off by default: `RYPH_SERVICES=on` turns it on, and until then a repo's declaration is not even
read.

## 📜 `.ryph/services.yml`

A third file in the repo's `.ryph/` dir, beside
[`setup.yml` and `environment.md`](../../runner/docs/environment-setup.md). A mapping keyed by name,
GitHub-Actions-shaped:

```yaml
services:
  db:
    uses: postgres@18
    command: ["postgres", "-p", "5433", "-c", "fsync=off"]
    env:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: app_test
    port: 5433
  redis:
    uses: redis@8
    command: ["redis-server", "--port", "6382"]
    port: 6382
```

| Key           | Required | Meaning                                                                                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the name      | yes      | **The hostname**, so an RFC 1035 label: lowercase letters, digits and dashes, starting with a letter, at most 59 characters (Kubernetes names its container `svc-<name>`)                                     |
| `uses`        | yes\*    | A catalogue entry and version, `postgres@18`. Never an image reference                                                                                                                                        |
| `port`        | yes      | What the run dials, and what the health gate waits for. Explicit because we cannot read a `HEALTHCHECK`                                                                                                       |
| `command`     | no       | argv, as a list. No string form and no shell: something would have to split it, and that something is a shell nobody asked for                                                                                |
| `env`         | no       | Settings the catalogue entry accepts. Never a credential — these are values committed to the repo's tree, and they sit in the run's record and its container spec                                             |
| `checks_only` | no       | `true` starts it only for the [checks](checks.md) that name it, never beside a run. A boolean and nothing else: `yes` is a string in YAML 1.2, and guessing would decide whether every run starts a container |

\* unless the operator opened the escape hatch below, where `image` and `capabilities` replace it.

### `checks_only`: a service the checks need and the runs do not

The same file declares a run's services and the checks', and the two often differ. A database the
test suite runs over is the common case: the checks name it, while an agent running a package's
tests can use an embedded one. Without the key, every run of the repo would start it too, and on a
deployment with `RYPH_SERVICES=off` (the binary's and the Helm chart's default) every run would fail
at `setting-up`, because its checkout declares a service it did not get.

A `checks_only: true` service is invisible to the run path. The control plane leaves it out of the
declaration before the union and the resolution (`forRuns` in
[core/services.ts](../src/core/services.ts)), and the runner leaves it out of the services it
expects. A run whose list ends up empty is launched exactly as one whose repo has no `services.yml`.
Wherever it is started, for a check that names it, it is the same service as any other: the same
catalogue entry, the same hardening, the same policy, and the same refusal where services are off.

Parsing is strict in the style of `setup.yml`: an unknown key is a typo, and half-running the
author's intent is worse than refusing it. Anchors and aliases are refused outright.

### Addressing: `<name>:<port>`, never `localhost`

The declared name **is** the hostname, identically on every backend that supports the feature:
`hostAliases` on Kubernetes (sidecars share the pod's network namespace) and `--network-alias` on a
per-run network under docker.

`localhost:<port>` happens to work on Kubernetes, and **the contract forbids it anyway**. Otherwise
a repo writes `localhost` — half the ecosystem's `.env.example` files do — goes green on Kubernetes
and fails on docker with `ECONNREFUSED`. So committed config has to say `db:5433`. There is no way
around that one line, and pretending otherwise would just move the surprise.

### What is refused, and why

- **A name something already answers to.** An agent container joins the deployment's network to
  reach `control-plane` and `forge` by name; under docker it joins the run's network beside it, so a
  service aliased with one of those makes the run's own control channel ambiguous. The refused list
  is the platform's own service names plus the resolver's (`localhost`, `kubernetes`,
  `host.docker.internal`) — and, whatever the deployment calls them, **the host of every address a
  run is handed to reach the platform**. A service's name beats DNS on both backends, so a service
  called `orchestrator` in a deployment whose runners dial `http://orchestrator:7411` would receive
  the runner's authenticated requests. The control plane refuses the hosts of the addresses it hands
  out (`RYPH_PUBLIC_URL`, the git gateway, the historian) before launch; the runner refuses the
  hosts of the addresses only it sees — what the credentials fetch delivers, the model proxy's
  typically — before the harness starts. It still cannot be complete for whatever _else_ an operator
  runs on that network.
- **Port 8080.** The runner's own control listener. Services start _first_, so a service on 8080 —
  wiremock, keycloak, jaeger's UI — wins the bind and the runner dies with `AddrInUse` before it has
  fetched its work item.
- **Two services on one port.** Only a shared namespace genuinely collides, but the contract is the
  same everywhere so a repo cannot be backend-specific by accident.

## 📚 The catalogue

`packages/orchestrator/catalogue/`, one reviewed JSON file per entry, digest-pinned, loaded and
validated at boot when the feature is on. A repo picks from it; it does not name images.

**Why a catalogue and not a registry allowlist**, which is the finding the whole design turns on:

- Copy the run container's own posture — `capabilities: {drop: ["ALL"]}` — onto a service and
  `postgres:18` dies at entrypoint with
  `chown: changing ownership of '/var/lib/postgresql/18/docker': Operation not permitted`.
- Do not copy it, and the service gets the runtime's default capability set, **`CAP_NET_RAW`
  included**, in a namespace where every intra-cluster hop is plaintext HTTP carrying
  `RYPH_RUN_TOKEN`, the git token and the virtual model key.

So a service image needs its minimum capability set known, and that set is **not uniform**.
Measured, each trimmed until something broke:

| Entry         | Capabilities added on top of `drop: ALL` | Why                                                         |
| ------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `postgres`    | CHOWN, SETGID, SETUID                    | `exec gosu`, plus initdb's chown of the data dir            |
| `mongo`       | CHOWN, SETGID, SETUID                    | the same                                                    |
| `mysql`       | + DAC_OVERRIDE                           | its entrypoint reads `/var/lib/mysql-files` before dropping |
| `redis`       | + SETPCAP                                | it uses `setpriv`, which shrinks the bounding set           |
| `meilisearch` | none                                     | it never drops privileges                                   |

No registry prefix can carry that, and a prefix would not be much of a control anyway:
`docker.io/library/*` is ~170 images including `alpine`.

A capability outside one allowlist cannot enter the catalogue at all — the schema refuses it, so it
is not something a reviewer has to catch. The list is docker's own default minus `NET_RAW` and
`MKNOD`: nothing a stock `docker run` does not already hand any image. An allowlist and not a
denylist of `NET_RAW`, because that is only one road to the run's tokens — `NET_ADMIN` rewrites the
pod's routes to the same effect, and `ALL` is every road at once.

Adding an entry is a JSON file and a review, the same economics as
[the MCP catalogue](../../mcp-gateway/src/core/catalogue.ts) and for the same reason: it is the list
of images the platform will run on an operator's machines.

## ⏱️ How a run gets them

1. **Before launch**, the control plane reads `.ryph/services.yml` through the forge — out of the
   per-connected-repo cache the clone is served from, never a forge API — leaves out the
   `checks_only` services, resolves the rest against the catalogue and the operator's policy, and
   **freezes the result onto the run**. It has to be before: on Kubernetes a Pod's containers are
   fixed at creation, and the workspace does not exist until the runner clones _inside_ one.
2. **The provisioner launches them as part of the run's container unit** — native sidecars in the
   run's Job on Kubernetes, a per-run network under docker — so they live and die with the run and
   nothing outside it can reach them.
3. **The runner waits** for each to accept a connection before the agent starts, narrating the wait,
   and prepends the true list to the agent's environment description.

### Which ref

The run's own ref when it is a **branch of the connected repo**, and the connected repo's default
branch otherwise. Today every run's ref is such a branch by construction; the rule is there for the
day a fork's PR head can trigger a run, where `refs/pull/42/head` is fetched from the base repo but
its content is the fork's.

And the quiet part: **the ref is not the control.** It stops a stranger choosing an image; it does
nothing about a maintainer merging a bad one. The catalogue is the control.

### When the forge cannot answer

`serveBase` first, the very call the clone is about to make, so the read adds no availability
dependency the clone does not already have. When that refresh fails and the cache still holds the
ref, the forge's cache adapter serves the copy it holds and the answer is marked **stale**: the run
starts, the trail records `services-stale`, and the agent's environment block says so.

It does not bind the declaration to the commit the run clones: the clone fetches again for its own
advertisement, so a push landing in between means the run checks out a tree whose `services.yml` was
never the one resolved. Seconds wide, loud when it happens, and self-correcting next run — closing
it properly means resolving to a SHA and pinning the clone to it, which changes what a run's ref
means.

When nothing can answer, **the task is refused** rather than started. "We could not ask" is not "the
repo declares none", and launching anyway reproduces exactly the failure this feature exists to
remove — the measured one, where a missing Redis does not fail the suite but hangs it for ten
minutes with no output.

## 🧩 Per backend

| Provisioner  | Service containers                                                                   |
| ------------ | ------------------------------------------------------------------------------------ |
| `kubernetes` | ✅ native sidecars in the run's Job. Needs 1.29+; older clusters are refused by name |
| `docker`     | ✅ a per-run network, `--network-alias` per service                                  |
| `manual`     | narrated — it starts nothing anyway, so it prints what a human must arrange          |

Refusals throw at launch naming the provisioners that work. Never a silent drop: a run whose
database is simply absent fails a long way from the cause, which is the whole problem.

**Kubernetes.** `initContainers` with `restartPolicy: Always` — the only shape under `batch/v1` that
lets a Job with helper containers ever reach `Complete`. Cleanup is free (deleting the Job
cascades), no new RBAC is needed, and `ryph-runs` is default-deny **with no ingress rule at all**,
so nothing in the cluster can reach a run's database. A `tcpSocket` startupProbe means the kubelet
does not start the runner until the services answer.

**Docker.** `network create` → services with `--network-alias` → `docker create` the agent on the
deployment network → `network connect` → `start`. Two networks because the agent needs the
deployment network for the control plane and the run network for its services, and
`docker run --network` takes one. A run with no services keeps the old single-shot `run -d` path
unchanged.

Two honest limits:

- Docker's networks give **addressing** isolation, not enforced isolation — OrbStack's do not
  isolate at all, so another run can reach this run's database by IP. The real boundary is the
  Kubernetes NetworkPolicy; docker services are a development and trusted-deployment feature.
- Docker's address pools hold roughly 31 networks and the ceiling is **cumulative**. The adapter
  reclaims per-run networks from the reaper's tick, reconciling the runtime against the runs the
  store still calls active — and that is the primary path, not a backstop. `kill` reaches a run that
  was lost or cancelled; a run that simply **finishes** is never killed, so without the reconcile it
  is the happy path that leaks a database per run and exhausts the pool on success. The launch
  `catch` and a boot pass cover the two crash windows on top of that. Launches run concurrently with
  the reconcile, so it lists docker first and reads the store second: a run's row is written before
  its launch creates anything, so nothing it lists can belong to a run the read misses.

## 🩺 Health

TCP-open, 500 ms apart, up to 120 s per service — well under `RYPH_STARTUP_GRACE_MS`, so a service
that never comes up produces `{status: "error", during: "setting-up"}` naming it rather than a run
marked `lost` with "no heartbeat for 600000ms". Kubernetes additionally gates on the kubelet's
startupProbe; that is a stronger guarantee on one backend, not the contract.

TCP-open is right for Postgres _specifically_ because its entrypoint bootstraps with
`listen_addresses=''`, so an open port genuinely means ready. It is **not** right for MySQL, whose
port opens well before the server will answer a query — the catalogue entry says so, and a
`readyWhen` command is the obvious next step.

## ⚙️ Operator policy

| Variable              | Default | Meaning                                                                                                                                                                                                                         |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RYPH_SERVICES`       | `off`   | The feature. Off, because on means running images of a repo's choosing here                                                                                                                                                     |
| `RYPH_SERVICE_IMAGES` | unset   | Escape-hatch registry/repo prefixes, comma-separated                                                                                                                                                                            |
| `RYPH_SERVICE_MAX`    | `3`     | Services per run                                                                                                                                                                                                                |
| `RYPH_SERVICE_CPU`    | `1`     | Per service, request and limit                                                                                                                                                                                                  |
| `RYPH_SERVICE_MEMORY` | `1g`    | Per service, request and limit — docker's spelling, converted for Kubernetes. A catalogue entry's own `memory` is a **floor**, so a service gets whichever is larger: tightening this cannot start an image under what it needs |

With `RYPH_SERVICES=off` the declaration is **not read at all**, so a repo's file is inert rather
than refused. That is a deliberate trade: reading it would put a forge round trip on every task
creation in every deployment that will never use the feature. The runner closes the gap from the
other side — a workspace that declares services the run did not get fails during `setting-up`,
naming the reason. `checks_only` services are not among those, so a repo whose only service is
checks-only runs on such a deployment as if it declared none. Its checks that name one do not: the
suite ends in an error saying services are off.

Everything else refuses rather than ignores: an entry this deployment does not have, an image
outside the allowlist, more services than the max, a name or port that is taken. Each names the
switch or the list.

### The escape hatch

With `RYPH_SERVICE_IMAGES` set, a declaration may name an `image` directly — and must then carry its
own `capabilities`, because no catalogue reviewed it and an omitted list must never quietly mean the
runtime default. Those capabilities come from the same allowlist the catalogue's schema applies: the
hatch lets a repo name an image, never restore what `drop: ALL` removed. Matching normalises first
(`postgres:18` → `docker.io/library/postgres:18`) and anchors at a path boundary, so a rule for
`evil/postgres` does not admit `evil/postgres-backdoor`.

It is the escape hatch and not the main road, and the reason is the one above: a prefix constrains
who published the bytes, not what they do.

## 🛡️ What this changes in the threat model

| Change                                                              | What holds it                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The platform runs an image chosen from a repo's declaration         | The catalogue decides which images exist and how each is confined; the escape hatch is operator-set and off by default                                                                                                                                                 |
| A service shares the run pod's network namespace                    | Its capability set is the catalogue's, drawn from an allowlist without `NET_RAW` on both roads. This is the load-bearing mitigation                                                                                                                                    |
| A service inherits the pod's NetworkPolicy egress                   | Credential-free — the run's Secret is `envFrom` on the runner container alone — but as reachable outward as the agent. Accepted                                                                                                                                        |
| Repo-authored YAML is parsed inside the **control plane's** process | 64 KiB cap before anything decodes it, anchors refused, the parser pure with no I/O, every loop bounded                                                                                                                                                                |
| A service's env sits in the run's record and its container spec     | Values the repo committed to its own tree, so nothing the agent could not read there anyway. Not copied into the prompt — the runner is told a service's name, port and image only. Not filtered either: refusing `POSTGRES_PASSWORD` would make Postgres undeclarable |

## 🚫 Deliberately not

- **Volumes and persistence.** One container is one run; nothing survives it, as with setup.
- **Teardown hooks.** Same reason.
- **A `services:` key in `setup.yml`.** The runner ships _inside the agent image_, so the day a repo
  added one, every run on an un-upgraded image would fail with `` unknown key `services` ``.
- **`activeDeadlineSeconds` on the Job.** It would cap a run's wall clock, which is a decision about
  every run rather than a detail of this feature.
