#!/bin/bash
# Runs the artifact sanitizer supervisor
# (packages/orchestrator/src/adapters/artifact_html/sanitizer_supervisor.ts) in its OWN container,
# beside the control plane's, as its own uid: `sanitizer` (1995), never the control plane's.
#
# WHY A CONTAINER OF ITS OWN. The sanitizer needs a process per publish, killed at its deadline:
# the one way to put a hard limit on a synchronous parse of untrusted HTML. Each one runs under
# `node --permission`, reading its own modules and parse5 and nothing else, but node's permission
# model does not gate process.kill: a sanitizer that shared the control plane's uid could SIGKILL
# or SIGSTOP it. Here it shares neither the uid nor (in a Kubernetes pod or under compose) the PID
# namespace, so the control plane is out of its reach twice over. Nothing secret is in this
# container either: the supervisor starts with an emptied environment.
#
# THE SOCKET. RYPH_ARTIFACT_SANITIZER_SOCKET names it, in a directory on a volume both containers
# mount (the control plane read-only, which is enough to connect). This script makes the
# directory 0750; the supervisor, started with `--group`, refuses it unless only its owner can
# write it and nobody outside its group can enter, and makes the socket 0660 right after it
# listens. The sanitizer GROUP is the one the control plane's uid is a member of, and nothing
# else is. The socket's mode is the readiness signal the startup probe reads.
#
# LIFECYCLE. Bash is PID 1 and waits on the supervisor; SIGTERM and SIGINT are passed on, and if
# the supervisor exits, so does the container, and Kubernetes or compose starts it again. The
# control plane dials the socket per publish, so a restart costs only the publishes in between.
#
# MEMORY. The supervisor and every sanitizer it starts have oom_score_adj 1000 (inherited), so
# under node pressure the kernel kills them first; this container's own memory limit is its own,
# so a sanitizer that hits it no longer takes the control plane with it.
set -euo pipefail
cd /app/packages/orchestrator
bun=$(readlink -f "$(command -v bun)")
socket=${RYPH_ARTIFACT_SANITIZER_SOCKET:?RYPH_ARTIFACT_SANITIZER_SOCKET names the socket}
dir=$(dirname "$socket")

supervisor=""
on_signal() {
  if [ -n "$supervisor" ]; then kill -TERM "$supervisor" 2>/dev/null || true; fi
}
trap on_signal TERM INT

# A restarted container finds its previous directory on the volume: it is this uid's, so remove it.
rm -rf "$dir"
(umask 027 && mkdir "$dir")

# The emptied environment keeps only what says how the sanitizer runs, and only what is set (an
# empty RYPH_ARTIFACT_SANITIZER_CONFINED is not a setting).
keep=(HOME=/opt/ryph-sanitizer PATH="$PATH" NO_COLOR=1)
for name in RYPH_ARTIFACT_SANITIZER_NODE RYPH_ARTIFACT_SANITIZER_CONFINED; do
  if [ -n "${!name+set}" ]; then keep+=("$name=${!name}"); fi
done
(
  echo 1000 >/proc/self/oom_score_adj
  exec env -i "${keep[@]}" \
    "$bun" --no-env-file src/adapters/artifact_html/sanitizer_supervisor.ts "$socket" --group
) &
supervisor=$!

# `wait` returns early when a trapped signal arrives; wait again until the supervisor is gone.
status=0
while kill -0 "$supervisor" 2>/dev/null; do
  wait "$supervisor" || status=$?
done
exit "$status"
