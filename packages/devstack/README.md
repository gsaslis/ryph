# `./dev` — the dev-stack controller

Runs the local dev stack. Three units — `host`, `forge`, `app` — each in its own tmux pane. Agent
runs happen in `ryph-run-<runId>` docker containers, or in a runner you launch by hand.

The CLI converges or reports when you ask it to. It never watches, supervises, or restarts anything
on its own. A unit that dies stays dead until you say `up`.

## Before you start

Three tools must already be on your `PATH`, and two are optional.

| Tool                 | Why                                                 | Install                                         |
| -------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `tmux`               | every stack verb runs through it, `doctor` included | `brew install tmux`                             |
| `bun`                | the shim runs `bun`, and every pane a `bun run`     | `mise install`, or any other way                |
| `docker`             | agent runs, `logs run`, `reset runs`                | Docker Desktop, or `brew install colima docker` |
| `mise` — optional    | pins the toolchain the panes launch with            | `brew install mise`                             |
| `kubectl` — optional | `remote` alone: the forwards into a deployment      | `gcloud components install kubectl`             |

`mise` is the odd one out. When it is there, panes launch as `mise x -- bun run <task>` and get the
version `mise.toml` pins; when it is not, they get the ambient `bun`, which is usually the same
thing. `doctor` reports which you are getting. It is deliberately not required — refusing to start
over a version pin, on a stack that would run fine, is not a trade worth making.

A missing tool surfaces as a spawn error, not a friendly message. If a command dies with something
like `Failed to spawn 'tmux'`, that is what happened.

## Running it

Nothing to install beyond the workspace's own `bun install` at the root. `./dev` is a shim at the
repo root:

```
./dev --help
./dev doctor
```

`doctor` reports tools, env files, ports, and init state. It changes nothing, so it is always safe
to run first.

**It is never put on `PATH`, and that is the point.** The shipping product is also a CLI called
`ryph` ([`packages/ryph`](../ryph/README.md)); a dev tool installed under a similar name would sit
one typo away from it, and an earlier version of this tool was literally called `ryph`. Running it
as `./dev` from the checkout it belongs to removes the question.

## First run

```
./dev init   # scaffolds missing .env files, wires host↔forge and host↔app, pushes the schema
./dev up     # starts what is missing, waits until each unit is ready
```

`up` is idempotent — running it again starts only what is down.

## Everyday commands

| Command                    | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `./dev up [units...]`      | Starts what is missing and waits for readiness                       |
| `./dev down [units...]`    | Stops units; a stopped unit stays down until `up`                    |
| `./dev restart [units...]` | Relaunches in place — pane position and scrollback survive           |
| `./dev status [--json]`    | Unit and recent-run state; observes only                             |
| `./dev logs [targets...]`  | Unit logs, run logs, or everything merged                            |
| `./dev attach [unit]`      | Opens the tmux view. Detach with `C-b d`                             |
| `./dev config [--env]`     | Effective configuration, or the declared vars. Secrets stay redacted |
| `./dev doctor`             | Health check across tools, ports, and cross-package wiring           |
| `./dev remote`             | The app alone, in front of a deployment's services (below)           |
| `./dev reset [scopes...]`  | Wipes data by scope: `db`, `forge`, `runs`. Confirms first           |
| `./dev completions`        | Shell completions                                                    |

Every verb takes `--help`.

Some shapes worth knowing:

```
./dev logs host -f           # one unit, live
./dev logs -f                # all units merged, runs interleaved
./dev logs run -f            # every run as it appears
./dev logs run r-baad976418  # one specific run
./dev config --env forge     # the vars forge declares
./dev reset db               # databases only
```

`up` refuses to launch on a `.env` the host or the forge would refuse to boot on — a missing
`RYPH_AGENT_IMAGE` under a provisioner that launches, say — and names the knob, rather than
reporting "not answering after 10s" and leaving the reason in a log. Everything else `doctor` finds
is a warning there, not a stop here.

## Against a deployment

A frontend change wants agents, runs and history to look at, and a laptop has none. The app is a BFF
— the browser never reaches a service, the app server does — so its dev server can be put in front
of a deployment's services instead of the local stack:

```
./dev remote --context <kube context>                   # a Helm release in `ryph`
./dev remote --context <kube context> --namespace acme  # one installed with namespaces.prefix=acme
./dev remote --context <kube context> --no-app          # forwards only, env printed
```

It reads the release's `app` Deployment for the URLs it talks to its services on, port-forwards each
to loopback (`7411` → `17411`, and so on, so a local stack on the real ports is never in the way),
and starts Vite with those URLs in its environment — nothing is written to `packages/app/.env`, and
a variable the deployment does not set falls through to that file, which it says so when it happens.
`--port` picks Vite's port; without it, a local `app` unit on `:5173` makes Vite step to the next
free one, and the command says so.

This is the one verb that does not go through the tmux board. The forwards need a supervisor for as
long as the session lasts, and that is the command itself: it runs in the foreground, restarts a
forward that `kubectl` drops, and Ctrl-C takes the forwards and the dev server down together.
`status` and `logs` know nothing about it.

**It is the real deployment.** Nothing is deployed or exposed to make this work — a port-forward is
a tunnel through the API server to the pod's own loopback, gated by the RBAC on your credentials —
but the data is live and so are the side effects: a task created in that tab launches a pod in the
cluster, and an agent edited there is edited for everyone. Passkeys and OAuth round trips stay bound
to the deployment's hostname; see [the app's README](../app/README.md#against-a-deployment).

## Logs

One plain-text file per unit, under `packages/devstack/state/logs/<unit>.log`. Each file is
truncated when its unit launches, so it always covers exactly the current launch. `state/` is
gitignored — it is runtime data.

Read those files directly whenever you want. Reading disturbs nothing.

## Three rules that look wrong but are not

**Never `tmux pipe-pane` the stack's panes.** The CLI owns each pane's pipe to capture the logs
above. Re-piping replaces it and silently breaks `./dev logs`. Read the log files instead.

**Panes launch units through `mise x -- bun run <task>` when mise is installed. Keep the
`mise x --`.** The tmux server snapshots `PATH` when it starts, so a bare `bun` inside a pane runs
whatever version the server was born with — the global mise pin, not this repo's `mise.toml`. This
has already broken vite once. Without mise the ambient `bun` is used instead, which is a deliberate
fallback rather than an oversight; see `src/toolchain.ts`.

It is a workspace member (`@ryph/devstack`): cliffy comes from JSR's npm registry and is pinned in
the root `bun.lock`, and `bun run check` here type-checks it. Root `bun run fmt` and `bun run lint`
cover it too.
