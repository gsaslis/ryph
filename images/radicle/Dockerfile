# The Radicle bridge — @ryph/radicle, the other half of the OPTIONAL `radicle` service. It is the
# ONLY process that touches RAD_HOME: the forge's radicle ForgeApi adapter dials it over HTTP with
# RYPH_RADICLE_TOKEN, and it turns those calls into `rad cob` reads and writes (`rad-job` ones for
# the job COB), `git push rad …` for patches and revisions, and a `subscribe` on the node's control
# socket whose events become ForgeEvents in the existing webhook mailroom.
#
# WHY THE BINARIES ARE IN HERE TOO. `git-remote-rad` writes straight into RAD_HOME/storage on
# the local filesystem — pushing a patch is a local write, not a network call — so whatever
# pushes must share the volume with the node and carry the same `rad`, `git` and
# `git-remote-rad`. The build step is shared with images/radicle-node through
# build-radicle.sh, which holds the version pin; the two images cannot be
# built from each other (images/publish.ts builds each independently from the workspace root),
# so the STEP is shared rather than a layer.
#
# Configure via RYPH_RADICLE_PORT (default 7470), RYPH_RADICLE_TOKEN (the bearer the forge presents
# — required, and the same one the bridge presents back on the events link), RYPH_RADICLE_DB (its
# own `ryph_radicle`, holding the event cursors), RYPH_RADICLE_EVENTS_URL (where a ForgeEvent goes:
# the forge, which hosts the mailroom), RYPH_RADICLE_EXPLORER_URL (the template patch links are
# built from), RYPH_RADICLE_RECONCILE_SECONDS (the slow correctness pass; the event stream is lossy
# by design) and RAD_PASSPHRASE — the same value the node container gets, or this process cannot
# sign.
#
# The schema is provisioned separately, as in every other service image here: the entrypoint
# does not apply it, a one-shot job does (the networked compose's migrate-radicle, or the Helm chart's
# `migrate` init container).
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/radicle/Dockerfile -t ryph-radicle .

FROM rust:1.97.1-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f AS release
ARG TARGETARCH
# The same step as images/radicle-node, so BuildKit builds it once for both images.
COPY images/radicle-node/build-radicle.sh /build-radicle.sh
RUN --mount=type=cache,id=cargo-registry-$TARGETARCH,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target-$TARGETARCH,target=/cargo-target \
    CARGO_TARGET_DIR=/cargo-target /bin/sh /build-radicle.sh /opt/radicle

# rad-job — the `radicle-job` crate's own CLI, and the only writer of the job COB
# (`xyz.radworks.job`, where ryph records a check suite's verdict) that works against rad 1.10.2:
# `rad cob` can neither read nor write that type (packages/radicle/src/adapters/jobs/rad_job.ts
# has the measurements). Built from source at the exact revision Radicle Desktop and
# radicle-explorer pin — the `patches/da556678…` branch of radicle-job 0.6.0 — because that is
# the COB encoding the readers of these jobs are built against.
#
# The pin is a COMMIT, fetched by id (the seed serves any commit it holds) and checked after
# checkout, so a push to the branch changes nothing here; `--locked` then holds every crate to the
# checksums in that commit's Cargo.lock. Bump RADICLE_JOB_COMMIT together with Desktop's pin; the
# branch it lives on is `patches/da55667860741ee221483fc42fa7cbbb58e0cfc2`. The toolchain image is
# pinned by digest for the same reason.
# Built on trixie, like the runtime stage below, so the glibc it links against is the one it
# runs on. The toolchain is newer than the crate's declared MSRV (1.86) on purpose: the radicle
# 0.25 its lockfile resolves does not compile on 1.89 (E0382 inside the `radicle` crate), and 1.96
# is the version this was built and tested with.
FROM rust:1.96-slim-trixie@sha256:31ee7fc65186be7e0e0ccb3f2ca305f14e4739e7642a1ae65753aa5d7b874523 AS rad-job
ARG RADICLE_JOB_URL=https://seed.radicle.dev/z2UcCU1LgMshWvXj6hXSDDrwB8q8M/z6MkwPUeUS2fJMfc2HZN1RQTQcTTuhw4HhPySB8JeUg2mVvx
ARG RADICLE_JOB_COMMIT=77cf8fb415f1f9026fb8a0bd5ef807eca54f69d4
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates pkg-config \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init --quiet . \
  && git fetch --quiet --no-tags "$RADICLE_JOB_URL" "$RADICLE_JOB_COMMIT" \
  && git checkout --quiet --detach "$RADICLE_JOB_COMMIT" \
  && test "$(git rev-parse HEAD)" = "$RADICLE_JOB_COMMIT"
RUN cargo build --locked --release --bin rad-job \
  && install -D -m 0755 target/release/rad-job /out/rad-job \
  && /out/rad-job --version | grep -qx "radicle-job 0.6.0"

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# git backs every write: a patch is a push, and Radicle's storage is git all the way down.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# rad, radicle-node and git-remote-rad. The node binary comes along because it is one build;
# nothing here runs it — that is the sidecar's whole job, and two nodes on one RAD_HOME would
# corrupt it.
COPY --from=release /opt/radicle/bin/ /usr/local/bin/
# rad-job beside them, found through the same RYPH_RADICLE_BIN_DIR. It signs with the same key
# and RAD_HOME as `rad`, and only when the bridge records a check suite on a commit's job.
COPY --from=rad-job /out/rad-job /usr/local/bin/rad-job
# Where the bridge looks for them. It spawns an ABSOLUTE path rather than a bare name
# (packages/radicle/src/adapters/rad/cli.ts), so this is part of the contract and not a convenience.
ENV RYPH_RADICLE_BIN_DIR=/usr/local/bin

# uid 1994, PINNED, in the same form the node image pins it. A bare `useradd` takes the next
# free number — on today's base image 1001, because `bun` sits at 1000 — and would silently
# become something else the day the base image adds a user. The two
# containers share RAD_HOME and the node's control socket inside it, and the manifests' fsGroup
# is the same number: a mismatch makes the socket unopenable from this side and looks exactly
# like a node that is down.
RUN groupadd --gid 1994 radicle \
  && useradd --create-home --uid 1994 --gid 1994 radicle

# RAD_HOME, pre-created and radicle-owned, for the reason the forge image gives: docker seeds a
# fresh NAMED volume from the mount point's ownership. In the pod this is the node's volume, so
# what matters there is the fsGroup; here it is what makes `-v radicle-data:/data/radicle`
# writable on a laptop.
RUN install -d -o radicle -g radicle /data /data/radicle
ENV RAD_HOME=/data/radicle

WORKDIR /app

# Source and dependencies stay root-owned (installed and copied as root, before USER below), as in
# the forge image and for the same reason: this process handles input from strangers on a public
# network AND holds the deployment's signing key, so a write bug must not be able to rewrite the
# code that runs on the next boot.
#
# Every dependency is installed here, at build, from the lockfile: this container has NO egress to
# the internet (deploy/helm/ryph/templates/radicle.yaml gives radicle DNS, the forge, Postgres and
# the gossip port, and nothing else), so anything resolved at boot would hang until the liveness
# probe killed it (a new tsx release between two image builds once did exactly that). A frozen
# install of exact lockfile versions leaves nothing to resolve, and the entrypoint's
# --no-install makes a missing package a one-line error instead of a download.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/radicle

COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/process/src/ packages/process/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/radicle/src/ packages/radicle/src/
COPY packages/radicle/scripts/ packages/radicle/scripts/
COPY packages/radicle/drizzle.config.ts packages/radicle/
COPY packages/radicle/drizzle/ packages/radicle/drizzle/

# Nothing the service user can rewrite. bun install leaves some files world-writable (bin targets
# such as esbuild, drizzle-kit's bin.cjs and node-which come out 0777), which a root-owned tree
# alone does not stop, so the tree is made go-w and the build fails on anything left writable by
# everyone (sticky directories such as /tmp aside).
RUN chmod -R go-w /app /opt /root \
  && bad=$(find / -xdev -perm -0002 ! -type l ! \( -type d -perm -1000 \)) \
  && if [ -n "$bad" ]; then echo "world-writable: $bad" >&2; exit 1; fi

# PATH without the base image's /usr/local/bun-node-fallback-bin, whose `node` is bun itself:
# whatever looks for node on PATH (the artifact sanitizer did) must not find a bun posing as one.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER radicle

COPY --chmod=0755 images/radicle/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
