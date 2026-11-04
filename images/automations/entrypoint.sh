#!/bin/sh
# Execs the standalone automations service. It does NOT apply the schema — the one-shot
# migrate-automations job does, with:
#
#   bun --no-env-file scripts/ensure_database.ts
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
#
# The service probes its database at boot and exits naming the fix if the schema is absent.
#
# --no-env-file: the service reads the environment it was given, never a .env from its directory.
set -e
cd /app/packages/automations
exec bun --no-env-file src/main.ts
