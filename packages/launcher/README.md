# @ryph/launcher 🚀

The one process that runs the docker CLI. **It holds the docker socket, which is root on the
machine, and holds no platform secret**: no master key, no database, no provider key. Everything
else that runs containers on docker reaches it over HTTP: the control plane for runs, check suites,
environment builds and image prefetch, and the MCP gateway for hosted servers.

| Mode                | Launcher                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `ryph` binary       | embedded: `@ryph/host` calls `startLauncher` and dials it over loopback |
| compose deployments | its own service, `bun src/main.ts`, reached at `RYPH_LAUNCHER_URL`      |
| Kubernetes          | not used: the kube API plus RBAC already is this seam                   |

The binary goes through the same clients a compose deployment does, so every boot exercises the
seam.

## 🔌 What it serves

The docker adapters stay in `@ryph/orchestrator` and `@ryph/mcp-gateway`, with their tests. This
package builds them from its own configuration and puts one route in front of each port method. The
clients implement the same ports: `adapters/launcher/` in the orchestrator, and
`adapters/tool_host/launcher.ts` in the gateway.

| Route                           | Token | Port method                                                        |
| ------------------------------- | ----- | ------------------------------------------------------------------ |
| `GET /v1/info`                  | run   | the engine, the networks, the gate and routes                      |
| `POST /v1/runs/launch`          | run   | `Provisioner.launch` (long)                                        |
| `POST /v1/runs/kill`            | run   | `Provisioner.kill`, this deployment's runs only                    |
| `POST /v1/runs/inspect`         | run   | `Provisioner.inspect`                                              |
| `POST /v1/reconcile/list`       | run   | the reconcile, first half: a listing id                            |
| `POST /v1/reconcile/reclaim`    | run   | the reconcile, second half                                         |
| `POST /v1/checks/prepare`       | run   | `CheckLauncher.prepare`                                            |
| `POST /v1/checks/launch`        | run   | `CheckLauncher.launch` (long)                                      |
| `POST /v1/checks/poll`          | run   | `CheckLauncher.poll`                                               |
| `POST /v1/checks/logs`          | run   | `CheckLauncher.logs`                                               |
| `POST /v1/checks/discard`       | run   | `CheckLauncher.discard`                                            |
| `GET /v1/checks/list`           | run   | `CheckLauncher.list`                                               |
| `POST /v1/builds/build`         | run   | `EnvironmentBuilder.build` (long)                                  |
| `POST /v1/builds/adopt`         | run   | `EnvironmentBuilder.adopt` (long)                                  |
| `POST /v1/builds/discard`       | run   | `EnvironmentBuilder.discard`                                       |
| `POST /v1/builds/live-log`      | run   | `EnvironmentBuilder.liveLog`                                       |
| `POST /v1/builds/remove-images` | run   | `EnvironmentBuilder.removeImages`                                  |
| `GET /v1/prefetch/status`       | run   | `ImagePrefetch.status`                                             |
| `POST /v1/prefetch/start`       | run   | `ImagePrefetch.start`                                              |
| `GET /v1/tools/info`            | tools | `reachesGuard`, the guard's name and image, the network, the relay |
| `POST /v1/tools/network`        | tools | `ToolHost.ensureNetwork`: the tools network, edge, egress relay    |
| `POST /v1/tools/launch`         | tools | `ToolHost.launch`                                                  |
| `POST /v1/tools/stop`           | tools | `ToolHost.stop`                                                    |
| `GET /v1/tools/list`            | tools | `ToolHost.list`                                                    |
| `POST /v1/tools/inspect`        | tools | `ToolHost.inspect`                                                 |
| `POST /v1/tools/address`        | tools | `ToolHost.address`                                                 |
| `POST /v1/tools/logs`           | tools | `ToolHost.logs`                                                    |
| `GET /healthz`, `/readyz`       | none  | liveness and readiness                                             |

- **Two tokens, two scopes.** `RYPH_LAUNCHER_TOKEN` opens the run side and
  `RYPH_LAUNCHER_TOOLS_TOKEN` opens the tool host. Each is a 401 on the other's routes, the same 401
  as no token at all. Both are compared in constant time over their hashes.
- **Long calls** answer as NDJSON: a beat every 10 s while the work runs, then one result or one
  failure. A build has no deadline on the client. When the caller aborts, its closed connection
  aborts the request here, and the build stops.
- **Errors are typed.** `ImageGone` is answered as `{error: "image_gone", message}` and rethrown by
  the client as itself. Anything else an adapter throws is `{error: "failed", message}`, in docker's
  own words.
- **A launcher briefly away is waited for.** A request that never reached it (a refused connection,
  a name that does not resolve) is sent again for up to 90 s, so a launcher that compose recreates
  does not fail the runs launched meanwhile. A request that may have arrived is never sent twice.
  The run-side clients do this for every call, and the mcp-gateway's for its network, launch, stop
  and list (its probes answer "unknown" at once); both use `untilReached` from `@ryph/service`.
- **A launch that outlives its caller is bounded, not adopted.** When the control plane restarts in
  the middle of a launch (or compose restarts it with a recreated launcher), the launcher may still
  finish starting the container, and the run stays `starting` with no handle, since nobody is left
  to record one. If its runner comes up, it redeems its bootstrap bearer and heartbeats like any
  run, cancels reach it on its heartbeat, and its container is reclaimed once it ends. If it never
  comes up, the reaper marks the run `lost` once `RYPH_STARTUP_GRACE_MS` (10 minutes by default) has
  passed since it was created, and the next reconcile removes the container by its `ryph.run` label.
  A run that heartbeats while ignoring every cancel cannot be killed by handle in that window. The
  runner honours cancels, so that would take a runner bug.
- **The reconcile keeps its order.** The launcher lists the runtime first and keeps the listing
  under an id. The caller then reads its active runs, and the reclaim removes only what that listing
  holds. A reclaim never names an object. A listing gone (expired, or already reclaimed) is a 409
  `no_listing`, which listing again answers.

## 🔒 What a request cannot say

The boundary: a compromised caller cannot turn the launcher into root on the host. A run is code
already, so running code is not the line. So everything about a container that could reach past it
is the launcher's own configuration, and no request can set it: the networks, the run gate, the OCI
runtime, the BuildKit image and its directories, mounts, capabilities, `--privileged`, published
ports, the tools network, the tool guard's image, and where hosted servers' egress goes.

A request carries only the port's own spec. The server parses it with a zod `strictObject`, so an
unknown key is a 400. The schemas (`wire.ts` in the orchestrator) also hold every field that reaches
an argv, a path or git's environment to what the core would ever send:

- no image, ref or name starts with `-`
- a service container's capabilities come from the core's allowlist
- checkout paths and cache scopes are single path segments
- a build's clone credential is exactly the one `GIT_CONFIG_*` extraheader the core mints, over
  http(s)
- a hosted server's secret cannot take a name the docker CLI or the loader reads (`DOCKER_HOST`,
  `LD_PRELOAD`, and the like)

`kill` and `inspect` act on a container only when it carries this deployment's run labels: a stop
goes ahead on one of ours or on nothing there, is a 503 when docker cannot say whose it is, and a
403 otherwise. Every other by-name operation a route reaches holds to the same rule: a run's
teardown and a failed launch's cleanup find their objects by this deployment's labels, check logs
read only this deployment's suite containers, a build's network is labelled with the deployment and
found by its labels, and the tool routes act only on `ryph-tool-*` containers labelled with this
launcher's tools network and its deployment (`ryph.deployment`, as on runs). A hosted server
launched before the deployment label existed is no longer this launcher's, so a relaunch of its name
is refused; remove those once, on a tools network no other deployment shares:
`docker rm -f $(docker ps -aq --filter label=ryph.tool.network=<tools network>)`. Only the guard is
ever published, and a joined launcher publishes nothing. A launch under the guard's name runs this
launcher's `RYPH_TOOL_GUARD_IMAGE` or is a 400: the guard is the one hosted container that is also
on the deployment network. The egress relay is named outside the `ryph-tool-*` handles, so no tool
route reaches it. A request body over 16 MiB is a 413.

**Hosted servers are confined like runs.** `POST /v1/tools/network` (`src/tools.ts`) makes the tools
network `--internal` with gateway mode `isolated`, and refuses where the engine cannot (Podman, a
native engine before 28; a VM engine before 28 gets `--internal` alone). A tools network that exists
and does not confine is replaced when only this deployment's hosted servers, guard and relay are on
it, and refused, naming the rest, otherwise. The guard is created on the deployment network (or
`<tools network>-edge`, made here, where there is none), connected to the tools network, then
started, with the run gate's no-forwarding sysctl. The **egress relay**,
`ryph-egress-relay-<tools network>`, is the run gate's image and posture on both networks, relaying
`:7460` on the tools network to `RYPH_TOOL_EGRESS_TARGET`, the egress proxy's tool listener, which
opens any public host on any port to a hosted server's claim and nothing private. The gateway mints
the claims; this process holds no key.

**Builds under a sandboxed runtime.** With `RYPH_DOCKER_RUNTIME` set, branch builds are refused, and
which branch a build is of is the caller's word. So a standalone launcher refuses every build there
unless `RYPH_ENV_TRUST_DEFAULT_BRANCH=on` says to trust it. The binary's embedded launcher always
does: its caller is its own process. `/v1/info` says so (`buildsRefused`), and a caller with
`RYPH_ENVIRONMENTS=on` refuses to boot against it rather than fail every build.

**Builds need a run network.** An unconfined build tags the universal image's public names
(`quay.io/ryph/ryph-universal:1`, `:latest`) on the daemon, and every deployment on that daemon
builds on them. So a standalone launcher builds only where `RYPH_DOCKER_RUN_NETWORK` confines runs,
and confined builds tag nothing public. Without it, `/v1/info` says every build is refused, the same
way. The binary's embedded launcher still builds unconfined: its deployment is the daemon's one
tenant.

Specs carry secrets: the run's single-use bootstrap bearer, clone credentials, a hosted server's
`secretEnv`. The launcher never logs a spec, not even inside a 400's message, and keeps none past
its request.

## ⚙️ Configuration (standalone)

| Variable                                                                                                       | Default                            | What                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `RYPH_LAUNCHER_PORT`                                                                                           | `7470`                             | where it listens, every interface                                                                          |
| `RYPH_LAUNCHER_TOKEN`                                                                                          | required                           | the run-side credential                                                                                    |
| `RYPH_LAUNCHER_TOKEN_FILE`, `RYPH_LAUNCHER_TOOLS_TOKEN_FILE`                                                   | unset                              | read the tokens from files, minted if absent                                                               |
| `RYPH_LAUNCHER_TOOLS_TOKEN`                                                                                    | unset: no hosting                  | the tool-host credential, a different value                                                                |
| `RYPH_DOCKER_NETWORK`                                                                                          | required                           | the deployment network, and its identity on a shared daemon                                                |
| `RYPH_DOCKER_RUN_NETWORK`                                                                                      | unset                              | confine runs to this internal network                                                                      |
| `RYPH_DOCKER_GATE_IMAGE`, `_ROUTES`, `_OWNER`                                                                  |                                    | the run gate, with a run network; the image is the egress relay's too                                      |
| `RYPH_DOCKER_RUNTIME`                                                                                          | runc                               | the OCI runtime runs and hosted servers get                                                                |
| `RYPH_CHECKS`, `RYPH_ENVIRONMENTS`                                                                             | `off`                              | serve check suites, environment builds                                                                     |
| `RYPH_ENV_BUILDKIT_IMAGE`, `RYPH_ENV_CACHE_DIR`, `RYPH_ENV_TEMP_DIR`, `RYPH_ENV_BUILD_PLATFORM`                |                                    | the docker builder's own                                                                                   |
| `RYPH_ENV_IMAGE_REMOVAL`                                                                                       | `on`                               | `off`: retention untags nothing here; a caller's removal is answered as not done, so its rows wait         |
| `RYPH_ENV_TRUST_DEFAULT_BRANCH`                                                                                | `off`                              | under a sandboxed runtime, build the default branch on the caller's word                                   |
| `RYPH_IMAGE_PREFETCH`                                                                                          | `on`                               | fetch the images below ahead of first use                                                                  |
| `RYPH_AGENT_IMAGE`, `RYPH_BROWSER_IMAGE`, `RYPH_TOOL_GUARD_IMAGE`, `RYPH_HARNESS_IMAGE`, `RYPH_ENV_BASE_IMAGE` |                                    | what is fetched; the last two are required with `RYPH_ENVIRONMENTS=on`, since every build starts from them |
| `RYPH_TOOL_NETWORK`                                                                                            | `ryph-tools-<RYPH_DOCKER_NETWORK>` | hosted servers' network, made internal here                                                                |
| `RYPH_TOOL_GUARD_IMAGE`                                                                                        | required with a tools token        | the one image the tool guard runs                                                                          |
| `RYPH_TOOL_EGRESS_TARGET`                                                                                      | required with a tools token        | `<host>:<port>` of the egress proxy's tool listener on `RYPH_DOCKER_NETWORK`, or `off` for no way out      |
| `RYPH_DRAIN_DEADLINE_MS`                                                                                       | `40000`                            | how long a stop waits on calls in flight; past a run's 30 s docker stop                                    |

A standalone launcher always hosts as `joined`: the gateway is on the deployment network, where the
guard's ordinary side is, and dials it by name; it never joins the tools network. A port published
on this machine's loopback means nothing to a gateway in another container.

At boot it refuses a run network that cannot confine runs. It also makes the run gate in the
background and logs how that went, and starts fetching its images ahead: the prefetch's state is its
own, and a caller's start is only a retry. Callers run no docker for any of it. `/readyz` answers
only while docker does (a cached `docker version`). Callers wait only for the launcher to have
started, so one can boot against a launcher whose docker does not answer; it then logs a DOCKER IS
NOT REACHABLE warning at boot. On the launcher's side, a socket it may not open is logged at boot as
an error naming the socket's group and `DOCKER_GID`, apart from a daemon that is merely not up yet.
`GET /v1/info` waits at most 3 s on docker for the engine and answers `engine: null` past that.

The gate's owner label (which deployment instance made it) is minted into `$HOME/gate-owner` on the
first confined boot and kept, unless `RYPH_DOCKER_GATE_OWNER` names one.

`RYPH_DOCKER_GATE_ROUTES` lists the gate's routes, comma-separated, each `<listen>=<host>:<port>`: a
port a run dials on the gate and the service behind it. Spelled out, not derived: the addresses runs
are handed are the callers' configuration. The control plane and the binary read the routes back
from `GET /v1/info` at boot and warn of an address they hand runs that misses them. Nothing checks
the model proxy's and the gateway's run-facing addresses.

**Token files.** Where no one hands out secrets (deploy/compose), `<name>_FILE` names a file in a
volume the caller mounts read-only. The launcher mints it on first boot (32 random bytes as hex,
mode 0644, written to a fresh file and linked into place, so it is never seen half-written; an empty
file counts as absent) and reads it after. The caller reads the same file (`launcherTokenFromEnv`).
The volume is the boundary.

The image is [images/launcher](../../images/launcher/Dockerfile): Bun, the docker CLI and buildx,
git, bash and tar, uid 1996, the socket's group added by compose.

## 🧪 Tests

`bun run ci`. `tests/wire_test.ts` and `tests/tools_test.ts` drive the real clients against a real
launcher over loopback HTTP, with the real docker adapters behind it and only the docker CLI faked:
launches, `ImageGone` from runs and checks, token scopes, the strict schemas, the reconcile's order,
a build cancelled from the client, prefetch, and the tool host.
