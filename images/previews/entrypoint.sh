#!/bin/sh
# Execs the standalone previews service. There is no schema to apply and no data directory to
# prepare: what it holds is the open tunnels, in memory.
set -e
cd /app/packages/previews
# It needs its two listeners and nothing else; Bun has no permission flag to say so (docs/runtime.md,
# What we lose). --no-env-file: the environment it was given, never a .env from its directory.
exec bun --no-env-file src/main.ts
