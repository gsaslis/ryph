# shellcheck shell=bash
# The end of every check script, `run_check <mark>` in the tree it is to run in: wait for the
# services, then run the check as `sh -c` under its timeout. Never returns: the container's exit
# code IS the verdict. 0 passed, 124 timed out, 125 the platform's part failed (the tree, a
# service that never answered, a second start), 122 stopped for the pool (pool.sh), anything else
# failed. A command that exits 122, 124 or 125 by itself is reported as 1, so none of them can be
# claimed by the head. A check the timeout marked is 124 even if the pool stopped it in the
# timeout's grace: it was already over.
#
# The timeout is a bash watchdog, the same on every image (scripts.ts's header says why not
# `timeout`): the command in a process group of its own, and at the timeout the watchdog writes a
# mark, TERMs the group and KILLs it after the grace. The mark (`<mark>`, a path) is the one fact
# 124 rests on, and lives outside the tree the check works in. A command that fails a moment
# before its time is its own failure, and a command that catches the TERM and exits 0 still ran
# out of time.

# The wait is a stage too (`pool_stage`): a check whose tree runs the pool short is stopped
# while it waits, as at any other moment.
wait_services() {
  for svc in ${RYPH_CHECK_SERVICES:-}; do
    host="${svc%:*}"; port="${svc##*:}"; waited=0
    until (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
      if [ "$waited" -ge "$RYPH_SERVICE_WAIT_SECONDS" ]; then
        echo "ryph: service $host did not accept connections on port $port" \
          "within ${RYPH_SERVICE_WAIT_SECONDS}s"
        return 1
      fi
      sleep 1; waited=$((waited + 1))
    done
  done
}
run_check() {
  pool_stage wait_services
  rc=$?
  pool_stopped
  if [ "$rc" -ne 0 ]; then exit "$RYPH_PLATFORM_EXIT"; fi
  t="$RYPH_CHECK_TIMEOUT"
  mark=$1
  rm -f "$mark"
  set -m
  sh -c "$RYPH_CHECK_RUN" &
  pid=$!
  pool_go "$pid"
  # The watchdog is a process group of its own too (`set -m`), and holds no stream of the log:
  # ending it ends its sleep, and nothing keeps the container's output open behind it. Only a
  # sleep that ran its full time marks: a sleep ended by a signal (ours, as the group ends, can
  # reach it a moment before the subshell) once marked a check that passed in a second as timed
  # out.
  (
    sleep "$t" || exit
    : >"$mark"
    kill -TERM -- "-$pid" 2>/dev/null
    sleep "$RYPH_KILL_AFTER_SECONDS"
    kill -KILL -- "-$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  dog=$!
  # Both groups are made by now. Job control off before the wait, or bash prints the check's
  # "Done" line into its log when it ends.
  set +m
  wait "$pid"
  rc=$?
  # KILL, to the group or to the watchdog itself when its group is not made yet. A check that
  # ends at once can end it the moment after its fork, when under gVisor its group can be missing,
  # and a TERM there can be lost in bash's handler (the EXIT trap's, pool.sh's `pool_end`): either
  # way the watchdog would sleep out the timeout and mark a check that passed as timed out.
  kill -KILL -- "-$dog" 2>/dev/null || kill -KILL "$dog" 2>/dev/null
  # Reaped here, or bash says "Killed" for it in the log at its next command.
  wait "$dog" 2>/dev/null
  if [ -e "$mark" ]; then
    echo "ryph: timed out after ${t}s"
    exit 124
  fi
  pool_stopped
  if [ "$rc" -eq 124 ] || [ "$rc" -eq "$RYPH_PLATFORM_EXIT" ] ||
    [ "$rc" -eq "$RYPH_POOL_EXIT" ]; then
    echo "ryph: the check exited $rc by itself, inside its time; reported as 1"
    exit 1
  fi
  exit "$rc"
}
