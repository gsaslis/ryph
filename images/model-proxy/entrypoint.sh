#!/bin/sh
# Execs the standalone model proxy — both listeners, one process. It does NOT apply the schema.
#
# Schema provisioning is a one-shot job run once per deploy, before the replicas roll — N
# replicas each migrating at boot race each other. drizzle-kit is installed in this image:
#
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
#
# The service probes its database at boot and exits naming the fix if the schema is absent.
#
# --no-env-file: the service reads the environment it was given, never a .env from its directory.
set -e
cd /app/packages/model-proxy
exec bun --no-env-file src/main.ts
