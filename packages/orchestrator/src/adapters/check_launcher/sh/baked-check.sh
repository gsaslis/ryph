# shellcheck shell=bash
# One `check-<name>` container when the image baked a checkout of this repo
# (`RYPH_CHECK_BAKED`, a directory under BAKED_ROOT): move that checkout to the head in place, run
# the setup steps in it, then run the check (run-check.sh). This is what a run does with the same
# checkout (the runner's `adoptInPlace`), so a check's build is as warm as a run's.
#
# - the head comes from the pristine tree, mounted read-only: the clone stays the only stage that
#   holds the git credential. Before it is fetched, the image's remotes and their refs and
#   `refs/replace/` go; its other refs, and `refs/ryph/base` on the image's commit, stay through
#   the fetch so the pristine tree sends only what the head adds, not the whole history. After
#   the checkout every ref but the clone's branches goes, and then the reflogs, as a run's
#   adoption does them (runner `adoptInPlace`). The clone's branches come along under the names
#   the clone gave them, so the tree's git sees what a copy of the clone would
# - every git command of the move runs under `env -i` with only the variables the script names,
#   without the image's global and system git config or attributes, with hooks, fsmonitor and
#   submodule recursion off, no transport but the local one, and fetches no LFS object (the
#   runner's git_exec disables hooks for the same reason). The checkout's own `.git/config` is
#   rewritten to its repository format alone, and its worktree config and `.git/info/attributes`
#   are removed, so no setting the image left there applies: an allowlist, not a list of keys to
#   refuse. A repository kept elsewhere (`.git/commondir`) or an unknown repository extension
#   fails the move, and git looks for no repository above the tree. So no git config of the
#   image's and nothing the head adds runs before HEAD is proven the head's. The image's object
#   store and index are trusted, as its build output is: the move fetches only what its commit
#   lacks, and takes the index's stat data as the bake left it
# - `checkout -f` rewrites only the files that differ between the image's commit and the head, so
#   every other file keeps its mtime. `git clean -x` then removes every untracked file, ignored
#   ones too, except what the keep patterns name (`keep` in checks.yml: by default
#   `node_modules`, `target`, `.venv`). What is kept is the build cache the image is for, and the
#   build tools decide what of it is stale, as they do in a run. The rest goes because a verdict
#   gates a merge: a head that deletes a generator must not pass on the image's old output of it.
#   A head that changes a lockfile (LOCKFILES in scripts.ts) moves all the same, and the log names
#   the lockfiles: setup and the check install and build what changed themselves, so it is slower
# - HEAD must be the recorded sha after the move, or the check never runs. So must the tree be
#   the head's: an index entry marked skip-worktree or assume-unchanged (a sparse checkout leaves
#   those), or a submodule the image left at another commit fails the move
# - every setup step runs here, in order, before the services are waited on. Setup runs once per
#   check this way, since nothing one container writes reaches another; on a warm tree it is
#   cheap. Its failure is the check's, with the step's exit code (124 and 125 reported as 1)
#
# - a move that fails (any of the refusals above, or git itself) falls back to the copied tree in
#   this container: the baked checkout is removed and the clone copied in its place, then setup
#   runs there, cold. What fails a move is usually the image's own (a submodule it initialised, a
#   sparse checkout), and would fail every suite until the image is rebuilt; a cold check still
#   gives the verdict. Only a copy that fails, or a copy that is not at the head, is the
#   platform's (125)
#
# Each check container has its own copy-on-write view of the image, so parallel checks moving
# "the same" checkout never meet, and only the files a check writes take disk. The stage's mark is
# a directory in the checkout's `.git`, which the container's own filesystem keeps across a second
# start, as docker keeps it; a fallback makes it again in the copy.

set -u
exec 2>&1
tree="$RYPH_CHECK_BAKED"
if [ ! -d "$tree/.git" ]; then
  echo "ryph: the image has no checkout at $tree"
  exit "$RYPH_PLATFORM_EXIT"
fi
marks="$tree/.git/ryph-check"
if ! mkdir "$marks" 2>/dev/null; then
  started_twice "this check"
fi
pool_start
# A checkout that is there but cannot be entered is the platform's, like one that is not there.
cd "$tree" || exit "$RYPH_PLATFORM_EXIT"
# Every git command of the move. None of the image's global or system config (an LFS filter,
# an `include.path`), and none of the checkout's own config that runs code or reaches past the
# tree: hooks (husky points `core.hooksPath` into the tree, where the head decides what is
# there), fsmonitor, submodule recursion. No LFS object is fetched, no replace object is
# honoured, and no automatic gc rewrites a baked pack for nothing.
# Only the variables named here reach git: no config, attributes source or repository the
# image's env points at. Every transport but the local one is off, so nothing turns the fetch
# from the pristine tree into a command.
g() {
  # No looking above the tree for a repository: a broken `.git` must fail, not find the image's
  # parent one.
  env -i PATH="$PATH" HOME="${HOME:-/}" GIT_CEILING_DIRECTORIES="${tree%/*}" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_LFS_SKIP_SMUDGE=1 \
    GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false \
    -c fetch.recurseSubmodules=false -c gc.auto=0 -c maintenance.auto=false \
    -c protocol.allow=never -c protocol.file.allow=always -c core.attributesFile=/dev/null \
    -c advice.detachedHead=false "$@"
}
adopt() {
  # The checkout's own config goes, down to the repository format git needs to read its
  # objects: what a fresh clone's would say. With it go a filter's smudge, an include, a URL
  # rewrite, a work tree elsewhere, line-ending conversion, a sparse checkout, and whatever else
  # a key can do that no list of keys would think of; the worktree config and the checkout's own
  # attributes go too. Nothing a usual setup writes there is needed by a check (husky's
  # `core.hooksPath` is overridden in `g` anyway).
  # A repository kept elsewhere (`.git/commondir`) would have git read its config, objects and
  # attributes from there, past everything below.
  if [ -e .git/commondir ]; then
    echo "ryph: the baked checkout keeps its repository elsewhere (.git/commondir)"
    return 1
  fi
  # An extension the move does not know may be one git needs to read the repository: dropping
  # it could read it wrong, so it fails the move instead.
  unknown="$(g config --file .git/config --name-only --get-regexp '^extensions\.' |
    sed -E '/^extensions\.(objectformat|compatobjectformat|refstorage|worktreeconfig|relativeworktrees|partialclone|preciousobjects|noop)$/d')"
  if [ -n "$unknown" ]; then
    echo "ryph: the baked checkout uses repository extensions the move does not know: $unknown"
    return 1
  fi
  format="$(g config --file .git/config --get-regexp \
    '^(core\.repositoryformatversion|extensions\.(objectformat|compatobjectformat|refstorage))$')"
  case $? in 0 | 1) ;; *)
    echo "ryph: could not read the baked checkout's .git/config"
    return 1
  ;; esac
  rm -f .git/config .git/config.worktree .git/info/attributes &&
  g config --file .git/config core.bare false &&
  while read -r key value; do
    [ -z "$key" ] || g config --file .git/config "$key" "$value" || return 1
  done <<<"$format" &&
  # HEAD detached where it is, so deleting its branch below leaves it on the commit the index
  # describes.
  at="$(g rev-parse --verify -q "HEAD^{commit}")" &&
  g update-ref --no-deref HEAD "$at" &&
  # One ref on the image's commit through the fetch, so the clone's tree sends only what the
  # head adds to it rather than the whole history: a fetch with no ref has no haves.
  g update-ref refs/ryph/base "$at" &&
  # The image's remotes, their refs and `refs/replace/` go before the fetch
  # (GIT_NO_REPLACE_OBJECTS already ignores replace objects; they go all the same).
  remotes="$(g remote)" &&
  for remote in $remotes; do
    g remote remove "$remote" || return 1
  done &&
  refs="$(g for-each-ref --format='%(refname)' refs/remotes refs/replace)" &&
  for ref in $refs; do
    g update-ref --no-deref -d "$ref" || return 1
  done &&
  g fetch -q --no-tags "$RYPH_PRISTINE/repo" HEAD '+refs/remotes/*:refs/remotes/*' &&
  # The index's stat data first: a file whose mtime or inode moved since the bake recorded it
  # (an image layer does that) but whose content did not would otherwise be rewritten by the
  # forced checkout, and its build taken for stale. Exits 1 when files really differ; the
  # checkout below deals with those.
  { g update-index -q --refresh >/dev/null 2>&1 || :; } &&
  g checkout -q -f --detach "$RYPH_CHECK_HEAD" &&
  [ "$(g rev-parse HEAD)" = "$RYPH_CHECK_HEAD" ] &&
  # Every other ref the image's checkout had goes now, `refs/ryph/base` too: only the clone's
  # branches stay.
  refs="$(g for-each-ref --format='%(refname)')" &&
  for ref in $refs; do
    case "$ref" in refs/remotes/*) continue ;; esac
    g update-ref --no-deref -d "$ref" || return 1
  done &&
  # The lockfiles the head changed since the image's commit, for the log (LOCKFILE_PATTERN).
  # Only ever said, so a failing diff says nothing rather than fail the move.
  { locks="$(g -c core.quotePath=false diff --name-only --no-renames "$at" HEAD 2>/dev/null |
    sed -n -E '\#'"$RYPH_LOCKFILES"'#p')" || :; } &&
  # Untracked files go, and ignored ones too unless a keep pattern names them: a verdict gates
  # a merge, so the image's stale output of a generator the head deleted must not pass it.
  # `-f -f` takes nested repositories as well.
  spare=() &&
  for ((k = 0; k < ${RYPH_CHECK_KEEP_COUNT:-0}; k++)); do
    pattern="RYPH_CHECK_KEEP_$k"
    spare+=(-e "${!pattern-}")
  done &&
  # The empty array's expansion spelled for bash before 4.4, which calls it unbound under -u.
  g clean -f -f -d -x -q ${spare[@]+"${spare[@]}"} &&
  g reflog expire --expire=now --all &&
  settled
}
# What a checkout leaves as the image had it where the head's tree would differ. Each one fails
# the move rather than run a check on files that are not the head's.
settled() {
  # Captured first, so a failing ls-files fails the move rather than read as nothing flagged.
  listed="$(g ls-files -v)" || return 1
  flagged="$(printf '%s\n' "$listed" | sed -n '/^$/d;/^H /!p')"
  if [ -n "$flagged" ]; then
    echo "ryph: the baked checkout marks files skip-worktree or assume-unchanged:"
    printf '%s\n' "$flagged" | head -n 5
    return 1
  fi
  # Every gitlink the head records, against what is checked out at its path: `submodule status`
  # would only look at submodules the config names, and the config is the clone's now. Listed
  # to a file first (paths may hold any byte but NUL), so a failing ls-files fails the move.
  g ls-files -s -z >"$marks/gitlinks" || return 1
  moved=""
  while IFS= read -r -d "" entry; do
    case "$entry" in 160000\ *) ;; *) continue ;; esac
    sha="${entry#160000 }"
    sha="${sha%% *}"
    path="${entry#*$'\t'}"
    if [ -e "$path/.git" ]; then
      [ "$(g -C "$path" rev-parse HEAD 2>/dev/null)" = "$sha" ] || moved="$moved$path"$'\n'
    # No checkout there, but files: what the image had at a path the head made a submodule,
    # which `git clean` does not go into.
    elif [ -n "$(ls -A "$path" 2>/dev/null)" ]; then
      moved="$moved$path"$'\n'
    fi
  done <"$marks/gitlinks"
  rm -f "$marks/gitlinks"
  if [ -n "$moved" ]; then
    echo "ryph: the baked checkout has submodules that are not at the head's commits:"
    printf '%s\n' "$moved"
    return 1
  fi
}
# The move, and the fallback's copy, each a stage the pool watcher can stop (`pool_stage`):
# what they write is the check's memory under gVisor. Each runs in a subshell of its own, so
# what it says it says itself.
move() {
  locks=""
  adopt || return
  echo "ryph: moved the baked checkout at $tree to $RYPH_CHECK_HEAD"
  if [ -n "$locks" ]; then
    echo "ryph: the head changes lockfiles from the image's commit, which has the old dependencies;"
    echo "  what changed is installed only if setup or the build does it:"
    printf '%s\n' "$locks" | head -n 5 | sed 's/^/  /'
  fi
}
# Out of the tree first: it is about to go. The copy goes where the checkout was, so the
# check's paths are the same either way.
# A read-only directory in it (a module cache) would stop the removal. The mark is made again
# before the copy, so a restart part-way through it refuses rather than check a partial tree.
fallback() {
  cd / &&
  { chmod -R u+w "$tree" 2>/dev/null || :; } &&
  rm -rf "$tree" &&
  mkdir -p "$marks" &&
  cp -a "$RYPH_PRISTINE/repo/." "$tree"/ &&
  # The copy is this check's to write, whatever modes the pristine tree shows through its mount.
  chmod -R u+w "$tree"
}
pool_stage move
rc=$?
pool_stopped
if [ "$rc" -ne 0 ]; then
  echo "ryph: could not move the baked checkout at $tree to $RYPH_CHECK_HEAD;" \
    "checking a copy of the clone instead, without the image's build output"
  pool_stage fallback
  rc=$?
  pool_stopped
  # The tree the shell stood in is gone: in to the copy.
  { [ "$rc" -eq 0 ] && cd "$tree" && [ "$(g rev-parse HEAD)" = "$RYPH_CHECK_HEAD" ]; } || {
    echo "ryph: could not copy the clone at $RYPH_CHECK_HEAD into $tree either"
    exit "$RYPH_PLATFORM_EXIT"
  }
fi
n="${RYPH_CHECK_SETUP_COUNT:-0}"
i=0
while [ "$i" -lt "$n" ]; do
  step="RYPH_CHECK_SETUP_$i"
  echo "ryph: setup step $((i + 1)) of $n"
  # A process group of its own, as the check's is (`run_check`), so the pool watcher can stop
  # the step and everything it started.
  pool_stage sh -c "${!step}"
  rc=$?
  pool_stopped
  if [ "$rc" -eq 124 ] || [ "$rc" -eq "$RYPH_PLATFORM_EXIT" ] ||
    [ "$rc" -eq "$RYPH_POOL_EXIT" ]; then
    echo "ryph: setup step $((i + 1)) exited $rc by itself; reported as 1"
    exit 1
  elif [ "$rc" -ne 0 ]; then
    echo "ryph: setup step $((i + 1)) exited $rc"
    exit "$rc"
  fi
  i=$((i + 1))
done
run_check "$marks/timed-out"
