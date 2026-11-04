# .ryph/services.yml reference

The databases and caches a repository's runs and checks need, started by the platform beside each
run. The agent's machine has no container runtime, so this is the only way to get one.
`.ryph/services.yml` is read before a run's container exists, through the platform, at the run's own
branch when it is one of the repository's branches and at the default branch otherwise.

The deployment must run service containers at all: it is off until the operator sets
`RYPH_SERVICES=on`, and then a run gets at most `RYPH_SERVICE_MAX` services (3 by default). A run
whose file cannot be read or resolved is not started, with the reason, because a run whose database
is silently missing hangs rather than fails. For the same reason, where services are off, a run
whose checkout declares any it would start fails at its start, naming them. A `checks_only` service
(below) is not one of those.

## Shape

```yaml
# .ryph/services.yml
services:
  db:
    uses: postgres@18
    command: ["postgres", "-p", "5433", "-c", "fsync=off"]
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app_test
    port: 5433
  cache:
    uses: redis@8
    port: 6379
```

One top-level key, `services`: a mapping of name to service, at most 20 entries. An empty or
comments-only file declares nothing.

| Key           | Required | Rule                                                                                                                                   |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| the name      | yes      | The hostname: `^[a-z]([a-z0-9-]{0,57}[a-z0-9])?$`, lowercase letters, digits and dashes, starting with a letter, at most 59 characters |
| `uses`        | yes      | A catalogue entry and version, `<entry>@<version>` (below). Never an image reference                                                   |
| `port`        | yes      | 1–65535: what the run dials and what the platform waits on. Not 8080, and distinct per service                                         |
| `command`     | no       | The container's argv as a list of strings, at most 64, each 1–1000 characters. No string form and no shell                             |
| `env`         | no       | At most 32 settings the entry accepts (below). Values are strings, numbers or booleans, at most 2000 characters                        |
| `checks_only` | no       | `true` or `false` (the default). `true` starts it only for the checks that name it, never beside a run                                 |

Mark a service `checks_only: true` when only the checks need it, such as a database a test suite
runs over. Runs then ignore it: they do not start it, do not wait for it, and are not refused where
the deployment runs no service containers. A repository whose every service is `checks_only` runs
exactly like one without a `services.yml`. An agent that wants the same database during its run uses
something it can start itself, such as an embedded one.

Parsing is strict: an unknown key, a YAML anchor or alias, or a malformed value refuses the file
with a message naming the field. A number in `command` must be quoted (`"5433"`).

## Names that are refused

A service's name beats DNS inside the run, so a name something else answers to would intercept the
run's own traffic. Refused: `control-plane`, `forge`, `historian`, `memory`, `model-proxy`,
`mcp-gateway`, `app`, `postgres`, `objects`, `localhost`, `kubernetes`, `host`,
`host.docker.internal`, `browser`, and the host of any address the deployment hands its runs. Name a
Postgres service `db`.

Port 8080 is the runner's own control port, and services start first, so a service there would take
it from the runner. Port 7490 is the platform browser's, which shares the run's localhost with the
services. Two services may not share a port.

## The catalogue

`uses` picks a reviewed, digest-pinned image. This release offers:

| `uses`              | Default port | Settings `env` may set                                                                                                              |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `postgres@18`       | 5432         | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_INITDB_ARGS`, `POSTGRES_HOST_AUTH_METHOD`, `PGDATA`                  |
| `mysql@9`           | 3306         | `MYSQL_ROOT_PASSWORD`, `MYSQL_ALLOW_EMPTY_PASSWORD`, `MYSQL_RANDOM_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` |
| `mongo@8`           | 27017        | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `MONGO_INITDB_DATABASE`                                                 |
| `redis@8`           | 6379         | none                                                                                                                                |
| `meilisearch@v1.24` | 7700         | `MEILI_MASTER_KEY`, `MEILI_ENV`, `MEILI_NO_ANALYTICS`, `MEILI_LOG_LEVEL`                                                            |

The default port is where the image listens unless `command` moves it; `port` must say where it
actually listens. A setting the entry does not list is refused. `env` is committed to the repository
and visible in the run's record: settings for a throwaway test database, never a real credential.

An operator may also allow raw images (`image:` with `capabilities:` in place of `uses`) through
`RYPH_SERVICE_IMAGES`; without that, only the catalogue works.

## Reaching a service

Always by its name and port: `db:5433`, `cache:6379`. `localhost` happens to work on one backend and
fails on another, so committed configuration (`.env.example`, test settings, `DATABASE_URL`) must
use the name. Say in `.ryph/environment.md` how the project reaches each service.

## When services are up

- **Runs**: every service not marked `checks_only`, started with the run's container, and each must
  accept a TCP connection on its `port` (checked for up to two minutes) before `setup.yml` runs and
  the agent starts. The agent is told the true list, ahead of `environment.md`.
- **Image builds**: no services. A `setup.yml` step that needs one must skip itself when
  `RYPH_SETUP_PHASE` is `image`.
- **Checks**: only the services some check names in `.ryph/checks.yml`, `checks_only` or not,
  started after the checks file's `setup` (see the ryph-checks skill). Where the deployment runs no
  service containers, a suite in which any check names one ends in an error, saying so.

Every service lives and dies with its run. Nothing outside the run can reach it.

## Workspaces and standalone runs

Declare each repository's required services in its own `services.yml`. A standalone run reads only
that repository's declarations; putting its database solely in the workspace's environment
repository leaves standalone runs without it.

Workspace runs merge every member's declarations. The same name with the same specification is one
shared service, so repeat that declaration in each member that needs it independently. Match `uses`,
`port`, `command` and `env` (and `image` and `capabilities` where raw images are allowed). Different
specifications under the same name refuse the run; do not solve that by deleting a declaration a
member needs standalone.

If members need separate services, give them different names and different listening ports, and
ensure their client configuration uses those names and ports. Changing `port` alone does not change
where the server listens: configure its command as needed. Check the number of distinct services
against the deployment's per-run limit after merging. If this requires project configuration changes
outside the setup task's scope, report the blocker instead of shipping an incomplete environment.

A workspace run proving that a shared service is available does not prove that each member declared
it locally. Review each member's file, and distinguish workspace testing from standalone validation.

## Where services work

Kubernetes (native sidecars in the run's pod) and docker (a network per run).
