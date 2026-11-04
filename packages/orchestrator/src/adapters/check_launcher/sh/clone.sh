# shellcheck shell=bash
# The `clone` init container: fetch every branch of the candidate repository, check the head out
# detached, prove HEAD is the recorded sha, then list what the change touched.
#
# The credential rides git's own env (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, an extraheader for
# the gateway) and nothing writes it anywhere: the fetch names a URL rather than adding a remote,
# so `.git/config`, which every check later copies or fetches from, holds no trace of it. It runs
# before any head code does and on the base's image, which is why the changed-paths list, which
# the report rests `watch` on, is taken here.
#
# The list is what the change touched: merge base (of the head and the checks commit) → head.
# What the base did after the head branched is not the change's, and is not listed.
#
# The list's end is always said: `@@ryph-changed-end <n>` after the paths (plus
# `@@ryph-changed-truncated <n>` when more than MAX_CHANGED_PATHS were cut), or
# `@@ryph-changed-unknown <why>` when the base is not in the fetched history or the diff failed.
# The list is written to a file and counted before a line of it is printed, so `n` is the count of
# a diff that succeeded. "No end line" is a clone that died mid-list, and reads as unknown, never
# as "nothing changed".

set -eu -o pipefail
exec 2>&1
# A directory the run user creates, so the tree is the run user's (see scripts.ts's header). Its
# existence is also this stage's mark: a second start finds it and stops.
if ! mkdir "$RYPH_PRISTINE/repo" 2>/dev/null; then
  started_twice "the clone"
fi
# A home of its own, beside the tree so no check copies it: git reads and may write config
# there, and the image's may not be ours. It holds no credential (that rides the env).
export HOME="$RYPH_PRISTINE/.ryph-clone"
mkdir "$HOME"
cd "$RYPH_PRISTINE/repo"
git -c init.defaultBranch=ryph init -q .
echo "ryph: fetching $RYPH_CHECK_HEAD"
# Its branches, and the upstream branches it was seeded from: the candidate repository keeps
# the base branch as a branch of its own, and a repository seeded from a clone keeps it as
# `refs/remotes/origin/<base>`. Both are fetched, so the merge base is found either way.
git fetch -q --no-tags "$RYPH_CHECK_URL" \
  '+refs/heads/*:refs/remotes/src/*' '+refs/remotes/*:refs/remotes/upstream/*'
git -c advice.detachedHead=false checkout -q --detach "$RYPH_CHECK_HEAD"
head="$(git rev-parse HEAD)"
if [ "$head" != "$RYPH_CHECK_HEAD" ]; then
  echo "ryph: HEAD is $head, not $RYPH_CHECK_HEAD"
  exit 1
fi
echo "ryph: checked out $head"
# The base is usually on a fetched branch already; when it is not (the branch moved on past
# it), one direct ask, which a gateway that serves only advertised refs may refuse.
if ! git cat-file -e "$RYPH_CHECK_BASE^{commit}" 2>/dev/null; then
  git fetch -q --no-tags "$RYPH_CHECK_URL" "$RYPH_CHECK_BASE" >/dev/null 2>&1 || true
fi
# The list goes to a file outside the tree, is counted, and only then printed: a diff that
# dies part-way says unknown rather than a short list with a matching count.
list="$HOME/changed"
if ! base="$(git merge-base HEAD "$RYPH_CHECK_BASE" 2>/dev/null)"; then
  echo "${RYPH_CHANGED}-unknown the base $RYPH_CHECK_BASE is not in the fetched history"
elif ! git -c core.quotePath=false diff --name-only --no-renames "$base" HEAD >"$list"; then
  echo "${RYPH_CHANGED}-unknown git diff failed"
elif ! n="$(wc -l <"$list" | tr -d " ")"; then
  echo "${RYPH_CHANGED}-unknown the changed paths could not be counted"
else
  head -n "$RYPH_MAX_CHANGED_PATHS" "$list" | sed "s/^/$RYPH_CHANGED /"
  if [ "$n" -gt "$RYPH_MAX_CHANGED_PATHS" ]; then echo "${RYPH_CHANGED}-truncated $n"; fi
  echo "${RYPH_CHANGED}-end $n"
fi
