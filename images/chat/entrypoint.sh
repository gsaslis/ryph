#!/bin/sh
# Execs the standalone chat service. It does NOT apply the schema — see
# images/control-plane/entrypoint.sh for why that moved to a one-shot pre-deploy job. drizzle-kit
# is installed here too:
#
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
#
# The service probes its database at boot and exits naming the fix if the schema is absent.
#
# --no-env-file: the service reads the environment it was given, never a .env from its directory.
set -e
cd /app/packages/chat
exec bun --no-env-file src/main.ts
