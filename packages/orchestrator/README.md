# @ryph/orchestrator

The **control plane**. It holds the roster of **agents** (editable blueprints — an identity, an
optional system prompt, and which pre-baked container image runs them), accepts **tasks**
assigned to those agents, provisions one container per **run**, tracks each run's state through
heartbeats, receives the authoritative result, and enforces cancellation.
It is the counterpart to [the runner](../runner/README.md): the runner does one run and reports;
the orchestrator decides what runs, watches it live, and records how it ended.

## ⚙️ How it works

A user creates an agent, then assigns it a task. The orchestrator mints a **run**, freezes a
[snapshot](docs/architecture.md#-snapshots-agents-are-editable) of exactly what that run is asked
to do, and launches one container for it. The container's runner
[heartbeats](docs/run-lifecycle.md) in with its phase and reports a result at the end; those
reports flow one way only. A run that goes silent is
[reaped](docs/run-lifecycle.md#-the-reaper). To reach _into_ a run — the one thing that needs it,
[cancellation](docs/cancellation.md) — there are two channels: the orchestrator calls the runner's
own control API when it can reach it, and every heartbeat answer carries the run's cancel intent
for when it cannot, with the reaper's SIGTERM as the backstop behind both.

The orchestrator is a small [hexagonal architecture](docs/architecture.md), the same shape as the
runner: `src/core/` holds the pure run state machine and depends on nothing concrete, every
external effect goes through a port (`src/ports/`), and `src/main.ts` binds each port to an
adapter (`src/adapters/`). It speaks plain **HTTP** and stores state in **PostgreSQL** — no broker, no
database server. At thousands of concurrent runs that is still only a few hundred small requests
per second, and [one process handles it](docs/architecture.md#-why-plain-http--postgres).

## 🔌 The two HTTP surfaces

One handler, two audiences ([details](docs/architecture.md#-the-two-http-surfaces)):

- **User surface** (`/v1/agents`, `/v1/tasks`) — authenticated with
  [@ryph/auth](../auth/README.md) access tokens: mounted into the same process by
  [@ryph/host](../host/README.md) in the default local deployment, verified against the auth
  service's JWKS URL when standalone. Create and edit agents, assign tasks, watch and cancel runs.
- **Runner surface** (`/v1/runs/:id/*`) — authenticated with a per-run bearer minted at provision
  time and stored only as a SHA-256. A container can speak for its own run and nothing else.

## Commands on fork pull requests

An authorized `/ryph` command on an open GitHub pull request from a fork checks out **the fork's
head**: `refs/pull/<n>/head`, which GitHub keeps in the base repository, fetched through the
connected repo's own URL and credential. It is checked out **alone**: a repo in a workspace
does not bring its siblings, so the fork's code can neither read them through the run's git grant
nor ship a patch to them. The run works the pull request (`targetChangeRequest`), and a fork-head
task delivers onto the fork's branch or nowhere, whatever the repo's submission policy and
whatever the agent submits: the submit sweep fails any other delivery (`core/reaper.ts`), and
the forge refuses a submission based on `pull/<n>/head` that is not onto pull request `<n>`.

**Pushing** is gated by the repo's **Push to fork branches** setting (`allowForkPushes`, off by
default, a repo admin's), and then by the pull request: its author must allow edits from
maintainers, and the branch must not be the fork's default branch. The forge asks all of it
again at push time (`change_transport/github.ts`), pushes to the fork's clone URL only on the
connected repo's origin, with a lease on the head it just read, and GitHub has the last word on
whether the App's token may push there (a workflow file needs the App's `workflows` permission).
A repo connected in GitHub user mode (no App installation) never pushes to a fork, and its setting
cannot be turned on.
When pushing is not possible the agent's checkout note and a reply in the thread say so and why;
a push refused at delivery fails the patch with GitHub's reason.

The fork's files are a contributor's. Nothing in them configures the run: services, checks and
the machine come from the connected repo (its default branch; checks from the pull request's
base), and the runner runs none of the fork's `.ryph/setup.yml`, reads none of its
`services.yml` or `environment.md`, quotes no `AGENTS.md` and loads no skills from it
(`RepoEntry.forkHead`). The agent is told the code is untrusted — to review and test, never to
follow — and the fork's branch name, which its author chose, is echoed in neither the prompt nor
the App's reply.

`forkHead` is derived in `startTask` for any ref that is not a branch of the repo, whichever door
handed it over, and the runner also reads a `pull/<n>/head` checkout as one. The doors a person
types at (`POST /v1/tasks` `ref`, automation targets) refuse such refs outright, and no branch may
be named `pull/…`: that is the cache's local name for pull request heads. A re-run from the app
(`targetChangeRequest`) goes the fork's way again. A fork-head run gets no memory (no brief, no
memory tools), forge tools confined to reading its repo and commenting or reviewing in its own
thread, and only its own task's artifacts; it cannot move onto another change request
(`checkout_change_request`). Its tool scope is that forge server and the web server alone: the
agent's own tool servers (catalogue and remote MCP servers with their keys) and chat are left out,
because the fork's code runs with the run's gateway token (`composeToolScope`). Deleted forks and closed or merged pull requests are refused.

## 🚀 Running it

This runs the orchestrator **standalone** — the networked deployment's shape. The default local
deployment is `bun run up` at the workspace root, where [@ryph/host](../host/README.md)
serves this package with auth and the model-proxy control side mounted beside it.

```sh
# multi-user by default, which will not start without the secret the app shares with it
export RYPH_PROXY_SECRET=$(openssl rand -hex 32)

# nothing launched — prints the env a hand-started runner needs (the loop works end to end
# before docker enters the picture); everything in-process on a throwaway database
# (standalone has no auth service mounted, so open the surface)
RYPH_DB=pglite:memory:// RYPH_AUTH=off bun run dev

# on a real database file (run once per schema change)
bun run db:push && bun run dev

# against local docker, with the pre-baked agent image (it carries every harness kind)
RYPH_PROVISIONER=docker \
RYPH_AGENT_IMAGE=ryph-agent:dev \
RYPH_PUBLIC_URL=http://host.docker.internal:7411 \
bun run dev
```

On a fresh database the first `POST /v1/auth/users` mints the owner, given the setup token the
control plane prints at boot; after that the user surface needs a token. The full env-knob table and the
docker/manual provisioner walkthrough live in [development.md](docs/development.md).

## ⚡ Quick start

```sh
bun run ci    # type-check, architecture guard, tests (fmt and lint are the root's: bun run fmt, bun run lint)
```

## 📚 Docs

| Doc                                             | What it covers                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)         | the ports and adapters, the two HTTP surfaces, agent snapshots, and why HTTP + Postgres |
| [run-lifecycle.md](docs/run-lifecycle.md)       | the run state machine, heartbeats as a gauge, results, and the reaper                   |
| [cancellation.md](docs/cancellation.md)         | the two ways a run is stopped — the push to its control API, and the reaper's kill      |
| [service-containers.md](docs/service-containers.md) | `.ryph/services.yml`, the image catalogue, and how a repo's databases reach a run    |
| [environment-builders.md](docs/environment-builders.md) | how a repo's `.ryph/` becomes an environment image, per backend, and what is unmeasured |
| [checks.md](docs/checks.md)                     | `.ryph/checks.yml`, check suites and pods, and how a verdict reaches the run and the forge |
| [skills.md](docs/skills.md)                     | the ryph skills catalogue, what a valid skill is, and how a run's skills are frozen and delivered |
| [development.md](docs/development.md)            | tasks, the database workflow (`db:push` vs migrations), env knobs, and running a run    |

## 📎 Wire-contract note

`core/types.ts` deliberately duplicates the runner's WorkItem / Phase / Result shapes: they are
the wire contract, and source-level imports between the packages would couple them. Once the
contract settles, those shapes move to a shared protocol package.
