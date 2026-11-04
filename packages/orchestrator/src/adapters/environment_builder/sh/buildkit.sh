# shellcheck shell=sh
# The start of every BuildKit script (buildkit_script.ts `buildScript`), after its constants
# header: the work volume's output directory, the registry's credential helper, and ONE buildkitd
# for the whole script, ready, with the build steps' network confined when the backend asks for
# it. busybox's sh: the buildkit image is Alpine, on both backends.
#
# ONE buildkitd, and `build()` (build.sh) against it. Upstream's `buildctl-daemonless.sh` starts
# a buildkitd per `buildctl` and kills it when the command returns. MEASURED (locally, v0.32.2
# rootless, `native`, 2026-09-20): a daemon per pass costs this build nothing BY ITSELF — given a
# GC policy the build does not cross, four passes over a 1.9GB base re-extracted not one layer,
# and the last two took a second each. What it costs is control. The daemon that decides whether
# the next pass finds the layers the last one extracted is the one whose garbage collector ran in
# between (see kubernetes.ts `gcKeepStorage`, which is the fix), and a daemon started inside a
# helper script is not one this script can hand a config to, wait on, or get a log out of when it
# dies. Started here, once, it is all three — and its start-up, its worker scan and its boltdb
# open happen once instead of four times.
#
# Readiness is `buildctl debug workers` until it answers, as upstream's script does, and a daemon
# that dies first ends the build with its log rather than the retry loop's silence.

set -eu
mkdir -p "$RYPH_WORK/out"
# Workload Identity's token, through the helper (docker-credential-ryph-gke.sh), for the
# registries' hosts alone (RYPH_DOCKER_CONFIG_JSON), or no helper for a registry that needs none.
if [ -n "$RYPH_DOCKER_CONFIG_JSON" ]; then
  mkdir -p "$RYPH_WORK/bin" "$RYPH_WORK/docker"
  printf '%s\n' "$RYPH_CREDENTIAL_HELPER" > "$RYPH_WORK/bin/docker-credential-ryph-gke"
  chmod 0755 "$RYPH_WORK/bin/docker-credential-ryph-gke"
  printf '%s\n' "$RYPH_DOCKER_CONFIG_JSON" > "$RYPH_WORK/docker/config.json"
  export PATH="$RYPH_WORK/bin:$PATH" DOCKER_CONFIG="$RYPH_WORK/docker"
fi
digest() { sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$1" | head -n 1; }
# Confined, build steps run on a bridge of their own. The one resolver a step may reach is the
# metadata server's: the worker's own is a localhost stub the bridge cannot use. Names it resolves
# are public ones, as kube-dns is to a run.
if [ -n "$RYPH_CONFINE_STEPS" ]; then
  cat > "$RYPH_WORK/buildkitd.toml" <<TOML
[worker.oci]
  networkMode = "bridge"
  bridgeName = "$RYPH_STEP_BRIDGE"
  bridgeSubnet = "$RYPH_STEP_SUBNET"
[dns]
  nameservers = ["169.254.169.254"]
TOML
fi
# Rootless: under rootlesskit, as the image's own user, which is what a pod without privileges
# allows. Rootful: as root, which a Cloud Build step is.
if [ "$RYPH_DAEMON" = rootless ]; then
  export BUILDKIT_HOST="unix://${XDG_RUNTIME_DIR:-/run/user/$RYPH_BUILDKIT_UID}/buildkit/buildkitd.sock"
  set -- rootlesskit buildkitd
else
  export BUILDKIT_HOST="unix:///run/buildkit/buildkitd.sock"
  set -- buildkitd
fi
# $BUILDKITD_FLAGS is the backend's (the snapshotter, the process sandbox, the GC policy);
# unquoted, so it splits into words the way buildctl-daemonless.sh splits it.
# shellcheck disable=SC2086 # split on purpose, see above
set -- "$@" ${BUILDKITD_FLAGS:-}
[ -z "$RYPH_CONFINE_STEPS" ] || set -- "$@" --config="$RYPH_WORK/buildkitd.toml"
"$@" --addr="$BUILDKIT_HOST" > "$RYPH_WORK/out/buildkitd.log" 2>&1 &
buildkitd_pid=$!
# What the build left on the volume, on every ending: the one number that says whether the
# GC policy was the right size for this repo. Not a `ryph:` line, for the reason the heading
# below is not one either.
usage() { df -Pm "$RYPH_WORK" | awk 'NR==2 {print "== work volume " $3 "MB used of " $2 "MB"}' >&2; }
# Whatever ends the script ends the daemon, and a failure takes buildkitd's own log with it:
# a push that could not authenticate or a worker that died says so there and nowhere else.
# The heading is not a `ryph:` line: `failureLine` reads the LAST of those as the reason a build
# failed, and the reason is what the build printed, not this heading.
# shellcheck disable=SC2154 # `status` is assigned first thing in the trap itself
trap 'status=$?; usage || true; kill "$buildkitd_pid" 2>/dev/null || true;
  wait "$buildkitd_pid" 2>/dev/null || true;
  if [ "$status" != 0 ]; then echo "== buildkitd log ==" >&2;
  tail -n 50 "$RYPH_WORK/out/buildkitd.log" >&2 || true; fi; exit "$status"' EXIT
ready=
tries=0
while [ "$tries" -lt "$RYPH_BUILDKITD_READY_SECONDS" ]; do
  if buildctl debug workers >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$buildkitd_pid" 2>/dev/null; then break; fi
  sleep 1
  tries=$((tries+1))
done
[ -n "$ready" ] || { echo "ryph: buildkitd did not start" >&2; exit 1; }
# The step bridge's firewall, set before any step runs. Its own chain in the `mangle` table,
# jumped to from PREROUTING for everything that arrives from the bridge: the proxy
# (RYPH_STEP_PROXY_HOST, none when the build has no way out) and the metadata server's resolver
# on port 53 go on, everything else — the internet, Google's APIs, the metadata server's token,
# the step container itself — is dropped.
#
# `mangle`, not `filter`: BuildKit's bridge network is CNI's, and CNI writes FORWARD rules of its
# own, inserting its jump at the top whenever it finds it missing — which it does on the first
# step network it makes, after these rules could have gone in. Nothing CNI does touches `mangle`,
# and PREROUTING sees a step's packet before any of it. `stepsConfined` is checked before every
# pass (build.sh), so a rule that went missing fails the build rather than running a step
# unconfined. MEASURED locally (v0.32.2, bridge mode, 2026-09-29): the allowed address answered,
# another public one and the metadata server's token endpoint timed out.
# shellcheck disable=SC2153 # RYPH_STEP_PROXY_PORT is the header's, not a misspelling of _HOST
if [ -n "$RYPH_CONFINE_STEPS" ]; then
  { iptables -t mangle -N "$RYPH_STEP_CHAIN" &&
    { [ -z "$RYPH_STEP_PROXY_HOST" ] ||
      iptables -t mangle -A "$RYPH_STEP_CHAIN" -d "$RYPH_STEP_PROXY_HOST" -p tcp \
        --dport "$RYPH_STEP_PROXY_PORT" -j RETURN; } &&
    iptables -t mangle -A "$RYPH_STEP_CHAIN" -d 169.254.169.254 -p udp --dport 53 -j RETURN &&
    iptables -t mangle -A "$RYPH_STEP_CHAIN" -d 169.254.169.254 -p tcp --dport 53 -j RETURN &&
    iptables -t mangle -A "$RYPH_STEP_CHAIN" -j DROP &&
    iptables -t mangle -I PREROUTING 1 -i "$RYPH_STEP_BRIDGE" -j "$RYPH_STEP_CHAIN"; } ||
    { echo "ryph: the build steps' network could not be confined" >&2; exit 1; }
  stepsConfined() {
    iptables -t mangle -C PREROUTING -i "$RYPH_STEP_BRIDGE" -j "$RYPH_STEP_CHAIN" 2>/dev/null &&
      iptables -t mangle -C "$RYPH_STEP_CHAIN" -j DROP 2>/dev/null
  }
fi
