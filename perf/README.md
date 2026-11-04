# 🏋️ The perf harness

Pressure and a long history against the real services, on one machine, shaped like a small
production Kubernetes install.

```sh
bun run perf:up                        # the compose stack, production-shaped (see below)
bun run perf:load --scenario smoke     # once: the seeder copies the rows this makes
bun run perf:seed --runs 100000        # two years of history
bun run perf:report --reset
bun run perf:load --scenario burst     # or steady, soak
bun run perf:report                    # what the database did during it
```

It runs as its own compose project (`ryph-perf`) on its own networks (`ryph-perf`,
`ryph-tools-ryph-perf`), so `compose:up`'s data is never touched. It is not a second stack beside
it, though: both publish the same host ports, and the driver dials those ports. `compose:stop` the
dev stack before `perf:up`, and `perf:down` before bringing it back.

## The shape

`compose.perf.yaml` layers three production numbers over
[`deploy/compose-networked/compose.yaml`](../deploy/compose-networked/compose.yaml):

| What             | Here                     | A small production install                                |
| ---------------- | ------------------------ | --------------------------------------------------------- |
| Service CPU      | capped at 250m           | 250m requested (the chart's default), no limit: bursts    |
| Postgres         | 1 core, 1.7 GB, 50 conns | a small managed instance (Cloud SQL `db-g1-small`, say)   |
| Pool per service | `max=2`                  | `max=2` in `postgres.params` (deploy/helm/ryph/README.md) |

The CPU cap is the worst case, a node whose neighbours are all busy. `PERF_CPU=0` lifts it for the
best case, and the truth is between the two, so run both. `PERF_DB_CPU`, `PERF_POOL` and
`PERF_CP_POOL` (the control plane's pool alone) widen the others; the two pool variables are the
whole query string the database URL ends with, `PERF_CP_POOL='?max=6&idle_timeout=30'`, not a bare
number. Changing any of them is a `perf:up` with the variable set, which recreates only what
changed.

Nothing is launched. The networked compose runs every run, check and build through the docker
launcher; here the control plane is back on the manual provisioner, because the driver plays the
runners itself (below). The launcher stays out, environment builds, checks and hosted MCP servers
are off, and every address a run is handed names its service directly instead of the run gate.

A `mock-model` service stands in for the provider: an OpenAI-compatible endpoint streaming canned
completions with usage, registered as a custom endpoint. Model calls go through the real proxy and
meter real rows.

## The driver

`load.ts` plays three parties over the real HTTP surfaces:

- **users** create tasks through the control plane, at `--rate` a second up to `--concurrency` live,
  each on the stack's fixture repository (the networked compose's `fixture-repo`), connected on
  first use
- **runners**, one per run, do what `packages/runner` does: spec, credentials, a heartbeat every 10
  s and on each phase, model calls through the proxy, transcript batches to the historian every
  second, a result. The bootstrap token comes off the control plane's log, the manual provisioner's
  contract, and is redeemed for the run token as a runner would
- **viewers**, each a browser tab: the task list's SSE, the run's transcript SSE, and the run page's
  3 s poll, moving to another task every minute

| Scenario | Runs | Live at once | Arrival | Turns | Viewers |
| -------- | ---- | ------------ | ------- | ----- | ------- |
| `smoke`  | 5    | 5            | 1/s     | 3     | 2       |
| `steady` | 200  | 40           | 2/s     | 15    | 12      |
| `burst`  | 500  | 500          | 50/s    | 10    | 25      |
| `soak`   | 60   | 30           | 1/s     | 120   | 20      |

Any of `--runs --concurrency --rate --turns --thinkMs --viewers` overrides the scenario.

Every 15 s it prints per-operation latency, runs in flight, and database connections. At the end:
the summary, each service's CPU used and **throttled** from its cgroup (the number that says a
service is queueing behind its quota), memory first to last, and the raw samples in `perf/results/`.

`view.events.stream` times until the stream's response headers arrive. Measured through the app,
they arrive with the stream's first frame, so for a live run it is mostly the wait for the next
transcript event, not a connect latency.

## The seeder

`seed.ts` copies template rows the services wrote during a `smoke` run, so every jsonb column is as
fat as a real one. It spreads the copies over `--days` with the skew real use has: one agent with
half the work, and one run in a thousand fifty times the mean length. Seeded ids start `s-`, and
`--wipe` takes them out again.
