# shellcheck shell=sh
# The end of every BuildKit script, once its passes are built: the result, into a file first.
# Printed for a backend that reads its container's log (kubernetes), and handed to Cloud Build as
# the step's output, which is what that backend reads — a log in a bucket is something a build's
# own identity could write.
#
# Every key, every build, exactly once — `none` where it has no value — so a line that is not the
# script's is always a second one, and fails the read (buildkit_script.ts `readScriptResult`).
# shellcheck disable=SC2154 # machine_digest and warm are set by the passes, which
# buildkit_script.ts writes between build.sh and this file
{
  echo "$RYPH_RESULT_MARKER digest $(digest "$RYPH_WORK/out/environment.json")"
  # A re-layer builds no baked stage: it carries the one it was given.
  if [ -n "$RYPH_RELAYER" ]; then
    echo "$RYPH_RESULT_MARKER baked none"
  else
    echo "$RYPH_RESULT_MARKER baked $(digest "$RYPH_WORK/out/baked.json")"
  fi
  # The machine this build pushed, so retention can delete it by digest rather than trust a tag
  # to say which version it was. None when the machine is the universal image.
  if [ -n "$RYPH_MACHINE_PUSHED" ]; then
    echo "$RYPH_RESULT_MARKER machine $machine_digest"
  else
    echo "$RYPH_RESULT_MARKER machine none"
  fi
  # Whether an incremental build really built on its image: `warm` is the passes' (0 or 1).
  if [ -n "$RYPH_INCREMENTAL" ]; then
    echo "$RYPH_RESULT_MARKER warm $warm"
  else
    echo "$RYPH_RESULT_MARKER warm none"
  fi
  # JSON through `printf '%s'`, never `echo`: a dash `echo` expands the `\n` a JSON string
  # escapes a newline as, and the line would break in two.
  printf '%s toolchains %s\n' "$RYPH_RESULT_MARKER" \
    "$(tr -d '\n' < "$RYPH_WORK/out/toolchains/$RYPH_TOOLCHAINS_FILE")"
  # Last, and bounded by ryph-bake (`MAX_SETUP_WARNINGS_BYTES`): Cloud Build keeps only the
  # first 4 KiB of a step's output, and a cut here may cost the warnings but never a digest.
  # The lines before it are bounded too — three digests, `warm`, and the toolchains, each
  # version clipped by ryph-bake (`versionOf`) — so they and this fit in the 4 KiB. Printed
  # every build, `[]` with no file (an image baked before it existed): a line cut short, or
  # missing, reads as unreadable rather than as clean (`readScriptResult`).
  if [ -f "$RYPH_WORK/out/toolchains/$RYPH_SETUP_WARNINGS_FILE" ]; then
    printf '%s setup-warnings %s\n' "$RYPH_RESULT_MARKER" \
      "$(tr -d '\n' < "$RYPH_WORK/out/toolchains/$RYPH_SETUP_WARNINGS_FILE")"
  else
    echo "$RYPH_RESULT_MARKER setup-warnings []"
  fi
} > "$RYPH_WORK/out/result"
cat "$RYPH_WORK/out/result"
[ -z "${BUILDER_OUTPUT:-}" ] || cp "$RYPH_WORK/out/result" "$BUILDER_OUTPUT/output"
