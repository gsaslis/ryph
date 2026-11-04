# `ryph`

The single-process deployment, as one shipped binary. No runtime to install, no `node_modules`,
no database server.

```sh
curl -fsSL https://ryph.ai/install.sh | sh   # install (install.sh)
ryph up              # control plane, model proxy, MCP gateway, and the web UI
```

On a NAS or a home server, [`deploy/compose`](../../deploy/compose/README.md) runs this binary in a
container beside a real Postgres, with only docker on the host.

Everything the local loop needs is inside it: real PostgreSQL 17 (PGlite, embedded), the schema
migrations, and the built UI. The two things it cannot absorb are **`git`** and **`docker`** — the
forge shells out to one and the provisioner to the other — so those stay dependencies of the
machine.

## Commands

| | |
| --- | --- |
| `ryph up` | Start everything. Applies any pending migrations first. |
| `ryph setup` | Ask the three questions a fresh install cannot answer for you. |
| `ryph config` | Show what a launch resolves to, and which layer decided each value. |
| `ryph migrate` | Apply the schema and exit, for provisioning ahead of time. |
| `ryph auth grant-owner <email>` | Make an existing user an owner, straight in the database: lockout recovery. |
| `ryph backup <file>` | Write a compressed snapshot of the database. |
| `ryph restore <file>` | **Replace** the database from a snapshot. Needs `--force` if one exists. |
| `ryph checks run` | Run a repo's checks on your commit, on a ryph deployment, before a PR. See [Checks from your machine](#checks-from-your-machine). |
| `ryph mcp` | Serve a ryph deployment to an agent on your machine as MCP tools, over stdio. See [A deployment as MCP tools](#a-deployment-as-mcp-tools). |
| `ryph version` | Print the version. |

Backup and restore are **offline** commands: stop the server first. PGlite is single-connection,
so a dump serialises behind every other query — including heartbeats, and heartbeats delayed past
their timeout get runs marked lost and their containers killed.

## Opening an agent's dev server

On the localhost binary, ask the agent to start its dev server with `ryph__background_run`
(`service: true`) and call `ryph__expose_port` with its port and a label, for example
`{ "port": 5173, "label": "Web app" }`. The tool returns a URL and the run page shows an
**Open preview** button. Open it on the machine running `ryph up`.

The server can listen on **`127.0.0.1` or `::1` inside the run**. The runner opens one socket
out to the binary per preview and carries every browser connection over it; there is no Docker
port publishing, container ingress, or browser sidecar requirement. HTTP, streaming responses
and WebSockets (including dev-server HMR) travel through that tunnel.
Each preview has its own random `http://<id>.localhost:<port>` origin, backed by an IPv4
loopback-only listener (or by one shared port, `RYPH_LOCAL_PREVIEWS_PORT`, where ryph runs in a
container and publishes it). Browsers resolve `.localhost` locally; no DNS setup is needed.

- Only explicitly registered ports are exposed: ports 1024–65535, at most four previews per run.
  Registering the same port again through the tool reuses its live preview.
- If the dev server enforces an allowed-host list, add the returned `.localhost` hostname.
  Apps that hardcode `localhost:<dev-port>` URLs, OAuth callbacks or HMR addresses need their
  public URL configured to match the preview. The tunnel does not rewrite application code.
  Cross-origin browser requests into a preview are refused; for a separate API, use the dev
  server's same-origin proxy rather than fetching another preview directly.
- The preview URL is a local capability, not a public share link or a second login. Anyone on
  this machine who has it can use the application. Treat other local users/processes as trusted;
  do not expose internal control services or servers containing secrets.
- Trust runs the other way too. Opening a preview runs the agent's code in your own browser, with
  your machine's network: it can send requests to other services on this machine or your LAN,
  and reach the internet even from a confined run. Open previews of runs you trust. ryph's own
  services inside the run (its control API, tool server and browser) cannot be exposed.
- Stopping the run, disconnecting the runner or stopping the binary closes its previews. There
  is no persistent hosting or automatic reconnection after a binary restart. A stopped dev
  server answers as unavailable; the agent can restart it on the same port.
- This is enabled only by the binary with a loopback app URL. Hosted deployments do not offer
  the tool or preview endpoints. An old runner image must be updated to gain the tool.

## Stopping

Ctrl-C stops everything this process started. Hosted tool servers go down with it, every time, and
come back at the next `ryph up`. When runs are still going, they are listed and you can choose:

- **Cancel shutdown and keep ryph running** (the default): nothing stops; Ctrl-C can ask again later.
- **Cancel them, then exit**: wait for the runs to wrap up before stopping ryph.
- **Exit without cancelling them**: leave the runs behind for a quick restart.

Everything a run needs (the model proxy, the MCP gateway, the transcript) lives in this process,
so a run left behind survives only if ryph is back within the heartbeat timeout (60 s). Cancelling works like Cancel in the UI, and the wait for
each run to wrap up can be cut short with a second Ctrl-C; a third skips the rest of the shutdown,
database close included, so it is best avoided. Nothing is asked without a terminal, on a
SIGTERM, or when the terminal itself is closed — that stops it the same clean way, and the runs
are then left, as a quick restart wants.

## First launch

A first `ryph up` at a terminal asks four groups of questions, then starts. `ryph setup` asks
them again whenever you want; `ryph setup --yes` answers them with flags instead, for a script or
a coding agent ([setup with an agent](../../docs/guides/setup-with-an-agent.md) is the briefing to
hand one). The whole first hour, by hand, is [the quickstart](../../docs/guides/quickstart.md).

| | |
| --- | --- |
| **Master key** | Mint one, paste your own, or skip. Seals every provider key and MCP server credential this deployment stores. |
| **Agent runner** | `docker` wherever it answers. Then the agent image (only when the binary has no pinned one), the browser image, and how much of the internet a run gets: confined, allowlisted or direct. |
| **Repositories** | A directory on this machine, a GitHub login or token, a GitLab login or token, a Radicle identity, or none of them. |
| **Mail** | Only with `RYPH_MULTIUSER=on`: how invitations go out. |

Each one is something the machine genuinely cannot decide. Without an agent runner nothing you
create would do anything, so `ryph up` refuses to start without one (below); the others are
warnings in the status block otherwise.

It asks **only when there is a terminal to answer it.** A container, a systemd unit and a CI job
never get asked, and must set `RYPH_PROVISIONER` themselves; `--no-setup` skips it by hand, and a launch whose environment already sets `RYPH_PROVISIONER` is treated as configured
and never asked.

Either way, **`ryph up` refuses to start without a provisioner.** With `RYPH_PROVISIONER` unset
every run would sit until it is marked lost, so the boot stops and names `ryph setup` instead.
`manual`, which launches nothing and prints the environment a hand-started runner needs, is for
developing ryph: it starts only beside `RYPH_ALLOW_MANUAL_PROVISIONER=1`, which the playground
sets.

Answers it will not give you:

- **No runner at all is never written.** Agents run in docker, so without a docker that answers
  setup stops before its first question, says what is wrong and how to fix it, and writes
  nothing. There is no "none" to pick.
- **`docker` with no image is never written.** An empty answer stops setup at that step, with
  nothing written, and says how to get an image.
- **An existing master key is kept by default,** and replacing it warns before it asks — every
  provider key sealed with the old one becomes unreadable, and stays working right up until a run
  needs it.

### First sign-in

The terminal's questions are the machine's. The browser's are yours: a first `ryph up` opens it
signed in, on a **welcome** flow of five steps — a **model** (paste a provider key, or connect a
ChatGPT plan), your first **agent**, the **background model** memory uses, a **repository**, and
**ready**. Provider keys are entered there, or on the Model keys page, and nowhere else: no
setting, flag or API token carries one, so a script or an agent setting this up hands that step to
a person. The flow shows once, on a fresh instance; every step has its own page afterwards.

### Docker

Agents run in docker, because on your own machine what you want first is a
run that works, browser included. The browser sidecar joins the agent container's network
namespace, so a dev server the agent starts is the page it opens. No run is handed this machine's
credentials.

**The images are published.** A binary knows the version it was built as (`ryph --version`: a
release's `0.1.0`, or an edge build's `sha-<commit>`), and its defaults are the images published
under that same tag (`images/publish.ts`):

| Setting                  | Default in the binary                        |
| ------------------------ | -------------------------------------------- |
| `RYPH_AGENT_IMAGE`       | `quay.io/ryph/ryph-agent:<version>`      |
| `RYPH_BROWSER_IMAGE`     | `quay.io/ryph/ryph-browser:<version>`    |
| `RYPH_TOOL_GUARD_IMAGE`  | `quay.io/ryph/ryph-tool-guard:<version>` |
| `RYPH_DOCKER_GATE_IMAGE` | `quay.io/ryph/ryph-run-gate:<version>`   |
| `RYPH_ENV_BASE_IMAGE`    | `quay.io/ryph/ryph-universal:<version>`  |
| `RYPH_HARNESS_IMAGE`     | `quay.io/ryph/ryph-harness:<version>`    |

`ryph up` downloads the missing ones in the background, one at a time and the agent image first,
and the first-run screen in the web UI shows how far it got. The agent image is several GB, so a
run started before it lands waits for it. `RYPH_IMAGE_PREFETCH=off` leaves each image to the first
time it is launched. A binary built from uncommitted changes,
or without git to ask, has no images of its own and follows the moving `edge` tag instead, which
its status block says. `ryph setup` offers the same published images, and prefers a local
`ryph-agent:dev`, `ryph-browser:dev` or `ryph-run-gate:dev` when `bun run agent-image` has built
one, saying which it picked. Run from source (`bun run up`), the defaults are those `:dev` builds,
with no browser unless one is named.

**Artifact thumbnails work automatically under Docker too.** A cache miss starts a disposable
container from the published browser image, feeds it the prepared HTML through stdin and reads a
PNG from stdout. This works across Docker Desktop's VM boundary without sharing Unix sockets or
publishing ports. It is separate from the interactive browser a run gets: disabling that browser
does not disable artifact thumbnails. The renderer has no network, credentials, host mounts or
capabilities; its root filesystem is read-only and its CPU, memory, PIDs and temporary storage are
bounded. Jobs are removed on completion, cancellation and normal shutdown.

`RYPH_ARTIFACT_THUMBNAIL_IMAGE` selects another image, or `off` disables generation. A source
checkout without a published browser default needs an image explicitly configured. Set
`RYPH_ARTIFACT_THUMBNAIL_URL` or `RYPH_ARTIFACT_THUMBNAIL_SOCKET` instead to use a separately managed
isolated renderer; these take precedence over Docker. Existing cached previews remain available
when generation is disabled. Image preparation runs independently of the short render deadline;
missing images or unavailable Docker leave placeholders, not a failed `ryph up` or artifact publish.

Chromium's sandbox stays required. Ryph supplies a pinned Playwright-derived Docker seccomp profile
that permits Chromium's private user namespaces while retaining syscall filtering; it does not use
`--privileged`, `SYS_ADMIN`, unconfined seccomp or a `--no-sandbox` fallback. A host kernel or AppArmor
policy that forbids unprivileged user namespaces can still refuse rendering; fix that policy or use
an isolated external renderer rather than disable the sandbox. Container rendering must be smoke-tested
on the target Docker runtime.

It can also **confine** a run. Answer "confined" to the internet question — the default wherever
there is a run gate image, published or built — and the wizard creates an internal
`ryph-runs` docker network (`ryph-runs-<network>` when `RYPH_DOCKER_NETWORK` is set) and puts runs on
it alone: no internet, no DNS for outside names, and no route to this machine. That last part needs
the network's gateway mode set to `isolated` (docker 28 or later), because a plain internal network
keeps an address on the docker host; the wizard creates it that way (and remakes an older
`ryph-runs` that lacks it, when nothing but the run gate is attached), and on a native engine older
than 28 — or under Podman — it does not offer confinement. Their one way back is the **run gate**, a small container on both that
network and an ordinary one, which relays only ryph's own ports — the control plane, model proxy,
MCP gateway and egress proxy — to the host. So the wizard writes every runner address as
`http://ryph-gate-default:<port>`, and the egress proxy behind the gate is a run's only way to the
internet. It refuses to dial this machine's own names and addresses, so it is no way around the
gate. The listeners stay on loopback, since Docker Desktop delivers the gate's connections there
(so do OrbStack, Colima, Rancher Desktop and rootless docker, whose bridge is not on this machine);
on a native Linux engine, where the bridge's address is one of this machine's, they bind that
address instead, which is where they arrive there. That address exists only while dockerd is up,
so on Linux start ryph after docker — a listener whose address is missing stops the boot, naming
the setting.
The browser shares the agent's network namespace, so it is confined with it. Confined runs share
one network, so a run can reach a sibling run's open ports (the runner's own listener needs a
token).

Answer "allowlisted" instead, or run without the gate image, and the internet allowlist only shapes
what setup steps install: a run's own code can go around it, so it is not a hard boundary.

**Environment builds are on.** Under docker each repo gets an image with its checkout and setup
(`.ryph/setup.yml`, and a `.ryph/Dockerfile` if it has one) already done, so its runs start ready,
and checks (`.ryph/checks.yml`) run on the same images. The last two rows above are what a build
starts from: the universal image and the harness layer. When `RYPH_AGENT_IMAGE` is a `ryph-agent`
image they follow it, so `ryph-agent:dev` builds on `ryph-universal:dev` and `ryph-harness:dev`.
Each repo's image is a few GB on top of the universal image's several, and its layer cache lives
in `~/.ryph/env-cache`. Older images are removed once a newer build replaces them.
`RYPH_ENVIRONMENTS=off` and `RYPH_CHECKS=off` turn them off.

A confined run's builds are confined too, in a BuildKit container of their own on an internal
network with the run gate. That container is privileged: a repo's `.ryph/Dockerfile` and setup
steps run there as root, and an escape from it is root in docker's VM (on Linux, on this machine).
It is the most power repo content gets here.

## Settings

Answers land in **`~/.ryph/config.env`** — the same `RYPH_*` variables as everywhere else, one
per line, and yours to edit:

```
RYPH_PROVISIONER=docker
RYPH_AGENT_IMAGE=quay.io/ryph/ryph-agent:sha-0123456789ab
RYPH_BROWSER_IMAGE=quay.io/ryph/ryph-browser:sha-0123456789ab
RYPH_LOCAL_REPO_ROOT=/Users/you/code
```

Three layers decide any value, in this order: **the environment, then that file, then the
built-in default.** So a scripted launch is never surprised by what is in somebody's home
directory, and `RYPH_DB=… ryph up` still means what it says. `ryph config` prints the
resolved value *and* the layer that decided it — the question a `cat` of the file cannot answer,
because a variable exported in a shell profile two years ago outranks everything in it and leaves
no trace there.

Hand edits survive `ryph setup`: a re-run replaces the lines it owns where they stand and leaves
the rest of the file alone. Only `RYPH_*` keys are applied — the file lives in a home directory
and has no business setting `PATH`. The master key is the one answer that does **not** go in it;
it goes where master keys go, below.

`RYPH_HOME` moves the database, the master key and this file together, which is what makes a
second instance one variable rather than three that have to agree. It is read from the environment
only: it says where the settings file is, so it cannot come from inside it.

## Environment

**The database lives in your home directory, not in the working one.** `ryph up` is a server
with one identity per machine — your account, your agents, your run history — so it opens
`~/.ryph/data` wherever you launch it from. It used to open `./data/ryph`, which meant
starting it from a different directory silently opened a different, empty database; the banner
printed the relative path, so it read the same both times and the only symptom was "my data is
gone". Every path this binary prints is absolute now, for the same reason.

Set `RYPH_DB=pglite:./data/ryph` to get a database per directory back.

**The master key is minted for you, and lives beside the database — never inside it.**

```
~/.ryph/data            the database
~/.ryph/secrets.key     the key that opens the provider secrets in it (owner-only)
~/.ryph/files           the images runs were handed, and environment build logs
```

`~/.ryph/files` is not in a `ryph backup` snapshot either: those are files, not rows. Copy the
folder alongside the snapshot to keep a restored deployment's run images; without it they are
simply gone, and nothing else is.

Keeping it out of the data directory is what lets `ryph backup` stay safe to copy: the snapshot
holds sealed provider keys and nothing that opens them. The cost is that restoring on another
machine needs the key carried across too, so `backup` says so when the snapshot contains any, and
`restore` refuses to pretend — it tells you the keys it cannot open rather than letting you find
out at the first run that needs one.

A `postgres://` database gets no generated key. There is no local directory to pair one with, and
a per-machine key is the wrong shape for a database several machines share, so `RYPH_SECRETS_KEY`
stays required there — unless `RYPH_SECRETS_KEY_FILE` names a file to keep one in, which is how
[`deploy/compose`](../../deploy/compose/README.md), one machine on one Postgres, gets its key minted
like a laptop's.

| Variable | Default | |
| --- | --- | --- |
| `RYPH_SECRETS_KEY` | minted into `~/.ryph/secrets.key` | Seals every stored provider key and MCP server credential (`RYPH_MCP_KEY` defaults to it). Generated on first launch; set it to supply your own, or for `postgres://`, which gets none |
| `RYPH_SECRETS_KEY_FILE` | — | An absolute path the master key is read from, or minted into on first launch, whatever the database: how a one-machine `postgres://` deployment (deploy/compose) keeps its key in a volume |
| `RYPH_LOCAL_PREVIEWS` | `on` | `off` stops agents exposing dev servers as previews |
| `RYPH_LOCAL_PREVIEWS_PORT` | — | One port every preview shares, told apart by host name, instead of a free loopback port each: for a ryph in a container, which publishes it (deploy/compose). `RYPH_LOCAL_PREVIEWS_BIND` (default `127.0.0.1`) is where it listens, and `RYPH_LOCAL_PREVIEWS_PUBLIC_PORT` the port a browser reaches it at when that differs |
| `RYPH_HOME` | `~/.ryph` | The database, run images, the master key and the settings file, together. Environment only |
| `RYPH_ATTACHMENT_DIR` / `RYPH_ENV_LOG_DIR` | `~/.ryph/files` | Where run images and environment build logs go with the local store |
| `RYPH_ENVIRONMENTS` / `RYPH_CHECKS` | `on` under docker, else `off` | Environment builds, and the checks that run on them ([above](#docker)) |
| `RYPH_CHECKS_REMOTE_URL` / `RYPH_CHECKS_REMOTE_TOKEN` | — | Send checks to a deployment instead of running them here ([below](#running-your-instances-checks-on-a-deployment)) |
| `RYPH_ENV_CACHE_DIR` / `RYPH_ENV_TEMP_DIR` | `~/.ryph/env-cache`, `~/.ryph/tmp` | Environment builds' layer cache, and where a build's clone and image exports (GBs) go while it runs |
| `RYPH_DB` | `pglite:~/.ryph/data` | Database URL. Also `pglite:./data/ryph` (beside you, not in `~`), `pglite:memory://` (throwaway) or `postgres://…` |
| `RYPH_APP_PORT` | `3000` | The web UI |
| `RYPH_PORT` | `7411` | The control plane |
| `RYPH_MEMORY_EMBEDDINGS` | `local` | Memory search by meaning, from the model the binary carries, loaded on first use; `off` is full-text only |

### Getting a repository to an agent

Two ways, in order of least setup. Either way runs clone through the forge's git gateway, and no
run is ever handed a credential for a git host:

| | |
| --- | --- |
| A repository on this machine | Repos → Connect repository → On this machine in the web UI, from under `RYPH_LOCAL_REPO_ROOT` (default: your home directory; `off` turns this way in off). Runs clone it through the forge, and an approved patch lands as a branch in that repository. **No git host, no credential** — the answer for the single-machine case. |
| A forge provider | Connected repositories and pull requests. GitHub needs your GitHub CLI login (`gh auth login`) or a token — `ryph setup` asks — and acts as you; a Radicle node works too. |

The forge runs in this process unless `RYPH_FORGE_URL` points at one elsewhere, and only that
forge can read this machine's disk: a forge reached over the network reads its own
`RYPH_LOCAL_REPO_ROOT`. The root is the line around what may be added, and paths are resolved
through symlinks before the containment check, so a link inside it pointing elsewhere does not
escape it. Nothing under it is reachable until someone adds it. Set `RYPH_LOCAL_REPO_ROOT=off` to
allow no local repositories at all; `up` falls back to your home directory only when it is unset.

A run sees **commits**, not your working tree: uncommitted edits are not part of its base. Git
refuses a push to the checked-out branch, and ryph never rewrites a branch it did not create,
so the working copy you have open is not disturbed.

`up` accepts every other `RYPH_*` knob the host does — see
[@ryph/host](../host/README.md), which is the root this binary hands off to. It reads no
configuration of its own: the binary only supplies the two things a shipped artifact can do that a
source checkout cannot (apply its embedded migrations, serve its embedded UI), so there is exactly
one boot sequence and it is not in this package.

## Checks from your machine

`ryph checks` is a client of a ryph deployment somewhere else; it starts nothing and reads no
database. It asks that deployment to run a repository's `.ryph/checks.yml` on a commit of yours,
before you open a pull request, on the same machines a PR's checks run on. The suite is the very
one a push of that commit on the same base gets, so when you then open the PR on that commit, the
forge is told the result at once and nothing runs twice.

```sh
export RYPH_URL=https://ryph.example.com     # the ryph web app
export RYPH_TOKEN=ryph_pat_…                 # an API token holding checks:request and repos:read

ryph checks run                              # HEAD of the current branch, and wait
ryph checks run --check test --base develop  # one check, judged by develop's checks file
ryph checks wait cs-…                        # follow a suite (or an ask, cq-…)
ryph checks status cs-…                      # read it once
```

| Variable | |
| --- | --- |
| `RYPH_URL` | The ryph web app's address. Everything goes through its `/api`, the one door a deployment makes public. |
| `RYPH_TOKEN` | An API token (`ryph_pat_…`) holding `checks:request` and `repos:read`, minted on your account page. Members and up may grant it. You also need write access to the repository on its forge, through your linked account. |

Both may live in `~/.ryph/config.env` instead; the environment wins.

**What gets checked is HEAD, never the working tree.** Uncommitted changes earn a warning and are
left out. The repo comes from the `origin` remote (`owner/name` on GitHub, `rad:z…` on Radicle),
or `--repo`. When the remote's branch already is HEAD, ryph fetches the commit from the forge.
Otherwise the branch's own commits (everything since the merge-base with the base) are uploaded
as a git bundle. A bundle is also used on Radicle, where `ls-remote` asks your own node and not
the forge's, and for a `--repo` other than the one `origin` names. If the forge's branch has moved
by the time ryph looks, the ask goes again as a bundle and says so. `--push` and `--bundle` pick
one outright. `--base` takes a branch name: `refs/heads/main` means `main`, and so does
`origin/main` when that is a remote-tracking branch here.

**An upload may have only five minutes to arrive** through a deployment's app container: Node's server
gives a whole request that long (`requestTimeout`), and adapter-node, which serves the app, has
no setting for it. For a 100 MiB bundle that is about 2.8 Mbit/s. A bundle carries only the
branch's own commits, so most are far smaller; on a slow link, push the branch and let ryph fetch
it instead. `ryph up` gives an upload half an hour.

**A rebase or an amend makes a new commit, and a new commit runs again.** A suite belongs to one
commit judged by one base's checks file. Asking again on the same branch replaces your earlier
ask there, and an ask nobody follows up on lapses after a day.

`run` waits by default, printing each check as it changes, and exits 0 when the suite passed, 1
when it failed, 2 when it was cancelled or never got a suite, and 3 for a usage or configuration
mistake. `--no-wait` prints the suite's page and exits; `--json` prints one JSON object at the end
instead of progress.

### For a local agent

`ryph mcp` serves the same as two tools, `checks_run` and `checks_status`, beside the rest of a
deployment (below). `checks_run` takes a `path`, the directory the agent is working in, and checks
the repository that directory is in. Claude Code starts the server once, in the directory the
session began in, so an agent that has moved to another worktree since needs to pass it; without
`path` the server uses its own directory. It waits for the verdict and returns the end of each
failed check's log (its last 150 lines), so the agent can fix what broke, commit, and ask again.

### Running your instance's checks on a deployment

`ryph checks` above is you asking a deployment. To have `ryph up` itself send every suite its runs
and patches ask for to a deployment, which then runs them on its machines and reports them to the
forge, add to `~/.ryph/config.env` and restart:

```sh
RYPH_CHECKS=on
RYPH_CHECKS_REMOTE_URL=https://ryph.example.com
RYPH_CHECKS_REMOTE_TOKEN=ryph_pat_…   # minted on that deployment's account page: checks:request + repos:read
```

The deployment needs the same repositories connected, matched by forge address, and checks on.
No check containers run here; results and logs show up on your runs as usual, read from the
deployment. If it is unreachable, checks retry and then report an error: they never fall back
to running here. Let any local checks finish before switching. The whole contract is in
[the checks docs](../orchestrator/docs/checks.md#instance-wide-remote-backend).

## A deployment as MCP tools

`ryph mcp` is a stdio MCP server that drives a ryph deployment, wherever it runs, with your API
token: start, steer and watch tasks, read a run's transcript, subagents, background commands,
previews and activity, review patches, run checks, and configure agents, repos, workspaces,
memory, chat, MCP servers and automations. Like `ryph checks`, it is a client of the deployment's
public app (`<RYPH_URL>/api`), and reads no database. In Claude Code:

```sh
claude mcp add ryph -e RYPH_URL=https://ryph.example.com -e RYPH_TOKEN=ryph_pat_… -- ryph mcp
```

or, with the two in your environment or `~/.ryph/config.env`:

```sh
claude mcp add ryph -- ryph mcp
```

For an agent that should look but not touch, `ryph mcp --read-only` serves only the tools that
read: nothing it calls starts, steers, approves or configures anything, whatever the token holds.
They send only GETs, but for `memory`'s `brief_preview`, a POST that renders a brief and stores
nothing. Opening a preview (`run_preview_open`) mints a way in, so it is left out.

The configuration is read on the first tool call, so a missing or refused token is a tool error
the agent relays, not a server that fails to start. Ask the agent to call `whoami` first: it names
the deployment, who the token speaks for, and which tools the token's capabilities reach.

**The token decides what works.** Mint it on your account page with the capabilities you mean to
hand the agent; every route checks the token's own list, never your role's. People, invites,
instance settings, tokens and model keys are not reachable with a token at all, and no tool
touches them. A token you hand an agent should not hold `patches:review` (approving a patch
publishes it to the forge) or `agents:policy` (an agent's model, tools, network and limits)
unless the agent is meant to do exactly that.

| Tools | Capabilities |
| --- | --- |
| `whoami` | any |
| `tasks_list`, `task_get`, `run_transcript`, `run_subagents`, `run_background`, `run_previews`, `run_preview_open`, `run_activity`, `run_wait`, `responses` | `tasks:read` (`tasks:read-all` for everyone's) |
| `task_start` | `tasks:create`, and write access to the repos on their forge |
| `task_cancel`, `task_finish`, `run_message`, `response_close` | `tasks:steer` |
| `patches`; `patch_review` | `patches:read`; `patches:review`, and write access to the repo |
| `checks_run`; `checks_status`, `checks`; `checks_manage` | `checks:request` and `repos:read`; `repos:read`; `patches:review` |
| `agents`; `agents_manage` | `agents:read`; `agents:write`, and `agents:policy` for model, tool, forge, network and limit policies, a browser or artifacts |
| `repos`; `repos_manage` | `repos:read` (`repos:connect` for installations); `repos:connect`, `repos:manage`, `resources:manage` for size classes and rebuilds, `tasks:create` for an environment setup task |
| `workspaces`; `workspaces_manage` | `workspaces:read`; `workspaces:manage`, `resources:manage` for size classes and rebuilds |
| `environments`, `deployment` | `repos:read`, `agents:read` |
| `skills`; `skills_manage` | `skills:read`; `skills:manage` |
| `memory`; `memory_manage` | `memory:read`; `memory:manage` (proposing needs only `memory:read`; a proposal made with a token waits for a person to accept it, and at most 50 of yours wait at once) |
| `chat`; `chat_manage` | `chat:read`, `chat:write`; `chat:write`, `chat:manage` for command rooms and Zulip, and `tasks:create` to set a command room |
| `mcp_servers`; `mcp_servers_manage` | `tools:read`; `tools:manage` |
| `artifacts`; `artifacts_manage` | `artifacts:read`; `artifacts:manage`, or `artifacts:read` and `tasks:create` for one made for you |
| `automations`, `automations_manage` | `automations:manage` (`automations:manage-all` for everyone's), and `tasks:create` to create, edit, enable or rotate one |

The configuration tools take an `action`, and their `describe` action returns a body's JSON
Schema, generated from the service's own validation. A deployment older than this CLI forwards an
API token on the checks routes only; every other tool then answers that the app did not pass the
token on.

## Building

```sh
bun run compile      # -> dist/ryph          (from this package)
bun run build        # the same thing        (from the repo root)
```

`compile` builds the UI first, because `bun build --compile` does not. That step (`build:app`) can
be run on its own while iterating on the UI, but it is not a separate thing to remember before a
build. Node and Bun are needed to PRODUCE the build, never to run the result. Another platform's
binary: `bun scripts/compile.ts --target=bun-linux-x64` (or `bun-linux-arm64`, `bun-darwin-arm64`,
`bun-darwin-x64`), into `dist/ryph-<target>`.

The binary embeds the same migration sets the networked deployment applies, one per schema owner
(`bun run db:generate` at the repo root regenerates them all), and applies them into its one
database, each tracked in its own table. It does so with drizzle-orm's **runtime** migrator, never
drizzle-kit — drizzle-kit is a CLI that carries esbuild and cannot ride inside a binary. That is what lets a downloaded `ryph`
provision its own database on first launch with no toolchain present.

### Releasing

`bun run release` publishes this commit's four binaries to files.ryph.ai, where
[`install.sh`](install.sh) fetches them: a clean checkout only, once `bun run images:publish` has
pushed the commit's images for both platforms, because a binary pulls the images of its own
version. At a commit tagged `vX.Y.Z` the release is `X.Y.Z` and moves `latest`, which `install.sh`
installs by default; any other commit is an edge release, `sha-<commit>`, which moves only `edge`
(`RYPH_VERSION=edge`). How versions work and how to cut one:
[Releases & versioning](../../CONTRIBUTING.md#releases--versioning).
It signs `SHA256SUMS` with the release key (`~/.ryph-release-key`, whose public half `install.sh`
carries) and uploads with wrangler. `--dry-run` stops before the upload. The script says the rest
([scripts/release.ts](scripts/release.ts)).

### Two things that will bite you

**The compile options are load-bearing.** A compiled Bun binary by default reads a `bunfig.toml`
and a `.env` from the directory it is started in, and runs the bunfig's `preload` scripts: for a
tool started inside arbitrary repositories, code execution from any checkout. `scripts/compile.ts`
turns both off, and every build of this machine's binary is run once in a directory holding both
and fails if it read either. The files the binary reads as files (the UI, the migrations, the
catalogues and skills, PGlite's WASM, the two workers) travel as one archive inside it, unpacked
on first launch into `~/.ryph/runtime/<id>`: in a compiled binary every module's
`import.meta.url` is the binary's own, so the build rewrites each to where that module sits in
the unpacked tree (`src/resources.ts`). `tests/binary_test.ts` builds a probe the same way and
checks all of it from inside.

**A newer data directory is refused, not upgraded.** Migrations only roll forward, so an older
binary pointed at a directory a newer one has migrated would find nothing to do and start happily
against tables it does not agree with, quietly dropping columns it never learned about. The guard
counts applied migrations against embedded ones and refuses. Upgrade, or point `RYPH_DB`
somewhere else.

## What it costs

~115 MB on disk (darwin-arm64; ~123 MB darwin-x64, ~132 MB for linux): the Bun runtime, the
bundled code, and a 48 MB archive of PGlite's WASM and data image, the built UI, the migrations
and memory's embeddings (the ONNX runtime for this platform and bge-small-en-v1.5's weights,
33 MB of it), which unpack to ~118 MB under `~/.ryph/runtime` on first launch.

Memory search ranks by meaning as well as by words (`RYPH_MEMORY_EMBEDDINGS`, default `local`;
`off` is full-text only). The model loads on the first memory write or search, not at boot, and
then holds ~150–180 MB more resident; a query costs a few milliseconds. If it cannot load, `up`
says so once and memory search stays on full-text.

Under docker the images take the most disk: the agent image is several GB, and with environment
builds on, each repo's image adds a few GB more, plus its layer cache in `~/.ryph/env-cache`.

At runtime the real cost is **PGlite's resident memory** — a few hundred megabytes, committed when
Postgres first starts inside the WASM sandbox and never returned. It is a fixed startup cost, not
a data cost, which is why every module here shares **one** instance.
