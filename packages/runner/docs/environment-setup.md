# 🧰 Environment setup

How a repo prepares the ground for the agent that will work on it.
A repo opts in by carrying a `.ryph/` dir at its root with any of three files:
`setup.yml`, a CI-like sequence of shell steps the runner executes before the agent starts;
`environment.md`, the repo's own description of that environment,
injected into the agent's system prompt so it knows what was prepared for it;
and `services.yml`, the databases and caches the platform starts _beside_ the run
([service containers](../../orchestrator/docs/service-containers.md)).
Repos without the dir run exactly as before — all three are optional.

Nobody has to write them by hand. The repo page's **Set up this repo's environment** starts a task
in which an agent reads the repo's CI configuration, contributor guides, toolchain pins and
lockfiles, writes `setup.yml` and `environment.md` (a `Dockerfile` only for what setup steps cannot
or should not provide, `services.yml` when the checks need a database), tries what it can of them in
its own shell, and ships them as a patch; the platform builds that patch's branch and posts the
result into the run's inbox, and the agent revises until the build succeeds (`environment_status`
answers the same on demand). The agent cannot run Docker, and this is how it gets to find out
anyway. Every setup run is frozen with the `ryph-environment` skill, the reference for every file on
this page; its instruction tells the agent to read it first, leaves the formats to it, and says to
stop when the skill did not load ([skills](../../orchestrator/docs/skills.md)).

The first two are read from the checkout, by the runner, and are what this page is about.
The third is read before the run's container exists and is the control plane's;
see [the trust rule](../../forge/docs/threat-model.md) on why that split exists.

Everything here happens in the `setting-up` phase, after the clone and the runner's own
preparation (signing, the memory brief) and immediately before the agent runs
([the run pipeline](architecture.md#-the-run-pipeline)).
The discovery and execution live in `src/helpers/environment.ts`.

## 📜 setup.yml

A single `steps` list; each step has a required `run` and an optional `name`:

```yaml
steps:
  - name: start services
    run: docker compose up -d db redis

  - name: install dependencies
    run: npm ci

  - name: prepare database
    run: |
      cp .env.example .env
      npm run db:migrate

  - run: npm run build # name is optional
```

`run` is the only verb — anything CI systems express with reusable actions
is just a command here, which keeps the runner a dumb executor
and leaves the environment vocabulary to the shell.
`setup.yaml` is accepted too; `setup.yml` wins when both spellings exist.

**One exception, and it is the exception that proves the rule.** This page used to say the same
about service blocks, on the grounds that anything CI expresses that way is just a command. That
held while every environment was reachable from a shell. It does not hold for an environment the
shell has no privilege to create: the stock agent images ship no container runtime, so the first
example above — `docker compose up -d db redis` — fails on every one of them, and on Kubernetes a
Docker daemon inside a gVisor pod is not a thing at all. A repo's databases are declared in
[`services.yml`](../../orchestrator/docs/service-containers.md) and started by the platform
before this container exists. The runner is still a dumb executor; it just no longer pretends the
shell can conjure a Postgres.

### How steps run

- Each step runs via `bash -c` in the checkout root, top to bottom.
- Every step is a fresh shell: shell state (variables, `cd`) does not carry across steps,
  same as CI. A step that needs env vars sets them inline (`FOO=bar cmd`)
  or uses a multi-line script as above.
- `name` is narration only: it labels the step in progress messages and error reports;
  the command itself stands in when it is absent.
- The first non-zero exit stops that repo's sequence — later steps usually build on earlier
  ones, like CI — and **the run goes on**: setup is an optimization, and an agent on a
  half-prepared machine can finish the job, where a run that never started does nothing.
  Other repos' setup still runs. The failure is a warning in two places: the run's history
  gets one `setup.failed` event per repo and kind (the step's label, exit code and output tail, cleaned of
  terminal escapes and credentials), shown on the run page; and the agent's machine block says
  which step failed, what was skipped and that it may need to finish setting up itself, with the
  output tail fenced as quoted text. The runner waits for that report (within its request
  timeout) before going on, so the warning lands before anything else the run reports.
- What a failed step changed in its repo's checkout is **discarded** before the run goes on.
  Before any setup runs, the runner takes a **snapshot** of each checkout (`checkoutStart`,
  helpers/checkout.ts): its base commit and branch, the replace refs it already holds, where git
  finds it (work tree, git dir, common git dir, as real paths), and every gitlink the base (or the
  index) records — a submodule `.gitmodules` names or a bare nested repository it does not — with
  the commit recorded for it and whether it was checked out (a `.git` in its directory — never, in
  a clone the runner makes, since it does not initialise submodules; a baked image's setup may
  have). Only a gitlink with no checkout at the snapshot counts as one a step brought in. Putting a tree back (`putBack`) restores one
  invariant against that snapshot, with local git alone — no fetch, lazy fetches included
  (`GIT_NO_LAZY_FETCH`), and nothing outside the checkout's own repositories. Of the commands the
  checkout's config can name, hooks and `core.fsmonitor` are off for every git call, and the
  checkouts and resets that rewrite the tree pass `--no-recurse-submodules` (fetches keep the
  checkout's `fetch.recurseSubmodules`, as on main). Filter drivers are never overridden: every
  put-back git command is plain and runs the drivers the config names, as main does, so the
  content it writes and the status that checks it agree with that config. Which config that is
  depends on whether any step failed. The snapshot also records, for the checkout and each checked-out
  submodule, what decides its drivers (`DriverStart`, read with `git config`, which runs
  nothing): the `filter.*`, `include.*`, `includeIf.*`, `core.attributesFile` and
  `extensions.worktreeConfig` keys of its config file, the `filter.*` config and attributes file
  git effectively reads, and its `.git/info/attributes` (its bytes up to 1 MiB; a larger one only
  by hash).
  - **A step failed, in this repo or any other** (`putBack(…, { failed: true })`): before any git command that
    could run a driver, its drivers go back to the snapshot key by key — keys a step added
    removed, keys it changed restored exactly (`git config --file <common dir>/config`, `-z`
    reads, `--add` writes), every key whose values did not change left where it is in the file (so
    an `[include]` keeps its place and precedence; a changed one comes back at the end, which can
    move it), a valueless key (`required` alone) kept as is unless a step changed it, then written
    as `true`, which git reads the same — `.git/info/attributes` restored or removed — in the checkout and in every submodule
    checked out at the snapshot. A repository a step checked out at a gitlink since (`git
    submodule update --init`) goes back to no drivers at all, as it had none; one whose git dir is
    not where git puts a submodule's is removed outright instead. Where anything changed, the
    index's own time is set back so git compares every file's content rather than trusting stat
    info a step's driver left (a plaintext `git-crypt unlock` checked out). If the drivers git
    reads still differ from the snapshot afterwards (a driver in a file an include pulls in), or
    an `info/attributes` known only by hash changed, put-back refuses and the run fails: no
    driver a failed step authored ever runs. Then the plain status, checkout, reset and clean run
    with exactly the drivers the repo started with (git-lfs, git-crypt, nbstripout as main
    has them), so a file stored through one comes back as a checkout of the start commit gives
    it, and a driver a step added and then failed under leaves no half-decrypted tree behind.
  - **Anything else** — no step failed, and a successful setup left the tree changed
    (`{ failed: false }`): the config stays as setup left it (a successful `git-crypt unlock`
    stays unlocked), and the tree is put back with it, as the dirty check reads it. Once a step
    failed in any repo, every repo is put back as above (`{ failed: true }`): the failed step may
    have written another repo's config, and what is left there cannot be told apart from its
    writes — so a sibling's successful `git-crypt unlock` goes back to locked with its tree.

  Turning drivers off instead would restore the wrong content: a reset with `clean` and `smudge`
  off writes the stored blob raw (an LFS pointer, git-crypt ciphertext) over any file whose stat
  info changed, which a status with them on reads as modified. A failed step's whole process
  group is ended (TERM, then KILL) before any of this, so nothing it left running in the
  background writes into the tree afterwards; a successful step keeps what it started:
  - git still finds the checkout's own repository there: a step that pointed it elsewhere
    (`core.worktree`, a `.git` file or link to another git dir, a `commondir`) makes the put-back
    refuse before it touches anything, so no checkout, reset or clean ever runs on another
    directory;
  - HEAD is the base commit, on the run's branch (or detached, as it started): an operation a step
    stopped half-way (a rebase, merge or cherry-pick) is abandoned, a stale `index.lock` or
    `HEAD.lock` a killed step left is removed (every step has finished by then), replace refs
    written since the snapshot and a grafts file are deleted — the runner's git ignores replace
    refs anyway, so one can never pass injected content off as the base commit — and the branch is
    checked out at the base, `reset --hard`, `clean -ffd` (nested repositories included, never
    `-x`; the untracked directories it removes are first made owner-writable, links never
    followed, so a read-only one a step left — `go mod download` into the checkout — goes too). A
    commit the step made, or a branch it switched to, never ships as the agent's work;
  - `git status` reads clean, with two listings: the repo's `ignore` settings honoured for what is
    inside a submodule (dirt `add -A` could not stage), and every gitlink whose commit moved
    counted whatever `ignore` says — `ignore = all` hides a moved submodule from status, yet
    `add -A` stages the bump;
  - a submodule status reports changed that was checked out at the snapshot is back on its
    recorded commit (`checkout -f --detach` inside it, its own submodules likewise, then
    `reset --hard` and `clean -ffd` while status still names it). One that was NOT checked out is
    not checked out again: its directory emptied (its `.git` included) and kept, and the clone git
    made for it in `.git/modules/<name>` removed when it did not exist at the snapshot — so a
    `git submodule update --init` that cloned a submodule but could not check its commit out
    (never pushed, a shallow remote, a flaky network) is setup's leftover like any other, never a
    reason to fail. A submodule a step checked out cleanly on its recorded commit reads unchanged
    and stays, and so does output a submodule's `ignore = untracked` (or `dirty`) hides. Never
    `git submodule update` (it clones over the network and runs a `submodule.<name>.update`
    command a step configured) and never a fetch.

  An `npm install` that rewrote the lockfile and then failed, or yarn's `yarn-error.log`, neither
  ships nor trips the clean-tree rule below. Ignored build output (`node_modules/`) may remain.
  The warning says the tree was discarded. The runner checks the invariant again after; a checkout
  that still departs fails the run, naming what is left: shipping it would be worse. **What
  remains fatal**, exactly: git no longer finding the checkout's own repository there (above); git
  refusing the restore (the run's branch checked out in another worktree, a ref lock other than
  `HEAD.lock` a killed step left); a tracked file in a directory a step made read-only, or an
  untracked one whose mode the runner cannot change (another owner's); a submodule that was checked out at the snapshot whose recorded commit its clone no
  longer holds, or whose directory a step pointed at another repository; a submodule path reached
  through a symbolic link; for a repo whose own step failed, filter drivers that do not come back
  to the snapshot (a step's driver in a file an include pulls in, an `info/attributes` larger than
  1 MiB that changed, a config file or `info/` a step replaced with a link); and, on a git older
  than 2.44 (which ignores `GIT_NO_LAZY_FETCH`), a
  checkout or checked-out submodule a step made a partial clone.
- A failing step can write into a **sibling** checkout too (`cd ../web && npm install`), and
  what it wrote there cannot be told apart from that repo's own setup. So once a step has failed
  in any repo, every other repo found changed after all the setup ran is put back the same way,
  and gets a warning of its own naming the repo whose setup failed ("changes left in `web/` after
  setup failed in `api/` were discarded"). The run page and the agent both read it under the
  changed repo. When every setup succeeded, a changed tree is put back too, with a `dirty`
  warning naming the files (below).
- A `setup.yml` that is not valid YAML or does not match the shape above is the same kind of
  warning: none of that repo's steps run, the run goes on, and the run page and the machine block
  say the file is invalid, with the validation error. Validation is strict — an unknown key is
  refused rather than skipped — so a typo warns rather than half-running the file. (An invalid
  `services.yml` or an oversized `environment.md` still fails the run.)
- A step that could not be started at all (no `bash`) fails the run as an `error` during
  `setting-up`: that is the machinery's, not the repo's.
- Step output streams to the runner's diagnostics (stderr), line by line;
  each step's start also rides a progress heartbeat, so it is visible upstream live.
- A cancellation kills the in-flight step, skips the rest,
  and reports `cancelled` as usual ([the cancellation flow](cancellation-flow.md)).

### What a step sees

Steps are repo-authored code and run in the same trust domain as the agent itself:
inside the run's container, in the cloned checkout, with the container's environment —
minus every `RYPH_*` variable, which carries the runner's own credentials
and is scrubbed from the step's env.

**Except one, which is set for the step rather than inherited: `RYPH_SETUP_PHASE`.** The same steps
run in two places. A run executes them in its own container, with `RYPH_SETUP_PHASE=run`. And when
the repo has an environment image, the platform has already executed them once at image build time —
in a clone baked into the image, by `ryph-bake`, the same executor compiled on its own — with
`RYPH_SETUP_PHASE=image`. The run then adopts that clone, fetches its own commit into it, and runs
the steps **again**, because the lockfile may have moved between the two commits. The variable
carries nothing secret, and it is always set: a step never has to guess which phase it is in.

That second pass is the one obligation environments put on a repo: **steps must be cheap when
nothing changed.** On a warm tree they should be near no-ops, and most tools already are:

| Cheap on a warm tree                                | Not — it throws the warm tree away              |
| --------------------------------------------------- | ----------------------------------------------- |
| `cargo build`, `cargo fetch`                        | `cargo clean && cargo build`                    |
| `npm install --prefer-offline`, `pnpm install`      | `npm ci` (deletes `node_modules/` by design)    |
| `uv sync`, `pip install -r requirements.txt`        | `rm -rf .venv && python -m venv .venv && …`     |
| `deno install --frozen`, `go mod download`          |                                                 |

`RYPH_SETUP_PHASE` is the escape hatch for the rare step that genuinely must differ — a warm-up
worth doing once at build time and never per run, say:

```yaml
steps:
  - name: install dependencies
    run: npm install --prefer-offline
  - name: warm the build cache (image builds only)
    run: '[ "$RYPH_SETUP_PHASE" = image ] && npm run build || true'
```

### Adopting the baked checkout

A run whose spec names a **baked** environment works in the image's `/ryph/work`, not a temp dir,
and for each repo that has a checkout there (`/ryph/work/<path>/.git`) it does not clone. It
adopts (`src/helpers/adopt.ts`, through the `GitTransport` port's `adopt`):

1. The tree must be clean. The bake left it clean, so anything else means it cannot be trusted.
2. Every remote is removed and `origin` is added back as the run's own URL, then the run's ref is
   fetched through the same transport a clone would use, with the same credential.
3. `git checkout` moves the tree to it **in place**: git rewrites only the files that differ
   between the built commit and the run's, so every other file keeps its mtime and an
   incremental build stays incremental. Nothing is cleaned; the gitignored outputs are the point.
4. Every ref but the run's is deleted and the reflogs expired, so the agent sees one branch, as it
   would after a clone.

Any failure along the way is not the run's failure. The runner says so — a `cloning` progress
message and an `environment.adopt_failed` event in the run's trace — empties the directory, and
clones fresh into it. A repo the image has no checkout for (a workspace member added since the
build) is cloned as usual, and anything under `/ryph/work` that is not one of the run's repos is
removed first. The run then carries on exactly as any other: signing, the brief, and the setup
steps again with `RYPH_SETUP_PHASE=run`.

The agent is told which machine it is on, in a block the platform puts ahead of every repo's
`environment.md`: the image, when and from which branch it was built, the commit each repo was
built from and the one it starts at, and which checkouts are warm and which were cloned cold. The
same block carries the toolchain versions this bake recorded — off the run's spec, where the
control plane validated them, not off the image's own copy, which the run user could rewrite —
and a `PATH` probe of the everyday tools, taken on the box itself
([the machine block](harnesses.md#-the-machine-block), `src/helpers/machine.ts`).

### ryph-bake

The image-time half is `src/bake.ts`, compiled on its own as `ryph-bake`:

```
ryph-bake --phase image /ryph/work [--toolchains-out /opt/ryph-env/toolchains.json]
```

It bakes every checkout under the root, in the order the builder wrote to `/ryph/work/.order` (one
path per line), else sorted by name, runs each one's `setup.yml` in its own directory, checks every
tree clean once all of them have run, and records the toolchains it finds on `PATH` (`rustc`,
`cargo`, `node`, `deno`, `bun`, `python3`, `go`, `uv`) as JSON. It must run as the uid that owns
the checkouts (1994): a bake as root would leave build outputs the run cannot write, so it refuses.
Failures exit 1 with one line naming the repo; bad usage exits 2.

In the image phase, before any repo's steps run, it pins every file git tracks to whole seconds
(`pinTrackedMtimes`). Image layers keep whole-second mtimes. Cargo fingerprints a package by its
newest file's mtime to the nanosecond, so a crate built against `…785.912001772s` read
`…785.000000000s` at run time and rebuilt on every run. Pinned first, the build and the run read the
same times. Pinning makes ties: cargo records a package's newest file by name as well as time, and
picks among tied files by directory order, which differs between the build and the run. So where a
package has its newest second shared by more than one of its files (the package's directory, less
any nested package's), one file cargo always lists is moved a second past the rest: its
`Cargo.toml`, or, when that is also the workspace's manifest (which clippy names in every crate's
dep-info), its tracked `Cargo.lock`, else whichever of its build script, `src/lib.rs` or `src/main.rs` is
tied already (moving a source forward would recompile it in the bake).
A workspace's manifest never moves. A build script's fingerprint and rustdoc's both name the newest
file. Only files whose
mtime has a fraction are set, which GNU `stat` tells (a Date holds milliseconds); without GNU `stat`
every tracked file is set. Setting a file from a lower image layer copies it whole into the bake's.
Repos do not need a step of their own for this.

- Each time is rounded down, not set to the commit time. On a warm build the files the new commit
  changed were just written, after every output in the tree, and a commit can be dated before the
  last build. Its commit time would hide the change from cargo. Rounded down, it stays ahead.
- Files are listed with `git ls-files -z`. Only regular files are set. Symlinks are skipped, never
  followed. Submodules are not recursed into; the builder does not check them out. Untracked and
  ignored files, and directories, keep their times.
- The index is refreshed after, and contents do not change, so the tree stays clean.
- Never in the run phase: there a fraction of a second marks a file the run's own checkout
  rewrote. The runner's run-phase setup does not share this code.

The build log carries one line per repo: how many tracked files were pinned, and how many had a
fraction to lose.

Everything else on this page holds in both phases — the parser, `bash -c`, the clean-tree rule,
what a failing step or an invalid `setup.yml` means — because it is the same code. At build time a
failing step skips the rest of that repo's steps and puts its checkout back (and, as above, any
other checkout found changed after it), an invalid
file runs none, and the build **finishes anyway**: the image is `ready`, and `ryph-bake` writes the
warnings to `/opt/ryph-env/setup-warnings.json` beside the toolchain record. The builder reads
them onto the build's row, the repo's Environment card and the build's page show "Setup didn't
finish", and the build-result message a setup task reads says setup.yml did NOT finish, with each
step's output. Runs on that image rerun setup and warn again the way any run does. A tree a
setup that SUCCEEDED left changed is put back with a `dirty` warning, as at run time. A tree that
cannot be put back, a bad base, or a failing Dockerfile still fails the build.

**Plus the way out, which the agent gets too.** Where the deployment confines egress, a setup step's
env carries `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` pointing at the egress proxy, with the run's
signed allowlist as the proxy credential — so `npm ci` reaches the registries the operator vouched
for and nothing else. The harness spawns through the same helper and gets the same four variables.

`NO_PROXY` is the other half of that, and it is not a detail: it carries the platform's own
addresses, so the run's control plane, its history endpoint, its git origin, the model proxy, the
MCP gateway and the run's declared service containers are all dialled DIRECTLY. The egress proxy
refuses an in-network address by design, so a platform address missing from that list reads to a
client as a dead tunnel — a run whose dependencies install perfectly and then dies at its first
tool call with `fetch failed`. The helper sees the brand-scoped URLs on its own; everything else
is named by the caller, because the addresses arrive in the run's credentials and only the
adapter that writes pi's config knows which ones it wrote.

There was once an asymmetry here — setup steps got the credential, the harness did not — and it
is gone, because the premise was wrong twice over. Agents are asked to upgrade dependencies and
add them, which resolves a registry in the agent phase; and PID 1 (the image's tini), the runner
and the harness all run under the same uid with the same env, so `/proc/1/environ` serves the
claim to anything that goes looking whatever the runner deletes from its own heap copy. What bounds a claim is its expiry,
and the allowlist means the same thing in both phases. A deployment that wants an agent with no
internet vouches for no bundles, which is an answer that does not depend on a clock.

Two rules, both familiar from CI:

- **Leave the tree clean.** Finalize commits whatever the tree holds as the agent's work,
  so setup must not add to it: after the last step, any modified or untracked file that is not
  gitignored (an `npm install` rewriting `package-lock.json`, `cargo` updating `Cargo.lock`,
  codegen into a tracked file), and a commit or branch switch, is put back to the checkout's start
  — ignored files kept — with a `dirty` warning naming the files, and the run (or the build) goes
  on without them. Once a step failed somewhere, a changed tree cannot be pinned on one repo's
  setup, and its warning names the failed repo instead (above). Only a tree that cannot be put
  back fails the run, naming what is left. Setup artifacts (`.env` files, installed deps, build
  output, markers) belong in `.gitignore`, and lockfiles want the tool's locked flag: a discarded
  file is gone for the agent too.
- **Don't expect a teardown.** One container is one run: whatever a step starts
  dies with the container, and no teardown hook exists.

The stock [agent images](../../../images/README.md) deliberately ship no container runtime,
so a step like `docker compose up` fails on them. The answer is
[`.ryph/services.yml`](../../orchestrator/docs/service-containers.md), where the repo declares
what it needs and the platform starts it — reachable from a step by name, `db:5433`, never on
`localhost`. (A deployment can still bake its own agent image with a runtime inside; the images
README carries that posture and its why.) The runner's contract does not change either way:
steps run with whatever the image provides, against whatever the platform started.

## 📖 environment.md

Injected into the agent's system prompt, framed as the working environment the repositories
configured and whose setup steps ran before the agent started — after the machine block, which
says first if any of those steps failed.
Write it for the agent, in plain prose: what services are running and where,
what tooling is installed, how to run the tests, anything it would otherwise
have to discover by trial and error.

When the run has service containers, a machine-generated list of them — names, addresses,
images — is prepended **ahead of this file and cannot be removed**. So is the block describing the
machine the run is on, when the control plane resolved an environment for it (see
[adopting the baked checkout](#adopting-the-baked-checkout)). `environment.md` is read from
the checkout while services are resolved before the run exists, so the two can disagree; the
repo may describe its services, it may not replace the true list.

The file is trimmed and capped at 32 KiB — it rides the agent's system prompt,
and on some harnesses a single command-line argument, so it must stay small;
an oversized file fails the run, and a blank one is treated as absent.
