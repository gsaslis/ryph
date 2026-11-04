# shellcheck shell=sh
# What Cloud Build's `prepare` step runs (cloud_build.ts `WRITE_SCRIPTS`), on the buildkit image's
# busybox sh: every script the later steps run, written onto the volume from `scriptFiles`'
# arguments. Each file is its path, its chunk count and its chunks, since no one argument may hold
# a whole script; the chunks are written as they are, `%s`, so none is read as a format or a flag.
set -eu
chmod 1777 "$RYPH_WORK"
mkdir -p "$RYPH_WORK/steps"
while [ "$#" -gt 0 ]; do
  f=$1; n=$2; shift 2; : > "$f"
  while [ "$n" -gt 0 ]; do printf %s "$1" >> "$f"; shift; n=$((n - 1)); done
  chmod 0644 "$f"
done
