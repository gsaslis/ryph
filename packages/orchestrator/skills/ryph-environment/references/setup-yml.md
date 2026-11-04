# .ryph/setup.yml reference

The steps that prepare a checkout: installing dependencies and warming what the project's checks
compile. `.ryph/setup.yaml` is read when there is no `.yml`.

## Shape

```yaml
# .ryph/setup.yml
steps:
  - name: install dependencies
    run: pnpm install
  - name: generate the API client
    run: pnpm --filter api-client generate
  - run: cargo build --workspace --all-targets --locked
```

| Key            | Rule                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| `steps`        | Required: a list of at most 100 steps. The only top-level key                        |
| `steps[].run`  | Required: a non-empty string of at most 10,000 characters                            |
| `steps[].name` | Optional: a non-empty string of at most 200 characters, shown in progress and errors |

Validation is strict: an unknown key anywhere, a step without `run`, or YAML that does not parse
makes the file invalid, and then none of its steps run. That does not fail the build or the run:
both go on without the setup, and the build result, the build's page and the run page say
`setup.yml` is invalid, with the error. An invalid file is still a bug to fix. An empty or
comments-only file means no steps. The file may be at most 1 MiB.

## How steps run

- Each step runs as `bash -c "<run>"` in the repository's root, top to bottom.
- Every step is a fresh shell: a variable or a `cd` does not carry to the next one. Set variables
  inline (`FOO=bar cmd`) or write a multi-line `run: |` script.
- Output streams to the run's log line by line; each step's start is shown as progress.
- The first non-zero exit stops the sequence, and the repository's remaining steps are skipped.
  Neither an image build nor a run fails over it: other repositories still set up, the image is
  finished (`ready`), and the run goes on. Whatever the failed step changed in that repository's
  tree is discarded: tracked and untracked changes, a commit or a branch switch, a rebase or merge
  left half-done. Gitignored build output may remain. The failure is a warning instead: the build
  result you are sent says the build SUCCEEDED but setup.yml did NOT finish, with the step's label,
  its exit code and the end of its output, and the run page and the agent's prompt say the same, so
  a run's agent may have to finish the setup itself. A step that fails is still a bug to fix: a
  build result that says setup.yml did not finish means your setup.yml does not work yet.
- A cancelled run kills the step in flight and skips the rest.
- In a run of several repositories, each repository's steps run in its own checkout, in checkout
  order, and every tree is checked clean once all of them have run.

## The two passes

The same steps run twice:

| Phase | `RYPH_SETUP_PHASE` | Where                                                                                       |
| ----- | ------------------ | ------------------------------------------------------------------------------------------- |
| image | `image`            | At image build, in the clone baked into the image. No services exist                        |
| run   | `run`              | At the start of every run, after the baked clone moved to the run's commit. Services are up |

So every step must be cheap when nothing changed:

| Cheap on a warm tree                                          | Not: it throws the warm tree away  |
| ------------------------------------------------------------- | ---------------------------------- |
| `cargo build`, `cargo fetch`                                  | `cargo clean && cargo build`       |
| `npm install --prefer-offline`, `pnpm install`, `bun install` | `npm ci` (deletes `node_modules/`) |
| `uv sync`, `pip install -r requirements.txt`                  | recreating the virtualenv          |
| `deno install --frozen`, `go mod download`                    |                                    |

Image layers keep file times in whole seconds. Before the image pass, the platform rounds the mtime
of every tracked file down to the second, so a build tool sees the same times at build and at run
start. Do not add a step that touches files for this.

Prefer `uv sync` for a Python project: it installs the project editable and keeps the venv exactly
the lockfile's. A `pip install .` copies the project's own code into the venv, so the image's copy
shadows the head's in every check that keeps `.venv`.

For a step that should differ, branch on the variable:

```yaml
# .ryph/setup.yml
steps:
  - name: install dependencies
    run: npm install --prefer-offline
  - name: warm the build cache (image builds only)
    run: '[ "$RYPH_SETUP_PHASE" = image ] && npm run build || true'
  - name: migrate the test database (runs only)
    run: '[ "$RYPH_SETUP_PHASE" = run ] || exit 0; npm run db:migrate'
```

## What warms what

Warm what the checks compile, read off the project's CI and hooks, or the first check on the image
is still cold:

- Rust: `cargo build --workspace --all-targets --locked`; when the checks use nextest and clippy,
  `cargo nextest run --workspace --no-run --locked` and
  `cargo clippy --workspace --all-targets
  --locked`, with the same features and profile the checks
  use.
- JavaScript: the package manager's install, plus the build or codegen step tests need first.
- Python: `uv sync` with the extras the tests use.
- Go: `go mod download`, then `go test -run '^$' ./...` to compile the tests.

## What a step sees

- The run's container, in the cloned checkout, as uid 1994.
- The environment without any `RYPH_*` variable (the runner's own credentials are scrubbed), except
  `RYPH_SETUP_PHASE`, which is set for the step.
- Where the deployment confines outbound traffic, `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` point
  at the egress proxy. `NO_PROXY` carries the platform's own addresses and the run's services, so
  those are reached directly.
- No container runtime. Databases and caches come from `.ryph/services.yml`, reached by name
  (`db:5432`), never `localhost`.
- Downloads go through the same egress allowlist as the Dockerfile's: prefer the package managers
  and official release hosts over arbitrary URLs.

## Skills are not setup output

Commit repository skills under `.agents/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`;
do not copy, generate or install them in setup. When enabled, working-repo skills are read from git
objects at the checkout's base commit before any setup step. Both directories share the same limits,
in name order, with `.agents/skills` winning equal names and collisions reported. A preferred
directory or link shadows the `.claude` copy even if invalid; there is no fallback or file merging,
and both copies count toward the directory cap. Frozen platform/org skills and earlier checkouts
retain precedence. `.claude/agents/*.md` is not imported: its Claude Code-specific model, tool and
permission settings are not Ryph subagent presets. Use skills and explicit subagent tasks instead.

## The clean-tree rule

After every step of every repository has run, each tree must be clean. Whatever a tree holds when a
run ends is committed as the agent's work, so setup output must never show up there: a modified or
untracked file that is not gitignored is discarded — the checkout put back to the commit it started
from, ignored files kept — with a warning naming the files, and the build or run goes on without it.
A repository whose step failed has its tree put back already. Once a step has failed in one
repository, changes left in another cannot be told apart from what that step did, so they are
discarded too, with a warning naming both. Only a tree that cannot be put back fails the build or
the run. Write output to a gitignored path (`node_modules/`, `target/`, `.venv/`) or outside the
checkout, and install with the tool's locked flag so a lockfile is not rewritten.

Nothing tears down what a step started: one container is one run, and everything in it ends with the
run.
