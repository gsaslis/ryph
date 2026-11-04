# shellcheck shell=bash
# One `setup-<i>` init container: the step, in the pristine tree, as `sh -c`. Setup runs head code
# (install scripts), and writes what it installs into the tree every check then copies. Its exit
# code is the step's, except that a step's own 125 is reported as 1 (see scripts.ts's header).

set -u
exec 2>&1
# The step's mark, beside the tree rather than in it, so no check copies it.
if ! mkdir "$RYPH_PRISTINE/.ryph-setup-$RYPH_CHECK_STEP_INDEX" 2>/dev/null; then
  started_twice "this setup step"
fi
# Never a step run anywhere but the tree: a tree that cannot be entered is the platform's.
cd "$RYPH_PRISTINE/repo" || exit "$RYPH_PLATFORM_EXIT"
sh -c "$RYPH_CHECK_STEP"
rc=$?
if [ "$rc" -eq "$RYPH_PLATFORM_EXIT" ]; then
  echo "ryph: the setup step exited $RYPH_PLATFORM_EXIT by itself; reported as 1"
  exit 1
fi
exit "$rc"
