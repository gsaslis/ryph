# The Radicle node — upstream's code, built from source, nothing of ours but the entrypoint. It is half of the
# OPTIONAL `radicle` service: one pod, two containers, one
# volume mounted at RAD_HOME. This container owns the storage, the key and the gossip
# connection; the bridge beside it (images/radicle/Dockerfile) is the only thing that writes
# through `rad`, and it reaches this process over the control socket INSIDE that shared volume.
#
# THE KEY IS THE IDENTITY. Storage is re-fetchable from the network; authorship is not. So a
# real deployment provisions the key pair from a Secret mounted at /run/secrets/radicle
# (`radicle` and `radicle.pub`) and the entrypoint copies it in on first boot. Generating one
# onto the volume is the laptop path, and it is what happens when no Secret is there.
#
# Configure via RYPH_RADICLE_ALIAS (default `ryph`), RAD_PASSPHRASE (may be empty — then the key
# is unencrypted, which is the compose default), RYPH_RADICLE_CONNECT (comma-separated
# `<nid>@<host>:<port>` seeds, default the two heartwood ships) and RYPH_RADICLE_EXTERNAL_ADDRESS
# (comma-separated `<host>:<port>`, only when this node is reachable from outside).
#
# The Radicle version and commit are pinned in build-radicle.sh, which images/radicle also runs;
# bump them there. It says why this is a source build rather than upstream's release archive.
#
# Debian trixie-slim: the same distribution the Bun service images are built on
# (oven/bun:1.4.4-slim is trixie), so the two containers in this pod share a libc and a CA
# bundle. Built from the workspace root like every other image here:
#   docker build -f images/radicle-node/Dockerfile -t ryph-radicle-node .

FROM rust:1.97.1-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f AS release
ARG TARGETARCH

# Plain `cargo build`, on the same Debian release the runtime stage uses, so the binaries link
# against the glibc they run on. The cache mounts keep a rebuild from recompiling the world.
# The Rust image is pinned by digest so this layer stays cached from one release to the next: a
# floating `rust:1` moves upstream and every move recompiles Radicle for both platforms. Each
# platform gets cache mounts of its own: sharing one, the two builds queued on cargo's lock in
# /cargo-target, and an emulated amd64 cargo that hung while holding it stalled arm64 for good.
# Keep this stage identical in images/radicle and images/ryph so BuildKit builds it once.
COPY images/radicle-node/build-radicle.sh /build-radicle.sh
RUN --mount=type=cache,id=cargo-registry-$TARGETARCH,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target-$TARGETARCH,target=/cargo-target \
    CARGO_TARGET_DIR=/cargo-target /bin/sh /build-radicle.sh /opt/radicle

FROM debian:trixie-slim

# git is not optional: Radicle's storage IS git, and `rad auth` refuses to run without it. jq
# renders config.json in the entrypoint. ca-certificates is for nothing this process does
# itself — the p2p protocol is not TLS — but `rad` will fetch over https if a repo names such a
# seed, and an image with no trust store fails that in a way nobody can read.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates jq \
  && rm -rf /var/lib/apt/lists/*

COPY --from=release /opt/radicle/bin/ /usr/local/bin/

# uid 1994, PINNED rather than taken from useradd's next-free, as in the bridge image (whose base
# already has `bun` at 1000); here too it must
# be spelled out — the bridge container and this one share a volume AND a UNIX socket inside it,
# and the manifests' fsGroup is the same number.
RUN groupadd --gid 1994 radicle \
  && useradd --create-home --uid 1994 --gid 1994 radicle

# RAD_HOME, pre-created and radicle-owned, for the reason the forge image gives at length:
# docker seeds a fresh NAMED volume from whatever is at the mount point, ownership included, so
# `-v radicle-data:/data/radicle` lands writable. A BIND mount keeps the host's ownership and
# still needs a matching uid on the host.
RUN install -d -o radicle -g radicle /data /data/radicle
ENV RAD_HOME=/data/radicle

USER radicle
WORKDIR /data/radicle

# The p2p listener. Never published by default — see the networked compose and the NetworkPolicy
# in deploy/helm/ryph/templates/radicle.yaml: this node is outbound-only unless a deployment decides
# otherwise, because fetches ride the connection it opened.
EXPOSE 8776

# Root-owned and world-executable: the radicle user runs it and cannot rewrite it.
COPY --chmod=0755 images/radicle-node/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
