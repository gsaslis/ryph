# The environment you are working in

This is the Ryph repo itself, so you are a Ryph run working on Ryph. The container you are in is the
universal image this repo builds (`images/env/universal`), and the setup that ran before you started
was this repo's own `.ryph/setup.yml`.

## What is already done for you

`bun install --frozen-lockfile` has run in the workspace root. Every workspace dependency is
installed from `bun.lock` into `node_modules/`. **You do not need to install anything** to run a
test or a type-check.

Installed in the image: `bun` and `node` through mise's shims, which honour this repo's `mise.toml`
pins, plus `git`, `bash`, Rust, Python, Go and the everyday tools (`rg`, `fd`, `jq`, `just`). Call
`bun` directly, never `mise run`.

## Checks: run them with ryph__run_checks

This repo declares its checks in `.ryph/checks.yml`. They are the gate a change is judged by:

- `lint`: fmt and lint, across the repo.
- `orchestrator`, `runner`, `forge`, `radicle`: that package's type check, guard and tests.
- `app`: the web app's type check, tests and build.
- `chart`: the Helm chart in deploy/: its render tests and `helm lint`, with the helm `mise.toml`
  pins.
- `rest`: the same for every other package (perf/ among them), plus the type check of the scripts
  outside any package.
- `migrations`: the committed migrations match the schemas.

**Don't run their commands here yourself.** They run in a container of their own while you keep
working. Commit, call `ryph__run_checks`, and end your turn; the result arrives as the next message.
While you work in one package, name just its check (`checks: ["orchestrator"]`); a package without a
check of its own is in `rest`. Run all of them before you submit.

## Running a single test yourself while debugging

For a quick loop on one failing test, run that file directly in its package, with the flags from the
package's own `test` script in its `package.json`:

```bash
cd packages/orchestrator
bun test --no-env-file --timeout 60000 tests/services_test.ts
```

Narrow further with `-t "some words from the test name"`. Adding a path to a package's `test` script
does not narrow it, since the script already ends in `tests/`.

Suites using `@ryph/db/testing` group their cases as tests under a `describe` named for the suite;
`-t` matches either. See the adopter list and suite names in
[`packages/db/README.md`](../packages/db/README.md).

The web app is vitest, and its script takes a path:

```bash
bun run --filter '@ryph/app' test src/lib/utils/markdown.test.ts
```

Leave whole-package suites, fmt, lint, type checks and builds to the checks.

## What you cannot run here, and must not try

- **Anything needing a container runtime**: `bun run compose:*`, `k8s:*`, `agent-image`, `gcp:*`.
  The agent images ship no docker CLI and no daemon socket — deliberately, it would be root on the
  host node. No check runs the compose e2e or the k8s smoke; write the change, reason about it, and
  say in the PR that `bun run compose:e2e` needs running by hand on a machine with docker.
- **`bun run db:push` / `up` / `dev`** — the local dev stack. It wants an `.env` and a process that
  keeps running; it is not how you verify a change from here. To look at the app, use the playground
  below instead.
- There is **no service container** beside this run and none is needed: everything in this repo that
  touches Postgres runs it embedded through pglite (`pglite:memory://`, or a `data/` directory that
  is gitignored). Nothing to dial, nothing to wait for. The checks run the drizzle tests over a
  Postgres of their own instead (`db` in `.ryph/services.yml`, `checks_only`, so never started
  here). Run the tests here without `RYPH_TEST_DB` and they use pglite; the same tests pass on both.

## Looking at the UI: the playground

`bun run playground` runs the whole of ryph in this container: every service from source on an
embedded database, the app's Vite dev server on `localhost:5173`, and a seeded deployment behind it:
a team of four, three repos, four agents, three representative finished runs (an approved patch, a
patch awaiting review and a no-change conversation), usage, automations, memory, and two runs that
are live right now (one working, one waiting for an answer). No container runtime is involved.

If the task is likely to need browser verification — layout, styling, navigation or other UI
behavior — **start the playground early**, before investigating or editing, so startup overlaps your
work. Don't start it for backend-only tasks. Use `ryph__background_run` with
`command: "bun run playground"`, the repository as `cwd`, `service: true` and
`readyWhen: "RYPH_PLAYGROUND_READY"`. Keep working: a one-time service-ready message arrives when
the seed, live fixtures and HTTP readiness checks are complete. Then open `localhost:5173` in your
browser tool when you have something to inspect. Reuse the process throughout the task; don't poll
its log or guess a startup delay. If using an older runner without `readyWhen`, check
`ryph__background_output` for `RYPH_PLAYGROUND_READY` when you need the browser.

Sign in as `owner@ryph.local` with the password `playground-password` (`member@`, `operator@` and
`viewer@ryph.local` for the other roles).

The app hot-reloads as you edit `packages/app`; a change to a backend package needs the playground
restarted. Tasks you start in the app are played by a scripted runner that answers every message, so
creating tasks and chatting with runs works end to end. Compose a different deployment with
`--preset full` for every history state, `--preset minimal` for no history, `--with history=40`, or
`--without live,waiting`; `bun run playground list` shows the fixtures. Everything it writes is
under the gitignored `data/playground/`.

## Two house rules the platform enforces

- **Leave the tree clean of anything that is not your work.** Whatever is modified or untracked at
  the end is committed as your change. Test runs here are already clean — pglite's data dirs,
  `node_modules/` and build output are gitignored — so if `git status` shows something you did not
  mean to write, remove it or gitignore it deliberately.
- **Nothing survives this container.** Whatever a command starts dies with the run; there is no
  teardown hook and no state carried to the next run.

If you change a dependency in any `package.json`, run `bun install` and commit the updated
`bun.lock`: the checks install with `--frozen-lockfile` and fail on the skew. If you change a
database schema, run `bun run db:generate` and commit the migrations; the `migrations` check fails
otherwise.
