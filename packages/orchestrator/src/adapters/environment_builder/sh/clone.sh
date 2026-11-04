# shellcheck shell=bash
# Clones every checkout into the current directory, in member order, and writes RYPH_ORDER_FILE.
# Run OUTSIDE the build — on the host by the docker builder, in an init container by the
# kubernetes one, in a step of its own on Cloud Build — with the build's git credential as env
# (`spec.clone.env`), so repo-authored code never shares a process with it.
#
# Its arguments, four per checkout, in member order: the checkout's path, its clone URL, its
# branch and its commit (dockerfile.ts `cloneArgs`). Values reach it as arguments only, never as
# script text, so none of them can be read as shell; `assertBuildable` vouches for their shape.
#
# Full history, one branch: the runner later fetches the run's own commit on top of this clone
# and `git checkout`s it in place, and a shallow clone would make that fetch re-send what the
# image already holds. `reset --hard` rather than a detached checkout, so the baked tree sits on
# the branch it was built from, at exactly the commit the record names.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
clone() {
  echo "ryph: cloning $1 at $4 ($3)"
  git clone --quiet --no-tags --single-branch --branch "$3" -- "$2" "$1"
  if ! git -C "$1" reset --quiet --hard "$4"; then
    echo "ryph: $1: commit $4 is not on branch $3" >&2
    exit 1
  fi
}
if [ $(($# % 4)) -ne 0 ]; then
  echo "ryph: the clone takes four arguments per checkout, not $#" >&2
  exit 1
fi
order=()
while [ "$#" -gt 0 ]; do
  clone "$1" "$2" "$3" "$4"
  order+=("$1")
  shift 4
done
# The empty array's expansion spelled for bash before 4.4, which calls it unbound under -u.
printf '%s\n' ${order[@]+"${order[@]}"} > "$RYPH_ORDER_FILE"
