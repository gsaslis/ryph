#!/bin/sh
# Runs the bridge. It writes RAD_HOME (the shared volume — storage, the COB caches, the control
# socket it dials) and the system temp dir it verifies incoming bundles into. The source tree and
# its dependencies are root-owned and read-only to this process, which is the point: this is the
# one container that holds the deployment's Radicle signing key and takes input from strangers on
# a public network. Bun has no write scope or spawn allowlist of its own (docs/runtime.md, What
# we lose); a read-only root filesystem with RAD_HOME and /tmp writable is the boundary. The
# bridge spawns `rad`, `rad-job` and `git` by absolute path from RYPH_RADICLE_BIN_DIR and nothing
# else; `git-remote-rad` is spawned by git itself, not from here.
#
# It does NOT apply the schema — see images/control-plane/entrypoint.sh for why that moved to a
# one-shot pre-deploy job. drizzle-kit is installed here too:
#
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
set -e
# The node container writes the key; this process only reads it, and needs the same passphrase
# to sign with it. Exported even when empty so nothing falls back to prompting on a terminal
# that does not exist here.
export RAD_PASSPHRASE="${RAD_PASSPHRASE-}"
cd /app/packages/radicle
# --no-install because this container has no route to a registry: its NetworkPolicy allows DNS,
# the forge, Postgres and the Radicle gossip port, and nothing else. Everything this process
# imports is installed by the Dockerfile from the lockfile. So a dependency that is somehow NOT in
# the image is a build bug, and this flag makes it say so in one line at boot instead of hanging
# on a connection that can never be made until the liveness probe kills the pod.
# --no-env-file: the environment it was given, never a .env from its directory.
exec bun --no-install --no-env-file src/main.ts
