# ☸️ Runs on Kubernetes

`RYPH_PROVISIONER=kubernetes` launches each run as a `batch/v1` Job in a namespace of its own. It
works on any conformant cluster. It was written with GKE Autopilot in mind, but nothing in it is GKE
specific. The adapter is
[`adapters/provisioner/kubernetes.ts`](../src/adapters/provisioner/kubernetes.ts), and its header
explains each decision in full. In short:

- **One Job per run**, named `ryph-run-<runId>` and labelled `ryph.run=<runId>`, with
  `backoffLimit: 0` and, for a run with a wall clock, `activeDeadlineSeconds` — the run's limit plus
  the startup and cancel graces, so the reaper's cancel lands first and the Job's deadline is what
  remains when the reaper cannot. The orchestrator decides retries. The Job controller never retries
  a run, because a second pod would boot with the same, already spent, bootstrap token.
- **The env lives in a Secret, not in the pod spec.** The Job owns the Secret, and the container
  reads it with `envFrom`. Anyone who can `get pods` can read a pod's spec, and the bootstrap token
  must not be in it: inside its window it redeems for the run's credentials. The Job is created
  suspended, then the Secret is created with the Job's uid as its owner, and then the Job is
  released. That order means the Secret always exists before the pod starts. Deleting the Job, by
  its TTL or by a kill, takes the Secret with it.
- **The pod gets no cluster credentials.** `automountServiceAccountToken: false` keeps the service
  account token out of the pod, and `enableServiceLinks: false` keeps out the per-Service env vars
  Kubernetes would otherwise inject for the namespace. The API server's own address is injected
  regardless (`KUBERNETES_SERVICE_HOST`); without a token it grants nothing, and the runs-side
  NetworkPolicy below can deny it outright.
- **The container cannot gain privileges, and is not root.** `allowPrivilegeEscalation: false` and
  every capability dropped, beside the pod's `RuntimeDefault` seccomp profile, `runAsNonRoot` and an
  explicit `runAsUser`/`runAsGroup` — a number, which is the only form a kubelet can refuse to
  start, where an image's `USER` is the image's own promise. Those three sit on the runner container
  rather than the pod, because the pod also carries a task's service containers, which are vendor
  images that start as root and drop privileges themselves — which is why `ryph-runs` enforces
  `baseline` and only warns on `restricted`. `RYPH_K8S_RUN_USER` (default `1994:1994`, the agent
  images' `runner`) moves it for a harness image of your own; get it wrong and the run's clone is
  unwritable, so read the image's `USER` before you change it.
- **Cancel arrives on the heartbeat reply.** A pod's hostname is not resolvable in cluster DNS, so
  the orchestrator cannot push a cancel into the pod. The runner learns about the cancel from the
  reply to its next heartbeat, at most one heartbeat interval later. See
  [cancellation.md](cancellation.md). A kill deletes the Job, and the pod gets
  `RYPH_K8S_STOP_GRACE_SECONDS` (default 120) to commit and push before SIGKILL. A hard kill also
  deletes the pod with no grace period.

A `local` repository works here as on every provisioner: the run clones it through the gateway, and
nothing is mounted. It still has to be on the forge's own disk.

## What the control plane needs

[The Helm chart](../../../deploy/helm/ryph/README.md) has all of this as templates, the services
with it, and `bun run k8s:smoke` checks an install from a run's position. What follows is what the
chart encodes, for a deployment that brings its own.

A namespace for runs, kept apart from the services, and a Role in that namespace for the control
plane's service account:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ryph-runs
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ryph-provisioner
  namespace: ryph-runs
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "patch", "delete"]
  # create only: the control plane writes each run's Secret and never reads one back.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
  # a hard kill deletes the run's pod by label.
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["deletecollection"]
  # reserved capacity: one placeholder Deployment per size class, applied and pruned.
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["list", "create", "patch", "delete"]
  # and the Lease whose holder is the one replica that applies them.
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["create"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    resourceNames: ["ryph-reserved-capacity"]
    verbs: ["get", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ryph-provisioner
  namespace: ryph-runs
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ryph-provisioner
subjects:
  - kind: ServiceAccount
    name: control-plane
    namespace: ryph
```

And the priorities reserved capacity rests on: a ladder of ten its placeholders run at, the one
every run, check and build pod names so it always outranks them, whatever `globalDefault` class the
cluster has, and the one the MCP gateway's hosted tool servers name. All are cluster-scoped, and
every deployment on the cluster shares them:

```yaml
# ryph-reserved-capacity-0 (-10) to ryph-reserved-capacity-9 (-1), each like this one.
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ryph-reserved-capacity-0
value: -10
preemptionPolicy: Never
globalDefault: false
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ryph-workload
value: 0
preemptionPolicy: PreemptLowerPriority
globalDefault: false
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ryph-tool-host
value: 0
preemptionPolicy: Never
globalDefault: false
```

Hosted tool servers and their guard name `ryph-tool-host`: above every placeholder, so no slot holds
one back, but never preempting. On GKE they run on the same gVisor nodes as the placeholders, and a
tool server that found no room at 0 with the default policy would evict a run's warm slot, a whole
node, for a few hundred millicores. Instead it waits for a new node like any other pod.

`ryph-workload` and `ryph-tool-host` are 0 because that is what a pod gets on a cluster with no
`globalDefault` class, so there they sit level with everything else. A cluster with a
`globalDefault` class gives ordinary pods its value instead, ryph's own control plane, forge and
Postgres included, since they name no class. If the default is positive (say 1000), ordinary pods
outrank a run and can preempt it mid-work, and a run's Job never retries. If it is negative, a run
that finds no room evicts ordinary pods wherever the two share nodes, other tenants' and the control
plane supervising it alike. Either way, set both classes' value to the default, and keep every rung
below it. With a default from -9 to -1, re-create the rungs at or above it one below the default
(they then share a priority, and a run may take a larger slot among them). With a default of -10 or
lower no rung fits below it: reserve nothing there, or keep `ryph-workload` at 0 and give ryph's own
Deployments and StatefulSet a PriorityClass at least as high, accepting that runs may still evict
other tenants' pods. A PriorityClass's value cannot be changed in place: delete and re-create it,
and patch it in your overlay so the next deploy does not put 0 back.

Releases before the ladder shipped a single `ryph-reserved-capacity` class at -10. `kubectl apply`
does not prune cluster-scoped objects, so once every deployment on the cluster runs a release with
the ladder, and its placeholders have rolled onto the new classes, delete the old one by hand:
`kubectl delete priorityclass ryph-reserved-capacity`. Deleting it earlier leaves an old placeholder
unable to come back after an eviction.

Then set the following on the control plane:

```sh
RYPH_PROVISIONER=kubernetes
RYPH_K8S_NAMESPACE=ryph-runs
RYPH_AGENT_IMAGE=<registry>/ryph-agent:<tag>
RYPH_K8S_RUNTIME_CLASS=gvisor                        # GKE Sandbox; unset = the shared kernel
RYPH_K8S_SERVICE_ACCOUNT=ryph-run                    # see below
RYPH_K8S_RUN_USER=1994:1994                          # the harness layer's `runner`
RYPH_RUN_SIZES=standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;large:cpu=8,memory=16Gi,ephemeral-storage=10Gi,work-volume=50Gi
RYPH_K8S_WORK_VOLUME_CLASS=standard-rwo              # unset = the cluster's default class
RYPH_K8S_CHECK_COMPUTE_CLASS=ryph-checks             # check pods on fixed-CPU nodes; unset = any
RYPH_PUBLIC_URL=http://control-plane.ryph.svc.cluster.local:7411
```

The control plane reads the API server address, the token and the CA from its own pod. The token is
re-read on every request, because projected tokens rotate. Every `RYPH_K8S_*` variable is listed in
[development.md](development.md#️-env-knobs).

**The run's service account.** Its token is never mounted, but on a cluster that maps service
accounts to cloud identities (GKE Workload Identity), the metadata server hands out credentials
whether or not the token is mounted. Give runs a service account of their own that is bound to no
cloud identity. The namespace's `default` service account qualifies only until someone binds it.

**Resources.** The quantities become both the request and the limit. Put the ephemeral storage limit
at something generous: the clone, its dependencies and the harness's scratch files all land there,
and Autopilot defaults to 1 GiB. Its general-purpose compute class also caps a pod at 10 GiB and
refuses a larger request outright, so on Autopilot 10 GiB is the most a run can have without a
different compute class.

**Work volumes cost boot time.** A class's `work-volume` is mounted over `/ryph/work`, which hides
the checkout an environment image baked there. So before anything else starts, the pod's first init
container, `seed-work`, copies the baked checkout onto the volume. The copy grows with the checkout:
a 13 GB warm Rust `target/` took five minutes on GKE.

A class without a work volume works on the image's checkout in place and copies nothing at boot.
What the run writes lands in the container's writable layer. Under GKE Sandbox that layer is on
disk, not in memory: a pod with a 2Gi memory limit wrote 4 GiB to its root filesystem and kept
running (measured 2026-10-05). It counts against the run's ephemeral storage, which is 10Gi less 1Gi
per service sidecar. Overlay copy-up is whole-file, so a baked file the run modifies is copied in
full. That includes `target/` files cargo rewrites, and incremental caches it hard-links. A rebuild
after a large change can write more than its own output suggests.

That is why the Helm chart's default `runs.sizes` has `large-no-disk` beside `large`, with the same
cpu and memory and no volume. Pick `large` for a run whose writes outgrow that budget. The two
classes' reserved-capacity slots are the same size, so either serves a run of the other.

**Startup.** The first pod on a fresh node waits for the node and for the image pull before it sends
its first heartbeat. `RYPH_STARTUP_GRACE_MS` (default ten minutes) must cover that. On a fresh
Autopilot cluster, the first `gvisor` run waited about three and a half minutes for its GKE Sandbox
node, showing `FailedScheduling` beside a `TriggeredScaleUp` until the node joined.

## Reserved capacity

An admin can keep warm room for each size class on the Platform settings page: a number of **slots**
per class, up to 20 each. The control plane keeps one Deployment per class with slots,
`ryph-reserve-<class>` in the runs namespace, with that many replicas. Each pod asks for the largest
pod a run or check of its class can ask for, as request and limit: the class's cpu, memory and
ephemeral storage, plus room for `RYPH_SERVICE_MAX` service sidecars at `RYPH_SERVICE_CPU` and the
larger of `RYPH_SERVICE_MEMORY` and the catalogue's largest memory floor (none with
`RYPH_SERVICES=off`). A class whose disk cannot fit that many 1Gi sidecars holds room for as many as
a one-check suite of it can have, which leaves each check its 512Mi floor (a run keeps 1Gi, so it
may fit one fewer). The slot's disk is the class's ephemeral storage, as a run pod's is. Only a
class that sets cpu, memory and ephemeral storage can have slots: where a class leaves one unset,
Autopilot, or a LimitRange elsewhere, gives every container its default for it, once in the
one-container placeholder but once per container in a run or check pod, so the pod would outgrow its
slot. The API refuses slots for such a class. With the defaults a `standard` slot holds 7 cpu, 11Gi
of memory and 10Gi of disk. The scheduler only evicts a placeholder when that frees enough on its
node, so a slot smaller than the run that wants it holds nothing for that run. It runs under
`RYPH_K8S_RUNTIME_CLASS`, at one of the placeholder priorities above. A run or check pod, at
`ryph-workload`, evicts one when it needs the room; the evicted pod goes Pending, the autoscaler
adds a node for it, and the reservation refills itself. This is the "balloon pod" pattern GKE
documents for Autopilot. The lowest priority is `-10` because the cluster autoscaler ignores pods
below it, and would never scale up for an evicted placeholder.

Each class's placeholder sits on a rung by the cpu it holds, half an octave per rung: under 1.41
cores at `-10`, 1.41 to 2 at `-9`, 2 to 2.83 at `-8`, and so on up to 22.6 cores and more at `-1`.
The scheduler preempts on the node whose highest-priority victim is lowest, so a run that fits in
more than one kind of slot evicts the smallest, and a `standard` run leaves the `large` slot warm.
The scale is the same in every cell, because the classes are shared by the cluster and a run in one
cell may evict another cell's placeholder: the same size gets the same rung whatever else a cell
defines. Slots in the same band share a rung, and preemption does not tell those apart.

Rungs rank by cpu alone; memory and disk never move one. A class whose slot is larger by memory but
smaller by cpu, say `highmem:cpu=2,memory=48Gi` beside `standard:cpu=4,memory=8Gi`, sits on a lower
rung, so a `standard` run that fits in either slot evicts the `highmem` one and that class goes
cold. Give the classes you reserve the same order by cpu as by memory, or accept that the one with
less cpu is the one given up. A rung comes from the class alone, never from what is saved, so a save
never restarts a placeholder; a change to a class's cpu, or to `RYPH_SERVICE_MAX` or
`RYPH_SERVICE_CPU`, may move it, and restarts its placeholders.

The ladder works only because every placeholder holds a node of its own: they carry a required
anti-affinity against each other, in every namespace, so the autoscaler makes a node per slot. The
scheduler weighs a node by its highest victim, so two `standard` slots packed onto one node would
both go to a `large` run while the `large` slot on another node stayed idle.

On GKE's 8-vCPU sandbox nodes (7.91 cpu allocatable), a `large` slot (7 cpu) with the default room
asks for 10 cpu, which no such node can take: every `large` slot gets a 16-vCPU node of its own, or
stays Pending where the project cannot make one. Lower `RYPH_SERVICE_MAX` or `RYPH_SERVICE_CPU`, or
the class's cpu, to keep `large` slots on 8-vCPU nodes.

The container is `RYPH_AGENT_IMAGE` running `sleep infinity`, so a reserved node has also pulled the
layers every run starts from, from the registry it already pulls from. It holds nothing: no service
account token, no env, no volume, no port, non-root, every capability dropped, a read-only root
filesystem, `RuntimeDefault` seccomp and a zero grace period. No NetworkPolicy admits it anywhere.

A pass lists the placeholder Deployments, applies the whole desired Deployment of each class above
zero with server-side apply, then deletes every placeholder Deployment that is not wanted, so a pass
run twice ends in the same state. Only one replica passes: the holder of the Lease
`ryph-reserved-capacity` in the runs namespace
(`kubectl -n ryph-runs get lease ryph-reserved-capacity` shows which pod). During a rollout the old
and new control plane would otherwise take turns applying their own image, restarting every
placeholder each time. The Lease follows client-go's leader election, as the MCP gateway's hosting
lease does (both are `@ryph/service`'s): its duration is three reconcile intervals or three reaper
ticks, whichever is longer, at least 60 s. A replica takes it when it is absent or released, or once
it has seen it unchanged for that duration by its own clock; no replica ever compares its clock with
the holder's renew time, so clock skew cannot make two holders, and every interval is timed on a
monotonic clock, so an NTP step cannot either. The holder renews it on every pass, and stops writing
two thirds of the duration after its last renewal began, which is before anyone else may take over;
the last third is the margin for a request already sent. Every write to the Lease carries the
version it read, so a race for it is one 409 and one holder. A clean shutdown releases it, so the
next replica takes over at its next pass; a crashed holder is taken over within the duration plus an
interval or two. Each class stands alone: one the API server refuses does not stop the others, nor
the deletes. It rides the reaper's tick and runs at boot, every
`RYPH_CAPACITY_RECONCILE_INTERVAL_MS`, and on the holder's next tick after a save on any replica. A
pass with any failure (API server down, a missing grant, one class rejected) logs
`capacity.reconcile_failed`, or `capacity.lease_failed` when the Lease itself could not be read or
written, and is retried at the interval; runs never notice. The settings page shows how many slots
of each class are ready, or that the cluster could not be asked. A work volume is not reserved: the
slot holds the node, not the disk.

Placeholders are only ever removed by a pass. Anything that stops the passes leaves them holding
their nodes: rolling back to a release from before reserved capacity, switching `RYPH_PROVISIONER`
away from `kubernetes`, or moving `RYPH_K8S_NAMESPACE` (the new namespace gets its own, the old one
keeps its). Clean up by hand, in the runs namespace the placeholders are in:

```sh
kubectl -n ryph-runs delete deployment -l app.kubernetes.io/component=reserved-capacity
kubectl -n ryph-runs delete lease ryph-reserved-capacity
```

Setting every class to 0 before the change does the first half for you.

## Network boundaries

The compose file admits it cannot express one boundary (see
[deploy/compose-networked](../../../deploy/compose-networked/README.md#what-compose-cannot-express)).
A run reaches the model-proxy's data listener (`:7420`) but must not reach its control listener
(`:7421`), and likewise for the mcp-gateway's `:7430`/`:7431`. Here a NetworkPolicy expresses it.
Attach the policy to the service being protected, so it holds even if a runs-side policy is
misconfigured:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: model-proxy-listeners
  namespace: ryph
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: model-proxy }
  policyTypes: [Ingress]
  ingress:
    # The data plane: every run.
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: ryph-runs }
          podSelector:
            matchLabels: { app.kubernetes.io/component: agent-run }
      ports: [{ port: 7420 }]
    # The control plane: the control plane and the app's proxy, nothing else.
    - from:
        - podSelector:
            matchExpressions:
              - { key: app.kubernetes.io/name, operator: In, values: [control-plane, app] }
      ports: [{ port: 7421 }]
```

The mcp-gateway gets the same policy with `7430`/`7431`. On the runs side, a default-deny policy in
`ryph-runs` should allow egress to:

- DNS
- the control plane `:7411`, the forge `:7412` and the historian `:7413`
- the two data listeners
- the egress proxy `:7460` in `ryph-egress` — and **nothing else on the internet at all**

That last rule used to be `0.0.0.0/0` with the private ranges excepted, and replacing it is what the
egress proxy is for. The reason it could not simply be tightened: **a hostname allowlist cannot be
written as an `ipBlock`.** `registry.npmjs.org` is Cloudflare, so "the package managers" has no CIDR
— the old rule was really "everything that is not us", which is exactly the reach an exfiltrating
run wants. What a forward proxy sees instead is the name in the `CONNECT` line, before any TLS
exists, and it matches that against the signed allowlist the run presents.

It should allow no ingress at all — and with [service containers](service-containers.md) that
absence carries more weight than it used to. A run's databases are **sidecars inside the run's
pod**, on its loopback, so "nothing in the cluster can reach a run's database" is true exactly as
long as no ingress rule exists in `ryph-runs`. There is no way to admit something to a run pod and
not to its Postgres: a NetworkPolicy selects pods, and the sidecars are in the pod. The same
sentence read the other way is why a sidecar inherits the agent's full egress — credential-free,
since the run's Secret is `envFrom` on the runner container alone, but reachable outward all the
same.

The chart's [`networkpolicies.yaml`](../../../deploy/helm/ryph/templates/networkpolicies.yaml) is
that policy set, and `bun run k8s:smoke` probes it from a pod carrying a run's labels. Two things it
turned up:

- **Excepting "the private ranges" only works if the cluster lives in them.** Autopilot puts
  Services in `34.118.224.0/20` unless told otherwise, which is not a private range, so an internet
  rule that excepts 10/8, 172.16/12 and 192.168/16 would let runs through to every Service. Declare
  the cluster's pod and Service ranges inside 10/8 for this reason. Since the lockdown this applies
  to the **egress proxy's** rule rather than a run's — it is the one pod that still opens
  `0.0.0.0/0`, which is what it exists to do, and the except list is what keeps a hostname resolving
  to a cluster address from being followed there.
- **A policy holds from when the network plugin programs it, which can be after the pod starts.** On
  kube-router (k3s, OrbStack), a new pod's egress is unfiltered for its first few seconds. The smoke
  check measures that window at boot and reports it; the verdict is taken once it has closed. The
  runner's first act is fetching its spec, which is allowed anyway, but a cluster whose plugin opens
  such a window gives a run's first seconds a wider reach than the policy says. On GKE Autopilot
  (Dataplane V2, gVisor) the same probe found no window: the policy held from the pod's first
  connection.

## Service containers

A run's [service containers](service-containers.md) ride the same Job, as entries under
`initContainers` carrying `restartPolicy: Always` — native sidecars. That shape is not cosmetic: the
kubelet terminates restartable init containers once the regular ones exit, and it is the only
arrangement under `batch/v1` in which a Job with helper containers ever reaches `Complete`. Plain
extra entries under `containers:` would leave every run's pod running forever.

What it costs and what it buys, on a cluster:

- **Version floor 1.29**, where sidecars are beta and on by default (GA in 1.33). Below it the
  kubelet ignores `restartPolicy` on an init container, so the "sidecar" runs to completion and the
  runner never starts. The adapter asks the API server at launch and refuses by name rather than
  creating a Job that will hang.
- **No new RBAC and no new cleanup.** They are containers of a Job this process already creates, and
  deleting the Job cascades to all of them.
- **A shared storage budget.** A restartable init container counts into the pod's requests, and
  Autopilot's general-purpose class refuses a pod asking for more than 10 GiB of ephemeral storage
  in total. So with services, a size class's `ephemeral-storage` is what the whole pod gets: each
  service asks for 1 GiB explicitly (Autopilot would inject that anyway, where the adapter could not
  account for it), and the runner keeps the rest — 8 GiB beside two services out of 10. A run whose
  services would leave the runner under 1 GiB is refused at launch, naming the size class. CPU and
  memory are not shared: a service's are added on top of the runner's.
- **Pull time against the startup grace.** The kubelet serialises pulls, and a first gVisor run
  already waits minutes for its sandbox node. A cold node plus several database pulls can exceed
  `RYPH_STARTUP_GRACE_MS`, and the outcome is a run marked `lost`. Keep `RYPH_SERVICE_MAX` low, or
  raise the grace.

When a run is killed hard — the reaper giving up on one that never reported — the adapter reads the
pod's container statuses into the log **before** deleting it. Without that the grace-0 delete takes
the evidence with it, and "which service never became ready" is answerable only by someone who
happened to be watching `kubectl` live.

## Developing against a local cluster

From outside a pod, point the orchestrator at `kubectl proxy`, which authenticates with your own
kubeconfig:

```sh
kubectl proxy --port 8001 &
RYPH_PROVISIONER=kubernetes RYPH_K8S_API_URL=http://127.0.0.1:8001 \
  RYPH_K8S_NAMESPACE=ryph-runs RYPH_AGENT_IMAGE=ryph-agent:dev \
  bun run dev
```

With `RYPH_K8S_API_URL` set, no service account token is sent, even from inside a pod. A mounted
token is meant for the API server only, never for a URL taken from config. The run pods still have
to reach whatever `RYPH_PUBLIC_URL` names, and on a local cluster that is usually the host's address
as the cluster sees it.

Create the PriorityClasses first (the chart does, with `priorityClasses.create`; the template is
[`priorityclasses.yaml`](../../../deploy/helm/ryph/templates/priorityclasses.yaml)): every run,
check and build pod names `ryph-workload`, every hosted tool server `ryph-tool-host`, and a pod that
names a class the cluster does not have is refused admission. The Job is created but its pod never
is (only `FailedCreate` events on the Job say why), and the run sits until `RYPH_STARTUP_GRACE_MS`
and ends `lost`.
