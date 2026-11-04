#!/bin/sh
# The credential helper the buildkit container installs when the registry is authenticated by
# Workload Identity (buildkit.sh). Docker's helper protocol, answered from the metadata server.
# buildctl keeps an answer for a few minutes (4m50s in v0.32.2), not the whole build, so a push at
# the end of a long build never presents a token fetched at its start. The proxy is bypassed: the
# metadata server is link-local and no egress claim names it.
#
# Each ask is cut off and tried again. BuildKit gives an authorization 60 s (`sessionAuthTimeout`
# in v0.32.2), and that covers this helper AND the token exchange with the registry after it,
# which goes through the proxy. Two re-layers on GKE died on
# `failed to authorize: DeadlineExceeded` after building and pushing every layer, and the log
# cannot say which half stalled. A metadata request with no timeout was one way, and is closed
# here; the other is what `build()` (build.sh) retries.
#
# busybox's sh and wget: the buildkit image is Alpine. Installed as written here, less these
# comments (buildkit.sh), so the ask stays on one line.
[ "$1" = get ] || exit 0
read -r server
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
token=
# shellcheck disable=SC2034 # a count of tries; which one it is does not matter
for attempt in 1 2 3; do
  token=$(wget -q -T 5 -O - --header 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p') || token=
  [ -z "$token" ] || break
  sleep 1
done
[ -n "$token" ] || { echo "ryph: no token from the metadata server" >&2; exit 1; }
printf '{"ServerURL":"%s","Username":"oauth2accesstoken","Secret":"%s"}\n' "$server" "$token"
