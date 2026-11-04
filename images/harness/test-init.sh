#!/bin/bash
# Init regression for the harness's tini, in both of the modes it ever runs in.
#
#   test-init.sh <init>    at build time: the RUN's shell is PID 1 of the build's process
#                          namespace, not tini, so init runs with -s and adopts orphans as a
#                          subreaper
#   worker, signal-worker  run under the image's own init as PID 1, with the ENTRYPOINT's own
#                          flags (images/agent/check_init.ts does this, passing the script's
#                          text to `bash -c`, so $0 is not a path there)
#
# Either way the workers' parent is the init that started them, so they test it, not whatever
# else is PID 1.
set -eu

# Polls of 20ms, up to 10s each: success returns at once, so the budget only bounds a failure,
# and a loaded builder must not turn a slow fork into a failed image build.
tries=500

# As PID 1 a worker would adopt and reap the orphan itself, and its parent would be no init.
if [ "${1:-}" = worker ] || [ "${1:-}" = signal-worker ]; then
  if [ $$ = 1 ]; then
    echo "the worker is PID 1: no init in front of it" >&2
    exit 1
  fi
fi

if [ "${1:-}" = worker ]; then
  # The intermediate shell exits without waiting for its child. The child's parent is then
  # init, not this shell; only init can reap it. kill -0 deliberately counts zombies as present.
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  bash -c 'sleep 0.1 & echo $!' > "$dir/pid"
  pid=$(<"$dir/pid")
  for ((i=0; i<tries; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      exit 42
    fi
    sleep 0.02
  done
  echo "init did not reap orphan $pid" >&2
  exit 1
fi

if [ "${1:-}" = signal-worker ]; then
  # TERM to the init, as a container stop sends it; init must pass it on to its child, this shell.
  trap 'exit 43' TERM
  kill -TERM "$PPID"
  for ((i=0; i<tries; i++)); do sleep 0.02; done
  echo "init did not forward TERM" >&2
  exit 1
fi

init=$1
status=0
"$init" -s -- bash "$0" worker || status=$?
if [ "$status" != 42 ]; then
  echo "init must reap orphans and preserve its child's exit status (got $status)" >&2
  exit 1
fi

# A container's TERM must still reach the runner's graceful-cancellation handler.
status=0
"$init" -s -- bash "$0" signal-worker || status=$?
if [ "$status" != 43 ]; then
  echo "init must forward TERM to its child (got $status)" >&2
  exit 1
fi
