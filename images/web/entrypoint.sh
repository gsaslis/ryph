#!/bin/sh
# Execs the standalone web service. There is no schema to apply and no data directory to
# prepare: this service keeps nothing.
set -e
cd /app/packages/web
# It needs the network (the listener, the DNS lookups the address guard makes, and the pages and
# search results it fetches) and nothing else; Bun has no permission flag to say so, and the
# NetworkPolicy and the root-owned /app are what is left (docs/runtime.md, What we lose).
# --no-env-file: the environment it was given, never a .env from its directory.
exec bun --no-env-file src/main.ts
