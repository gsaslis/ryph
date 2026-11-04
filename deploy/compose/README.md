# ryph with Docker Compose

ryph on one machine you keep running: a NAS, a home server, a box under a desk. It is the
[`ryph` binary](../../packages/ryph/README.md), the same single process a laptop runs, in a
container beside a real Postgres. Agents run as containers on the same machine's docker.

You need only docker. Nothing here asks for Bun, Node or a toolchain on the host.

This is the simplest way to self-host. The other is the networked deployment: the services as
separate containers with a database each, closest to how ryph runs on Kubernetes.
[`deploy/compose-networked`](../compose-networked/README.md) is that deployment as a Docker Compose
example. For people and teams that need runs kept apart from the machine ryph lives on, the
networked deployment on Kubernetes is the answer ([the Helm chart](../helm/ryph/README.md)).

## What you need

- Docker Engine 28.0 or later, which confining runs needs (Security, below), with a recent Compose
  v2 (2.20 or later) and buildx. Docker Desktop has all three.
- 10 to 15 GB of disk for the images. The agent image is most of it: one machine with every
  mainstream toolchain, so a repo that pins a version gets it without setup. Environment builds need
  several GB more per repo (Environments, below).
- An x86_64 or arm64 machine. The images are published for both.
- This directory's `compose.yaml` (and `.env.example`, if you like). Nothing else from the
  repository is needed: every image is pulled from `quay.io/ryph`.

## Start it

```sh
git clone https://github.com/ryph-hq/ryph.git
cd ryph/deploy/compose
cp .env.example .env                       # optional; every setting has a default

docker compose pull                        # ryph, the launcher, Postgres, and the images runs launch
docker compose up -d --wait                # ryph, the launcher and Postgres, healthy
```

`docker compose pull` fetches the images ryph launches for runs too (the agent, the browser, the
tool guard and the run gate) and the two environment builds start from (the universal image and the
harness), so the first run does not wait on a several-GB download. They are listed in `compose.yaml`
but never started by compose; the launcher fetches any that are missing at boot anyway.

**Which version.** `RYPH_VERSION` in `.env` picks it, for every image at once: a release like
`0.1.0`, `edge` (the default) for the newest build of the main branch, or `sha-<commit>` for one
commit's images. Releases are what is supported; `edge` and `sha-…` builds are not
([Releases & versioning](../../CONTRIBUTING.md#releases--versioning)).

On a Linux engine, set `DOCKER_GID` in `.env` to the docker socket's group first
(`stat -c %g /var/run/docker.sock`). The launcher starts runs through that socket, and the group is
what lets it. Docker Desktop is fine with the default, `0`. With the wrong group ryph still comes up
and prints its setup token: it waits for the launcher to have started, not to be healthy. But
`--wait` reports the launcher unhealthy, ryph's log opens with `DOCKER IS NOT REACHABLE`, and no run
starts until `DOCKER_GID` is fixed and `docker compose up -d` run again.

Then claim the instance. The first account needs the setup token ryph prints at boot:

```sh
docker compose logs ryph | grep "Setup token"
```

The line has the whole link, `http://localhost:3000/register?setup=…`. Open it, register, and you
are the owner. The token stops working once an owner exists. Everyone after you registers or is
invited from the UI.

Next, in the UI: add a model provider key under Model keys, connect a repository (below), and create
an agent. The first run takes a little longer while docker starts the image.

### One person instead of several

`RYPH_MULTIUSER=off` in `.env` before the first start makes ryph single-user, as the binary is by
default: no registration, one owner, and a sign-in link instead of a password.

```sh
docker compose exec ryph ryph login --no-open
```

prints a fresh link whenever you need one. Switching to multi-user later works once the owner has
set an email address and password on the account page.

## What is running

| Service    | What it is                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ryph`     | The binary: control plane, sign-in, model proxy, MCP gateway, run history, memory, chat, automations, the forge and the web UI, in one process |
| `launcher` | The only container with the docker socket. It starts every container below when ryph asks, and holds no secret of ryph's                       |
| `postgres` | PostgreSQL 17. It listens on no network at all: ryph reaches it through a unix socket in a shared volume                                       |

And the containers the launcher starts, on the same docker:

- **one per run**, on `ryph-compose-runs`, an internal network with no route anywhere, which the
  launcher makes on first use;
- **the run gate**, `ryph-gate-ryph-compose`, on that network and on `ryph-compose` beside ryph: a
  run's one way out, relaying ryph's run-facing ports and nothing else (Security, below). The
  launcher starts it at boot;
- **a browser** beside a run whose agent has one, sharing the run's network namespace
  (`RYPH_BROWSER_IMAGE=off` in `.env` turns browsers off for every run);
- **hosted MCP servers**, on `ryph-compose-tools`, an internal network the launcher makes like the
  run network; **the tool guard** in front of them, on that network and on `ryph-compose`, where
  ryph dials it; and **the egress relay**, `ryph-egress-relay-ryph-compose-tools`, on both too:
  their one way out, to ryph's egress proxy (Security, below);
- **a BuildKit container per environment build**, on an internal network of the build's own with the
  run gate attached, both removed when the build ends (Environments, below).

Compose knows none of these, so they outlive `docker compose down`, which then says the
`ryph-compose` network is still in use. To remove everything, take them away by the labels the
launcher puts on them, then the volumes and networks they held, then compose's own once more:

```sh
d=ryph-compose
docker compose down
docker ps -aq --filter label=ryph.deployment=$d | xargs -r docker rm -f
# What a launcher stopped mid-build leaves: a BuildKit container and its state volume, named for
# this deployment's digest.
b=buildx_buildkit_ryph-build-$(printf %s $d | sha256sum | cut -c1-12)-
docker ps -aq --filter name=$b | xargs -r docker rm -f
docker volume ls -q --filter name=$b | xargs -r docker volume rm
docker volume ls -q --filter label=ryph.check --filter label=ryph.deployment=$d | xargs -r docker volume rm
# Per-run and per-build networks, then the deployment's own, each that is still there (the first
# `down` may already have removed the ones compose declares).
# The tools network carries the label too, and the launcher made it, not compose.
docker network ls -q --filter label=ryph.deployment=$d | xargs -r docker network rm
for n in $d-runs $d-tools $d; do docker network inspect $n >/dev/null 2>&1 && docker network rm $n; done
docker compose down
```

With `RYPH_NETWORK` set, use its value for `d`. On macOS, where there is no `sha256sum`, use
`shasum -a 256` in its place.

State lives in named volumes: `ryph-home` (the master key, the forge's cache), `postgres-data`,
`repos` (repositories on this machine, below), and the launcher's: `launcher-home`, `launcher-cache`
and `launcher-temp` (environment builds' cache and working files) and `launcher-tokens` (below).
There are no bind mounts but the launcher's docker socket, so nothing depends on the host's file
permissions.

## Artifact thumbnails

The separate `artifact-thumbnails` container reuses the browser image, with its thumbnail
entrypoint. It has **no network** (`network_mode: none`), credentials, or Docker socket. Ryph
reaches it through `/run/ryph-thumbnails/render.sock`, on a named volume mounted read-only by ryph.
The browser image seeds that directory as uid/gid 1994, mode 0750; the renderer creates a mode-0660
socket. The backend adds group 1994 and uses `RYPH_ARTIFACT_THUMBNAIL_SOCKET`; its mount disables
volume copy-up so it cannot seed the directory with the wrong ownership. No TCP port is published or
used.

The renderer is nonroot, read-only, drops all capabilities, disallows privilege escalation, and has
CPU, memory and PID limits with bounded `/tmp` and shared memory. It receives no application
secrets. Both published-image and source-build deployments reuse the browser image, named by
`RYPH_ARTIFACT_THUMBNAIL_IMAGE` rather than `RYPH_BROWSER_IMAGE`, so turning agents' browsers off
leaves thumbnails on. Pointing `RYPH_BROWSER_IMAGE` at an image of your own leaves thumbnails on the
published one: set `RYPH_ARTIFACT_THUMBNAIL_IMAGE` to the same image to move both, and build or pull
it yourself, since compose builds and pulls only the thumbnail renderer's.

**Chromium's sandbox is required.** Stock Docker seccomp blocks the user namespaces it needs, so
this service explicitly uses the pinned Playwright-derived profile at
`packages/host/src/thumbnail_seccomp.json`, the same profile embedded in the local binary. It allows
Chromium's private namespace operations without unconfined seccomp, extra capabilities or a
`--no-sandbox` fallback. The Compose path is relative to this directory; keep the profile when
copying deployment files. Docker client proxy settings are explicitly blanked so they cannot inject
proxy credentials into the renderer.

Before opening its socket, the renderer performs a real fixed-document render. A failed browser
launch exits with an actionable diagnostic instead of advertising healthy. Ryph does not depend on
that healthcheck, so an unavailable renderer leaves placeholders without preventing startup or
publication. Host kernel/AppArmor restrictions may still need adjustment; do not disable the sandbox
to work around them. GKE keeps Chromium's sandbox required inside gVisor as well. Run a real
thumbnail smoke test on your host, not only a socket probe.

## Repositories

### GitHub, as you

The default. ryph acts on GitHub as the account a token belongs to, the way the binary does with
`gh auth token`. Create a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the
repositories agents should work on, with:

| Permission      | Access         | Why                                                 |
| --------------- | -------------- | --------------------------------------------------- |
| Contents        | Read and write | clone, and push the branches of approved patches    |
| Pull requests   | Read and write | open pull requests, read reviews, reply in them     |
| Issues          | Read and write | read and comment on issues and pull request threads |
| Metadata        | Read           | required by GitHub for any of the above             |
| Commit statuses | Read           | optional: lets agents see a pull request's CI       |

Leave **Workflows** off. Without it GitHub refuses a push that adds or changes `.github/workflows`,
which would otherwise run with your repository's secrets. Put the token in `.env` and restart:

```sh
RYPH_GITHUB_TOKEN=github_pat_…
docker compose up -d --wait
```

A token GitHub refuses stops ryph at boot, with GitHub's answer in `docker compose logs ryph`.
Everything ryph does on GitHub appears as you. There are no webhooks in this mode, so `/ryph`
comments do nothing and merges are noticed by polling, about once a minute.

### GitLab, as you

ryph acts on gitlab.com, or on your own GitLab 17.0 or newer, as the account a token belongs to.
Create a
[personal access token](https://gitlab.com/-/user_settings/personal_access_tokens?scopes=api,read_repository,write_repository)
(on your instance: `<its URL>/-/user_settings/personal_access_tokens`) with the scopes `api`,
`read_repository` and `write_repository`, put it in `.env` and restart:

```sh
RYPH_GITLAB_URL=https://gitlab.example.com   # leave out for gitlab.com
RYPH_GITLAB_MODE=user
RYPH_GITLAB_TOKEN=glpat-…
docker compose up -d --wait
```

As with GitHub, everything ryph does on GitLab appears as you, there are no webhooks, and merges are
noticed by polling. GitLab has no scope that keeps a token away from CI configuration: a branch ryph
pushes runs the project's `.gitlab-ci.yml`, an agent's edit to it included, with the project's
unprotected CI variables. Protect the variables a pipeline must not hand to such a branch.

An instance with a self-signed certificate needs its CA inside the `ryph` container, which `.env`
cannot put there: `compose.yaml` passes the container only the variables it names. Mount the CA file
and point `NODE_EXTRA_CA_CERTS` (ryph's GitLab API calls) and `GIT_SSL_CAINFO` (its git) at it in a
`compose.override.yaml`:

```yaml
# compose.override.yaml
services:
  ryph:
    volumes:
      - ./gitlab-ca.pem:/etc/ssl/gitlab-ca.pem:ro
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/gitlab-ca.pem
      GIT_SSL_CAINFO: /etc/ssl/gitlab-ca.pem
```

`GIT_SSL_CAINFO` replaces git's CA bundle rather than adding to it, so if ryph also clones from
GitHub or another public host, mount a file holding the system bundle and your CA together.

### Repositories on this machine

Without any git host, agents can work on repositories in the `repos` volume, mounted at
`/srv/repos`. Clone one there, then add it under Repos → Connect repository → On this machine:

```sh
docker compose exec ryph git clone https://example.com/you/project.git /srv/repos/project
```

Runs clone it through ryph and never see the volume. An approved patch lands as a branch in that
repository, which you can fetch from where you cloned it with
`docker compose exec ryph git -C
/srv/repos/project …`.

To use a directory on the host instead, mount it over `/srv/repos` in a `compose.override.yaml`. It
must be writable by uid 1994, ryph's user in the container. On a NAS share that is often not true:
UGOS, for one, refuses bind mounts from a shared folder to container users outside group 10.

```yaml
services:
  ryph:
    volumes:
      - /volume1/code:/srv/repos
```

`RYPH_LOCAL_REPO_ROOT=off` turns this way off.

### Radicle, on ryph's own node

The `radicle` profile adds a Radicle node of ryph's own and the bridge that drives it, the same pair
the networked deployment runs. The node makes its own key on first boot, so ryph has an identity of
its own on the network, apart from yours. Add to `.env`:

```sh
COMPOSE_PROFILES=radicle
RYPH_RADICLE_URL=http://radicle:7470
RYPH_RADICLE_TOKEN=…        # openssl rand -hex 32, or any 64 random hex characters
```

then `docker compose pull && docker compose up -d --wait`. ryph's status block then lists `radicle`
among its forges, and `docker compose logs radicle-node | grep "Node ID"` shows the node's identity.
Connect a repository by its RID under Repos.

The key is unencrypted on the `radicle-home` volume, so anyone who can read that volume can sign as
ryph's node. `RAD_PASSPHRASE` in `.env` encrypts it, but the passphrase then sits beside it, so it
only protects copies of the key file, such as backups. For a repository's delegates to accept ryph's
patches as theirs, add the node's DID as a delegate, or keep reviewing them as a peer's.

The node dials out only. To let peers dial in, publish port 8776 and set
`RYPH_RADICLE_EXTERNAL_ADDRESS` to the address they reach it at.

### Radicle, through a node you already run here

If a Radicle node already runs on this machine, ryph can act as that node's identity, the way the
binary's `RYPH_RADICLE_URL=embedded` does on a laptop. The bridge then runs inside ryph and needs
the node's whole `RAD_HOME`, not only its socket: `rad` writes patches and comments straight into
the node's storage and signs them with the key in `RAD_HOME/keys`. The socket only tells the node to
announce them. So:

- use the image with Radicle's CLI: `RYPH_VARIANT=-radicle` in `.env`, which runs
  `ryph:<RYPH_VERSION>-radicle`, so ryph stays at the launcher's version (a build from source builds
  that stage too);
- mount the node's `RAD_HOME` read-write over `/data/radicle`: a host path, or the node's named
  volume if it runs in a container;
- run ryph as the user that owns those files, which may mean `user:` below and handing the
  `ryph-home` and `repos` volumes to that uid once, as root:
  `docker run --rm -v ryph-compose_ryph-home:/a -v ryph-compose_repos:/b debian chown -R 1000:1000 /a /b`;
- leave the `radicle` profile off. One node, one bridge.

```yaml
# compose.override.yaml
services:
  ryph:
    user: "1000:1000" # the owner of the node's RAD_HOME; leave out for uid 1994
    volumes:
      - /home/you/.radicle:/data/radicle
    environment:
      RYPH_RADICLE_URL: embedded
```

The key has to be usable without anyone typing a passphrase:

- **an unencrypted key** works as it is;
- **`RAD_PASSPHRASE` in `.env`** unlocks an encrypted one, but the passphrase sits on the same
  machine as the key, so it only protects copies of the key file, such as backups;
- **an ssh-agent socket** mounted into the container, with `SSH_AUTH_SOCK` pointing at it, keeps the
  passphrase off the disk. The key must be added to the agent again after every reboot, and until it
  is, every Radicle write ryph makes fails.

Two more things to watch. The `rad` in the image is the version `images/radicle-node` pins; a node
on another heartwood release may disagree with it about storage. And a `RAD_HOME` on a NAS share
meets the same permission problem as a host directory above.

Never copy a key that a node elsewhere uses, your laptop's included, onto this machine. Two nodes
running one key at once is not safe. Give this machine its own identity instead, which is what the
`radicle` profile does.

### GitHub as an App

An App acts as itself rather than as you, can be installed by others, and gets webhooks: `/ryph`
commands in comments, and merges the moment they happen. It needs GitHub to reach ryph, which a NAS
that only your LAN can reach cannot offer, so most people here want the token above. Register an App
as [the forge's README](../../packages/forge/README.md) describes, then set all of these in `.env`,
and not `RYPH_GITHUB_TOKEN`:

```sh
RYPH_GITHUB_APP_ID=…
RYPH_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----\n"
RYPH_GITHUB_CLIENT_ID=…
RYPH_GITHUB_CLIENT_SECRET=…
RYPH_GITHUB_WEBHOOK_SECRET=…
```

Point the App's webhook URL at `<RYPH_APP_URL>/v1/hooks/github`. The UI's port passes a POST to that
exact path on to the forge, whatever host name it arrives under, so the reverse proxy
[below](#beyond-localhost) is all it needs.

### GitLab with a bot

A bot acts as an account of its own (a service account on GitLab Premium, an ordinary user anywhere
else) and gets webhooks: `/ryph` commands in comments, and merges the moment they happen. Like the
App above, it needs GitLab to reach ryph. Give the bot a personal access token with the scopes
above, and add it to each project, or a group, at the **Developer** role and no higher: protected
branches then keep it off your default branch. Then set in `.env`:

```sh
RYPH_GITLAB_URL=https://gitlab.example.com   # leave out for gitlab.com
RYPH_GITLAB_TOKEN=glpat-…                    # the bot's
RYPH_GITLAB_WEBHOOK_SECRET=…                 # openssl rand -hex 32
# Sign-in with GitLab: an OAuth application, confidential, scope read_user, redirect URI
# <RYPH_APP_URL>/gitlab/callback. Both or neither.
RYPH_GITLAB_CLIENT_ID=…
RYPH_GITLAB_CLIENT_SECRET=…
# Who may sign up through GitLab: members of this group. Leave out for no group gate.
RYPH_GITLAB_GROUP=acme/engineering
```

Connecting a repository shows its webhook's URL and token, which a Maintainer pastes into the
project's **Settings → Webhooks**. Each project's token is its own, derived from
`RYPH_GITLAB_WEBHOOK_SECRET`, so changing that secret disconnects every hook at once. The URL is
`<RYPH_APP_URL>/v1/hooks/gitlab?…`, and the UI's port passes it on to the forge, as for GitHub's.

A self-managed GitLab refuses to deliver to a private address (a LAN, a VPN, `10.x`) and says the
URL is blocked when the hook is saved. If ryph's address is one, an administrator lets it through
under **Admin → Settings → Network → Outbound requests**: add ryph's host to **Local IP addresses
and domain names that hooks and integrations can access**, or, broader, tick **Allow requests to the
local network from webhooks and integrations**. gitlab.com cannot reach a private address at all.

## Environments

Each repo gets an environment: an image with its checkout and its setup (`.ryph/setup.yml`, and a
`.ryph/Dockerfile` if it has one) already done, so its runs start ready instead of installing
dependencies every time. Checks (`.ryph/checks.yml`) run on the same images. ryph builds them by
itself and again as the default branch moves; Rebuild on the repo's page starts one by hand.

Both are on by default. `RYPH_ENVIRONMENTS=off` and `RYPH_CHECKS=off` in `.env` turn them off, and
runs then start from the agent image.

**With `RYPH_DOCKER_RUNTIME` set**, the launcher refuses every build, and ryph refuses to start
while environments are on. Set one of these in `.env`:

- `RYPH_ENV_TRUST_DEFAULT_BRANCH=on`, to build the default branch only;
- `RYPH_ENVIRONMENTS=off`, to build nothing.

Builds run privileged and outside that runtime (Security, below).

**Disk.** Every build starts from the universal image, several GB, most of it shared with the agent
image. Each repo's environment adds a few GB more, and its layer cache lives in `launcher-cache`.
Builds run in the launcher, so a build's clone and image exports, also GBs, go to `launcher-temp`
while it runs, not to the container's `/tmp`, which is memory. ryph keeps the newest image of each
branch and removes older ones half an hour after a newer build replaces them; a branch's image goes
two weeks after its build. What docker itself keeps (its build cache, base images pulled) is
`docker system prune`'s to clean.

## Beyond localhost

The UI is published on `127.0.0.1:3000`, so only this machine reaches it. To reach it from
elsewhere:

1. Put a reverse proxy with TLS in front, on this machine. ryph's session cookie is `Secure`, so a
   browser keeps it only over https (or on `localhost`); over plain http on a LAN address sign-in
   seems to work and then forgets you.
2. Set `RYPH_APP_URL` to the https address people use. Every link ryph sends and the passkey origin
   come from it, and sign-in is refused from any other origin.
3. Set `RYPH_ADDRESS_HEADER=x-forwarded-for` (and `RYPH_XFF_DEPTH`, 1 behind one proxy that appends
   the client). Sign-in is rate limited per client address, and without it every visitor arrives
   from docker's gateway and shares one limit, which one stranger can spend for everyone.
4. Keep `RYPH_UI_BIND=127.0.0.1` when the proxy runs on this machine. Set `RYPH_UI_BIND=0.0.0.0`
   only when it runs elsewhere, and then only on a network you trust.

With Caddy, for example:

```
ryph.example.lan {
  reverse_proxy 127.0.0.1:3000
}
```

`RYPH_UI_PORT` moves the published port.

**Previews** of an agent's dev server open at `http://<id>.localhost:7490`, a port published on
`127.0.0.1` beside the UI (`RYPH_PREVIEW_PORT` moves it). Every preview shares that one port, told
apart by its host name, and a browser resolves `*.localhost` to its own machine, so a preview opens
only in a browser on this machine. With `RYPH_APP_URL` set to anything but a `localhost` address
they are off, as they are for the binary: a `.localhost` link means nothing to a browser elsewhere.

**Inbound webhooks** for automations arrive at the control plane's `/v1/hooks/…` on port 7411, which
compose does not publish. Route that path there from your proxy if you use them, but leave GitHub's
and GitLab's (`/v1/hooks/github`, `/v1/hooks/gitlab`, exact) on the UI's port, ahead of that prefix.

## Upgrading

```sh
docker compose pull
docker compose up -d --wait
```

With `RYPH_VERSION` pinned, change it first. A `git pull` is only needed when `compose.yaml` itself
changed.

Upgrading from a version where ryph started its own run gate, before the `launcher` service: let
confined runs finish first. The gate's owner changes, and the launcher does not take the old gate
from under live runs.

ryph applies new migrations at boot. It refuses to start against a database a newer ryph has
migrated, so going back a version means restoring a backup taken before the upgrade.

Repos and workspaces with environment builds copy the agent image's tools when they are built: after
an upgrade, use Rebuild on each one, or their runs keep the old runner.

ryph and the launcher refuse to work at different versions (each says so at boot, naming both), so
upgrade them together: `RYPH_VERSION` moves every image at once, and `RYPH_VARIANT` keeps the
Radicle image on it too.

Upgrading from a version before environment images were tagged per deployment
(`ryph-env/<deployment>/…`): the older images (`ryph-env/<subject>:…`) and the BuildKit networks of
builds from then (`ryph-build-…`) are not cleaned up automatically, and the environments rebuild on
first use. Free them by hand, on a daemon no other ryph deployment shares, once nothing older is
running:

```sh
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ryph-env/[^/]+:' | xargs -r docker rmi
docker network ls -q --filter name=ryph-build- | xargs -r docker network rm
docker image prune
```

## Building from source

`compose.build.yaml` adds a `build:` to every image, from this checkout, tagged with the same refs
`compose.yaml` pulls:

```sh
docker compose -f compose.yaml -f compose.build.yaml build      # slow the first time
docker compose -f compose.yaml -f compose.build.yaml up -d --wait
```

`COMPOSE_FILE=compose.yaml:compose.build.yaml` in `.env` makes plain `docker compose` do the same.
Images are built for this machine's architecture. Pulls are the default because a build needs the
whole repository and a toolchain's worth of time, and because a `build:` beside each `image:` would
make `docker compose up` quietly build whatever it has not pulled. A later `docker compose pull`
replaces local builds with the published images.

## Backups

Three things, and the first two belong apart:

```sh
# The database. Safe while ryph runs.
docker compose exec -T postgres pg_dump -U ryph ryph | gzip > ryph-$(date +%F).sql.gz

# The master key. It opens every provider key and credential in the database; keep it
# somewhere other than the dumps, since a dump and its key together are the secrets in clear.
docker compose exec ryph cat /var/lib/ryph/secrets.key > secrets.key

# Files: run images, and the repositories on this machine.
docker run --rm -v ryph-compose_ryph-home:/v:ro -v "$PWD":/out debian \
  tar czf /out/ryph-home.tgz -C /v files
docker run --rm -v ryph-compose_repos:/v:ro -v "$PWD":/out debian \
  tar czf /out/repos.tgz -C /v .
```

To restore on a fresh install, before ryph has started for the first time: put the key back
(`docker compose run --rm -T --entrypoint sh ryph -c 'umask 077; cat > /var/lib/ryph/secrets.key' < secrets.key`),
start Postgres alone (`docker compose up -d --wait postgres`), load the dump
(`gunzip -c ryph-….sql.gz | docker compose exec -T postgres psql -U ryph ryph`), then start
everything. A dump restored without its key works, except that every stored provider key and MCP
credential fails until re-entered.

`docker compose down` keeps every volume. `docker compose down -v` deletes compose's volumes, the
database and the key included, and cannot be undone. Neither removes what the launcher started
(runs, the run gate, hosted MCP servers, check volumes, their networks); the label teardown under
[What is running](#what-is-running) does, with `down -v` in place of its `down` to delete the
volumes too.

## Security

**The docker socket is the launcher's, and the launcher is root on this machine.** Access to the
socket is root: whoever controls the `launcher` container can start any container with any mount. So
it is built to hold nothing else. It has no master key, no database and no provider key, and it
listens only on the compose network, for ryph.

**ryph holds the secrets and no socket.** It has the master key and the database, and no docker CLI
or socket at all. It asks the launcher over HTTP, with the two tokens the launcher mints into the
`launcher-tokens` volume on first boot, to start runs, check suites, environment builds and hosted
MCP servers. Everything about a container that could reach past it is the launcher's own
configuration, and no request can set it: the networks, the run gate and its routes, the runtime,
mounts, capabilities, privileges, published ports.

What that means if ryph is compromised: the attacker has every secret ryph holds, and can ask the
launcher for what ryph may ask for. That is a run, a check or a build on an image it names, on the
run network behind the gate, unprivileged, which is what a run already is; or a hosted MCP server on
the tools network, confined the same way. It cannot ask for a mount of this machine's files, a
privileged container, a capability, a published port or another network, so it does not get root on
this machine through the launcher. Two things stay as they were: an environment build runs in a
privileged BuildKit container (below), and anything that escapes a container reaches the daemon.

What that means if the launcher is compromised: assume the machine is. It is the one container to
keep patched and the one that has to stay off every network but ryph's.

What that means for runs:

- **Runs are containers on the same kernel**, with docker's default runtime. An escape reaches the
  daemon and, through it, everything. A Linux engine with gVisor or Kata registered can run them
  under it (`RYPH_DOCKER_RUNTIME=runsc`). With it set, ryph does not start while environments are on
  unless `RYPH_ENV_TRUST_DEFAULT_BRANCH=on` (Environments, above).
- **Runs are confined.** A run joins `ryph-compose-runs`, an `--internal` network: no default route,
  no DNS for outside names, and, with gateway mode `isolated` (Docker Engine 28 or later), no
  address on the docker host either. The launcher makes it so, and refuses to launch onto one that
  is not. Its one way out is the run gate, which relays exactly ryph's control plane, forge, model
  proxy, MCP gateway and egress proxy ports (7411, 7412, 7420, 7430, 7460) to ryph and nothing else:
  not the web UI, not previews, not Postgres, which is on no network at all.
- **The internet only through the allowlist.** The egress proxy behind port 7460 is a run's only
  route out, and lets through the hosts the agent's network policy names; it refuses private and
  loopback addresses, so it is no way back into this machine either.
- **Each listener authenticates its caller**; a run holds only its own short-lived credentials. Runs
  share the run network, so they can reach each other's open ports.
- **A run's browser runs without Chromium's own sandbox**, which docker's default seccomp profile
  does not let start. The container is the boundary: non-root, no capabilities, no mounts, and the
  run's network namespace, so its only way out is the agent's. That is the boundary that already
  holds the agent, which runs whatever code it likes. With `RYPH_DOCKER_RUNTIME=runsc` the browser
  tries its sandbox first, for defense in depth.

Measured on Docker Desktop (engine 29.8, macOS): from a run's network a public IP and a public name
were unreachable directly, as were ryph's and the gate's addresses on `ryph-compose` and the docker
host; through the gate the control plane answered and port 3000 refused; through the egress proxy an
allowlisted host answered 200 and one not on the list 403. These are docker's guarantees for
internal networks, and they need confirming on a native Docker Engine, where the bridge's host is
this machine rather than a VM. Engines older than 28.0 cannot make an internal network without a
gateway on the host; the launcher refuses to confine runs on them and says so at boot.

- **Environment builds run privileged.** A repo's `.ryph/Dockerfile` and setup steps run as root in
  a BuildKit container docker starts privileged. It is confined like a run: an internal network of
  its own, the run gate as its only way out, the egress proxy as its only route to the internet. But
  privileged is the most power repo content gets in this mode, and an escape from that container is
  root on this machine. `RYPH_DOCKER_RUNTIME` does not apply to builds, so with it set the launcher
  refuses every build, and ryph does not start while environments are on.
  `RYPH_ENV_TRUST_DEFAULT_BRANCH=on` builds the default branch only. Connect only repos whose
  `.ryph/` you would run as root here, or set `RYPH_ENVIRONMENTS=off`.
- **Postgres is on no network.** Only the containers that mount its socket volume can reach it,
  which is why it trusts them without a password. The launcher does not mount it.
- **Hosted MCP servers are confined like runs.** A vendor's image is code nobody here wrote, holding
  an operator's credential, so it joins `ryph-compose-tools`, which the launcher makes `--internal`
  with gateway mode `isolated` and refuses to host on where the engine cannot (Podman, a native
  engine older than 28). Nothing of ryph's is on it: ryph reaches a server only through the tool
  guard, the one container also on `ryph-compose`, whose image is the launcher's
  (`RYPH_TOOL_GUARD_IMAGE`) and never a request's. A server's one way out is the egress relay to
  ryph's egress proxy on a second port (7461), which takes only claims ryph signs for hosted
  servers, and opens any public host on any port and never a private, loopback, link-local or CGNAT
  address, whatever `RYPH_EGRESS_ALLOW_PRIVATE` says — the parity with Kubernetes's `ryph-tools`. So
  a hosted server reaches the internet and nothing of this machine, its LAN, its docker host or
  ryph's listeners. An MCP server on your LAN is registered by its URL instead
  (`RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS`), not hosted. A client that ignores `HTTPS_PROXY` (raw TCP, a
  JVM without its proxy flags, Node before 24) has no way out at all. Hosted servers on the tools
  network can reach each other's ports; the caller token each one checks is what keeps them out of
  one another. Measured on Docker Desktop (engine 29.8): from the tools network a public IP, an
  outside name, the docker host and the deployment network's gateway were all unreachable; the relay
  answered 407 to no claim and to a run's, 200 to a tool claim for a public host, and 403 to one for
  a private address. The guard's launch is fixed as well as its image: no command, only the env it
  reads, its own port and a bounded memory cap, so the tools token cannot run code of its own in the
  one container on both networks.
- **This host's own public address is the residual.** "Nothing private" is the private ranges plus
  the addresses on the egress proxy's own interfaces, and from inside the `ryph` container those are
  the container's, not the VM's; on a cloud VM the public address is often on no interface at all (a
  1:1 NAT). A hosted server may dial any public address on any port, so it can reach this VM's
  public address, and with it anything on the host bound to `0.0.0.0`, past the cloud firewall that
  keeps the internet off it. **On a cloud VM, set `RYPH_EGRESS_DENY_CIDRS` to this host's public
  addresses** (comma-separated CIDRs, IPv4 and IPv6); neither of the egress proxy's listeners dials
  them then, by literal or by a name that resolves to one, and a malformed entry stops ryph from
  booting. On a laptop, behind NAT, there is no such address to close.
- **A hosted server's egress claim does not expire.** Servers are long-lived and relaunched only
  when ryph boots, so revoking their claims is rotating `RYPH_EGRESS_TOOL_KEY` and restarting. Left
  unset, as here, ryph mints a fresh one on every boot, so a restart is the rotation.

People who need runs kept apart from the machine and from each other, or ryph's own services kept
apart from one another, want the networked deployment on Kubernetes, where those are network
policies and separate processes.

## Troubleshooting

- **`permission denied while trying to connect to the docker API`** in the launcher's logs,
  `DOCKER IS NOT REACHABLE` in ryph's, an unhealthy launcher, or runs that never start: `DOCKER_GID`
  is not the socket's group.
- **ryph does not start, saying the docker launcher did not answer:** `docker compose logs launcher`
  says why. It needs the socket (above) and its token volume.
- **ryph does not start, saying the launcher refuses every build:** `RYPH_DOCKER_RUNTIME` is set
  (Environments, above).
- **Runs fail with an image that cannot be pulled:** check `docker compose pull` works on this
  machine, and that `RYPH_VERSION` names a published tag.
- **A second instance on the same engine** needs its own `COMPOSE_PROJECT_NAME` and `RYPH_NETWORK`.
  Its run gate, run network, tools network, tool guard and egress relay are all named for
  `RYPH_NETWORK`, so the two keep apart.
- **Hosted MCP servers read unavailable, saying `ryph-compose-tools` does not confine and naming a
  container attached to it:** a compose file from before hosted servers were confined put ryph on
  that network. `docker compose up -d` with this file recreates ryph without it; the launcher then
  remakes the network at hosting's next boot (restart ryph).
- **The launcher stops at boot with `docker … is older than 28.0`** or a run network that "keeps a
  gateway address" (`docker compose logs launcher`): the engine cannot confine runs as configured.
  Upgrade docker, or remove the network the message names so the launcher can make it again.
- **Everything ryph logs** at more detail: `RYPH_LOG_LEVEL=info` (or `debug`).
