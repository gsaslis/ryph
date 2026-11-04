# Environment builders

How the control plane turns a repo's `.ryph/` into an **environment image**: the machine the repo
asked for, the checkout baked in with its `setup.yml` already run, and the harness layer on top. The
core decides when to build and from which commits; a builder, behind the `EnvironmentBuilder` port
(`src/ports/environment_builder.ts`), decides how. The code is in
`src/adapters/environment_builder/`.

## What every builder builds

Up to four builds, whatever the backend:

1. **The machine**, when the repo has a `.ryph/Dockerfile`. That file, built with the repo checkout
   as its context, so `COPY rust-toolchain.toml` works and `.ryph/Dockerfile.dockerignore` is
   honoured by BuildKit itself. `FROM quay.io/ryph/ryph-universal` (bare, `:latest` or `:1`) is
   redirected to the deployment's pinned copy, `RYPH_ENV_BASE_IMAGE`.
2. **The environment**: a generated outer Dockerfile (`dockerfile.ts`) on top of the machine, or of
   the universal image when the repo declares none. It copies the clones into `/ryph/work`, runs
   `ryph-bake --phase image` as uid 1994 (the `baked` stage), then, in a stage of its own, copies
   the harness layer on last and sets the user and the entrypoint. The file is the same bytes for
   every build; its inputs are the build arguments `RYPH_MACHINE` and `RYPH_HARNESS` and the named
   context `checkout`.
3. **The baked stage**, the same file's `baked` target, kept as an image of its own (all cache
   hits): the environment without its harness layer, recorded on the row as `bakedImage`.
4. **The toolchain record**: the `toolchains` target of the same file, exported to a directory.
   Every stage is a cache hit by then. It carries `ryph-bake`'s setup warnings beside the record
   (`setup-warnings.json`, optional: an image baked before it existed has none).

**A setup.yml that does not finish does not fail the build.** Setup is an optimization, and a run
reruns it anyway. A failing step skips the rest of that repo's steps and discards what it changed in
the tree, an invalid file runs none, and `ryph-bake` finishes the image and writes the warnings.
Every builder reads them back with the toolchain record: docker from the exported directory,
kubernetes and Cloud Build from the script's last `@@ryph-result setup-warnings` line (last because
Cloud Build keeps only 4 KiB of a step's output; `ryph-bake` bounds the file and each toolchain
version to fit). A record that is there but cannot be read (cut short, not JSON) is one `unreadable`
warning, never a clean bill. The core cleans them (`src/core/setup_warnings.ts`), keeps only those
naming one of the build's own checkouts, and settles the build **`ready`** with
`Environment.setupWarnings`, so a repo with a `.ryph/Dockerfile` gets its runs started rather than
refused. The repo's Environment card, the build's page, the builds list and the task page's patch
build show "Setup didn't finish", and the result message tells the agent setup.yml did NOT finish,
fenced. A re-layer reads the same file out of the image it re-layers, so it keeps its source's
warnings.

A setup that finished but left changes in a tree (a rewritten lockfile, codegen into a tracked file,
untracked output that is not gitignored, a commit) does not fail the build either: `ryph-bake` puts
that checkout back to the commit it started from, ignored files kept, and records a `dirty` warning
naming the files. Its setup did finish, so a `dirty` warning alone is not "setup didn't finish"
(`setupUnfinished`): it changes no image choice below. Gitignoring the output, or installing with
the tool's locked flag, is the fix the result message advises.

Such an image is ready but answers only for the commit it was built at, as a failed build does: a
step can fail on a lockfile or a script outside `.ryph/`, so a new commit may be built again rather
than told the same warning. For a patch's build (`core/environment_feedback.ts`) that is every push:
as a failed patch build did, one whose step failed, whose setup.yml was invalid or whose tree setup
left dirty answers only for its own commit, so each new commit of the patch is built again, and the
run hears what setup.yml does now (an `unreadable` record alone does not do this; a `discarded`
never comes alone). For pushes and branch runs it is once per warning episode (`warningRebuildDue`):
a branch run on a newer commit (built behind the run, which launches on the image: it reruns
setup.yml itself) and a default branch's next push without waiting for `RYPH_ENV_REBUILD_INTERVAL`
(`refreshSubject`). An episode ends at a clean build: a warned build earns the early build only when
the completed build before it, of the same definition, was clean (or there is none). A step that
fails at every build — one that needs a service, a secret or a host only a run has — therefore costs
a push or branch build one early build, and then the default branch waits out the interval and a
branch waits for a `.ryph/` change, rather than building on every push. A build whose setup.yml step
failed or whose file was invalid is never a warm source (`warmSource`): a put-back keeps the ignored
files its step may have failed on, and a tree warmed from it would carry them on. A warm build
starts from the newest ready image whose setup did not break instead, and with none left — a repo
whose step fails at every build — builds are cold. A check pod does not rerun `.ryph/setup.yml`, so
checks take a clean image of the same definition over a newer warned one (`newestForChecks`; a clean
image of an older definition is not the machine the repo describes now, so the newest is taken and
the check feedback says setup did not finish), and retention keeps that clean one ready until a
clean build of its branch settles after it (`retainedOfGroup`, docs/checks.md). What still fails a
build: the Dockerfile, the base checks, a tree setup left that cannot be put back, and a step that
could not run. Putting a tree back restores the snapshot `ryph-bake` took before any step ran
(packages/runner/docs/environment-setup.md lists exactly what cannot be): base commit and branch, a
clean status, submodules checked out then on their recorded commits and the rest not checked out — a
`git submodule update --init` that cloned a submodule but could not check its commit out is undone,
not fatal. A check suite run on a clean image taken over a newer warned one says so in its note and
forge report, with the image's build time (`olderImageSentence`).

Three and four are not worth folding into two: measured, each costs a second against a builder that
still has its layers (see "What `native` costs"), and they cannot share a solve in any case — each
is a different target, and an exporter exports one result.

A **re-layer** — a ready environment moved onto a new harness after a deploy — is none of that. It
builds a second constant file (`relayerDockerfile`), `FROM` the environment's baked image
(`RYPH_BAKED`) with the harness layer, the full check and the probe on top, and nothing else: no
clone, no bake, no cache. So it costs a pull of the baked image and a copy, never a warm build, and
it does not need the commit it was built from to still be on its branch (a force-push or a rebased
patch would otherwise fail every re-layer of it). A re-layer that fails is not asked for again on
the same harness; the core builds where the branch stands now instead.

An **incremental build** is the third shape, and the common one: a rebuild of the same machine at a
newer commit. The core picks it at queue time (`warmSource` in `src/core/environments.ts`) when a
ready image of the same machine, base image and checkout layout exists, and the builder builds a
third constant file (`warmDockerfile`) `FROM` that image's baked stage (`RYPH_WARM`). Each checkout
is moved to the new commit in place, from a fresh clone that is bind-mounted into the step and never
copied into a layer: `git fetch` from the clone, `git update-index --refresh`, then
`git checkout --force`. Git rewrites only the files that differ and deletes the ones the commit
dropped, so every untouched file keeps its mtime and every ignored one (`target/`, `node_modules/`)
survives. `ryph-bake` then reruns `setup.yml` on the warm tree, which is the same incremental rerun
a run does at start, and the harness goes on last as always. No machine build, no layer cache. The
refresh matters: measured with docker 29.4 and git 2.45, without it the index's stat data no longer
matches the files in the new layer, and the checkout rewrites every file, which moves every mtime
and makes cargo recompile the workspace.

Layers keep mtimes in whole seconds, so in both shapes `ryph-bake` rounds every tracked file's mtime
down to the second before any setup step runs. Without it, cargo fingerprints the fractions it sees
at build time and rebuilds at every run. Where a package's newest second is tied, one file cargo
always lists (its `Cargo.toml`, or for a workspace's root its `Cargo.lock`, or a tied build script
or `src/lib.rs`/`src/main.rs`) is then moved one second past the rest, so cargo's newest-file
fingerprint does not depend on directory order. On a warm build this only sets the files the
checkout just rewrote (GNU `stat` tells which have a fraction); the rest already came out of a layer
in whole seconds ([environment setup](../../runner/docs/environment-setup.md#ryph-bake)).

**The same machine** is the same definition (every member's `.ryph/` tree), or the same Dockerfile.
The forge answers the environment repo's `.ryph/Dockerfile` blob id beside the tree id, and the row
keeps it as `plan.machine` (`dockerfile:<blob id>`, or `universal` with no Dockerfile). So a
`setup.yml` or `environment.md` edit in any member builds now, and warm: setup reruns on the warm
tree, as it does at every run. A Dockerfile edit builds cold. A row queued before `plan.machine`
existed has none, and only the same definition starts warm from it.

When an incremental build is not used, and the build is cold instead:

- the machine (the definition and the Dockerfile both), the base image, the Dockerfile's owner or
  the checkouts (path and repo) changed
- the source is not trusted for this build. A default-branch build starts only from a default-branch
  image. A branch build starts from its own branch's last image, or the default branch's, never
  another branch's. This is the same rule the layer cache follows
- every candidate's chain is `RYPH_ENV_WARM_CHAIN` long (default 4). A branch's own image at the cap
  gives way to the default branch's, which may be shallower
- a warm build of this branch failed since the source was built. The warm tree may be the problem,
  so a cold build proves or disproves it, and warm builds resume after it succeeds
- every candidate's setup broke: a build whose step failed or whose file was invalid is never a
  source, so a repo whose step fails at bake every time builds cold every time
- the ask is a forced Rebuild
- the build is a patch's (trigger `patch`, `core/environment_feedback.ts`). It exists to prove the
  patch's definition, so it starts from the bare machine, not from an image that still holds what
  the old `setup.yml` left

**Leftovers of removed setup steps.** A warm build reruns `setup.yml` on the source's image, and
nothing removes what an earlier step wrote outside the checkout. A step dropped from `setup.yml`
(say a `cargo install foo`, or files under `$HOME` or `/opt`) leaves its output in every warm image
after it, until the next cold build: when the chain reaches `RYPH_ENV_WARM_CHAIN`, or on a manual
Rebuild. Default-branch rebuilds stay warm and so can carry such leftovers for a few builds; a
patch's build is cold, so a `setup.yml` that only works on them does not finish there, and the
patch's build result warns about it (setup never fails a build).

**The machine is checked, not assumed.** The Dockerfile's blob id names the Dockerfile, but the
machine's build context is the whole repo, so a Dockerfile that `COPY`s `rust-toolchain.toml` (or
`.ryph/setup.yml`) changes machine when that file does, and the id says nothing. So every build
records the digest of the machine it was built on in the image (`/usr/local/lib/ryph/machine`,
root's, out of setup's reach). An unchanged machine built again is all cache hits, which keep their
layers and their timestamps, so it is the same image, digest and all (measured, buildx 0.33; no
`SOURCE_DATE_EPOCH`, which would reach the repo's own `RUN` steps). A warm build builds the machine
first and reads the record out of the image it would start from (the warm file's `machine-record`
target). They differ, or the record cannot be read (an image older than it, or a failed read, which
the log says apart from a changed machine): the build is cold, in the same pass, and says so
(`warm: false` on the result, and the core records the row as a cold one). MEASURED with the docker
builder (2026-09-29): a code-only change built warm, and a change to the file the Dockerfile copies
built cold with the new file in the image.

**Growth.** Each warm build is a layer on the last holding every file it changed, the checkout's and
whatever setup rebuilt, and a lower layer never shrinks. `RYPH_ENV_WARM_CHAIN` (default 4) bounds
that.

The plan records `warmFrom` (the source row and its baked image) and `depth` (warm builds since the
last cold one; a re-layer carries its source's). A warm build that failed is not retried cold at
once: the next commit or a Rebuild builds cold, and a run that waited on the failed build is refused
with its log, as for any failed build.

The clones are made **outside** the build, by a script (`cloneScript`, `sh/clone.sh`) that takes
what to clone as its arguments and runs with the build's git credential as env and nothing else. No
step of a build ever holds that credential. The script writes `/ryph/work/.order` in member order,
which is the order `ryph-bake` runs the repos in.

The base is checked twice, by the harness layer's own `check-base.sh`. Before the bake, with
`--base-only`: glibc, `/bin/bash` and `git` (new enough for `git checkout --end-of-options`), each
named when missing, plus a warning (not a refusal) when `rg` or `fd` is missing, since pi's `grep`
and `find` tools need them. After the harness is on, in full, followed by a probe that the runner
and pi both start. That probe is what stands in for an echo smoke run: running the echo harness for
real needs a work item and an orchestrator to report to, and a build has neither. A base without a
home for uid 1994 gets one (`/home/runner`).

## The backends

| `RYPH_ENV_BUILDER` | What it does                                                                          | Image a run launches            |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------- |
| `docker`           | `docker buildx build` against the host's daemon; the clone runs on the host           | the local image id (`sha256:…`) |
| `kubernetes`       | a Job in `ryph-builds`: an init container clones, rootless BuildKit builds and pushes | `<registry>/<subject>@sha256:…` |
| `cloud-build`      | a Cloud Build build in a private pool: a step clones, rootful BuildKit builds, pushes | `<registry>/<subject>@sha256:…` |
| `manual` (derived) | narrates the clone, the machine build and the outer file, then refuses                | —                               |

Unset, `RYPH_ENV_BUILDER` follows `RYPH_PROVISIONER`. `cloud-build` is only ever named.

The kubernetes and Cloud Build backends run the same script (`buildkit_script.ts`): the same passes,
the same push retry, the same `@@ryph-result` lines. What differs is how buildkitd starts (rootless
under rootlesskit, or as root) and how the result comes back.

### docker

It runs in the docker launcher ([@ryph/launcher](../../launcher/README.md)), the one process that
holds the docker socket: embedded in the `ryph` binary, or the `launcher` service of a compose
deployment. The control plane reaches it through the launcher's client (`adapters/launcher/`), and
the clone, the build contexts, the cache and the temp files are all on the launcher's side. A
standalone control plane never builds on docker itself; it has no docker CLI.

The `docker` buildx driver has two limits that shape this adapter, both measured on engine 29.4:

- It resolves `--build-context x=docker-image://…` against a registry, never the local store, and it
  refuses `oci-layout://` outright. A plain `FROM` does read the local store. So the universal
  image's public name is mapped by **tagging** `RYPH_ENV_BASE_IMAGE` locally as
  `quay.io/ryph/ryph-universal:1` and `:latest` (pulled first when it is not local), and the outer
  file names its inputs by build argument. Every build on the daemon reads those names, so only the
  binary's embedded launcher, the daemon's one tenant, builds this way. A standalone launcher
  without `RYPH_DOCKER_RUN_NETWORK` refuses every build, says so in `/v1/info` (`buildsRefused`),
  and a caller with builds on refuses to boot against it. Confined builds hand the universal image
  over as a named context and tag nothing public.
- A local image is only taken for a `FROM` of the build's own platform; otherwise the daemon goes to
  the registry for it. `RYPH_ENV_BUILD_PLATFORM` sets `--platform` for when the images are another
  architecture than the machine (amd64 images on Apple silicon).

The clone runs in the launcher, not in a container, so it cannot always dial the gateway at
`RYPH_GIT_GATEWAY_URL`, which is the address as a run sees it (`host.docker.internal`, a run gate's
name). It dials `RYPH_FORGE_URL` instead, the same server as the control plane sees it, unless
`RYPH_ENV_GIT_GATEWAY_URL` names another. The binary with its launcher embedded uses its in-process
forge on loopback; a launcher in another container cannot reach that loopback, so the compose
deployments name the forge as the launcher dials it (`http://ryph:7412`, `http://forge:7412`).

Cache scopes are real only with the containerd image store, where each scope is a directory under
`RYPH_ENV_CACHE_DIR` and a branch build writes none. The classic store cannot export a BuildKit
cache at all, so there every build shares the daemon's own cache, branch and default alike. That is
accepted on a laptop, where every build is the operator's own, and said once in the log.

Each export is a version directory of its own, and a `current` file names the one to read:
BuildKit's local exporter only ever adds blobs to the directory it writes, so exporting over the
last export kept every layer any earlier build had written. A new version starts as hard links to
the current one's blobs, so the export writes only what is new, and keeps only the blobs its index
reaches once it is done. A replaced version is deleted once it has been retired for longer than a
build may run: an import reads blobs for as long as its build runs, and a build whose cache vanished
under it fails. Every build that uses the cache (not a re-layer) prunes every scope's stale versions
before it starts.

The clone gets none of the host's git configuration (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`) and no LFS smudge, so nothing configured there runs
over repo content.

**Confined deployments.** When runs are confined (`RYPH_DOCKER_RUN_NETWORK`), so is every build: the
`docker` driver's RUN steps take the daemon's default bridge — the internet, the LAN and, on Docker
Desktop, the host's loopback — and cannot be put on another network. Each build instead gets a
`docker-container` builder of its own (`ryph-build-<deployment digest>-<environment>`, image
`RYPH_ENV_BUILDKIT_IMAGE`, default the rootful `moby/buildkit:v0.32.2`) on an internal network of
its own (the same name) with the run gate attached, both removed when the build ends. The
deployment's digest is in the name because buildx labels nothing and starts any existing BuildKit
container of the name, state volume and all: an environment id alone could name another
deployment's. Its RUN steps share its network namespace: no route out, no host, only the run gate,
and through it the egress proxy on the build's claim, which BuildKit uses for its own pulls too. Not
the run network: a RUN step is root with BuildKit's default capabilities, raw sockets included,
which every run has dropped, so it is kept off the network the runs share. Measured on Docker
Desktop (engine 29.8): from a step, `host.docker.internal`, the bridge gateway, the Desktop host
address and a direct `https://example.com` all fail; the same fetch through the proxy succeeds. What
it costs:

- RUN steps resolve nothing (BuildKit hands them public resolvers the internal network cannot
  reach), so the proxy is handed to them at the gate's address on the build's network, not its name.
- The builder cannot read the daemon's store, so every image a pass starts from (base, harness,
  warm, baked) is exported with `docker image save` into an OCI layout and handed over as a named
  context, and the machine is written out as one. The exports run side by side. Results come back
  with `--load`. No pass adds an attestation (`--provenance=false`), which would change the
  machine's layout digest on every build and make every build cold.
- Every pass dials the gate at the address it had on the build's network when the build began. A run
  launch that has to replace the gate mid-build (a change that cannot wait for live containers) may
  give it another, and the build then fails saying so. The build's BuildKit counts as live behind
  the gate, so a change that can wait does.
- The cache is always the scoped, versioned directories under `RYPH_ENV_CACHE_DIR`, whatever the
  image store, so a branch build writes none and nothing reads the daemon's shared cache.

The image a re-layer or warm build starts from (`ryph-env/…`) is never pulled, confined or not: the
name is this store's own, and a pull would ask Docker Hub for it. A re-layer whose baked image is
gone fails; a warm build whose image is gone builds cold.

Unconfined, a build is handed `host.docker.internal:host-gateway` only when its proxy is served
there. A docker deployment whose runs have a sandboxed runtime (`RYPH_DOCKER_RUNTIME`, e.g.
`runsc`), confined or not, refuses branch builds: a build runs under runc (confined, in a privileged
BuildKit container), never in that sandbox, and a branch's `.ryph/` is code an agent wrote.
Re-layers of a branch environment are refused too: the harness layer runs a check inside the baked
image, with that image's own shell. Which branch a build is of is its caller's word, beside the
clone URLs and commit it also names, so the docker launcher takes it only where it trusts the
caller: the binary's embedded launcher always (its caller is its own process), a standalone one only
with `RYPH_ENV_TRUST_DEFAULT_BRANCH=on`. Otherwise a standalone launcher under a sandboxed runtime
refuses every build, since a compromised control plane could call any repository's branch the
default one and RUN it under runc; it says so in `/v1/info`, and a caller with builds on refuses to
boot against it.

Environment images are tagged `ryph-env/<deployment>/<subject>:<environment id>`, and their baked
stages `ryph-env/<deployment>/<subject>:baked-<environment id>` (what a re-layer builds `FROM` and a
check runs in), which keeps both out of `docker image prune`. `<deployment>` is the first 12 hex
digits of the SHA-256 of the deployment's docker network (`default` when unset), so deployments
sharing a daemon never share a tag: a launcher refuses to run, re-layer or remove an environment
image outside its own prefix, and treats an image id that carries none of its tags the same way. The
machine's temporary tag is removed when the build ends; a build that fails untags what it had
tagged, and so does the next control plane for a build that died with its process (`adopt`).

Once retention retires a row, the core removes its images (`removeImages`) after a 30-minute grace,
holding any a live run, an unsettled check suite or a build in flight still uses, and what a failed
build left once it can no longer be running (twice the build timeout from its start). A baked image
a re-layer shares goes with the last row naming it. Docker refuses to remove an image a container
uses, which leaves it for a later pass. What decides a launch is whether docker has the image, never
the bookkeeping. A check suite whose image turns out gone at launch (removed by retention, or by an
`image prune -a`) retires its build if that was still ready, so the next ask builds again. The suite
then waits for its base's environment again, or, keyed on the image itself, ends asking for checks
again; a re-run of one whose image is gone reads the base again instead. The docker check launcher
never pulls a `ryph-env/` name (`--pull never` on every container): those exist in this daemon's
store or nowhere. A run launch reads the same evidence (docker's `No such image` naming the run's
image id, `ImageGone`): the build is retired the same way, and the run's environment is resolved
again by the same rules a start uses (`resolveEnvironment`), for the branch as it is now. It waits
for the build that names (one already going, or one it queues), launches on what it names (with the
builder down, the newest ready default-branch image on the current harness or the default image,
saying so as `environment.fallback`), or is refused with its reason (`environment.image_missing` in
its events). Once only: a run whose next image is gone too errors. A cancel that landed during the
failed launch is kept: the run ends cancelled. Kubernetes pulls in the pod and never says this at
launch.

Measured locally (OrbStack, amd64 images under emulation on Apple silicon): a fixture repo with a
`.ryph/Dockerfile` `FROM` the universal image that installs one apt package and a one-step
`setup.yml` built end to end in **19 s**, and **10 s** again for the same commit with the layer
cache warm. A `debian:trixie-slim` machine with git built in 37 s, and `debian:bookworm-slim` is
refused as having a git too old for the runner.

### kubernetes

One `batch/v1` Job per build in `RYPH_ENV_BUILD_NAMESPACE` (`ryph-builds`), created suspended, its
Secret (the git credential and the egress claim) written owned by it, then released, as the run
provisioner does. The pod:

- **init container `clone`**, on `RYPH_ENV_BASE_IMAGE` (it has git and bash), writes the outer
  Dockerfile and clones every checkout onto a shared volume.
- **container `buildkit`**, `moby/buildkit:*-rootless`, with `--oci-worker-no-process-sandbox`,
  seccomp and AppArmor unconfined (upstream's rootless shape). Its script starts **one** buildkitd —
  `rootlesskit buildkitd $BUILDKITD_FLAGS`, waited on with `buildctl debug workers`, shut down by a
  trap that prints the daemon's own log when the build failed — and runs every pass against it. It
  builds and pushes the machine, then the environment and its baked stage, then exports the
  toolchain record, and prints each digest from `buildctl --metadata-file` on a line of its own,
  `@@ryph-result digest …`, `baked …`, `machine …`, `warm …`, `toolchains …` and `setup-warnings …`,
  every one exactly once (`none` where it has none, `[]` for no warnings; a key missing, from a
  build an older control plane started, reads as `none` too — except `setup-warnings`, which is
  printed last and so is the line a cut result loses first: missing or cut short, it reads as an
  `unreadable` warning, never as setup.yml having finished). BuildKit's plain progress prefixes
  everything a build step prints with `#<n> <seconds>`, so a step's output cannot print such a line.
  A step that reaches further can: with no process sandbox it shares the script's user, and could
  write to the pod's log through `/proc` or into `/work/out`. A key seen twice fails the build, so
  it cannot simply add a line; what it could still do is change what its own build reports, which is
  why retention never takes a recorded digest to be its row's alone ("What retention removes from a
  registry").
- **the pod's runtime class is the build's boundary**: `RYPH_ENV_BUILD_RUNTIME_CLASS`, else the
  runs' `RYPH_K8S_RUNTIME_CLASS`. Unconfined seccomp and AppArmor and no process sandbox leave a
  `RUN` step of a branch's Dockerfile, which an agent can write, with the full syscall surface of
  whatever kernel the pod runs on; without a sandboxing runtime that is the node's, and a kernel bug
  is root on the node and every run's Secret on it. So the builder refuses to boot, and to write a
  Job, without one, unless `RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on` (a laptop cluster's kind or k3d,
  which have no gVisor). The Helm chart refuses to render the same unless
  `environments.allowUnsandboxed`.
- **buildkitd's garbage collector is sized to the work volume**, `--oci-worker-gc-keepstorage` at 80
  % of it reserved and 90 % maximum (whole megabytes: `40GB` does not parse, MEASURED). Left to
  itself buildkitd derives that policy from the filesystem its state sits on, which is this volume —
  on a 50Gi one, `reserved 6GB, minimum free 11GB, maximum used 41GB` — so it starts throwing the
  build's own layers away once the volume is 39GB full. Under `native` a layer thrown away is
  extracted again in full, which is what turned a GKE build into a build that had not finished in 56
  minutes. The volume belongs to one build and is deleted with it, so nothing on it is worth
  collecting; the only reason to collect at all is to not hit ENOSPC. A build with no work volume of
  its own (`emptyDir`) keeps buildkitd's defaults: that disk is the node's.
- **Two identities.** A default-branch build runs as `RYPH_ENV_BUILD_SERVICE_ACCOUNT`
  (`ryph-builder`) and pushes to `RYPH_ENV_REGISTRY`; a branch build runs as
  `RYPH_ENV_BRANCH_BUILD_SERVICE_ACCOUNT` (`ryph-branch-builder`) and pushes to
  `RYPH_ENV_BRANCH_REGISTRY`. See below for why.
- The volume is `RYPH_ENV_BUILD_SIZE`'s `work-volume`, a generic ephemeral volume, because
  BuildKit's state for a warm Rust environment does not fit Autopilot's 10Gi ephemeral cap.
- BuildKit's own pulls and pushes go through the egress proxy like every build step, so the build's
  claim carries the deployment's ceiling plus the registry hosts of `RYPH_ENV_BASE_IMAGE`,
  `RYPH_HARNESS_IMAGE`, `RYPH_ENV_REGISTRY` and `RYPH_ENV_BRANCH_REGISTRY`. A `.ryph/Dockerfile`
  whose `FROM` lives anywhere else (Docker Hub, say) needs that registry in the ceiling
  (`RYPH_EGRESS_HOSTS`). A build step's own `NO_PROXY` is the spec's, without the metadata server
  buildkitd's credential helper dials.
- Layer caches live in `RYPH_ENV_REGISTRY`, one tag per scope and stage under `<registry>/cache`.
  Every read scope is imported; only the write scope is exported, and a branch build has none. An
  export a newer one replaced is deleted once no build can still be reading it
  ([below](#what-retention-removes-from-a-registry)).
- Every build, whatever its outcome, reads the pod's logs and container states — and leaves the Job
  standing. The control plane deletes it (`discard`) once the build's ROW is written, because until
  then the Job is the only record of the result: one deleted a heartbeat earlier is a successful
  build that the next control plane can find no trace of. The pod's work volume is a
  PersistentVolumeClaim the namespace's quota counts whether the pod runs or not, so a Job nobody
  discards holds one until its TTL. `activeDeadlineSeconds` (the timeout plus two minutes) and
  `ttlSecondsAfterFinished` (an hour) are the backstops for a control plane that died mid-build.
- Every API request is capped (a minute), so a connection that hangs fails the call instead of
  holding the build slot. The core has its own backstop too: an adapter that has not answered a
  minute past its abort is abandoned, and its build settled as failed.
- `RYPH_HARNESS_IMAGE` and `RYPH_ENV_BASE_IMAGE` must be pinned by digest (refused at boot
  otherwise): the core compares them to decide re-layers and base rebuilds, and a tag can move under
  both comparisons. Read the digests back from the registry when you set them.

On GKE the pod authenticates to Artifact Registry as its Workload Identity: a small credential
helper asks the metadata server for a fresh token on every pull and push
(`RYPH_ENV_REGISTRY_AUTH=gke-metadata`, the default for a `*.pkg.dev` registry).

The whole build script was run for real in rootless BuildKit (v0.32.2) in a local container, against
a local registry: machine, environment, push, digest and toolchain record in 29 s, and 11 s from a
fresh BuildKit state with the registry cache warm. It has **not** run in a Kubernetes pod, under
gVisor, on Autopilot, or against Artifact Registry.

#### What `native` costs, measured

The same script, four passes over a 1.9GB base image, in `moby/buildkit:v0.32.2-rootless` with
`--oci-worker-snapshotter=native` (OrbStack, arm64, a local registry, 2026-09-20):

|                              |                                                        |
| ---------------------------- | ------------------------------------------------------ |
| pass 1, the machine, cold    | 593–624 s, of which 485–548 s extracting eleven layers |
| pass 2, the environment      | 588–598 s, two layers (the harness) extracted          |
| pass 3, the baked stage      | **1 s**, five `CACHED` steps, nothing extracted        |
| pass 4, the toolchain record | **1 s**, eight `CACHED` steps, nothing extracted       |
| BuildKit state left behind   | **32.6 GB**, from a 1.9GB base                         |

Two things follow. A pass that finds its layers is free, so there is nothing to win by folding the
four into fewer — `environment` and `baked` are two images and `toolchains` is a third target, and
`buildctl`'s repeatable `--output` exports one solve's single result, so they cannot share a solve
anyway. And `native` amplifies: a native snapshot is a copy of the whole filesystem, not a diff, so
a build's state runs to many times its base image and the work volume has to be sized for that, not
for the image.

What is NOT measured: the re-extraction seen on GKE could not be reproduced end to end here. What
was reproduced is the mechanism — a daemon whose GC policy the state exceeds pruned a 34.95 GB state
to 4.34 GB within 90 s and logged nothing, and the same state under the policy above lost nothing —
and its price, a cold extraction being 500 s against 1 s. A daemon per pass, on its own, was
measured NOT to cause it: with a policy the build did not cross, `buildctl-daemonless.sh`
re-extracted no layer at all.

What the Helm chart provides (`environments.*` in its
[`values.yaml`](../../../deploy/helm/ryph/values.yaml)):

| Template               | What                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `namespaces.yaml`      | the builds namespace, Pod Security `privileged` enforced (rootlesskit needs unconfined seccomp and AppArmor)     |
| `builds.yaml`          | the `ryph-builder` and `ryph-branch-builder` service accounts (tokens never mounted), the Role, a ResourceQuota  |
| `networkpolicies.yaml` | builds reach DNS, the egress proxy and the forge's git gateway, nothing else; the proxy and the forge admit them |
| `control-plane.yaml`   | `RYPH_ENVIRONMENTS`, `RYPH_ENV_BUILDER`, both registries, the build namespace and runtime class                  |

What it cannot provide is the deployment's own: the two registries, an identity for each builder
service account (Workload Identity on GKE, through `environments.builderServiceAccount.annotations`
and `branchBuilderServiceAccount.annotations`), node pulls from both registries, and the harness and
universal images pinned by digest.

### cloud-build

One Cloud Build build per environment, in the private worker pool `RYPH_ENV_CLOUD_BUILD_POOL`, which
the deployment provisions. It exists because of what gVisor costs the kubernetes builder: only the
`native` snapshotter works there, and it copies a step's whole parent for every step (see "What
`native` costs" below). A Cloud Build step is root with every capability (measured 2026-09-29: uid
0, `CapEff 0000003fffffffff`), so buildkitd starts as itself, with overlayfs and a process sandbox,
on a VM that exists for this one build.

Three steps share a volume at `/work`:

1. `prepare`, on the BuildKit image, opens the volume to the next step's user (a step volume is
   created root-owned, and the universal image runs as `runner`) and writes the other two steps'
   scripts onto it. Cloud Build refuses a step argument over 10000 characters, and the build script
   of an incremental build is longer than that, so the scripts go in as chunks.
2. `clone`, on the universal image, writes the outer file and clones with the build's git key. The
   build step never holds that key.
3. `build`, on rootful BuildKit (`RYPH_ENV_BUILDKIT_IMAGE`, mirrored into the deployment's own
   registry, because the pool cannot reach Docker Hub), runs the shared script.

**Where the result comes from.** The script writes its result lines to the step's
`$BUILDER_OUTPUT/output`, and the adapter reads them from the build's `results.buildStepOutputs`.
Cloud Build records that output from a path in the step container that no `RUN` step can reach, and
nobody can change it afterwards. It never reads a result from the log. The log is an object in a
bucket, and a `RUN` step can get its build's token from the metadata server (measured: the metadata
server answers a step with the build's service account). So the log is for people only, and
default-branch and branch builds log to separate buckets (`RYPH_ENV_CLOUD_BUILD_LOGS`,
`RYPH_ENV_CLOUD_BUILD_BRANCH_LOGS`), each writable by its own identity alone.

**The network.** The pool has no public egress (measured: `https://example.com` times out from a
step). It is peered into the VPC. Each cell puts an internal load balancer in front of its egress
proxy and its forge's git gateway, open to the pool's range, and NetworkPolicies admit that range to
the two pods. `externalTrafficPolicy: Local` keeps the worker's address on the packet for those
policies to match. The control plane hands the build those addresses (`RYPH_ENV_EGRESS_PROXY_URL`,
`RYPH_ENV_GIT_GATEWAY_URL`), never cluster DNS names, and refuses to boot without them.

No public egress is not the same as no way out: a worker reaches Google's APIs directly (measured:
Artifact Registry answered a step), and so would anything on its network. buildkitd uses that on
purpose, for its own pulls and pushes. A build STEP must not: it could upload the tree to a bucket
of anyone's choosing, and fetch the build's token from the metadata server. So steps run on a bridge
of their own (`172.30.0.0/16`, BuildKit's `bridge` network mode), and a chain of our own in the step
container's `mangle` table, jumped to from PREROUTING for everything that arrives from that bridge,
lets it reach the egress proxy and the metadata server's resolver on port 53, and drops the rest
(`confineLines` in `buildkit_script.ts`). `mangle` because BuildKit's bridge is CNI's, and CNI
inserts its own accept-jump at the top of FORWARD when it creates the first step network, which can
be after any rule of ours went in there; nothing CNI does touches `mangle`. The rules are checked
before every pass, and a build whose rules cannot be set or have gone fails. Steps resolve names
through the metadata server's resolver (a `[dns]` entry in buildkitd's config: the worker's own is a
localhost stub the bridge cannot use), which answers public names, as kube-dns does for a run.
MEASURED locally (v0.32.2, 2026-09-29): with the rules set before the first step network, the
allowed address answered, another public one and the metadata server's token endpoint timed out, and
the rules were still in force after CNI had written its FORWARD jumps. The kubernetes builder needs
none of this: its pod's NetworkPolicy already holds it to the proxy, the gateway and DNS.

**Identities.** A default-branch build runs as `RYPH_ENV_CLOUD_BUILD_SERVICE_ACCOUNT`, a branch
build as `RYPH_ENV_CLOUD_BUILD_BRANCH_SERVICE_ACCOUNT`: the same two service accounts, with the same
registry rights, as the kubernetes builder's pods (see "The push credential is reachable from a
build step"). The control plane calls Cloud Build with its own identity (`ryph-control-plane`,
through Workload Identity), which may act as either.

**Substitutions.** Cloud Build reads `$NAME` and `${NAME}` in a step's args and env as its own
substitutions, and refuses a build that names one it does not know. Every `$` the adapter hands it
is the shell's, so every one is escaped as `$$` (`literal`).

**The durable record** is the build itself. It carries the tag `ryph-env-<environment id>`, so
`adopt` lists builds by that tag and watches what it finds. `discard` cancels a build still running
and leaves a finished one alone. A finished build's record is Cloud Build's history and costs
nothing.

**What it leaks.** The git key and the egress claim ride the build's step env, which the Cloud Build
API shows to anyone who may read builds in the project. Both are minted per build and die with it,
and reading them takes `cloudbuild.builds.get`. The control plane holds that (it starts the builds),
so where one identity serves several deployments' control planes in one project, each could read the
others' in-flight build keys. Deployments that must not see each other's builds need projects of
their own.

**Default accounts.** A build that named no service account would run as the Compute Engine default
account, which holds no project roles here (checked 2026-09-29). The legacy Cloud Build account does
hold `cloudbuild.builds.builder`, but running a build as it takes `actAs` on it, which the control
plane does not have.

## What retention removes from a registry

The kubernetes and Cloud Build builders push to Artifact Registry, and take back what they pushed
(`removeImages`, `adapters/environment_builder/artifact_registry.ts`) through Artifact Registry's
REST API, as the control plane's own Google identity. Off Artifact Registry (a laptop cluster's open
registry) they remove nothing: deleting a manifest there frees nothing until that registry's own
garbage collection runs.

One build leaves, in `<registry>/<subject>`, plain OCI manifests (BuildKit pushes no index here,
measured on GKE): the environment `:<id>`, its baked stage `:baked-<id>`, and, with a
`.ryph/Dockerfile`, the machine `:machine-<id>`. The row records all three digests (`image`,
`bakedImage`, `machineImage`). An unchanged machine built again is the same image, so one version
carries every build's machine tag (14 on one digest, measured), and every one of those rows names
it.

A removal **untags by name and deletes by digest**. The three tags, computed from the build's id,
are deleted and never read: any identity that may push (each build's) may point any tag anywhere, so
a tag is never evidence of what to delete. Then each digest the row recorded is deleted from the
row's own package, never with `force` — and only once the core has asked that no other row not yet
done with and no live run names it, because two builds can report one digest (every build of an
unchanged machine does, and a build whose steps reach its log could claim another's). The last row
naming a digest is the one that deletes it. Artifact Registry refuses to delete a version that is
still tagged, which is the second guard. A refusal is read for what it says, not by its code (no
documentation states it): the version read back still there with a tag is kept, gone is gone, and
anything else fails the removal. A digest recorded outside the row's package is never deleted, and
is logged as a leak, once: the row is done with, since nothing this deployment does will answer it.
Every step repeats safely, so a crash between the untag and the delete, or two replicas removing two
builds of one machine at once, ends with a later attempt deleting by the same digest. A deletion
with no verdict within 30 seconds answers "ask again", and the row stays unstamped until one comes.

| What                    | When it goes                                                                       | How                                                     |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| the environment         | its row retired 30 minutes, nothing holding it                                     | its tag; its recorded digest                            |
| the baked stage         | with the last row naming it (a re-layer shares its source's)                       | its tag with its own row; the digest with the last row  |
| the machine             | with the last row naming it                                                        | its tag with its row; the digest once no tag is left    |
| a failed build's pushes | twice the build timeout after it started, plus five minutes                        | its tags only; what that leaves untagged, the reconcile |
| a late success's pushes | at once, when its row has already moved on                                         | its tags only; what that leaves untagged, the reconcile |
| anything left untagged  | untagged that long plus 30 minutes, and named by no row not done with, no live run | the reconcile, once an hour, by digest                  |
| a layer-cache export    | untagged (a newer export took the tag) for the build timeout plus ten minutes      | the version, unforced                                   |

A build no row recorded (failed, or superseded mid-build) is cleaned by the core's pass, not at the
end of the build, because the watcher does not know whether its verdict is the one that lands: a
second replica watching a build another settled `ready` can read a Job that has gone. And not before
twice the build timeout from its start: a build abandoned by a replica that went away, or adopted as
gone, may still be running, and Cloud Build's own timeout starts only once a queued build runs
(`queueTtl` is the timeout too). A build that succeeded after its row moved on is untagged at once,
and nothing it reported is deleted on its word: a digest it claims could be one a build still in
flight has pushed and not yet recorded, which no row names yet. The reconcile takes what is left,
past an age gate no build in flight outlives.

The reconcile is what makes the registry converge on the rows: it lists each subject package under
the deployment's own path of each registry, and deletes an untagged version, unforced, only when the
core says nothing names its digest — a row of any status not yet done with, a live run's frozen
image, or the image a queued or running build starts from. It refuses a registry with no path of its
own (a bare repository another deployment could share), never looks at another cell's path or the
cache, and only takes what has been untagged for longer than a build no row recorded may still push
— oldest first, at most 200 deletions a package and 500 a pass, counting only versions nothing names
and resuming at the package the last pass stopped in, so a package somebody filled with thousands
takes several passes and never holds the removals up. The cache prune refuses a bare repository the
same way. That covers what builds pushed before removal existed too. An exported cache version is
aged by its `updateTime`, which Artifact Registry stamps when its tag moves on (measured: every
untagged cache version measured on GKE carries its successor's `createTime`); an import resolves its
tag when its build starts and reads blobs until it ends.

A registry refuses nothing a pod is pulling, and kubernetes pulls after the launch, so no launch
there says `ImageGone`. The holds and the grace are what cover it: resolution only picks a ready
row, so anything still launching on a retired one resolved it before it was retired and holds it,
and a live run's pod that is rescheduled pulls an image its hold kept. What slips anyway fails to
pull and says so. A check suite's re-run, which can come days later, goes by retention's stamp where
the launcher cannot tell, and asks again rather than launch on a removed image.

Each removal pass, prune and reconcile that did something or failed says so once, at warn, for the
replica that ran it (every replica runs its own passes, so a deployment's totals are the sum):
`environments.images_removal_pass` (rows seen, stamped, unanswered, failed, the deletions the
registry accepted, and the first error), `environments.cache_pruned` and
`environments.images_reconciled` (candidates, deletions accepted, deletions that failed, the first
error; a reconcile also counts the packages it could not read, as `packageFailures`). What each
deletion was stays at debug. A deletion counts once the registry has accepted it, finished or not. A
refusal of the control plane's own identity (401, 403) ends a prune or a reconcile at once, with one
`*_failed` warning, rather than being asked again for every version. `RYPH_ENV_IMAGE_REMOVAL=off`
stops retention's removals.

The control plane's identity has a role that deletes tags, reads and deletes versions, and lists
tags, versions and packages on the two environments repositories and nothing else (grant exactly
that); neither build identity may delete. A subject that stops building keeps its newest ready image
and its cache's current exports, as on docker.

## A build outlives the control plane that started it

A build takes tens of minutes; a deploy takes seconds. The two meet often enough that it has to be
designed for, and in practice it was not: a pod replaced at 21:18 left two builds that had finished
at 21:00 in `building` for ever, and because the concurrency cap counts `building` rows, the whole
queue wedged behind them.

So a build's progress no longer lives only in the memory of the process that started it. The replica
running one stamps its row on every tick, and a `building` row nobody has stamped for a minute has
no owner. One replica takes such a row (a compare-and-set on the stamp, so never two) and **adopts**
the build — it asks the builder, which is the only thing that knows:

| The backend says                  | What happens                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| the Job is there and running      | attach to it, watch it, settle when it ends — a redeploy mid-build costs nothing |
| the Job is there and finished     | read `@@ryph-result` out of its pod log and settle, success or failure           |
| there is no such Job              | fail the row now, within a tick                                                  |
| the API server could not be asked | decide nothing; the next tick asks again                                         |

`buildJobName` is derived from the environment id alone, which is what makes the first three
possible: a control plane that never created the Job can still find it. Its
`ttlSecondsAfterFinished` is an hour, so a finished Job is still there to be read after a rollout —
the price is that a Job nobody ever comes for holds its work volume for that hour instead of five
minutes. Size the `ryph-builds` quota for that: `requests.storage` has to fit the concurrent builds
plus a retained volume at whatever `RYPH_ENV_BUILD_SIZE`'s `work-volume` is, which at GKE's 150Gi is
not what the base manifest's default covers (the gke overlay raises it).

What the hour does NOT buy is the RESULT surviving its node. The digests are read out of the pod's
log, and a pod goes when its node does — on GKE a build node is scaled down minutes after the build
it was created for. Adoption then finds a Job that says `Complete` and no log to read it from: it
says exactly that ("its pod was gone before its result could be read"), rather than blaming the
build for reporting no digest, and the environment is built again. The image the lost build pushed
is untagged once the failed row can no longer be pushing, and the reconcile deletes it after.

The `docker` builder answers "gone", always, and truthfully: a build there is a `buildx` child of
the control-plane process writing into a temporary directory, and both die with it. There is nothing
to attach to, so the row is failed at once rather than held.

`RYPH_ENV_BUILD_TIMEOUT` has nothing to do with any of this. It bounds how long a build may
**take**, and it is enforced where the build is — the adapter's own cap, and `activeDeadlineSeconds`
on the Job. It is consulted in recovery in exactly one place: a row whose builder cannot be asked at
all, past the deadline the build itself was created with, is failed because the cluster would have
ended it anyway.

## The push credential is reachable from a build step

The design assumed the registry push "is done by BuildKit's client session, which the steps cannot
read". On the kubernetes backend that does not hold as built. With `--oci-worker-no-process-sandbox`
a `RUN` step runs as BuildKit's own user in BuildKit's own pod network, and Workload Identity hands
a token to anything in the pod that asks the metadata server. So a malicious Dockerfile or
`setup.yml` can obtain its build pod's identity for as long as the build runs.

What keeps that from undoing the cache-poisoning rule is that a branch build's pod is a different
identity from a default-branch build's, and the boundary is the registry's IAM, not the build
script's `--export-cache` flag:

| Identity                    | Writes              | Reads               | Runs as it                        |
| --------------------------- | ------------------- | ------------------- | --------------------------------- |
| `ryph-builder` (GSA)        | `ryph-envs`         | `ryph`              | default-branch builds             |
| `ryph-branch-builder` (GSA) | `ryph-env-branches` | `ryph-envs`, `ryph` | branch builds and their re-layers |

A branch that steals its token can push anything to `ryph-env-branches`: runs launch by digest, so
that redirects no run, and it overwrites no layer cache, because branch builds write none — not even
a scope of their own, which a second branch could then poison for a third. It can read `ryph-envs`,
which holds every subject's default-branch images, so repo contents are visible across subjects to a
branch author; single-org deployments accept that (every repo is the same organisation's), and a
customer paying for isolation gets their own deployment.

What is still open: a **default-branch** build's steps can reach `ryph-builder`, which may write any
subject's shared images and layer caches. That is the trusted ref — a maintainer merged the
Dockerfile — but it is not scoped to its own subject. Closing that too needs the push out of the pod
that runs repo code: a second, trusted pod that pushes an OCI layout the build pod leaves on a
volume, or Cloud Build as the fallback.

## Builds a patch asks for

Every path that builds a branch — a waiting run, a check suite, a task's patch — first asks whether
the branch CHANGED `.ryph/` (`src/core/ryph_baseline.ts`): a tree that differs from the default
branch head's but equals the branch's merge base's is the default branch's machine, behind. The
forge answers that from its cache (`/v1/service/ryph-base`): the merge base, its `.ryph` tree id and
the paths under `.ryph/` changed since. Every build records why it was queued
(`Environment.reason`): the refs, commits and trees compared, shown on the build's page and in the
result message.

A branch build has one more caller besides a run that waits for it: an environment-setup task's
**patch**. When such a patch reaches the forge as a branch and it changed `.ryph/` since its merge
base with the default branch, the control plane queues a build of exactly that commit on that branch
(trigger `patch`, claimed as early as a run's), and when it settles posts the result into the run's
inbox (`src/core/environment_feedback.ts`). To the builder it is an ordinary branch build: the
branch's identity, the branch registry, no cache written. It is how an agent that cannot run Docker
learns whether the `.ryph/` it wrote builds — the loop behind the repo page's "Set up this repo's
environment" task (`src/core/environment_setup.ts`). A ready build whose setup.yml did not finish
says so in the same message, as loudly as a failure: "SUCCEEDED, but setup.yml did NOT finish", the
repos named, and "This build checked setup.yml, and it does NOT work yet" where it would otherwise
say it works. The result message quotes the build's own output (its log tail, its failure, the
toolchain versions it printed, each failed step's label and output) only inside a fence keyed by a
nonce minted per message, after the platform's own sentence saying whose words those are.

Each patch is checked once. The check is claimed first, as a `patch_builds` row with a lease, before
the forge is read or a build queued, so the submitter, the run's `environment_status` read and the
tick never queue a build twice. A check the forge could not answer keeps its row and is retried 30 s
later, for up to a day; the build tick's backstop retakes expired leases, checks submitted patches
whose check was never claimed (the last day's), and tells results and setup notes nobody told. A
setup run idles on its inbox, so nothing waits on the agent asking.

## Knobs

| Variable                                      | Default                                                                                                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RYPH_ENV_BUILD_PLATFORM`                     | the daemon's                                                                                                      | docker: `--platform` for every build                                                                                                                                                                                                                                                                                                                                                                            |
| `RYPH_ENV_IMAGE_REMOVAL`                      | `on`                                                                                                              | `off`: retention removes nothing (no `removeImages`, `pruneCache` or `reconcileImages`) on any backend, and rows stay unstamped until it is on again. Docker still cleans up after its own builds: a failed build's tags and the cache directories it prunes at each build. With the docker builder it is the docker launcher's setting, and a caller reaching a launcher elsewhere refuses to boot with it set |
| `RYPH_ENV_GIT_GATEWAY_URL`                    | docker: `RYPH_FORGE_URL`, or the host's in-process forge; kubernetes: `RYPH_GIT_GATEWAY_URL`                      | the git gateway as the build's clone dials it                                                                                                                                                                                                                                                                                                                                                                   |
| `RYPH_ENV_CACHE_DIR`                          | `ryph/environments` under `$XDG_CACHE_HOME` or `~/.cache`; the binary: `~/.ryph/env-cache`                        | docker: per-scope cache directories (containerd image store, or any confined build)                                                                                                                                                                                                                                                                                                                             |
| `RYPH_ENV_TEMP_DIR`                           | the system temp dir                                                                                               | docker: where a build's clone and image exports go while it runs (GBs; made if missing). The binary: `~/.ryph/tmp`                                                                                                                                                                                                                                                                                              |
| `RYPH_ENV_BUILD_NAMESPACE`                    | `ryph-builds`                                                                                                     | kubernetes: where build Jobs go                                                                                                                                                                                                                                                                                                                                                                                 |
| `RYPH_ENV_BUILD_SERVICE_ACCOUNT`              | `ryph-builder`                                                                                                    | kubernetes: a default-branch build pod's service account                                                                                                                                                                                                                                                                                                                                                        |
| `RYPH_ENV_BRANCH_BUILD_SERVICE_ACCOUNT`       | `ryph-branch-builder`                                                                                             | kubernetes: a branch build pod's service account                                                                                                                                                                                                                                                                                                                                                                |
| `RYPH_ENV_BRANCH_REGISTRY`                    | `RYPH_ENV_REGISTRY`, only where that has no credential                                                            | kubernetes: where branch builds push; required with `gke-metadata`                                                                                                                                                                                                                                                                                                                                              |
| `RYPH_ENV_BUILD_RUNTIME_CLASS`                | `RYPH_K8S_RUNTIME_CLASS`                                                                                          | kubernetes: the sandbox a build pod runs under. One of the two is required, since BuildKit runs with seccomp and AppArmor unconfined                                                                                                                                                                                                                                                                            |
| `RYPH_ENV_BUILD_ALLOW_UNSANDBOXED`            | `off`                                                                                                             | kubernetes: `on` builds with no runtime class, on the node's own kernel. Laptop clusters only                                                                                                                                                                                                                                                                                                                   |
| `RYPH_ENV_BUILD_SIZE`                         | `cpu=4,memory=8Gi,ephemeral-storage=10Gi,work-volume=50Gi`                                                        | kubernetes: the build pod's resources, in the size-class grammar without a name                                                                                                                                                                                                                                                                                                                                 |
| `RYPH_ENV_BUILDKIT_IMAGE`                     | kubernetes: `moby/buildkit:v0.32.2-rootless`; cloud-build and confined docker: `moby/buildkit:v0.32.2`, by digest | the BuildKit image: rootless in a pod, rootful in a Cloud Build step or a confined docker build (a rootless one is refused at boot there)                                                                                                                                                                                                                                                                       |
| `RYPH_ENV_BUILDKIT_SNAPSHOTTER`               | `native`                                                                                                          | kubernetes: buildkitd's snapshotter. `native` is what works under gVisor — an overlay one dies on the first `COPY --from`, measured on GKE Autopilot. Override only off gVisor                                                                                                                                                                                                                                  |
| `RYPH_ENV_REGISTRY_AUTH`                      | `gke-metadata` for Google registries, else `none`                                                                 | kubernetes: the pod's Workload Identity token, or no credential                                                                                                                                                                                                                                                                                                                                                 |
| `RYPH_ENV_WARM_CHAIN`                         | `4`                                                                                                               | every builder: incremental builds in a row before the next is cold; `0` builds every image cold                                                                                                                                                                                                                                                                                                                 |
| `RYPH_ENV_EGRESS_PROXY_URL`                   | `RYPH_EGRESS_PROXY_URL`                                                                                           | the egress proxy as a build dials it; cloud-build: the cell's internal load balancer; confined docker: must be unset, since the build reaches only the run gate, and ryph or the control plane refuses to boot with it set                                                                                                                                                                                      |
| `RYPH_ENV_CLOUD_BUILD_POOL`                   | — (required)                                                                                                      | cloud-build: `projects/<p>/locations/<region>/workerPools/<name>`                                                                                                                                                                                                                                                                                                                                               |
| `RYPH_ENV_CLOUD_BUILD_LOGS`                   | — (required)                                                                                                      | cloud-build: the bucket a default-branch build logs to                                                                                                                                                                                                                                                                                                                                                          |
| `RYPH_ENV_CLOUD_BUILD_BRANCH_LOGS`            | — (required)                                                                                                      | cloud-build: the bucket a branch build logs to                                                                                                                                                                                                                                                                                                                                                                  |
| `RYPH_ENV_CLOUD_BUILD_SERVICE_ACCOUNT`        | — (required)                                                                                                      | cloud-build: the service account a default-branch build runs as                                                                                                                                                                                                                                                                                                                                                 |
| `RYPH_ENV_CLOUD_BUILD_BRANCH_SERVICE_ACCOUNT` | — (required)                                                                                                      | cloud-build: a branch build's                                                                                                                                                                                                                                                                                                                                                                                   |
| `RYPH_ENV_CLOUD_BUILD_DISK`                   | unset                                                                                                             | cloud-build: the pool's disk (e.g. `500G`), for buildkitd's GC policy                                                                                                                                                                                                                                                                                                                                           |

The kubernetes builder reads the API connection the run provisioner does (`RYPH_K8S_API_URL`, or the
pod's own service account) and the work volume's `RYPH_K8S_WORK_VOLUME_CLASS`.
