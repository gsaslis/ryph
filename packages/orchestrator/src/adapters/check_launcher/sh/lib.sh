# shellcheck shell=bash
# Shared by every check-pod script, after the constants header and before the script's own body
# (scripts.ts `script`). Definitions only: nothing here runs until a body calls it.

# A stage's second start: said, and answered with the platform's code (scripts.ts, the header).
started_twice() {
  echo "ryph: $1 was started a second time and did not run again"
  exit "$RYPH_PLATFORM_EXIT"
}
