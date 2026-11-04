#!/bin/sh
# Brings RAD_HOME to the state the node expects and then BECOMES the node.
#
# `radicle-node`, never `rad node start`: that one forks a daemon and returns, which under an
# init system that expects PID 1 to be the process means the container exits the moment the
# shell does. --force lets it take over a control socket left behind by an unclean stop; the
# volume is ours alone, so there is no other node it could be stealing from.
#
# Everything below is idempotent. The volume survives restarts, and the identity in it must too:
# a second boot reuses the key and therefore the NID, which is what every patch this deployment
# ever pushed is signed with.
set -e

RAD_HOME="${RAD_HOME:-/data/radicle}"
export RAD_HOME
# ALWAYS exported, even empty. `rad auth` reads this variable and, when it is unset, falls back
# to prompting on a terminal that a container does not have. Empty (the compose default) means
# an unencrypted key; a deployment that sets it gets an encrypted one, and the same value must
# reach the bridge container or it cannot sign.
export RAD_PASSPHRASE="${RAD_PASSPHRASE-}"

alias_name="${RYPH_RADICLE_ALIAS:-ryph}"
# heartwood's own defaults, crates/radicle/src/node/config.rs (`RADICLE_NODE_BOOTSTRAP_IRIS`
# and `_ROSA`). Named here rather than left to `rad`'s default so that overriding them is one
# variable and not an edited file — a private network sets RYPH_RADICLE_CONNECT and reaches
# nothing public.
default_seeds='z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.network:8776,z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.network:8776'
connect="${RYPH_RADICLE_CONNECT:-$default_seeds}"
external="${RYPH_RADICLE_EXTERNAL_ADDRESS:-}"

mkdir -p "$RAD_HOME/keys"

# ── the identity ────────────────────────────────────────────────────────────────────────────
if [ ! -f "$RAD_HOME/keys/radicle" ]; then
  if [ -f /run/secrets/radicle/radicle ]; then
    # The provisioned path. A Secret is the only way the NID survives losing this volume, which
    # is why a real deployment mounts one (deploy/helm/ryph/templates/radicle.yaml).
    echo "radicle: installing the key pair from /run/secrets/radicle"
    install -m 0600 /run/secrets/radicle/radicle "$RAD_HOME/keys/radicle"
    install -m 0644 /run/secrets/radicle/radicle.pub "$RAD_HOME/keys/radicle.pub"
  else
    echo "radicle: no key at $RAD_HOME/keys/radicle and no Secret mounted — generating one"
    rad auth --alias "$alias_name"
  fi
fi

# `rad auth` writes this on the generated path; the provisioned one arrives without it.
if [ ! -f "$RAD_HOME/config.json" ]; then
  rad config init --alias "$alias_name"
fi

# ── the configuration ───────────────────────────────────────────────────────────────────────
# Rewritten from the environment on EVERY boot, deliberately: this file is derived state, and a
# container whose config drifts from the variables it was launched with is a container nobody
# can reason about. Anything not named here (limits, workers, log level, the explorer template)
# keeps whatever `rad config init` chose.
#
# seedingPolicy stays `block`, which is also upstream's default and is load-bearing either way:
# the bridge seeds each connected repo explicitly, with scope `all` so a stranger's `/ryph`
# comment is fetched. A node that allowed by default would pull in every repo it heard of.
to_json_array() {
  printf '%s' "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d' \
    | jq -R . | jq -s .
}
connect_json="$(to_json_array "$connect")"
external_json="$(to_json_array "$external")"

tmp="$RAD_HOME/config.json.tmp"
jq \
  --arg alias "$alias_name" \
  --argjson connect "$connect_json" \
  --argjson external "$external_json" \
  '.node.alias = $alias
   | .node.seedingPolicy = { "default": "block" }
   | .node.connect = $connect
   | .node.externalAddresses = $external
   | .preferredSeeds = $connect' \
  "$RAD_HOME/config.json" > "$tmp"
mv "$tmp" "$RAD_HOME/config.json"

# The NID is deliberately not printed here: every way to ask for it before the node is up is
# deprecated or needs the control socket, and `radicle-node` announces "Node ID is …" on its
# first line anyway.
echo "radicle: alias=${alias_name} seeds=$(printf '%s' "$connect_json" | jq -r 'length') external=$(printf '%s' "$external_json" | jq -r 'length')"

# 0.0.0.0, not the config's `listen`: what is reachable is the deployment's decision (a
# NetworkPolicy, a published port), not this process's, and binding loopback inside a pod means
# the sidecar cannot reach it either.
exec radicle-node --listen 0.0.0.0:8776 --force
