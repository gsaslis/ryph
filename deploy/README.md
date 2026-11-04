# Deploying ryph

ryph runs in four ways. They share one codebase and one env contract; they differ in how far apart
they keep agent runs from everything else.

| Mode                                              | What runs                                                                  | For                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| [Single binary](../packages/ryph/README.md)       | one process, embedded Postgres; runs as containers on the machine's docker | one person on a laptop                                  |
| [Compose, single binary](compose/README.md)       | the same binary in a container, beside a real Postgres                     | a NAS or home server: the simplest way to self-host     |
| [Compose, networked](compose-networked/README.md) | every service in its own container, one database per owner                 | trying the networked shape on one machine; the e2e test |
| [Kubernetes, Helm chart](helm/ryph/README.md)     | the networked services, every run a Job in a namespace of its own          | teams, and anyone who needs runs kept apart             |

```
deploy/
├── compose/            the binary with Docker Compose
├── compose-networked/  the services with Docker Compose, plus their smoke and e2e checks
└── helm/
    ├── ryph/           the Helm chart
    ├── chart_test.ts   the chart's invariants, on what `helm template` renders
    └── smoke.ts        bun run k8s:smoke: checks an install from a run's position
```

## Which one

Start with the **binary** (`curl -fsSL https://ryph.ai/install.sh | sh`, then `ryph up`); first
time, [the quickstart](../docs/guides/quickstart.md) walks it, or hand
[setup with an agent](../docs/guides/setup-with-an-agent.md) to your coding agent. Move it to
**Compose** when it should keep running on a machine of its own. Both run agents as containers on
the host's docker, confined by the run gate: a run reaches the services it needs and the internet
through the egress proxy, and nothing else. The services themselves share one process, or one
network, so the boundary between services is a token, not a network rule. Under docker a run's
browser runs without Chromium's own sandbox, so the container that holds the agent holds the
browser's pages too.

Use **Kubernetes** when that last part matters: when people other than you write the prompts, or the
repositories hold anything worth stealing. The chart draws every boundary with NetworkPolicy,
including the ones between services that Compose cannot express
([what compose cannot express](compose-networked/README.md#what-compose-cannot-express)).

The **networked Compose** stack is an example, not a production mode. It is the closest thing to the
Kubernetes deployment on one machine, and where every link between services is checked end to end
(`bun run compose:e2e`).

## How the Kubernetes deployment isolates runs

The [chart's README](helm/ryph/README.md) has the namespace table, the network rules and the Secret
contract. This is why they look the way they do.

**A run is untrusted code.** It executes commands a model wrote, in repositories you did not write.
So a run gets nothing it does not need:

- **Its own namespace.** The control plane creates one Job, one pod and one Secret per run in the
  runs namespace, under a Role that allows exactly that and cannot read a Secret back. Runs share
  nothing with the services' namespace.
- **No credentials of its own.** A run's pod mounts no service account token and has no cloud
  identity. The tokens it does hold are minted for that run and die with it.
- **Five doors.** A run reaches DNS, the control plane, the historian, the forge, the model proxy's
  run port and the MCP gateway's run port (and the previews tunnel, when previews are on). It
  reaches the internet only through the egress proxy, which checks every hostname against the
  allowlist the run was signed for. The database, the nodes, the metadata server, the Kubernetes API
  and every other Service are out of reach.
- **Its own kernel, if you give it one.** With a sandboxing RuntimeClass (gVisor, Kata) each run,
  check and build runs on a kernel of its own. Without one, a kernel exploit in a run is a node
  compromise. Set `runs.runtimeClassName`.

**Services that fetch what others chose are held on the way out too.** memory fetches a URL a person
gave it, chat long-polls a bot API, the web service fetches pages an agent asked for, and the model
proxy dials whatever an admin registered as a custom endpoint. Each may reach DNS, its peers, its
database, and the public internet with every private and link-local range excepted. A pasted URL can
only leave; it cannot name another service, the database or the API server.

**Two services hold Kubernetes credentials, each for one namespace.** The control plane may create
Jobs and Secrets in the runs namespace. The MCP gateway may launch hosted MCP servers in the tools
namespace. Neither Role reaches anywhere else. On Secrets the gateway's Role is create and delete,
never read, but that is not a boundary by itself: a principal that can write a pod spec can mount
any Secret in its namespace. What makes it hold is that **no Secret the gateway did not write exists
in the tools namespace.** Keep it that way: operator credentials, pull secrets and certificates
belong in the services namespace.

**Pod security.** The services, tools and egress namespaces enforce the `restricted` Pod Security
Standard: non-root with a fixed uid, no privilege escalation, no capabilities, `RuntimeDefault`
seccomp. A run's own container meets `restricted` too. The runs namespace enforces only `baseline`
(and warns on `restricted`), because a task's service containers are vendor images that start as
root to drop to their own user. The builds namespace is `privileged`: rootless BuildKit needs
unconfined seccomp and AppArmor, which is why builds want a sandboxing RuntimeClass most of all.

**The network boundary needs a plugin that enforces it.** A cluster whose network plugin ignores
NetworkPolicy leaves every run able to reach everything, silently. The chart's README lists which
plugins enforce. `bun run k8s:smoke --kube-context <ctx>` checks it from a pod carrying a run's
labels. A `kubectl port-forward` is not affected by any of this: it arrives on the pod's own
loopback, which no NetworkPolicy sees.

## Upgrades and rollouts

Each service applies its own migrations before it starts
([Migrations](helm/ryph/README.md#migrations)). While new pods migrate and start, the old ones keep
serving — except automations, previews and Radicle, which are replaced rather than rolled and are
down until the new pod starts. Automations and Radicle are also down while their migrations run (or
until a failed one is fixed); previews has no migration.

Two builds of the app serve at once for the length of a rollout. Vite names every file under
`/_app/immutable/` after its content, and a pod has only its own build's, so a page from the new
build asking an old pod for a chunk gets a 404 (`Failed to fetch dynamically imported module`).
**Every build's chunks in a bucket** answer it: publish each build's `_app/immutable` to a bucket
and set `RYPH_ASSET_FALLBACK_URL` on the app (`app.assetFallback` in the chart's values). A chunk
the pod does not have is fetched from there instead of 404ing, in both directions, and a tab opened
before the rollout is served too. The bucket is a cache, never the source of truth: a lifecycle rule
may empty it.

Do not add session affinity at the load balancer instead. A cookie pinning a viewer to one pod hides
the 404 in one tab, and turns every rollout into `no healthy upstream` for the viewers whose pod is
draining.
