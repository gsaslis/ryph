#!/bin/sh
# Runs the forge. It writes only two trees: its data root (RYPH_FORGE_DATA, default /data — cache,
# patches, staging) and the system temp dir the patch submit path clones into. The source tree is
# root-owned and read-only to this process, so a write bug in a service that handles hostile input
# and holds the GitHub App key cannot overwrite forge's own code. Bun has no write scope of its own
# to enforce that a second way; a read-only root filesystem with /data and /tmp writable does.
#
# --no-env-file: the environment it was given, never a .env from the working directory.
set -e
exec bun --no-env-file packages/forge/src/main.ts
