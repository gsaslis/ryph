#!/bin/sh
# Refuses a base image the harness layer cannot run on, naming what is missing.
#
# The layer under /opt/ryph brings its own runtimes, so it depends on the base for exactly three
# things: glibc on x86_64 — pi's Node and
# the compiled runner are glibc builds, which is why Alpine and other musl bases are refused —
# /bin/bash for setup steps, and git for the checkout. Run as the last build step of every image
# the layer is copied onto, so a wrong base fails the build, never a run.
#
# POSIX sh, not bash: bash is one of the things it checks for.
#
# `--base-only` skips the one check that needs the layer itself (pi's Node), so an environment
# build can run this BEFORE its bake — against the base alone, copied in as this one file —
# and fail on a wrong base before any setup step has spent time on it. The build runs it again,
# in full, once the layer is on.

# Published layers are x86_64; a laptop's local build is its own architecture (aarch64 on Apple
# silicon, see images/agent/build.ts), and the loader checked is that architecture's.
missing=""
case "$(uname -m)" in
  x86_64) loader=/lib64/ld-linux-x86-64.so.2 ;;
  aarch64) loader=/lib/ld-linux-aarch64.so.1 ;;
  *) loader="" ; missing="$missing x86_64(found $(uname -m))" ;;
esac
[ -z "$loader" ] || [ -e "$loader" ] || missing="$missing glibc"
[ -x /bin/bash ] || missing="$missing /bin/bash"
command -v git >/dev/null 2>&1 || missing="$missing git"
if [ -n "$missing" ]; then
  echo "ryph: this base image cannot carry the harness layer; missing:$missing" >&2
  exit 1
fi

# A git that is there but too old fails every clone: the runner checks out with
# `git checkout --end-of-options <ref>`, which git 2.43 (Ubuntu 24.04's own) reads as a pathspec.
# Asked of git itself rather than of a version number, so a backport that fixed it passes.
probe="$(mktemp -d)"
if ! (git init -q -b main "$probe" \
      && git -C "$probe" -c user.name=ryph -c user.email=ryph@localhost commit -q --allow-empty -m probe \
      && git -C "$probe" checkout -q --end-of-options main) >/dev/null 2>&1; then
  rm -rf "$probe"
  echo "ryph: this base's git ($(git --version)) is too old: it does not understand" \
    "\`git checkout --end-of-options\`, which the runner needs — install a newer git" >&2
  exit 1
fi
rm -rf "$probe"

if [ "${1:-}" = "--base-only" ]; then
  # Not required, so a warning and not a refusal: pi's grep and find tools run rg and fd (or
  # Debian's fdfind) from the base, and pi runs offline, so it never downloads them. Without them
  # the agent searches with bash. Only in this pass, so a build prints it once. Not a `ryph:`
  # line: `failureLine` reads the last of those as the reason a build failed.
  command -v rg >/dev/null 2>&1 \
    || echo "== warning: no rg on this base, so pi's grep tool will not work" >&2
  command -v fd >/dev/null 2>&1 || command -v fdfind >/dev/null 2>&1 \
    || echo "== warning: no fd on this base, so pi's find tool will not work" >&2
  exit 0
fi

# Present is not the same as usable: a glibc older than the one pi's Node was built against fails
# here, at build time, instead of on the first run's pi spawn.
if ! /opt/ryph/node/bin/node -e "" 2>/dev/null; then
  echo "ryph: pi's Node (/opt/ryph/node) does not run on this base — is its glibc too old?" >&2
  exit 1
fi
