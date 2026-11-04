# shellcheck shell=bash
# One `check-<name>` container when the image baked no checkout of this repo: copy the pristine
# tree, as setup left it, to a private one, then run the check (run-check.sh).
#
# The copy is not a boundary (the checks of one suite all run the same code, so there is nothing to
# wall off); it stops parallel checks that write build output into the tree from colliding. `cp -a`
# keeps mtimes, which is what keeps a setup step's build output fresh to the check's build tool. It
# copies into a directory it has just created, which must not exist: that is also the stage's mark.

set -u
exec 2>&1
if ! mkdir "$RYPH_WORK/repo" 2>/dev/null; then
  started_twice "this check"
fi
pool_start
# A stage the pool watcher can stop: under gVisor what a copy writes is memory.
pool_stage cp -a "$RYPH_PRISTINE/repo/." "$RYPH_WORK/repo/"
rc=$?
pool_stopped
if [ "$rc" -ne 0 ]; then
  echo "ryph: could not copy the tree into $RYPH_WORK"
  exit "$RYPH_PLATFORM_EXIT"
fi
cd "$RYPH_WORK/repo" || exit "$RYPH_PLATFORM_EXIT"
run_check "$RYPH_WORK/.ryph-timed-out"
