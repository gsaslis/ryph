# @ryph/runner

> **ryph** is a codename, pending the production name.
> In code it lives in exactly two places — `src/core/brand.ts` (single source of truth,
> everything brand-derived comes from there) and the `name` field in `package.json`;
> prose mentions in README/docs are a grep away. Renaming is a two-file change plus that grep.

A Bun service that executes exactly **one work item**, start to finish:
clone the repo, let a coding agent work inside the clone,
commit, push a fresh branch, report a result.
It is one piece of a larger system — something upstream decides what to run and collects the outcome —
but the runner never sees that system directly: everything outside the box is reached through a port.

## ⚙️ How it works

A run moves through five phases — **cloning → preparing → setting-up → running → finalizing** —
inside a [disposable local clone](docs/git-flow.md); the pushed branch is the only thing that survives.
In `setting-up`, a repo that carries an [environment config](docs/environment-setup.md)
gets its setup steps run and its environment description handed to the agent — behind the
platform's own account of the machine the run landed on
([the machine block](docs/harnesses.md#-the-machine-block)).
The runner is a small [hexagonal architecture](docs/architecture.md):
`src/core/` holds the run pipeline and depends on nothing concrete,
every external effect goes through a port (`src/ports/`),
and `src/main.ts` binds each port to an adapter (`src/adapters/`).
The `Harness` port — the coding agent itself — is the extension point.

## 🚀 Usage

```sh
bun --no-env-file src/main.ts --work-item work-item.json
```

`--no-env-file` keeps Bun from loading a `.env` in the working directory. The runner reads its
JSON inputs and works in a temp checkout, reads the [env knobs](docs/architecture.md#️-env-knobs),
binds the [inbound control API](docs/cancellation-flow.md) when a control token is set, reports
heartbeats and the result upstream when an orchestrator is wired, and shells out to `git` (clone,
commit, push) and `bash` (a repo's own [setup steps](docs/environment-setup.md), and the agent's
background commands). Commits are authored as the work item's agent and are not signed.

In the agent image the runner is a compiled binary (`bun run compile` builds both it and
`ryph-bake` into `dist/`):

```sh
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  src/main.ts --outfile ryph-runner
```

The two `--no-compile-autoload-*` flags are required: without them the binary loads a `.env` and
a `bunfig.toml` (and runs its `preload` scripts) from whatever directory it starts in.

The runner's own flags:

| Flag                              | Meaning                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--work-item <path>`              | JSON describing the work to do: the harness to run, the agent's identity, and the task; required unless the spec is fetched on boot (below) |
| `--context <path>`                | (optional) JSON merged in as injected context; falls back to the fetched spec's context, else `{}`                                          |

Inside an [agent container](../../images/README.md) — the pre-baked image an orchestrator
launches, which passes no argv — the work item and context arrive by **fetch-on-boot** instead:
with `RYPH_RUN_ID`, `RYPH_ORCHESTRATOR_URL`, and `RYPH_BOOTSTRAP_TOKEN` all set, the runner
redeems the single-use bootstrap token for credentials held only in memory, then fetches its spec (`GET /v1/runs/:id/spec`, the frozen work item plus injected context) and validates it
through the same ingest boundary as the files. The `--work-item` flag wins when both are available.
A spec that cannot be fetched or validated is a startup failure (exit `2`), reported upstream as an
error result when the report can land. The skills section is the exception: one the runner refuses
leaves the run without skills rather than stopping it (see
[harnesses.md](docs/harnesses.md#-skills)).

The run's `Result` prints as JSON on **stdout** (all logging goes to stderr, so stdout stays clean) —
every status it can take is catalogued in [architecture.md](docs/architecture.md#-every-possible-result).
Bad usage exits `2`; a run that reports its result exits normally, whatever the status.

## ⚡ Quick start

Tool versions are pinned in the checkout root's [`mise.toml`](../../mise.toml);
[mise](https://mise.jdx.dev) provisions them:

```sh
mise install    # installs the pinned Bun
bun run ci      # type-check, architecture guard, tests (fmt and lint are root scripts)
bun run debug   # runs the whole pipeline end to end against a throwaway local origin —
                # no network or credentials; it waits for a debugger to attach (see below)
```

The full task list and the debugger walkthrough live in [development.md](docs/development.md).

## 📚 Docs

| Doc                                               | What it covers                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md)           | the ports and adapters, the run pipeline, every possible `Result`, and the env knobs  |
| [git-flow.md](docs/git-flow.md)                   | how a run moves through git: clone from `repo.ref`, work locally, push a fresh branch |
| [environment-setup.md](docs/environment-setup.md) | the repo-side contract: setup steps run before the agent, environment.md injected     |
| [cancellation-flow.md](docs/cancellation-flow.md) | how a run is stopped gracefully — whatever the agent already committed still ships    |
| [development.md](docs/development.md)             | prerequisites, tasks, and debugging the runner end to end on your machine             |
