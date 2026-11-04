#!/bin/sh
# Execs the browser sidecar. Nothing to prepare: it keeps nothing, and Chromium launches on the
# first tool call.
#
# The process is a sandboxed launcher of a browser it hands arbitrary pages to; the boundary that
# matters is the container's (uid 1994, no capabilities, no escalation) and Chromium's own
# sandbox. It ran with --allow-all when it was a Deno process, so Bun's lack of permission flags
# changed nothing here.
#
# --no-env-file: the environment it was given, never a .env from its directory.
set -e
cd /app/packages/browser
# A separate, network-isolated thumbnail deployment selects:
#   bun run src/thumbnail.ts
# Or one stdin HTML -> stdout PNG job (no listening socket or port):
#   bun --no-env-file src/thumbnail_cli.ts
# Never load a .env, including when an explicit Bun command is supplied.
if [ "${1:-}" = bun ]; then
  shift
  exec bun --no-env-file "$@"
fi
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec bun --no-env-file src/main.ts
