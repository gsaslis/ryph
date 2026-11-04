# shellcheck shell=sh
# `build()`: one `buildctl build`, run again when all that failed was talking to the registry.
#
# A pass that got as far as its push has every layer in this buildkitd's store already, so a
# second run of the same command is cache hits and the push alone: seconds, where failing the
# Job costs the whole build again on a fresh node. Only a push or an authorization failure is
# retried, and only when it is what ENDED the pass: the LAST of BuildKit's own `#<n> ERROR:`
# lines, which must begin `failed to push` or `failed to authorize`. The last, because a cache
# import that could not authorize is an ERROR line too, one BuildKit carries on past, and a step
# that fails after it must not run three times. The beginning, because a failed step's line is
# `ERROR: process "<its command>" …`, and a step's output carries its seconds between `#<n>` and
# the text, so neither a Dockerfile's commands nor what they print can ask for a retry. A step
# that failed would fail the same way, so a build that is broken is reported once. A permanent
# push error (a 403, an invalid manifest) is retried too; it costs two cache-hit passes and 20 s
# before failing with the same error.
#
# The pass's output goes through `tee` so it still streams to the pod log as it runs. buildctl's
# status is written to a file, since the pipeline's status is `tee`'s and ash has no pipefail. A
# `tee` that fails (a full /work, which also holds BuildKit's store) must not end a pass buildctl
# finished, and a status that could not be written is a failure, never a pass taken as built.
#
# The retry notice is not a `ryph:` line, for the reason the buildkitd heading is not.
build() {
  # Confined steps (buildkit.sh): a rule that went missing fails the build before the pass.
  if [ -n "$RYPH_CONFINE_STEPS" ]; then
    stepsConfined || { echo "ryph: the build steps' network is no longer confined" >&2; exit 1; }
  fi
  attempt=1
  while :; do
    rm -f "$RYPH_WORK/out/pass.status"
    { buildctl build --progress=plain --frontend=dockerfile.v0 "$@" 2>&1 && s=0 || s=$?;
      echo "$s" > "$RYPH_WORK/out/pass.status"; } | tee "$RYPH_WORK/out/pass.log" || :
    status=$(cat "$RYPH_WORK/out/pass.status" 2>/dev/null || :)
    [ "${status:-1}" != 0 ] || return 0
    if [ "$attempt" -ge "$RYPH_PUSH_ATTEMPTS" ] ||
      ! grep -E '^#[0-9]+ ERROR: ' "$RYPH_WORK/out/pass.log" | tail -n 1 |
        grep -qE '^#[0-9]+ ERROR: failed to (push|authorize)'; then
      return "${status:-1}"
    fi
    attempt=$((attempt+1))
    echo "== the push failed; pushing again (attempt $attempt of $RYPH_PUSH_ATTEMPTS) ==" >&2
    sleep 10
  done
}
