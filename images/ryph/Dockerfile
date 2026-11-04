# The `ryph` binary in a container: the single-process deployment (packages/ryph), for the Docker
# Compose mode in deploy/compose. Not one of the networked deployment's service images — this is
# the whole of ryph in one process, the same binary a laptop runs, compiled here so a self-hoster
# needs nothing but docker.
#
# The binary shells out to `git` (the in-process forge), so git is here. It runs no docker: in
# this container it reaches docker only through the launcher service beside it
# (RYPH_LAUNCHER_URL, images/launcher), which holds the socket and the docker CLI. So neither is
# here, and the process that holds the master key and the database cannot become root on the
# machine through them (deploy/compose/README.md, Security). Started without a launcher URL, the
# binary would embed one and find no docker to run.
#
# Node is here for the artifact sanitizer alone, as in the control-plane image: `node --permission`
# confines the process that parses untrusted HTML (packages/orchestrator/docs/artifacts.md), and
# RYPH_ARTIFACT_SANITIZER_CONFINED=required refuses every publish rather than run it unconfined.
#
# The Bun version mirrors the mise.toml pin and the Node major mirrors its node pin; bump them
# together with the other images. Built from the workspace root:
#   docker build -f images/ryph/Dockerfile -t ryph .

FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS node

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /build
# Every member's manifest, since bun wants each workspace a package names on disk; then the
# binary's dependencies and the app's (vite builds the UI the binary embeds).
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --filter @ryph/cli --filter @ryph/app
# The binary's whole module graph, the migration sets it embeds and the catalogues it packs.
# Copying packages/ wholesale is safe here: .dockerignore is an allowlist, so what lands is the
# source and the migrations, never a checkout's data or tests.
COPY packages/ packages/
COPY images/egress-proxy/main.ts images/egress-proxy/main.ts
# Memory's embeddings runtime, installed from its own lockfile at compile time; the weights are
# fetched from their pinned revision and checked against recorded digests (scripts/embeddings.ts).
COPY images/memory/embeddings/package.json images/memory/embeddings/bun.lock \
  images/memory/embeddings/
RUN bun run --filter @ryph/app build
# The tag this commit's images are published under (images/publish.ts passes `sha-<12>`), which the
# binary defaults its agent, browser, tool guard and run gate to. A build context has no .git, so
# compile.ts cannot ask; left empty, the binary follows `edge` and says so.
ARG RYPH_IMAGE_TAG=""
# For this build's own platform, whose onnxruntime addon is the one that goes in; compile.ts also
# runs the result once to check that it reads no bunfig.toml or .env from where it starts and
# refuses a hostile environment.
RUN RYPH_IMAGE_TAG="${RYPH_IMAGE_TAG}" bun --no-env-file packages/ryph/scripts/compile.ts --output=/out/ryph

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS ryph

# git for the forge, ca-certificates for every https dial (GitHub, model providers), libatomic1
# for node.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libatomic1 \
  && rm -rf /var/lib/apt/lists/*

# Root-owned and named outright, so the sanitizer runs under THIS node or not at all.
COPY --from=node /usr/local/bin/node /opt/node/bin/node
COPY --from=build /out/ryph /usr/local/bin/ryph
# `ryph version` unpacks the runtime (embeddings included, 100 MB) into RYPH_HOME, so it gets a
# throwaway one: the real one is the volume, and a copy left in this layer is dead weight.
RUN /opt/node/bin/node --version \
  && export RYPH_HOME="$(mktemp -d)" && ryph version && rm -rf "$RYPH_HOME"
ENV RYPH_ARTIFACT_SANITIZER_NODE=/opt/node/bin/node
ENV RYPH_ARTIFACT_SANITIZER_CONFINED=required

# uid 1994, pinned: the radicle-node image's, because with the compose `radicle` profile both
# containers write the same RAD_HOME volume (images/radicle-node/Dockerfile says why one uid).
RUN groupadd --gid 1994 ryph && useradd --uid 1994 --gid 1994 --no-create-home \
    --home-dir /var/lib/ryph --shell /usr/sbin/nologin ryph
# Everything ryph keeps — the unpacked runtime, the master key, run images, the forge's cache —
# lives under RYPH_HOME, a named volume in compose. Docker seeds a fresh named volume from this
# directory, ownership and mode included, so it lands owned by ryph and 0700: the binary refuses
# a runtime directory others can write.
RUN install -d -o ryph -g ryph -m 0700 /var/lib/ryph
ENV RYPH_HOME=/var/lib/ryph HOME=/var/lib/ryph
# Repositories on this machine (RYPH_LOCAL_REPO_ROOT): a named volume in compose, seeded owned by
# ryph, which it may clone into and land approved patches in as branches.
RUN install -d -o ryph -g ryph -m 0755 /srv/repos

# RAD_HOME for Radicle user mode (RYPH_RADICLE_URL=embedded, the `ryph-radicle` target below):
# where an existing node's RAD_HOME is mounted. Unused otherwise.
RUN install -d -o ryph -g ryph -m 0755 /data/radicle
ENV RAD_HOME=/data/radicle

# Nothing the service user can rewrite, and the build fails on anything world-writable (sticky
# directories such as /tmp aside).
RUN chmod -R go-w /usr/local /opt \
  && bad=$(find / -xdev -perm -0002 ! -type l ! \( -type d -perm -1000 \)) \
  && if [ -n "$bad" ]; then echo "world-writable: $bad" >&2; exit 1; fi

USER ryph
WORKDIR /var/lib/ryph
# The web UI and previews; the control plane, model proxy, forge, MCP gateway and egress proxy
# (7411, 7420, 7412, 7430, 7460) are for agent containers, through the run gate, and are never
# published.
EXPOSE 3000 7490
ENTRYPOINT ["/usr/local/bin/ryph"]
CMD ["up"]

# ── ryph-radicle: the same, plus `rad` and `git-remote-rad` ─────────────────────────────────────
# For Radicle user mode, where ryph's in-process bridge acts through an existing node's RAD_HOME
# and shells out to both. Upstream's code built from source at the version images/radicle-node
# pins (build-radicle.sh says why not the release archives), so a node built from that image and
# this CLI agree. A separate target because it is a Rust build: nobody else should wait for it.
FROM rust:1.97.1-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f AS radicle
ARG TARGETARCH
COPY images/radicle-node/build-radicle.sh /build-radicle.sh
RUN --mount=type=cache,id=cargo-registry-$TARGETARCH,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target-$TARGETARCH,target=/cargo-target \
    CARGO_TARGET_DIR=/cargo-target /bin/sh /build-radicle.sh /opt/radicle

FROM ryph AS ryph-radicle
COPY --from=radicle /opt/radicle/bin/rad /opt/radicle/bin/git-remote-rad /usr/local/bin/
RUN rad --version

# The default target, so a plain `docker build` makes the image without Radicle.
FROM ryph
