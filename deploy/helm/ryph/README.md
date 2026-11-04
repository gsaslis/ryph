# ryph Helm chart

Installs [ryph](https://github.com/ryph-hq/ryph) on Kubernetes: the control plane and its services,
and the namespaces, RBAC and NetworkPolicies that keep agent runs, hosted MCP servers, environment
builds and the egress proxy apart from them. The control plane launches every agent run as a Job.

- [Requirements](#requirements)
- [Quick start on kind](#quick-start-on-kind)
- [Production install](#production-install)
- [Upgrade, rollback, uninstall](#upgrade-rollback-uninstall)
- [Migrations](#migrations)
- [The namespace model](#the-namespace-model)
- [The network boundary](#the-network-boundary)
- [Secrets](#secrets) and [the Secret contract](#the-secret-contract)
- [Cluster-scoped objects](#cluster-scoped-objects)
- [The front door](#the-front-door)
- [GKE Autopilot](#gke-autopilot)
- [Values reference](#values-reference)

## Requirements

- **Kubernetes 1.29 or newer.** The control plane's sanitizer runs as a native sidecar.
- **A network plugin that enforces NetworkPolicy.** This is not optional. The boundary between an
  agent run and everything else — the database, the services' control listeners, the cloud metadata
  server — is drawn by NetworkPolicies. A plugin that ignores them leaves every run able to reach
  all of it, and nothing will tell you.
  - Enforce: Calico, Cilium, Antrea, GKE Dataplane V2, AKS with Azure or Cilium network policy, EKS
    with the VPC CNI's network policy agent turned on, k3s (kube-router), and **kindnet in kind
    v0.24 and newer**.
  - Do not: Flannel alone, the plain AWS VPC CNI without its policy agent, kindnet before kind
    v0.24, Docker Desktop's built-in Kubernetes.
  - Check it yourself: put a deny-all ingress policy on a test pod and try to reach it.
- **Pod Security admission** (built in since 1.25). The chart labels its namespaces (`restricted`
  for the services, tools and egress namespaces, `baseline` for runs, `privileged` for builds) and
  the pods are written to pass them.
- **A sandboxing RuntimeClass, strongly recommended.** Agent runs execute model-written commands in
  repositories you did not write. With `runs.runtimeClassName: gvisor` each run, check, environment
  build and (with `tools.runtimeClassName`) hosted MCP server gets its own kernel. Without one they
  share the node's kernel and a kernel exploit in a run is a node compromise. A run's browser also
  needs it for Chromium's own sandbox: under the RuntimeClass the sandbox is required, and without
  one, where the node's runtime refuses the sandbox, Chromium runs without it, held only by the
  run's container.
- **Environment builds** (`environments.enabled`) run rootless BuildKit in the builds namespace.
  That needs user namespaces and unconfined seccomp/AppArmor for the builder (hence `privileged` on
  that one namespace), a registry the builds can push to, and a **sandboxing RuntimeClass, which is
  required**: a build runs a branch's `.ryph/Dockerfile` and `setup.yml`, which an agent can write,
  and unconfined on the node's own kernel one kernel bug in a `RUN` step is root on the node. With
  the kubernetes builder the chart refuses to render without `environments.runtimeClassName` or
  `runs.runtimeClassName`, and the control plane refuses to boot without one.
  `environments.allowUnsandboxed: true` lifts both, and is for laptop clusters only
  (`values-dev.yaml` sets it, since kind has no gVisor).
- **Installing gVisor.** GKE Sandbox provides the `gvisor` RuntimeClass (see "GKE Autopilot").
  Elsewhere, install `runsc` on every node that runs runs or builds and register it with containerd
  ([gVisor's containerd guide](https://gvisor.dev/docs/user_guide/containerd/quick_start/)): the
  `runsc` and `containerd-shim-runsc-v1` binaries on the node, a `runsc` runtime in containerd's
  config (`[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]` with
  `runtime_type =
  "io.containerd.runsc.v1"`), and containerd restarted. Then create the
  RuntimeClass and name it:

  ```yaml
  extraObjects:
    - apiVersion: node.k8s.io/v1
      kind: RuntimeClass
      metadata:
        name: gvisor
      handler: runsc
  runs:
    runtimeClassName: gvisor
  ```
- **Artifact thumbnails** render untrusted HTML in Chromium with Chromium's own sandbox required.
  Under gVisor that works as is. Without gVisor, the container runtime's default seccomp profile
  refuses the user namespaces the sandbox needs: install
  [`packages/host/src/thumbnail_seccomp.json`](../../../packages/host/src/thumbnail_seccomp.json) on
  every node and set `artifactThumbnails.seccompProfile`, or turn thumbnails off. The renderer never
  falls back to running without its sandbox.
- **Postgres 15 or newer** and an **S3-compatible object store** (production; the chart can bring
  dev-only ones).
- **Sizing.** The services request about 4.5 CPU and 10.5 GiB together (two app and two egress-proxy
  replicas included). Each run asks for its size class (`standard`: 4 CPU, 8 GiB, 10 GiB ephemeral);
  plan nodes for the runs you want at once, not for the services.

## Quick start on kind

With Docker Desktop and kind 0.26 or newer: its default node image is Kubernetes 1.32, the first to
admit the socket-buffer sysctls of the previews pods `values-dev.yaml` turns on (on an older node
image they are refused, `SysctlForbidden`, unless `previews.capSocketBuffers=false`). The install
requests about 0.9 CPU and 3 GiB and uses about 2.5 GiB once up (measured: the whole kind node,
Kubernetes' own pods included, at 2.1 CPU and 3.3 GiB requested, before the previews pod's request
grew by 256 MiB), so Docker Desktop's default 8 GiB is enough for the services. An agent run asks
for its size class on top (`standard`: 4 CPU, 8 GiB): to run agents on a laptop, give Docker Desktop
more or define a smaller class in `runs.sizes`.

The cluster gets a kubeconfig of its own, so your default context, which may be a real cluster, is
left alone; every command below uses it through `KUBECONFIG` in this shell. From the repository
root:

```sh
kind create cluster --name ryph --kubeconfig ./ryph.kubeconfig
export KUBECONFIG="$PWD/ryph.kubeconfig"
# The seccomp profile the artifact thumbnail renderer's Chromium sandbox needs, onto the node,
# before the install (kind runs no gVisor).
docker exec ryph-control-plane mkdir -p /var/lib/kubelet/seccomp/ryph
docker cp packages/host/src/thumbnail_seccomp.json \
  ryph-control-plane:/var/lib/kubelet/seccomp/ryph/thumbnail.json
helm install ryph deploy/helm/ryph -n ryph-system --create-namespace \
  -f deploy/helm/ryph/values-dev.yaml -f deploy/helm/ryph/values-kind.yaml --wait --timeout 15m
kubectl -n ryph get pods            # every service migrated its schema, then started
kubectl -n ryph port-forward svc/app 3000
```

Open http://localhost:3000. The first account registered becomes the admin; a fresh control plane
logs the setup token that registration needs:

```sh
kubectl -n ryph logs deploy/control-plane -c control-plane | grep "Setup token"
```

Check it, from the repository root: the app and the services behind it, then what a pod with a run's
labels can and cannot reach. On a throwaway cluster it may claim the admin with placeholder
credentials:

```sh
bun run k8s:smoke --kube-context kind-ryph --dev-credentials
```

And the refusals only a cluster can show (a changed or lost sealing key, a PriorityClass another
release owns, an installer with no cluster-wide rights), each a dry-run upgrade against the release.
It deletes and restores a Secret for one of them, so it runs only on a throwaway: a kind or k3d
context whose API server is on loopback, named again in `--throwaway`, with a release on the dev
state. Each object it changes is backed up first under `$XDG_STATE_HOME/ryph/refusals` (default
`~/.local/state`), with the command that restores it, and put back on Ctrl-C too:

```sh
bun run k8s:refusals --kube-context kind-ryph --throwaway=kind-ryph
```

[`values-dev.yaml`](values-dev.yaml) turns on a bundled Postgres and SeaweedFS (`devState`), fixed
placeholder secrets and laptop-sized requests. The placeholders are public, so it also sets
`secrets.allowDevSecrets`, without which every service refuses to boot with one. Never use it beyond
a laptop. On another laptop cluster whose network plugin enforces NetworkPolicy (k3d, whose k3s runs
kube-router), leave out [`values-kind.yaml`](values-kind.yaml): thumbnails stay off, since they need
that profile on the node. Not Docker Desktop's built-in Kubernetes: it enforces no NetworkPolicy
([Requirements](#requirements)), so nothing there keeps a run from the database.

Later upgrades name the same files, so nothing set at install is lost:

```sh
helm upgrade ryph deploy/helm/ryph -n ryph-system \
  -f deploy/helm/ryph/values-dev.yaml -f deploy/helm/ryph/values-kind.yaml --wait --timeout 15m
```

To start over, `kind delete cluster --name ryph --kubeconfig ./ryph.kubeconfig`: `helm uninstall`
keeps the namespaces ([Upgrade, rollback, uninstall](#upgrade-rollback-uninstall)).

## Production install

Install the release into a namespace the chart does not use (`ryph-system` here), whether or not it
creates them: Helm keeps its release records there, and they hold every Secret the chart renders
([Secrets](#secrets)). The chart owns the five namespaces it puts things in (see
[the namespace model](#the-namespace-model)).

Before you start: the Postgres server (15 or newer) and the object store's bucket must exist. The
chart creates neither, and nothing creates the bucket on first write.

A minimal values file:

```yaml
appUrl: https://ryph.example.com

postgres:
  host: 10.20.0.3
  user: ryph
  params: sslmode=require&max=2&idle_timeout=30
  # The password, or whole URLs, from a Secret you manage — see "Secrets".
  # A Secret in the services namespace (`ryph`), one key per owner.
  urlSecrets:
    controlPlane: { name: ryph-db, key: control-plane }
    historian: { name: ryph-db, key: historian }
    modelProxy: { name: ryph-db, key: model-proxy }
    mcpGateway: { name: ryph-db, key: mcp-gateway }
    memory: { name: ryph-db, key: memory }
    chat: { name: ryph-db, key: chat }
    forge: { name: ryph-db, key: forge }
    automations: { name: ryph-db, key: automations }

objectStore:
  endpoint: https://s3.eu-west-1.amazonaws.com
  bucket: my-ryph-patches
  region: eu-west-1
  existingSecret: ryph-s3 # in `ryph`: RYPH_S3_ACCESS_KEY_ID, RYPH_S3_SECRET_ACCESS_KEY

runs:
  runtimeClassName: gvisor
tools:
  runtimeClassName: gvisor
artifactThumbnails:
  runtimeClassName: gvisor

ingress:
  enabled: true
  className: nginx
  host: ryph.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  tls:
    enabled: true
    secretName: ryph-tls

networkPolicy:
  # Who fronts the cluster: here, the ingress controller's namespace.
  frontDoor:
    from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: ingress-nginx
  # If your Postgres is outside the cluster: its address, so the services that are held on the way
  # out (memory, chat, model-proxy) may reach it.
  database:
    extraCidrs: ["10.20.0.3/32"]
  # Your API server's public address, so nothing that reaches the internet can reach it.
  internet:
    extraExcept: ["203.0.113.10/32"]
```

The Secrets that file names (`ryph-db`, `ryph-s3`) live in the services namespace, which the chart
creates. So there are two orders that work, and pre-creating the namespace alone is not one of them
(Helm refuses to take over a namespace it did not create):

**A. Namespaces and Secrets first.** Create the namespaces yourself, with the labels the chart would
give them ([Pre-created namespaces](#pre-created-namespaces)), put the Secrets in, and install with
`namespaces.create: false`:

```sh
kubectl create namespace ryph && kubectl label namespace ryph ryph.dev/services=true \
  pod-security.kubernetes.io/enforce=restricted
kubectl create namespace ryph-runs && kubectl label namespace ryph-runs \
  pod-security.kubernetes.io/enforce=baseline pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted
for ns in ryph-tools ryph-egress; do
  kubectl create namespace $ns && kubectl label namespace $ns pod-security.kubernetes.io/enforce=restricted
done
kubectl create namespace ryph-builds && kubectl label namespace ryph-builds \
  pod-security.kubernetes.io/enforce=privileged pod-security.kubernetes.io/warn=baseline \
  pod-security.kubernetes.io/audit=baseline

kubectl -n ryph create secret generic ryph-db \
  --from-literal=control-plane='postgres://ryph:…@10.20.0.3:5432/ryph?sslmode=require&max=2&idle_timeout=30' \
  --from-literal=historian='postgres://ryph:…@10.20.0.3:5432/ryph_history?sslmode=require&max=2&idle_timeout=30'
  # … and model-proxy (ryph_keys), mcp-gateway (ryph_mcp), memory (ryph_memory), chat (ryph_chat),
  # forge (ryph_forge), automations (ryph_automations)
kubectl -n ryph create secret generic ryph-s3 \
  --from-literal=RYPH_S3_ACCESS_KEY_ID=… --from-literal=RYPH_S3_SECRET_ACCESS_KEY=…

helm install ryph deploy/helm/ryph -n ryph-system --create-namespace -f my-values.yaml \
  --set namespaces.create=false --wait --timeout 15m
```

**B. Install, then the Secrets.** Install first; the chart creates the namespaces, and the pods that
read `ryph-db` or `ryph-s3` wait in `CreateContainerConfigError` until those exist. Create them as
in A (without the namespaces), and the pods start by themselves:

```sh
helm install ryph deploy/helm/ryph -n ryph-system --create-namespace -f my-values.yaml
kubectl -n ryph create secret generic ryph-db …   # as in A
kubectl -n ryph create secret generic ryph-s3 …
kubectl -n ryph get pods -w
```

No `--wait` in B: the release cannot be ready before the Secrets exist.

Then check it, as the admin you claimed (or the one it should claim), naming what the cluster knows
a run must not reach:

```sh
RYPH_SMOKE_EMAIL=you@example.com RYPH_SMOKE_PASSWORD=… \
  bun run k8s:smoke --kube-context <ctx> --namespace ryph --unreachable 10.20.0.3:5432
```

Each database must exist or be creatable by its user: the chart creates the ones that are missing
(except `ryph`, `ryph_history` and `ryph_keys`, which you create).

On a managed cluster that answers DNS from a node-local cache, add its address to
`networkPolicy.dns.extraCidrs` (GKE Autopilot: `169.254.20.10/32`), or every pod held on the way out
loses DNS.

## Upgrade, rollback, uninstall

```sh
helm upgrade ryph deploy/helm/ryph -n ryph-system -f my-values.yaml --wait --timeout 15m
```

Every pod with a database applies its owner's migrations before it starts
([Migrations](#migrations)), so an upgrade needs nothing else. `--wait` makes the command fail when
a pod does not come up — a failed migration, say — instead of returning while it crash-loops.

While the new pods migrate and start, the old ones keep serving — for the services that roll. Three
do not: **automations** is replaced (`Recreate`: the old pod stops before the new one starts),
**Radicle** is a one-replica StatefulSet, and **previews** is one `Recreate` Deployment per ordinal
(`previews`, or `previews-0` … with `previews.replicas` above 1), each pod holding its own runs'
previews, so each is down from its stop to its replacement's start. Changing `previews.replicas`
restarts every previews pod and every preview reconnects; set it in values, never by scaling a
Deployment (a second pod of an ordinal would split its runs' state). Either way the change has a
window that heals by itself as the rollout finishes: from 1 to N, a control plane still running
without `RYPH_PREVIEWS_PEER_HOST` refuses the `tunnelBase` a new pod names ("bad tunnel base"), and
the runner re-registers on its backoff until the new control plane is up; from N to 1, a pod still
running with N names a `tunnelBase` the new control plane no longer accepts, until that pod is gone.
With one replica, a viewer whose preview pod is restarting meets the load balancer's own error page,
which does not reload itself; the previews' own pages ("back in a moment") reload only when a
previews pod answers, so with two or more only the restarting pod's runs wait, on a page that comes
back by itself. Automations and Radicle migrate in that gap too: while their migration runs they are
not serving, and one that fails keeps them down until it is fixed or rolled back. Previews has no
database and no migration; its gap is the restart alone, after which runners re-register. A
migration that the previous release's code cannot live with needs a maintenance window: scale the
service to zero, upgrade, and it comes back on the new schema.

**When an upgrade fails** (`Init:Error` or `Init:CrashLoopBackOff` on a `migrate` container): read
its log (`kubectl -n ryph logs <pod> -c migrate`). To abort, roll back what is broken, and the
previous images start again: the whole release with `helm rollback ryph <revision> -n ryph-system`,
or one service with `kubectl -n ryph rollout undo deploy/<service>` (`statefulset/radicle`).

Neither undoes a migration. drizzle-kit applies each migration in a transaction, so a migration that
failed left the schema as it was; but in an upgrade that applied several owners' migrations and then
failed on one, the others are applied, and the code you rolled back to runs on their newer schema.
That is safe exactly when those migrations were additive. The same goes for `--rollback-on-failure`
(`--atomic` before Helm 4): it rolls the images back and leaves applied migrations in place.

`helm uninstall ryph -n ryph-system` removes the Deployments, StatefulSets, Services, policies and
RBAC the chart created, and keeps:

- **every namespace the chart created** (`namespaces.keepOnUninstall`, on by default), and with them
  everything in them that Helm did not create: in-flight runs and check suites and their Secrets,
  hosted MCP servers and the tool guard (which keep running with nothing managing them), build
  volumes, and the Secrets you created yourself (`existingSecret`s, `postgres.urlSecrets`,
  `objectStore.existingSecret`, `radicle.key.existingSecret`).
- **the chart's Secrets** (`secrets.keepOnUninstall`, on by default), the egress proxy's included.
  They hold the keys that seal provider credentials, MCP credentials and chat bot tokens; a
  reinstall under the same release name adopts them, and the namespaces, again.
- **the Radicle key Secret** (always), **the Radicle node's volume** and **the dev Postgres's**: a
  StatefulSet's volumes outlive it. The dev object store's volume (`objects-data`) is deleted.
- **the PriorityClasses** (`priorityClasses.keepOnUninstall`), which other releases may use.

To start over, delete the namespaces by hand. With `namespaces.keepOnUninstall: false`, Helm deletes
them on uninstall, and everything in each goes with it, whatever its own annotations say: your own
Secrets, the volumes, the kept chart Secrets, the sealing keys.

**On a live install, never `helm uninstall`, `--rollback-on-failure`/`--atomic` or a values change
that stops rendering a namespace without knowing what goes.** With the defaults the data survives
and the deployment stops; a first install that fails under `--rollback-on-failure` is uninstalled
the same way.

## Migrations

Each service with a database runs an init container named `migrate` (the forge's is
`migrate-webhooks`) in its own image, before it starts, on every pod start. It applies that owner's
committed migrations with `drizzle-kit migrate`, which records what ran and applies only what is
new, in one transaction. A failed migration leaves the schema as it was and the pod in `Init:Error`.
For the services that roll, the old pods keep serving; automations and Radicle, which are replaced
rather than rolled, are down until it is fixed or rolled back
([Upgrade](#upgrade-rollback-uninstall)).

drizzle-kit's migrator takes no lock: it reads the newest applied migration and then applies what is
newer. Two pods starting together would both apply — a DDL statement fails and rolls back, but a
data-only migration would run twice. So the init container runs it under a session-level Postgres
advisory lock on that database ([`files/migrate-locked.ts`](files/migrate-locked.ts)): replicas take
turns, and the second finds nothing to do. A runner waiting for the lock logs who holds it (pid,
client, since when) every 30 seconds and gives up after `migrations.lockTimeoutSeconds` (10
minutes), so the pod fails and is retried rather than hanging in `Init`. Raise it above your longest
migration: a pod that gives up behind one still running only waits again. The lock's session turns
off the server's `idle_session_timeout`, `statement_timeout` and `lock_timeout`, so a managed
Postgres that sets them for every role cannot end it mid-migration. If that connection closes anyway
while the migration runs, the lock is gone with it, so the runner stops the migration (SIGTERM, then
SIGKILL after 10 seconds) and fails, and the pod is retried. Connecting gives up after two minutes.
Its log names the database only by the variable that holds the URL, never anything from the URL. The
migration tool's own output is passed through as it is, and can name the host and port on a
connection error.

**Migration URLs must reach Postgres directly.** A session lock lives on one server connection.
Behind a transaction-mode pooler — PgBouncer in `transaction` mode, a "pooled" Neon or Supabase URL
— it is taken on whichever connection the pooler lent and released, or kept, by chance. Point every
owner's URL at the server itself (or a session-mode pooler). The lock's connection ignores the URL's
`idle_timeout` and `max_lifetime`, so the pool sizing in `postgres.params` cannot close it mid-run.

Why not Helm hooks: a `pre-install` hook runs before anything else exists — the namespaces the Jobs
would run in, their Secrets, the dev database. A `post-install`/`post-upgrade` hook runs after the
new code has rolled, which is the wrong order, and with `--wait` an install deadlocks (the services
are never ready without their schema). Hooks also leave Jobs behind and do not run under GitOps
tools that render the chart themselves. An init container has the order right by construction, needs
nothing that is not already in the pod, and passes through the same NetworkPolicy as the service.
The price is the one above: a migration's failure is its service's outage where the service is not
rolled. A separate gate that migrates before any pod is replaced could be offered as an option
later.

`migrations.enabled: false` turns the init containers off; you then apply migrations yourself before
each upgrade.

## The namespace model

| namespace (default) | holds                                     | Pod Security |
| ------------------- | ----------------------------------------- | ------------ |
| `ryph`              | the services                              | restricted   |
| `ryph-runs`         | agent runs and check suites, one Job each | baseline     |
| `ryph-tools`        | hosted MCP servers and the tool guard     | restricted   |
| `ryph-builds`       | environment builds (rootless BuildKit)    | privileged   |
| `ryph-egress`       | the egress proxy, alone                   | restricted   |
| `ryph-state`        | dev Postgres and SeaweedFS (`devState`)   | baseline     |

The control plane may create Jobs, Secrets (write-only) and its reserved-capacity placeholders in
the runs namespace and nothing else there; the mcp-gateway may launch Deployments and Services in
the tools namespace and nothing else. Those two are the only pods with a Kubernetes API token, and
neither Role reaches outside its one namespace. A run's own pod has no token and no cloud identity.

All names come from `namespaces.prefix` (`<prefix>`, `<prefix>-runs`, …) or one value each. Two
releases with different prefixes run side by side on one cluster and share nothing namespaced.

### Pre-created namespaces

With `namespaces.create: false`, create them first with these labels (the PSS levels above, plus).
`namespaces.labels` adds labels to the namespaces the chart creates, but no
`pod-security.kubernetes.io/` key: the levels are the chart's, and a `*-version` key would pin
`restricted` to an older, weaker definition.

```yaml
# the services namespace
ryph.dev/services: "true" # what a shared Gateway can select on
pod-security.kubernetes.io/enforce: restricted
# runs
pod-security.kubernetes.io/enforce: baseline
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/audit: restricted
# tools, egress
pod-security.kubernetes.io/enforce: restricted
# builds
pod-security.kubernetes.io/enforce: privileged
pod-security.kubernetes.io/warn: baseline
pod-security.kubernetes.io/audit: baseline
# state (devState only)
pod-security.kubernetes.io/enforce: baseline
```

`namespaces.create: false` also skips the state namespace, which `devState` then needs created.

## The network boundary

The services namespace denies all ingress and opens each port to exactly its callers. The runs,
tools, builds and egress namespaces deny everything both ways and open what each needs.

- A **run** reaches DNS, five services (control plane, historian, forge, model-proxy data port,
  mcp-gateway data port), the previews tunnel when previews are on, and the egress proxy. It has no
  route to the internet of its own: it reaches it through the egress proxy, which checks every
  hostname against the signed allowlist the run presents.
- A **check suite** reaches DNS, the forge and the egress proxy. A **build** the same.
- **previews** takes runners' tunnels on 7491 (run pods alone), the control plane's calls on 7493
  (the control plane alone; no run reaches it, so a run flooding the tunnel port cannot reach the
  control plane's calls), and browsers on 7490 (the front door alone). It dials nothing with one
  replica. With several (`previews.replicas`), its pods reach each other's peer and API ports
  (7492, 7493) through each ordinal's own Service, and DNS, and nothing else. A run dials its
  owner's tunnel port (7491) there, and never reaches the peer or API port.
- **memory, chat, web and the model-proxy** fetch addresses a person, a bot or an agent chose, so
  they are held on the way out too: DNS, their peers, their database, and the internet with every
  private and link-local range excepted (chat and web on 443 only). A self-managed GitLab on a
  private address is therefore out of memory's reach (a repo-file ingest reads raw files from it):
  `gitlab.egressCidrs` opens memory's egress to its addresses, on `gitlab.url`'s port alone. The
  forge is not held on the way out and reaches it as is.
- The **thumbnail renderer** may reach nothing at all, not even DNS.
- A hosted **MCP server** takes traffic from the tool guard alone, the guard from the mcp-gateway
  alone. A hosted server reaches DNS and the public internet with every private range excepted. This
  is the shape the docker launcher copies with an internal tools network, the guard as the one
  container also on an ordinary one, and an egress relay to the egress proxy's tool listener, which
  opens public hosts and nothing private ([compose](../../compose/README.md#security)). The caller
  token the guard presents still rides every forward: it keeps one hosted server from speaking to
  another's, and it is the second line rather than the only one.

- The **dev state** (`devState`) admits the services namespace alone.

What the cluster knows and the chart cannot is added by named knobs, each landing only on the rules
it names: `networkPolicy.dns.extraCidrs`, `networkPolicy.internet.extraExcept`,
`networkPolicy.database.extraCidrs`/`peers`/`extraPorts`, `networkPolicy.frontDoor.from`. Anything
else goes in `networkPolicy.extraIngress`/`extraEgress`, keyed by policy name, and can only add
rules. A key that names no policy fails the render, and so does a rule without its peers (`from` for
ingress, `to` for egress): a rule with none admits every source or reaches every destination. So
does a peer without an `ipBlock` whose every selector is empty: `namespaceSelector: {}` is every pod
in every namespace, and a lone `podSelector: {}` is every pod in the policy's own namespace (the
runs, for a run policy's rule). A peer in the policy's own namespace is named by its labels. They
take:

- `extraIngress`: `control-plane`, `historian`, `memory`, `chat`, `web`, `forge`, `automations`,
  `model-proxy`, `mcp-gateway`, `app`, `egress-proxy`, `previews`, `radicle`.
- `extraEgress`: `memory`, `chat`, `web`, `model-proxy`, `radicle` (the services held on the way
  out), `agent-run-egress`, `check-run-egress`, `environment-build-egress`, `egress-proxy`,
  `tool-server`.

**Where the database is.** The services held on the way out (memory, chat, model-proxy, Radicle)
reach their database only through a rule that names it; the others are not held on the way out and
need nothing. A Postgres outside the cluster: its address in `networkPolicy.database.extraCidrs`.
One inside it that an operator runs (CloudNativePG, Crunchy, Zalando): its pods as peers, applied to
every database rule:

```yaml
networkPolicy:
  database:
    peers:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: databases
        podSelector:
          matchLabels:
            cnpg.io/cluster: ryph
```

A peer whose every selector is empty (`namespaceSelector: {}` alone, say) is every pod, and the
schema refuses it. The database's own namespace may hold policies of its own; it must admit the
services namespace.

## Secrets

Every service reads its secrets from a Secret named after itself (`control-plane`, `historian`, …,
`egress-proxy` in the egress namespace), through `envFrom`. For each, either:

1. **Bring your own**: set `<service>.existingSecret` to a Secret you manage (External Secrets,
   Sealed Secrets, `kubectl create secret`). The chart creates none for that service; your Secret
   must hold the keys listed below.
2. **Let the chart create it** from values (`postgres`, `objectStore`, `github`, `gitlab`,
   `web.searchKey`, `radicle.*`, `<service>.extraSecretData`) and from **internal credentials** —
   the tokens the services use with each other and the encryption keys only one service holds. An
   internal credential is taken from `secrets.internal.<KEY>` if you set it; else from the Secret
   already in the cluster (Helm's `lookup`), so it survives upgrades; else generated (64 hex
   characters). Every service that shares a credential gets the same value.

Database URLs can also come from a Secret of your own per owner (`postgres.urlSecrets`), and the
object store keys from `objectStore.existingSecret`.

**When the chart refuses to generate.** A credential minted over one that already exists is silent
loss — for the sealing keys below, of everything they sealed. So the chart generates one only where
it can tell it is new, and otherwise fails the render naming what to supply:

- **No cluster access.** `helm template`, Argo CD (which renders with `helm template`),
  `helm
  install --dry-run` (without `=server`): `lookup` answers empty there whether the
  deployment has its Secrets or not, and each render would mint different values. Give every
  credential through `secrets.internal` (from a sealed or external source) or every service an
  `existingSecret`, or render with cluster access (`helm install`/`upgrade`, `--dry-run=server`).
- **A sealing key that would be new on an upgrade**, or on an install where its service already
  runs: the services namespace was renamed, a service moved off an `existingSecret`, or an existing
  deployment is being adopted. Supply the value it has today through `secrets.internal`.

A fresh install with cluster access needs none of this. `secrets.allowNewSealingKeys: true` turns
both refusals off; it is for a throwaway render or a deployment with nothing sealed, and on any
other it destroys every provider key, MCP credential and bot token users stored. The chart cannot
tell a fresh cluster restored from a database backup from a new deployment: restoring, supply the
old keys through `secrets.internal` before the first install.

**Never lose the encryption keys.** `RYPH_SECRETS_KEY`, `RYPH_MCP_KEY` and `RYPH_CHAT_KEY` seal what
users store. A new value cannot read anything sealed with the old one. Back them up. In production,
keep them in an external store (External Secrets, Sealed Secrets, your cloud's secret manager) and
hand them to the chart through `existingSecret` or `secrets.internal`, rather than letting the chart
generate them into the cluster alone.

**Helm's release records hold every Secret the chart creates.** Helm stores each revision of the
release — its rendered manifests, Secrets included — as a Secret `sh.helm.release.v1.<release>.v<N>`
in the release namespace (`ryph-system` here), up to `--history-max` revisions (10 by default). So
anyone who can read Secrets there can read every chart-created credential, current and past: give
the release namespace the same Secret RBAC as the services namespace. With `existingSecret` for
every service and no `secrets.internal`, the records hold no credential.

**Rotating a Secret you manage does not restart anything.** A pod reads its Secret once, at start,
and the chart cannot see a change in a Secret it did not render. After rotating one, restart its
readers (`kubectl -n ryph rollout restart deploy/<service>`), or put a version in the pod
annotations so the next `helm upgrade` rolls them:
`podDefaults.annotations: {ryph.dev/secrets: "2"}` (every service) or `<service>.podAnnotations`
(one). Chart-created Secrets roll their pods on change by themselves.

Internal credentials must be 32 characters or more (the chart refuses shorter ones); only
`secrets.allowDevSecrets` lets the short placeholders in [`values-dev.yaml`](values-dev.yaml)
through, and the chart refuses it without `devState.enabled`: a laptop install, nothing else.

### Moving an existing deployment onto the chart

An install the chart did not create (the Kustomize deployment, an older layout) has its credentials
in Secrets the chart does not know, under other names (Kustomize's `control-plane-<hash>`, …).

1. **Carry the credentials over.** Before the first `helm install`, read each internal credential
   out of the running deployment and pass it through `secrets.internal.<KEY>` — the sealing keys
   above all, which the chart refuses to mint over a running service — or point each service's
   `existingSecret` at the Secret it reads today.
2. **Adopt the objects.** The chart renders the same Deployments, Services, NetworkPolicies, RBAC,
   namespaces and PriorityClasses the old deployment has, under the same names and selectors, and
   Helm refuses to touch an object it does not own (`invalid ownership metadata`). Install once with
   `--take-ownership` (Helm 4, and 3.17+): it adopts every rendered object that already exists, and
   nothing else.

   On an older Helm, mark them as the release's first, as for the PriorityClasses in
   [Cluster-scoped objects](#cluster-scoped-objects) — exactly the objects the chart renders, so not
   Kustomize's hash-suffixed ConfigMaps and Secrets or each namespace's `kube-root-ca.crt`:

   ```sh
   # Names only: a client-side render lists every object a fresh install would create. The flag
   # lets it render whichever internal credentials step 1 did not supply; nothing is applied.
   helm template ryph ./deploy/helm/ryph -n ryph-system -f values.yaml \
     --set secrets.allowNewSealingKeys=true > rendered.yaml
   kubectl annotate --overwrite -f rendered.yaml \
     meta.helm.sh/release-name=ryph meta.helm.sh/release-namespace=ryph-system
   kubectl label --overwrite -f rendered.yaml app.kubernetes.io/managed-by=Helm
   rm rendered.yaml   # it holds the rendered Secrets
   ```

   Each object that does not exist yet reports `NotFound`; the install creates it. Either way,
   compare first: `helm install … --dry-run=server` (with `--take-ownership` where you use it)
   against the cluster shows what it would apply.
3. **Clean up after the cutover**, once every pod runs on the chart's Secrets
   (`kubectl -n ryph get pods`): the old deployment's one-shot migration Jobs, which the init
   containers replace
   (`kubectl -n ryph delete job migrate-control-plane migrate-historian
   migrate-model-proxy migrate-mcp-gateway migrate-webhooks migrate-automations …`,
   every `migrate-*`), and its hash-suffixed Secrets (`control-plane-<hash>`, …, and
   `egress-proxy-<hash>` in the egress namespace). Delete those only after step 1 copied their keys
   and no pod reads them: they are the old copy of the sealing keys.

**Turning `namespaces.create` on later** is the same adoption: namespaces you created yourself carry
no Helm ownership, and the upgrade fails with `invalid ownership metadata` until they do. Run it
with `--take-ownership`, or annotate and label each namespace as above. The other way, true to
false, leaves them in place (with `namespaces.keepOnUninstall`, the default) but no longer the
release's.

Production refuses to boot on the placeholder secrets this repository publishes: every service
checks its environment at boot. Only `secrets.allowDevSecrets` (dev values) lets them through.

### The Secret contract

Required keys must be present; optional keys may be left out. "Internal" means generated and shared
by the chart unless you bring your own; a key held by several Secrets must have the same value in
each.

| Secret (key)                                                                                                                                            | Read by                    | Required          | What                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------- | ------------------------------------------------- |
| **control-plane**                                                                                                                                       |                            |                   |                                                   |
| `RYPH_DB`                                                                                                                                               | control plane, its migrate | yes¹              | its Postgres URL                                  |
| `RYPH_FORGE_TOKEN`                                                                                                                                      | also forge                 | yes               | internal                                          |
| `RYPH_HISTORY_TOKEN`                                                                                                                                    | also historian             | yes               | internal                                          |
| `RYPH_MODEL_PROXY_TOKEN`                                                                                                                                | also model-proxy           | yes               | internal                                          |
| `RYPH_MCP_GATEWAY_TOKEN`                                                                                                                                | also mcp-gateway           | yes               | internal                                          |
| `RYPH_AUTOMATIONS_TOKEN`                                                                                                                                | also automations           | yes               | internal                                          |
| `RYPH_MEMORY_TOKEN`                                                                                                                                     | also memory                | yes               | internal                                          |
| `RYPH_CHAT_TOKEN`                                                                                                                                       | also chat                  | yes               | internal                                          |
| `RYPH_PLATFORM_TOKEN`                                                                                                                                   | also model-proxy, memory   | yes               | internal                                          |
| `RYPH_EGRESS_KEY`                                                                                                                                       | also egress-proxy          | yes               | internal; signs run egress claims                 |
| `RYPH_PROXY_SECRET`                                                                                                                                     | also app                   | yes               | internal                                          |
| `RYPH_S3_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY`                                                                                                          | control plane              | yes²              | object store keys                                 |
| SMTP and other control-plane settings                                                                                                                   | control plane              | no                | via `extraSecretData`                             |
| **app**                                                                                                                                                 |                            |                   |                                                   |
| `RYPH_PROXY_SECRET`                                                                                                                                     | app                        | yes               | same as the control plane's                       |
| `RYPH_ASSET_ACCESS_KEY_ID`, `RYPH_ASSET_SECRET_ACCESS_KEY`                                                                                              | app                        | no                | read-only key for the assets bucket               |
| **historian**: `RYPH_HISTORY_DB`¹, `RYPH_HISTORY_TOKEN`                                                                                                 | historian                  | yes               |                                                   |
| **model-proxy**: `RYPH_DB`¹, `RYPH_SECRETS_KEY`, `RYPH_MODEL_PROXY_TOKEN`, `RYPH_PLATFORM_TOKEN`                                                        | model-proxy                | yes               | `RYPH_SECRETS_KEY`: 64 hex, seals provider keys   |
| **mcp-gateway**: `RYPH_DB`¹, `RYPH_MCP_KEY`, `RYPH_MCP_GATEWAY_TOKEN`, `RYPH_MEMORY_GATEWAY_TOKEN`, `RYPH_CHAT_GATEWAY_TOKEN`, `RYPH_WEB_GATEWAY_TOKEN` | mcp-gateway                | yes               | `RYPH_MCP_KEY`: 64 hex, seals MCP credentials     |
| mcp-gateway: `RYPH_FORGE_GATEWAY_TOKEN`                                                                                                                 | mcp-gateway, forge         | with forge tools³ | internal                                          |
| **memory**: `RYPH_MEMORY_DB`¹, `RYPH_MEMORY_TOKEN`, `RYPH_MEMORY_GATEWAY_TOKEN`, `RYPH_PLATFORM_TOKEN`                                                  | memory                     | yes               |                                                   |
| **chat**: `RYPH_CHAT_DB`¹, `RYPH_CHAT_KEY`, `RYPH_CHAT_TOKEN`, `RYPH_CHAT_GATEWAY_TOKEN`                                                                | chat                       | yes               | `RYPH_CHAT_KEY`: 64 hex, seals bot tokens         |
| **web**: `RYPH_WEB_GATEWAY_TOKEN`                                                                                                                       | web                        | yes               |                                                   |
| web: `RYPH_WEB_SEARCH_KEY`                                                                                                                              | web                        | no                | without it: fetch only, no search                 |
| **forge**: `RYPH_FORGE_DB`¹, `RYPH_FORGE_TOKEN`                                                                                                         | forge, its migrate         | yes               |                                                   |
| forge: `RYPH_S3_ACCESS_KEY_ID`, `RYPH_S3_SECRET_ACCESS_KEY`                                                                                             | forge                      | yes²              | the same object store keys                        |
| forge: `RYPH_GITHUB_APP_ID`, `RYPH_GITHUB_CLIENT_ID`, `RYPH_GITHUB_CLIENT_SECRET`                                                                       | forge                      | with a GitHub App | plus Secret `forge-github-app` (`github-app.pem`) |
| forge: `RYPH_GITHUB_WEBHOOK_SECRET`                                                                                                                     | forge                      | no                |                                                   |
| forge: `RYPH_GITLAB_TOKEN`                                                                                                                              | forge                      | with GitLab       | or `gitlab.tokenSecret` (key `token`)             |
| forge: `RYPH_GITLAB_WEBHOOK_SECRET`, `RYPH_GITLAB_CLIENT_ID`, `RYPH_GITLAB_CLIENT_SECRET`                                                               | forge                      | no                | bot mode only                                     |
| `gitlab.caSecret` (its `key`, default `ca.crt`)                                                                                                         | forge, memory              | no                | a private CA's PEM, not a secret                  |
| **automations**: `RYPH_AUTOMATIONS_DB`¹, `RYPH_AUTOMATIONS_TOKEN`                                                                                       | automations                | yes               |                                                   |
| **egress-proxy** (egress namespace): `RYPH_EGRESS_KEY`                                                                                                  | egress proxy               | yes               | same as the control plane's                       |
| **previews**: `RYPH_PREVIEWS_TOKEN`                                                                                                                     | previews, control plane    | with previews     | 32 characters or more                             |
| **radicle**: `RYPH_RADICLE_DB`¹, `RYPH_RADICLE_TOKEN`, `RAD_PASSPHRASE`                                                                                 | bridge, node, forge        | with Radicle      | passphrase may be empty                           |
| radicle: `RYPH_RADICLE_ALIAS`, `RYPH_RADICLE_CONNECT`, `RYPH_RADICLE_EXTERNAL_ADDRESS`, `RYPH_RADICLE_EXPLORER_URL`                                     | node, bridge, forge        | no                |                                                   |
| **radicle-key** (`radicle.key`): files `radicle`, `radicle.pub`                                                                                         | node                       | with Radicle⁴     | the deployment's identity                         |

¹ Unless `postgres.urlSecrets.<owner>` names another Secret for it. ² Unless
`objectStore.existingSecret` holds them (both services read it). Static keys either way: both refuse
to boot without them, and a workload identity does not stand in (on GCS, use HMAC keys). ³ Forge
tools are on when the forge has a GitHub App, GitLab or Radicle (`forgeTools: auto`). ⁴ Without it
the node generates an identity on its volume. Laptop clusters only.

## Cluster-scoped objects

The chart creates only its namespaces and reserved capacity's PriorityClasses
(`ryph-reserved-capacity-0` … `-9` at -10 … -1, `ryph-workload`, `ryph-tool-host`). The services
name those classes literally, and a priority is a number on one cluster-wide scale, so every release
on a cluster shares the same ones: exactly one release sets `priorityClasses.create: true`, the
others `false`. A second release that leaves it `true` is refused at render time, naming the owner.
They are kept on uninstall by default, so removing the owning release does not get the others' pods
refused.

**Handing them to another release**, after the owner is uninstalled (its classes kept): the classes
still name the old release, so mark them as the new owner's, then set `create: true` on it:

```sh
for pc in $(seq -f 'ryph-reserved-capacity-%g' 0 9) ryph-workload ryph-tool-host; do
  kubectl annotate --overwrite priorityclass "$pc" \
    meta.helm.sh/release-name=<new release> meta.helm.sh/release-namespace=<its namespace>
  kubectl label --overwrite priorityclass "$pc" app.kubernetes.io/managed-by=Helm
done
```

The same adopts classes an older, non-Helm deployment created.

**Changing `workloadValue` or `toolHostValue`**: a PriorityClass's value is immutable. The chart
sees the change before applying anything and refuses it; delete the class
(`kubectl delete priorityclass
ryph-workload`) and upgrade straight after. Running pods keep their
priority; a run launched in between is refused until the class is back. Both values must be 0 or
more: the rungs sit at -10 … -1, and real work must outrank all of them.

## The front door

Four paths reach the cluster, and no others: `/` to the app, `/v1/hooks/github` and
`/v1/hooks/gitlab` (exact) to the forge's GitHub and GitLab webhook intake, the rest of `/v1/hooks/`
to the automations service's hooks door. GitLab's path must reach the forge: under the automations
prefix a delivery would be refused as an unknown mailbox, and GitLab disables a hook that keeps
failing. With `forge.replicas` above one, every forge replica takes deliveries at the door and only
the one holding the mailroom's lock delivers them, so GitLab's webhook call budget (600 calls a
minute) holds for the deployment, not per replica. The mailroom abandons a tick stuck for a minute
and carries on; the forge's and automations' `/healthz` answer 503 only once three ticks in a row
were abandoned, so the liveness probe restarts a replica whose delivery keeps wedging instead of
leaving it accepting hooks it never delivers. A database outage never trips it: every database call
a tick makes gives up within seconds, so the forge's git traffic, which needs no database, stays up
through one. With previews on, `*.<previews.domain>` goes to the previews service's public port;
previews need a registrable domain the app is not on, and a wildcard certificate for it.

**The client's address.** Sign-in is rate limited per client address, which the app takes from the
connection unless `app.addressHeader` and `app.xffDepth` say which forwarded header carries it.
Behind a load balancer or an ingress controller, set them (e.g. `x-forwarded-for` and `"2"` behind
Google's load balancer): otherwise every visitor shares the balancer's address and one stranger's
bad passwords hold sign-in at 429 for everyone. The limit lives in each control-plane process, so
`controlPlane.replicas` above one allows that many times the attempts.

Use an `Ingress` (`ingress.*`) or Gateway API routes attached to your own Gateway (`httpRoute.*`).
Either way, set `networkPolicy.frontDoor.from` to what fronts the cluster (your load balancer's
source ranges, or your ingress controller's namespace): the app's policy then admits only those, and
the forge, the hooks door and the previews public port admit them at all. Without it the app admits
every source and the other three admit nothing from outside the cluster.

**GitLab on a private network.** A self-managed GitLab refuses to deliver a webhook to a private
address and says the URL is blocked when the hook is saved. If the front door's address is one, an
administrator lets it through under **Admin → Settings → Network → Outbound requests**: add ryph's
host to **Local IP addresses and domain names that hooks and integrations can access**, or, broader,
tick **Allow requests to the local network from webhooks and integrations**. The other direction is
`gitlab.egressCidrs` (above, "The network boundary").

**GitLab with a private CA.** An instance whose certificate is self-signed, or issued by an internal
CA, is trusted by nothing in the images, so the forge cannot start (its first call to GitLab fails)
and memory cannot read repository files from it. Put the CA's PEM in a Secret in the services
namespace and name it:

```sh
kubectl -n ryph create secret generic gitlab-ca --from-file=ca.crt=./gitlab-ca.pem
```

```yaml
gitlab:
  caSecret:
    name: gitlab-ca
    key: ca.crt # the default
```

The two services that dial GitLab mount it read-only and trust it beside the public CAs:
`NODE_EXTRA_CA_CERTS` for their HTTP calls, on the forge and memory, and `GIT_SSL_CAINFO` for the
forge's git. That one replaces git's bundle rather than adding to it, so the forge's points at a
bundle an init container builds before it starts: the image's own public CAs with yours after them,
which keeps GitHub's clones working and follows the image's CAs on every upgrade. The Secret holds
your CA alone. Runs, check suites and builds clone through the forge's git gateway and never dial
GitLab, so they need nothing. A `gitlab.url` on plain http has no certificate to trust and is
refused with `caSecret`.

**Long-lived responses.** A run's transcript streams to the browser (Server-Sent Events, through the
app) for as long as the run lasts, and a preview holds WebSockets open. Whatever fronts the app must
not cut a response after its default timeout (60 s for ingress-nginx, 30 s for Google's load
balancer). With ingress-nginx:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  previews:
    annotations:
      nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

An hour, and the stream's own reconnect covers the rest. Do not add session affinity: during a
rollout the app answers a chunk of either build from the asset fallback (`app.assetFallback`), and a
cookie pinned to a draining pod only turns that into `no healthy upstream`.

Provider-specific objects (backend timeouts, health-check policies, an internal load balancer) go in
`extraObjects`, rendered through `tpl` so they can name the release's namespaces.

## Sizing previews

Each previews pod holds its runs' previews in memory, and both what an agent's dev server sends and
how fast a viewer reads are someone else's choice. So a pod does not size itself by estimate: it
measures its own memory about once a second (its cgroup's usage, less the inactive file cache,
against `previews.resources.limits.memory`) and acts on two watermarks, each left only 5 points
below where it is entered, so a pod near one does not flap:

| past                                                                | it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3/4 of the limit (576 MiB of 768Mi)                                 | names **culprits**, but only at a sample at or past 3/4 (between 0.70 and 3/4, on the way down, it keeps and releases them and names nobody new), never within 10 s of naming one or closing at least 1 MiB unless usage rose 1% of the limit since the first of those (what closing frees shows in the counter seconds later), and only when what the runs hold between them explains at least half of how far the pod has grown since its baseline (the least it held below 3/4 over the 5 minutes before it was pressed, never more than 0.65 of the limit, so at least 77 MiB of growth at 768Mi; with none yet, nobody); otherwise nobody, and a `previews.memory.unexplained` warning. When the runs' bytes explain it but none holds its share of it (below), nobody either, and a `previews.memory.no_culprit` warning names the largest holder and what it holds. A culprit is a run (or relayed run) whose measured bytes — unread stream bytes either way and what their browsers' sockets hold (the kernel's buffers counted while they fill), plus 16 KiB for each stream holding any (and 128 KiB for each not measured yet, a WebSocket whose upgrade is not answered yet), tunnel send queue, request bodies read or paused while waiting — are at least 1 MiB, at least the mean of those holding any, and at least its share of half the growth, split among those past the mean. Idle streams count nothing, so open tabs never name a run. A lone run explains at most twice what it can hold at the caps: some 17 MiB of streams (64 stalled downloads at some 272 KiB each), up to 64 MiB of uploads paused while they wait in its line (at most 128 of them, at up to 512 KiB each: what was read of each, counted live, and 128 KiB of kernel buffer; the next is a 503, `cap: run-paused`), some 6 MiB of small bodies paused in the rest of its line, a few MiB of early bodies and its tunnels' queues, some 100 MiB in all. So at 768Mi it can be named at 3/4 only once the baseline is at least about half the limit (~0.48–0.54, by how full its line is), and otherwise is met at 9/10 instead, as is memory that grows slowly without being any run's bytes. The baseline's cap stays 0.65 on purpose: at 0.70 the growth to explain would be only 5% of the limit (38 MiB at 768Mi), which an honest busy run's ~17 MiB of streams all but explains. A culprit stays one until the pod is back under 0.70, or it has held less than 1 MiB for a minute. Culprits get nothing new (a page load gets "back in a moment", which reloads itself after 2–5 s), lose their place in line, have every tunnel of theirs whose queue is more than two frames past what its streams are owed cut, and **lose every stream holding bytes**, progressing or not. **Nobody else is touched**; with no culprit, nothing more happens until 9/10. On entering it, once, public and peer connections idle 15 s or more are closed |
| 9/10 (691 MiB)                                                      | refuses **everyone** and empties every line; cuts every tunnel whose queue is more than two frames past what its streams are owed, whoever's, all at once; closes streams, the culprits' first, then those making no progress, then the largest, until what they held covers the way back under 3/4, at most a quarter of them, and then waits 10 s for the freed memory to show (not past 95%); each time a `previews.memory.shed` warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9/10 for at least 1 min, and the latest shed found nothing to close | is **stuck**: fails `/healthz` (`previews.memory.stuck`, an error): the liveness probe (three failures 10 s apart, 5 s each to answer) restarts the pod some 30 s later, its runners re-register, and every link and viewer cookie survives it. It passes again as soon as that stops holding (below 0.85, or a shed finds something). Compose's healthcheck asks `/readyz`, and Docker does not restart an unhealthy container, so compose never restarts it for this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

It leaves 3/4 below 0.70 and 9/10 below 0.85. Each time the culprit set changes it says so in a
`previews.memory.culprits` warning (runs by id, relayed runs by shard, the 16 holding the most with
`heldMiB` each, `baselineMiB` and `overMiB` past it, never anything secret). The watermarks are
`RYPH_PREVIEWS_MEMORY_HIGH` and `RYPH_PREVIEWS_MEMORY_CRITICAL` (fractions, in `previews.extraEnv`).
Keep the request equal to the limit: below it, a node short of memory may evict the pod before it
nears its own limit.

Fairness inside that is by counts, constants of the service: a run holds at most 64 streams (one
tunnel's width), 48 of them WebSockets or event streams, and 512 requests waiting; a pod's own runs
768 streams in all (twelve runs at their caps), 576 of them long-lived; with several replicas, a pod
relays at most 384 browser requests for runs other pods own, 32 per run, apart from those 768, and
has at most 768 of them waiting, in a line apart from its own runs' 1536. Those counts do not grow
with memory: past about 1 GiB a bigger limit only moves the watermarks. So which knob a refusal asks
for depends on its `cap` (`preview.refused`):

| `preview.refused` says                                            | it means                   | do                                                    |
| ----------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| `cap: memory-high`, `memory-critical` in normal use               | the pod's memory is short  | raise `previews.resources` memory (request and limit) |
| `cap: pod`, `pod-long`, `pod-line`, `pod-relay`, `pod-relay-line` | the pod's counts are full  | add replicas (`previews.replicas`, experimental)      |
| `cap: run…`, `relay…`, `tunnel`                                   | one run is at its own caps | nothing: a run never holds more, whatever the pod has |
| a registration answered `preview limit reached` (429)             | the pod holds 256 previews | add replicas (experimental)                           |

`previews.memory` (logged every minute while anything is open: memory, RSS, heap, the level, its
culprits and `attributedMiB` — what it measured of the runs, beside the pod's memory — streams open,
waiting and relayed, connections per listener) shows how near the watermarks a pod runs. Several
replicas are experimental (below).

How many hostile runs it takes: a hostile run holds every stream its caps allow, on endless answers
nobody reads (a few MiB of unread frames, and 64 sockets with their kernel buffers). One such run
past 3/4 is a culprit, refused alone and its streams closed; honest runs holding less than the mean
keep their service (one that holds the mean or more while the pod is at 3/4 is named with it).
Memory no run's bytes explain (the runtime's slack, the kernel's) names nobody, so it cannot be
steered onto whichever honest run is busiest: if it reaches 9/10, everyone is refused until it is
back under 0.85. Twelve hostile runs fill a pod's stream counts before any of that, and an honest
run then waits for a stream; twelve also fill its line at their floors (128 each), and eight that
take all the line lets them do (the first three past their floors), so that some twelve colluding
runs per pod is where it starves the others, by design (the counts' own fairness).

`previews.capSocketBuffers` keeps every socket's kernel buffers at 128 KiB each way: they count
against the limit, and left to the kernel a page that never reads could grow them faster than a
once-a-second sample sees. Turning it off removes that protection, and more memory does not make up
for it; a pod whose sockets may grow past 128 KiB says `previews.socket_buffers_uncapped` at boot.

Nothing fails readiness for memory: Google's external Application Load Balancer answers 503 for
every request when every backend is unhealthy, so a health check that failed under pressure could
take every preview down at once. `/healthz` and `/readyz` answer only a request whose Host is no
name under the preview domain (the kubelet and the balancer ask by the pod's address), with `ok` or
`not ok`.

### Several previews replicas (experimental)

`previews.replicas` above 1 is **experimental, not run in any cell yet**. Replicas spread runs over
pods, so one pod's pressure or restart reaches fewer runs; they do not make any one run's previews
more available (each lives on one pod, with no failover). Before turning it on in a cell:

- a live GKE test at N=2: a runner dials its owner's per-ordinal Service on `:7491`; the control
  plane's calls through either ordinal's `:7493` reach the owner; browser requests through either
  pod reach the owner; a rollout; 1→2→1; killing one ordinal; a hung-node eviction;
- the relay's memory measured under load, and `previews.resources` sized for it;
- alerts on `preview.refused` with `cap: peer` and the `pod…` caps.

## GKE Autopilot

What a GKE Autopilot cluster needs beyond the production values above:

- **Private pod and Service ranges.** Autopilot puts Services in `34.118.224.0/20` unless told
  otherwise, and that is not a private range. Every "internet, private ranges excepted" rule would
  then let traffic through to every Service. Create the cluster with its pod and Service ranges
  inside 10/8.
- **DNS.** Add the node-local DNS cache, `169.254.20.10/32`, to `networkPolicy.dns.extraCidrs`.
- **The API server.** A public control-plane endpoint is outside every private range: add its
  address to `networkPolicy.internet.extraExcept`, and check with `k8s:smoke --unreachable
  <address>:443`.
- **Previews' socket buffers.** `previews.capSocketBuffers` (on by default) sets the pod sysctls
  `net.ipv4.tcp_rmem` and `tcp_wmem`, which Autopilot admits as safe sysctls from Kubernetes 1.32
  (checked on GKE 1.35 Autopilot: admitted under the `restricted` Pod Security level, scheduled, and
  in effect in the pod). On a cluster older than 1.32 the previews pods are refused
  (`SysctlForbidden`): set it to `false` there, knowing that removes the protection.
- **gVisor.** GKE Sandbox serves `runtimeClassName: gvisor`. The first sandboxed pod waits for
  Autopilot to make a node for it, a few minutes on a fresh cluster; until then it shows
  `FailedScheduling` beside `TriggeredScaleUp`. That is the node being made, not a fault.
- **Check pods.** gVisor counts a sandbox's CPUs once, at pod start, and Autopilot's default nodes
  start with only a few CPUs online, so a check pod may see 2 of the 7 it asked for. A ComputeClass
  on a fixed machine family has every CPU online from boot:

  ```yaml
  checks:
    computeClass: ryph-checks
  extraObjects:
    - apiVersion: cloud.google.com/v1
      kind: ComputeClass
      metadata:
        name: ryph-checks
      spec:
        autopilot: { enabled: true }
        nodePoolAutoCreation: { enabled: true }
        priorities:
          - { machineFamily: n2d, minCores: 8 }
          - { machineFamily: n2, minCores: 8 }
        whenUnsatisfiable: DoNotScaleUp
  ```

- **The load balancer** (Gateway API routes on a GKE Gateway). Three policies per backend Service,
  in `extraObjects`, all attached to the Service directly:
  - a `GCPBackendPolicy` on the app (and previews): `timeoutSec: 3600`, because the default 30 s
    applies to the whole response and cuts every transcript stream; unsampled access logs, because a
    503 the balancer answers itself carries its reason (`statusDetails`) only there; and 30 s of
    connection draining. The forge and automations get the draining alone.
  - a `HealthCheckPolicy` on `/readyz` for the app, the forge, automations and previews (with no
    `host`: previews answers its health routes only by address, "Sizing previews"). The balancer's
    own health check, not the kubelet's probe, decides whether an endpoint is in rotation; checking
    every 5 s with one good answer lets a new pod join as soon as it can, while the Deployments'
    `minReadySeconds` holds the old one until it has.
  - **no session affinity.** A cookie pinning a viewer to one pod (`GENERATED_COOKIE`) turns a
    rollout into `no healthy upstream` for everyone whose pod is draining. Chunk 404s during a
    rollout are what the asset fallback (`app.assetFallback`) fixes: every build's assets go to a
    bucket and any pod serves either build's chunk from it.

  ```yaml
  extraObjects:
    backend-app: |
      apiVersion: networking.gke.io/v1
      kind: GCPBackendPolicy
      metadata:
        name: app
        namespace: {{ include "ryph.ns.services" . }}
      spec:
        default:
          timeoutSec: 3600
          logging:
            enabled: true
            sampleRate: 1000000
          connectionDraining:
            drainingTimeoutSec: 30
        targetRef: { group: "", kind: Service, name: app }
    backend-forge: |
      apiVersion: networking.gke.io/v1
      kind: GCPBackendPolicy
      metadata:
        name: forge
        namespace: {{ include "ryph.ns.services" . }}
      spec:
        default:
          connectionDraining:
            drainingTimeoutSec: 30
        targetRef: { group: "", kind: Service, name: forge }
    # … the same for automations; previews as the app (timeout, logging, draining)
    health-app: |
      apiVersion: networking.gke.io/v1
      kind: HealthCheckPolicy
      metadata:
        name: app
        namespace: {{ include "ryph.ns.services" . }}
      spec:
        default:
          checkIntervalSec: 5
          timeoutSec: 5
          healthyThreshold: 1
          config:
            type: HTTP
            httpHealthCheck:
              port: 3000
              requestPath: /readyz
        targetRef: { group: "", kind: Service, name: app }
    # … the same for forge (port 7412) and automations (7414)
    health-previews: |
      apiVersion: networking.gke.io/v1
      kind: HealthCheckPolicy
      metadata:
        name: previews
        namespace: {{ include "ryph.ns.services" . }}
      spec:
        default:
          checkIntervalSec: 5
          timeoutSec: 5
          healthyThreshold: 1
          config:
            type: HTTP
            httpHealthCheck:
              port: 7490
              requestPath: /readyz
        targetRef: { group: "", kind: Service, name: previews }
  ```

  Set `networkPolicy.frontDoor.from` to Google's front-end and health-check ranges, `35.191.0.0/16`
  and `130.211.0.0/22`, or the health checks never reach a pod.

## Values reference

Every value is documented in [`values.yaml`](values.yaml);
[`values.schema.json`](values.schema.json) checks their types. [`values-dev.yaml`](values-dev.yaml)
is a complete laptop install.
