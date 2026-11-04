#!/usr/bin/env bash
# Fails when an image's compressed size — the sum of its layers as a registry stores them, which
# is what a node pulls — is over budget. The universal image's budget is 4 GB
# (size is a budget, not an accident).
#
#   images/env/universal/check-size.sh localhost:5000/ryph-universal:ci 4000000000
#
# Reads the manifest over the registry's HTTP API, so it needs the image pushed somewhere plain
# HTTP answers (the CI jobs push to a registry service on localhost) and nothing but curl and jq.
# A multi-platform index is resolved to its linux/amd64 manifest, the platform that is published.
set -euo pipefail

ref="${1:?usage: check-size.sh <host/name:tag> <budget-bytes>}"
budget="${2:?usage: check-size.sh <host/name:tag> <budget-bytes>}"
host="${ref%%/*}"
rest="${ref#*/}"
name="${rest%:*}"
tag="${rest##*:}"
accept="application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json"

manifest="$(curl -fsS -H "Accept: $accept" "http://$host/v2/$name/manifests/$tag")"
if [ "$(jq 'has("manifests")' <<<"$manifest")" = true ]; then
  digest="$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest' <<<"$manifest")"
  manifest="$(curl -fsS -H "Accept: $accept" "http://$host/v2/$name/manifests/$digest")"
fi

size="$(jq '[.layers[].size] | add' <<<"$manifest")"
printf '%s: %s bytes compressed (%.2f GB) in %s layers; budget %s bytes\n' \
  "$ref" "$size" "$(bc -l <<<"$size / 1000000000")" "$(jq '.layers | length' <<<"$manifest")" "$budget"
if [ "$size" -gt "$budget" ]; then
  echo "::error::$ref is over its size budget: $size > $budget bytes compressed" >&2
  exit 1
fi
