#!/bin/sh
# Builds `rad`, `radicle-node` and `git-remote-rad` from heartwood's source with plain
# `cargo build` and installs them into <prefix>/bin. Shared by BOTH images that need those
# binaries — images/radicle-node (the node itself) and images/radicle (the bridge, which shells
# out to `rad` and pushes through `git-remote-rad`) — so the version is pinned in exactly one
# file. Neither image can be built from the other's output (they are built independently, from
# the workspace root, by images/publish.ts), so the STEP is shared rather than a layer.
#
#   build-radicle.sh <prefix>
#
# WHY FROM SOURCE. Upstream's release archives are built with `cargo zigbuild`, and those
# linux-musl binaries segfault when a fetch prunes certain refs, leaving a stale
# `packed-refs.lock` that fails every later fetch of that repo (reproduced 2026-09-30 on
# 1.10.2 and 1.10.3, amd64 and arm64). A plain `cargo build` of the same commit does not.
# Upstream knows; this is their recommended workaround until a release fixes the builder.
#
# The pin. Bump both together, and nowhere else.
VERSION=1.10.2
COMMIT=7f5de25223c43ee90365fbbca85fc1bdfb41797f
#
# The commit hash is the trust anchor: git checks every object it fetches against it, so a
# seed serving anything else fails the checkout. The toolchain comes from heartwood's own
# rust-toolchain.toml, which rustup installs on first use.
set -e

prefix="${1:?usage: build-radicle.sh <prefix>}"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT

git -C "$src" init -q
git -C "$src" fetch -q --depth 1 https://iris.radicle.xyz/z3gqcJUoA1n9HaHKufZs5FCSGazv5.git \
  "refs/tags/releases/$VERSION"
git -C "$src" checkout -q --detach FETCH_HEAD
got="$(git -C "$src" rev-parse HEAD)"
if [ "$got" != "$COMMIT" ]; then
  echo "releases/$VERSION is $got, not the pinned $COMMIT" >&2
  exit 1
fi

# CARGO_TARGET_DIR may be a cache mount; the binaries are copied out before it goes away. The
# version and commit are passed the way upstream's release build passes them, because the
# shallow checkout has no tag for heartwood's build.rs to describe.
(cd "$src" && RADICLE_VERSION="$VERSION" GIT_HEAD="$COMMIT" \
  cargo build --locked --release -p radicle-node -p radicle-cli -p radicle-remote-helper)
target="${CARGO_TARGET_DIR:-$src/target}/release"
mkdir -p "$prefix/bin"
install -m 0755 "$target/rad" "$target/radicle-node" "$target/git-remote-rad" "$prefix/bin/"

# Fails the BUILD rather than the first boot: the package's deviation list is written against
# one exact version ("Things measured about rad 1.10.2"), so the printed version is COMPARED.
for bin in rad radicle-node; do
  reported="$("$prefix/bin/$bin" --version)" || {
    echo "$prefix/bin/$bin does not run" >&2; exit 1;
  }
  # `rad 1.10.2 (<commit>)` — the second field is the one that has to match the pin.
  if [ "$(echo "$reported" | awk '{print $2}')" != "$VERSION" ]; then
    echo "$bin reports '$reported', which is not the pinned $VERSION" >&2
    exit 1
  fi
done
