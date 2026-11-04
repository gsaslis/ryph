# Contributing to ryph

The repository is a [Bun workspace](https://bun.com/docs/install/workspaces). This page is the
contributor's half of the old README: the toolchain, the commands, how the repo runs on itself, and
how designs are written down. What ryph is and how to run it is in the [README](README.md) and
[docs/guides](docs/guides/).

## Getting started

```sh
mise install   # the pinned Bun and Node (mise.toml)
bun install    # every workspace member, from bun.lock
bun run ci     # the full gate
```

Runtime conventions (`node:*` APIs over `Bun.*`, the shared `serve`/`command`/`caFetch` helpers,
tests, compile flags) and the Bun surprises we have hit are in [docs/runtime.md](docs/runtime.md).
The system, end to end, with the doc that owns each step:
[docs/system-flow.md](docs/system-flow.md).

## Commands

- `./dev init` then `./dev up` — the local dev stack: host, forge and app, each in a tmux pane, with
  `./dev doctor` to say what is wrong before you start. See
  [`packages/devstack`](packages/devstack/README.md). Not to be confused with the shipping `ryph`
  binary — it is never installed on `PATH`, only run from the checkout.
- `bun run db:push` then `bun run up` — the same backend without the tmux wrapper, one process via
  [`@ryph/host`](packages/host/README.md). The schema push is a first-run step and is idempotent
  after that. The web app runs separately: `bun run --filter '@ryph/app' dev`.
- `bun run playground` — a whole ryph seeded with fixtures (a team, repos, history, live runs) and
  the app's dev server in front of it, for UI work; no container runtime needed. See
  [`packages/playground`](packages/playground/README.md).
- `bun run build` — compiles the shipping binary to `dist/ryph` (~115 MB, UI and memory's embedding
  model included). Cross-compile with
  `bun run --filter '@ryph/cli' compile -- --target=bun-linux-x64`.
- `bun run ci` — full gate across the workspace: fmt check, lint, then every member's type-check,
  architecture guard, and tests. It starts no process that talks to another process — that half is
  `compose:e2e`.
- `bun run compose:up` / `compose:smoke` — the networked deployment on this machine, built from this
  checkout, and the cross-service checks that verify it. Needs a docker daemon. `compose:stop`
  pauses it, `compose:down` removes the containers but keeps the data, `compose:reset` takes the
  data too.
- `bun run k8s:smoke --kube-context <ctx>` — checks a Helm install: the app and the services behind
  it, then what a run's pod can and cannot reach. See
  [the chart's README](deploy/helm/ryph/README.md).
- `bun run images:publish` — builds every image and pushes it to `quay.io/ryph`, where both compose
  deployments and the binary pull from. See [`images/README.md`](images/README.md).
- `bun run --filter '@ryph/<name>' <task>` — run one member's task from the root.

Each package also has its own tasks; see its README. Every root script is described in the `"//"`
block of [`package.json`](package.json). The Bun version is pinned in `mise.toml`.

## Formatting and lint

`bun run fmt` formats everything with dprint (`dprint.json`: 100 columns, markdown wrapped) and then
the `<script>` and `<style>` blocks of every `.svelte` file. `bun run fmt:check` and `bun run lint`
(oxlint) are the first two steps of `ci`. Write docs in the voice the existing ones use: present
tense, the invariant in bold, a link to the doc that owns a detail rather than a second copy of it.

## Runs on this repo

Ryph works on ryph, so this repo carries its own [`.ryph/`](.ryph/environment.md) dir — the same
[environment setup](packages/runner/docs/environment-setup.md) any connected repo may carry.
`setup.yml` installs the workspace from the lockfile, exactly as CI does, and `environment.md` tells
the agent how to run the _specific_ tests its change touches: the full gate is CI's job, and a run's
hardware is not the place to spend minutes on it. No `services.yml` — every Postgres in this repo's
tests is embedded (pglite), so there is nothing to start beside the run.

## Dependencies

Each member declares its own dependencies in its `package.json`; `bun install` at the root installs
them all into one `node_modules`, locked once in the root `bun.lock`. A member that imports another
names it as `"@ryph/<pkg>": "workspace:*"`. Where one version must hold workspace-wide, every member
that uses the package pins the same range. JSR packages (`@std/*`, `@cliffy/*`) come through JSR's
npm registry, as `"@std/assert": "npm:@jsr/std__assert@1"` (the `@jsr` scope is set in
`bunfig.toml`). A changed dependency means `bun install` and a committed `bun.lock`; a changed
schema means `bun run db:generate` and committed migrations.

## Releases & versioning

Versions are semver, and one number covers everything a release ships: the `ryph` binary, every
image on `quay.io/ryph`, and the Helm chart. `ryph --version` prints it.

- Before 1.0, a minor bump (`0.1` to `0.2`) may break things, and its release notes say what to do.
  A patch bump (`0.1.0` to `0.1.1`) never needs any action.
- An upgrade runs its database migrations by itself on start. A downgrade is refused: an older
  binary will not start on data a newer one has migrated
  ([`schema_guard.ts`](packages/ryph/src/schema_guard.ts)).
- Builds of main are published too, as `sha-<commit>`, with `edge` pointing at the newest. That is
  an unsupported edge channel: use it to try a fix, not to run a team on.

To cut a release, say `0.1.0`:

```sh
bun run release:version --stamp 0.1.0   # the chart's version and appVersion; merge that to main
git switch main && git pull
git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0
bun run images:publish --version 0.1.0  # pushes 0.1.0 and sha-<commit>, moves edge
bun run release --version 0.1.0         # the binaries; moves latest
gh release create v0.1.0 --verify-tag --generate-notes
```

`images:publish` does not rebuild the universal image: it gives the one already at
`ryph-universal:1` the release's tags, so its digest stays put. Rebuilding it makes every deployment
rebuild all its environments, so do it only on purpose, with `--build-universal`
([images/README.md](images/README.md#-publishing)).

Both publish scripts refuse a dirty tree, a HEAD that is not the tagged commit, and a chart that
does not say the version. Without a version tag on HEAD they publish an edge build instead
([`version.ts`](packages/ryph/scripts/version.ts)).

## Designs

A change that revises an invariant, adds a service or a surface, or needs a threat-model delta is
written up first, in an issue, before the code: the one-paragraph version, why, the shape, what
breaks and what happens then, what it deliberately does not do, and phasing.
