#!/bin/bash
# Runs the control plane (the orchestrator with auth mounted). It does NOT apply the schema, and it
# does NOT start the artifact sanitizer: that runs in a container of its own (sanitizer.sh).
#
# Schema provisioning is a one-shot job run once per deploy, before the replicas roll — N
# replicas each migrating at boot race each other. drizzle-kit is installed in this image, so
# the job runs here:
#
#   bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate
#
# It applies packages/orchestrator/drizzle, the one migration set covering BOTH schemas that share
# this database — the orchestrator's tables and auth's. An unprovisioned database is not silent:
# the service probes it at boot and exits naming the fix.
#
# --no-env-file: it reads the environment it was given, never a .env from its directory.
#
# THE SANITIZER. Each publish's HTML is parsed by a process the supervisor in the sanitizer
# container starts, as another uid, under `node --permission` (sanitizer.sh says why the uid is
# its own). This process reaches it over the unix socket RYPH_ARTIFACT_SANITIZER_SOCKET names,
# which the image sets. Without it the control plane would start the sanitizer itself, as its own
# uid, which this image never allows: it refuses to start instead.
set -euo pipefail
cd /app/packages/orchestrator
if [ -z "${RYPH_ARTIFACT_SANITIZER_SOCKET:-}" ]; then
  echo "entrypoint: RYPH_ARTIFACT_SANITIZER_SOCKET is empty; the control plane runs beside a sanitizer container (images/control-plane/sanitizer.sh)" >&2
  exit 1
fi
exec bun --no-env-file src/main.ts
