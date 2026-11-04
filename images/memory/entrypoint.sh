#!/bin/sh
# Execs the standalone memory service. It does NOT apply the schema — see
# images/control-plane/entrypoint.sh for why that moved to a one-shot pre-deploy job. drizzle-kit
# is installed here too:
#
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
#
# The service probes its database at boot and exits naming the fix if the schema is absent.
set -e
cd /app/packages/memory
# The in-process embeddings runtime (onnxruntime-node) is a native addon, which Bun loads as Node
# does. --no-env-file: the environment it was given, never a .env from its directory.
exec bun --no-env-file src/main.ts
