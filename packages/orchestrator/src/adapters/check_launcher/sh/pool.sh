# shellcheck shell=bash
# The pool watcher, started in every check container right after the stage's mark, before the
# tree is made (`pool_start`): the policy in scripts.ts's header, run by each check for itself.
# Every POOL_TICK_SECONDS it
# - reads its own container's memory use: cgroup v2's `memory.current` less `inactive_file`, or
#   v1's `memory.usage_in_bytes` less `total_inactive_file` where `memory.stat` has it. Page cache
#   the kernel can drop is not use. Under gVisor the v1 file is exact per container, and writes to
#   the container's own filesystem count in it (gVisor keeps them in memory), which is why a baked
#   check's tree is part of its use
# - publishes it, with the time, as `<at> <bytes>` in `<pool>/<name>/use`: written beside and
#   renamed into place, so a reader never sees half a line. That directory is its own volume,
#   mounted read-write in this container alone, so only this check's own head can get in the way
#   of the publish, and a publish that fails only costs this tick
# - reads the file of every OTHER check of the suite (RYPH_CHECK_NAMES: no other name counts),
#   skipping any older than POOL_STALE_SECONDS (a container that died cannot remove its own), and
#   sums them with its own use: the pool's use
# - when that use is POOL_SHORT_PERCENT of the pool or more, and this check is over its own share
#   and the furthest over of all (ties: the first name), it stops what it is running: TERMs the
#   process group running now and KILLs it after POOL_KILL_AFTER_SECONDS. A check at or under its
#   share is never the one. Shares are equal, so every check is measured against this check's
#   own, from its env. Two watchers judging a moment apart can both find themselves the victim,
#   rarely; there is no lock, and the second stop only frees more
#
# A sibling's directory is mounted read-only here, but what is in it is the sibling's to choose:
# a FIFO, a link to /dev/zero or to a path in THIS container, a file of any size. So a check's
# verdict on itself rests on its own numbers (its use as it just read it, its share from its env),
# and the files only ever stand for the others' use. Each is opened read-only (an open creates
# nothing where a link points), read only when the open descriptor is a regular file (asked of
# /proc/self/fd where there is one, of the path otherwise), 80 bytes at most, and counts
# only as two plain numbers. One reader child per tick reads every file in turn and is killed
# after a second (a FIFO's open blocks); the first name it reads moves on each tick, so a sibling
# that blocks it costs the files after it that tick only. A sibling can lie in its own file: a
# huge claim makes it the furthest over itself, so no other check is stopped for it, and a claim
# of its share adds no more than it was entitled to. It can leave the others less room to borrow
# in, but never make a check within its share stop itself.
#
# It watches from container start, not from the check's start: a baked check's move and setup
# steps write its tree into its memory, and a pool run short by setup is as short as one run
# short by the check. Every stage of the container after the mark runs as a process group of its
# own (`pool_stage`, or the check's in `run_check`), so there is always something to stop: the
# copy or the move, the fallback's copy, a setup step, the wait for the services, the check. What
# runs at that moment is stopped, and the check fails with 122 and the line its log ends on.
#
# The stop's mark is written only once the TERM reached a live group, and names the group it
# reached: the stage waited on is failed for it only when the mark names that stage
# (`pool_stopped`). A mark that stopped nothing, or only what a finished stage left behind, would
# otherwise fail the check later for a moment it was not even running, even after it passed. It,
# the running group's id and the reader's FIFO live in a directory of the container's own, not
# in the tree, which a failed move removes and the head writes: made fresh at start, 0700, in
# POOL_CONTROL (the container's own /tmp; never one that is a link). One already there is never
# used. The watcher marks `stopping` before the TERM and clears it after the mark, so the script,
# whose stage the TERM just ended, waits for the verdict rather than read the mark a moment early.
#
# The watcher is cooperative. The head runs as the same user in the same container, so it can kill
# its watcher, or lie to the others about itself: that loses its own check the protection, and the
# backend's caps are the real bound (see docs/checks.md, "One memory pool").
#
# Nothing is watched when the suite has no pool (no memory in the class and no cap: the env is
# unset). A container whose pool is not set up (no directory of its own, or a list of the suite's
# checks without its name), whose memory use cannot be read, whose control directory or FIFO
# cannot be made, or whose own directory cannot be written, says so once and runs unwatched:
# never a failure of the check. The watcher writes nothing to the log and holds none of its
# streams; the script prints the mark's line itself, in order.

# A plain count: digits, no leading zero (bash would read it as octal, and `08` as an error
# that ends the watcher), and few enough that a sum of them stays inside bash's 64 bits.
pool_num() { case "$1" in "" | *[!0-9]* | 0?*) return 1 ;; esac; [ "${#1}" -le 18 ]; }
# A check's name as the platform gives it: never a path (CHECK_NAME).
pool_word() { case "$1" in "" | *[!a-z0-9-]*) return 1 ;; esac; }
# The suite's other checks, the only directories of the pool read. Its own name must be among
# them: a list without it was not set up for this check.
pool_peers() {
  local n listed=
  pool_word "$pool_name" || return 1
  for n in $pool_names; do
    if [ "$n" = "$pool_name" ]; then listed=1; elif pool_word "$n"; then pool_others+=("$n"); fi
  done
  [ -n "$listed" ]
}
# `printf '%(%s)T'` is bash 4.2's; an older bash (macOS's 3.2) asks `date`.
pool_now() {
  printf -v pool_t '%(%s)T' -1 2>/dev/null || pool_t="$(date +%s)"
  pool_num "$pool_t" || pool_t=0
}
pool_used() {
  local used="" inactive=0 stat="" want="" key="" value=""
  if [ -r "$RYPH_CGROUP/memory.current" ]; then
    read -r used <"$RYPH_CGROUP/memory.current"
    stat="$RYPH_CGROUP/memory.stat" want=inactive_file
  elif [ -r "$RYPH_CGROUP/memory/memory.usage_in_bytes" ]; then
    read -r used <"$RYPH_CGROUP/memory/memory.usage_in_bytes"
    stat="$RYPH_CGROUP/memory/memory.stat" want=total_inactive_file
  fi
  pool_num "$used" || return 1
  if [ -r "$stat" ]; then
    while read -r key value; do
      if [ "$key" = "$want" ] && pool_num "$value"; then inactive=$value; fi
    done <"$stat"
  fi
  pool_mine=$((10#$used > 10#$inactive ? 10#$used - 10#$inactive : 0))
}
# Its own directory is written by this container alone: written beside, renamed into place.
pool_publish() {
  printf '%s %s\n' "$pool_t" "$pool_mine" >"$pool_own/.use" &&
    mv -f "$pool_own/.use" "$pool_own/use"
}
# One other check's file, already opened read-only as fd 3 (an open creates nothing where a
# link points), read only when what is open is a regular file: asked of the descriptor itself
# where /proc has it, of the path otherwise. 80 bytes at most, counted by `head`, never by
# `read -n`: bash drops a NUL without counting it, so a sparse file of NULs (no blocks, past
# any size limit) would hold `read` for the whole second, and a device swapped in after the
# look at the path costs 80 bytes too. Only two plain numbers count, appended with its name
# to this tick's list in the watcher's own directory, in one write.
pool_read_one() {
  local line=""
  { exec 3<"$2"; } 2>/dev/null || return 0
  if [ -n "$pool_proc" ]; then [ -f /proc/self/fd/3 ]; else [ -f "$2" ] && [ ! -L "$2" ]; fi &&
    line=$(head -c 80 <&3)
  exec 3<&-
  [[ "$line" =~ ^[0-9]+\ [0-9]+$ ]] || line=""
  [ -z "$line" ] || printf '%s %s\n' "$1" "$line" >>"$pool_ctl/seen"
}
# The reader: every name given, in turn, skipping anything that is not plainly a file before
# it opens it, then says the tick is done on the watcher's FIFO.
pool_read_all() {
  local n
  for n in "$@"; do
    [ -f "$pool/$n/use" ] && [ ! -L "$pool/$n/use" ] && pool_read_one "$n" "$pool/$n/use"
  done
  echo "$pool_tick" >&7
}
# One reader child per tick, waited on for a second at most and killed after (a FIFO's open
# blocks until a writer comes). The first name read moves on each tick, so a file that holds
# the reader up costs only the names after it, and only that tick.
pool_gather() {
  local k=${#pool_others[@]} at child got=""
  : >"$pool_ctl/seen" 2>/dev/null || return 0
  [ "$k" -gt 0 ] || return 0
  pool_tick=$((pool_tick + 1)) at=$((pool_tick % k))
  pool_read_all "${pool_others[@]:at}" "${pool_others[@]:0:at}" </dev/null 2>/dev/null &
  child=$!
  # A line of an earlier tick's reader, killed just after it wrote, is passed over.
  while [ "$got" != "$pool_tick" ] && read -t 1 -r -u 7 got; do :; done
  [ "$got" = "$pool_tick" ] || kill -KILL "$child" 2>/dev/null
  wait "$child" 2>/dev/null
}
# Stops the group running now, if one is. The mark only once the TERM reached it, naming it.
# A group already gone is passed over before `stopping`: its stage would wait on nothing.
pool_halt() {
  local target=""
  { read -t 1 -r target <"$pool_target"; } 2>/dev/null
  pool_num "$target" || return 0
  kill -0 -- "-$target" 2>/dev/null || return 0
  : >"$pool_stopping" || return 0
  if kill -TERM -- "-$target" 2>/dev/null; then
    # One line, whose words echo joins with a space each.
    { echo "$target"; echo "ryph: stopped: the suite's checks were using $(($1 / 1048576))MiB" \
      "of their $((pool_size / 1048576))MiB of memory, and this check was the furthest over" \
      "its share, using $((pool_mine / 1048576))MiB against a share of" \
      "$((pool_share / 1048576))MiB"; } >"$pool_stop"
    rm -f "$pool_stopping"
    sleep "$RYPH_POOL_KILL_AFTER_SECONDS"
    kill -KILL -- "-$target" 2>/dev/null
  else
    rm -f "$pool_stopping"
  fi
}
pool_watch() {
  local n at use rest total over worst victim
  # Names compare bytewise, whatever locale the image sets.
  LC_ALL=C
  # Where the reader says it is done: opened read-write, so the open never waits for a writer.
  exec 7<>"$pool_ctl/done" || return
  while :; do
    pool_now
    # No reading of its own this tick: no publish and no verdict.
    if pool_used; then
      pool_publish 2>/dev/null
      # Its own entry from memory, never from its file.
      total=$pool_mine over=$((pool_mine - pool_share)) worst=0 victim=""
      if [ "$over" -gt 0 ]; then victim=$pool_name worst=$over; fi
      pool_gather
      if [ -f "$pool_ctl/seen" ]; then
        while read -r n at use rest; do
          # shellcheck disable=SC2015 # not an if-else: any test that fails skips the line
          [ -z "$rest" ] && pool_num "$at" && pool_num "$use" || continue
          at=$((10#$at)) use=$((10#$use))
          if [ $((pool_t - at)) -gt "$RYPH_POOL_STALE_SECONDS" ] ||
            [ $((at - pool_t)) -gt "$RYPH_POOL_STALE_SECONDS" ]; then continue; fi
          # No check holds more than the pool: a claim past it counts as the pool, so no sum
          # overflows.
          [ "$use" -le "$pool_size" ] || use=$pool_size
          total=$((total + use)) over=$((use - pool_share))
          if [ "$over" -gt 0 ] && { [ "$over" -gt "$worst" ] ||
            { [ "$over" -eq "$worst" ] && [[ "$n" < "$victim" ]]; }; }; then
            victim=$n worst=$over
          fi
        done <"$pool_ctl/seen"
      fi
      if [ "$victim" = "$pool_name" ] &&
        [ $((total * 100)) -ge $((pool_size * RYPH_POOL_SHORT_PERCENT)) ]; then
        pool_halt "$total"
      fi
    fi
    sleep "$RYPH_POOL_TICK_SECONDS"
  done
}
# The group running now, for the watcher to stop, and the one the next `pool_stopped` judges.
# Quiet when the head removed the watcher's directory: that is its own check's loss.
pool_go() { pool_last=$1; [ -z "$pool_dog" ] || { echo "$1" >"$pool_target"; } 2>/dev/null; }
# One stage of the container: "$@" as a process group of its own, the one the watcher stops,
# waited on; its exit code is the stage's. Job control is off again before the wait, or bash
# prints the stage's "Done" line into the log, and the wait's own notice of a stopped stage
# goes nowhere: the stop's line says it.
pool_stage() {
  local pid
  set -m
  "$@" &
  pid=$!
  set +m
  pool_go "$pid"
  wait "$pid" 2>/dev/null
}
# After every stage: one the watcher stopped ends the check with 122 and the mark's line. A
# stop under way (`stopping`) is waited for, a few seconds at most: the watcher marks it in
# the moment after its TERM landed. A mark that names any group but the stage just waited on
# (one a finished stage left running, stopped after its own look) is dropped: the stage it
# would fail is not the one it stopped. Each stage is judged once.
pool_stopped() {
  [ -n "$pool_dog" ] || return 0
  rm -f "$pool_target" 2>/dev/null
  local waited=0 whom="" line="" last=$pool_last
  pool_last=""
  while [ -e "$pool_stopping" ] && [ "$waited" -lt 5 ]; do sleep 1; waited=$((waited + 1)); done
  [ -f "$pool_stop" ] || return 0
  { { read -r whom; IFS= read -r line; } <"$pool_stop"; } 2>/dev/null
  if [ -n "$last" ] && [ "$whom" = "$last" ]; then
    printf '%s\n' "$line"
    exit "$RYPH_POOL_EXIT"
  fi
  rm -f "$pool_stop" 2>/dev/null
}
# The container's own directory for the mark, the group's id and the reader's FIFO: made
# fresh, 0700, in the container's own /tmp, outside the tree a failed move removes, before any
# head code runs. A /tmp that is a link is refused, and so is a name already taken (an image
# could leave either).
pool_private() {
  local base="$RYPH_POOL_CONTROL"
  [ -d "$base" ] && [ ! -L "$base" ] || return 1
  pool_ctl="$base/.ryph-pool-$$-$RANDOM"
  mkdir -m 700 "$pool_ctl" 2>/dev/null || { pool_ctl=""; return 1; }
  pool_stop="$pool_ctl/stop" pool_stopping="$pool_ctl/stopping" pool_target="$pool_ctl/target"
}
# The watcher goes before the file does, so it cannot publish it again behind the removal.
#
# The script's own process only. A child the script just forked keeps bash's handler for TERM
# (which an EXIT trap installs) until it resets its signals, and a TERM landing in that moment (the
# watcher's, at a stage it just named) runs this trap in the child: under gVisor it killed the
# watcher and removed the stop mark, and the check failed with the TERM's 143 instead of 122. Here
# the child does nothing and dies of the TERM, as the stage would have. `$BASHPID` is bash 4's;
# macOS's 3.2 asks a `sh` whose parent is this process.
#
# The watcher's group, or the watcher itself when that group is not made yet: under gVisor, the
# moment after the fork, it can be missing, and a TERM sent to nothing would leave the wait below
# waiting on a watcher that never ends.
pool_end() {
  [ -n "$pool_dog" ] || return 0
  [ "${BASHPID:-$(exec sh -c 'echo "$PPID"')}" = "$$" ] || return 0
  kill -- "-$pool_dog" 2>/dev/null || kill "$pool_dog" 2>/dev/null
  wait "$pool_dog" 2>/dev/null
  rm -f "$pool_own/use" "$pool_own/.use" 2>/dev/null
  rm -rf "$pool_ctl" 2>/dev/null
}
# The watcher's state, then the watcher itself when the suite has a pool and this container can
# take part in it. Every variable here is the script's own (none is `local`): `pool_go`,
# `pool_stopped` and `pool_end` read them for the rest of the script.
pool_start() {
  pool_dog="" pool_last="" pool_ctl="" pool_own="" pool_proc="" pool_tick=0 pool_others=()
  pool="${RYPH_CHECK_POOL:-}"
  pool_name="${RYPH_CHECK_NAME:-}"
  pool_names="${RYPH_CHECK_NAMES:-}"
  pool_size="${RYPH_CHECK_POOL_BYTES:-}"
  pool_share="${RYPH_CHECK_SHARE_BYTES:-}"
  if [ -n "$pool_size" ]; then
    pool_own="$pool/$pool_name"
    if ! pool_num "$pool_size" || ! pool_num "$pool_share" || ! pool_peers ||
      [ ! -d "$pool_own" ]; then
      echo "ryph: the suite's memory pool is not set up in this container;" \
        "this check runs unwatched"
    elif ! pool_private; then
      echo "ryph: no directory of this container's own can be made in $RYPH_POOL_CONTROL;" \
        "this check runs unwatched by the suite's memory pool"
    elif ! pool_used; then
      rm -rf "$pool_ctl"
      echo "ryph: this container's memory use cannot be read (no cgroup memory files);" \
        "this check runs unwatched by the suite's memory pool"
    elif ! { mkfifo "$pool_ctl/done"; } 2>/dev/null; then
      rm -rf "$pool_ctl"
      echo "ryph: mkfifo is missing or failed; this check runs unwatched by the suite's memory pool"
    else
      pool_size=$((10#$pool_size)) pool_share=$((10#$pool_share))
      [ ! -d /proc/self/fd ] || pool_proc=1
      pool_now
      if ! pool_publish 2>/dev/null; then
        rm -rf "$pool_ctl"; rm -f "$pool_own/.use" 2>/dev/null
        echo "ryph: this check's directory of the suite's memory pool, $pool_own, cannot be" \
          "written; this check runs unwatched"
      else
        set -m
        pool_watch </dev/null >/dev/null 2>&1 &
        pool_dog=$!
        set +m
        trap pool_end EXIT
      fi
    fi
  fi
}
